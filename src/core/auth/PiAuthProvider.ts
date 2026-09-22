/**
 * PiAuthProvider — EngineAuthProvider implementation for the 'pi' engine (M3).
 *
 * Unlike opencode (a server ClaudeUI talks to over HTTP), pi has no server —
 * ClaudeUI reads/writes `~/.pi/agent/auth.json` DIRECTLY. This is the ONE
 * sanctioned write into `~/.pi/**`: a read-modify-write that preserves every
 * unknown provider entry and unknown field byte-for-byte, and keeps 0600 on
 * POSIX (see docs/protocol-pi/README.md "Auth" + vendor/pi-cli/docs/providers.md).
 *
 * pi's native `pi /login` is TUI-interactive, but as of M6 ClaudeUI DOES drive
 * the `openai-codex` (ChatGPT) login itself via its own auth vault
 * (capabilities.auth.canDriveLogin is now true — ADR-036): oauthAuthorize/
 * oauthCallback/cancelVendorOauth below delegate that ONE vendor to
 * `credentialSync`. pi's OTHER subscription vendors (anthropic/github-copilot/
 * xai/radius) are still undriven — their oauth entries in
 * listVendorAuthOptions() stay informational (the Settings UI shows a "run pi
 * /login in a terminal" hint for those — see PiVendors.tsx).
 *
 * probe()/setVendorApiKey()/removeVendorAuth() degrade to a no-op-safe result
 * on any failure — pi is optional, exactly like ClaudeAuthProvider/
 * OpencodeAuthProvider's own failure postures.
 */
import fs from 'fs'
import path from 'path'
import { piAgentDir } from '../services/pi-session-list'
import { invalidatePiModelCache } from '../pi/model-discovery'
import { readJsonFileForWrite, writeJsonAtomic } from '../services/write-json-atomic'
import type {
  AccountRef,
  AuthState,
  VendorAuthMap,
  VendorAuthOption,
  VendorDeviceCodeStart,
  VendorDeviceCodeStatus
} from '../../shared/types'
import type { AccountIdentity } from '../../shared/account-key'
import { AuthFileIdentityCache } from './account-identity'
import type { EngineAuthProvider } from './EngineAuthProvider'
import { PI_API_KEY_VENDOR_IDS, PI_SUBSCRIPTION_VENDOR_IDS } from './pi-vendor-ids'
import {
  credentialSync,
  PI_CODEX_VENDOR_ID,
  type CodexCredentialInput,
  type CodexEntrySnapshot
} from './vault/CredentialSync'

/**
 * `~/.pi/agent/auth.json` — pi's own credential store. Reuses `piAgentDir()`
 * (pi-session-list.ts) rather than re-deriving `os.homedir()` composition, so
 * this module honors the SAME `os.homedir()` mock the existing pi-session-list
 * tests use for isolation (no separate env-var override needed).
 */
function resolvePiAuthJsonPath(): string {
  return path.join(piAgentDir(), 'auth.json')
}

/**
 * One entry in `~/.pi/agent/auth.json`. Deliberately loose (not a discriminated
 * union) — this is JSON.parse'd, untyped, best-effort data; `type`/`expires`
 * are read defensively and every other field (refresh/access/extras, or a
 * future field we don't know about) round-trips through `[key: string]: unknown`
 * byte-for-byte on write.
 */
interface PiAuthEntry {
  type?: string
  key?: string
  expires?: number
  [key: string]: unknown
}

type PiAuthFile = Record<string, PiAuthEntry>

/**
 * Best-effort read + parse of auth.json for READ-ONLY callers (probe /
 * listVendorCredentialIds / readOauthEntry). Returns {} on any failure
 * (missing file, corrupt JSON, non-object) — a read reporting "no vendors" is
 * an acceptable degradation. The WRITE path deliberately does NOT use this
 * (see readAuthFileForWrite): degrading a corrupt-but-present file to {} and
 * then writing it back would delete every vendor entry it could not parse (H18).
 */
function readAuthFile(): PiAuthFile {
  try {
    const raw = fs.readFileSync(resolvePiAuthJsonPath(), 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed as PiAuthFile
  } catch {
    return {}
  }
}

/**
 * Read auth.json for a read-modify-write. Returns {} for a MISSING file (fresh
 * start) but THROWS (after backing the file up once) when the file is present
 * but unreadable — so a mutator never clobbers a corrupt file, permanently
 * losing other vendors' credentials (H18/R2).
 */
function readAuthFileForWrite(): PiAuthFile {
  return readJsonFileForWrite(resolvePiAuthJsonPath()) as PiAuthFile
}

/**
 * Atomically write auth.json (temp-file + rename), creating `~/.pi/agent/` if
 * absent and forcing 0600 on POSIX. Atomicity prevents the mid-write truncation
 * that produces the corrupt file readAuthFileForWrite must otherwise refuse.
 */
function writeAuthFile(data: PiAuthFile): void {
  writeJsonAtomic(resolvePiAuthJsonPath(), data, { indent: 2 })
}

/** The host-side record of one device-code wait — see {@link PiAuthProvider.deviceCodeStart}. */
interface DeviceCodeWait {
  startedAt: number
  /** Host wall-clock ms the flow dies at; the flow enforces it, this is for diagnosis. */
  expiresAt: number
  state: VendorDeviceCodeStatus['state']
  /** Host message, `error` only. Never token material. */
  error?: string
}

export class PiAuthProvider implements EngineAuthProvider {
  /**
   * Snapshot from the LAST probe() call — read synchronously by
   * buildPiAccountRef() (called from PiSession.status, a synchronous getter).
   * Unlike OpencodeAuthProvider's cache-if-present probe() (justified there by
   * an expensive server-spawn+HTTP round trip), probe() here ALWAYS re-reads:
   * auth.json is a single cheap local file read, and a user who just ran
   * `pi /login` in a terminal should see Settings reflect it on next open
   * without an app restart. The snapshot exists purely to serve the
   * synchronous buildPiAccountRef() call, not to avoid repeated work.
   */
  private lastProbe: VendorAuthMap = {}

  /**
   * The one in-flight device-code wait (ADR-068 §3, Slice 7). Held on the
   * provider singleton because the wait outlives the invoke that started it —
   * see {@link deviceCodeStart}. Single-flight: a second start replaces it.
   */
  private deviceWait: DeviceCodeWait | undefined

  /**
   * ADR-071 §3 account identity, off pi's own auth.json, cached on that file's
   * mtime. Independent of `lastProbe`: a row must be attributable whether or
   * not probe() has run.
   *
   * Built on FIRST USE, not in a field initializer: the singleton at the foot
   * of this file is constructed while this module is still evaluating, and
   * reaching into another module's bindings at that moment couples the two
   * files' initialization order for no gain.
   */
  private identityCache: AuthFileIdentityCache | null = null

  async probe(): Promise<VendorAuthMap> {
    const map = this.computeVendorMap()
    this.lastProbe = map
    return map
  }

  private computeVendorMap(): VendorAuthMap {
    const file = readAuthFile()
    const map: VendorAuthMap = {}
    const now = Date.now()
    for (const [vendorId, entry] of Object.entries(file)) {
      if (!entry || typeof entry !== 'object') continue
      const authState: AuthState = 'authenticated'
      if (entry.type === 'oauth') {
        const expired = typeof entry.expires === 'number' && entry.expires < now
        map[vendorId] = {
          authState,
          billingType: 'subscription',
          label: expired ? 'OAuth (expired — refreshes on use)' : 'OAuth'
        }
      } else {
        // Anything non-oauth (api_key, or an unrecognized future type) is
        // reported as an API-key-like credential — mirrors
        // OpencodeAuthProvider.listVendorCredentialIds's identical "anything
        // non-oauth = api" idiom.
        map[vendorId] = { authState, billingType: 'apiKey', label: 'API key' }
      }
    }
    return map
  }

  async listVendorAuthOptions(): Promise<Record<string, VendorAuthOption[]>> {
    const out: Record<string, VendorAuthOption[]> = {}
    for (const vendorId of PI_API_KEY_VENDOR_IDS) {
      out[vendorId] = [
        {
          type: 'api',
          label: 'API key',
          prompts: [{ type: 'text', key: 'key', message: 'API key', secret: true }]
        }
      ]
    }
    for (const vendorId of PI_SUBSCRIPTION_VENDOR_IDS) {
      const oauthOption: VendorAuthOption = {
        type: 'oauth',
        label: 'Subscription (run pi /login in a terminal)'
      }
      out[vendorId] = out[vendorId] ? [...out[vendorId], oauthOption] : [oauthOption]
    }
    return out
  }

  async listVendorCredentialIds(): Promise<Record<string, 'api' | 'oauth'>> {
    const file = readAuthFile()
    const out: Record<string, 'api' | 'oauth'> = {}
    for (const [vendorId, entry] of Object.entries(file)) {
      if (!entry || typeof entry !== 'object') continue
      out[vendorId] = entry.type === 'oauth' ? 'oauth' : 'api'
    }
    return out
  }

  /**
   * Merge `{type:'api_key', key}` into auth.json — preserves every other
   * provider entry and every unknown field on the target entry byte-for-byte
   * (read-modify-write, not overwrite). Invalidates the pi model cache after
   * the write (a newly-keyed vendor's models may now be discoverable) and
   * refreshes the probe snapshot so buildPiAccountRef() reflects it immediately.
   */
  async setVendorApiKey(vendorId: string, key: string): Promise<void> {
    const file = readAuthFileForWrite()
    file[vendorId] = { ...file[vendorId], type: 'api_key', key }
    writeAuthFile(file)
    invalidatePiModelCache()
    await this.probe()
  }

  /** Delete a provider's entry from auth.json entirely. Preserves every other entry. */
  async removeVendorAuth(vendorId: string): Promise<void> {
    const file = readAuthFileForWrite()
    delete file[vendorId]
    writeAuthFile(file)
    invalidatePiModelCache()
    await this.probe()
  }

  // -------------------------------------------------------------------------
  // CredentialSync feed target (M6b) — implements vault/CredentialSync.ts's
  // structural `CodexFeedTarget` interface. NOT part of EngineAuthProvider —
  // Claude has no analog, and the vendorId this vault feeds ('openai-codex')
  // is Codex-specific, not a generic per-vendor operation like
  // setVendorApiKey/removeVendorAuth above.
  // -------------------------------------------------------------------------

  /** `~/.pi/agent/auth.json`'s absolute path — CredentialSync derives its fs.watch dir + filename filter from this. */
  authFilePath(): string {
    return resolvePiAuthJsonPath()
  }

  /**
   * RMW-merge a Codex OAuth credential into auth.json. Preserves every other
   * provider entry AND any unknown field already on this vendor's own entry
   * (spread-before-overwrite, same idiom as setVendorApiKey above).
   * Deliberately does NOT write `accountId`/`email` — pi's own auth.json
   * schema has no such field and doesn't read one; unlike opencode (which
   * persists accountId), silently dropping it here is correct, not lossy —
   * the vault (auth-vault.json) remains the source of truth for that data.
   */
  async feedOauthCredential(vendorId: string, cred: CodexCredentialInput): Promise<void> {
    const file = readAuthFileForWrite()
    file[vendorId] = {
      ...file[vendorId],
      type: 'oauth',
      access: cred.access,
      refresh: cred.refresh,
      expires: cred.expires
    }
    writeAuthFile(file)
    invalidatePiModelCache()
    await this.probe()
  }

  /** Read this vendor's current OAuth entry — used by CredentialSync's fs-watch resync to detect an engine-initiated rotation. Null if absent, non-oauth, or malformed. */
  async readOauthEntry(vendorId: string): Promise<CodexEntrySnapshot | null> {
    const file = readAuthFile()
    const entry = file[vendorId]
    if (!entry || entry.type !== 'oauth') return null
    const { access, refresh, expires } = entry
    if (typeof access !== 'string' || typeof refresh !== 'string' || typeof expires !== 'number')
      return null
    return { access, refresh, expires }
  }

  // -------------------------------------------------------------------------
  // OAuth delegation (M6b) — ONLY for 'openai-codex', dispatched to the
  // AuthVault-backed CredentialSync. pi's OTHER subscription vendors
  // (anthropic, github-copilot, xai, radius — PI_SUBSCRIPTION_VENDOR_IDS)
  // remain undriven (`pi /login` in a terminal); see the module header.
  // -------------------------------------------------------------------------

  async oauthAuthorize(
    vendorId: string,
    _method: number,
    _inputs?: Record<string, string>
  ): Promise<{ url: string; method: 'auto' | 'code'; instructions: string }> {
    if (vendorId !== PI_CODEX_VENDOR_ID) {
      throw new Error(
        `PiAuthProvider.oauthAuthorize: only '${PI_CODEX_VENDOR_ID}' is driven; got '${vendorId}'`
      )
    }
    const { authorizeUrl } = await credentialSync.beginLogin()
    return {
      url: authorizeUrl,
      method: 'auto',
      instructions: 'Complete sign-in to ChatGPT in the browser window that just opened.'
    }
  }

  /**
   * ADR-068 §3 / Slice 7: start a DEVICE-CODE sign-in instead of the loopback
   * one — "open this link, type this code", which is the flow a phone can
   * actually finish. Same vendor gate as `oauthAuthorize`.
   *
   * THE WAIT IS HOST-OWNED, and that is the point. `credentialSync.completeLogin()`
   * is kicked off here and deliberately NOT awaited: a device code lives for
   * fifteen minutes, and the web transport (`web/connection.ts`,
   * `INVOKE_TIMEOUT_MS = 30_000`) rejects any invoke that outlives thirty
   * seconds — on the one client that uses device code. So the outcome lands in
   * {@link deviceWait} and the client asks {@link deviceCodeStatus} for it.
   * A dropped socket then costs nothing: the host is still polling, and the
   * reconnected client picks the answer up.
   *
   * SINGLE-FLIGHT by holder identity: a second start replaces `deviceWait`, and
   * the background settler writes only if it still owns the slot. The vault
   * enforces the other half — `claimLoginSlot` cancels a live device flow.
   */
  async deviceCodeStart(vendorId: string): Promise<VendorDeviceCodeStart> {
    if (vendorId !== PI_CODEX_VENDOR_ID) {
      throw new Error(
        `PiAuthProvider.deviceCodeStart: only '${PI_CODEX_VENDOR_ID}' is driven; got '${vendorId}'`
      )
    }
    const started = await credentialSync.beginDeviceCodeLogin()
    const wait: DeviceCodeWait = {
      startedAt: Date.now(),
      expiresAt: started.expiresAt,
      state: 'pending'
    }
    this.deviceWait = wait
    // Not awaited. `.then(ok, err)` rather than a floating promise + catch, so
    // neither outcome can surface as an unhandled rejection.
    void credentialSync.completeLogin().then(
      () => this.settleDeviceWait(wait, 'done'),
      (err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err)
        // A cancellation is not a failure to report — the user did it, or a
        // second start superseded this one.
        if (/cancelled/i.test(detail)) this.settleDeviceWait(wait, 'cancelled')
        else this.settleDeviceWait(wait, 'error', detail)
      }
    )
    return started
  }

  /**
   * Where the started wait has got to. `cancelled` is also the answer when NO
   * flow is live, so a client that missed the cancellation stops polling instead
   * of waiting forever. Carries the host's message on `error` and nothing else —
   * never a token, never the `device_auth_id`.
   */
  async deviceCodeStatus(): Promise<VendorDeviceCodeStatus> {
    const wait = this.deviceWait
    if (!wait) return { state: 'cancelled' }
    return wait.state === 'error' && wait.error
      ? { state: 'error', error: wait.error }
      : { state: wait.state }
  }

  /** Write a terminal state, but only for the wait that still owns the slot, and only once. */
  private settleDeviceWait(
    wait: DeviceCodeWait,
    state: DeviceCodeWait['state'],
    error?: string
  ): void {
    if (this.deviceWait !== wait || wait.state !== 'pending') return
    wait.state = state
    if (error) wait.error = error
  }

  async oauthCallback(vendorId: string, _method: number, code?: string): Promise<boolean> {
    if (vendorId !== PI_CODEX_VENDOR_ID) {
      throw new Error(
        `PiAuthProvider.oauthCallback: only '${PI_CODEX_VENDOR_ID}' is driven; got '${vendorId}'`
      )
    }
    // ADR-057: a non-empty `code` is the pasted callback URL / bare code from a
    // remote browser (the host loopback never fired because the redirect landed
    // on the REMOTE client's own loopback). Complete via the paste path; the
    // host still holds the PKCE verifier and performs the exchange. Absent, the
    // desktop loopback wait is awaited exactly as before.
    const pasted = code?.trim()
    if (pasted) {
      await credentialSync.completeLogin(pasted)
    } else {
      await credentialSync.completeLogin()
    }
    return true
  }

  async cancelVendorOauth(): Promise<void> {
    credentialSync.cancelLogin()
    // Mark the holder immediately rather than waiting for the background
    // completion to reject: the client's very next status poll must see this,
    // and on a fake/settled flow that rejection may never arrive at all.
    if (this.deviceWait) this.settleDeviceWait(this.deviceWait, 'cancelled')
  }

  // -------------------------------------------------------------------------
  // Helpers for PiSession.status.account
  // -------------------------------------------------------------------------

  /**
   * Build an AccountRef for the given vendor from the last probe() snapshot.
   * Returns null if probe() hasn't run yet or the vendor has no entry —
   * mirrors OpencodeAuthProvider.buildAccountRef exactly.
   */
  buildPiAccountRef(vendorId: string): AccountRef | null {
    const entry = this.lastProbe[vendorId]
    if (!entry) return null
    return {
      engineId: 'pi',
      vendorId,
      billingType: entry.billingType,
      authState: entry.authState,
      label: entry.label
    }
  }

  /**
   * Which ACCOUNT this vendor's turns run under (ADR-071 §3), off pi's own
   * auth.json — the opencode method's twin, with `pi:<vendor>:native` as the
   * fallback. pi does not persist an `accountId` on its oauth entries, so the
   * ChatGPT subscription id is read out of the access token's own
   * `chatgpt_account_id` claim instead; the key that comes out is the same one
   * opencode and Codex derive for that subscription.
   *
   * Returns the key and the label and nothing else: no token, no key material.
   */
  accountIdentity(vendorId: string): AccountIdentity {
    this.identityCache ??= new AuthFileIdentityCache(
      'pi',
      resolvePiAuthJsonPath,
      PI_CODEX_VENDOR_ID
    )
    return this.identityCache.identity(vendorId)
  }
}

/** Singleton pi auth provider. */
export const piAuthProvider = new PiAuthProvider()

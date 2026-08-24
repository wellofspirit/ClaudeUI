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
import type { AccountRef, AuthState, VendorAuthMap, VendorAuthOption } from '../../shared/types'
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
}

/** Singleton pi auth provider. */
export const piAuthProvider = new PiAuthProvider()

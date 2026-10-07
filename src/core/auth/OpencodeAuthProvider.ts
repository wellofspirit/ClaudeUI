/**
 * OpencodeAuthProvider — EngineAuthProvider for the 'opencode' engine, on
 * opencode 2.x (ADR-093 §5).
 *
 * 2.x keeps credentials in its database behind `/api/credential`, and the data
 * dir is shared with the user's own opencode. Every write here goes through
 * {@link opencodeCredentialStore}, which owns exactly ClaudeUI's
 * `cred_claudeui_*` rows: an API key is vended as the next generation and made
 * active, a removal deletes ClaudeUI's rows only and gives the slot back to
 * the user's previously active credential. Nothing is written to `auth.json`,
 * and nothing is recycled: 2.x applies a credential change to the next request.
 *
 * probe() merges `GET /api/integration` (every integration with its methods
 * and connections), `GET /api/provider` (the usable ones) and the credential
 * snapshot (which row each integration uses, never its value). OAuth sign-ins
 * run on opencode's own integration flows (`/api/integration/{id}/connect/oauth`):
 * the row they create is opencode's, not ClaudeUI's.
 *
 * Degrades to {} on any failure — opencode is optional.
 */

import { opencodeServerManager, type ServerConnection } from '../opencode/OpencodeServerManager'
import { READ_LINGER_MS } from '../opencode/read-linger'
import { OpencodeClient } from '../opencode/OpencodeClient'
import { opencodeCredentialStore } from '../opencode/opencode-credentials'
import {
  CHATGPT_INTEGRATION_ID,
  credentialTypes,
  type ClaudeuiTokenCheck,
  type VendedChatgpt
} from '../opencode/credential-store'
import type { Integration_Info, Integration_Method } from '../opencode/protocol-v2/openapi'
import { PERSISTED_SESSIONS_DIR } from '../services/persisted-sessions-dir'
import { invalidateOpencodeModelCache } from '../opencode/model-discovery'
import { logger } from '../services/logger'
import { logSafeError } from '../services/redact-secrets'
import { removalCaller } from './removal-caller'
import type { VendorAuthMap, VendorAuthOption, AccountRef, AuthState } from '../../shared/types'
import { nativeAccountKey, type AccountIdentity } from '../../shared/account-key'
import type { EngineAuthProvider } from './EngineAuthProvider'
import { FREE_OPENCODE_VENDOR_IDS } from '../../shared/engine-meta'
import type { CodexCredentialInput } from './vault/CredentialSync'

/** Auth calls run no turn: never wait for the hosted MCP tools (S2 readiness). */
const NO_TURN = { waitForHostedTools: false, lingerMs: READ_LINGER_MS } as const

/** How often an `auto` OAuth attempt (loopback / device code) is polled. */
export const OAUTH_POLL_MS = 1000

/** The methods ClaudeUI's sign-in UI offers, in opencode's order (the `method` index). */
function offeredMethods(integration: Integration_Info): Integration_Method[] {
  return integration.methods.filter((method) => method.type === 'oauth' || method.type === 'key')
}

function authOption(method: Integration_Method): VendorAuthOption {
  if (method.type === 'oauth') {
    const prompts = (method.form ?? [])
      .filter((field) => !(field as { hidden?: boolean }).hidden)
      .map((field) => {
        const f = field as { key: string; title?: string; options?: unknown[]; type?: string }
        return { type: f.options ? 'select' : 'text', key: f.key, message: f.title ?? f.key }
      })
    return { type: 'oauth', label: method.label, ...(prompts.length > 0 ? { prompts } : {}) }
  }
  return { type: 'api', label: (method.type === 'key' && method.label) || 'API key' }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

interface OauthHold {
  conn: ServerConnection
  client: OpencodeClient
  vendorId: string
  attemptID: string
  mode: 'auto' | 'code'
  expires: number
  released: boolean
  /** The attempt's one-off label and the row active before it (provenance, S7 follow-up). */
  signin: { label: string; previousActive?: string }
}

export class OpencodeAuthProvider implements EngineAuthProvider {
  /** Cached probe result, dropped on every credential change ClaudeUI makes. */
  private cachedVendorMap: VendorAuthMap | null = null

  /**
   * The server an OAuth attempt lives in, held from authorize to callback: the
   * attempt (PKCE state, a loopback listener) is in THAT process.
   */
  private oauthHold: OauthHold | null = null

  constructor() {
    // The model catalogs subscribe on their own (model-discovery.ts).
    opencodeCredentialStore.onChange(() => this.invalidateCache())
  }

  // ── EngineAuthProvider ───────────────────────────────────────────────────────

  async probe(): Promise<VendorAuthMap> {
    if (this.cachedVendorMap) return this.cachedVendorMap
    const result = await this.fetchVendorMap()
    this.cachedVendorMap = result
    return result
  }

  /** One read of integrations + usable providers + credential snapshot; {} on failure. */
  private async fetchVendorMap(): Promise<VendorAuthMap> {
    try {
      const [{ integrations, providers }, snapshot] = await Promise.all([
        this.withClient(async (client) => ({
          integrations: await client.integrations(),
          providers: await client.providers()
        })),
        opencodeCredentialStore.snapshot().catch(() => opencodeCredentialStore.cachedSnapshot())
      ])
      const usable = new Map(providers.map((p) => [p.id, p.integrationID ?? p.id]))
      const map: VendorAuthMap = {}
      const entry = (vendorId: string, integration: Integration_Info | undefined) => {
        const isFree = FREE_OPENCODE_VENDOR_IDS.has(vendorId)
        const integrationID = usable.get(vendorId) ?? vendorId
        const configured = usable.has(vendorId) || (integration?.connections.length ?? 0) > 0
        const state = snapshot?.integrations.get(integrationID)
        const authState: AuthState = isFree || configured ? 'authenticated' : 'unauthenticated'
        let billingType: 'subscription' | 'apiKey' | 'free' | 'unknown'
        if (isFree) billingType = 'free'
        else if (state?.activeType)
          billingType = state.activeType === 'oauth' ? 'subscription' : 'apiKey'
        else if (!configured) billingType = 'unknown'
        else {
          // Configured without a stored row (an env key, a config key): the
          // methods it offers are the only hint left.
          const methods = integration?.methods ?? []
          const oauth = methods.some((m) => m.type === 'oauth')
          const key = methods.some((m) => m.type === 'key' || m.type === 'env')
          billingType = oauth && !key ? 'subscription' : 'apiKey'
        }
        map[vendorId] = { authState, billingType }
      }
      for (const integration of integrations) entry(integration.id, integration)
      for (const providerId of usable.keys()) if (!map[providerId]) entry(providerId, undefined)
      return map
    } catch (err) {
      logger.warn('OpencodeAuth', `probe() failed (opencode optional): ${errText(err)}`)
      return {}
    }
  }

  async listVendorAuthOptions(): Promise<Record<string, VendorAuthOption[]>> {
    try {
      const integrations = await this.withClient((client) => client.integrations())
      const out: Record<string, VendorAuthOption[]> = {}
      for (const integration of integrations) {
        const options = offeredMethods(integration).map(authOption)
        if (options.length > 0) out[integration.id] = options
      }
      return out
    } catch (err) {
      logger.warn('OpencodeAuth', `listVendorAuthOptions() failed: ${errText(err)}`)
      return {}
    }
  }

  /**
   * Vend `key` as ClaudeUI's `cred_claudeui_<vendor>_v<n>` and make it active.
   * The same key already vended writes nothing (the shared-provider sync
   * re-vends every key at boot).
   */
  async setVendorApiKey(vendorId: string, key: string): Promise<void> {
    await opencodeCredentialStore.vendKey(vendorId, key)
  }

  /**
   * Which vendors have an active credential, and of what type — the row
   * opencode uses, ClaudeUI's or the user's. Never key material.
   */
  async listVendorCredentialIds(): Promise<Record<string, 'api' | 'oauth'>> {
    return credentialTypes(
      await opencodeCredentialStore.snapshot().catch(() => opencodeCredentialStore.cachedSnapshot())
    )
  }

  /** Vendors where ClaudeUI holds an API-key row it can remove (`cred_claudeui_*`). */
  async listRemovableVendorIds(): Promise<Set<string>> {
    // ClaudeUI's own record: no server needed.
    return opencodeCredentialStore.recordedRemovableIntegrations()
  }

  async oauthAuthorize(
    vendorId: string,
    method: number,
    inputs?: Record<string, string>
  ): Promise<{ url: string; method: 'auto' | 'code'; instructions: string }> {
    await this.cancelVendorOauth()
    // The row this sign-in creates is ClaudeUI's (owner decision 2026-10-07):
    // found afterwards by the attempt's one-off label, race-free.
    const signin = await opencodeCredentialStore.prepareSignin(vendorId)
    const conn = await opencodeServerManager.acquire(PERSISTED_SESSIONS_DIR, NO_TURN)
    const client = new OpencodeClient(conn)
    try {
      const integration = (
        await client.call('integration.get', { params: { integrationID: vendorId } })
      ).data
      const chosen = offeredMethods(integration)[method]
      if (!chosen || chosen.type !== 'oauth')
        throw new Error(`opencode offers no OAuth method #${method} for ${vendorId}`)
      const attempt = (
        await client.call('integration.oauth.connect', {
          params: { integrationID: vendorId },
          body: {
            methodID: chosen.id,
            label: signin.label,
            ...(inputs && Object.keys(inputs).length > 0 ? { answer: inputs } : {})
          }
        })
      ).data
      const expires = Number(attempt.time.expires)
      this.oauthHold = {
        conn,
        client,
        vendorId,
        attemptID: attempt.attemptID,
        mode: attempt.mode,
        expires: Number.isFinite(expires) ? expires : Date.now() + 10 * 60_000,
        released: false,
        signin
      }
      return { url: attempt.url, method: attempt.mode, instructions: attempt.instructions }
    } catch (err) {
      opencodeServerManager.releaseIfCurrent(PERSISTED_SESSIONS_DIR, conn)
      throw err
    }
  }

  /**
   * Finish the attempt `oauthAuthorize` started: submit the pasted code, or
   * wait for the browser/device flow to complete. The row opencode stores
   * (opencode's id) is recorded as ClaudeUI's: removed with the provider, and
   * the slot given back to the row active before it.
   */
  async oauthCallback(vendorId: string, _method: number, code?: string): Promise<boolean> {
    const hold = this.oauthHold
    if (!hold || hold.vendorId !== vendorId) return false
    try {
      const params = { integrationID: vendorId, attemptID: hold.attemptID }
      if (code !== undefined && code !== '') {
        await hold.client.call('integration.oauth.complete', { params, body: { code } })
      } else {
        for (;;) {
          if (hold.released) return false
          const status = (await hold.client.call('integration.oauth.status', { params })).data
          if (status.status === 'complete') break
          if (status.status === 'failed') throw new Error(status.message)
          if (status.status === 'expired' || Date.now() > hold.expires) return false
          await sleep(OAUTH_POLL_MS)
        }
      }
      await opencodeCredentialStore
        .adoptSignin(vendorId, hold.signin.label, hold.signin.previousActive)
        .catch((err: unknown) =>
          logger.warn(
            'OpencodeAuth',
            `recording the ${vendorId} sign-in failed: ${logSafeError(err)}`
          )
        )
      this.invalidateCache()
      invalidateOpencodeModelCache()
      await opencodeCredentialStore.snapshot().catch(() => null)
      return true
    } finally {
      this.releaseOauthHold()
    }
  }

  /** Abandon an in-flight OAuth attempt and release the server it lives in. */
  async cancelVendorOauth(): Promise<void> {
    const hold = this.oauthHold
    if (!hold || hold.released) return
    await hold.client
      .call('integration.oauth.cancel', {
        params: { integrationID: hold.vendorId, attemptID: hold.attemptID }
      })
      .catch(() => {})
    this.releaseOauthHold()
  }

  /**
   * Remove ClaudeUI's API key for this vendor (its `cred_claudeui_*` rows) and
   * give the slot back to the user's previously active credential. A sign-in
   * made in opencode (also one made through its OAuth flow here) is opencode's
   * and stays. Without opencode installed, the removal waits for it.
   */
  async removeVendorAuth(vendorId: string): Promise<void> {
    // A removal always leaves a trace: the vendor and the call site, never the key.
    const context = `remove ${vendorId} (${removalCaller()})`
    await opencodeCredentialStore.removeSlot(vendorId, 'key', context)
    // A sign-in the user started from ClaudeUI is ClaudeUI's too (by provenance).
    await opencodeCredentialStore.removeSlot(vendorId, 'signin', context)
  }

  /**
   * Remove ClaudeUI's API key only (a shared provider's route) — a sign-in the
   * user started from ClaudeUI's provider screen is not that route's to take.
   */
  async removeVendorKey(vendorId: string): Promise<void> {
    await opencodeCredentialStore.removeSlot(
      vendorId,
      'key',
      `remove ${vendorId} key (${removalCaller()})`
    )
  }

  // ── CredentialSync's ChatGPT target (structural `OpencodeChatgptTarget`) ─────

  /** Vend the active ChatGPT account: access-only, padded expiry, rotate-by-replace (§5). */
  async vendChatgpt(
    cred: CodexCredentialInput,
    isClaudeuiToken?: ClaudeuiTokenCheck
  ): Promise<void> {
    await opencodeCredentialStore.vendChatgpt(
      { access: cred.access, expires: cred.expires, accountId: cred.accountId },
      isClaudeuiToken
    )
  }

  /** Remove ClaudeUI's ChatGPT rows and give the `openai` slot back (§5). */
  async removeChatgpt(
    context: string,
    isClaudeuiToken?: ClaudeuiTokenCheck,
    options: { vaultEmptying?: boolean } = {}
  ): Promise<boolean> {
    // The vault being emptied is an explicit disconnect: look even without
    // ClaudeUI's record (it may have been lost), and let ClaudeUI's row go even
    // if opencode then falls back to a copy. Every other removal keeps it then.
    return opencodeCredentialStore.removeSlot(
      CHATGPT_INTEGRATION_ID,
      'oauth',
      context,
      isClaudeuiToken,
      { force: options.vaultEmptying === true, vaultEmptying: options.vaultEmptying === true }
    )
  }

  /** What this process last vended (real expiry) — the pre-turn gate's input. */
  vendedChatgpt(): VendedChatgpt | null {
    return opencodeCredentialStore.vendedChatgpt()
  }

  // ── Session helpers ───────────────────────────────────────────────────────────

  /** An AccountRef for the vendor from the cached probe; null before the first probe. */
  buildAccountRef(vendorId: string): AccountRef | null {
    const entry = this.cachedVendorMap?.[vendorId]
    if (!entry) return null
    return {
      engineId: 'opencode',
      vendorId,
      billingType: entry.billingType,
      authState: entry.authState,
      label: entry.label
    }
  }

  /**
   * Which ACCOUNT this vendor's turns run under (ADR-071 §3): the identity of
   * the integration's active row as last read (identities only are cached),
   * else `opencode:<vendor>:native`. Synchronous: usage rows are written from
   * synchronous paths.
   */
  accountIdentity(vendorId: string): AccountIdentity {
    return (
      opencodeCredentialStore.cachedSnapshot()?.integrations.get(vendorId)?.identity ?? {
        accountKey: nativeAccountKey('opencode', vendorId),
        accountLabel: vendorId
      }
    )
  }

  /** Warm the probe cache (session start). */
  async warmCache(): Promise<void> {
    if (!this.cachedVendorMap) this.cachedVendorMap = await this.fetchVendorMap()
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private invalidateCache(): void {
    this.cachedVendorMap = null
  }

  private async withClient<T>(read: (client: OpencodeClient) => Promise<T>): Promise<T> {
    const conn = await opencodeServerManager.acquire(PERSISTED_SESSIONS_DIR, NO_TURN)
    try {
      return await read(new OpencodeClient(conn))
    } finally {
      opencodeServerManager.releaseIfCurrent(PERSISTED_SESSIONS_DIR, conn)
    }
  }

  private releaseOauthHold(): void {
    const hold = this.oauthHold
    if (hold && !hold.released) {
      hold.released = true
      opencodeServerManager.releaseIfCurrent(PERSISTED_SESSIONS_DIR, hold.conn)
    }
    if (this.oauthHold === hold) this.oauthHold = null
  }
}

/** Singleton opencode auth provider. */
export const opencodeAuthProvider = new OpencodeAuthProvider()

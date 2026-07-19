/**
 * PiAuthProvider — EngineAuthProvider implementation for the 'pi' engine (M3).
 *
 * Unlike opencode (a server ClaudeUI talks to over HTTP), pi has no server —
 * ClaudeUI reads/writes `~/.pi/agent/auth.json` DIRECTLY. This is the ONE
 * sanctioned write into `~/.pi/**`: a read-modify-write that preserves every
 * unknown provider entry and unknown field byte-for-byte, and keeps 0600 on
 * POSIX (see docs/protocol-pi/README.md "Auth" + vendor/pi-cli/docs/providers.md).
 *
 * pi's OAuth login (`pi /login`) is a TUI-interactive flow ClaudeUI does NOT
 * drive (capabilities.auth.canDriveLogin stays false — model-capabilities.ts's
 * PI_ENGINE_CAPABILITIES). oauthAuthorize/oauthCallback are therefore NOT
 * implemented here; the oauth entries in listVendorAuthOptions() are
 * informational only (the Settings UI shows a "run pi /login in a terminal"
 * hint instead of driving a flow — see PiVendors.tsx).
 *
 * probe()/setVendorApiKey()/removeVendorAuth() degrade to a no-op-safe result
 * on any failure — pi is optional, exactly like ClaudeAuthProvider/
 * OpencodeAuthProvider's own failure postures.
 */
import fs from 'fs'
import path from 'path'
import { piAgentDir } from '../services/pi-session-list'
import { invalidatePiModelCache } from '../pi/model-discovery'
import { logger } from '../services/logger'
import type { AccountRef, AuthState, VendorAuthMap, VendorAuthOption } from '../../shared/types'
import type { EngineAuthProvider } from './EngineAuthProvider'

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
 * API-key provider ids documented in vendor/pi-cli/docs/providers.md's
 * "API Keys" table (auth.json-key column), in the table's own order. This is
 * the exact, versioned, offline reference the M3 kickoff spec calls out —
 * deliberately NOT derived from the pinned source's ~140 built-in provider
 * definitions (most of which pi supports via env-var-only resolution with no
 * dedicated auth.json UX story documented for end users).
 */
const PI_API_KEY_VENDOR_IDS: readonly string[] = [
  'anthropic',
  'ant-ling',
  'azure-openai-responses',
  'openai',
  'deepseek',
  'nvidia',
  'google',
  'amazon-bedrock',
  'mistral',
  'groq',
  'cerebras',
  'cloudflare-ai-gateway',
  'cloudflare-workers-ai',
  'xai',
  'openrouter',
  'vercel-ai-gateway',
  'zai',
  'zai-coding-cn',
  'opencode',
  'opencode-go',
  'radius',
  'huggingface',
  'fireworks',
  'together',
  'kimi-coding',
  'minimax',
  'minimax-cn',
  'xiaomi',
  'xiaomi-token-plan-cn',
  'xiaomi-token-plan-ams',
  'xiaomi-token-plan-sgp'
]

/**
 * Subscription (OAuth-capable) provider ids — VERIFIED against the pinned pi
 * source (`packages/ai/src/providers/{anthropic,openai-codex,github-copilot,
 * xai,radius}.ts`'s `id:` fields; `openai-codex` has NO apiKey auth path at
 * all — oauth only), matching providers.md's "Subscriptions" section (ChatGPT
 * Plus/Pro, Claude Pro/Max, GitHub Copilot, xAI, Radius = 5, not 4 — do not
 * guess, per the kickoff spec). `github-copilot` has no auth.json-key row in
 * providers.md's API-key TABLE (even though its provider source also accepts
 * COPILOT_GITHUB_TOKEN) — so it gets the oauth option only here, consistent
 * with deriving the api-key catalog strictly from the docs table.
 */
const PI_SUBSCRIPTION_VENDOR_IDS: readonly string[] = [
  'anthropic',
  'openai-codex',
  'github-copilot',
  'xai',
  'radius'
]

/** Best-effort read + parse of auth.json. Returns {} on any failure (missing file, corrupt JSON, non-object). */
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

/** Write auth.json, creating `~/.pi/agent/` if absent and setting 0600 on POSIX (no-op mode on Windows). */
function writeAuthFile(data: PiAuthFile): void {
  const filePath = resolvePiAuthJsonPath()
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { mode: 0o600 })
  // fs.writeFileSync's `mode` only applies to a NEWLY created file — an
  // existing file (e.g. one pi itself created) keeps its prior permissions.
  // Force 0600 explicitly so a ClaudeUI-mediated write never widens it back
  // out; no-op on Windows (chmod bits are meaningless there).
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(filePath, 0o600)
    } catch (err) {
      logger.warn('PiAuth', `chmod 0600 failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
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
        { type: 'api', label: 'API key', prompts: [{ type: 'text', key: 'key', message: 'API key', secret: true }] }
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
    const file = readAuthFile()
    file[vendorId] = { ...file[vendorId], type: 'api_key', key }
    writeAuthFile(file)
    invalidatePiModelCache()
    await this.probe()
  }

  /** Delete a provider's entry from auth.json entirely. Preserves every other entry. */
  async removeVendorAuth(vendorId: string): Promise<void> {
    const file = readAuthFile()
    delete file[vendorId]
    writeAuthFile(file)
    invalidatePiModelCache()
    await this.probe()
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

/**
 * AuthVault — encrypted credential store for Codex (ChatGPT) OAuth (M6a).
 *
 * `~/.claude/ui/auth-vault.json`, encrypted at rest via Electron's
 * `safeStorage` when available, falling back to 0600 plaintext (parity with
 * the engines' OWN auth stores — pi's `~/.pi/agent/auth.json`
 * (PiAuthProvider.ts) and opencode's `auth.json` are both unencrypted 0600
 * today; this is a flagged pre-existing posture, not a regression introduced
 * here).
 *
 * M6a scope is deliberately narrow: storage + the login-flow entry points
 * only (beginLogin/completeLogin/cancelLogin). Feeding credentials to
 * pi/opencode, background refresh-before-expiry, and a filesystem watch all
 * land in M6b — this milestone is the standalone, fully unit-tested security
 * core, not wired into any engine or UI yet.
 *
 * HARD SAFETY NOTE: nothing here may be exercised against the real
 * auth.openai.com in any test. beginLogin()/completeLogin() drive a
 * `LoginFlow` (real implementation: CodexLoginFlow, codex-oauth.ts) whose
 * token exchange must be reached ONLY through a mocked `deps.fetch` in tests
 * — a real exchange/refresh ROTATES the shared refresh_token and strands the
 * user's actual pi + opencode Codex session. See codex-oauth.ts's header.
 */
import { safeStorage as electronSafeStorage } from 'electron'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { logger } from '../../services/logger'
import { CodexLoginFlow, type LoginFlow, type VaultCredential } from './codex-oauth'

/**
 * `~/.claude/ui/` — the SAME per-OS-user config/data root db.ts's CONFIG_DIR
 * resolves to. Deliberately re-derived here (not imported from db.ts) so this
 * security-core module never pulls in db.ts's better-sqlite3 dependency chain
 * — same "each file derives its own `~/.claude/ui/...` path" convention
 * already used throughout src/main/services (automation-manager.ts, logger.ts,
 * account-manager.ts, persisted-sessions-dir.ts, etc). Computed at CALL time
 * (not a module-load-time const) so it honors the same `os.homedir()` test
 * mock the rest of the codebase uses (piAgentDir(), persisted-sessions-dir.ts).
 */
export function claudeUiDir(): string {
  return path.join(os.homedir(), '.claude', 'ui')
}

/** `~/.claude/ui/auth-vault.json` — exported so tests can locate the on-disk file. */
export function vaultPath(): string {
  return path.join(claudeUiDir(), 'auth-vault.json')
}

/** Canonical vault key for this milestone's only credential. */
const CODEX_KEY = 'openai-codex'

interface VaultFileEncrypted {
  v: 1
  encrypted: true
  /** base64 of safeStorage.encryptString(JSON.stringify(Record<string, VaultCredential>)). */
  data: string
}
interface VaultFilePlain {
  v: 1
  encrypted: false
  /** JSON.stringify(Record<string, VaultCredential>). */
  data: string
}
type VaultFile = VaultFileEncrypted | VaultFilePlain

/** The slice of Electron's `safeStorage` this module needs — lets tests inject a fake without touching Electron at all. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

export interface AuthVaultDeps {
  safeStorage?: SafeStorageLike
  now?: () => number
  loginFlowFactory?: () => LoginFlow
}

export class AuthVault {
  private readonly safeStorage: SafeStorageLike
  private readonly now: () => number
  private readonly loginFlowFactory: () => LoginFlow

  /**
   * The in-flight login flow started by beginLogin(), if any — the single-flight
   * guard. See beginLogin()'s doc comment for the chosen behavior (reject the
   * second call, don't cancel the first).
   */
  private activeFlow: LoginFlow | undefined

  constructor(deps: AuthVaultDeps = {}) {
    this.safeStorage = deps.safeStorage ?? electronSafeStorage
    this.now = deps.now ?? (() => Date.now())
    this.loginFlowFactory = deps.loginFlowFactory ?? (() => new CodexLoginFlow({ now: this.now }))
  }

  /** Best-effort read. Never throws — an absent, corrupt, or undecryptable file all degrade to null. */
  async load(): Promise<VaultCredential | null> {
    const all = this.readAll()
    return all[CODEX_KEY] ?? null
  }

  /** Persist a credential under the canonical Codex key, preserving any other (future) key already in the file. */
  async save(cred: VaultCredential): Promise<void> {
    const all = this.readAll()
    all[CODEX_KEY] = cred
    this.writeAll(all)
  }

  /** Remove the file entirely. No-op (not an error) if it's already absent. */
  async clear(): Promise<void> {
    try {
      fs.unlinkSync(vaultPath())
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn('AuthVault', `clear() failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  /**
   * Start a login flow, returning the URL the caller should open in a browser.
   *
   * Single-flight rule (DECISION): a second beginLogin() while one is already
   * pending REJECTS immediately and leaves the first flow untouched — it does
   * NOT cancel the in-progress flow. Rationale: the first flow's browser tab
   * may already be open with the user mid-authorization; silently killing it
   * on a stray double-click (or a UI re-render re-invoking beginLogin) would
   * be a more surprising failure mode than a clear "already in progress"
   * rejection. Callers that genuinely want to restart must cancelLogin() first.
   */
  async beginLogin(): Promise<{ authorizeUrl: string }> {
    if (this.activeFlow) {
      throw new Error('AuthVault: a login is already in progress')
    }
    const flow = this.loginFlowFactory()
    this.activeFlow = flow
    try {
      const { authorizeUrl } = await flow.start()
      return { authorizeUrl }
    } catch (err) {
      this.activeFlow = undefined
      throw err
    }
  }

  /** Await the callback for the flow started by beginLogin(), persisting the credential on success. */
  async completeLogin(): Promise<VaultCredential> {
    const flow = this.activeFlow
    if (!flow) {
      throw new Error('AuthVault: no login in progress — call beginLogin() first')
    }
    try {
      const cred = await flow.waitForCallback()
      await this.save(cred)
      return cred
    } finally {
      this.activeFlow = undefined
    }
  }

  /** Abandon the in-flight login started via beginLogin(), if any. Safe to call with no active flow. */
  cancelLogin(): void {
    this.activeFlow?.cancel()
    this.activeFlow = undefined
  }

  // ---------------------------------------------------------------------
  // File I/O
  // ---------------------------------------------------------------------

  /** Best-effort read + decrypt of the whole vault file. Any failure (absent/corrupt/undecryptable) → {}. */
  private readAll(): Record<string, VaultCredential> {
    try {
      const raw = fs.readFileSync(vaultPath(), 'utf-8')
      const parsed = JSON.parse(raw) as VaultFile
      if (!parsed || typeof parsed !== 'object' || parsed.v !== 1) return {}

      const json = parsed.encrypted
        ? this.safeStorage.decryptString(Buffer.from(parsed.data, 'base64'))
        : parsed.data

      const data = JSON.parse(json)
      if (!data || typeof data !== 'object' || Array.isArray(data)) return {}
      return data as Record<string, VaultCredential>
    } catch {
      return {}
    }
  }

  /**
   * Write the whole vault file. Encrypts via safeStorage when available;
   * otherwise falls back to plaintext with a logged warning (see the module
   * header — parity with the engines' own auth stores, not a new regression).
   * 0600 on POSIX (chmod, mirroring PiAuthProvider's writeAuthFile — a fresh
   * file gets its mode from `fs.writeFileSync`'s `mode` option, but an
   * existing file keeps its prior permissions, so chmod is forced explicitly).
   */
  private writeAll(all: Record<string, VaultCredential>): void {
    const dir = claudeUiDir()
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

    const json = JSON.stringify(all)
    let file: VaultFile
    if (this.safeStorage.isEncryptionAvailable()) {
      const data = this.safeStorage.encryptString(json).toString('base64')
      file = { v: 1, encrypted: true, data }
    } else {
      logger.warn(
        'AuthVault',
        'safeStorage encryption unavailable — writing auth-vault.json in plaintext (0600). ' +
          'This mirrors the existing engine auth stores (pi auth.json, opencode auth.json), which are ' +
          'also unencrypted 0600 today; flagged here, not a new regression.'
      )
      file = { v: 1, encrypted: false, data: json }
    }

    const filePath = vaultPath()
    fs.writeFileSync(filePath, JSON.stringify(file), { mode: 0o600 })
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(filePath, 0o600)
      } catch (err) {
        logger.warn('AuthVault', `chmod 0600 failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
}

/** Singleton — real Electron safeStorage + real fetch/clock. M6b/M6c wire engines/UI to this. */
export const authVault = new AuthVault()

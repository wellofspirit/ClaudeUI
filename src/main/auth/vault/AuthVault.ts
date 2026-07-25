import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { validateSharedProviderId } from '../../../shared/shared-provider'
import { logger } from '../../services/logger'
import { CodexLoginFlow, type LoginFlow, type VaultCredential } from './codex-oauth'

export function claudeUiDir(): string {
  return path.join(os.homedir(), '.claude', 'ui')
}
export function vaultPath(): string {
  return path.join(claudeUiDir(), 'auth-vault.json')
}
export const CHATGPT_PROVIDER_ID = 'chatgpt'
export type VaultCredentialRecord = VaultCredential | { type: 'api_key'; key: string }
interface VaultFileV2 {
  v: 2
  credentials: Record<string, VaultCredentialRecord>
}

export interface AuthVaultDeps {
  now?: () => number
  loginFlowFactory?: () => LoginFlow
}

export class AuthVault {
  private readonly now: () => number
  private readonly loginFlowFactory: () => LoginFlow
  private activeFlow: LoginFlow | undefined

  constructor(deps: AuthVaultDeps = {}) {
    this.now = deps.now ?? (() => Date.now())
    this.loginFlowFactory = deps.loginFlowFactory ?? (() => new CodexLoginFlow({ now: this.now }))
  }

  async load(): Promise<VaultCredential | null> {
    const credential = await this.loadCredential(CHATGPT_PROVIDER_ID)
    return credential?.type === 'oauth' ? credential : null
  }
  async save(credential: VaultCredential): Promise<void> {
    await this.saveCredential(CHATGPT_PROVIDER_ID, credential)
  }
  async loadCredential(providerId: string): Promise<VaultCredentialRecord | null> {
    validateSharedProviderId(providerId)
    return this.readAll().credentials[providerId] ?? null
  }
  async saveCredential(providerId: string, credential: VaultCredentialRecord): Promise<void> {
    validateSharedProviderId(providerId)
    if (!isCredential(credential)) throw new Error('Invalid vault credential')
    const state = this.readAll()
    state.credentials[providerId] = credential
    this.write(state)
  }
  async removeCredential(providerId: string): Promise<void> {
    validateSharedProviderId(providerId)
    const state = this.readAll()
    delete state.credentials[providerId]
    if (Object.keys(state.credentials).length === 0) await this.clear()
    else this.write(state)
  }
  async clear(): Promise<void> {
    try {
      fs.unlinkSync(vaultPath())
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
        logger.warn('AuthVault', `clear failed: ${String(err)}`)
    }
  }
  hasUnreadableLegacyVault(): boolean {
    try {
      const value = JSON.parse(fs.readFileSync(vaultPath(), 'utf8')) as {
        v?: unknown
        encrypted?: unknown
      }
      return value.v === 1 && value.encrypted === true
    } catch {
      return false
    }
  }
  async beginLogin(): Promise<{ authorizeUrl: string }> {
    if (this.activeFlow) throw new Error('AuthVault: a login is already in progress')
    this.activeFlow = this.loginFlowFactory()
    try {
      return { authorizeUrl: (await this.activeFlow.start()).authorizeUrl }
    } catch (err) {
      this.activeFlow = undefined
      throw err
    }
  }
  async completeLogin(): Promise<VaultCredential> {
    const flow = this.activeFlow
    if (!flow) throw new Error('AuthVault: no login in progress — call beginLogin() first')
    try {
      const credential = await flow.waitForCallback()
      await this.save(credential)
      return credential
    } finally {
      this.activeFlow = undefined
    }
  }
  cancelLogin(): void {
    this.activeFlow?.cancel()
    this.activeFlow = undefined
  }

  private readAll(): VaultFileV2 {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(vaultPath(), 'utf8'))
      if (!parsed || typeof parsed !== 'object') return emptyVault()
      if ((parsed as { v?: unknown }).v === 2) return parseV2(parsed)
      const legacy = parsed as { v?: unknown; encrypted?: unknown; data?: unknown }
      if (legacy.v === 1 && legacy.encrypted === false && typeof legacy.data === 'string') {
        const entries: unknown = JSON.parse(legacy.data)
        const credential =
          entries && typeof entries === 'object'
            ? (entries as Record<string, unknown>)['openai-codex']
            : undefined
        return isCredential(credential)
          ? { v: 2, credentials: { [CHATGPT_PROVIDER_ID]: credential } }
          : emptyVault()
      }
    } catch {
      /* malformed vault is disconnected */
    }
    return emptyVault()
  }
  private write(file: VaultFileV2): void {
    fs.mkdirSync(claudeUiDir(), { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') fs.chmodSync(claudeUiDir(), 0o700)
    const target = vaultPath()
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
    try {
      fs.writeFileSync(temporary, JSON.stringify(file), { mode: 0o600 })
      if (process.platform !== 'win32') fs.chmodSync(temporary, 0o600)
      fs.renameSync(temporary, target)
      if (process.platform !== 'win32') fs.chmodSync(target, 0o600)
    } catch (err) {
      try {
        fs.unlinkSync(temporary)
      } catch {
        /* cleanup */
      }
      throw err
    }
  }
}
function emptyVault(): VaultFileV2 {
  return { v: 2, credentials: {} }
}
function parseV2(value: object): VaultFileV2 {
  const entries = (value as { credentials?: unknown }).credentials
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return emptyVault()
  const credentials: Record<string, VaultCredentialRecord> = {}
  for (const [id, credential] of Object.entries(entries)) {
    try {
      validateSharedProviderId(id)
      if (isCredential(credential)) credentials[id] = credential
    } catch {
      // Ignore malformed or unsafe credential entries.
    }
  }
  return { v: 2, credentials }
}
function isCredential(value: unknown): value is VaultCredentialRecord {
  if (!value || typeof value !== 'object') return false
  const credential = value as Record<string, unknown>
  return credential.type === 'api_key'
    ? typeof credential.key === 'string' && credential.key.length > 0
    : credential.type === 'oauth' &&
        typeof credential.access === 'string' &&
        credential.access.length > 0 &&
        typeof credential.refresh === 'string' &&
        credential.refresh.length > 0 &&
        typeof credential.expires === 'number' &&
        Number.isFinite(credential.expires) &&
        credential.expires > 0
}
export const authVault = new AuthVault()

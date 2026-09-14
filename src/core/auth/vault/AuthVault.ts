import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { validateSharedProviderId } from '../../../shared/shared-provider'
import { logger } from '../../services/logger'
import { CodexLoginFlow, type LoginFlow, type VaultCredential } from './codex-oauth'
import {
  CodexDeviceCodeFlow,
  type DeviceCodeFlowLike,
  type DeviceCodeStart
} from './codex-device-code'

export function claudeUiDir(): string {
  return path.join(os.homedir(), '.claude', 'ui')
}
export function vaultPath(): string {
  return path.join(claudeUiDir(), 'auth-vault.json')
}
export const CHATGPT_PROVIDER_ID = 'chatgpt'
export type VaultApiKeyRecord = { type: 'api_key'; key: string }
export type VaultCredentialRecord = VaultCredential | VaultApiKeyRecord

/**
 * One stored subscription account (ADR-068 §2).
 *
 * `id` is the vault's OWN stable handle — minted here, never the provider's —
 * because it is what a session pin, a radio button and a remove command name,
 * and it must survive a re-login that rotates every token on the record.
 * `accountId` is the ChatGPT WORKSPACE id read off the JWT, and is the identity
 * `upsertAccount` matches on.
 */
export interface VaultAccount {
  id: string
  email?: string
  accountId?: string
  planType?: string
  credential: VaultCredential
  addedAt: number
}

/** One provider's account list plus which of them is active (null = none). */
export interface VaultAccountList {
  activeId: string | null
  list: VaultAccount[]
}

interface VaultFileV2 {
  v: 2
  credentials: Record<string, VaultCredentialRecord>
}

/**
 * v3 (ADR-068 §2): `credentials` keeps ONLY API-key records (custom providers);
 * every OAuth subscription lives in `accounts` as a list plus an active id.
 * A v2 file migrates on read — see {@link AuthVault.readAll} — and is rewritten
 * in this shape by the next write.
 */
interface VaultFileV3 {
  v: 3
  credentials: Record<string, VaultApiKeyRecord>
  accounts: Record<string, VaultAccountList>
}

export interface AuthVaultDeps {
  now?: () => number
  loginFlowFactory?: () => LoginFlow
  /**
   * The device-code sibling of {@link loginFlowFactory} (ADR-068 §3, Slice 7).
   * Separate factory rather than a mode flag on the loopback one: the two flows
   * share no machinery — one binds a loopback server, the other polls an
   * endpoint — and both stay behind an injection point so tests use fakes.
   */
  deviceCodeFlowFactory?: () => DeviceCodeFlowLike
  /** Injectable account-id minter — tests want deterministic ids. */
  newAccountId?: () => string
}

/**
 * The ONE login slot, tagged with which kind of flow is in it. `completeLogin`
 * awaits whichever it holds, so every caller above this line (CredentialSync,
 * PiAuthProvider, the IPC layer) stays flow-agnostic.
 */
type ActiveLoginFlow =
  { kind: 'loopback'; flow: LoginFlow } | { kind: 'device'; flow: DeviceCodeFlowLike }

export class AuthVault {
  private readonly now: () => number
  private readonly loginFlowFactory: () => LoginFlow
  private readonly deviceCodeFlowFactory: () => DeviceCodeFlowLike
  private readonly newAccountId: () => string
  private activeFlow: ActiveLoginFlow | undefined

  constructor(deps: AuthVaultDeps = {}) {
    this.now = deps.now ?? (() => Date.now())
    this.loginFlowFactory = deps.loginFlowFactory ?? (() => new CodexLoginFlow({ now: this.now }))
    this.deviceCodeFlowFactory =
      deps.deviceCodeFlowFactory ?? (() => new CodexDeviceCodeFlow({ now: this.now }))
    this.newAccountId = deps.newAccountId ?? (() => randomBytes(8).toString('hex'))
  }

  /**
   * The ACTIVE ChatGPT account's credential. Kept as-is across the v3 move: it
   * is what `CredentialSync` feeds to pi and opencode, whose stores hold exactly
   * one Codex entry each (ADR-068 §2).
   */
  async load(): Promise<VaultCredential | null> {
    const credential = await this.loadCredential(CHATGPT_PROVIDER_ID)
    return credential?.type === 'oauth' ? credential : null
  }
  async save(credential: VaultCredential): Promise<void> {
    await this.saveCredential(CHATGPT_PROVIDER_ID, credential)
  }
  async loadCredential(providerId: string): Promise<VaultCredentialRecord | null> {
    validateSharedProviderId(providerId)
    const state = this.readAll()
    const key = state.credentials[providerId]
    if (key) return key
    return activeAccount(state.accounts[providerId])?.credential ?? null
  }
  /**
   * An OAuth record NEVER lands in the single `credentials` slot again: it routes
   * to {@link upsertAccount}, so no caller can silently write the pre-v3 shape
   * and strand the account list (ADR-068 §2).
   */
  async saveCredential(providerId: string, credential: VaultCredentialRecord): Promise<void> {
    validateSharedProviderId(providerId)
    if (!isCredential(credential)) throw new Error('Invalid vault credential')
    if (credential.type === 'oauth') {
      await this.upsertAccount(providerId, credential)
      return
    }
    const state = this.readAll()
    state.credentials[providerId] = credential
    this.write(state)
  }
  async removeCredential(providerId: string): Promise<void> {
    validateSharedProviderId(providerId)
    const state = this.readAll()
    delete state.credentials[providerId]
    delete state.accounts[providerId]
    await this.writeOrClear(state)
  }

  // -------------------------------------------------------------------------
  // Accounts (ADR-068 §2)
  // -------------------------------------------------------------------------

  async listAccounts(providerId: string): Promise<VaultAccount[]> {
    validateSharedProviderId(providerId)
    return this.readAll().accounts[providerId]?.list ?? []
  }

  async getActiveAccountId(providerId: string): Promise<string | null> {
    validateSharedProviderId(providerId)
    return this.readAll().accounts[providerId]?.activeId ?? null
  }

  /** Point the provider at a stored account. Refuses an id it does not hold. */
  async setActiveAccount(providerId: string, id: string): Promise<void> {
    validateSharedProviderId(providerId)
    const state = this.readAll()
    const entry = state.accounts[providerId]
    if (!entry?.list.some((account) => account.id === id)) {
      throw new Error(`Unknown vault account: ${id}`)
    }
    entry.activeId = id
    this.write(state)
  }

  /**
   * Store a freshly-obtained credential against its account.
   *
   * MATCHING is by ChatGPT WORKSPACE id (`credential.accountId`): the same
   * workspace updates its account in place — same vault id, same active flag, so
   * a re-login of the active account stays active — and a new workspace is
   * appended WITHOUT stealing active. The first account ever stored becomes
   * active, since a provider with one account and no active one is unusable.
   *
   * A credential carrying NO workspace claim (a JWT that omitted it) matches the
   * active account only when that account has no workspace id either — i.e. the
   * single unidentified slot a v2 migration leaves behind. It must never clobber
   * an identified account, so otherwise it is appended.
   */
  async upsertAccount(providerId: string, credential: VaultCredential): Promise<VaultAccount> {
    validateSharedProviderId(providerId)
    if (credential?.type !== 'oauth' || !isCredential(credential)) {
      throw new Error('Invalid vault credential')
    }
    const state = this.readAll()
    const entry = state.accounts[providerId] ?? { activeId: null, list: [] }
    const match = matchAccount(entry, credential)
    const account: VaultAccount = match
      ? { ...match, ...derivedFields(credential, match), credential }
      : {
          id: this.newAccountId(),
          ...derivedFields(credential),
          credential,
          addedAt: this.now()
        }
    entry.list = match
      ? entry.list.map((existing) => (existing.id === match.id ? account : existing))
      : [...entry.list, account]
    if (!entry.list.some((existing) => existing.id === entry.activeId)) entry.activeId = account.id
    state.accounts[providerId] = entry
    this.write(state)
    return account
  }

  /**
   * Drop one account. Removing the ACTIVE one promotes the most recently added
   * of what remains; removing the last leaves `activeId` null (the provider is
   * then disconnected, and the engine copies are cleaned up by `CredentialSync`).
   */
  async removeAccount(providerId: string, id: string): Promise<void> {
    validateSharedProviderId(providerId)
    const state = this.readAll()
    const entry = state.accounts[providerId]
    if (!entry) return
    const remaining = entry.list.filter((account) => account.id !== id)
    if (remaining.length === entry.list.length) return // unknown id — nothing to do
    if (entry.activeId === id) entry.activeId = newestAccount(remaining)?.id ?? null
    entry.list = remaining
    if (remaining.length === 0) delete state.accounts[providerId]
    else state.accounts[providerId] = entry
    await this.writeOrClear(state)
  }

  /**
   * Rewrite ONE account's credential — the per-account refresher's writer. It
   * touches neither the active id nor any other account, which is what lets a
   * background account rotate its token without disturbing the one in use.
   * An unknown id is a no-op: the account can legitimately have been removed
   * while its refresh was in flight.
   */
  async saveAccountCredential(
    providerId: string,
    id: string,
    credential: VaultCredential
  ): Promise<void> {
    validateSharedProviderId(providerId)
    if (credential?.type !== 'oauth' || !isCredential(credential)) {
      throw new Error('Invalid vault credential')
    }
    const state = this.readAll()
    const entry = state.accounts[providerId]
    const existing = entry?.list.find((account) => account.id === id)
    if (!entry || !existing) {
      logger.debug('AuthVault', `saveAccountCredential: no account ${id} under ${providerId}`)
      return
    }
    const updated: VaultAccount = {
      ...existing,
      ...derivedFields(credential, existing),
      credential
    }
    entry.list = entry.list.map((account) => (account.id === id ? updated : account))
    this.write(state)
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
  /**
   * Take the single login slot for a new attempt, or refuse.
   *
   * Three cases, in order:
   *
   *  1. _A ZOMBIE flow_ — one that already reached a terminal outcome (its 5-min
   *     timeout fired, its device code expired, or it errored/was cancelled) but
   *     whose completeLogin() was never called, so activeFlow was never cleared.
   *     Superseded. Without this, an abandoned authorize (user closed the
   *     browser tab, or the renderer reloaded between authorize and callback)
   *     would block re-login with "a login is already in progress" until cancel
   *     or restart.
   *  2. _A LIVE DEVICE flow_ — CANCELLED, and the slot taken (ADR-068 §3, Slice
   *     7 design point 6: "a second `device-code-start` while one is live
   *     cancels the first"). A device flow holds the slot for a full FIFTEEN
   *     minutes with nothing host-side to shorten it, so refusing here is how a
   *     page reload or a second tab strands the user for a quarter of an hour.
   *     Cancelling is also what makes the dialog's "Paste the callback URL
   *     instead" safe: it fires the cancel and the PKCE start back to back, and
   *     the cancel no longer has to win that race.
   *  3. _A LIVE LOOPBACK flow_ — still refused, as before. Its 5-minute timeout
   *     bounds it, its browser tab is open in front of the user, and its
   *     loopback server is bound to a fixed port; tearing it down under a second
   *     caller would abort a sign-in the user is in the middle of.
   */
  private claimLoginSlot(): void {
    const active = this.activeFlow
    if (!active) return
    if (active.flow.isSettled?.()) {
      this.activeFlow = undefined
      return
    }
    if (active.kind === 'device') {
      active.flow.cancel()
      this.activeFlow = undefined
      return
    }
    throw new Error('AuthVault: a login is already in progress')
  }

  async beginLogin(): Promise<{ authorizeUrl: string }> {
    this.claimLoginSlot()
    const flow = this.loginFlowFactory()
    this.activeFlow = { kind: 'loopback', flow }
    try {
      return { authorizeUrl: (await flow.start()).authorizeUrl }
    } catch (err) {
      this.activeFlow = undefined
      throw err
    }
  }
  /**
   * Start a DEVICE-CODE login (ADR-068 §3, Slice 7) into the same single slot,
   * so `completeLogin()` / `cancelLogin()` need no new verb. Returns only what
   * the user has to see: the page to open, the code to type, and when it dies.
   */
  async beginDeviceCodeLogin(): Promise<DeviceCodeStart> {
    this.claimLoginSlot()
    const flow = this.deviceCodeFlowFactory()
    this.activeFlow = { kind: 'device', flow }
    try {
      return await flow.start()
    } catch (err) {
      this.activeFlow = undefined
      throw err
    }
  }
  /** Await whichever flow is live — the loopback redirect, or the device-code poll — then persist. */
  async completeLogin(): Promise<VaultCredential> {
    const active = this.activeFlow
    if (!active) throw new Error('AuthVault: no login in progress — call beginLogin() first')
    try {
      const credential =
        active.kind === 'device'
          ? await active.flow.waitForCompletion()
          : await active.flow.waitForCallback()
      await this.save(credential)
      return credential
    } finally {
      this.activeFlow = undefined
    }
  }
  /**
   * Complete the active login from a PASTED callback URL / bare code (ADR-057's
   * remote paste-back path). Mirrors completeLogin() — persist + clear the
   * active flow — but drives the flow's paste completion instead of the loopback
   * wait. Throws when the active flow does not support pasted completion (a fake
   * without the method, or a flow kind that has no loopback to bypass).
   */
  async completeLoginFromPastedInput(input: string): Promise<VaultCredential> {
    const active = this.activeFlow
    if (!active) throw new Error('AuthVault: no login in progress — call beginLogin() first')
    // A device-code flow has no loopback to bypass and no verifier of its own —
    // the server holds both — so it falls into the same refusal as a fake
    // without the method.
    const flow = active.kind === 'loopback' ? active.flow : undefined
    if (!flow?.completeFromPastedInput) {
      throw new Error('AuthVault: the active login flow does not support pasted completion')
    }
    try {
      const credential = await flow.completeFromPastedInput(input)
      await this.save(credential)
      return credential
    } finally {
      this.activeFlow = undefined
    }
  }
  cancelLogin(): void {
    this.activeFlow?.flow.cancel()
    this.activeFlow = undefined
  }

  /**
   * The vault as v3, whatever version is on disk.
   *
   * v2 and plaintext v1 migrate HERE, on every read, and are only persisted by
   * the next write — the same lazy shape the v1 → v2 move already had. That is
   * why a migrated account's id is DERIVED rather than random: two reads before
   * the first write must agree on it, or a `listAccounts()` followed by a
   * `setActiveAccount()` would name an account that no longer exists.
   */
  private readAll(): VaultFileV3 {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(vaultPath(), 'utf8'))
      if (!parsed || typeof parsed !== 'object') return emptyVault()
      if ((parsed as { v?: unknown }).v === 3) return parseV3(parsed)
      if ((parsed as { v?: unknown }).v === 2) return migrateV2(parseV2(parsed), this.now())
      const legacy = parsed as { v?: unknown; encrypted?: unknown; data?: unknown }
      if (legacy.v === 1 && legacy.encrypted === false && typeof legacy.data === 'string') {
        const entries: unknown = JSON.parse(legacy.data)
        const credential =
          entries && typeof entries === 'object'
            ? (entries as Record<string, unknown>)['openai-codex']
            : undefined
        return isCredential(credential)
          ? migrateV2({ v: 2, credentials: { [CHATGPT_PROVIDER_ID]: credential } }, this.now())
          : emptyVault()
      }
    } catch {
      /* malformed vault is disconnected */
    }
    return emptyVault()
  }
  /** Persist, or unlink once the vault holds nothing at all (the pre-v3 rule). */
  private async writeOrClear(state: VaultFileV3): Promise<void> {
    if (Object.keys(state.credentials).length === 0 && Object.keys(state.accounts).length === 0) {
      await this.clear()
      return
    }
    this.write(state)
  }
  private write(file: VaultFileV3): void {
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
function emptyVault(): VaultFileV3 {
  return { v: 3, credentials: {}, accounts: {} }
}
function parseV2(value: object): VaultFileV2 {
  const entries = (value as { credentials?: unknown }).credentials
  if (!entries || typeof entries !== 'object' || Array.isArray(entries))
    return { v: 2, credentials: {} }
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

/** Every v2 OAuth credential becomes ONE active account; API keys stay keys. */
function migrateV2(file: VaultFileV2, now: number): VaultFileV3 {
  const migrated = emptyVault()
  for (const [id, credential] of Object.entries(file.credentials)) {
    if (credential.type === 'api_key') {
      migrated.credentials[id] = credential
      continue
    }
    const account: VaultAccount = {
      id: migratedAccountId(id, credential),
      ...derivedFields(credential),
      credential,
      addedAt: now
    }
    migrated.accounts[id] = { activeId: account.id, list: [account] }
  }
  return migrated
}

/**
 * A migrated account's id, derived so repeated reads of an un-rewritten v2 file
 * agree (see {@link AuthVault.readAll}). The workspace id / email are the only
 * stable, NON-SECRET things a v2 record carries; a vault with neither has
 * exactly one account, so the constant tail is unambiguous.
 */
function migratedAccountId(providerId: string, credential: VaultCredential): string {
  const seed = credential.accountId ?? credential.email ?? 'legacy'
  return createHash('sha256').update(`${providerId}|${seed}`).digest('hex').slice(0, 16)
}

function parseV3(value: object): VaultFileV3 {
  const file = emptyVault()
  const credentials = (value as { credentials?: unknown }).credentials
  if (credentials && typeof credentials === 'object' && !Array.isArray(credentials)) {
    for (const [id, credential] of Object.entries(credentials)) {
      try {
        validateSharedProviderId(id)
        // v3 keeps ONLY API keys here; an OAuth record in this slot is a
        // hand-written (or downgraded) file and is ignored rather than trusted.
        if (isCredential(credential) && credential.type === 'api_key')
          file.credentials[id] = credential
      } catch {
        // Ignore malformed or unsafe credential entries.
      }
    }
  }
  const accounts = (value as { accounts?: unknown }).accounts
  if (accounts && typeof accounts === 'object' && !Array.isArray(accounts)) {
    for (const [id, entry] of Object.entries(accounts)) {
      try {
        validateSharedProviderId(id)
        const parsed = parseAccountList(entry)
        if (parsed.list.length > 0) file.accounts[id] = parsed
      } catch {
        // Ignore malformed or unsafe account entries.
      }
    }
  }
  return file
}

function parseAccountList(value: unknown): VaultAccountList {
  if (!value || typeof value !== 'object') return { activeId: null, list: [] }
  const raw = (value as { list?: unknown }).list
  const list: VaultAccount[] = []
  if (Array.isArray(raw)) {
    for (const candidate of raw) {
      const account = parseAccount(candidate)
      if (account && !list.some((existing) => existing.id === account.id)) list.push(account)
    }
  }
  // A non-empty list with no usable active id is a corrupt file (every write
  // path keeps one selected, and an emptied list drops the whole entry), so it
  // self-heals onto the newest account rather than leaving the provider with
  // accounts it cannot use.
  const activeId = (value as { activeId?: unknown }).activeId
  const active =
    typeof activeId === 'string' && list.some((account) => account.id === activeId)
      ? activeId
      : (newestAccount(list)?.id ?? null)
  return { activeId: active, list }
}

function parseAccount(value: unknown): VaultAccount | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  if (typeof candidate.id !== 'string' || !candidate.id) return null
  const credential = candidate.credential
  if (!isCredential(credential) || credential.type !== 'oauth') return null
  return {
    id: candidate.id,
    ...derivedFields(credential, {
      email: optionalString(candidate.email),
      accountId: optionalString(candidate.accountId),
      planType: optionalString(candidate.planType)
    }),
    credential,
    addedAt:
      typeof candidate.addedAt === 'number' && Number.isFinite(candidate.addedAt)
        ? candidate.addedAt
        : 0
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

/**
 * The account fields a credential carries — the credential wins, the account's
 * existing values are the fallback (a refresh whose id_token omits the profile
 * claims must not blank an email the login already learned).
 */
function derivedFields(
  credential: VaultCredential,
  prior: { email?: string; accountId?: string; planType?: string } = {}
): { email?: string; accountId?: string; planType?: string } {
  const email = credential.email ?? prior.email
  const accountId = credential.accountId ?? prior.accountId
  const planType = credential.planType ?? prior.planType
  return {
    ...(email ? { email } : {}),
    ...(accountId ? { accountId } : {}),
    ...(planType ? { planType } : {})
  }
}

function activeAccount(entry: VaultAccountList | undefined): VaultAccount | undefined {
  return entry?.list.find((account) => account.id === entry.activeId)
}

/** Most recently added; ties break towards the later list position. */
function newestAccount(list: readonly VaultAccount[]): VaultAccount | undefined {
  return list.reduce<VaultAccount | undefined>(
    (newest, account) => (!newest || account.addedAt >= newest.addedAt ? account : newest),
    undefined
  )
}

/** Which stored account a freshly-obtained credential belongs to — see {@link AuthVault.upsertAccount}. */
function matchAccount(
  entry: VaultAccountList,
  credential: VaultCredential
): VaultAccount | undefined {
  if (credential.accountId) {
    return entry.list.find((account) => account.accountId === credential.accountId)
  }
  return entry.list.find((account) => account.id === entry.activeId && !account.accountId)
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

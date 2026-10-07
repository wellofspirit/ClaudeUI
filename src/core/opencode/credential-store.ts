/**
 * ClaudeUI's credentials in opencode 2.x's credential table (ADR-093 §5).
 *
 * 2.x keeps credentials in its database, several per integration with one
 * ACTIVE, behind `/api/credential`. The data dir is shared with the user's own
 * opencode (§6), so this module owns exactly the rows ClaudeUI put there and
 * nothing else:
 *
 *  - OWNERSHIP IS THE ID. ClaudeUI's rows are `cred_claudeui_<stem>_v<n>`; a
 *    SLOT is one (integration, value type) pair: an API key (`<stem>` = the
 *    integration id) or the ChatGPT sign-in (`<stem>` = the ChatGPT account id,
 *    integration `openai`, OAuth). Every other row — a sign-in made in opencode,
 *    the copy opencode's migration imported once from `auth.json` — is never
 *    deleted, rotated or relabelled.
 *  - ROTATE = REPLACE. `PATCH` changes labels only and re-POSTing an id is a
 *    409, so a new value is the NEXT generation POSTed with `activate:true`,
 *    then the previous generations are deleted: no gap, one
 *    `credential.switched`. A crash between the two leaves an extra generation
 *    the next vend of that slot (boot included) prunes.
 *  - THE ACTIVE SLOT. Taking the slot from a row that is not ClaudeUI's
 *    records that row (the user's previously active credential) in ClaudeUI's
 *    own file; removing ClaudeUI's rows re-activates it BEFORE deleting them
 *    (opencode's delete-of-active would promote the NEWEST remaining row, not
 *    the previous one). A copy of ClaudeUI's own 1.x ChatGPT sign-in (an
 *    imported row whose refresh token is one ClaudeUI managed) is never
 *    restored: opencode would refresh it and rotate the vault's token away.
 *  - CHATGPT is access-token only (`refresh:""`), `metadata.accountID` set,
 *    and its `expires` PADDED by 24 h past the token's real expiry, so opencode
 *    never tries the empty refresh. The real expiry (from the JWT) is what this
 *    process remembers for the pre-turn gate.
 *  - A slot ClaudeUI may hold is recorded in its file BEFORE the POST, so a
 *    removal of a slot never vended needs no server, and a removal while
 *    opencode is not installed waits there until it is (`pendingRemoval`).
 *
 * CREDENTIAL BOUNDARY: values are read only to compare them with what is being
 * vended and to name the account (identities are cached, never tokens or
 * keys); `readActiveKey` is the one method that returns a secret (MAIN process,
 * for ADR-074 §6 adoption). Nothing here logs a value.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  Credential_CreateInput,
  Credential_Entry,
  Credential_Value
} from './protocol-v2/openapi'
import { logger } from '../services/logger'
import { writeJsonAtomic } from '../services/write-json-atomic'
import { logSafeError } from '../services/redact-secrets'
import { accountIdentityFromAuthEntry } from '../auth/account-identity'
import { extractAccountId, parseJwtClaims } from '../auth/vault/codex-oauth'
import type { AccountIdentity } from '../../shared/account-key'
import { nativeAccountKey } from '../../shared/account-key'

// ── Constants ─────────────────────────────────────────────────────────────────

export const CLAUDEUI_CREDENTIAL_PREFIX = 'cred_claudeui_'
/** opencode's integration for OpenAI — API keys AND the ChatGPT sign-in. */
export const CHATGPT_INTEGRATION_ID = 'openai'
/** The Codex-client OAuth method opencode's openai plugin treats as ChatGPT mode. */
export const CHATGPT_METHOD_ID = 'chatgpt-browser'
/** How far past the token's real expiry the vended `expires` lies (owner decision, §5). */
export const CHATGPT_EXPIRY_PADDING_MS = 24 * 60 * 60 * 1000

export type CredentialKind = 'key' | 'oauth'

/** The four operations ClaudeUI needs (`OpencodeClient` supplies them). */
export interface CredentialApi {
  list(): Promise<readonly Credential_Entry[]>
  create(input: Credential_CreateInput): Promise<Credential_Entry>
  remove(id: string): Promise<void>
  activate(id: string): Promise<void>
}

export interface CredentialLease {
  readonly api: CredentialApi
  release(): void
}

/** What ClaudeUI remembers about one slot it may hold rows in. */
export interface SlotRecord {
  /** The non-ClaudeUI row that was active when ClaudeUI took the slot. */
  previousActive?: string
  /** A removal that could not run (opencode not installed) and waits for it. */
  pendingRemoval?: true
}

export type SlotRecords = Record<string, SlotRecord>

/** ClaudeUI's own record of its slots (`~/.claude/ui/opencode-credential-slots.json`). */
export interface SlotMemory {
  read(): SlotRecords
  write(records: SlotRecords): void
  /**
   * True once after the backing file was found corrupt and quarantined: the
   * store rebuilds the records from the live `cred_claudeui_*` rows.
   */
  takeRebuild?(): boolean
}

/** Decides whether a refresh token is one ClaudeUI manages (the vault's, or a 1.x copy it fed). */
export type ClaudeuiTokenCheck = (refreshToken: string) => boolean | Promise<boolean>

/** What one integration looks like from ClaudeUI — never a secret. */
export interface IntegrationCredentialState {
  /** The type of the row opencode uses (its active row), when there is one. */
  readonly activeType?: 'api' | 'oauth'
  /** That active row is ClaudeUI's. */
  readonly activeOwned: boolean
  /** ClaudeUI holds an API-key row here (removable by ClaudeUI). */
  readonly ownKey: boolean
  /** ClaudeUI holds a ChatGPT row here. */
  readonly ownOauth: boolean
  /** ADR-071 §3 identity of the active row. */
  readonly identity: AccountIdentity
}

export interface CredentialSnapshot {
  readonly integrations: ReadonlyMap<string, IntegrationCredentialState>
  readonly at: number
}

/** The ChatGPT token this process last vended. */
export interface VendedChatgpt {
  readonly accountId: string
  /** The token's REAL expiry (JWT `exp`), epoch ms — what the pre-turn gate reads. */
  readonly realExpires: number
  /** Matches a vault credential to this vend; never logged. */
  readonly access: string
}

export interface ChatgptVendInput {
  readonly access: string
  /** The vault's expiry for the token (the fallback when the JWT has no `exp`). */
  readonly expires: number
  readonly accountId?: string
}

export interface OpencodeCredentialStoreDeps {
  /** A server's credential API, released after the operation. */
  connect: () => Promise<CredentialLease>
  /** Whether opencode can run (a server can be started). Default: yes. */
  available?: () => boolean
  memory?: SlotMemory
  now?: () => number
  /**
   * Recognises a refresh token ClaudeUI manages (the vault's, or one it fed
   * the 1.x `auth.json`). Every vend and removal consults it, whoever calls:
   * such a row of the user's is a copy of ClaudeUI's sign-in.
   */
  isClaudeuiToken?: ClaudeuiTokenCheck
}

/** How a removal treats a fallback that is a copy of ClaudeUI's sign-in. */
export interface RemoveOptions {
  /** Look even when nothing is recorded (an explicit disconnect). */
  readonly force?: boolean
  /**
   * The vault is being emptied (disconnect, last account removed): ClaudeUI's
   * row goes even if opencode then falls back to a copy (logged). Otherwise a
   * removal that would activate a copy keeps ClaudeUI's padded row instead.
   */
  readonly vaultEmptying?: boolean
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

export function isClaudeuiCredentialId(id: string): boolean {
  return id.startsWith(CLAUDEUI_CREDENTIAL_PREFIX)
}

/** The id stem for a slot: lowercase `[a-z0-9-]` (opencode accepts more; ids stay readable). */
export function credentialStem(raw: string): string {
  const stem = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return stem || 'x'
}

/** `cred_claudeui_<stem>_v<n>`. */
export function claudeuiCredentialId(stem: string, generation: number): string {
  return `${CLAUDEUI_CREDENTIAL_PREFIX}${stem}_v${generation}`
}

function generationOf(id: string, stem: string): number | null {
  const prefix = `${CLAUDEUI_CREDENTIAL_PREFIX}${stem}_v`
  if (!id.startsWith(prefix)) return null
  const n = Number(id.slice(prefix.length))
  return Number.isInteger(n) && n > 0 ? n : null
}

/**
 * The access token's REAL expiry: the JWT's `exp` (seconds) in ms, else the
 * vault's own expiry for it. Never the row's (padded) `expires`.
 */
export function chatgptRealExpiry(access: string, fallback: number): number {
  const exp = (parseJwtClaims(access) as { exp?: unknown } | undefined)?.exp
  return typeof exp === 'number' && Number.isFinite(exp) && exp > 0 ? exp * 1000 : fallback
}

const slotKey = (integrationID: string, kind: CredentialKind): string => `${integrationID}:${kind}`

function kindOf(value: Credential_Value): CredentialKind {
  return value.type === 'oauth' ? 'oauth' : 'key'
}

function inSlot(row: Credential_Entry, integrationID: string, kind: CredentialKind): boolean {
  return (
    isClaudeuiCredentialId(row.id) &&
    row.integrationID === integrationID &&
    kindOf(row.value) === kind
  )
}

/** An OAuth row opencode could refresh on its own (it carries a refresh token). */
function refreshable(row: Credential_Entry): string | null {
  return row.value.type === 'oauth' && row.value.refresh ? row.value.refresh : null
}

/** Errors are logged redacted: an opencode error body may echo a value. */
const errText = logSafeError

function identityOf(row: Credential_Entry | undefined, integrationID: string): AccountIdentity {
  if (!row)
    return { accountKey: nativeAccountKey('opencode', integrationID), accountLabel: integrationID }
  const value = row.value
  const accountID = value.type === 'oauth' ? value.metadata?.accountID : undefined
  return accountIdentityFromAuthEntry({
    engineId: 'opencode',
    vendorId: integrationID,
    isChatgptVendor: integrationID === CHATGPT_INTEGRATION_ID,
    entry:
      value.type === 'oauth'
        ? {
            type: 'oauth',
            access: value.access,
            ...(typeof accountID === 'string' ? { accountId: accountID } : {})
          }
        : { type: 'api', key: value.key }
  })
}

/** Reduce a credential list to what ClaudeUI may keep in memory: types, ownership, identities. */
export function snapshotOf(rows: readonly Credential_Entry[], at: number): CredentialSnapshot {
  const byIntegration = new Map<string, Credential_Entry[]>()
  for (const row of rows) {
    const list = byIntegration.get(row.integrationID) ?? []
    list.push(row)
    byIntegration.set(row.integrationID, list)
  }
  const integrations = new Map<string, IntegrationCredentialState>()
  for (const [integrationID, list] of byIntegration) {
    const active = list.find((row) => row.active)
    integrations.set(integrationID, {
      ...(active ? { activeType: active.value.type === 'oauth' ? 'oauth' : 'api' } : {}),
      activeOwned: !!active && isClaudeuiCredentialId(active.id),
      ownKey: list.some((row) => inSlot(row, integrationID, 'key')),
      ownOauth: list.some((row) => inSlot(row, integrationID, 'oauth')),
      identity: identityOf(active, integrationID)
    })
  }
  return { integrations, at }
}

/** `{integration: type of its active row}` — the row opencode uses, ClaudeUI's or the user's. */
export function credentialTypes(
  snapshot: CredentialSnapshot | null
): Record<string, 'api' | 'oauth'> {
  const out: Record<string, 'api' | 'oauth'> = {}
  for (const [id, state] of snapshot?.integrations ?? [])
    if (state.activeType) out[id] = state.activeType
  return out
}

/** Integrations where ClaudeUI holds an API-key row it may remove (`cred_claudeui_*`). */
export function removableVendors(snapshot: CredentialSnapshot | null): Set<string> {
  return new Set(
    [...(snapshot?.integrations ?? [])].filter(([, state]) => state.ownKey).map(([id]) => id)
  )
}

// ── Slot memory ───────────────────────────────────────────────────────────────

/** In-memory slot records (tests; production wires the file). */
export function memorySlotMemory(initial: SlotRecords = {}): SlotMemory {
  let records: SlotRecords = structuredClone(initial)
  return {
    read: () => structuredClone(records),
    write: (next) => {
      records = structuredClone(next)
    }
  }
}

function defaultSlotPath(): string {
  return path.join(os.homedir(), '.claude', 'ui', 'opencode-credential-slots.json')
}

/**
 * The file: ids and flags only, never a value (0600, atomic writes). An
 * unreadable file reads as empty (logged) — a removal then has nothing
 * recorded to restore, the rule opencode itself applies.
 */
export function fileSlotMemory(filePath?: string): SlotMemory {
  const file = (): string => filePath ?? defaultSlotPath()
  let rebuild = false
  /** Move a corrupt file aside (never lose it, never block a vend on it). */
  const quarantine = (reason: string): void => {
    const aside = `${file()}.corrupt-${Date.now()}`
    try {
      fs.renameSync(file(), aside)
    } catch {
      // Already gone: nothing to keep.
    }
    rebuild = true
    logger.warn(
      'OpencodeCredentials',
      `${file()} was unreadable (${reason}) — moved to ${aside}; rebuilding from opencode's cred_claudeui_* rows`
    )
  }
  return {
    read: () => {
      let raw: string
      try {
        raw = fs.readFileSync(file(), 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
          logger.warn('OpencodeCredentials', `unreadable ${file()}: ${errText(err)}`)
        return {}
      }
      try {
        const parsed: unknown = JSON.parse(raw)
        const slots = (parsed as { slots?: unknown } | null)?.slots
        if (slots && typeof slots === 'object' && !Array.isArray(slots)) return slots as SlotRecords
        quarantine('no slots object')
      } catch {
        quarantine('not JSON')
      }
      return {}
    },
    write: (records) => writeJsonAtomic(file(), { slots: records }, { indent: 2 }),
    takeRebuild: () => {
      const due = rebuild
      rebuild = false
      return due
    }
  }
}

// ── The store ─────────────────────────────────────────────────────────────────

export class OpencodeCredentialStore {
  private connect: () => Promise<CredentialLease>
  private available: () => boolean
  private memory: SlotMemory
  private readonly now: () => number
  /** Every operation runs alone: two vends of one slot would race for one generation id. */
  private chain: Promise<unknown> = Promise.resolve()
  private cached: CredentialSnapshot | null = null
  private vended: VendedChatgpt | null = null
  private readonly listeners = new Set<() => void>()
  private isClaudeuiToken: ClaudeuiTokenCheck | undefined

  constructor(deps: OpencodeCredentialStoreDeps) {
    this.connect = deps.connect
    this.available = deps.available ?? ((): boolean => true)
    this.memory = deps.memory ?? memorySlotMemory()
    this.now = deps.now ?? ((): number => Date.now())
    this.isClaudeuiToken = deps.isClaudeuiToken
  }

  /** Swap the seams (composition root; tests). Absent fields stay. */
  configure(deps: Partial<OpencodeCredentialStoreDeps>): void {
    if (deps.connect) this.connect = deps.connect
    if (deps.available) this.available = deps.available
    if (deps.memory) this.memory = deps.memory
    if (deps.isClaudeuiToken) this.isClaudeuiToken = deps.isClaudeuiToken
  }

  /**
   * The slots ClaudeUI's own record says it holds (pending removals excluded)
   * — answered from the record, no server. What Remove can delete.
   */
  recordedSlots(): { integrationID: string; kind: CredentialKind }[] {
    return Object.entries(this.memory.read())
      .filter(([, record]) => !record.pendingRemoval)
      .map(([key]) => {
        const at = key.lastIndexOf(':')
        return { integrationID: key.slice(0, at), kind: key.slice(at + 1) as CredentialKind }
      })
  }

  /** Integrations where ClaudeUI's record holds an API-key slot (no server). */
  recordedKeyIntegrations(): Set<string> {
    return new Set(
      this.recordedSlots()
        .filter((slot) => slot.kind === 'key')
        .map((slot) => slot.integrationID)
    )
  }

  /**
   * Every integration's ACTIVE API key, in ONE list — for a pass over many
   * vendors (ADR-074 §6 adoption). MAIN PROCESS ONLY.
   */
  async readActiveKeys(): Promise<Map<string, string>> {
    if (!this.available()) return new Map()
    return this.exclusive(async (api) => {
      const rows = await api.list()
      this.cached = snapshotOf(rows, this.now())
      const keys = new Map<string, string>()
      for (const row of rows)
        if (row.active && row.value.type === 'key' && row.value.key)
          keys.set(row.integrationID, row.value.key)
      return keys
    })
  }

  /** The per-call check (a pre-read token set) OR the store's own one. */
  private tokenCheck(extra?: ClaudeuiTokenCheck): ClaudeuiTokenCheck | undefined {
    const own = this.isClaudeuiToken
    if (!own) return extra
    if (!extra) return own
    return async (refresh) => (await extra(refresh)) || (await own(refresh))
  }

  /** `row` is a user row opencode could refresh with a token that is ClaudeUI's. */
  private async isCopy(
    row: Credential_Entry | undefined,
    check: ClaudeuiTokenCheck | undefined
  ): Promise<boolean> {
    const refresh = row && !isClaudeuiCredentialId(row.id) ? refreshable(row) : null
    return !!refresh && !!check && (await check(refresh))
  }

  /** Rung after ClaudeUI changed a credential (model catalogs, the auth probe). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The last snapshot this process read, or null — synchronous, never a secret. */
  cachedSnapshot(): CredentialSnapshot | null {
    return this.cached
  }

  /** The ChatGPT token this process last vended (real expiry), or null. */
  vendedChatgpt(): VendedChatgpt | null {
    return this.vended
  }

  /** A fresh snapshot (one list), or the cached one when opencode cannot run. */
  async snapshot(): Promise<CredentialSnapshot | null> {
    if (!this.available()) return this.cached
    return this.exclusive(async (api) => {
      this.cached = snapshotOf(await api.list(), this.now())
      return this.cached
    })
  }

  /**
   * Vend an API key as `cred_claudeui_<integration>_v<n>` and make it active.
   * The same key already held → no new generation (re-activated if a user row
   * took the slot meanwhile). Resolves whether anything changed.
   */
  async vendKey(integrationID: string, key: string): Promise<boolean> {
    return this.vend(integrationID, 'key', credentialStem(integrationID), {
      matches: (value) => value.type === 'key' && value.key === key,
      value: () => ({ type: 'key', key }),
      label: 'claudeui:key'
    })
  }

  /**
   * Vend the ACTIVE ChatGPT account's access token (access-only, padded expiry,
   * `metadata.accountID`) and make it the active `openai` row (§5).
   */
  async vendChatgpt(
    input: ChatgptVendInput,
    isClaudeuiToken?: ClaudeuiTokenCheck
  ): Promise<boolean> {
    const accountId = input.accountId || extractAccountId({ access_token: input.access })
    if (!accountId)
      throw new Error('ChatGPT credential has no account id; opencode needs metadata.accountID')
    const realExpires = chatgptRealExpiry(input.access, input.expires)
    let stale = false
    const changed = await this.vend(CHATGPT_INTEGRATION_ID, 'oauth', credentialStem(accountId), {
      // A vend that arrives after a NEWER token of the same account (a gate's
      // re-vend queued behind a refresh's) must not replace it.
      stale: (slot) =>
        (stale = slot.some(
          (row) =>
            row.value.type === 'oauth' &&
            row.value.metadata?.accountID === accountId &&
            row.value.access !== input.access &&
            chatgptRealExpiry(row.value.access, row.value.expires - CHATGPT_EXPIRY_PADDING_MS) >
              realExpires
        )),
      matches: (value) =>
        value.type === 'oauth' &&
        value.access === input.access &&
        value.metadata?.accountID === accountId,
      value: () => ({
        type: 'oauth',
        methodID: CHATGPT_METHOD_ID,
        refresh: '',
        access: input.access,
        expires: realExpires + CHATGPT_EXPIRY_PADDING_MS,
        metadata: { accountID: accountId }
      }),
      label: 'claudeui:chatgpt',
      isClaudeuiToken
    })
    if (stale) {
      logger.info(
        'OpencodeCredentials',
        'vend: opencode already holds a newer token of this ChatGPT account — the older one is not vended'
      )
      return false
    }
    this.vended = { accountId, realExpires, access: input.access }
    return changed
  }

  /**
   * Remove ClaudeUI's rows of one slot and give the slot back: the user's
   * remembered row is re-activated FIRST when ClaudeUI held the slot. Rows
   * that are not ClaudeUI's are never touched. Resolves whether anything was
   * removed (false when nothing is recorded, or opencode cannot run — then the
   * removal waits for it).
   *
   * NO REMOVAL EVER PROMOTES A COPY of ClaudeUI's own sign-in (a user row
   * whose refresh token ClaudeUI manages): opencode would refresh it and rotate
   * the vault's token away. When the row opencode would activate after the
   * DELETE is such a copy, ClaudeUI's padded, never-refreshed row is KEPT
   * active instead (and the record kept, so a later removal retries) — except
   * while the vault itself is being emptied (`vaultEmptying`), where it goes
   * and the fallback is logged.
   *
   * `force` looks even when nothing is recorded (an explicit disconnect: the
   * record may have been lost with ClaudeUI's settings); without it, a slot
   * never vended costs no server — the boot-time sweeps of every route.
   */
  async removeSlot(
    integrationID: string,
    kind: CredentialKind,
    context: string,
    isClaudeuiToken?: ClaudeuiTokenCheck,
    options: RemoveOptions = {}
  ): Promise<boolean> {
    const key = slotKey(integrationID, kind)
    if (!this.memory.read()[key] && !options.force) return false
    if (!this.available()) {
      this.updateRecord(key, (record) => ({ ...record, pendingRemoval: true }))
      logger.info(
        'OpencodeCredentials',
        `${context}: opencode not installed — removing ClaudeUI's ${key} credential when it is`
      )
      return false
    }
    const removed = await this.exclusive((api) =>
      this.removeWith(api, integrationID, kind, context, this.tokenCheck(isClaudeuiToken), options)
    )
    if (removed && kind === 'oauth' && integrationID === CHATGPT_INTEGRATION_ID) this.vended = null
    if (removed) this.notify()
    return removed
  }

  /** Run the removals that waited for opencode (also done before every operation). */
  async flushPending(): Promise<void> {
    if (!this.available()) return
    if (!Object.values(this.memory.read()).some((record) => record.pendingRemoval)) return
    await this.exclusive(async () => undefined)
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch (err) {
        logger.warn('OpencodeCredentials', `change listener threw: ${errText(err)}`)
      }
    }
  }

  private updateRecord(
    key: string,
    change: (record: SlotRecord | undefined) => SlotRecord | null
  ): void {
    const records = this.memory.read()
    const next = change(records[key])
    if (next) records[key] = next
    else delete records[key]
    this.memory.write(records)
  }

  /**
   * One lease, alone, with the pending removals applied first. `prepare` runs
   * first of all, inside the turn (a vend records its slot there).
   */
  private exclusive<T>(op: (api: CredentialApi) => Promise<T>, prepare?: () => void): Promise<T> {
    const run = this.chain.then(async () => {
      prepare?.()
      const lease = await this.connect()
      try {
        if (this.memory.takeRebuild?.()) await this.rebuildRecords(lease.api)
        await this.applyPending(lease.api)
        return await op(lease.api)
      } finally {
        lease.release()
      }
    })
    this.chain = run.catch(() => undefined)
    return run
  }

  /** After a corrupt record file: every slot holding a `cred_claudeui_*` row is ClaudeUI's again. */
  private async rebuildRecords(api: CredentialApi): Promise<void> {
    const records = this.memory.read()
    for (const row of await api.list()) {
      if (!isClaudeuiCredentialId(row.id)) continue
      const key = slotKey(row.integrationID, kindOf(row.value))
      records[key] ??= {}
    }
    this.memory.write(records)
  }

  private async applyPending(api: CredentialApi): Promise<void> {
    const pending = Object.entries(this.memory.read()).filter(([, record]) => record.pendingRemoval)
    for (const [key] of pending) {
      const [integrationID, kind] = key.split(':') as [string, CredentialKind]
      try {
        if (await this.removeWith(api, integrationID, kind, 'pending removal', this.tokenCheck()))
          this.notify()
      } catch (err) {
        logger.warn('OpencodeCredentials', `pending removal of ${key} failed: ${errText(err)}`)
      }
    }
  }

  private async vend(
    integrationID: string,
    kind: CredentialKind,
    stem: string,
    spec: {
      matches: (value: Credential_Value) => boolean
      value: () => Credential_Value
      label: string
      isClaudeuiToken?: ClaudeuiTokenCheck
      /** True when this vend is older than what the slot holds: nothing is written. */
      stale?: (slot: readonly Credential_Entry[]) => boolean
    }
  ): Promise<boolean> {
    const key = slotKey(integrationID, kind)
    // Recorded BEFORE any write, so no crash can leave a ClaudeUI row nothing
    // remembers; a vend also cancels a removal still waiting for opencode.
    const record = (): void =>
      this.updateRecord(key, (current) =>
        current?.previousActive ? { previousActive: current.previousActive } : {}
      )
    const changed = await this.exclusive(async (api) => {
      const rows = await api.list()
      const slot = rows.filter((row) => inSlot(row, integrationID, kind))
      if (spec.stale?.(slot)) return false
      const active = rows.find((row) => row.integrationID === integrationID && row.active)
      if (active && !isClaudeuiCredentialId(active.id))
        await this.rememberDisplaced(key, active, slot, this.tokenCheck(spec.isClaudeuiToken))

      let changed = false
      let current = slot.find((row) => spec.matches(row.value))
      if (current && !current.active) {
        await api.activate(current.id)
        changed = true
      } else if (!current) {
        const generation = Math.max(0, ...rows.map((row) => generationOf(row.id, stem) ?? 0)) + 1
        current = await api.create({
          id: claudeuiCredentialId(stem, generation),
          integrationID,
          label: spec.label,
          value: spec.value(),
          activate: true
        })
        changed = true
      }
      // Stale generations (a rotation's previous one, or one a crash left).
      for (const stale of slot) {
        if (stale.id === current.id) continue
        await api.remove(stale.id)
        changed = true
      }
      this.cached = snapshotOf(changed ? await api.list() : rows, this.now())
      return changed
    }, record)
    if (changed) this.notify()
    return changed
  }

  /**
   * ClaudeUI is taking the slot from `active`, a row that is not its own: that
   * is the credential to give the slot back to. A user sign-in that took the
   * slot after ClaudeUI's is logged (respected until this vend, §5). A copy of
   * ClaudeUI's own sign-in is not remembered — it must never be restored.
   */
  private async rememberDisplaced(
    key: string,
    active: Credential_Entry,
    slot: readonly Credential_Entry[],
    isClaudeuiToken?: ClaudeuiTokenCheck
  ): Promise<void> {
    if (await this.isCopy(active, isClaudeuiToken)) {
      logger.warn(
        'OpencodeCredentials',
        `${active.id} (a copy of ClaudeUI's own ChatGPT sign-in, imported from auth.json) holds the ${active.integrationID} slot — taking it; it will not be restored`
      )
      return
    }
    const previous = this.memory.read()[key]?.previousActive
    if (slot.length > 0)
      logger.info(
        'OpencodeCredentials',
        `${active.id} took the ${active.integrationID} slot from ClaudeUI's credential — re-asserting ClaudeUI's (vend)`
      )
    if (previous === active.id) return
    this.updateRecord(key, (record) => ({ ...record, previousActive: active.id }))
  }

  private async removeWith(
    api: CredentialApi,
    integrationID: string,
    kind: CredentialKind,
    context: string,
    isClaudeuiToken: ClaudeuiTokenCheck | undefined,
    options: RemoveOptions = {}
  ): Promise<boolean> {
    const key = slotKey(integrationID, kind)
    const record = this.memory.read()[key]
    const rows = await api.list()
    const slot = rows.filter((row) => inSlot(row, integrationID, kind))
    if (slot.length === 0) {
      this.updateRecord(key, () => null)
      this.cached = snapshotOf(rows, this.now())
      return false
    }
    const unsafe = (row: Credential_Entry | undefined): Promise<boolean> =>
      this.isCopy(row, isClaudeuiToken)
    const heldSlot = slot.some((row) => row.active)
    if (heldSlot) {
      const others = rows.filter(
        (row) => row.integrationID === integrationID && !slot.includes(row)
      )
      let restore = record?.previousActive
        ? others.find((row) => row.id === record.previousActive && !isClaudeuiCredentialId(row.id))
        : undefined
      if (restore && (await unsafe(restore))) {
        logger.warn(
          'OpencodeCredentials',
          `${context}: not restoring ${restore.id} — a copy of ClaudeUI's own ChatGPT sign-in`
        )
        restore = undefined
      }
      if (restore) {
        await api.activate(restore.id)
        logger.info(
          'OpencodeCredentials',
          `${context}: restored ${restore.id} as the active ${integrationID} credential`
        )
      } else {
        // opencode promotes the NEWEST remaining row (`credential.ts` remove):
        // the last of the others in the list's (active, created) order.
        const promoted = others.at(-1)
        if (await unsafe(promoted)) {
          if (!options.vaultEmptying) {
            logger.warn(
              'OpencodeCredentials',
              `${context}: keeping ClaudeUI's ${key} credential — removing it would activate ${promoted!.id}, a copy of ClaudeUI's own ChatGPT sign-in that opencode would refresh`
            )
            // Kept and still recorded (no longer pending): a later removal retries.
            this.updateRecord(key, (current) =>
              current?.previousActive ? { previousActive: current.previousActive } : {}
            )
            this.cached = snapshotOf(rows, this.now())
            return false
          }
          logger.warn(
            'OpencodeCredentials',
            `${context}: the vault is being emptied — opencode will fall back to ${promoted!.id}, a copy of ClaudeUI's own ChatGPT sign-in imported from auth.json, which it may refresh`
          )
        }
      }
    }
    // Inactive generations first, the active one last.
    for (const row of [...slot].sort((a, b) => Number(a.active) - Number(b.active))) {
      await api.remove(row.id)
    }
    logger.info(
      'OpencodeCredentials',
      `${context}: removed ClaudeUI's ${key} credential (${slot.length} row(s))`
    )
    this.updateRecord(key, () => null)
    this.cached = snapshotOf(await api.list(), this.now())
    return true
  }
}

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
import { randomBytes } from 'node:crypto'
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

/**
 * A slot's kind: ClaudeUI's own API key or ChatGPT row (`cred_claudeui_*`),
 * or `signin` — rows opencode created with ids of its own for a sign-in the
 * user started from ClaudeUI (ids recorded, provenance-based).
 */
export type CredentialKind = 'key' | 'oauth' | 'signin'

/** The operations ClaudeUI needs (`OpencodeClient` supplies them). */
export interface CredentialApi {
  list(): Promise<readonly Credential_Entry[]>
  create(input: Credential_CreateInput): Promise<Credential_Entry>
  remove(id: string): Promise<void>
  activate(id: string): Promise<void>
  /** Labels only (opencode ignores a value in a PATCH). Optional: a sign-in keeps its label without it. */
  relabel?(id: string, label: string): Promise<void>
}

/** The label a ClaudeUI-started sign-in row carries once adopted. */
export const SIGNIN_LABEL = 'ClaudeUI sign-in'
/** How long an attempt's label waits for a row a late-completing flow creates. */
export const SIGNIN_PENDING_TTL_MS = 60 * 60 * 1000

/** The label an adopted sign-in row keeps: readable, and still carrying the attempt's id. */
export function adoptedSigninLabel(hex: string): string {
  return `${SIGNIN_LABEL} · ${hex}`
}

/**
 * A sign-in label ClaudeUI generated (S7 review 3/4). `id` once a row was
 * adopted; pending until then (expires after {@link SIGNIN_PENDING_TTL_MS}).
 * Kept apart from the slot records, so a quarantined slot file does not lose
 * them: they are what a rebuild recovers sign-in rows from — never a label
 * alone, only one ClaudeUI remembers generating.
 */
export interface SigninLabel {
  readonly integrationID: string
  readonly hex: string
  readonly at: number
  readonly previousActive?: string
  readonly id?: string
}
/** The one-off label a sign-in attempt is started with, so its row is found race-free. */
export const SIGNIN_LABEL_PREFIX = 'claudeui:signin:'

/** The last proven-copy cleanup (ids only, never a value). */
export interface CopyCleanupRecord {
  readonly at: number
  readonly count: number
  readonly ids: readonly string[]
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
  /** `signin` slots: the opencode-chosen ids of rows a ClaudeUI-started sign-in created. */
  ids?: string[]
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
  /** The last proven-copy cleanup (absent: none recorded yet). */
  readCleanup?(): CopyCleanupRecord | undefined
  writeCleanup?(record: CopyCleanupRecord): void
  /** The sign-in labels ClaudeUI generated (pending and adopted). */
  readSigninLabels?(): SigninLabel[]
  writeSigninLabels?(labels: readonly SigninLabel[]): void
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

function inSlot(
  row: Credential_Entry,
  integrationID: string,
  kind: Exclude<CredentialKind, 'signin'>
): boolean {
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
export function snapshotOf(
  rows: readonly Credential_Entry[],
  at: number,
  owned: (id: string) => boolean = isClaudeuiCredentialId
): CredentialSnapshot {
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
      activeOwned: !!active && owned(active.id),
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
  let cleanup: CopyCleanupRecord | undefined
  let labels: SigninLabel[] = []
  return {
    read: () => structuredClone(records),
    write: (next) => {
      records = structuredClone(next)
    },
    readCleanup: () => cleanup,
    writeCleanup: (record) => {
      cleanup = structuredClone(record)
    },
    readSigninLabels: () => structuredClone(labels),
    writeSigninLabels: (next) => {
      labels = structuredClone([...next])
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
  const signinFile = (): string => file().replace(/\.json$/, '') + '.signins.json'
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
  /** The whole file: `{slots, copyCleanup?}`; {} when absent or quarantined. */
  const load = (): { slots: SlotRecords; copyCleanup?: CopyCleanupRecord } => {
    let raw: string
    try {
      raw = fs.readFileSync(file(), 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
        logger.warn('OpencodeCredentials', `unreadable ${file()}: ${errText(err)}`)
      return { slots: {} }
    }
    try {
      const parsed = JSON.parse(raw) as { slots?: unknown; copyCleanup?: CopyCleanupRecord } | null
      const slots = parsed?.slots
      if (slots && typeof slots === 'object' && !Array.isArray(slots))
        return {
          slots: slots as SlotRecords,
          ...(parsed?.copyCleanup ? { copyCleanup: parsed.copyCleanup } : {})
        }
      quarantine('no slots object')
    } catch {
      quarantine('not JSON')
    }
    return { slots: {} }
  }
  return {
    read: () => load().slots,
    write: (records) => {
      const { copyCleanup } = load()
      writeJsonAtomic(
        file(),
        { slots: records, ...(copyCleanup ? { copyCleanup } : {}) },
        {
          indent: 2
        }
      )
    },
    readCleanup: () => load().copyCleanup,
    // A sibling file: survives a quarantine of the slot file (S7 review 4).
    readSigninLabels: () => {
      try {
        const parsed = JSON.parse(fs.readFileSync(signinFile(), 'utf8')) as { labels?: unknown }
        return Array.isArray(parsed?.labels) ? (parsed.labels as SigninLabel[]) : []
      } catch {
        return []
      }
    },
    writeSigninLabels: (labels) =>
      writeJsonAtomic(signinFile(), { labels: [...labels] }, { indent: 2 }),
    writeCleanup: (record) =>
      writeJsonAtomic(file(), { slots: load().slots, copyCleanup: record }, { indent: 2 }),
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
  /** Whether this process ran the proven-copy cleanup through its own lease yet. */
  private copiesCleaned = false

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

  /**
   * Integrations where ClaudeUI's record holds something Remove deletes — its
   * API key, or a sign-in started from ClaudeUI (no server).
   */
  recordedRemovableIntegrations(): Set<string> {
    return new Set(
      this.recordedSlots()
        .filter((slot) => slot.kind === 'key' || slot.kind === 'signin')
        .map((slot) => slot.integrationID)
    )
  }

  /** Whether the copy recogniser is wired (the first-contact hook refuses to run without it). */
  recognisesCopies(): boolean {
    return !!this.isClaudeuiToken
  }

  /** Every id ClaudeUI owns by provenance (ClaudeUI-started sign-ins). */
  private signinIds(): Set<string> {
    const ids = new Set<string>()
    for (const [key, record] of Object.entries(this.memory.read()))
      if (key.endsWith(':signin')) for (const id of record.ids ?? []) ids.add(id)
    return ids
  }

  /** A row ClaudeUI owns: a `cred_claudeui_*` id, or a recorded ClaudeUI-started sign-in. */
  private ownedBy(): (id: string) => boolean {
    const signins = this.signinIds()
    return (id) => isClaudeuiCredentialId(id) || signins.has(id)
  }

  /** The rows of one of ClaudeUI's slots. */
  private slotRows(
    rows: readonly Credential_Entry[],
    integrationID: string,
    kind: CredentialKind
  ): Credential_Entry[] {
    if (kind !== 'signin') return rows.filter((row) => inSlot(row, integrationID, kind))
    const ids = new Set(this.memory.read()[slotKey(integrationID, 'signin')]?.ids ?? [])
    return rows.filter((row) => row.integrationID === integrationID && ids.has(row.id))
  }

  // ── Sign-ins started from ClaudeUI (provenance ownership) ─────────────────

  /**
   * Before a sign-in the user starts from ClaudeUI: a one-off label for the
   * attempt (opencode stores an attempt's label on the row it creates, so the
   * row is found by it, race-free against the user's own opencode), and the
   * row active before it — the one to give the slot back to.
   */
  async prepareSignin(integrationID: string): Promise<{ label: string; previousActive?: string }> {
    const hex = randomBytes(8).toString('hex')
    const label = `${SIGNIN_LABEL_PREFIX}${hex}`
    let previousActive: string | undefined
    if (this.available())
      previousActive = await this.exclusive(async (api) => {
        const owned = this.ownedBy()
        const active = (await api.list()).find(
          (row) => row.integrationID === integrationID && row.active
        )
        return active && !owned(active.id) ? active.id : undefined
      })
    // Remembered BEFORE the flow starts: a row it creates later — even after
    // the hold expired — is adopted by this exact label (S7 review 3).
    this.writeLabels([
      ...this.readLabels(),
      { integrationID, hex, at: this.now(), ...(previousActive ? { previousActive } : {}) }
    ])
    return { label, ...(previousActive ? { previousActive } : {}) }
  }

  /**
   * After the sign-in completed: the row carrying the attempt's label is
   * ClaudeUI's (recorded by id; relabelled `ClaudeUI sign-in · <hex>`, so it
   * still carries the attempt's id). Nothing else is claimed. Resolves the
   * adopted id, or null when no such row exists (yet: a pending label is
   * adopted by a later operation).
   */
  async adoptSignin(
    integrationID: string,
    label: string,
    previousActive?: string
  ): Promise<string | null> {
    const id = await this.exclusive(async (api) => {
      const hex = label.startsWith(SIGNIN_LABEL_PREFIX)
        ? label.slice(SIGNIN_LABEL_PREFIX.length)
        : ''
      const known = this.readLabels().find(
        (entry) => entry.integrationID === integrationID && entry.hex === hex
      )
      return this.adoptRow(api, await api.list(), {
        integrationID,
        hex,
        at: known?.at ?? this.now(),
        ...((previousActive ?? known?.previousActive)
          ? { previousActive: previousActive ?? known?.previousActive }
          : {})
      })
    })
    if (id) this.notify()
    return id
  }

  private readLabels(): SigninLabel[] {
    return this.memory.readSigninLabels?.() ?? []
  }

  private writeLabels(labels: readonly SigninLabel[]): void {
    this.memory.writeSigninLabels?.(labels)
  }

  /** Adopt the row of one generated label (by its exact raw or adopted label), if there is one. */
  private async adoptRow(
    api: CredentialApi,
    rows: readonly Credential_Entry[],
    entry: SigninLabel
  ): Promise<string | null> {
    if (!entry.hex) return null
    const row = rows.find(
      (candidate) =>
        candidate.integrationID === entry.integrationID &&
        (candidate.label === `${SIGNIN_LABEL_PREFIX}${entry.hex}` ||
          candidate.label === adoptedSigninLabel(entry.hex))
    )
    if (!row) return null
    this.updateRecord(slotKey(entry.integrationID, 'signin'), (record) => ({
      ...(record?.previousActive
        ? { previousActive: record.previousActive }
        : entry.previousActive
          ? { previousActive: entry.previousActive }
          : {}),
      ...(record?.pendingRemoval ? { pendingRemoval: true as const } : {}),
      ids: [...new Set([...(record?.ids ?? []), row.id])]
    }))
    this.writeLabels(
      this.readLabels()
        .filter(
          (known) => !(known.integrationID === entry.integrationID && known.hex === entry.hex)
        )
        .concat({ ...entry, id: row.id })
    )
    if (row.label !== adoptedSigninLabel(entry.hex))
      await api
        .relabel?.(row.id, adoptedSigninLabel(entry.hex))
        .catch((err: unknown) =>
          logger.warn('OpencodeCredentials', `relabel ${row.id} failed: ${errText(err)}`)
        )
    logger.info('OpencodeCredentials', `${row.id}: a sign-in started from ClaudeUI — ClaudeUI's`)
    return row.id
  }

  /**
   * Every operation: adopt rows that late-completing flows created for a
   * pending label, and expire labels that waited too long (S7 review 3).
   */
  private async adoptPendingSignins(api: CredentialApi): Promise<void> {
    const labels = this.readLabels()
    const pending = labels.filter((entry) => !entry.id)
    if (pending.length === 0) return
    const fresh = pending.filter((entry) => this.now() - entry.at <= SIGNIN_PENDING_TTL_MS)
    if (fresh.length !== pending.length)
      this.writeLabels(labels.filter((entry) => entry.id || fresh.includes(entry)))
    if (fresh.length === 0) return
    const rows = await api.list()
    let adopted = false
    for (const entry of fresh) if (await this.adoptRow(api, rows, entry)) adopted = true
    if (adopted) this.notify()
  }

  // ── Proven copies of ClaudeUI's own sign-in ──────────────────────────────

  /**
   * Delete every row that is PROVEN to be a copy of ClaudeUI's own ChatGPT
   * sign-in: not ClaudeUI's, and carrying a refresh token ClaudeUI manages
   * (the vault's, or one it fed the 1.x `auth.json`). An unproven row is never
   * touched. Logged by id and reason only; the run is recorded (time, count,
   * ids). Runs on `api` directly: the server-started hook calls it before the
   * server is handed to anyone.
   */
  async deleteProvenCopies(api: CredentialApi, context: string): Promise<number> {
    const check = this.isClaudeuiToken
    if (!check) return 0
    const rows = await api.list()
    const copies: Credential_Entry[] = []
    for (const row of rows) if (await this.isCopy(row, check)) copies.push(row)
    // Inactive first: deleting an active one promotes another, maybe a copy.
    for (const row of copies.sort((a, b) => Number(a.active) - Number(b.active))) {
      await api.remove(row.id)
      logger.info(
        'OpencodeCredentials',
        `${context}: deleted ${row.id} — a copy of ClaudeUI's own ChatGPT sign-in (its refresh token is ClaudeUI's)`
      )
    }
    if (copies.length > 0) {
      // Only a run that deleted something is recorded: an empty run (every
      // server start) must not overwrite what was deleted (S7 review 2).
      this.memory.writeCleanup?.({
        at: this.now(),
        count: copies.length,
        ids: copies.map((r) => r.id)
      })
      this.cached = snapshotOf(await api.list(), this.now(), this.ownedBy())
      this.notify()
    }
    return copies.length
  }

  /**
   * Every integration's ACTIVE API key, in ONE list — for a pass over many
   * vendors (ADR-074 §6 adoption). MAIN PROCESS ONLY.
   */
  async readActiveKeys(): Promise<Map<string, string>> {
    if (!this.available()) return new Map()
    return this.exclusive(async (api) => {
      const rows = await api.list()
      this.cached = snapshotOf(rows, this.now(), this.ownedBy())
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
    const refresh = row && !this.ownedBy()(row.id) ? refreshable(row) : null
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
      this.cached = snapshotOf(await api.list(), this.now(), this.ownedBy())
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
        // The first operation of the process deletes proven copies BEFORE it
        // vends or removes anything (each new server also runs it at first
        // contact — `deleteProvenCopies` via the server manager's hook).
        if (!this.copiesCleaned && this.isClaudeuiToken) {
          // Recorded as done only once it succeeded: a failed run retries on
          // the next operation (S7 review 1).
          try {
            await this.deleteProvenCopies(lease.api, 'first contact')
            this.copiesCleaned = true
          } catch (err) {
            logger.warn('OpencodeCredentials', `proven-copy cleanup failed: ${errText(err)}`)
          }
        }
        await this.adoptPendingSignins(lease.api).catch((err: unknown) =>
          logger.warn('OpencodeCredentials', `adopting late sign-ins failed: ${errText(err)}`)
        )
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
    const rows = await api.list()
    for (const row of rows) {
      if (!isClaudeuiCredentialId(row.id)) continue
      const key = slotKey(row.integrationID, kindOf(row.value))
      records[key] ??= {}
    }
    // Sign-in rows: only from labels ClaudeUI remembers generating (their
    // sibling file survives the quarantine) — by the adopted id, or by the
    // exact label carrying the attempt's id. A label alone proves nothing;
    // without the ledger the rows stay the user's (fail safe).
    for (const entry of this.readLabels()) {
      const row = rows.find(
        (candidate) =>
          candidate.integrationID === entry.integrationID &&
          (candidate.id === entry.id ||
            candidate.label === `${SIGNIN_LABEL_PREFIX}${entry.hex}` ||
            candidate.label === adoptedSigninLabel(entry.hex))
      )
      if (!row) continue
      const key = slotKey(entry.integrationID, 'signin')
      const record = records[key] ?? {}
      records[key] = {
        ...record,
        ...(!record.previousActive && entry.previousActive
          ? { previousActive: entry.previousActive }
          : {}),
        ids: [...new Set([...(record.ids ?? []), row.id])]
      }
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
      const slot = this.slotRows(rows, integrationID, kind)
      if (spec.stale?.(slot)) return false
      const active = rows.find((row) => row.integrationID === integrationID && row.active)
      if (active && !this.ownedBy()(active.id))
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
      this.cached = snapshotOf(changed ? await api.list() : rows, this.now(), this.ownedBy())
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
    const slot = this.slotRows(rows, integrationID, kind)
    if (slot.length === 0) {
      this.updateRecord(key, () => null)
      this.cached = snapshotOf(rows, this.now(), this.ownedBy())
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
        ? others.find((row) => row.id === record.previousActive && !this.ownedBy()(row.id))
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
            this.updateRecord(key, (current) => ({
              ...(current?.previousActive ? { previousActive: current.previousActive } : {}),
              ...(current?.ids ? { ids: current.ids } : {})
            }))
            this.cached = snapshotOf(rows, this.now(), this.ownedBy())
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
    if (kind === 'signin') {
      // Their labels are done with; pending ones (a flow still out) stay.
      const removed = new Set(slot.map((row) => row.id))
      this.writeLabels(this.readLabels().filter((entry) => !entry.id || !removed.has(entry.id)))
    }
    this.cached = snapshotOf(await api.list(), this.now(), this.ownedBy())
    return true
  }
}

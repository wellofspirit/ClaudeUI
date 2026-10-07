/**
 * An in-memory model of opencode 2.x's credential table, with the semantics
 * `packages/core/src/credential.ts` (2.0.24) gives it:
 *
 *  - `create` activates unless `activate:false` (and then only when the
 *    integration has no row); re-creating an id is a 409;
 *  - `activate` makes one row active per integration;
 *  - `remove` of the ACTIVE row promotes the NEWEST remaining row (by creation),
 *    not the previously active one;
 *  - `list` orders by (active, created, id) ascending.
 *
 * Every call is recorded for ordering assertions.
 */
import type { Credential_CreateInput, Credential_Entry } from '../../protocol-v2/openapi'
import type { CredentialApi, CredentialLease } from '../../credential-store'

interface Row {
  entry: Credential_Entry
  created: number
}

export interface FakeCredentialTable {
  readonly api: CredentialApi
  readonly calls: string[]
  /** Leases opened and released (a lease must always be released). */
  readonly leases: { opened: number; released: number }
  connect: () => Promise<CredentialLease>
  /** Insert a row directly (a user's sign-in, an imported row) — not recorded as a call. */
  seed(input: Credential_CreateInput & { id: string }): void
  rows(): Credential_Entry[]
  active(integrationID: string): Credential_Entry | undefined
  /** Make the next call of `op` throw once. */
  failNext(op: 'list' | 'create' | 'remove' | 'activate'): void
}

export function fakeCredentialTable(): FakeCredentialTable {
  const rows: Row[] = []
  const calls: string[] = []
  const leases = { opened: 0, released: 0 }
  let clock = 0
  const failing = new Set<string>()
  const maybeFail = (op: string): void => {
    if (failing.delete(op)) throw new Error(`fake ${op} failed`)
  }
  const ordered = (): Row[] =>
    [...rows].sort(
      (a, b) =>
        Number(a.entry.active) - Number(b.entry.active) ||
        a.created - b.created ||
        a.entry.id.localeCompare(b.entry.id)
    )
  const setActive = (integrationID: string, id: string | null): void => {
    for (const row of rows)
      if (row.entry.integrationID === integrationID)
        row.entry = { ...row.entry, active: row.entry.id === id }
  }
  const insert = (input: Credential_CreateInput & { id: string }): Credential_Entry => {
    if (rows.some((row) => row.entry.id === input.id))
      throw Object.assign(new Error('ConflictError: Credential already exists'), { status: 409 })
    const others = rows.filter((row) => row.entry.integrationID === input.integrationID)
    const activate = input.activate !== false || others.length === 0
    if (activate) setActive(input.integrationID, null)
    const entry: Credential_Entry = {
      id: input.id,
      integrationID: input.integrationID,
      label: input.label ?? 'default',
      active: activate,
      value: input.value
    }
    rows.push({ entry, created: ++clock })
    return entry
  }
  const api: CredentialApi = {
    list: async () => {
      calls.push('list')
      maybeFail('list')
      return ordered().map((row) => row.entry)
    },
    create: async (input) => {
      calls.push(`create ${input.id}`)
      maybeFail('create')
      return insert({ ...input, id: input.id ?? `cred_auto_${clock + 1}` })
    },
    remove: async (id) => {
      calls.push(`remove ${id}`)
      maybeFail('remove')
      const index = rows.findIndex((row) => row.entry.id === id)
      if (index < 0) return
      const [row] = rows.splice(index, 1)
      if (!row.entry.active) return
      const replacement = rows
        .filter((other) => other.entry.integrationID === row.entry.integrationID)
        .sort((a, b) => b.created - a.created || b.entry.id.localeCompare(a.entry.id))[0]
      if (replacement) setActive(row.entry.integrationID, replacement.entry.id)
    },
    activate: async (id) => {
      calls.push(`activate ${id}`)
      maybeFail('activate')
      const row = rows.find((candidate) => candidate.entry.id === id)
      if (row) setActive(row.entry.integrationID, id)
    },
    relabel: async (id, label) => {
      calls.push(`relabel ${id}`)
      const row = rows.find((candidate) => candidate.entry.id === id)
      if (row) row.entry = { ...row.entry, label }
    }
  }
  return {
    api,
    calls,
    leases,
    connect: async () => {
      leases.opened++
      return { api, release: () => void leases.released++ }
    },
    seed: (input) => void insert(input),
    rows: () => ordered().map((row) => row.entry),
    active: (integrationID) =>
      rows.find((row) => row.entry.integrationID === integrationID && row.entry.active)?.entry,
    failNext: (op) => void failing.add(op)
  }
}

const b64url = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url')

/** A fake, unsigned JWT shaped like a ChatGPT access token. Never a real token. */
export function fakeChatgptJwt(account: string, expSeconds: number, tag = 't'): string {
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({
    'https://api.openai.com/auth': { chatgpt_account_id: account },
    exp: expSeconds,
    tag
  })}.fake-${tag}`
}

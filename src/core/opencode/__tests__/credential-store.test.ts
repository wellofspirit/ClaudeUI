/**
 * @vitest-environment node
 *
 * OpencodeCredentialStore (ADR-097 §5) against an in-memory model of opencode
 * 2.x's credential table. Fake JWTs and fake keys only.
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { logger } from '../../services/logger'
import {
  OpencodeCredentialStore,
  chatgptRealExpiry,
  credentialTypes,
  credentialStem,
  isClaudeuiCredentialId,
  adoptedSigninLabel,
  fileSlotMemory,
  memorySlotMemory,
  SHARED_ROUTE_CLAIM_MESSAGE,
  SIGNIN_PENDING_TTL_MS,
  type SlotMemory
} from '../credential-store'
import { fakeChatgptJwt, fakeCredentialTable } from './fixtures/fake-credential-table'

const NOW = 1_800_000_000_000
const EXP = Math.floor(NOW / 1000) + 3600

function setup(
  options: {
    available?: () => boolean
    memory?: SlotMemory
    isClaudeuiToken?: (refresh: string) => boolean
    claimedBySharedRoute?: (integrationID: string) => boolean | Promise<boolean>
  } = {}
) {
  const table = fakeCredentialTable()
  const memory = options.memory ?? memorySlotMemory()
  const store = new OpencodeCredentialStore({
    connect: table.connect,
    available: options.available,
    memory,
    now: () => NOW,
    isClaudeuiToken: options.isClaudeuiToken,
    claimedBySharedRoute: options.claimedBySharedRoute
  })
  const changes = vi.fn()
  store.onChange(changes)
  return { table, store, memory, changes }
}

const userKey = (id: string, integrationID: string, key: string, activate = true) => ({
  id,
  integrationID,
  label: 'mine',
  activate,
  value: { type: 'key' as const, key }
})

const userOauth = (id: string, refresh: string, activate = true) => ({
  id,
  integrationID: 'openai',
  label: 'imported',
  activate,
  value: {
    type: 'oauth' as const,
    methodID: 'chatgpt-browser',
    refresh,
    access: fakeChatgptJwt('acct-user', EXP - 7200, 'user'),
    expires: NOW - 60_000,
    metadata: { accountID: 'acct-user' }
  }
})

/** Every call that names a row ClaudeUI does not own. */
const foreignCalls = (calls: readonly string[]) =>
  calls.filter((call) => {
    const [op, id] = call.split(' ')
    return op !== 'list' && !isClaudeuiCredentialId(id)
  })

/** The integrations ClaudeUI's record holds a key or sign-in slot for (pending removals excluded). */
const recorded = (store: OpencodeCredentialStore): Set<string> =>
  new Set(
    store
      .recordedSlots()
      .filter((slot) => slot.kind === 'key' || slot.kind === 'signin')
      .map((slot) => slot.integrationID)
  )

describe('helpers', () => {
  it('derives a readable stem and the real expiry from the JWT, never the row', () => {
    expect(credentialStem('OpenRouter')).toBe('openrouter')
    expect(credentialStem('8a1c-Acc.ID/x')).toBe('8a1c-acc-id-x')
    expect(chatgptRealExpiry(fakeChatgptJwt('a', EXP), 1)).toBe(EXP * 1000)
    expect(chatgptRealExpiry('not-a-jwt', 42)).toBe(42)
  })
})

describe('API keys', () => {
  it('vends cred_claudeui_<integration>_v1 active, and the same key again changes nothing', async () => {
    const { table, store, changes } = setup()
    expect(await store.vendKey('openrouter', 'sk-1')).toBe(true)
    expect(table.rows()).toMatchObject([
      {
        id: 'cred_claudeui_openrouter_v1',
        integrationID: 'openrouter',
        active: true,
        label: 'claudeui:key',
        value: { type: 'key', key: 'sk-1' }
      }
    ])
    expect(changes).toHaveBeenCalledTimes(1)
    table.calls.length = 0
    expect(await store.vendKey('openrouter', 'sk-1')).toBe(false)
    expect(table.calls).toEqual(['list'])
    expect(changes).toHaveBeenCalledTimes(1)
    expect(table.leases.opened).toBe(table.leases.released)
  })

  it('rotates by replace: POST the next generation, THEN delete the previous one (no gap)', async () => {
    const { table, store } = setup()
    await store.vendKey('openrouter', 'sk-1')
    table.calls.length = 0
    await store.vendKey('openrouter', 'sk-2')
    expect(table.calls).toEqual([
      'list',
      'create cred_claudeui_openrouter_v2',
      'remove cred_claudeui_openrouter_v1',
      'list'
    ])
    expect(table.rows().map((row) => [row.id, row.active])).toEqual([
      ['cred_claudeui_openrouter_v2', true]
    ])
  })

  it('a crash between POST and DELETE leaves two generations; the next vend prunes the stale one', async () => {
    const { table, store } = setup({
      memory: memorySlotMemory({ 'openrouter:key': {} })
    })
    table.seed({ ...userKey('cred_claudeui_openrouter_v1', 'openrouter', 'sk-1'), label: 'x' })
    table.seed({ ...userKey('cred_claudeui_openrouter_v2', 'openrouter', 'sk-2'), label: 'x' })
    await store.vendKey('openrouter', 'sk-2')
    expect(table.calls.filter((call) => call !== 'list')).toEqual([
      'remove cred_claudeui_openrouter_v1'
    ])
    expect(table.active('openrouter')?.id).toBe('cred_claudeui_openrouter_v2')
  })

  it('serializes concurrent vends of one slot (no 409, one row left)', async () => {
    const { table, store } = setup()
    await Promise.all([
      store.vendKey('openrouter', 'a'),
      store.vendKey('openrouter', 'b'),
      store.vendKey('openrouter', 'c')
    ])
    expect(table.rows().map((row) => [row.id, row.value])).toEqual([
      ['cred_claudeui_openrouter_v3', { type: 'key', key: 'c' }]
    ])
  })

  it('always releases its lease, also when a call fails', async () => {
    const { table, store } = setup()
    table.failNext('create')
    await expect(store.vendKey('openrouter', 'sk')).rejects.toThrow('fake create failed')
    expect(table.leases).toEqual({ opened: 1, released: 1 })
    // The chain survives the failure.
    expect(await store.vendKey('openrouter', 'sk')).toBe(true)
  })
})

describe('ChatGPT', () => {
  it('vends access-only with metadata.accountID and expires = REAL expiry + 24 h; remembers the real one', async () => {
    const { table, store } = setup()
    const access = fakeChatgptJwt('acct-111', EXP, 'A')
    await store.vendChatgpt({ access, expires: NOW + 10_000 })
    expect(table.rows()).toEqual([
      {
        id: 'cred_claudeui_acct-111_v1',
        integrationID: 'openai',
        label: 'claudeui:chatgpt',
        active: true,
        value: {
          type: 'oauth',
          methodID: 'chatgpt-browser',
          refresh: '',
          access,
          // The REAL expiry (the JWT's), padded by a literal 24 h.
          expires: EXP * 1000 + 24 * 60 * 60 * 1000,
          metadata: { accountID: 'acct-111' }
        }
      }
    ])
    expect(store.vendedChatgpt()).toEqual({
      accountId: 'acct-111',
      realExpires: EXP * 1000,
      access
    })
  })

  it('refuses a token with no account id (opencode reads the header only from metadata)', async () => {
    const { store, table } = setup()
    await expect(store.vendChatgpt({ access: 'opaque', expires: NOW })).rejects.toThrow(
      /metadata\.accountID/
    )
    expect(table.leases.opened).toBe(0)
  })

  it('rotates within an account and across accounts; the vault account switch prunes the old account', async () => {
    const { table, store } = setup()
    await store.vendChatgpt({ access: fakeChatgptJwt('acct-111', EXP, 'A'), expires: NOW })
    await store.vendChatgpt({ access: fakeChatgptJwt('acct-111', EXP + 60, 'B'), expires: NOW })
    expect(table.rows().map((row) => row.id)).toEqual(['cred_claudeui_acct-111_v2'])
    table.calls.length = 0
    await store.vendChatgpt({ access: fakeChatgptJwt('acct-222', EXP, 'C'), expires: NOW })
    expect(table.calls).toEqual([
      'list',
      'create cred_claudeui_acct-222_v1',
      'remove cred_claudeui_acct-111_v2',
      'list'
    ])
    expect(table.active('openai')?.value).toMatchObject({ metadata: { accountID: 'acct-222' } })
  })
})

describe('the active slot', () => {
  it('remembers the user row it displaced and re-activates it BEFORE deleting its own (older user row)', async () => {
    const { table, store } = setup()
    table.seed(userKey('cred_user_old', 'openai', 'sk-old'))
    table.seed(userKey('cred_user_new', 'openai', 'sk-new', false))
    // The user's active row is the OLDER one; opencode would promote the newer.
    table.api.activate('cred_user_old')
    await store.vendChatgpt({ access: fakeChatgptJwt('acct-1', EXP), expires: NOW })
    table.calls.length = 0
    expect(await store.removeSlot('openai', 'oauth', 'disconnect')).toBe(true)
    expect(table.calls).toEqual([
      'list',
      'activate cred_user_old',
      'remove cred_claudeui_acct-1_v1',
      'list'
    ])
    expect(table.active('openai')?.id).toBe('cred_user_old')
  })

  it('restores the newer user row when that is the one it displaced', async () => {
    const { table, store } = setup()
    table.seed(userKey('cred_user_old', 'openai', 'sk-old'))
    table.seed(userKey('cred_user_new', 'openai', 'sk-new'))
    await store.vendChatgpt({ access: fakeChatgptJwt('acct-1', EXP), expires: NOW })
    await store.removeSlot('openai', 'oauth', 'quit')
    expect(table.active('openai')?.id).toBe('cred_user_new')
  })

  it('a user sign-in that took the slot later is respected on removal and re-taken (and remembered) by the next vend', async () => {
    const { table, store, memory } = setup()
    table.seed(userKey('cred_user_1', 'openai', 'sk-1'))
    await store.vendChatgpt({ access: fakeChatgptJwt('acct-1', EXP, 'A'), expires: NOW })
    // The user signs in again in their own opencode: POST defaults to activate.
    table.seed(userKey('cred_user_3', 'openai', 'sk-3'))
    // The next rotation re-asserts ClaudeUI's row and remembers the new user row.
    await store.vendChatgpt({ access: fakeChatgptJwt('acct-1', EXP, 'B'), expires: NOW })
    expect(table.active('openai')?.id).toBe('cred_claudeui_acct-1_v2')
    expect(memory.read()['openai:oauth']).toEqual({ previousActive: 'cred_user_3' })
    // The user takes the slot once more, then ClaudeUI removes its row:
    // the active row is the user's, so nothing is activated.
    table.seed(userKey('cred_user_4', 'openai', 'sk-4'))
    table.calls.length = 0
    await store.removeSlot('openai', 'oauth', 'disconnect')
    expect(table.calls).toEqual(['list', 'remove cred_claudeui_acct-1_v2', 'list'])
    expect(table.active('openai')?.id).toBe('cred_user_4')
  })

  it('never removes, rotates or activates a row it does not own, except the one it gives the slot back to', async () => {
    const { table, store } = setup()
    table.seed(userKey('cred_user_a', 'openrouter', 'sk-user'))
    table.seed(userKey('cred_user_b', 'openrouter', 'sk-user-2', false))
    await store.vendKey('openrouter', 'sk-ours')
    await store.vendKey('openrouter', 'sk-ours-2')
    await store.removeSlot('openrouter', 'key', 'route off')
    expect(foreignCalls(table.calls)).toEqual(['activate cred_user_a'])
    expect(
      table
        .rows()
        .map((row) => row.id)
        .sort()
    ).toEqual(['cred_user_a', 'cred_user_b'])
  })

  it('a slot it never vended needs no server', async () => {
    const { table, store } = setup()
    expect(await store.removeSlot('openrouter', 'key', 'boot')).toBe(false)
    expect(table.leases.opened).toBe(0)
  })
})

describe('the copy of ClaudeUI 1.x sign-in imported from auth.json', () => {
  const managed = new Set(['rt-vault'])
  const isClaudeui = (refresh: string) => managed.has(refresh)

  it('is not remembered when ClaudeUI takes the slot from it', async () => {
    const { table, store, memory } = setup()
    table.seed(userOauth('cred_imported', 'rt-vault'))
    await store.vendChatgpt({ access: fakeChatgptJwt('acct-1', EXP), expires: NOW }, isClaudeui)
    expect(memory.read()['openai:oauth']).toEqual({})
    expect(table.active('openai')?.id).toBe('cred_claudeui_acct-1_v1')
  })

  it('on quit: ClaudeUI keeps its row rather than let opencode promote the copy', async () => {
    const { table, store } = setup()
    table.seed(userOauth('cred_imported', 'rt-vault'))
    await store.vendChatgpt({ access: fakeChatgptJwt('acct-1', EXP), expires: NOW }, isClaudeui)
    expect(await store.removeSlot('openai', 'oauth', 'quit', isClaudeui)).toBe(false)
    expect(table.active('openai')?.id).toBe('cred_claudeui_acct-1_v1')
    expect(table.rows().map((row) => row.id)).toContain('cred_imported')
  })

  it('on disconnect: ClaudeUI removes its row (the copy itself stays — not ClaudeUI’s id)', async () => {
    const { table, store } = setup()
    table.seed(userOauth('cred_imported', 'rt-vault'))
    await store.vendChatgpt({ access: fakeChatgptJwt('acct-1', EXP), expires: NOW }, isClaudeui)
    expect(
      await store.removeSlot('openai', 'oauth', 'disconnect', isClaudeui, { vaultEmptying: true })
    ).toBe(true)
    expect(table.rows().map((row) => row.id)).toEqual(['cred_imported'])
    expect(foreignCalls(table.calls)).toEqual([])
  })

  it('a user’s own OAuth sign-in (a token ClaudeUI never managed) is restored normally', async () => {
    const { table, store } = setup()
    table.seed(userOauth('cred_users_own', 'rt-users-own'))
    await store.vendChatgpt({ access: fakeChatgptJwt('acct-1', EXP), expires: NOW }, isClaudeui)
    await store.removeSlot('openai', 'oauth', 'quit', isClaudeui)
    expect(table.active('openai')?.id).toBe('cred_users_own')
  })
})

describe('opencode not installed', () => {
  it('records the removal and runs it on the next operation once opencode can run', async () => {
    let installed = true
    const { table, store, memory } = setup({ available: () => installed })
    table.seed(userKey('cred_user', 'openrouter', 'sk-user'))
    await store.vendKey('openrouter', 'sk-ours')
    installed = false
    const opened = table.leases.opened
    expect(await store.removeSlot('openrouter', 'key', 'route off')).toBe(false)
    expect(table.leases.opened).toBe(opened)
    expect(memory.read()['openrouter:key']).toMatchObject({ pendingRemoval: true })
    installed = true
    await store.flushPending()
    expect(table.rows().map((row) => [row.id, row.active])).toEqual([['cred_user', true]])
    expect(memory.read()['openrouter:key']).toBeUndefined()
  })

  it('a vend of the slot cancels a removal still waiting', async () => {
    let installed = true
    const { table, store, memory } = setup({ available: () => installed })
    await store.vendKey('openrouter', 'sk-1')
    installed = false
    await store.removeSlot('openrouter', 'key', 'route off')
    installed = true
    await store.vendKey('openrouter', 'sk-1')
    expect(table.active('openrouter')?.id).toBe('cred_claudeui_openrouter_v1')
    expect(memory.read()['openrouter:key']).toEqual({})
  })
})

describe('snapshot', () => {
  it('keeps types, ownership and identities — never a secret', async () => {
    const { table, store } = setup()
    table.seed(userKey('cred_user', 'anthropic', 'sk-ant-secret'))
    await store.vendKey('openrouter', 'sk-or-secret')
    await store.vendChatgpt({ access: fakeChatgptJwt('acct-9', EXP), expires: NOW })
    const snapshot = (await store.snapshot())!
    expect(snapshot.integrations.get('openrouter')).toMatchObject({
      activeType: 'api',
      activeOwned: true,
      ownKey: true,
      ownOauth: false
    })
    expect(snapshot.integrations.get('anthropic')).toMatchObject({
      activeType: 'api',
      activeOwned: false,
      ownKey: false
    })
    expect(snapshot.integrations.get('openai')).toMatchObject({
      activeType: 'oauth',
      activeOwned: true,
      ownOauth: true
    })
    expect(snapshot.integrations.get('openai')!.identity.accountKey).toMatch(/^chatgpt:acct-9/)
    const json = JSON.stringify([...snapshot.integrations])
    expect(json).not.toMatch(/secret|fake-t/)
    expect(store.cachedSnapshot()).toBe(snapshot)
  })

  it('an external credential (Azure CLI, opencode 2.0.25+) is neither an API key nor a sign-in', async () => {
    const { table, store } = setup()
    table.seed({
      id: 'cred_azure_cli',
      integrationID: 'azure',
      label: 'Azure CLI',
      activate: true,
      value: { type: 'external', methodID: 'azure-cli', metadata: { resource: 'cognitive' } }
    })
    table.seed(userKey('cred_user', 'anthropic', 'sk-ant-secret'))
    const snapshot = (await store.snapshot())!
    expect(snapshot.integrations.get('azure')).toMatchObject({
      activeType: 'external',
      activeOwned: false,
      ownKey: false,
      ownOauth: false,
      // The source's label, on the vendor's native key: no key to digest.
      identity: { accountKey: 'opencode:azure:native', accountLabel: 'azure (azure-cli)' }
    })
    // The cross-engine kinds are 'api' | 'oauth' only: the external row is left out, not called a key.
    expect(credentialTypes(snapshot)).toEqual({ anthropic: 'api' })
    expect(recorded(store).has('azure')).toBe(false)
  })

  it('reads the active key on demand only', async () => {
    const { table, store } = setup()
    table.seed(userKey('cred_user', 'openrouter', 'sk-user'))
    expect([...(await store.readActiveKeys())]).toEqual([['openrouter', 'sk-user']])
  })
})

describe('a lost record', () => {
  it('an explicit (forced) removal still finds ClaudeUI’s rows by id; an unforced one starts no server', async () => {
    const { table, store, memory } = setup()
    await store.vendChatgpt({ access: fakeChatgptJwt('acct-1', EXP), expires: NOW })
    memory.write({}) // ClaudeUI's settings were wiped
    const opened = table.leases.opened
    expect(await store.removeSlot('openai', 'oauth', 'start')).toBe(false)
    expect(table.leases.opened).toBe(opened)
    expect(
      await store.removeSlot('openai', 'oauth', 'disconnect', undefined, { force: true })
    ).toBe(true)
    expect(table.rows()).toEqual([])
  })
})

// ── Review fixes (S7 review) ─────────────────────────────────────────────────

// Since 2026-10-07 proven copies are deleted at first contact; the guard stays
// as defence in depth for a copy that appears LATER (seeded after the store's
// first operation here).
describe('H1: no removal ever promotes a copy of ClaudeUI’s sign-in', () => {
  const vaultToken = (refresh: string) => refresh === 'rt-vault'
  const withCopy = () => setup({ isClaudeuiToken: vaultToken })
  const copyLater = (table: ReturnType<typeof fakeCredentialTable>) =>
    table.seed(userOauth('cred_imported', 'rt-vault', false))

  it.each(['removeDisabledCopies', 'harnessArrived', 'start', 'quit', 'route off'])(
    '%s: ClaudeUI’s padded row stays active (and recorded); the copy stays inactive',
    async (context) => {
      const { table, store, memory } = withCopy()
      await store.vendChatgpt({ access: fakeChatgptJwt('acct-1', EXP), expires: NOW })
      copyLater(table)
      expect(await store.removeSlot('openai', 'oauth', context)).toBe(false)
      expect(table.active('openai')?.id).toBe('cred_claudeui_acct-1_v1')
      expect(memory.read()['openai:oauth']).toEqual({})
      expect(table.calls.filter((call) => call.startsWith('remove'))).toEqual([])
    }
  )

  it('a removal that waited for opencode keeps ClaudeUI’s row too', async () => {
    let installed = true
    const h = setup({ isClaudeuiToken: vaultToken, available: () => installed })
    await h.store.vendChatgpt({ access: fakeChatgptJwt('acct-1', EXP), expires: NOW })
    copyLater(h.table)
    installed = false
    await h.store.removeSlot('openai', 'oauth', 'harnessArrived')
    installed = true
    await h.store.flushPending()
    expect(h.table.active('openai')?.id).toBe('cred_claudeui_acct-1_v1')
  })

  it('the vault being emptied (disconnect, last account) removes ClaudeUI’s row anyway', async () => {
    const { table, store } = withCopy()
    await store.vendChatgpt({ access: fakeChatgptJwt('acct-1', EXP), expires: NOW })
    copyLater(table)
    expect(
      await store.removeSlot('openai', 'oauth', 'disconnect', undefined, {
        vaultEmptying: true
      })
    ).toBe(true)
    expect(table.rows().map((row) => row.id)).toEqual(['cred_imported'])
  })

  it('a genuine user row newer than the copy is what opencode promotes: the removal goes ahead', async () => {
    const { table, store } = withCopy()
    await store.vendChatgpt({ access: fakeChatgptJwt('acct-1', EXP), expires: NOW })
    copyLater(table)
    table.seed(userKey('cred_user_newer', 'openai', 'sk-user', false))
    expect(await store.removeSlot('openai', 'oauth', 'route off')).toBe(true)
    expect(table.active('openai')?.id).toBe('cred_user_newer')
  })
})

describe('M1: copy recognition lives in the store — the key path cannot bypass it', () => {
  it('an openai key vended over the copy never remembers it, and removing the key keeps ClaudeUI’s row', async () => {
    const { table, store, memory } = setup({ isClaudeuiToken: (r) => r === 'rt-vault' })
    await store.vendKey('anthropic', 'k') // the process's first operation (and cleanup)
    table.seed(userOauth('cred_imported', 'rt-vault')) // a copy that appears later, active
    await store.vendKey('openai', 'sk-ours')
    expect(memory.read()['openai:key']).toEqual({})
    // No per-call check given: the store's own applies.
    expect(await store.removeSlot('openai', 'key', 'remove openai')).toBe(false)
    expect(table.active('openai')?.id).toBe('cred_claudeui_openai_v1')
  })
})

describe('L1: an older token never replaces a newer one', () => {
  it('a re-vend of the older token of the same account after the newer one is skipped', async () => {
    const { table, store } = setup()
    const newer = fakeChatgptJwt('acct-1', EXP + 3600, 'new')
    const older = fakeChatgptJwt('acct-1', EXP, 'old')
    await store.vendChatgpt({ access: newer, expires: NOW })
    expect(await store.vendChatgpt({ access: older, expires: NOW })).toBe(false)
    expect(table.rows().map((row) => (row.value as { access: string }).access)).toEqual([newer])
    expect(store.vendedChatgpt()?.access).toBe(newer)
  })

  it('another account’s token is not "older": an account switch goes through', async () => {
    const { table, store } = setup()
    await store.vendChatgpt({ access: fakeChatgptJwt('acct-1', EXP + 3600), expires: NOW })
    await store.vendChatgpt({ access: fakeChatgptJwt('acct-2', EXP), expires: NOW })
    expect(table.active('openai')?.value).toMatchObject({ metadata: { accountID: 'acct-2' } })
  })
})

describe('L2: a corrupt record file never blocks a vend', () => {
  it('is quarantined, logged, rebuilt from the live cred_claudeui_* rows, and vending goes on', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slots-'))
    const file = join(dir, 'opencode-credential-slots.json')
    try {
      const table = fakeCredentialTable()
      table.seed({ ...userKey('cred_claudeui_openrouter_v1', 'openrouter', 'sk-x'), label: 'x' })
      writeFileSync(file, '{ not json')
      const memory = fileSlotMemory(file)
      const store = new OpencodeCredentialStore({ connect: table.connect, memory, now: () => NOW })
      await store.vendChatgpt({ access: fakeChatgptJwt('acct-1', EXP), expires: NOW })
      expect(readdirSync(dir).some((name) => name.includes('.corrupt-'))).toBe(true)
      const records = JSON.parse(readFileSync(file, 'utf8')).slots
      expect(Object.keys(records).sort()).toEqual(['openai:oauth', 'openrouter:key'])
      expect(table.active('openai')?.id).toBe('cred_claudeui_acct-1_v1')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('L2b: a rebuilt record skips a row that fills no slot', () => {
  it('an external row under a cred_claudeui_ id records nothing (and does not throw)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slots-'))
    const file = join(dir, 'opencode-credential-slots.json')
    try {
      const table = fakeCredentialTable()
      table.seed({
        id: 'cred_claudeui_azure_v1',
        integrationID: 'azure',
        label: 'x',
        value: { type: 'external', methodID: 'azure-cli' }
      })
      writeFileSync(file, '{ not json')
      const store = new OpencodeCredentialStore({
        connect: table.connect,
        memory: fileSlotMemory(file),
        now: () => NOW
      })
      await store.vendKey('openrouter', 'sk-or-secret')
      expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')).slots)).toEqual(['openrouter:key'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('M3b: ClaudeUI’s record of its slots is answered with no server', () => {
  it('recorded key slots, pending removals excluded', async () => {
    let installed = true
    const { table, store } = setup({ available: () => installed })
    await store.vendKey('openrouter', 'k1')
    await store.vendKey('anthropic', 'k2')
    installed = false
    await store.removeSlot('anthropic', 'key', 'route off')
    const opened = table.leases.opened
    expect([...recorded(store)]).toEqual(['openrouter'])
    expect(table.leases.opened).toBe(opened)
  })
})

describe('L5: a token an error body echoes never reaches the log', () => {
  it('a failing pending removal logs a redacted message', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      let installed = true
      const { table, store } = setup({ available: () => installed })
      await store.vendKey('openrouter', 'k1')
      installed = false
      await store.removeSlot('openrouter', 'key', 'route off')
      installed = true
      const jwt = fakeChatgptJwt('acct-1', EXP, 'secretpayload')
      const api = table.api
      const list = api.list
      let first = true
      api.list = async () => {
        if (first) {
          first = false
          throw new Error(
            `InvalidRequest: {"access":"${jwt}","key":"sk-or-v1-abcdef123456"} Bearer ${jwt}`
          )
        }
        return list()
      }
      await store.vendKey('anthropic', 'k2')
      const logged = JSON.stringify(warn.mock.calls)
      expect(warn).toHaveBeenCalled()
      expect(logged).not.toContain(jwt)
      expect(logged).not.toContain('secretpayload')
      expect(logged).not.toContain('sk-or-v1-abcdef123456')
    } finally {
      warn.mockRestore()
    }
  })
})

// ── Owner decisions 2026-10-07: proven copies deleted; ClaudeUI-started sign-ins are ClaudeUI's ──

describe('proven copies of ClaudeUI’s sign-in are deleted', () => {
  const proven = new Set(['rt-vault', 'rt-fed-1x'])
  const check = (refresh: string) => proven.has(refresh)

  it('deletes copies matching the vault or the 1.x history; keeps unproven, owned and key rows; records the run', async () => {
    const { table, store, memory } = setup({ isClaudeuiToken: check })
    table.seed(userOauth('cred_copy_vault', 'rt-vault', false))
    table.seed(userOauth('cred_copy_history', 'rt-fed-1x'))
    table.seed(userOauth('cred_users_own', 'rt-users-own', false))
    table.seed(userKey('cred_user_key', 'openai', 'sk-user', false))
    const count = await store.deleteProvenCopies(table.api, 'first contact')
    expect(count).toBe(2)
    expect(
      table
        .rows()
        .map((row) => row.id)
        .sort()
    ).toEqual(['cred_user_key', 'cred_users_own'])
    // Inactive first, the active one last.
    expect(table.calls.filter((c) => c.startsWith('remove'))).toEqual([
      'remove cred_copy_vault',
      'remove cred_copy_history'
    ])
    expect(memory.readCleanup?.()).toEqual({
      at: NOW,
      count: 2,
      ids: ['cred_copy_vault', 'cred_copy_history']
    })
  })

  it('never deletes without a recogniser, and logs ids — never a token', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {})
    try {
      const none = setup()
      none.table.seed(userOauth('cred_copy', 'rt-vault'))
      expect(await none.store.deleteProvenCopies(none.table.api, 'x')).toBe(0)
      expect(none.table.rows()).toHaveLength(1)

      const { table, store } = setup({ isClaudeuiToken: check })
      table.seed(userOauth('cred_copy', 'rt-vault'))
      await store.deleteProvenCopies(table.api, 'first contact')
      const logged = JSON.stringify(info.mock.calls)
      expect(logged).toContain('cred_copy')
      expect(logged).not.toContain('rt-vault')
      expect(logged).not.toContain('fake-user-access')
    } finally {
      info.mockRestore()
    }
  })

  it('the first operation of the process deletes them BEFORE it vends', async () => {
    const { table, store } = setup({ isClaudeuiToken: check })
    table.seed(userOauth('cred_copy', 'rt-vault'))
    await store.vendChatgpt({ access: fakeChatgptJwt('acct-1', EXP), expires: NOW })
    const writes = table.calls.filter((c) => !c.startsWith('list'))
    expect(writes).toEqual(['remove cred_copy', 'create cred_claudeui_acct-1_v1'])
    // Only once per process through its own lease (servers run it at first contact).
    table.seed(userOauth('cred_copy_later', 'rt-vault', false))
    await store.vendKey('openrouter', 'k')
    expect(table.rows().map((row) => row.id)).toContain('cred_copy_later')
  })
})

describe('a sign-in started from ClaudeUI is ClaudeUI’s', () => {
  it('captures exactly the row carrying the attempt’s label, relabels it, and removes it like its own (restoring the previous row first)', async () => {
    const { table, store } = setup()
    table.seed(userKey('cred_user_before', 'github-copilot', 'tok-user'))
    const signin = await store.prepareSignin('github-copilot')
    expect(signin.label).toMatch(/^claudeui:signin:[0-9a-f]{16}$/)
    expect(signin.previousActive).toBe('cred_user_before')
    // The user's own opencode signs in meanwhile (another label).
    table.seed({
      ...userKey('cred_user_concurrent', 'github-copilot', 'tok-other'),
      label: 'GitHub'
    })
    // opencode completes ClaudeUI's attempt: its row, its id, the attempt's label.
    table.seed({
      ...userKey('ghc_opencode_id_1', 'github-copilot', 'tok-ours'),
      label: signin.label
    })
    expect(await store.adoptSignin('github-copilot', signin.label, signin.previousActive)).toBe(
      'ghc_opencode_id_1'
    )
    // Still carries the attempt's id (a rebuild recovers it by that).
    expect(table.rows().find((row) => row.id === 'ghc_opencode_id_1')?.label).toBe(
      `ClaudeUI sign-in · ${signin.label.slice('claudeui:signin:'.length)}`
    )
    expect([...recorded(store)]).toEqual(['github-copilot'])

    table.calls.length = 0
    expect(await store.removeSlot('github-copilot', 'signin', 'remove github-copilot')).toBe(true)
    expect(table.calls.filter((c) => !c.startsWith('list'))).toEqual([
      'activate cred_user_before',
      'remove ghc_opencode_id_1'
    ])
    expect(
      table
        .rows()
        .map((row) => row.id)
        .sort()
    ).toEqual(['cred_user_before', 'cred_user_concurrent'])
    expect(recorded(store).size).toBe(0)
  })

  it('claims nothing when no row carries the label, and a ClaudeUI sign-in is never taken for a copy', async () => {
    const { table, store } = setup({ isClaudeuiToken: (r) => r === 'rt-shared' })
    const signin = await store.prepareSignin('openai')
    table.seed({ ...userOauth('oc_unrelated', 'rt-x'), label: 'mine' })
    expect(await store.adoptSignin('openai', signin.label)).toBeNull()
    table.seed({ ...userOauth('oc_ours', 'rt-shared'), label: signin.label })
    expect(await store.adoptSignin('openai', signin.label)).toBe('oc_ours')
    expect(await store.deleteProvenCopies(table.api, 'first contact')).toBe(0)
    expect(
      table
        .rows()
        .map((row) => row.id)
        .sort()
    ).toEqual(['oc_ours', 'oc_unrelated'])
  })
})

// ── S7 review (s7b) ───────────────────────────────────────────────────────────

describe('s7b-1: a FAILED process-first cleanup is not recorded as done', () => {
  it('retries on the next operation and deletes the copy then', async () => {
    const { table, store } = setup({ isClaudeuiToken: (r) => r === 'rt-vault' })
    table.seed(userOauth('cred_copy', 'rt-vault', false))
    const list = table.api.list
    let failOnce = true
    table.api.list = async () => {
      if (failOnce) {
        failOnce = false
        throw new Error('SQLITE_BUSY')
      }
      return list()
    }
    await store.vendKey('openrouter', 'k1')
    expect(table.rows().map((row) => row.id)).toContain('cred_copy')
    await store.vendKey('openrouter', 'k2')
    expect(table.rows().map((row) => row.id)).not.toContain('cred_copy')
  })
})

describe('s7b-2: an empty run never overwrites what a run deleted', () => {
  it('keeps the last deletion record', async () => {
    const { table, store, memory } = setup({ isClaudeuiToken: (r) => r === 'rt-vault' })
    table.seed(userOauth('cred_copy', 'rt-vault'))
    await store.deleteProvenCopies(table.api, 'first contact')
    await store.deleteProvenCopies(table.api, 'first contact')
    expect(memory.readCleanup?.()).toEqual({ at: NOW, count: 1, ids: ['cred_copy'] })
  })
})

describe('s7b-3: a sign-in that completes after its hold is adopted later', () => {
  it('a pending label is adopted by the next operation; an expired one never', async () => {
    let now = NOW
    const table = fakeCredentialTable()
    const store = new OpencodeCredentialStore({
      connect: table.connect,
      memory: memorySlotMemory(),
      now: () => now
    })
    const late = await store.prepareSignin('github-copilot')
    const stale = await store.prepareSignin('anthropic')
    // The hold gave up; opencode completes both attempts afterwards.
    table.seed({ ...userKey('ghc_late', 'github-copilot', 'tok'), label: late.label })
    now += SIGNIN_PENDING_TTL_MS / 2
    await store.vendKey('openrouter', 'k') // any later operation
    expect([...recorded(store)].sort()).toEqual(['github-copilot', 'openrouter'])
    expect(table.rows().find((row) => row.id === 'ghc_late')?.label).toBe(
      adoptedSigninLabel(late.label.slice('claudeui:signin:'.length))
    )
    now += SIGNIN_PENDING_TTL_MS
    table.seed({ ...userKey('ant_too_late', 'anthropic', 'tok'), label: stale.label })
    await store.vendKey('openrouter', 'k2')
    expect(recorded(store).has('anthropic')).toBe(false)
  })
})

describe('s7b-4: sign-in ownership survives a quarantined slot file — only from remembered ids', () => {
  it('a rebuild recovers adopted and pending sign-ins from the label ledger; a look-alike label is not claimed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slots-'))
    const file = join(dir, 'opencode-credential-slots.json')
    try {
      const table = fakeCredentialTable()
      const memory = fileSlotMemory(file)
      const store = new OpencodeCredentialStore({ connect: table.connect, memory, now: () => NOW })
      const signin = await store.prepareSignin('github-copilot')
      table.seed({ ...userKey('ghc_ours', 'github-copilot', 'tok'), label: signin.label })
      await store.adoptSignin('github-copilot', signin.label)
      // A row whose label merely LOOKS like ClaudeUI's (an id ClaudeUI never generated).
      table.seed({
        ...userKey('ghc_lookalike', 'github-copilot', 'tok2', false),
        label: adoptedSigninLabel('0123456789abcdef')
      })
      writeFileSync(file, '{ corrupt')
      const fresh = new OpencodeCredentialStore({
        connect: table.connect,
        memory: fileSlotMemory(file),
        now: () => NOW
      })
      await fresh.vendKey('openrouter', 'k')
      expect(recorded(fresh).has('github-copilot')).toBe(true)
      await fresh.removeSlot('github-copilot', 'signin', 'remove')
      expect(table.rows().map((row) => row.id)).toContain('ghc_lookalike')
      expect(table.rows().map((row) => row.id)).not.toContain('ghc_ours')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('with the ledger gone too, sign-in rows fail safe as user rows', async () => {
    const table = fakeCredentialTable()
    const store = new OpencodeCredentialStore({
      connect: table.connect,
      memory: memorySlotMemory()
    })
    table.seed({ ...userKey('ghc_x', 'github-copilot', 'tok'), label: adoptedSigninLabel('aaaa') })
    await store.vendKey('openrouter', 'k')
    expect(recorded(store).has('github-copilot')).toBe(false)
  })
})

describe('removeIntegration: an explicit user Remove deletes EVERY row of the integration', () => {
  const ids = (table: ReturnType<typeof fakeCredentialTable>) => table.rows().map((row) => row.id)

  it('deletes the user’s rows and ClaudeUI’s, re-activating nothing', async () => {
    const { table, store, memory, changes } = setup()
    table.seed(userKey('cred_user_a', 'openrouter', 'sk-a'))
    // "Replace" was used: ClaudeUI's key took the slot, the user's row is `previousActive`.
    await store.vendKey('openrouter', 'sk-ours')
    expect(memory.read()['openrouter:key']).toEqual({ previousActive: 'cred_user_a' })
    table.seed(userKey('cred_user_b', 'openrouter', 'sk-b', false))
    // A neighbour integration is not touched.
    table.seed(userKey('cred_other', 'anthropic', 'sk-other'))
    table.calls.length = 0
    changes.mockClear()

    expect(await store.removeIntegration('openrouter', 'remove openrouter (test)')).toEqual([
      'cred_user_a',
      'cred_user_b',
      'cred_claudeui_openrouter_v1'
    ])
    expect(table.calls).toEqual([
      'list',
      'remove cred_user_a',
      'remove cred_user_b',
      'remove cred_claudeui_openrouter_v1',
      'list'
    ])
    expect(ids(table)).toEqual(['cred_other'])
    expect(memory.read()).toEqual({})
    expect(changes).toHaveBeenCalledTimes(1)
    expect(table.leases.opened).toBe(table.leases.released)
  })

  it('deletes the inactive rows first and the active one last, whatever order the list returns them in', async () => {
    // The fake lists (active, created) ascending, as opencode does, so on its own it would hand
    // the active row last whether or not the store sorts. This lease lists the active row FIRST.
    const table = fakeCredentialTable()
    let activeFirst = false
    const store = new OpencodeCredentialStore({
      connect: async () => {
        const lease = await table.connect()
        return {
          ...lease,
          api: {
            ...lease.api,
            list: async () => {
              const rows = await lease.api.list()
              return activeFirst ? [...rows].reverse() : rows
            }
          }
        }
      },
      memory: memorySlotMemory(),
      now: () => NOW
    })
    table.seed(userKey('cred_user_a', 'openrouter', 'sk-a'))
    await store.vendKey('openrouter', 'sk-ours') // active; the user's row is inactive now
    table.seed(userKey('cred_user_b', 'openrouter', 'sk-b', false))
    expect(table.active('openrouter')?.id).toBe('cred_claudeui_openrouter_v1')
    table.calls.length = 0
    activeFirst = true

    await store.removeIntegration('openrouter', 'remove openrouter (test)')

    const removes = table.calls.filter((call) => call.startsWith('remove '))
    expect(removes.slice(0, 2).sort()).toEqual(['remove cred_user_a', 'remove cred_user_b'])
    expect(removes[2]).toBe('remove cred_claudeui_openrouter_v1')
    expect(removes).toHaveLength(3)
    expect(ids(table)).toEqual([])
  })

  it('deletes an external reference and a sign-in made in opencode, whoever owns them', async () => {
    const { table, store } = setup()
    table.seed({
      id: 'cred_azure_cli',
      integrationID: 'azure',
      label: 'Azure CLI',
      activate: true,
      value: { type: 'external', methodID: 'azure-cli' }
    })
    table.seed(userOauth('cred_user_oauth', 'rt-users-own', false))
    await store.removeIntegration('azure', 'remove azure')
    expect(ids(table)).toEqual(['cred_user_oauth'])
    await store.removeIntegration('openai', 'remove openai')
    expect(ids(table)).toEqual([])
  })

  it('forgets every ClaudeUI record of the integration (key, sign-in, pending) and the sign-in ledger of the deleted ids — and no other integration’s', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      const { table, store, memory } = setup()
      await store.vendKey('github-copilot', 'sk-ours')
      const signin = await store.prepareSignin('github-copilot')
      table.seed({ ...userKey('ghc_ours', 'github-copilot', 'tok'), label: signin.label })
      await store.adoptSignin('github-copilot', signin.label, signin.previousActive)
      // Another integration's adopted sign-in must come through the trim untouched.
      const other = await store.prepareSignin('anthropic')
      table.seed({ ...userKey('ant_ours', 'anthropic', 'tok-ant'), label: other.label })
      await store.adoptSignin('anthropic', other.label, other.previousActive)
      // A flow still out for the same integration keeps its pending label.
      const pending = await store.prepareSignin('github-copilot')
      await store.vendKey('openrouter', 'sk-keep')
      memory.write({ ...memory.read(), 'github-copilot:oauth': { pendingRemoval: true } })
      expect(Object.keys(memory.read()).sort()).toEqual([
        'anthropic:signin',
        'github-copilot:key',
        'github-copilot:oauth',
        'github-copilot:signin',
        'openrouter:key'
      ])
      const ledger = (): string[] =>
        (memory.readSigninLabels?.() ?? [])
          .map((entry) => `${entry.integrationID}:${entry.id ?? 'pending'}`)
          .sort()
      expect(ledger()).toEqual([
        'anthropic:ant_ours',
        'github-copilot:ghc_ours',
        'github-copilot:pending'
      ])

      // The first list of the lease belongs to the pending-label adoption; the second is the
      // pending removal's, and it fails (caught) — so the `github-copilot:oauth` pending record
      // is still there when the removal runs, and only the removal can clear it.
      table.failNext('list', 1)
      await store.removeIntegration('github-copilot', 'remove github-copilot')
      expect(
        warn.mock.calls.some((call) =>
          String(call[1]).includes('pending removal of github-copilot:oauth failed')
        )
      ).toBe(true)

      expect(Object.keys(memory.read()).sort()).toEqual(['anthropic:signin', 'openrouter:key'])
      expect(ledger()).toEqual(['anthropic:ant_ours', 'github-copilot:pending'])
      expect(memory.readSigninLabels?.().find((entry) => !entry.id)).toMatchObject({
        hex: pending.label.slice('claudeui:signin:'.length)
      })
      expect(table.rows().map((row) => row.id)).toEqual(
        expect.arrayContaining(['ant_ours', 'cred_claudeui_openrouter_v1'])
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('rings onChange and refreshes the cached snapshot (the integration leaves it)', async () => {
    const { table, store, changes } = setup()
    table.seed(userKey('cred_user', 'openrouter', 'sk-user'))
    expect((await store.snapshot())?.integrations.has('openrouter')).toBe(true)
    await store.removeIntegration('openrouter', 'remove')
    expect(store.cachedSnapshot()?.integrations.has('openrouter')).toBe(false)
    expect(changes).toHaveBeenCalledTimes(1)
  })

  it('a DELETE that fails mid-way surfaces, keeps the earlier deletions and ClaudeUI’s records, and still refreshes + rings onChange', async () => {
    const { table, store, memory, changes } = setup()
    table.seed(userKey('cred_user_a', 'openrouter', 'sk-a'))
    await store.vendKey('openrouter', 'sk-ours')
    table.seed(userKey('cred_user_b', 'openrouter', 'sk-b', false))
    table.calls.length = 0
    changes.mockClear()
    table.failNext('remove', 1) // cred_user_a goes, cred_user_b fails

    await expect(store.removeIntegration('openrouter', 'remove')).rejects.toThrow(
      'fake remove failed'
    )

    expect(ids(table).sort()).toEqual(['cred_claudeui_openrouter_v1', 'cred_user_b'])
    // The failure path re-lists (the cache must not keep the deleted row) …
    expect(table.calls.at(-1)).toBe('list')
    expect(changes).toHaveBeenCalledTimes(1)
    // … and nothing recorded is forgotten: a later removeSlot still finds its rows.
    expect(memory.read()['openrouter:key']).toEqual({ previousActive: 'cred_user_a' })
    expect(table.leases.opened).toBe(table.leases.released)
  })

  describe('after a DELETE that fails part-way, the cached snapshot holds what is left', () => {
    /**
     * ClaudeUI's key is vended, then the user's own row takes the slot: ClaudeUI's row is the
     * INACTIVE one, so it is deleted first, and the second DELETE (the user's) is the one that fails.
     */
    async function ourKeyGoneThenFailure() {
      const rig = setup()
      await rig.store.vendKey('openrouter', 'sk-ours')
      rig.table.seed(userKey('cred_user', 'openrouter', 'sk-user'))
      expect((await rig.store.snapshot())?.integrations.get('openrouter')?.ownKey).toBe(true)
      rig.table.calls.length = 0
      rig.changes.mockClear()
      return rig
    }

    it('re-listed: ClaudeUI’s deleted key is no longer in it', async () => {
      const { table, store, changes } = await ourKeyGoneThenFailure()
      table.failNext('remove', 1) // cred_claudeui_openrouter_v1 goes, cred_user fails

      await expect(store.removeIntegration('openrouter', 'remove')).rejects.toThrow(
        'fake remove failed'
      )

      expect(table.rows().map((row) => row.id)).toEqual(['cred_user'])
      expect(table.calls).toEqual([
        'list',
        'remove cred_claudeui_openrouter_v1',
        'remove cred_user',
        'list'
      ])
      expect(store.cachedSnapshot()?.integrations.get('openrouter')).toMatchObject({
        ownKey: false,
        activeOwned: false
      })
      expect(changes).toHaveBeenCalledTimes(1)
    })

    it('with the re-list failing too, falls back to the rows it had minus the deleted — and the error stays the remove’s', async () => {
      const { table, store, changes } = await ourKeyGoneThenFailure()
      table.failNext('remove', 1)
      table.failNext('list', 1) // the lease's own list answers, the re-list after the failure does not

      await expect(store.removeIntegration('openrouter', 'remove')).rejects.toThrow(
        'fake remove failed'
      )

      expect(table.calls).toEqual([
        'list',
        'remove cred_claudeui_openrouter_v1',
        'remove cred_user',
        'list'
      ])
      expect(store.cachedSnapshot()?.integrations.get('openrouter')).toMatchObject({
        ownKey: false,
        activeOwned: false
      })
      expect(changes).toHaveBeenCalledTimes(1)
    })
  })

  it('a failure before anything was deleted rings nothing', async () => {
    const { table, store, changes } = setup()
    table.seed(userKey('cred_user', 'openrouter', 'sk-user'))
    table.failNext('remove')
    await expect(store.removeIntegration('openrouter', 'remove')).rejects.toThrow()
    expect(changes).not.toHaveBeenCalled()
    expect(ids(table)).toEqual(['cred_user'])
  })

  it('a later removeSlot whose previousActive row is gone does not throw (the user’s row was deleted by someone else)', async () => {
    const { table, store, memory } = setup()
    table.seed(userKey('cred_user', 'openrouter', 'sk-user'))
    await store.vendKey('openrouter', 'sk-ours')
    expect(memory.read()['openrouter:key']).toEqual({ previousActive: 'cred_user' })
    await table.api.remove('cred_user')
    expect(await store.removeSlot('openrouter', 'key', 'route off')).toBe(true)
    expect(ids(table)).toEqual([])
    expect(memory.read()).toEqual({})
  })

  it('nulls the ChatGPT token it remembers vending when the openai rows go', async () => {
    const { table, store } = setup()
    table.seed(userKey('cred_user_openai', 'openai', 'sk-user', false))
    await store.vendChatgpt({ access: fakeChatgptJwt('acct-1', EXP), expires: NOW })
    expect(store.vendedChatgpt()).not.toBeNull()
    await store.removeIntegration('openai', 'remove openai')
    expect(ids(table)).toEqual([])
    expect(store.vendedChatgpt()).toBeNull()
  })

  it('keeps the remembered ChatGPT token for any other integration', async () => {
    const { table, store } = setup()
    await store.vendChatgpt({ access: fakeChatgptJwt('acct-1', EXP), expires: NOW })
    table.seed(userKey('cred_user', 'openrouter', 'sk-user'))
    await store.removeIntegration('openrouter', 'remove')
    expect(store.vendedChatgpt()).not.toBeNull()
  })

  it('zero rows is a no-op that returns [], still forgets stale records and rings onChange', async () => {
    const { table, store, memory, changes } = setup()
    await store.vendKey('openrouter', 'sk-ours')
    await table.api.remove('cred_claudeui_openrouter_v1') // gone behind ClaudeUI’s back
    expect(Object.keys(memory.read())).toEqual(['openrouter:key'])
    table.calls.length = 0
    changes.mockClear()
    expect(await store.removeIntegration('openrouter', 'remove openrouter')).toEqual([])
    expect(table.calls).toEqual(['list'])
    expect(memory.read()).toEqual({})
    // The surface that offered this Remove saw rows that went elsewhere: its
    // listeners (vendor map, discovery) must re-read.
    expect(changes).toHaveBeenCalledTimes(1)
  })

  it('with opencode not installed it says so and queues nothing', async () => {
    const { table, store, memory } = setup({ available: () => false })
    await expect(store.removeIntegration('openrouter', 'remove')).rejects.toThrow(
      'opencode is not installed — nothing to remove.'
    )
    expect(table.leases.opened).toBe(0)
    expect(memory.read()).toEqual({})
  })

  it('refuses while an enabled shared route claims the integration — nothing deleted, asked inside the lease after the pending removals', async () => {
    let installed = true
    const asked: { openLeases: number; removesSoFar: number }[] = []
    const harness: { table?: ReturnType<typeof fakeCredentialTable> } = {}
    const { table, store, changes } = setup({
      available: () => installed,
      claimedBySharedRoute: async (integrationID) => {
        asked.push({
          openLeases: harness.table!.leases.opened - harness.table!.leases.released,
          removesSoFar: harness.table!.calls.filter((call) => call.startsWith('remove')).length
        })
        return integrationID === 'openai'
      }
    })
    harness.table = table
    table.seed(userKey('cred_user_openai', 'openai', 'sk-user'))
    table.seed(userKey('cred_user_or', 'openrouter', 'sk-or'))
    await store.vendKey('openrouter', 'sk-ours')
    // A removal that waited for opencode runs BEFORE the guard is asked.
    installed = false
    await store.removeSlot('openrouter', 'key', 'route off')
    installed = true
    table.calls.length = 0
    changes.mockClear()

    await expect(store.removeIntegration('openai', 'remove openai')).rejects.toThrow(
      SHARED_ROUTE_CLAIM_MESSAGE
    )
    expect(asked).toEqual([{ openLeases: 1, removesSoFar: 1 }])
    expect(table.calls.filter((call) => call.startsWith('remove'))).toEqual([
      'remove cred_claudeui_openrouter_v1'
    ])
    expect(ids(table)).toContain('cred_user_openai')
    expect(changes).toHaveBeenCalledTimes(1) // the pending removal's, not the refused one's
    // An unclaimed integration goes through the same guard.
    expect(await store.removeIntegration('openrouter', 'remove openrouter')).toEqual([
      'cred_user_or'
    ])
  })

  it('fails closed: a claim guard that throws rejects the Remove — nothing deleted, nothing rung, the lease released', async () => {
    const { table, store, memory, changes } = setup({
      claimedBySharedRoute: () => {
        throw new Error('shared definitions unreadable')
      }
    })
    table.seed(userKey('cred_user', 'openrouter', 'sk-user'))
    await store.vendKey('openrouter', 'sk-ours')
    table.calls.length = 0
    changes.mockClear()
    const recordsBefore = structuredClone(memory.read())

    await expect(store.removeIntegration('openrouter', 'remove openrouter')).rejects.toThrow(
      'shared definitions unreadable'
    )

    expect(table.calls.filter((call) => call.startsWith('remove'))).toEqual([])
    expect(ids(table)).toEqual(['cred_user', 'cred_claudeui_openrouter_v1'])
    expect(memory.read()).toEqual(recordsBefore)
    expect(changes).not.toHaveBeenCalled()
    expect(table.leases.opened).toBe(table.leases.released)
  })

  it('logs every deleted row at WARN (on disk at the default level) by id, value type and owner — never a value or a label', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {})
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      const { table, store } = setup()
      table.seed({
        ...userKey('cred_user_a', 'openrouter', 'sk-SECRET-user'),
        label: 'my-LABEL-secret'
      })
      await store.vendKey('openrouter', 'sk-SECRET-ours')
      await store.removeIntegration('openrouter', 'remove openrouter (test)')
      const deletions = warn.mock.calls
        .map((call) => String(call[1]))
        .filter((line) => line.includes('deleted '))
      const lines = [...info.mock.calls, ...warn.mock.calls].map((call) => String(call[1]))
      expect(deletions).toHaveLength(2)
      expect(deletions[0]).toMatch(
        /remove openrouter \(test\): deleted cred_user_a .*openrouter key row, owner user/
      )
      expect(deletions[1]).toMatch(
        /deleted cred_claudeui_openrouter_v1 .*openrouter key row, owner claudeui/
      )
      expect(lines.join('\n')).not.toMatch(/SECRET|LABEL/)
    } finally {
      info.mockRestore()
      warn.mockRestore()
    }
  })

  it('removeSlot and the other automatic paths still never delete a row of the user’s', async () => {
    const { table, store } = setup()
    table.seed(userKey('cred_user', 'openrouter', 'sk-user'))
    await store.vendKey('openrouter', 'sk-ours')
    await store.removeSlot('openrouter', 'key', 'route off')
    expect(ids(table)).toEqual(['cred_user'])
    expect(table.calls.filter((call) => call.startsWith('remove cred_user'))).toEqual([])
  })
})

describe('integrationsWithRows', () => {
  it('lists every integration holding ANY row (anyone’s, any type) from a fresh read', async () => {
    const { table, store } = setup()
    table.seed(userKey('cred_user', 'openrouter', 'sk-user'))
    await store.vendKey('anthropic', 'sk-ours')
    table.seed({
      id: 'cred_azure_cli',
      integrationID: 'azure',
      label: 'Azure CLI',
      activate: true,
      value: { type: 'external', methodID: 'azure-cli' }
    })
    expect([...(await store.integrationsWithRows())].sort()).toEqual([
      'anthropic',
      'azure',
      'openrouter'
    ])
    // A row written outside ClaudeUI is seen by the very next call (no stale cache).
    table.seed(userKey('cred_user_2', 'groq', 'sk-groq'))
    expect((await store.integrationsWithRows()).has('groq')).toBe(true)
  })

  it('answers from the last snapshot (then empty) while opencode cannot run', async () => {
    let installed = true
    const { table, store } = setup({ available: () => installed })
    table.seed(userKey('cred_user', 'openrouter', 'sk-user'))
    await store.snapshot()
    installed = false
    expect([...(await store.integrationsWithRows())]).toEqual(['openrouter'])
    const cold = setup({ available: () => false })
    expect((await cold.store.integrationsWithRows()).size).toBe(0)
  })
})

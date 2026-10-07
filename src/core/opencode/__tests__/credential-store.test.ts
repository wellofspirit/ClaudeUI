/**
 * @vitest-environment node
 *
 * OpencodeCredentialStore (ADR-093 §5) against an in-memory model of opencode
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
  credentialStem,
  isClaudeuiCredentialId,
  adoptedSigninLabel,
  fileSlotMemory,
  memorySlotMemory,
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
  } = {}
) {
  const table = fakeCredentialTable()
  const memory = options.memory ?? memorySlotMemory()
  const store = new OpencodeCredentialStore({
    connect: table.connect,
    available: options.available,
    memory,
    now: () => NOW,
    isClaudeuiToken: options.isClaudeuiToken
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

describe('M3b: Remove-ability is answered from ClaudeUI’s record (no server)', () => {
  it('recorded key slots, pending removals excluded', async () => {
    let installed = true
    const { table, store } = setup({ available: () => installed })
    await store.vendKey('openrouter', 'k1')
    await store.vendKey('anthropic', 'k2')
    installed = false
    await store.removeSlot('anthropic', 'key', 'route off')
    const opened = table.leases.opened
    expect([...store.recordedRemovableIntegrations()]).toEqual(['openrouter'])
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
    expect([...store.recordedRemovableIntegrations()]).toEqual(['github-copilot'])

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
    expect(store.recordedRemovableIntegrations().size).toBe(0)
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
    expect([...store.recordedRemovableIntegrations()].sort()).toEqual([
      'github-copilot',
      'openrouter'
    ])
    expect(table.rows().find((row) => row.id === 'ghc_late')?.label).toBe(
      adoptedSigninLabel(late.label.slice('claudeui:signin:'.length))
    )
    now += SIGNIN_PENDING_TTL_MS
    table.seed({ ...userKey('ant_too_late', 'anthropic', 'tok'), label: stale.label })
    await store.vendKey('openrouter', 'k2')
    expect(store.recordedRemovableIntegrations().has('anthropic')).toBe(false)
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
      expect(fresh.recordedRemovableIntegrations().has('github-copilot')).toBe(true)
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
    expect(store.recordedRemovableIntegrations().has('github-copilot')).toBe(false)
  })
})

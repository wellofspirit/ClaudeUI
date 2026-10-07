/**
 * @vitest-environment node
 *
 * OpencodeAuthProvider on opencode 2.x (ADR-093 §5): the catalog reads go to
 * `/api/integration` + `/api/provider`, every credential write goes through the
 * credential store (here over an in-memory credential table), OAuth sign-ins
 * run on opencode's integration flows, and nothing is ever recycled.
 * Fake keys and fake JWTs only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockAcquire, mockReleaseIfCurrent, mockRecycleAll, client } = vi.hoisted(() => ({
  mockAcquire: vi.fn(),
  mockReleaseIfCurrent: vi.fn(),
  mockRecycleAll: vi.fn(),
  client: {
    integrations: vi.fn(),
    providers: vi.fn(),
    call: vi.fn()
  }
}))

vi.mock('../../../core/opencode/OpencodeServerManager', () => ({
  opencodeServerManager: {
    acquire: mockAcquire,
    releaseIfCurrent: mockReleaseIfCurrent,
    recycleAll: mockRecycleAll,
    isBinaryAvailable: () => true
  }
}))

vi.mock('../../../core/opencode/OpencodeClient', () => ({
  OpencodeClient: vi.fn(function () {
    return client
  })
}))

vi.mock('../../../core/services/persisted-sessions-dir', () => ({
  PERSISTED_SESSIONS_DIR: '/fake/persisted'
}))

vi.mock('../../../core/services/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

import { OpencodeAuthProvider, OAUTH_POLL_MS } from '../../../core/auth/OpencodeAuthProvider'
import { opencodeCredentialStore } from '../../../core/opencode/opencode-credentials'
import { memorySlotMemory } from '../../../core/opencode/credential-store'
import {
  fakeChatgptJwt,
  fakeCredentialTable,
  type FakeCredentialTable
} from '../../../core/opencode/__tests__/fixtures/fake-credential-table'

const CONN = {
  baseUrl: 'http://127.0.0.1:1',
  password: 'p',
  authHeader: 'Basic x',
  directory: '/fake/persisted',
  startedAt: 0
}

const integrations = [
  { id: 'opencode', name: 'OpenCode Console', methods: [{ type: 'key' }], connections: [] },
  {
    id: 'openai',
    name: 'OpenAI',
    methods: [
      { type: 'key' },
      { type: 'env', names: ['OPENAI_API_KEY'] },
      { id: 'chatgpt-browser', type: 'oauth', label: 'Codex browser (legacy)' }
    ],
    connections: []
  },
  { id: 'openrouter', name: 'OpenRouter', methods: [{ type: 'key' }], connections: [] },
  { id: 'anthropic', name: 'Anthropic', methods: [{ type: 'key' }], connections: [] },
  {
    id: 'groq',
    name: 'Groq',
    methods: [{ type: 'key' }, { type: 'env', names: ['GROQ_API_KEY'] }],
    connections: [{ type: 'env', name: 'GROQ_API_KEY' }]
  },
  {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    methods: [
      { type: 'env', names: ['GITHUB_TOKEN'] },
      {
        id: 'device',
        type: 'oauth',
        label: 'Login with GitHub Copilot',
        form: [
          {
            key: 'deploymentType',
            title: 'Select GitHub deployment type',
            type: 'string',
            options: []
          },
          { key: 'server', hidden: true, type: 'string' }
        ]
      }
    ],
    connections: []
  }
]

let table: FakeCredentialTable
let provider: OpencodeAuthProvider

beforeEach(() => {
  vi.clearAllMocks()
  table = fakeCredentialTable()
  opencodeCredentialStore.configure({
    connect: table.connect,
    available: () => true,
    memory: memorySlotMemory()
  })
  mockAcquire.mockResolvedValue(CONN)
  client.integrations.mockResolvedValue(integrations)
  client.providers.mockImplementation(async () => {
    const usable = new Set(['opencode', 'groq'])
    for (const row of table.rows()) if (row.active) usable.add(row.integrationID)
    return [...usable].map((id) => ({ id, name: id, activation: 'auto', package: 'x' }))
  })
  provider = new OpencodeAuthProvider()
})

afterEach(() => {
  // Every lease handed out was released.
  expect(mockReleaseIfCurrent.mock.calls.length).toBe(mockAcquire.mock.calls.length)
  expect(table.leases.opened).toBe(table.leases.released)
  // 2.x applies credentials live: nothing is ever recycled.
  expect(mockRecycleAll).not.toHaveBeenCalled()
})

describe('probe()', () => {
  it('merges integrations, usable providers and the credential snapshot', async () => {
    await provider.setVendorApiKey('openrouter', 'sk-or-fake')
    await opencodeCredentialStore.vendChatgpt({
      access: fakeChatgptJwt('acct-1', Math.floor(Date.now() / 1000) + 3600),
      expires: Date.now() + 3_600_000
    })
    const map = await provider.probe()
    expect(map.opencode).toEqual({ authState: 'authenticated', billingType: 'free' })
    expect(map.openai).toEqual({ authState: 'authenticated', billingType: 'subscription' })
    expect(map.openrouter).toEqual({ authState: 'authenticated', billingType: 'apiKey' })
    expect(map.anthropic).toEqual({ authState: 'unauthenticated', billingType: 'unknown' })
    // Configured from the environment: no row, the methods decide.
    expect(map.groq).toEqual({ authState: 'authenticated', billingType: 'apiKey' })
  })

  it('caches, and a credential change ClaudeUI makes drops the cache', async () => {
    await provider.probe()
    await provider.probe()
    expect(client.integrations).toHaveBeenCalledTimes(1)
    await provider.setVendorApiKey('anthropic', 'sk-ant-fake')
    const map = await provider.probe()
    expect(client.integrations).toHaveBeenCalledTimes(2)
    expect(map.anthropic).toEqual({ authState: 'authenticated', billingType: 'apiKey' })
  })

  it('degrades to {} when opencode cannot be reached', async () => {
    mockAcquire.mockRejectedValueOnce(new Error('no binary'))
    await expect(provider.probe()).resolves.toEqual({})
    // No lease was handed out, so none is owed (afterEach balances the rest).
    mockAcquire.mock.calls.pop()
  })
})

describe('API keys', () => {
  it('vends cred_claudeui_<vendor>_v<n> and lists the active types — never a key', async () => {
    await provider.setVendorApiKey('openrouter', 'sk-or-fake')
    expect(table.active('openrouter')?.id).toBe('cred_claudeui_openrouter_v1')
    const ids = await provider.listVendorCredentialIds()
    expect(ids).toEqual({ openrouter: 'api' })
    expect(JSON.stringify(ids)).not.toContain('sk-or')
    expect([...(await provider.listRemovableVendorIds())]).toEqual(['openrouter'])
  })

  it('removeVendorAuth removes only ClaudeUI’s rows and gives the slot back to the user’s', async () => {
    table.seed({
      id: 'cred_user_or',
      integrationID: 'openrouter',
      value: { type: 'key', key: 'sk-user-own' }
    })
    await provider.setVendorApiKey('openrouter', 'sk-or-fake')
    expect(table.active('openrouter')?.id).toBe('cred_claudeui_openrouter_v1')
    await provider.removeVendorAuth('openrouter')
    expect(table.rows().map((row) => [row.id, row.active])).toEqual([['cred_user_or', true]])
    expect(await provider.listRemovableVendorIds()).toEqual(new Set())
  })

  it('a removal of a key ClaudeUI never vended touches nothing', async () => {
    table.seed({
      id: 'cred_user_or',
      integrationID: 'openrouter',
      value: { type: 'key', key: 'k' }
    })
    await provider.removeVendorAuth('openrouter')
    expect(table.calls).toEqual([])
    expect(table.rows()).toHaveLength(1)
  })
})

describe('listVendorAuthOptions()', () => {
  it('offers opencode’s key and OAuth methods in order (env and command are not sign-ins)', async () => {
    const options = await provider.listVendorAuthOptions()
    expect(options.openai).toEqual([
      { type: 'api', label: 'API key' },
      { type: 'oauth', label: 'Codex browser (legacy)' }
    ])
    expect(options['github-copilot']).toEqual([
      {
        type: 'oauth',
        label: 'Login with GitHub Copilot',
        prompts: [
          { type: 'select', key: 'deploymentType', message: 'Select GitHub deployment type' }
        ]
      }
    ])
  })
})

describe('OAuth on opencode’s integration flow', () => {
  const attempt = (mode: 'auto' | 'code') => ({
    data: {
      attemptID: 'att_1',
      url: 'https://example.invalid/authorize',
      instructions: 'Open the link',
      mode,
      time: { created: Date.now(), expires: Date.now() + 600_000 }
    }
  })

  it('code mode: connect with the method id by index, complete with the pasted code, release', async () => {
    client.call.mockImplementation(async (op: string) => {
      if (op === 'integration.get') return { data: integrations[5] }
      if (op === 'integration.oauth.connect') return attempt('code')
      return undefined
    })
    const started = await provider.oauthAuthorize('github-copilot', 0, {
      deploymentType: 'github.com'
    })
    expect(started).toEqual({
      url: 'https://example.invalid/authorize',
      method: 'code',
      instructions: 'Open the link'
    })
    expect(client.call).toHaveBeenCalledWith('integration.oauth.connect', {
      params: { integrationID: 'github-copilot' },
      body: { methodID: 'device', answer: { deploymentType: 'github.com' } }
    })
    // The attempt lives in that server: still held.
    expect(mockReleaseIfCurrent).not.toHaveBeenCalled()
    await expect(provider.oauthCallback('github-copilot', 0, 'CODE-1')).resolves.toBe(true)
    expect(client.call).toHaveBeenCalledWith('integration.oauth.complete', {
      params: { integrationID: 'github-copilot', attemptID: 'att_1' },
      body: { code: 'CODE-1' }
    })
    expect(mockReleaseIfCurrent).toHaveBeenCalledTimes(1)
  })

  it('auto mode: polls the attempt until it completes', async () => {
    vi.useFakeTimers()
    try {
      let polls = 0
      client.call.mockImplementation(async (op: string) => {
        if (op === 'integration.get') return { data: integrations[1] }
        if (op === 'integration.oauth.connect') return attempt('auto')
        if (op === 'integration.oauth.status')
          return { data: { status: ++polls < 3 ? 'pending' : 'complete', time: {} } }
        return undefined
      })
      await provider.oauthAuthorize('openai', 1)
      expect(client.call).toHaveBeenCalledWith('integration.oauth.connect', {
        params: { integrationID: 'openai' },
        body: { methodID: 'chatgpt-browser' }
      })
      const done = provider.oauthCallback('openai', 1)
      await vi.advanceTimersByTimeAsync(OAUTH_POLL_MS * 3)
      await expect(done).resolves.toBe(true)
      expect(polls).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses a method index that is not an OAuth method, and releases', async () => {
    client.call.mockResolvedValue({ data: integrations[1] })
    await expect(provider.oauthAuthorize('openai', 0)).rejects.toThrow(/no OAuth method/)
    expect(mockReleaseIfCurrent).toHaveBeenCalledTimes(1)
  })

  it('cancel cancels the attempt and releases once', async () => {
    client.call.mockImplementation(async (op: string) => {
      if (op === 'integration.get') return { data: integrations[1] }
      if (op === 'integration.oauth.connect') return attempt('auto')
      return undefined
    })
    await provider.oauthAuthorize('openai', 1)
    await provider.cancelVendorOauth()
    await provider.cancelVendorOauth()
    expect(client.call).toHaveBeenCalledWith('integration.oauth.cancel', {
      params: { integrationID: 'openai', attemptID: 'att_1' }
    })
    expect(mockReleaseIfCurrent).toHaveBeenCalledTimes(1)
  })
})

describe('accounts', () => {
  it('names the account of the active row (ChatGPT vended, a key) and the native key otherwise', async () => {
    await opencodeCredentialStore.vendChatgpt({
      access: fakeChatgptJwt('acct-9', Math.floor(Date.now() / 1000) + 3600),
      expires: Date.now()
    })
    await provider.setVendorApiKey('openrouter', 'sk-or-fake-1234')
    expect(provider.accountIdentity('openai').accountKey).toMatch(/^chatgpt:acct-9/)
    expect(provider.accountIdentity('openrouter').accountKey).not.toContain('sk-or-fake')
    expect(provider.accountIdentity('mistral')).toEqual({
      accountKey: 'opencode:mistral:native',
      accountLabel: 'mistral'
    })
  })

  it('buildAccountRef reads the warmed probe', async () => {
    expect(provider.buildAccountRef('opencode')).toBeNull()
    await provider.warmCache()
    expect(provider.buildAccountRef('opencode')).toMatchObject({
      engineId: 'opencode',
      vendorId: 'opencode',
      billingType: 'free'
    })
  })
})

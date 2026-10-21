/**
 * @vitest-environment node
 *
 * OpencodeAuthProvider on opencode 2.x (ADR-097 §5): the catalog reads go to
 * `/api/integration` + `/api/provider`, every credential write goes through the
 * credential store (here over an in-memory credential table), OAuth sign-ins
 * run on opencode's integration flows, and nothing is ever recycled.
 * Fake keys and fake JWTs only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockAcquire, mockReleaseIfCurrent, client } = vi.hoisted(() => ({
  mockAcquire: vi.fn(),
  mockReleaseIfCurrent: vi.fn(),
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
    setServerStartedHook: vi.fn(),
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
  },
  {
    // opencode 2.0.25+: signs in through a CLI's own login, nothing stored but a reference.
    id: 'azure',
    name: 'Azure',
    methods: [{ id: 'azure-cli', type: 'external', label: 'Azure CLI' }],
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

  it('an external credential is configured but neither a key nor a subscription', async () => {
    table.seed({
      id: 'cred_azure_cli',
      integrationID: 'azure',
      label: 'Azure CLI',
      activate: true,
      value: { type: 'external', methodID: 'azure-cli' }
    })
    const map = await provider.probe()
    expect(map.azure).toEqual({ authState: 'authenticated', billingType: 'unknown' })
    // The cross-engine credential kinds stay 'api' | 'oauth': the external row is no key.
    expect(await provider.listVendorCredentialIds()).toEqual({})
  })

  it('an integration offering only an external method, configured without a row, is not an apiKey either', async () => {
    client.providers.mockResolvedValue([
      { id: 'azure', name: 'azure', activation: 'auto', package: 'x' }
    ])
    const map = await provider.probe()
    expect(map.azure).toEqual({ authState: 'authenticated', billingType: 'unknown' })
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
  })

  it('removeVendorAuth (an explicit user Remove) deletes EVERY row of the provider — the user’s too — and re-activates nothing', async () => {
    table.seed({
      id: 'cred_user_or',
      integrationID: 'openrouter',
      value: { type: 'key', key: 'sk-user-own' }
    })
    await provider.setVendorApiKey('openrouter', 'sk-or-fake')
    expect(table.active('openrouter')?.id).toBe('cred_claudeui_openrouter_v1')
    table.calls.length = 0
    await provider.removeVendorAuth('openrouter')
    expect(table.rows()).toEqual([])
    expect(table.calls.filter((call) => call.startsWith('activate'))).toEqual([])
    expect(await provider.listVendorCredentialIds()).toEqual({})
  })

  it('removeVendorAuth deletes a key ClaudeUI never vended (the user’s own)', async () => {
    table.seed({
      id: 'cred_user_or',
      integrationID: 'openrouter',
      value: { type: 'key', key: 'k' }
    })
    await provider.removeVendorAuth('openrouter')
    expect(table.calls).toEqual(['list', 'remove cred_user_or', 'list'])
    expect(table.rows()).toEqual([])
  })

  it('removeVendorKey stays narrow: ClaudeUI’s own rows only, the slot given back to the user’s', async () => {
    table.seed({
      id: 'cred_user_or',
      integrationID: 'openrouter',
      value: { type: 'key', key: 'sk-user-own' }
    })
    await provider.setVendorApiKey('openrouter', 'sk-or-fake')
    await provider.removeVendorKey('openrouter')
    expect(table.rows().map((row) => [row.id, row.active])).toEqual([['cred_user_or', true]])
    // A key ClaudeUI never vended is untouched by the narrow verb.
    table.calls.length = 0
    await provider.removeVendorKey('openrouter')
    expect(table.calls).toEqual([])
    expect(table.rows()).toHaveLength(1)
  })

  it('removeVendorAuth rejects when opencode is not installed, and queues nothing', async () => {
    opencodeCredentialStore.configure({ available: () => false })
    await expect(provider.removeVendorAuth('openrouter')).rejects.toThrow(/not installed/)
    expect(table.leases.opened).toBe(0)
  })
})

describe('listVendorAuthOptions()', () => {
  it('offers opencode’s key and OAuth methods in order (env and command are not sign-ins)', async () => {
    const options = await provider.listVendorAuthOptions()
    expect(options.openai).toEqual([
      { type: 'api', label: 'API key' },
      { type: 'oauth', label: 'Codex browser (legacy)' }
    ])
    // An external method is not a sign-in ClaudeUI can drive: nothing is offered for it.
    expect(options).not.toHaveProperty('azure')
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

  it('code mode: connect with the method id by index and a one-off label, complete with the pasted code, adopt the row, release', async () => {
    table.seed({
      id: 'cred_user_gh',
      integrationID: 'github-copilot',
      label: 'mine',
      value: { type: 'key', key: 'gh-user' }
    })
    let label = ''
    client.call.mockImplementation(async (op: string, init: { body?: { label?: string } }) => {
      if (op === 'integration.get') return { data: integrations[5] }
      if (op === 'integration.oauth.connect') {
        label = init.body?.label ?? ''
        return attempt('code')
      }
      // opencode stores the attempt's row: ITS id, the attempt's label.
      if (op === 'integration.oauth.complete')
        table.seed({
          id: 'ghc_opencode_chosen',
          integrationID: 'github-copilot',
          label,
          value: { type: 'oauth', methodID: 'device', refresh: 'r', access: 'a', expires: 1 }
        })
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
      body: {
        methodID: 'device',
        label: expect.stringMatching(/^claudeui:signin:[0-9a-f]{16}$/),
        answer: { deploymentType: 'github.com' }
      }
    })
    // The attempt lives in that server: still held.
    expect(mockReleaseIfCurrent).not.toHaveBeenCalled()
    await expect(provider.oauthCallback('github-copilot', 0, 'CODE-1')).resolves.toBe(true)
    expect(client.call).toHaveBeenCalledWith('integration.oauth.complete', {
      params: { integrationID: 'github-copilot', attemptID: 'att_1' },
      body: { code: 'CODE-1' }
    })
    expect(mockReleaseIfCurrent).toHaveBeenCalledTimes(1)
    // The sign-in started from ClaudeUI is ClaudeUI's. An explicit Remove
    // takes it AND the user's own row; the narrow route verb takes neither a
    // user's row nor (by design) the sign-in.
    expect(opencodeCredentialStore.recordedSlots()).toEqual([
      { integrationID: 'github-copilot', kind: 'signin' }
    ])
    await provider.removeVendorKey('github-copilot')
    expect(table.rows()).toHaveLength(2)
    await provider.removeVendorAuth('github-copilot')
    expect(table.rows()).toEqual([])
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
        body: {
          methodID: 'chatgpt-browser',
          label: expect.stringMatching(/^claudeui:signin:/)
        }
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

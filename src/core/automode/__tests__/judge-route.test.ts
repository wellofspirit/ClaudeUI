/**
 * The judge route resolver (ADR-081 §2-§3): every branch from a judge model
 * value to a route or a user-facing refusal, with fakes for every dependency —
 * no vault, no provider files, no engine catalog, no network.
 */
import { describe, it, expect, vi } from 'vitest'
import { nativeAccountKey } from '../../../shared/account-key'
import type { SharedProviderDefinition, SharedProviderModel } from '../../../shared/shared-provider'
import type { OpencodeCatalogModel } from '../../../shared/types'
import type { CodexInjectionToken } from '../../auth/vault/CredentialSync'
import type { PiModel } from '../../pi/pi-protocol'
import { apiKeyAccountKey } from '../../services/account-key-hash'
import { chatgptProvider } from '../../shared-providers/SharedProviderRepository'
import { buildChatBody } from '../judge-http/wire-chat'
import type { JudgeRouteResult, ResolvedJudgeRoute } from '../judge-http/types'
import { resolveJudgeRoute, type JudgeRouteDeps } from '../judge-route'

const FAKE_KEY = 'sk-test-judge-route-00000000000000ab12'
const OTHER_KEY = 'sk-test-judge-route-11111111111111cd34'

function fakeJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${header}.${payload}.tok-test-signature`
}

const TOKEN: CodexInjectionToken = {
  accessToken: fakeJwt({ chatgpt_account_id: 'ws-test' }),
  chatgptAccountId: 'ws-test',
  chatgptPlanType: 'plus',
  vaultAccountId: 'vault-acct-test'
}
const FRESH_TOKEN: CodexInjectionToken = {
  ...TOKEN,
  accessToken: fakeJwt({ chatgpt_account_id: 'ws-test', fresh: true })
}
const SECRETS = [FAKE_KEY, OTHER_KEY, TOKEN.accessToken, FRESH_TOKEN.accessToken]

function catalogDef(
  id: string,
  over: Partial<SharedProviderDefinition> = {}
): SharedProviderDefinition {
  return {
    id,
    name: id,
    kind: 'catalog',
    models: [],
    managed: true,
    routes: { pi: { enabled: true }, opencode: { enabled: true } },
    ...over
  }
}

function customDef(
  id: string,
  protocol: SharedProviderDefinition['protocol'],
  over: Partial<SharedProviderDefinition> = {}
): SharedProviderDefinition {
  return catalogDef(id, {
    name: `Custom ${id}`,
    kind: 'custom',
    protocol,
    baseUrl: 'https://judge.test/v1/',
    ...over
  })
}

function ocModel(id: string, over: Partial<OpencodeCatalogModel> = {}): OpencodeCatalogModel {
  return { id, name: id, ...over }
}

function piModel(provider: string, id: string, over: Partial<PiModel> = {}): PiModel {
  return {
    id,
    name: id,
    api: 'openai-completions',
    provider,
    baseUrl: 'https://api.pi-vendor.test/v1',
    reasoning: false,
    input: ['text'],
    contextWindow: 128_000,
    maxTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...over
  }
}

function fakeDeps(
  opts: {
    definitions?: SharedProviderDefinition[]
    keys?: Record<string, string>
    token?: CodexInjectionToken | null
    freshToken?: CodexInjectionToken | null
    opencode?: Record<string, OpencodeCatalogModel[]>
    pi?: PiModel[]
  } = {}
): JudgeRouteDeps & {
  chatgptToken: ReturnType<typeof vi.fn>
  loadApiKey: ReturnType<typeof vi.fn>
  opencodeCatalog: ReturnType<typeof vi.fn>
  piCatalog: ReturnType<typeof vi.fn>
} {
  const token = opts.token === undefined ? TOKEN : opts.token
  const fresh = opts.freshToken === undefined ? FRESH_TOKEN : opts.freshToken
  return {
    listDefinitions: () => opts.definitions ?? [chatgptProvider()],
    loadApiKey: vi.fn(async (id: string) => opts.keys?.[id] ?? null),
    chatgptToken: vi.fn(async (force: boolean) => (force ? fresh : token)),
    chatgptIdentity: vi.fn(async (vaultAccountId: string) => ({
      accountKey: `chatgpt:ws-test:user-${vaultAccountId}`,
      accountLabel: 'ChatGPT test account'
    })),
    opencodeCatalog: vi.fn(async (providerId: string) => opts.opencode?.[providerId] ?? []),
    piCatalog: vi.fn(async () => opts.pi ?? []),
    appVersion: '9.9.9-test'
  }
}

/** The route, asserting the result is ok. */
function routeOf(result: JudgeRouteResult): ResolvedJudgeRoute {
  if (!result.ok) throw new Error(`expected a route, got ${result.code}: ${result.reason}`)
  return result.route
}

/** Everything but the headers must be credential-free: labels, reasons, account. */
function expectNoSecrets(result: JudgeRouteResult): void {
  const visible = result.ok ? { ...result.route, headers: undefined } : result
  const text = JSON.stringify(visible)
  for (const secret of SECRETS) expect(text).not.toContain(secret)
}

function expectUnavailable(result: JudgeRouteResult, code: string): string {
  expectNoSecrets(result)
  if (result.ok) throw new Error(`expected ${code}, got a ${result.route.kind} route`)
  expect(result.code).toBe(code)
  return result.reason
}

describe('resolveJudgeRoute — ChatGPT subscription', () => {
  it('opencode openai/* → the ChatGPT backend with the active account', async () => {
    const deps = fakeDeps()
    const result = await resolveJudgeRoute('opencode', 'openai/gpt-5.4-mini', deps)
    const route = routeOf(result)
    expectNoSecrets(result)
    expect(route).toMatchObject({
      kind: 'chatgpt',
      wire: 'responses',
      url: 'https://chatgpt.com/backend-api/codex/responses',
      model: 'gpt-5.4-mini',
      label: 'ChatGPT · gpt-5.4-mini',
      account: {
        vendorId: 'openai',
        accountId: 'vault-acct-test',
        accountKey: 'chatgpt:ws-test:user-vault-acct-test',
        accountLabel: 'ChatGPT test account',
        billingType: 'subscription'
      }
    })
    expect(route.caps.systemChannel).toBe('instructions')
    expect(route.headers).toEqual({
      Authorization: `Bearer ${TOKEN.accessToken}`,
      'ChatGPT-Account-Id': 'ws-test',
      originator: 'opencode',
      'User-Agent': expect.stringMatching(/^ClaudeUI\/9\.9\.9-test \(\S+ \S+; \S+\)$/)
    })
    expect(route.maxOutputTokens).toBeUndefined()
    expect(deps.chatgptToken).toHaveBeenCalledTimes(1)
    expect(deps.chatgptToken).toHaveBeenCalledWith(false)
  })

  it('pi openai-codex/* → ChatGPT too (the native-id mapping)', async () => {
    const route = routeOf(await resolveJudgeRoute('pi', 'openai-codex/gpt-5.4', fakeDeps()))
    expect(route.kind).toBe('chatgpt')
    expect(route.account.vendorId).toBe('openai-codex')
  })

  it("the ChatGPT ids don't cross engines: pi openai/* and opencode openai-codex/* are engine-owned", async () => {
    expectUnavailable(
      await resolveJudgeRoute('pi', 'openai/gpt-5.4', fakeDeps()),
      'no-shared-provider'
    )
    expectUnavailable(
      await resolveJudgeRoute('opencode', 'openai-codex/gpt-5.4', fakeDeps()),
      'no-shared-provider'
    )
  })

  it('adds the residency header when the token carries a constraint', async () => {
    const token = {
      ...TOKEN,
      accessToken: fakeJwt({ 'https://api.openai.com/auth': { chatgpt_compute_residency: 'eu' } })
    }
    const route = routeOf(
      await resolveJudgeRoute('opencode', 'openai/gpt-5.4', fakeDeps({ token }))
    )
    expect(route.headers['x-openai-internal-codex-residency']).toBe('eu')
  })

  it('reauthorize force-refreshes and rebuilds the route from the fresh token', async () => {
    const deps = fakeDeps()
    const route = routeOf(await resolveJudgeRoute('opencode', 'openai/gpt-5.4', deps))
    const fresh = await route.reauthorize!()
    expect(deps.chatgptToken).toHaveBeenLastCalledWith(true)
    expect(fresh).not.toBeNull()
    expect(fresh!.headers.Authorization).toBe(`Bearer ${FRESH_TOKEN.accessToken}`)
    expect(fresh!.url).toBe(route.url)
    expect(fresh!.account).toEqual(route.account)
  })

  it('reauthorize → null when the refresh yields no token, or the same (refused) one', async () => {
    const gone = routeOf(
      await resolveJudgeRoute('opencode', 'openai/gpt-5.4', fakeDeps({ freshToken: null }))
    )
    expect(await gone.reauthorize!()).toBeNull()
    // injectionTokenFor returns the old token when the refresh itself failed.
    const stale = routeOf(
      await resolveJudgeRoute('opencode', 'openai/gpt-5.4', fakeDeps({ freshToken: TOKEN }))
    )
    expect(await stale.reauthorize!()).toBeNull()
  })

  it('no token (signed out / no workspace) → chatgpt-unavailable', async () => {
    const reason = expectUnavailable(
      await resolveJudgeRoute('opencode', 'openai/gpt-5.4', fakeDeps({ token: null })),
      'chatgpt-unavailable'
    )
    expect(reason).toMatch(/Sign in to ChatGPT/)
  })

  it("the ChatGPT route switched off for the engine → the engine's own provider", async () => {
    const chatgpt = chatgptProvider()
    chatgpt.routes.opencode.enabled = false
    expectUnavailable(
      await resolveJudgeRoute('opencode', 'openai/gpt-5.4', fakeDeps({ definitions: [chatgpt] })),
      'no-shared-provider'
    )
  })
})

describe('resolveJudgeRoute — custom endpoints', () => {
  const declared: SharedProviderModel[] = [
    {
      id: 'canon-model',
      reasoning: true,
      maxTokens: 4096,
      harnessOverrides: { opencode: { id: 'oc-model' } }
    }
  ]

  it('openai-completions → custom-chat at baseUrl/chat/completions, key digest account', async () => {
    const deps = fakeDeps({
      definitions: [
        chatgptProvider(),
        customDef('acme', 'openai-completions', { models: declared })
      ],
      keys: { acme: FAKE_KEY }
    })
    const result = await resolveJudgeRoute('opencode', 'acme/oc-model', deps)
    const route = routeOf(result)
    expectNoSecrets(result)
    expect(route).toMatchObject({
      kind: 'custom-chat',
      wire: 'chat',
      url: 'https://judge.test/v1/chat/completions',
      model: 'oc-model',
      label: 'acme · oc-model',
      maxOutputTokens: 4096,
      account: {
        ...apiKeyAccountKey('acme', FAKE_KEY),
        vendorId: 'acme',
        accountId: null,
        billingType: 'apiKey'
      }
    })
    expect(route.headers).toEqual({ Authorization: `Bearer ${FAKE_KEY}` })
    expect(deps.loadApiKey).toHaveBeenCalledWith('acme')
    // The declared ceiling clamps the stage-2 budget in the body.
    expect(buildChatBody(route, { system: 's', user: 'u', maxTokens: 8192 }).max_tokens).toBe(4096)
  })

  it("the definition's native id is the provider (routes.<engine>.providerId)", async () => {
    const def = customDef('acme', 'openai-completions', {
      routes: { pi: { enabled: true, providerId: 'acme-pi' }, opencode: { enabled: true } }
    })
    const deps = fakeDeps({ definitions: [def], keys: { acme: FAKE_KEY } })
    expect(routeOf(await resolveJudgeRoute('pi', 'acme-pi/m', deps)).kind).toBe('custom-chat')
    expectUnavailable(await resolveJudgeRoute('pi', 'acme/m', deps), 'no-shared-provider')
  })

  it('openai-responses → custom-responses at baseUrl/responses', async () => {
    const deps = fakeDeps({
      definitions: [customDef('acme', 'openai-responses', { baseUrl: 'https://judge.test/v1' })],
      keys: { acme: FAKE_KEY }
    })
    const route = routeOf(await resolveJudgeRoute('pi', 'acme/gpt-5-mini', deps))
    expect(route).toMatchObject({
      kind: 'custom-responses',
      wire: 'responses',
      url: 'https://judge.test/v1/responses'
    })
    expect(route.maxOutputTokens).toBeUndefined()
  })

  it('anthropic-messages → unsupported-protocol', async () => {
    const deps = fakeDeps({
      definitions: [customDef('acme', 'anthropic-messages')],
      keys: { acme: FAKE_KEY }
    })
    const reason = expectUnavailable(
      await resolveJudgeRoute('opencode', 'acme/claude-x', deps),
      'unsupported-protocol'
    )
    expect(reason).toMatch(/Anthropic Messages API/)
  })

  it('an OpenRouter second key → the openrouter kind, attribution headers, reasoning off', async () => {
    const def = customDef('openrouter-work', 'openai-completions', {
      derivedFrom: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      models: [{ id: 'z-ai/glm-4.6', reasoning: true }]
    })
    const deps = fakeDeps({ definitions: [def], keys: { 'openrouter-work': OTHER_KEY } })
    const result = await resolveJudgeRoute('opencode', 'openrouter-work/z-ai/glm-4.6', deps)
    const route = routeOf(result)
    expectNoSecrets(result)
    expect(route).toMatchObject({
      kind: 'openrouter',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      model: 'z-ai/glm-4.6'
    })
    expect(route.headers).toEqual({
      Authorization: `Bearer ${OTHER_KEY}`,
      'HTTP-Referer': 'https://github.com/wellofspirit/ClaudeUI',
      'X-Title': 'ClaudeUI'
    })
    expect(route.caps.reasoning.fast).toEqual({ reasoning: { enabled: false } })
    expect(route.account.accountKey).toBe(apiKeyAccountKey('openrouter-work', OTHER_KEY).accountKey)
  })

  it('a keyless endpoint → no Authorization, the native account key', async () => {
    const deps = fakeDeps({ definitions: [customDef('local', 'openai-completions')] })
    const route = routeOf(await resolveJudgeRoute('pi', 'local/qwen', deps))
    expect(route.headers).toEqual({})
    expect(route.account).toEqual({
      vendorId: 'local',
      accountId: null,
      accountKey: nativeAccountKey('pi', 'local'),
      accountLabel: 'local',
      billingType: 'apiKey'
    })
  })

  it('a templated base URL → no-base-url', async () => {
    const deps = fakeDeps({
      definitions: [customDef('acme', 'openai-completions', { baseUrl: '${ACME_URL}/v1' })]
    })
    expectUnavailable(await resolveJudgeRoute('opencode', 'acme/m', deps), 'no-base-url')
  })
})

describe('resolveJudgeRoute — catalog providers', () => {
  it('openai → the constant OpenAI URL; the catalog supplies the ceiling', async () => {
    const deps = fakeDeps({
      definitions: [
        chatgptProvider(),
        // opencode's `openai` is ChatGPT's here — the collision guard keeps the key on pi.
        catalogDef('openai', { routes: { pi: { enabled: true }, opencode: { enabled: false } } })
      ],
      keys: { openai: FAKE_KEY },
      pi: [piModel('openai', 'gpt-4.1-mini', { api: 'openai-responses', maxTokens: 32_768 })]
    })
    const result = await resolveJudgeRoute('pi', 'openai/gpt-4.1-mini', deps)
    const route = routeOf(result)
    expectNoSecrets(result)
    expect(route).toMatchObject({
      kind: 'openai',
      url: 'https://api.openai.com/v1/chat/completions',
      model: 'gpt-4.1-mini',
      maxOutputTokens: 32_768,
      account: { ...apiKeyAccountKey('openai', FAKE_KEY), billingType: 'apiKey' }
    })
    expect(route.headers).toEqual({ Authorization: `Bearer ${FAKE_KEY}` })
  })

  it('openrouter → the constant OpenRouter URL, attribution headers, catalog reasoning bit', async () => {
    const deps = fakeDeps({
      definitions: [catalogDef('openrouter')],
      keys: { openrouter: FAKE_KEY },
      opencode: { openrouter: [ocModel('z-ai/glm-4.6', { reasoning: true, maxTokens: 0 })] }
    })
    const route = routeOf(await resolveJudgeRoute('opencode', 'openrouter/z-ai/glm-4.6', deps))
    expect(route).toMatchObject({
      kind: 'openrouter',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      model: 'z-ai/glm-4.6'
    })
    expect(route.headers['HTTP-Referer']).toBe('https://github.com/wellofspirit/ClaudeUI')
    expect(route.headers['X-Title']).toBe('ClaudeUI')
    expect(route.caps.reasoning.thinking).toEqual({ reasoning: { enabled: false } })
    // A zero limit is "unknown", not a ceiling.
    expect(route.maxOutputTokens).toBeUndefined()
    expect(deps.opencodeCatalog).toHaveBeenCalledWith('openrouter')
  })

  it('openai / openrouter absent from the catalog still route (the URL is a constant)', async () => {
    const deps = fakeDeps({
      definitions: [catalogDef('openrouter')],
      keys: { openrouter: FAKE_KEY }
    })
    const route = routeOf(await resolveJudgeRoute('pi', 'openrouter/some/new-model', deps))
    expect(route.kind).toBe('openrouter')
    expect(route.caps.reasoning.fast).toEqual({})
  })

  it('openai with a throwing catalog still routes, without the catalog facts', async () => {
    const deps = fakeDeps({ definitions: [catalogDef('openai')], keys: { openai: FAKE_KEY } })
    deps.piCatalog.mockRejectedValue(new Error('pi probe failed'))
    const route = routeOf(await resolveJudgeRoute('pi', 'openai/gpt-4.1-mini', deps))
    expect(route).toMatchObject({
      kind: 'openai',
      url: 'https://api.openai.com/v1/chat/completions'
    })
    expect(route.maxOutputTokens).toBeUndefined()
    expect(deps.piCatalog).toHaveBeenCalled()
  })

  it('another catalog provider with a throwing catalog → rejects (the URL comes from it)', async () => {
    const deps = fakeDeps({ definitions: [catalogDef('acme')], keys: { acme: FAKE_KEY } })
    deps.opencodeCatalog.mockRejectedValue(new Error('opencode server hiccup'))
    await expect(resolveJudgeRoute('opencode', 'acme/fast-1', deps)).rejects.toThrow(
      'opencode server hiccup'
    )
  })

  it('no key in the vault → no-credential, without consulting the catalog', async () => {
    const deps = fakeDeps({ definitions: [catalogDef('openrouter')] })
    const reason = expectUnavailable(
      await resolveJudgeRoute('opencode', 'openrouter/z-ai/glm-4.6', deps),
      'no-credential'
    )
    expect(reason).toMatch(/no API key/)
    expect(deps.opencodeCatalog).not.toHaveBeenCalled()
  })

  it('another catalog provider on opencode with the openai-compatible SDK → custom-chat', async () => {
    const deps = fakeDeps({
      definitions: [catalogDef('acme')],
      keys: { acme: FAKE_KEY },
      opencode: {
        acme: [
          ocModel('fast-1', {
            apiNpm: '@ai-sdk/openai-compatible',
            apiUrl: 'https://api.acme.test/v1/',
            reasoning: false,
            maxTokens: 8000
          })
        ]
      }
    })
    const result = await resolveJudgeRoute('opencode', 'acme/fast-1', deps)
    const route = routeOf(result)
    expectNoSecrets(result)
    expect(route).toMatchObject({
      kind: 'custom-chat',
      url: 'https://api.acme.test/v1/chat/completions',
      model: 'fast-1',
      maxOutputTokens: 8000,
      account: { vendorId: 'acme', billingType: 'apiKey' }
    })
  })

  it('another catalog provider on pi with api openai-completions → custom-chat', async () => {
    const deps = fakeDeps({
      definitions: [catalogDef('acme')],
      keys: { acme: FAKE_KEY },
      pi: [
        piModel('other', 'fast-1', { baseUrl: 'https://wrong.test' }),
        piModel('acme', 'fast-1', { baseUrl: 'https://api.acme.test/v1', maxTokens: 2048 })
      ]
    })
    const route = routeOf(await resolveJudgeRoute('pi', 'acme/fast-1', deps))
    expect(route).toMatchObject({
      kind: 'custom-chat',
      url: 'https://api.acme.test/v1/chat/completions',
      maxOutputTokens: 2048
    })
  })

  it('a catalog provider behind another SDK / api → unsupported-protocol', async () => {
    const opencode = fakeDeps({
      definitions: [catalogDef('anthropic')],
      keys: { anthropic: FAKE_KEY },
      opencode: { anthropic: [ocModel('claude-x', { apiNpm: '@ai-sdk/anthropic' })] }
    })
    expect(
      expectUnavailable(
        await resolveJudgeRoute('opencode', 'anthropic/claude-x', opencode),
        'unsupported-protocol'
      )
    ).toMatch(/@ai-sdk\/anthropic/)
    const pi = fakeDeps({
      definitions: [catalogDef('google')],
      keys: { google: FAKE_KEY },
      pi: [piModel('google', 'gemini-x', { api: 'google-generative-ai' })]
    })
    expectUnavailable(await resolveJudgeRoute('pi', 'google/gemini-x', pi), 'unsupported-protocol')
  })

  it('a templated or missing catalog URL → no-base-url', async () => {
    const templated = fakeDeps({
      definitions: [catalogDef('acme')],
      keys: { acme: FAKE_KEY },
      opencode: {
        acme: [ocModel('m', { apiNpm: '@ai-sdk/openai-compatible', apiUrl: '${ACME_BASE}/v1' })]
      }
    })
    expectUnavailable(await resolveJudgeRoute('opencode', 'acme/m', templated), 'no-base-url')
    const missing = fakeDeps({
      definitions: [catalogDef('acme')],
      keys: { acme: FAKE_KEY },
      opencode: { acme: [ocModel('m', { apiNpm: '@ai-sdk/openai-compatible' })] }
    })
    expectUnavailable(await resolveJudgeRoute('opencode', 'acme/m', missing), 'no-base-url')
  })

  it("a model not in the engine's catalog → unsupported-protocol naming the catalog", async () => {
    const deps = fakeDeps({
      definitions: [catalogDef('acme')],
      keys: { acme: FAKE_KEY },
      pi: [piModel('acme', 'other-model')]
    })
    const reason = expectUnavailable(
      await resolveJudgeRoute('pi', 'acme/missing-model', deps),
      'unsupported-protocol'
    )
    expect(reason).toMatch(/not in pi's catalog/)
  })
})

describe('resolveJudgeRoute — providers ClaudeUI does not own', () => {
  it('a provider switched off in ClaudeUI → provider-disabled', async () => {
    const deps = fakeDeps({
      definitions: [catalogDef('openrouter', { name: 'OpenRouter', disabled: true })],
      keys: { openrouter: FAKE_KEY }
    })
    const reason = expectUnavailable(
      await resolveJudgeRoute('opencode', 'openrouter/z-ai/glm-4.6', deps),
      'provider-disabled'
    )
    expect(reason).toMatch(/"OpenRouter" is switched off/)
    expect(deps.loadApiKey).not.toHaveBeenCalled()
  })

  it('an engine-owned provider (Copilot) → no-shared-provider, as an instruction', async () => {
    const reason = expectUnavailable(
      await resolveJudgeRoute('opencode', 'github-copilot/gpt-4.1', fakeDeps()),
      'no-shared-provider'
    )
    expect(reason).toBe(
      '"github-copilot" is set up inside opencode, not in ClaudeUI, so ClaudeUI can\'t call it for the judge. Pick a judge model from a provider in Settings › Models & providers.'
    )
  })
})

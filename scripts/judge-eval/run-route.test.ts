/**
 * `run.ts`'s route selection and size summary. `run.ts` itself cannot be
 * imported without starting an eval, so these exercise the pure module it calls.
 */
import { describe, expect, it } from 'vitest'
import { outputCapValue } from '../../src/core/automode/judge-http/caps'
import { buildChatBody } from '../../src/core/automode/judge-http/wire-chat'
import type { VaultAccount } from '../../src/core/auth/vault/AuthVault'
import {
  accountNote,
  buildCustomRoute,
  estimateTokens,
  parseRouteHeaders,
  parseRouteHeadroom,
  pickChatgptAccount,
  readOnlyTokenOf,
  requestDumpLine,
  ROUTE_REASONING_HEADROOM,
  summarizeSizes,
  wireModelOf
} from './run-route'

describe('buildCustomRoute (--route-url)', () => {
  const route = buildCustomRoute({
    model: 'opencode/big-pickle',
    baseUrl: 'https://x/v1',
    key: 'public'
  })

  it('posts to <base>/chat/completions with the wire model and the bearer header', () => {
    expect(route.kind).toBe('custom-chat')
    expect(route.wire).toBe('chat')
    expect(route.url).toBe('https://x/v1/chat/completions')
    expect(route.model).toBe('big-pickle')
    expect(route.headers.Authorization).toBe('Bearer public')
    expect(route.headers['x-opencode-client']).toBe('ClaudeUI-judge-eval')
    expect(route.label).toBe('zen · big-pickle')
    expect(route.account).toEqual({
      vendorId: 'opencode',
      accountId: null,
      accountKey: 'eval-zen',
      accountLabel: 'zen-public',
      billingType: 'apiKey'
    })
  })

  it('sets the reasoning headroom, which widens only the wire cap', () => {
    expect(route.caps.reasoningHeadroom).toBe(ROUTE_REASONING_HEADROOM)
    expect(outputCapValue(route, { maxTokens: 64 })).toBe(64 + ROUTE_REASONING_HEADROOM)
    const body = buildChatBody(route, { system: 's', user: 'u', maxTokens: 256, stage: 'fast' })
    expect(body.model).toBe('big-pickle')
    expect(body.max_tokens).toBe(256 + ROUTE_REASONING_HEADROOM)
  })

  it('trims trailing slashes, honours --route-key and keeps a model with no slash whole', () => {
    const other = buildCustomRoute({ model: 'plain', baseUrl: 'https://x/v1//', key: 'k' })
    expect(other.url).toBe('https://x/v1/chat/completions')
    expect(other.model).toBe('plain')
    expect(other.headers.Authorization).toBe('Bearer k')
  })

  it('adds --route-header entries and a --route-headroom override', () => {
    const tuned = buildCustomRoute({
      model: 'opencode/big-pickle',
      baseUrl: 'https://x/v1',
      key: 'public',
      headers: { 'x-opencode-project': 'p', 'X-Opencode-Client': 'mine' },
      headroom: 16384
    })
    expect(tuned.headers.Authorization).toBe('Bearer public')
    expect(tuned.headers['x-opencode-project']).toBe('p')
    expect(tuned.headers['X-Opencode-Client']).toBe('mine')
    expect(tuned.caps.reasoningHeadroom).toBe(16384)
    expect(outputCapValue(tuned, { maxTokens: 64 })).toBe(64 + 16384)
    // Neither option leaks into the default route.
    expect(route.headers['x-opencode-project']).toBeUndefined()
    expect(route.caps.reasoningHeadroom).toBe(ROUTE_REASONING_HEADROOM)
  })

  it('cuts the wire model at the FIRST slash only', () => {
    expect(wireModelOf('openrouter/z-ai/glm-4.6')).toBe('z-ai/glm-4.6')
  })

  it('refuses an empty base or a model with no wire part', () => {
    expect(() => buildCustomRoute({ model: 'a/b', baseUrl: ' / ', key: 'k' })).toThrow()
    expect(() => buildCustomRoute({ model: 'opencode/', baseUrl: 'https://x', key: 'k' })).toThrow()
  })
})

describe('--route-header / --route-headroom parsing', () => {
  it('splits at the first = and trims; a later entry for a name wins, case-insensitively', () => {
    expect(
      parseRouteHeaders([
        'x-opencode-project=p',
        'x-opencode-session = a=b ',
        'X-Opencode-Project=q'
      ])
    ).toEqual({ 'X-Opencode-Project': 'q', 'x-opencode-session': 'a=b' })
    expect(parseRouteHeaders([])).toEqual({})
  })

  it('refuses a malformed entry, a control character and Authorization, naming no value', () => {
    expect(() => parseRouteHeaders(['no-equals'])).toThrow('entry #1')
    expect(() => parseRouteHeaders(['ok=1', '=v'])).toThrow('entry #2')
    expect(() => parseRouteHeaders(['bad name=v'])).toThrow('entry #1')
    expect(() => parseRouteHeaders(['x=a\r\nInjected: 1'])).toThrow('control character')
    expect(() => parseRouteHeaders(['Authorization=Bearer secret-value'])).toThrow('--route-key')
    try {
      parseRouteHeaders(['authorization=secret-value'])
    } catch (err) {
      expect(String(err)).not.toContain('secret-value')
    }
  })

  it('accepts a positive integer headroom and nothing else', () => {
    expect(parseRouteHeadroom('16384')).toBe(16384)
    for (const bad of ['0', '-1', '1.5', 'abc', '', '2000000'])
      expect(() => parseRouteHeadroom(bad)).toThrow('--route-headroom')
  })
})

describe('--chatgpt-account lookup', () => {
  const oauth = (id: string, expires: number, extra: Partial<VaultAccount> = {}): VaultAccount =>
    ({
      id,
      accountId: `ws-${id}`,
      planType: 'plus',
      credential: { type: 'oauth', access: `tok-${id}`, refresh: 'r', expires },
      addedAt: 0,
      ...extra
    }) as unknown as VaultAccount
  const now = 1_000
  const accounts = [oauth('a1', now + 10), oauth('a2', now + 10, { planType: 'pro' })]

  it('uses the requested account instead of the active one', () => {
    expect(pickChatgptAccount(accounts, 'a1', 'a2')?.id).toBe('a2')
    expect(pickChatgptAccount(accounts, 'a1')?.id).toBe('a1')
  })

  it('never falls back to the active account for an unknown requested id', () => {
    expect(pickChatgptAccount(accounts, 'a1', 'nope')).toBeUndefined()
    expect(pickChatgptAccount(accounts, null)).toBeUndefined()
  })

  it('reads the token read-only: null when expired, workspace-less or not oauth', () => {
    expect(readOnlyTokenOf(accounts[1], now)).toEqual({
      accessToken: 'tok-a2',
      chatgptAccountId: 'ws-a2',
      chatgptPlanType: 'pro',
      vaultAccountId: 'a2'
    })
    expect(readOnlyTokenOf(oauth('x', now), now)).toBeNull()
    expect(readOnlyTokenOf(oauth('x', now + 10, { accountId: undefined }), now)).toBeNull()
    expect(
      readOnlyTokenOf(
        oauth('x', now + 10, { credential: { type: 'api_key', key: 'k' } } as never),
        now
      )
    ).toBeNull()
  })

  it('names the account by vault id and plan, never the email', () => {
    const note = accountNote(oauth('a1', now, { email: 'someone@example.test' }))
    expect(note).toBe('account a1 (plus)')
    expect(note).not.toContain('@')
  })
})

describe('summarizeSizes (--dry-run-sizes)', () => {
  it('estimates tokens as chars/4, rounded up', () => {
    expect(estimateTokens(4)).toBe(1)
    expect(estimateTokens(5)).toBe(2)
  })

  it('reports max, median and the strict over-threshold counts', () => {
    // 100k, 150k, 160k, 800k chars → 25k, 37.5k, 40k, 200k tokens (40k is NOT over 40k).
    const s = summarizeSizes([100_000, 150_000, 160_000, 800_000], [30_000, 40_000, 190_000])
    expect(s.count).toBe(4)
    expect(s.maxChars).toBe(800_000)
    expect(s.maxTokens).toBe(200_000)
    expect(s.medianTokens).toBe(Math.round((37_500 + 40_000) / 2))
    expect(s.over).toEqual({ 30_000: 3, 40_000: 1, 190_000: 1 })
  })

  it('handles one case and none', () => {
    expect(summarizeSizes([40], [10]).medianTokens).toBe(10)
    expect(summarizeSizes([], [10])).toMatchObject({ count: 0, maxTokens: 0, medianTokens: 0 })
  })
})

describe('requestDumpLine (--dump-requests)', () => {
  it('is one JSON line carrying exactly the system and user text', () => {
    const system = 'policy line 1\npolicy "quoted" line 2'
    const user = '{"meta":{}}\nuser turn with unicode … and a tab\t'
    const line = requestDumpLine('R-1', { stage: 'thinking', system, user })
    expect(line).not.toContain('\n')
    expect(JSON.parse(line)).toEqual({ caseId: 'R-1', stage: 'thinking', system, user })
  })

  it('records an unnamed stage as null', () => {
    expect(JSON.parse(requestDumpLine('R-2', { system: 's', user: 'u' })).stage).toBeNull()
  })
})

/**
 * Layer 1: the app's one derived auth view (ADR-070 §4).
 *
 * The rules that matter are the ones the six deleted surfaces each got wrong in
 * their own way: `'unknown'` must contribute nothing (a cold boot showed a
 * banner), a live flow must win the tone (the banner had to stay visible for
 * it), a resolution with a retry owed must not read as a sign-in still needed,
 * and the order must be stable so the pill's label and the dialog's list cannot
 * disagree.
 */
import { describe, it, expect } from 'vitest'
import { summarizeAuthIssues, type AuthIssuesInput } from '../auth-issues'
import { UNKNOWN_PROVIDER_AUTH, type ProviderAuthView } from '../../utils/sign-in-provider'
import type { AuthRequiredState } from '../../../../shared/remote-protocol'

function input(over: {
  providerAuth?: Partial<ProviderAuthView>
  blamed?: Record<string, AuthRequiredState>
  authorizing?: Partial<AuthIssuesInput['authorizing']>
}): AuthIssuesInput {
  return {
    providerAuth: { ...UNKNOWN_PROVIDER_AUTH, ...over.providerAuth },
    blamed: over.blamed ?? {},
    authorizing: { anthropic: false, chatgpt: false, ...over.authorizing }
  }
}

describe("auth-issues — 'unknown' contributes nothing", () => {
  it('a cold boot (nothing probed, nothing failed) is not an issue', () => {
    const summary = summarizeAuthIssues(input({}))
    expect(summary.issues).toEqual([])
    expect(summary.tone).toBe('none')
  })

  it("an 'unknown' provider stays silent even beside an unauthenticated one", () => {
    const summary = summarizeAuthIssues(
      input({ providerAuth: { anthropic: 'unauthenticated', chatgpt: 'unknown' } })
    )
    expect(summary.issues.map((i) => i.providerId)).toEqual(['anthropic'])
    expect(summary.tone).toBe('needed')
  })

  it('an authenticated provider is not an issue either', () => {
    const summary = summarizeAuthIssues(
      input({ providerAuth: { anthropic: 'authenticated', chatgpt: 'authenticated' } })
    )
    expect(summary.tone).toBe('none')
  })
})

describe('auth-issues — needed vs expired', () => {
  it("'unauthenticated' with nothing failed is amber `needed`", () => {
    const summary = summarizeAuthIssues(input({ providerAuth: { chatgpt: 'unauthenticated' } }))
    expect(summary.issues[0]).toMatchObject({
      providerId: 'chatgpt',
      kind: 'needed',
      routingIds: []
    })
    expect(summary.tone).toBe('needed')
  })

  it('an unresolved authRequired is red `expired`, and outranks a needed one', () => {
    const summary = summarizeAuthIssues(
      input({
        providerAuth: { anthropic: 'unauthenticated' },
        blamed: { r1: { providerId: 'chatgpt', accountId: 'acct-1', retryPrompt: 'do it' } }
      })
    )
    expect(summary.tone).toBe('expired')
    const chatgpt = summary.issues.find((i) => i.providerId === 'chatgpt')
    expect(chatgpt).toMatchObject({
      kind: 'expired',
      routingIds: ['r1'],
      accountId: 'acct-1',
      retry: { routingId: 'r1', prompt: 'do it' },
      drivable: true
    })
    expect(summary.issues.find((i) => i.providerId === 'anthropic')?.kind).toBe('needed')
  })

  it('aggregates every session blaming one provider into one issue', () => {
    const summary = summarizeAuthIssues(
      input({
        blamed: {
          r1: { providerId: 'chatgpt' },
          r2: { providerId: 'chatgpt', retryPrompt: 'second' }
        }
      })
    )
    expect(summary.issues).toHaveLength(1)
    expect(summary.issues[0].routingIds).toEqual(['r1', 'r2'])
    // The retry target is the first blamed session that captured a prompt.
    expect(summary.issues[0].retry).toEqual({ routingId: 'r2', prompt: 'second' })
  })

  it('an engine-native credential is an issue with no flow to offer', () => {
    const summary = summarizeAuthIssues(
      input({ blamed: { r1: { providerId: 'opencode:openrouter' } } })
    )
    expect(summary.issues[0]).toMatchObject({
      providerId: 'opencode:openrouter',
      kind: 'expired',
      drivable: false,
      blocks: ['opencode']
    })
  })
})

describe('auth-issues — a live flow wins the tone', () => {
  it.each([
    ['anthropic', { anthropic: true }],
    ['chatgpt', { chatgpt: true }]
  ] as const)('%s authorizing outranks expired', (providerId, authorizing) => {
    const summary = summarizeAuthIssues(
      input({
        providerAuth: { anthropic: 'unauthenticated' },
        blamed: { r1: { providerId: 'chatgpt' } },
        authorizing
      })
    )
    expect(summary.tone).toBe('authorizing')
    expect(summary.authorizing).toBe(providerId)
    // The issues themselves are untouched — the flow changes what the pill SAYS,
    // not what is wrong.
    expect(summary.issues).toHaveLength(2)
  })
})

describe('auth-issues — the resolved lifetime', () => {
  it('a resolution with a retry owed is `resolved`, not a sign-in still needed', () => {
    const summary = summarizeAuthIssues(
      input({
        providerAuth: { chatgpt: 'authenticated' },
        blamed: { r1: { providerId: 'chatgpt', resolved: true, retryPrompt: 'refactor it' } }
      })
    )
    expect(summary.tone).toBe('resolved')
    // Not counted as an issue: the credential is fine and all that is left is
    // the retry, so the pill must not say "1 sign-in needed".
    expect(summary.issues).toEqual([])
    // The app-wide list names the provider whose credential stopped each prompt
    // (`OwedRetry`): this entry outlives its own issue, so `routingId` alone
    // would leave a per-provider consumer — the dialog's done state — unable to
    // tell whose retry it is holding.
    expect(summary.retryable).toEqual([
      { routingId: 'r1', prompt: 'refactor it', providerId: 'chatgpt' }
    ])
    expect(summary.resolved).toEqual(['r1'])
  })

  it('a resolution with no captured prompt is resolved with nothing owed', () => {
    const summary = summarizeAuthIssues(
      input({ blamed: { r1: { providerId: 'chatgpt', resolved: true } } })
    )
    expect(summary.tone).toBe('resolved')
    expect(summary.retryable).toEqual([])
    expect(summary.resolved).toEqual(['r1'])
  })

  it('a session still broken outranks a sibling that was fixed', () => {
    const summary = summarizeAuthIssues(
      input({
        blamed: {
          r1: { providerId: 'chatgpt', resolved: true, retryPrompt: 'fixed one' },
          r2: { providerId: 'chatgpt' }
        }
      })
    )
    expect(summary.tone).toBe('expired')
    expect(summary.issues[0].routingIds).toEqual(['r2'])
    expect(summary.issues[0].retryable).toEqual([
      { routingId: 'r1', prompt: 'fixed one', providerId: 'chatgpt' }
    ])
  })

  it('two providers owing retries stay tellable apart on the app-wide list', () => {
    const summary = summarizeAuthIssues(
      input({
        blamed: {
          r1: { providerId: 'chatgpt', resolved: true, retryPrompt: 'refactor it' },
          r2: { providerId: 'anthropic', resolved: true, retryPrompt: 'fix the test' }
        }
      })
    )
    // Neither provider is an ISSUE any more — both credentials are good — so
    // the provider on each entry is the only thing left that says which
    // sign-in unblocked which prompt.
    expect(summary.issues).toEqual([])
    expect(summary.retryable.map((owed) => [owed.providerId, owed.prompt])).toEqual([
      ['chatgpt', 'refactor it'],
      ['anthropic', 'fix the test']
    ])
  })
})

describe('auth-issues — ordering is stable', () => {
  it('drivable first, then providerId, whatever order the sessions arrived in', () => {
    const forward = summarizeAuthIssues(
      input({
        blamed: {
          r1: { providerId: 'pi:anthropic' },
          r2: { providerId: 'chatgpt' },
          r3: { providerId: 'opencode:openrouter' },
          r4: { providerId: 'anthropic' }
        }
      })
    )
    const reverse = summarizeAuthIssues(
      input({
        blamed: {
          r4: { providerId: 'anthropic' },
          r3: { providerId: 'opencode:openrouter' },
          r2: { providerId: 'chatgpt' },
          r1: { providerId: 'pi:anthropic' }
        }
      })
    )
    const expected = ['anthropic', 'chatgpt', 'opencode:openrouter', 'pi:anthropic']
    expect(forward.issues.map((i) => i.providerId)).toEqual(expected)
    expect(reverse.issues.map((i) => i.providerId)).toEqual(expected)
  })
})

describe('auth-issues — what a credential blocks', () => {
  it('ChatGPT blocks Codex always and pi/opencode only on an enabled route', () => {
    const off = summarizeAuthIssues(input({ providerAuth: { chatgpt: 'unauthenticated' } }))
    expect(off.issues[0].blocks).toEqual(['Codex'])

    const on = summarizeAuthIssues(
      input({
        providerAuth: { chatgpt: 'unauthenticated', chatgptRoutes: { pi: true, opencode: false } }
      })
    )
    expect(on.issues[0].blocks).toEqual(['Codex', 'pi'])
  })

  it('Anthropic blocks Claude', () => {
    const summary = summarizeAuthIssues(input({ providerAuth: { anthropic: 'unauthenticated' } }))
    expect(summary.issues[0].blocks).toEqual(['Claude'])
  })
})

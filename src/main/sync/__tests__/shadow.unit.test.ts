/**
 * @vitest-environment node
 *
 * The shadow comparator's masks — SyncCore phase 4a item 9.
 *
 * Each mask corresponds to a KNOWN structural divergence between canonical state
 * and the renderer replica. A mask that is too wide hides real drift (which is the
 * whole reason the harness exists), so every one is pinned here together with a
 * positive test proving the comparator still catches a genuine difference in the
 * same field family.
 */

import { describe, it, expect } from 'vitest'
import { compareShadow, formatShadowDiff } from '../shadow'
import type { FullStateSnapshot, PerSessionSnapshot } from '../../../shared/remote-protocol'
import type { SessionStatus } from '../../../shared/types'

function status(state: SessionStatus['state']): SessionStatus {
  return {
    state,
    sessionId: null,
    model: null,
    cwd: null,
    totalCostUsd: 0,
    engineId: 'claude',
    account: null
  } as SessionStatus
}

function session(overrides: Partial<PerSessionSnapshot> = {}): PerSessionSnapshot {
  return {
    routingId: 'rid',
    cwd: '/repo',
    messages: [],
    streamingText: '',
    streamingThinking: '',
    status: status('idle'),
    pendingApprovals: [],
    todos: [],
    sentFiles: [],
    queue: [],
    taskNotifications: [],
    activeTasks: {},
    taskProgressMap: {},
    subagentMessages: {},
    subagentStreamingText: {},
    subagentStreamingThinking: {},
    permissionMode: 'default',
    effort: '',
    thinkingMode: '',
    reasoningVariant: null,
    statusLine: null,
    slashCommands: [],
    sdkSkillNames: [],
    sdkActive: false,
    selectedEngineId: 'claude',
    selectedModel: 'default',
    ...overrides
  }
}

function snapshot(sessions: Record<string, PerSessionSnapshot>, seq = 1): FullStateSnapshot {
  return {
    seq,
    sessions,
    directories: [],
    activeSessionId: null,
    settings: {},
    recentSessionIds: [],
    pinnedSessionIds: [],
    customTitles: {},
    worktreeInfoMap: {}
  }
}

describe('compareShadow — clean', () => {
  it('reports nothing for identical snapshots', () => {
    const s = snapshot({ rid: session() })
    expect(compareShadow(s, snapshot({ rid: session() }))).toEqual([])
  })
})

describe('compareShadow — real drift IS reported', () => {
  it('catches a per-session field difference', () => {
    const diffs = compareShadow(
      snapshot({ rid: session({ permissionMode: 'plan' }) }),
      snapshot({ rid: session({ permissionMode: 'default' }) })
    )
    expect(diffs.map((d) => d.field)).toEqual(['permissionMode'])
  })

  it('catches an app-level field difference', () => {
    const a = snapshot({})
    const b = { ...snapshot({}), recentSessionIds: ['x'] }
    expect(compareShadow(a, b).map((d) => d.field)).toEqual(['recentSessionIds'])
  })

  it('catches a metering difference (the field 4a added)', () => {
    const diffs = compareShadow(
      snapshot({ rid: session({ metering: { tokens: { total: 5 } } as never }) }),
      snapshot({ rid: session() })
    )
    expect(diffs.map((d) => d.field)).toEqual(['metering'])
  })

  it('reports a one-sided session as ONE row, not a field storm', () => {
    const diffs = compareShadow(snapshot({ rid: session() }), snapshot({}))
    expect(diffs).toHaveLength(1)
    expect(diffs[0]).toMatchObject({ routingId: 'rid', field: 'session-missing-in-renderer' })
  })

  it('catches a genuine message-content difference despite the identity mask', () => {
    const diffs = compareShadow(
      snapshot({
        rid: session({
          messages: [
            { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'x' }], timestamp: 0 }
          ]
        })
      }),
      snapshot({
        rid: session({
          messages: [
            {
              id: 'a1',
              role: 'assistant',
              content: [{ type: 'text', text: 'DIFFERENT' }],
              timestamp: 0
            }
          ]
        })
      })
    )
    expect(diffs.map((d) => d.field)).toEqual(['messages'])
  })
})

describe('compareShadow — masks', () => {
  it('masks user-message id and timestamp (client-minted today)', () => {
    const diffs = compareShadow(
      snapshot({
        rid: session({
          messages: [
            { id: 'user-7', role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 0 }
          ]
        })
      }),
      snapshot({
        rid: session({
          messages: [
            {
              id: 'msg-6f0a',
              role: 'user',
              content: [{ type: 'text', text: 'hi' }],
              timestamp: 1755000000000
            }
          ]
        })
      })
    )
    expect(diffs).toEqual([])
  })

  it('still catches a user-message CONTENT difference', () => {
    const diffs = compareShadow(
      snapshot({
        rid: session({
          messages: [
            { id: 'user-7', role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 0 }
          ]
        })
      }),
      snapshot({
        rid: session({
          messages: [
            { id: 'msg-6f0a', role: 'user', content: [{ type: 'text', text: 'bye' }], timestamp: 0 }
          ]
        })
      })
    )
    expect(diffs.map((d) => d.field)).toEqual(['messages'])
  })

  it('masks thinking-block durationMs (the reducer is clock-free)', () => {
    const diffs = compareShadow(
      snapshot({
        rid: session({
          messages: [
            {
              id: 'a1',
              role: 'assistant',
              content: [{ type: 'thinking', text: 'hmm' }],
              timestamp: 0
            }
          ]
        })
      }),
      snapshot({
        rid: session({
          messages: [
            {
              id: 'a1',
              role: 'assistant',
              content: [{ type: 'thinking', text: 'hmm', durationMs: 4200 }],
              timestamp: 0
            }
          ]
        })
      })
    )
    expect(diffs).toEqual([])
  })

  it('compares streaming buffers only at idle', () => {
    const running = compareShadow(
      snapshot({ rid: session({ status: status('running'), streamingText: 'core has more' }) }),
      snapshot({ rid: session({ status: status('running'), streamingText: 'core' }) })
    )
    expect(running).toEqual([])

    const idle = compareShadow(
      snapshot({ rid: session({ streamingText: 'leftover' }) }),
      snapshot({ rid: session({ streamingText: '' }) })
    )
    expect(idle.map((d) => d.field)).toEqual(['streamingText'])
  })

  it('honours compareStreamingAlways for tests that drive to a known point', () => {
    const diffs = compareShadow(
      snapshot({ rid: session({ status: status('running'), streamingText: 'a' }) }),
      snapshot({ rid: session({ status: status('running'), streamingText: 'b' }) }),
      { compareStreamingAlways: true }
    )
    expect(diffs.map((d) => d.field)).toEqual(['streamingText'])
  })

  it('skips sessions core has not finished seeding', () => {
    const diffs = compareShadow(
      snapshot({ rid: session({ permissionMode: 'plan' }) }),
      snapshot({ rid: session() }),
      { unseeded: new Set(['rid']) }
    )
    expect(diffs).toEqual([])
  })

  it('skips a session the renderer has evicted (stripped transcript)', () => {
    const diffs = compareShadow(
      snapshot({
        rid: session({
          messages: [{ id: 'a1', role: 'assistant', content: [], timestamp: 0 }],
          permissionMode: 'plan'
        })
      }),
      // Renderer kept the lightweight entry but dropped the heavy arrays.
      snapshot({ rid: session({ messages: [] }) })
    )
    expect(diffs).toEqual([])
  })

  it('does NOT treat two genuinely-empty transcripts as eviction', () => {
    const diffs = compareShadow(
      snapshot({ rid: session({ permissionMode: 'plan' }) }),
      snapshot({ rid: session({ permissionMode: 'default' }) })
    )
    expect(diffs.map((d) => d.field)).toEqual(['permissionMode'])
  })

  it('bounds the reported rows', () => {
    const many: Record<string, PerSessionSnapshot> = {}
    for (let i = 0; i < 20; i++) many[`s${i}`] = session({ permissionMode: 'plan' })
    const diffs = compareShadow(snapshot(many), snapshot({}), { limit: 5 })
    expect(diffs).toHaveLength(5)
  })
})

describe('formatShadowDiff', () => {
  it('produces one truncated line per divergence', () => {
    const lines = formatShadowDiff(
      [{ routingId: 'rid', field: 'streamingText', canonical: 'x'.repeat(500), renderer: '' }],
      20
    )
    expect(lines).toHaveLength(1)
    expect(lines[0].startsWith('rid.streamingText: core="')).toBe(true)
    expect(lines[0].length).toBeLessThan(120)
  })

  it('names app-level rows without a session prefix', () => {
    expect(
      formatShadowDiff([{ routingId: null, field: 'settings', canonical: 1, renderer: 2 }])
    ).toEqual(['settings: core=1 renderer=2'])
  })
})

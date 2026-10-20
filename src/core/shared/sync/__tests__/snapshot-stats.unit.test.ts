/**
 * @vitest-environment node
 *
 * `describeSnapshot` — the `SyncStats` breakdown of one `sync-full` payload.
 *
 * Built from a synthetic CANONICAL state pushed through the real `toSnapshot`, so
 * the shapes under test are the ones a host actually serializes (including the
 * `slashCommands` copy repeated on every session entry, which is the very thing
 * the measurement exists to price).
 */

import { describe, it, expect } from 'vitest'
import { emptyCanonicalState, emptySession, toSnapshot } from '../state'
import type { CanonicalState, CanonicalSessionState } from '../state'
import { describeSnapshot, formatSnapshotStats } from '../snapshot-stats'
import type { ChatMessage } from '../../../../shared/types'

/** Text that must never reach a log line: transcript, titles, cwd paths. */
const SECRET_TEXT = 'TRANSCRIPT-SECRET-do-not-log'
const SECRET_TITLE = 'TITLE-SECRET-do-not-log'
const SECRET_CWD = '/Users/someone/CWD-SECRET-do-not-log'

function message(id: string, text: string): ChatMessage {
  return { id, role: 'assistant', content: [{ type: 'text', text }], timestamp: 1 }
}

function session(
  id: string,
  patch: Partial<CanonicalSessionState> & { fill?: number }
): CanonicalSessionState {
  const { fill = 0, ...rest } = patch
  const s = emptySession(id, SECRET_CWD)
  s.messages = Array.from({ length: fill }, (_, i) => message(`${id}-m${i}`, SECRET_TEXT))
  return { ...s, seeded: true, ...rest }
}

function fixture(): CanonicalState {
  const state = emptyCanonicalState()
  state.slashCommands = [
    { name: '/compact', description: 'Summarize the conversation' },
    { name: '/review' }
  ]
  state.sdkSkillNames = ['skill-a', 'skill-b']
  state.customTitles = { live1: SECRET_TITLE }
  state.settings = { theme: 'dark' }
  state.sessions = {
    // Live (sdkActive) with a long transcript, a subagent transcript and a stream.
    live1: session('live1', {
      sdkActive: true,
      fill: 40,
      subagentMessages: { toolA: [message('sub-1', SECRET_TEXT)] },
      itemStreams: {
        k: {
          target: { messageId: 'live1-m0', blockIndex: 0, kind: 'text' },
          generation: 1,
          value: SECRET_TEXT
        }
      }
    }),
    // Live because it is RUNNING, not because the sdk flag is set.
    live2: session('live2', {
      sdkActive: false,
      fill: 5,
      status: { ...emptySession('x').status, state: 'running' }
    }),
    // Evicted: transcript dropped by the host.
    gone: session('gone', { seeded: false })
  }
  return state
}

describe('describeSnapshot', () => {
  const snapshot = toSnapshot(fixture(), 7)
  const stats = describeSnapshot(snapshot)

  it('measures the whole payload', () => {
    expect(stats.totalBytes).toBe(JSON.stringify(snapshot).length)
    expect(stats.stringifyMs).toBeGreaterThanOrEqual(0)
  })

  it('counts sessions: total, live (sdkActive or running), unseeded', () => {
    expect(stats.sessionCounts).toEqual({ total: 3, live: 2, unseeded: 1 })
  })

  it('splits the app level so the parts add up to the total', () => {
    const { app } = stats
    expect(app.directories).toBe(JSON.stringify(snapshot.directories).length)
    expect(app.settings).toBe(JSON.stringify(snapshot.settings).length)
    expect(app.sessions).toBeGreaterThan(0)
    expect(app.rest).toBeGreaterThan(0)
    expect(app.directories + app.settings + app.sessions + app.rest).toBe(stats.totalBytes)
  })

  it('splits each session entry into messages / subagent / streams / rest that add up', () => {
    const live1 = stats.top.find((s) => s.routingId === 'live1')!
    const entry = snapshot.sessions.live1
    expect(live1.messages).toBe(JSON.stringify(entry.messages).length)
    expect(live1.subagentMessages).toBe(JSON.stringify(entry.subagentMessages).length)
    expect(live1.itemStreams).toBe(JSON.stringify(entry.itemStreams).length)
    expect(live1.messageCount).toBe(40)
    for (const s of stats.top) {
      expect(s.messages + s.subagentMessages + s.itemStreams + s.rest).toBe(s.bytes)
    }
    // …and the cross-session totals are the sums of those parts.
    const sum = (key: 'messages' | 'subagentMessages' | 'itemStreams' | 'rest'): number =>
      stats.top.reduce((n, s) => n + s[key], 0)
    expect(stats.sessionBytes.messages).toBe(sum('messages'))
    expect(stats.sessionBytes.subagentMessages).toBe(sum('subagentMessages'))
    expect(stats.sessionBytes.itemStreams).toBe(sum('itemStreams'))
    expect(stats.sessionBytes.rest).toBe(sum('rest'))
    expect(stats.app.sessions).toBe(stats.top.reduce((n, s) => n + s.bytes, 0))
  })

  it('orders the top sessions by size, largest first', () => {
    expect(stats.top.map((s) => s.routingId)).toEqual(['live1', 'live2', 'gone'])
  })

  it('caps the top list at five', () => {
    const state = fixture()
    for (let i = 0; i < 6; i++) {
      state.sessions[`extra${i}`] = session(`extra${i}`, { fill: 10 + i })
    }
    const many = describeSnapshot(toSnapshot(state, 7))
    expect(many.sessionCounts.total).toBe(9)
    expect(many.top).toHaveLength(5)
    expect(many.top.map((s) => s.routingId)).toEqual([
      'live1',
      'extra5',
      'extra4',
      'extra3',
      'extra2'
    ])
  })

  it('prices the slashCommands/sdkSkillNames copy repeated in every entry', () => {
    const perEntry =
      JSON.stringify(snapshot.sessions.live1.slashCommands).length +
      JSON.stringify(snapshot.sessions.live1.sdkSkillNames).length
    expect(stats.slashRepeat).toEqual({ perEntry, entries: 3, total: perEntry * 3 })
  })

  it('handles an empty snapshot', () => {
    const empty = describeSnapshot(toSnapshot(emptyCanonicalState(), 0))
    expect(empty.sessionCounts).toEqual({ total: 0, live: 0, unseeded: 0 })
    expect(empty.top).toEqual([])
    expect(empty.slashRepeat).toEqual({ perEntry: 0, entries: 0, total: 0 })
    expect(empty.app.sessions).toBe(0)
  })

  it('carries no transcript text, title or cwd — only ids and numbers', () => {
    const serialized = JSON.stringify(stats) + formatSnapshotStats(stats)
    expect(serialized).not.toContain(SECRET_TEXT)
    expect(serialized).not.toContain(SECRET_TITLE)
    expect(serialized).not.toContain('CWD-SECRET')
    // The one non-numeric thing it may print is a routing id.
    expect(serialized).toContain('live1')
  })

  it('renders one line with the headline numbers', () => {
    const line = formatSnapshotStats(stats)
    expect(line).not.toContain('\n')
    expect(line).toContain(`totalBytes=${stats.totalBytes}`)
    expect(line).toContain('sessions[total=3 live=2 unseeded=1]')
    expect(line).toContain(`slashRepeat[perEntry=${stats.slashRepeat.perEntry} entries=3`)
  })
})

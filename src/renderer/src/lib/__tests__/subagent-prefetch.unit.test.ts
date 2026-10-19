/**
 * ADR-102 Arc 2 — the background phase of a Claude load: the activation reconciler,
 * the per-session job (status line + subagent buckets), its ordering and bounds,
 * the generation guard (R4), the replica fills' own guards (R1, R3), on-demand
 * requests, cancel / restart on activation, and the bar's plan (C5).
 *
 * `window.api` is faked down to the three calls the job makes; the store and the
 * replica are real, so every write goes through the sanctioned fills.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ChatMessage, SessionInfo, SubagentIndexEntry } from '../../../../shared/types'
import type { InvokeProgress } from '../../../../shared/remote-protocol'
import {
  evictedViewPatch,
  useSessionStore,
  type BackgroundLoadView
} from '../../stores/session-store'
import {
  evictLocalSessions,
  fillSubagentBucket,
  getReplicaState,
  patchLocalSession,
  replaceStatusLine
} from '../../stores/replica'
import {
  MAX_BUCKET_FETCHES,
  requestSubagentTranscript,
  resetBackgroundLoadForTests,
  startBackgroundLoad
} from '../subagent-prefetch'
import { resetHistoryLoadForTests, isTranscriptLoadInFlight } from '../session-history-load'
import { resetReplicaSeam } from '@test/helpers/replica-seed'

const store = (): ReturnType<typeof useSessionStore.getState> => useSessionStore.getState()

const message = (id: string): ChatMessage => ({
  id,
  role: 'assistant',
  content: [{ type: 'text', text: id }],
  timestamp: 1
})

const INFO: SessionInfo = {
  sessionId: 'sess',
  cwd: '/p',
  projectKey: '-p',
  title: 'sess',
  timestamp: 1,
  lastActivityAt: 1
}

const STATUS = { totalCostUsd: 7, totalTokens: 70 } as never
const STATUS_B = { totalCostUsd: 8, totalTokens: 80 } as never

interface Deferred<T> {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const loadSessionStatusLine = vi.fn()
const loadSubagentHistory = vi.fn()

/** An index entry; `agent-<tu>` is its agent id. */
const entry = (
  toolUseId: string,
  over: Partial<SubagentIndexEntry> = {}
): [string, SubagentIndexEntry] => [
  toolUseId,
  { agentId: `agent-${toolUseId}`, parentToolUseId: null, bytes: 100, order: 1, ...over }
]
const indexOf = (
  ...entries: Array<[string, SubagentIndexEntry]>
): Record<string, SubagentIndexEntry> => Object.fromEntries(entries)

/** What the content-first commit leaves on the entry, and the active session pointing at it. */
function openSession(index: Record<string, SubagentIndexEntry>, messages = [message('m1')]): void {
  store().loadHistoricalSession('sess', messages, '/p', [], undefined, null, undefined, {
    subagentIndex: index,
    source: { sessionId: 'sess', projectKey: '-p' },
    statusPending: true,
    statusBytes: 1000
  })
}
function activate(id: string | null = 'sess'): void {
  // No sidebar listing at all: a job never needs one (the commit recorded the source).
  useSessionStore.setState({ activeSessionId: id })
}
const session = (): ReturnType<typeof store>['sessions'][string] => store().sessions['sess']
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

let stop: (() => void) | null = null

beforeEach(() => {
  resetReplicaSeam()
  resetBackgroundLoadForTests()
  loadSessionStatusLine.mockReset()
  loadSubagentHistory.mockReset()
  ;(globalThis as unknown as { window: { api: unknown } }).window = {
    api: {
      loadSessionStatusLine,
      loadSubagentHistory,
      saveSessionConfig: vi.fn(),
      logRelay: vi.fn()
    }
  } as never
  useSessionStore.setState({
    activeSessionId: null,
    sessions: {},
    directories: [],
    recentSessionIds: [],
    customTitles: {},
    sessionEngines: {}
  })
  stop = startBackgroundLoad()
})

afterEach(() => {
  stop?.()
  stop = null
  resetBackgroundLoadForTests()
  resetHistoryLoadForTests()
})

/** Gate every bucket fetch; `started` lists agent ids in the order they were asked for. */
function gateBuckets(): {
  started: string[]
  gates: Map<string, Array<Deferred<ChatMessage[]>>>
  peak: () => number
  finish: (toolUseId: string, messages?: ChatMessage[]) => Promise<void>
} {
  const started: string[] = []
  const gates = new Map<string, Array<Deferred<ChatMessage[]>>>()
  let inFlight = 0
  let peak = 0
  loadSubagentHistory.mockImplementation(async (_s: string, _k: string, agentId: string) => {
    started.push(agentId)
    inFlight++
    peak = Math.max(peak, inFlight)
    const gate = deferred<ChatMessage[]>()
    gates.set(agentId, [...(gates.get(agentId) ?? []), gate])
    try {
      return await gate.promise
    } finally {
      inFlight--
    }
  })
  return {
    started,
    gates,
    peak: () => peak,
    finish: async (toolUseId, messages = [message(`b-${toolUseId}`)]) => {
      // The oldest pending call for that agent (a restarted job may ask twice).
      gates.get(`agent-${toolUseId}`)!.shift()!.resolve(messages)
      await flush()
    }
  }
}

describe('the activation reconciler (R2)', () => {
  it('starts the job for the ACTIVE session once its content is committed: status line + buckets, then clears the bar', async () => {
    const g = gateBuckets()
    const status = deferred<unknown>()
    loadSessionStatusLine.mockReturnValue(status.promise)
    openSession(indexOf(entry('tA'), entry('tB')))
    activate()

    // Concurrently: the status pass and the first buckets.
    expect(loadSessionStatusLine).toHaveBeenCalledWith('sess', '-p', expect.any(Function))
    expect(g.started).toEqual(['agent-tA', 'agent-tB'])
    expect(session().backgroundLoad).toMatchObject({ statusPending: true })

    status.resolve(STATUS)
    await g.finish('tA')
    await g.finish('tB')
    await flush()

    expect(session().statusLine).toBe(STATUS)
    expect(Object.keys(session().subagentMessages).sort()).toEqual(['tA', 'tB'])
    expect(session().backgroundLoad).toBeNull()
  })

  it('does nothing for a session that is not active, and the click path never starts it', async () => {
    openSession(indexOf(entry('tA')))
    await flush()
    expect(loadSessionStatusLine).not.toHaveBeenCalled()
    expect(loadSubagentHistory).not.toHaveBeenCalled()
    // Nothing in flight under the load registry either: a send never waits on this phase.
    expect(isTranscriptLoadInFlight('sess')).toBe(false)
  })

  it('an empty transcript has nothing to wait for: the bar is cleared and nothing is fetched', async () => {
    openSession(indexOf(entry('tA')), [])
    activate()
    await flush()
    expect(session().backgroundLoad).toBeNull()
    expect(loadSessionStatusLine).not.toHaveBeenCalled()
    expect(loadSubagentHistory).not.toHaveBeenCalled()
  })

  it('a session that went live drops the late status line (R3) and clears the wait', async () => {
    const status = deferred<unknown>()
    loadSessionStatusLine.mockReturnValue(status.promise)
    loadSubagentHistory.mockResolvedValue([])
    openSession(indexOf())
    activate()
    expect(session().backgroundLoad?.statusPending).toBe(true)

    // A prompt is sent meanwhile: the engine spawns and the session seeds its own figures.
    patchLocalSession('sess', { sdkActive: true })
    expect(session().backgroundLoad).toBeNull()

    status.resolve(STATUS)
    await flush()
    expect(session().statusLine).toBeNull()
  })
})

describe('what the job needs, and what it leaves behind', () => {
  it('runs from the commit alone: a session the sidebar listing does not name still loads (no directories)', async () => {
    const g = gateBuckets()
    loadSessionStatusLine.mockResolvedValue(STATUS)
    expect(store().directories).toEqual([])
    openSession(indexOf(entry('tA')))
    activate()
    expect(loadSessionStatusLine).toHaveBeenCalledWith('sess', '-p', expect.any(Function))
    expect(g.started).toEqual(['agent-tA'])
    await g.finish('tA')
    await flush()
    expect(session().statusLine).toBe(STATUS)
    expect(session().backgroundLoad).toBeNull()
  })

  it('an on-demand request needs no listing either', async () => {
    const g = gateBuckets()
    openSession(indexOf(entry('tA')))
    requestSubagentTranscript('sess', 'tA') // not active, no directories
    expect(g.started).toEqual(['agent-tA'])
  })

  it('a session that went live while inactive and came back idle leaves no wait behind', async () => {
    const g = gateBuckets()
    openSession(indexOf(entry('tA')))
    expect(session().backgroundLoad?.statusPending).toBe(true)
    // It ran (a prompt was sent from another view) and is idle again, no longer historical.
    useSessionStore.setState((s) => ({
      sessions: { ...s.sessions, sess: { ...s.sessions['sess'], isHistorical: false } }
    }))

    activate()

    expect(session().backgroundLoad).toBeNull()
    expect(loadSessionStatusLine).not.toHaveBeenCalled()
    expect(g.started).toEqual([])
  })

  it('a session with nothing pending (a stale bar) has it cleared when it becomes active', async () => {
    openSession(indexOf(entry('tGone', { bytes: 0 })))
    useSessionStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        sess: {
          ...s.sessions['sess'],
          backgroundLoad: { fraction: 0.5, label: 'x', statusPending: false, statusBytes: 1 }
        }
      }
    }))
    activate()
    expect(session().backgroundLoad).toBeNull()
  })

  it('a status line that lands after the session was left still ends the wait, so a return does not read it again', async () => {
    const status = deferred<unknown>()
    loadSessionStatusLine.mockReturnValue(status.promise)
    loadSubagentHistory.mockResolvedValue([])
    openSession(indexOf())
    activate()
    expect(loadSessionStatusLine).toHaveBeenCalledTimes(1)

    activate(null) // the user navigated away: the job is cancelled, its status pass still running
    status.resolve(STATUS)
    await flush()
    expect(session().statusLine).toBe(STATUS)
    expect(session().backgroundLoad).toBeNull()

    activate('sess')
    await flush()
    expect(loadSessionStatusLine).toHaveBeenCalledTimes(1)
  })

  it('...and keeps the bar when buckets are still missing, only without the status wait', async () => {
    const g = gateBuckets()
    const status = deferred<unknown>()
    loadSessionStatusLine.mockReturnValue(status.promise)
    openSession(indexOf(entry('tA')))
    activate()
    activate(null)
    status.resolve(STATUS)
    await flush()
    expect(session().backgroundLoad).toMatchObject({ statusPending: false })
    activate('sess')
    expect(loadSessionStatusLine).toHaveBeenCalledTimes(1)
    expect(g.started).toEqual(['agent-tA', 'agent-tA'])
  })
})

describe('bucket order and bounds (C3)', () => {
  it('fetches at most 2 at a time: parents of nested agents first, then newest transcript first', async () => {
    const g = gateBuckets()
    loadSessionStatusLine.mockResolvedValue(STATUS)
    openSession(
      indexOf(
        entry('tParent', { order: 10 }),
        entry('tChild', { order: 50, parentToolUseId: 'tParent' }),
        entry('tA', { order: 40 }),
        entry('tB', { order: 30 }),
        entry('tD', { order: 20 })
      )
    )
    activate()

    expect(MAX_BUCKET_FETCHES).toBe(2)
    expect(g.started).toEqual(['agent-tParent', 'agent-tChild'])
    await g.finish('tParent')
    expect(g.started).toEqual(['agent-tParent', 'agent-tChild', 'agent-tA'])
    await g.finish('tChild')
    await g.finish('tA')
    await g.finish('tB')
    await g.finish('tD')
    expect(g.started).toEqual(['tParent', 'tChild', 'tA', 'tB', 'tD'].map((t) => `agent-${t}`))
    expect(g.peak()).toBe(2)
  })

  it('skips agents with no transcript on disk and buckets that are already loaded', async () => {
    const g = gateBuckets()
    loadSessionStatusLine.mockResolvedValue(STATUS)
    openSession(indexOf(entry('tGone', { bytes: 0 }), entry('tHeld'), entry('tNew')))
    // tHeld's bucket is already there (a live agent streamed into it).
    expect(fillSubagentBucket('sess', 'tHeld', [message('live')])).toBe(true)
    activate()
    expect(g.started).toEqual(['agent-tNew'])
  })

  it('an on-demand request jumps the queue', async () => {
    const g = gateBuckets()
    loadSessionStatusLine.mockResolvedValue(STATUS)
    openSession(
      indexOf(
        entry('tA', { order: 90 }),
        entry('tB', { order: 80 }),
        entry('tC', { order: 70 }),
        entry('tOld', { order: 1 })
      )
    )
    activate()
    expect(g.started).toEqual(['agent-tA', 'agent-tB'])

    requestSubagentTranscript('sess', 'tOld')
    await g.finish('tA')
    // tC is next in line by recency, but the opened card's bucket goes first.
    expect(g.started.at(2)).toBe('agent-tOld')
  })

  it('a request for a transcript that is loaded, unlisted or in flight starts nothing', async () => {
    const g = gateBuckets()
    loadSessionStatusLine.mockResolvedValue(STATUS)
    openSession(indexOf(entry('tA')))
    activate()
    expect(g.started).toEqual(['agent-tA'])
    requestSubagentTranscript('sess', 'tA') // in flight
    requestSubagentTranscript('sess', 'nope') // not in the index
    await g.finish('tA')
    requestSubagentTranscript('sess', 'tA') // loaded
    expect(g.started).toEqual(['agent-tA'])
  })

  it('with no job running an on-demand request fetches just that bucket, and shows the bar while it does', async () => {
    const g = gateBuckets()
    loadSessionStatusLine.mockResolvedValue(STATUS)
    openSession(indexOf(entry('tA')))
    activate()
    await g.finish('tA')
    await flush()
    expect(session().backgroundLoad).toBeNull()

    // A later load left another transcript unfetched (it failed once, say): the card asks again.
    useSessionStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        sess: {
          ...s.sessions['sess'],
          subagentIndex: { ...indexOf(entry('tZ')), ...s.sessions['sess'].subagentIndex }
        }
      }
    }))
    requestSubagentTranscript('sess', 'tZ')
    expect(g.started.at(-1)).toBe('agent-tZ')
    expect(session().backgroundLoad).not.toBeNull()
    await g.finish('tZ')
    await flush()
    expect(session().subagentMessages['tZ']).toBeDefined()
    expect(session().backgroundLoad).toBeNull()
  })
})

describe('cancel on navigate-away, restart on return', () => {
  it('stops starting fetches when the session is deactivated; in-flight ones still land; a return fetches only what is missing', async () => {
    const g = gateBuckets()
    loadSessionStatusLine.mockResolvedValue(STATUS)
    openSession(
      indexOf(
        entry('tA', { order: 4 }),
        entry('tB', { order: 3 }),
        entry('tC', { order: 2 }),
        entry('tD', { order: 1 })
      )
    )
    activate()
    expect(g.started).toEqual(['agent-tA', 'agent-tB'])

    activate(null) // the user navigated away
    await g.finish('tA')
    await g.finish('tB')
    // The in-flight results landed; nothing new was started for the inactive session.
    expect(g.started).toEqual(['agent-tA', 'agent-tB'])
    expect(Object.keys(session().subagentMessages).sort()).toEqual(['tA', 'tB'])

    activate('sess')
    // Restarted for exactly what is still missing.
    expect(g.started.slice(2)).toEqual(['agent-tC', 'agent-tD'])
    await g.finish('tC')
    await g.finish('tD')
    await flush()
    expect(session().backgroundLoad).toBeNull()
  })

  it('a deactivated job does not draw over the bar of the job that replaced it', async () => {
    const g = gateBuckets()
    loadSessionStatusLine.mockReturnValue(new Promise(() => {})) // never lands: the label stays put
    openSession(indexOf(entry('tA'), entry('tB', { order: 0 }), entry('tC', { order: 0 })))
    activate()
    activate(null)
    activate('sess') // job 2 plans all three again while job 1's tA is still in flight
    const before = session().backgroundLoad
    expect(before?.label).toBe('Loading usage and 3 subagents · 0%')

    await g.finish('tA') // job 1's fetch settles (and fills the bucket)
    expect(session().subagentMessages['tA']).toBeDefined()
    // Job 1 must not have rewritten the bar: it would carry ITS plan and fraction.
    expect(session().backgroundLoad?.label).toBe(before?.label)
  })
})

describe("the generation guard (R4) and the fills' own guards (R1, R3)", () => {
  it('a status line that lands after a reload (new generation) is dropped; the new job lands its own', async () => {
    const first = deferred<unknown>()
    const second = deferred<unknown>()
    loadSessionStatusLine.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    loadSubagentHistory.mockResolvedValue([])
    openSession(indexOf())
    activate()
    const generation = session().backgroundGeneration

    // The same transcript is committed again (an idle re-click): the plan restarts.
    useSessionStore.getState().beginTranscriptLoad(INFO)
    openSession(indexOf())
    expect(session().backgroundGeneration).toBeGreaterThan(generation)
    expect(loadSessionStatusLine).toHaveBeenCalledTimes(2)

    first.resolve(STATUS) // the OLD plan's reading
    await flush()
    expect(session().statusLine).toBeNull()
    expect(session().backgroundLoad?.statusPending).toBe(true)

    second.resolve(STATUS_B)
    await flush()
    expect(session().statusLine).toBe(STATUS_B)
    expect(session().backgroundLoad).toBeNull()
  })

  it('an eviction drops the index and the bar and bumps the generation; a late bucket writes nothing', async () => {
    const g = gateBuckets()
    loadSessionStatusLine.mockResolvedValue(STATUS)
    openSession(indexOf(entry('tA')))
    activate()
    const generation = session().backgroundGeneration

    // The session is cold-evicted (the user opened ten others): view patch + replica strip.
    useSessionStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        sess: { ...s.sessions['sess'], ...evictedViewPatch(s.sessions['sess']) }
      }
    }))
    evictLocalSessions(['sess'])
    expect(session().subagentIndex).toBeNull()
    expect(session().backgroundLoad).toBeNull()
    expect(session().backgroundGeneration).toBeGreaterThan(generation)

    await g.finish('tA')
    await flush()
    expect(getReplicaState().sessions['sess'].subagentMessages).toEqual({})
    expect(session().subagentMessages).toEqual({})
  })

  it('R1: neither fill writes onto an entry that no longer holds its transcript', () => {
    openSession(indexOf(entry('tA')))
    evictLocalSessions(['sess']) // seeded: false, no messages
    expect(fillSubagentBucket('sess', 'tA', [message('late')])).toBe(false)
    expect(replaceStatusLine('sess', STATUS)).toBe(false)
    expect(getReplicaState().sessions['sess'].subagentMessages).toEqual({})
    expect(getReplicaState().sessions['sess'].statusLine).toBeNull()
    // An unknown session is a no-op too.
    expect(fillSubagentBucket('nope', 'tA', [message('x')])).toBe(false)
    expect(replaceStatusLine('nope', STATUS)).toBe(false)
  })

  it('fills are fill-only for buckets, replace for the status line, and drop a live status line', () => {
    openSession(indexOf(entry('tA')))
    expect(fillSubagentBucket('sess', 'tA', [message('first')])).toBe(true)
    // A bucket that holds anything is never overwritten (a live agent's events win).
    expect(fillSubagentBucket('sess', 'tA', [message('second')])).toBe(false)
    expect(session().subagentMessages['tA'].map((m) => m.id)).toEqual(['first'])
    expect(fillSubagentBucket('sess', 'tB', [])).toBe(false)

    expect(replaceStatusLine('sess', STATUS)).toBe(true)
    expect(replaceStatusLine('sess', STATUS_B)).toBe(true)
    expect(session().statusLine).toBe(STATUS_B)

    patchLocalSession('sess', { sdkActive: true })
    expect(replaceStatusLine('sess', STATUS)).toBe(false)
    expect(session().statusLine).toBe(STATUS_B)
  })
})

describe('failures', () => {
  it('retries a fetch once when the remote client timed out, then lands it', async () => {
    loadSessionStatusLine.mockResolvedValue(STATUS)
    loadSubagentHistory
      .mockRejectedValueOnce(new Error('Timeout: session:load-subagent-history'))
      .mockResolvedValueOnce([message('b')])
    openSession(indexOf(entry('tA')))
    activate()
    await flush()
    expect(loadSubagentHistory).toHaveBeenCalledTimes(2)
    expect(session().subagentMessages['tA'].map((m) => m.id)).toEqual(['b'])
  })

  it('any other failure is not retried: the transcript is given up on (index entry zeroed) and the job still finishes', async () => {
    loadSessionStatusLine.mockResolvedValue(STATUS)
    loadSubagentHistory.mockRejectedValue(new Error('disk gone'))
    openSession(indexOf(entry('tA')))
    activate()
    await flush()
    expect(loadSubagentHistory).toHaveBeenCalledTimes(1)
    expect(session().subagentMessages['tA']).toBeUndefined()
    expect(session().subagentIndex?.['tA'].bytes).toBe(0)
    expect(session().backgroundLoad).toBeNull()
  })

  it('a failed status line clears the wait instead of spinning forever', async () => {
    loadSessionStatusLine.mockRejectedValue(new Error('boom'))
    openSession(indexOf())
    activate()
    await flush()
    expect(session().statusLine).toBeNull()
    expect(session().backgroundLoad).toBeNull()
  })

  it('an empty read gives the bucket up too, so the card stops waiting', async () => {
    loadSessionStatusLine.mockResolvedValue(STATUS)
    loadSubagentHistory.mockResolvedValue([])
    openSession(indexOf(entry('tA')))
    activate()
    await flush()
    expect(session().subagentIndex?.['tA'].bytes).toBe(0)
  })
})

describe('the bar (C5)', () => {
  it('a job that is upgraded from an on-demand fetch to the whole background phase never moves the bar back', async () => {
    const g = gateBuckets()
    loadSessionStatusLine.mockReturnValue(new Promise(() => {}))
    openSession(indexOf(entry('tA'), entry('tB')))
    // Two cards asked for their buckets before the session was activated: a demand-only job.
    requestSubagentTranscript('sess', 'tA')
    requestSubagentTranscript('sess', 'tB')
    await g.finish('tA')
    const half = session().backgroundLoad!.fraction
    expect(half).toBeCloseTo(0.5)

    // Activation adds the status pass (1000 bytes) to the plan: the share done shrinks.
    activate()
    expect(session().backgroundLoad!.fraction).toBeGreaterThanOrEqual(half)
    expect(session().backgroundLoad?.statusPending).toBe(true)
  })

  it('is planned up front, monotonic, labelled, and cleared when the work is done', async () => {
    const seen: BackgroundLoadView[] = []
    const unsubscribe = useSessionStore.subscribe((s) => {
      const bar = s.sessions['sess']?.backgroundLoad
      if (bar && seen.at(-1) !== bar) seen.push(bar)
    })
    const g = gateBuckets()
    let reportStatus: (p: InvokeProgress) => void = () => {}
    const status = deferred<unknown>()
    loadSessionStatusLine.mockImplementation(
      (_id: string, _key: string, cb: (p: InvokeProgress) => void) => {
        reportStatus = cb
        return status.promise
      }
    )
    // statusBytes 1000 + 3 buckets of 100 = a planned total of 1300.
    openSession(
      indexOf(entry('tA', { order: 3 }), entry('tB', { order: 2 }), entry('tC', { order: 1 }))
    )
    activate()

    expect(session().backgroundLoad).toMatchObject({ fraction: 0, statusPending: true })
    expect(session().backgroundLoad?.label).toBe('Loading usage and 3 subagents · 0%')

    reportStatus({ done: 500, total: 1000, phase: 'costs' }) // half of the status share
    expect(session().backgroundLoad!.fraction).toBeCloseTo(500 / 1300)
    status.resolve(STATUS)
    await flush()
    expect(session().backgroundLoad!.fraction).toBeCloseTo(1000 / 1300)
    expect(session().backgroundLoad).toMatchObject({ statusPending: false })
    expect(session().backgroundLoad?.label).toBe('Loading 3 subagents · 76%')

    await g.finish('tA')
    expect(session().backgroundLoad!.fraction).toBeCloseTo(1100 / 1300)
    await g.finish('tB')
    await g.finish('tC')
    await flush()
    expect(session().backgroundLoad).toBeNull()

    const fractions = seen.map((b) => b.fraction)
    for (let i = 1; i < fractions.length; i++)
      expect(fractions[i]).toBeGreaterThanOrEqual(fractions[i - 1])
    expect(Math.max(...fractions)).toBeLessThanOrEqual(1)
    unsubscribe()
  })
})

/**
 * ADR-102 — the load's progress aggregation, its bounded subagent fan-out, and the
 * sidebar click's registration as THE load in flight for a session (R2).
 *
 * `window.api` is faked down to the history calls; the store and replica are real.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ChatMessage, SessionInfo } from '../../../../shared/types'
import type { InvokeProgress } from '../../../../shared/remote-protocol'
import { useSessionStore } from '../../stores/session-store'
import {
  awaitReloadBeforeSpawn,
  awaitTranscriptReload,
  beginTranscriptPlaceholder,
  isTranscriptLoadInFlight,
  loadClickedSession,
  loadSessionIntoStore,
  reloadActiveTranscript,
  resetHistoryLoadForTests
} from '../session-history-load'
import type { TranscriptLoadProgress } from '../transcript-load-progress'
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

const claudeResult = (over: Record<string, unknown> = {}): unknown => ({
  messages: [message('m1')],
  taskNotifications: [],
  customTitle: null,
  agentIdToToolUseId: {},
  statusLine: null,
  warnings: [],
  ...over
})

const loadSessionHistory = vi.fn()
const loadSubagentHistory = vi.fn()
const loadOpencodeHistory = vi.fn()

beforeEach(() => {
  resetReplicaSeam()
  loadSessionHistory.mockReset()
  loadSubagentHistory.mockReset()
  loadOpencodeHistory.mockReset()
  ;(globalThis as unknown as { window: { api: unknown } }).window = {
    api: {
      loadSessionHistory,
      loadSubagentHistory,
      loadOpencodeHistory,
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
})

afterEach(() => {
  resetHistoryLoadForTests()
})

describe('loadSessionIntoStore — progress', () => {
  it('without onProgress the Claude read is the plain two-argument call (no callback leaks)', async () => {
    loadSessionHistory.mockResolvedValue(claudeResult())
    await loadSessionIntoStore(INFO, { isCurrent: () => true })
    expect(loadSessionHistory).toHaveBeenCalledWith('sess', '-p')
    expect(loadSessionHistory.mock.calls[0]).toHaveLength(2)
  })

  it('aggregates history frames and subagent fetches into one monotonic fraction ending at 1 before the commit', async () => {
    const reports: TranscriptLoadProgress[] = []
    let atCommit: TranscriptLoadProgress | undefined
    loadSessionHistory.mockImplementation(
      async (_id: string, _key: string, _at: unknown, cb: (p: InvokeProgress) => void) => {
        cb({ done: 0, total: 1000, phase: 'transcript' })
        cb({ done: 300, total: 1000, phase: 'transcript' })
        cb({ done: 600, total: 1000, phase: 'costs' })
        cb({ done: 600, total: 1000, phase: 'sending' })
        return claudeResult({
          agentIdToToolUseId: { a1: 't1', a2: 't2' },
          subagentFileBytes: { a1: 250, a2: 150 }
        })
      }
    )
    loadSubagentHistory.mockImplementation(async () => [message('sub')])
    const original = store().loadHistoricalSession
    useSessionStore.setState({
      loadHistoricalSession: (...args: Parameters<typeof original>) => {
        atCommit = reports.at(-1)
        original(...args)
      }
    })

    const result = await loadSessionIntoStore(INFO, {
      isCurrent: () => true,
      onProgress: (p) => reports.push(p)
    })

    expect(result).toBe('loaded')
    const fractions = reports.map((p) => p.fraction)
    expect(fractions[0]).toBeNull() // announced before the first frame
    const known = fractions.filter((f): f is number => f !== null)
    for (let i = 1; i < known.length; i++) expect(known[i]).toBeGreaterThanOrEqual(known[i - 1])
    expect(reports.map((p) => p.phase)).toContain('receiving')
    expect(reports.map((p) => p.phase)).toContain('subagents')
    expect(reports.some((p) => p.phase === 'subagents' && p.subagents === 2)).toBe(true)
    // 600 from the read + 250 + 150 from the fetches = the planned 1000.
    expect(atCommit).toMatchObject({ fraction: 1, doneBytes: 1000, totalBytes: 1000 })
    expect(store().sessions['sess'].messages.map((m) => m.id)).toEqual(['m1'])
  })

  it('stays indeterminate when the server sends no progress (old server)', async () => {
    const reports: TranscriptLoadProgress[] = []
    loadSessionHistory.mockResolvedValue(
      claudeResult({ agentIdToToolUseId: { a1: 't1' }, subagentFileBytes: { a1: 99 } })
    )
    loadSubagentHistory.mockResolvedValue([message('sub')])
    await loadSessionIntoStore(INFO, { isCurrent: () => true, onProgress: (p) => reports.push(p) })
    expect(reports.length).toBeGreaterThan(0)
    expect(reports.every((p) => p.fraction === null && p.totalBytes === null)).toBe(true)
  })

  it('a non-Claude engine reports one indeterminate frame', async () => {
    const reports: TranscriptLoadProgress[] = []
    loadOpencodeHistory.mockResolvedValue({ messages: [message('o1')], statusLine: null })
    await loadSessionIntoStore(
      { ...INFO, engineId: 'opencode' },
      { isCurrent: () => true, onProgress: (p) => reports.push(p) }
    )
    expect(reports).toEqual([
      {
        fraction: null,
        phase: 'reading',
        doneBytes: 0,
        totalBytes: null,
        etaMs: null,
        subagents: null
      }
    ])
  })

  it('a superseded load reports nothing further and commits nothing', async () => {
    const reports: TranscriptLoadProgress[] = []
    let current = true
    loadSessionHistory.mockImplementation(
      async (_id: string, _key: string, _at: unknown, cb: (p: InvokeProgress) => void) => {
        cb({ done: 0, total: 100, phase: 'transcript' })
        current = false // the user clicked elsewhere
        cb({ done: 50, total: 100, phase: 'costs' })
        return claudeResult()
      }
    )
    const result = await loadSessionIntoStore(INFO, {
      isCurrent: () => current,
      onProgress: (p) => reports.push(p)
    })
    expect(result).toBe('skipped')
    expect(reports.every((p) => (p.doneBytes ?? 0) === 0)).toBe(true)
    expect(store().sessions['sess']).toBeUndefined()
  })

  it('fetches subagents at most 4 at a time, largest file first, missing sizes last', async () => {
    const agents: Record<string, string> = {}
    const sizes: Record<string, number> = {}
    for (let i = 0; i < 10; i++) {
      agents[`a${i}`] = `t${i}`
      // a0 is smallest ... a8 largest; a9 has no file on disk (no size).
      if (i < 9) sizes[`a${i}`] = (i + 1) * 100
    }
    loadSessionHistory.mockResolvedValue(
      claudeResult({ agentIdToToolUseId: agents, subagentFileBytes: sizes })
    )
    let inFlight = 0
    let peak = 0
    const started: string[] = []
    const gates: Array<Deferred<ChatMessage[]>> = []
    loadSubagentHistory.mockImplementation(async (_s: string, _k: string, agentId: string) => {
      started.push(agentId)
      inFlight++
      peak = Math.max(peak, inFlight)
      const gate = deferred<ChatMessage[]>()
      gates.push(gate)
      const msgs = await gate.promise
      inFlight--
      return msgs
    })

    const done = loadSessionIntoStore(INFO, { isCurrent: () => true })
    await vi.waitFor(() => expect(started.length).toBe(4))
    // The first wave is the four largest.
    expect(started).toEqual(['a8', 'a7', 'a6', 'a5'])
    // Finish one at a time; each completion admits exactly one more.
    for (let finished = 0; finished < 10; finished++) {
      await vi.waitFor(() => expect(gates.length).toBeGreaterThan(finished))
      gates[finished].resolve([message(`s${finished}`)])
      await Promise.resolve()
    }
    await done
    expect(peak).toBe(4)
    expect(started).toEqual(['a8', 'a7', 'a6', 'a5', 'a4', 'a3', 'a2', 'a1', 'a0', 'a9'])
  })

  it('lifts the bar to 100% before the commit even when the fetched sizes fall short of the plan', async () => {
    const reports: TranscriptLoadProgress[] = []
    let atCommit: TranscriptLoadProgress | undefined
    loadSessionHistory.mockImplementation(
      async (_id: string, _key: string, _at: unknown, cb: (p: InvokeProgress) => void) => {
        cb({ done: 0, total: 1000, phase: 'transcript' })
        cb({ done: 600, total: 1000, phase: 'costs' })
        // The plan counted 400 bytes of subagent files; only 100 are fetched
        // (a file listed on disk that no spawn result names).
        return claudeResult({ agentIdToToolUseId: { a1: 't1' }, subagentFileBytes: { a1: 100 } })
      }
    )
    loadSubagentHistory.mockResolvedValue([message('sub')])
    const original = store().loadHistoricalSession
    useSessionStore.setState({
      loadHistoricalSession: (...args: Parameters<typeof original>) => {
        atCommit = reports.at(-1)
        original(...args)
      }
    })
    await loadSessionIntoStore(INFO, { isCurrent: () => true, onProgress: (p) => reports.push(p) })
    const beforeFinish = reports.filter((p) => p.phase === 'subagents').at(-2)
    expect(beforeFinish!.fraction).toBeCloseTo(0.7)
    expect(atCommit).toMatchObject({ fraction: 1, doneBytes: 1000 })
  })

  it('files every subagent transcript under ITS tool_use id, whatever order the fetches finish in', async () => {
    loadSessionHistory.mockResolvedValue(
      claudeResult({
        agentIdToToolUseId: { x: 'tX', y: 'tY', z: 'tZ' },
        subagentFileBytes: { x: 1, y: 3, z: 2 }
      })
    )
    loadSubagentHistory.mockImplementation(async (_s: string, _k: string, id: string) => [
      message(`msg-${id}`)
    ])
    await loadSessionIntoStore(INFO, { isCurrent: () => true })
    const buckets = store().sessions['sess'].subagentMessages
    expect(buckets['tX'].map((m) => m.id)).toEqual(['msg-x'])
    expect(buckets['tY'].map((m) => m.id)).toEqual(['msg-y'])
    expect(buckets['tZ'].map((m) => m.id)).toEqual(['msg-z'])
  })

  it('keeps the subagent buckets keyed and complete however the fetches finish', async () => {
    loadSessionHistory.mockResolvedValue(
      claudeResult({
        agentIdToToolUseId: { small: 'tSmall', big: 'tBig', empty: 'tEmpty' },
        subagentFileBytes: { small: 1, big: 9, empty: 5 }
      })
    )
    loadSubagentHistory.mockImplementation(async (_s: string, _k: string, id: string) => {
      if (id === 'empty') return []
      if (id === 'small') throw new Error('unreadable')
      return [message('big-msg')]
    })
    await loadSessionIntoStore(INFO, { isCurrent: () => true })
    // Only a bucket with messages is kept; a failed or empty fetch leaves no key.
    expect(Object.keys(store().sessions['sess'].subagentMessages)).toEqual(['tBig'])
  })
})

describe('the click load is THE load in flight for its session (R2)', () => {
  it('registers while running, is awaitable by a send, and clears with its progress when done', async () => {
    const gate = deferred<unknown>()
    loadSessionHistory.mockImplementation(
      async (_id: string, _key: string, _at: unknown, cb: (p: InvokeProgress) => void) => {
        cb({ done: 0, total: 100, phase: 'transcript' })
        return gate.promise
      }
    )
    beginTranscriptPlaceholder(INFO)
    expect(isTranscriptLoadInFlight('sess')).toBe(false)

    const running = loadClickedSession(INFO, { isCurrent: () => true })
    expect(isTranscriptLoadInFlight('sess')).toBe(true)
    expect(awaitTranscriptReload('sess')).toBeDefined()
    await vi.waitFor(() => expect(store().sessions['sess'].transcriptLoadProgress).not.toBeNull())

    // A send from the empty placeholder waits for the load (the lazy spawn guard).
    let sendReleased = false
    const send = awaitReloadBeforeSpawn('sess').then(() => (sendReleased = true))
    await Promise.resolve()
    expect(sendReleased).toBe(false)

    gate.resolve(claudeResult())
    await running
    await send
    expect(sendReleased).toBe(true)
    expect(isTranscriptLoadInFlight('sess')).toBe(false)
    expect(store().sessions['sess'].transcriptLoadProgress).toBeNull()
    expect(store().sessions['sess'].messages.map((m) => m.id)).toEqual(['m1'])
  })

  it('a rejected read while it is still the selection flags the entry failed (Retry), never rejects', async () => {
    loadSessionHistory.mockRejectedValue(new Error('disk gone'))
    beginTranscriptPlaceholder(INFO)
    await expect(loadClickedSession(INFO, { isCurrent: () => true })).resolves.toBeUndefined()
    const entry = store().sessions['sess']
    expect(entry.transcriptLoadFailed).toBe(true)
    expect(entry.evicted).toBe(true)
    expect(entry.transcriptLoadProgress).toBeNull()
  })

  it('a superseded load is silent: no failed flag, no progress left behind, placeholder stays evicted', async () => {
    const gate = deferred<unknown>()
    let current = true
    loadSessionHistory.mockImplementation(
      async (_id: string, _key: string, _at: unknown, cb: (p: InvokeProgress) => void) => {
        cb({ done: 0, total: 100, phase: 'transcript' })
        return gate.promise
      }
    )
    beginTranscriptPlaceholder(INFO)
    const running = loadClickedSession(INFO, { isCurrent: () => current })
    await vi.waitFor(() => expect(store().sessions['sess'].transcriptLoadProgress).not.toBeNull())
    current = false
    gate.resolve(claudeResult())
    await running

    const entry = store().sessions['sess']
    expect(entry.transcriptLoadFailed).toBe(false)
    expect(entry.transcriptLoadProgress).toBeNull()
    expect(entry.evicted).toBe(true)
    expect(entry.messages).toEqual([])
  })

  it('a superseded REJECTED read is silent too', async () => {
    loadSessionHistory.mockRejectedValue(new Error('boom'))
    beginTranscriptPlaceholder(INFO)
    await loadClickedSession(INFO, { isCurrent: () => false })
    expect(store().sessions['sess'].transcriptLoadFailed).toBe(false)
  })

  it('a newer load registered for the same id keeps the entry and the progress when an older one settles', async () => {
    const first = deferred<unknown>()
    const second = deferred<unknown>()
    loadSessionHistory
      .mockImplementationOnce(async () => first.promise)
      .mockImplementationOnce(
        async (_id: string, _key: string, _at: unknown, cb: (p: InvokeProgress) => void) => {
          cb({ done: 10, total: 100, phase: 'transcript' })
          return second.promise
        }
      )
    beginTranscriptPlaceholder(INFO)
    const a = loadClickedSession(INFO, { isCurrent: () => false })
    const b = loadClickedSession(INFO, { isCurrent: () => true })
    await vi.waitFor(() => expect(store().sessions['sess'].transcriptLoadProgress).not.toBeNull())
    first.resolve(claudeResult())
    await a
    // The older load settling must not clear what the newer one is showing.
    expect(isTranscriptLoadInFlight('sess')).toBe(true)
    expect(store().sessions['sess'].transcriptLoadProgress).not.toBeNull()
    second.resolve(claudeResult())
    await b
    expect(isTranscriptLoadInFlight('sess')).toBe(false)
  })
})

describe('beginTranscriptPlaceholder — engine identity before the read (R1)', () => {
  /**
   * PRE-FIX (placeholder built before `sessionEngines` knows the engine): a pi /
   * opencode / Codex click showed a Claude entry (engine, capabilities) until the
   * read landed, and a prompt typed meanwhile would have spawned Claude.
   */
  it.each(['opencode', 'pi', 'codex'] as const)('a %s click seeds its engine first', (engineId) => {
    beginTranscriptPlaceholder({ ...INFO, engineId })
    expect(store().sessionEngines['sess']?.engineId).toBe(engineId)
    const entry = store().sessions['sess']
    expect(entry.selectedEngineId).toBe(engineId)
    expect(entry.status.engineId).toBe(engineId)
    expect(entry).toMatchObject({ evicted: true, isHistorical: true })
  })

  it('a Claude click needs no seeding', () => {
    beginTranscriptPlaceholder(INFO)
    expect(store().sessionEngines['sess']).toBeUndefined()
    expect(store().sessions['sess'].selectedEngineId).toBe('claude')
  })
})

describe('reloadActiveTranscript — progress (the Retry and post-hydrate reload)', () => {
  it('feeds the same progress to the loading view and clears it when the reload settles', async () => {
    const gate = deferred<unknown>()
    loadSessionHistory.mockImplementation(
      async (_id: string, _key: string, _at: unknown, cb: (p: InvokeProgress) => void) => {
        cb({ done: 0, total: 100, phase: 'transcript' })
        cb({ done: 25, total: 100, phase: 'transcript' })
        return gate.promise
      }
    )
    beginTranscriptPlaceholder(INFO)
    useSessionStore.setState({
      activeSessionId: 'sess',
      directories: [{ cwd: '/p', projectKey: '-p', folderName: 'p', sessions: [INFO] }] as never
    })

    const reload = reloadActiveTranscript('sess')
    await vi.waitFor(() =>
      expect(store().sessions['sess'].transcriptLoadProgress).toMatchObject({ fraction: 0.25 })
    )
    expect(isTranscriptLoadInFlight('sess')).toBe(true)

    gate.resolve(claudeResult())
    await reload
    expect(store().sessions['sess'].transcriptLoadProgress).toBeNull()
    expect(store().sessions['sess'].evicted).toBe(false)
  })
})

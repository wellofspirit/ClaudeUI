/**
 * ADR-102 — the load's progress, the content-first Claude read (Arc 2: no subagent
 * fetches, a deferred status line, the background phase left on the entry) and the
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

/**
 * The `subagentIndex` the host sends: `agentIdToToolUseId` joined with each
 * agent's file size (an agent absent from `sizes` is simply not listed).
 */
function indexOf(
  agents: Record<string, string>,
  sizes: Record<string, number>
): Record<string, { agentId: string; parentToolUseId: null; bytes: number; order: number }> {
  const index: Record<
    string,
    { agentId: string; parentToolUseId: null; bytes: number; order: number }
  > = {}
  for (const [agentId, toolUseId] of Object.entries(agents))
    if (agentId in sizes)
      index[toolUseId] = { agentId, parentToolUseId: null, bytes: sizes[agentId], order: 0 }
  return index
}

describe('loadSessionIntoStore — content-first Claude load (ADR-102 Arc 2)', () => {
  it('reads with deferStatusLine and a progress callback, whoever the caller is', async () => {
    loadSessionHistory.mockResolvedValue(claudeResult())
    await loadSessionIntoStore(INFO, { isCurrent: () => true })
    expect(loadSessionHistory).toHaveBeenCalledWith('sess', '-p', undefined, expect.any(Function), {
      deferStatusLine: true
    })
  })

  it('commits the conversation without fetching one subagent transcript', async () => {
    loadSessionHistory.mockResolvedValue(
      claudeResult({
        agentIdToToolUseId: { a1: 't1', a2: 't2' },
        subagentIndex: indexOf({ a1: 't1', a2: 't2' }, { a1: 250, a2: 150 })
      })
    )
    const result = await loadSessionIntoStore(INFO, { isCurrent: () => true })

    expect(result).toBe('loaded')
    expect(loadSubagentHistory).not.toHaveBeenCalled()
    const entry = store().sessions['sess']
    expect(entry.messages.map((m) => m.id)).toEqual(['m1'])
    expect(entry.subagentMessages).toEqual({})
    expect(entry.evicted).toBe(false)
  })

  it('leaves the background phase on the entry: the index, a pending status line, a planned byte total', async () => {
    loadSessionHistory.mockImplementation(
      async (_id: string, _key: string, _at: unknown, cb: (p: InvokeProgress) => void) => {
        cb({ done: 0, total: 1000, phase: 'transcript' })
        cb({ done: 1000, total: 1000, phase: 'transcript' })
        return claudeResult({
          subagentIndex: indexOf({ a1: 't1', a2: 't2' }, { a1: 250, a2: 150 }),
          statusLine: null
        })
      }
    )
    await loadSessionIntoStore(INFO, { isCurrent: () => true })

    const entry = store().sessions['sess']
    expect(Object.keys(entry.subagentIndex ?? {}).sort()).toEqual(['t1', 't2'])
    expect(entry.statusLine).toBeNull()
    // The status pass is planned at M (the first frame's total) + the index's bytes.
    expect(entry.backgroundLoad).toMatchObject({
      fraction: 0,
      statusPending: true,
      statusBytes: 1000 + 250 + 150
    })
  })

  it('a re-opened session keeps the status line it had until the fresh one replaces it (R3)', async () => {
    const previous = { totalCostUsd: 3, totalTokens: 9 } as never
    store().loadHistoricalSession('sess', [message('m0')], '/p', [], undefined, previous)
    expect(store().sessions['sess'].statusLine).toBe(previous)
    loadSessionHistory.mockResolvedValue(claudeResult())

    // The re-click strips the held transcript and reloads: the deferred read carries
    // no status line, and the one the entry had must survive that.
    await loadSessionIntoStore(INFO, { isCurrent: () => true, replace: true })

    expect(store().sessions['sess'].messages.map((m) => m.id)).toEqual(['m1'])
    expect(store().sessions['sess'].statusLine).toBe(previous)
    expect(store().sessions['sess'].backgroundLoad?.statusPending).toBe(true)
  })

  it('every commit gets a new generation; non-Claude commits carry no index or bar', async () => {
    loadSessionHistory.mockResolvedValue(
      claudeResult({ subagentIndex: indexOf({ a: 't' }, { a: 5 }) })
    )
    await loadSessionIntoStore(INFO, { isCurrent: () => true })
    const first = store().sessions['sess']
    await loadSessionIntoStore(INFO, { isCurrent: () => true, replace: true })
    const second = store().sessions['sess']
    expect(second.backgroundGeneration).toBeGreaterThan(first.backgroundGeneration)

    loadOpencodeHistory.mockResolvedValue({ messages: [message('o1')], statusLine: null })
    await loadSessionIntoStore(
      { ...INFO, sessionId: 'oc', engineId: 'opencode' },
      { isCurrent: () => true }
    )
    expect(store().sessions['oc'].subagentIndex).toBeNull()
    expect(store().sessions['oc'].backgroundLoad).toBeNull()
  })

  it('plans only the transcript pass: the bar is monotonic and ends at 1 before the commit', async () => {
    const reports: TranscriptLoadProgress[] = []
    let atCommit: TranscriptLoadProgress | undefined
    loadSessionHistory.mockImplementation(
      async (_id: string, _key: string, _at: unknown, cb: (p: InvokeProgress) => void) => {
        cb({ done: 0, total: 1000, phase: 'transcript' })
        cb({ done: 300, total: 1000, phase: 'transcript' })
        cb({ done: 1000, total: 1000, phase: 'transcript' })
        cb({ done: 1000, total: 1000, phase: 'sending' })
        return claudeResult()
      }
    )
    const original = store().loadHistoricalSession
    useSessionStore.setState({
      loadHistoricalSession: (...args: Parameters<typeof original>) => {
        atCommit = reports.at(-1)
        original(...args)
      }
    })

    await loadSessionIntoStore(INFO, { isCurrent: () => true, onProgress: (p) => reports.push(p) })

    const fractions = reports.map((p) => p.fraction)
    expect(fractions[0]).toBeNull() // announced before the first frame
    const known = fractions.filter((f): f is number => f !== null)
    for (let i = 1; i < known.length; i++) expect(known[i]).toBeGreaterThanOrEqual(known[i - 1])
    expect(new Set(reports.map((p) => p.phase))).toEqual(new Set(['reading', 'receiving']))
    expect(atCommit).toMatchObject({ fraction: 1, doneBytes: 1000, totalBytes: 1000 })
  })

  it('stays indeterminate when the server sends no progress', async () => {
    const reports: TranscriptLoadProgress[] = []
    loadSessionHistory.mockResolvedValue(claudeResult())
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
      { fraction: null, phase: 'reading', doneBytes: 0, totalBytes: null, etaMs: null }
    ])
  })

  it('a superseded load reports nothing further and commits nothing', async () => {
    const reports: TranscriptLoadProgress[] = []
    let current = true
    loadSessionHistory.mockImplementation(
      async (_id: string, _key: string, _at: unknown, cb: (p: InvokeProgress) => void) => {
        cb({ done: 0, total: 100, phase: 'transcript' })
        current = false // the user clicked elsewhere
        cb({ done: 50, total: 100, phase: 'transcript' })
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

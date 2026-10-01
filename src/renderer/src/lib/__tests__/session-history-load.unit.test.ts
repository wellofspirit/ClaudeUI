/**
 * The disk-reload edge cases around an evicted entry (ADR-087 §2): a click that
 * cannot read, the failed-load flag and its Retry, the in-flight reload a send waits
 * for, and a fill that live events already beat.
 *
 * The hydrate-level behaviour (what a snapshot marks and returns) lives in
 * `stores/__tests__/replica-uncarried.unit.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ChatMessage, SessionInfo } from '../../../../shared/types'
import { markViewEvicted, useSessionStore } from '../../stores/session-store'
import { patchLocalSession } from '../../stores/replica'
import {
  awaitReloadBeforeSpawn,
  awaitTranscriptReload,
  ensureTranscriptLoaded,
  finishHydrate,
  loadResumedTranscript,
  loadSessionIntoStore,
  opensResident,
  reloadActiveTranscript,
  resetHistoryLoadForTests,
  replaceOnClick
} from '../session-history-load'
import { resetReplicaSeam } from '@test/helpers/replica-seed'

const store = (): ReturnType<typeof useSessionStore.getState> => useSessionStore.getState()
const ids = (id: string): string[] => store().sessions[id].messages.map((m) => m.id)

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

const history = (...messageIds: string[]): unknown => ({
  messages: messageIds.map(message),
  taskNotifications: [],
  customTitle: null,
  agentIdToToolUseId: {},
  statusLine: null,
  warnings: []
})

const loadSessionHistory = vi.fn()
const logRelay = vi.fn()

/** An evicted entry for `sess`, listed in the directories, holding `held` messages. */
function evictedEntry(held: string[] = [], over: Record<string, unknown> = {}): void {
  patchLocalSession(
    'sess',
    { cwd: '/p', messages: held.map(message), seeded: false, ...over },
    { create: true }
  )
  markViewEvicted(['sess'])
  useSessionStore.setState({ activeSessionId: 'sess', directories: [directory()] })
}

function directory(): never {
  return { cwd: '/p', projectKey: '-p', folderName: 'p', sessions: [INFO] } as never
}

beforeEach(() => {
  resetReplicaSeam()
  loadSessionHistory.mockReset()
  logRelay.mockReset()
  ;(globalThis as unknown as { window: { api: unknown } }).window = {
    api: {
      loadSessionHistory,
      loadSubagentHistory: vi.fn(async () => []),
      loadOpencodeHistory: vi.fn(),
      saveSessionConfig: vi.fn(),
      logRelay
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

describe('a click on a LIVE evicted entry', () => {
  it('opens it with no read, so the tail is neither stamped historical nor made permanent', async () => {
    // A fill was refused: the entry holds the sender's optimistic tail, is live, and
    // is still marked evicted.
    evictedEntry(['tail-1'], { sdkActive: true })
    loadSessionHistory.mockResolvedValue(history('h1', 'h2', 'tail-1'))
    await loadResumedTranscript('sess', { resumeSessionId: 'sess' })
    loadSessionHistory.mockClear()
    expect(store().sessions['sess'].evicted).toBe(true)

    // The click: resident, nothing loads.
    expect(opensResident(store().sessions['sess'])).toBe(true)
    expect(loadSessionHistory).not.toHaveBeenCalled()
    expect(store().sessions['sess'].evicted).toBe(true)
    expect(store().sessions['sess'].isHistorical).toBe(false)

    // The engine goes idle; now a click reloads, replacing the tail.
    patchLocalSession('sess', { sdkActive: false })
    expect(opensResident(store().sessions['sess'])).toBe(false)
    const result = await loadSessionIntoStore(INFO, {
      isCurrent: () => true,
      markRecent: true,
      replace: replaceOnClick(store().sessions['sess'])
    })
    expect(result).toBe('loaded')
    expect(ids('sess')).toEqual(['h1', 'h2', 'tail-1'])
    expect(store().sessions['sess'].evicted).toBe(false)
  })

  it('classifies the other entries: held, never loaded, idle evicted', () => {
    patchLocalSession('held', { sdkActive: false }, { create: true })
    evictedEntry()
    expect(opensResident(store().sessions['held'])).toBe(true)
    expect(opensResident(undefined)).toBe(false)
    expect(opensResident(store().sessions['sess'])).toBe(false)
  })
})

describe('sidebar actions that need a transcript (auto-rename, watch toggle)', () => {
  it('use a LIVE evicted entry as it is: no read, no historical stamp, flag kept', async () => {
    // The refused-fill tail of a running session. A load here would stamp it
    // historical, clear the flag, and freeze the tail as the whole conversation.
    evictedEntry(['tail-1'], { sdkActive: true })
    // What the `session:created` observer does before the fill: the session is live.
    store().markSessionLive('sess')
    loadSessionHistory.mockResolvedValue(history('h1', 'h2', 'tail-1'))

    expect(await ensureTranscriptLoaded('sess')).toBe('resident')

    expect(loadSessionHistory).not.toHaveBeenCalled()
    expect(store().sessions['sess'].isHistorical).toBe(false)
    expect(store().sessions['sess'].evicted).toBe(true)
    expect(ids('sess')).toEqual(['tail-1'])
  })

  it('load an idle evicted entry in replace mode, through the engine-aware loader', async () => {
    evictedEntry(['tail-1'])
    loadSessionHistory.mockResolvedValue(history('h1', 'h2', 'tail-1'))

    expect(await ensureTranscriptLoaded('sess')).toBe('loaded')

    expect(ids('sess')).toEqual(['h1', 'h2', 'tail-1'])
    expect(store().sessions['sess'].evicted).toBe(false)
  })

  it('use a session that holds its transcript as it is, and report one that is not listed', async () => {
    patchLocalSession('held', { messages: [message('m')] }, { create: true })
    expect(await ensureTranscriptLoaded('held')).toBe('resident')
    expect(await ensureTranscriptLoaded('nobody')).toBe('unlisted')
    expect(loadSessionHistory).not.toHaveBeenCalled()
  })
})

describe('a declined load that a newer click superseded', () => {
  it('Codex: skipped, so the click does not navigate back to the old row', async () => {
    evictedEntry(['tail-1'])
    loadSessionHistory.mockRejectedValue(new Error('app-server down'))

    const result = await loadSessionIntoStore(
      { ...INFO, engineId: 'codex' },
      { isCurrent: () => false, replace: true }
    )

    expect(result).toBe('skipped')
  })

  it('Claude: skipped, not declined, once superseded', async () => {
    evictedEntry(['tail-1'])
    loadSessionHistory.mockRejectedValue(new Error('disk gone'))

    const result = await loadSessionIntoStore(INFO, { isCurrent: () => false, replace: true })

    expect(result).toBe('skipped')
  })
})

describe('a click whose read cannot replace a held transcript', () => {
  it('is declined (the caller still navigates) and leaves the entry evicted for the next click', async () => {
    evictedEntry(['tail-1'])
    const opencode: SessionInfo = { ...INFO, engineId: 'opencode' }
    ;(window.api as unknown as { loadOpencodeHistory: unknown }).loadOpencodeHistory = vi.fn(
      async () => Promise.reject(new Error('opencode is down'))
    )

    const result = await loadSessionIntoStore(opencode, {
      isCurrent: () => true,
      markRecent: true,
      replace: replaceOnClick(store().sessions['sess'])
    })

    // `skipped` is the only result that stops the click: `declined` opens the tail.
    expect(result).toBe('declined')
    expect(ids('sess')).toEqual(['tail-1'])
    expect(store().sessions['sess'].evicted).toBe(true)
  })

  it('an empty read over a held transcript is declined the same way', async () => {
    evictedEntry(['tail-1'])
    loadSessionHistory.mockResolvedValue(history())

    const result = await loadSessionIntoStore(INFO, {
      isCurrent: () => true,
      replace: true
    })

    expect(result).toBe('declined')
    expect(ids('sess')).toEqual(['tail-1'])
    expect(store().sessions['sess'].evicted).toBe(true)
  })

  it('a failed Codex read over a held transcript is declined, not a dead click', async () => {
    evictedEntry(['tail-1'])
    loadSessionHistory.mockRejectedValue(new Error('app-server down'))
    const onCodexError = vi.fn()

    const result = await loadSessionIntoStore(
      { ...INFO, engineId: 'codex' },
      { isCurrent: () => true, replace: true, onCodexError }
    )

    expect(result).toBe('declined')
    expect(onCodexError).toHaveBeenLastCalledWith(expect.stringContaining('Codex history'))
    expect(ids('sess')).toEqual(['tail-1'])
    expect(store().sessions['sess'].evicted).toBe(true)
  })

  it('a Claude read that rejects over a held transcript is declined and logged, not thrown', async () => {
    evictedEntry(['tail-1'])
    loadSessionHistory.mockRejectedValue(new Error('disk gone'))

    const result = await loadSessionIntoStore(INFO, { isCurrent: () => true, replace: true })

    expect(result).toBe('declined')
    expect(ids('sess')).toEqual(['tail-1'])
    expect(logRelay).toHaveBeenCalledWith(
      'warn',
      'SessionHistory',
      expect.stringContaining('disk gone')
    )
  })

  it('a Claude rejection over NOTHING held still propagates, as the click path always has', async () => {
    evictedEntry()
    loadSessionHistory.mockRejectedValue(new Error('disk gone'))
    await expect(
      loadSessionIntoStore(INFO, { isCurrent: () => true, replace: true })
    ).rejects.toThrow('disk gone')
  })

  it('a superseded load is skipped, not declined', async () => {
    evictedEntry(['tail-1'])
    loadSessionHistory.mockResolvedValue(history('d1'))
    expect(await loadSessionIntoStore(INFO, { isCurrent: () => false, replace: true })).toBe(
      'skipped'
    )
  })
})

describe('the failed-load flag', () => {
  it('is set when the session is not listed, and a retry clears it before reading', async () => {
    evictedEntry()
    useSessionStore.setState({ directories: [] })

    await reloadActiveTranscript('sess')

    expect(store().sessions['sess'].transcriptLoadFailed).toBe(true)
    expect(store().sessions['sess'].evicted).toBe(true)

    // Retry: listed now, and the read is held open — the flag is already down, so the
    // chat is back on the spinner while it waits.
    useSessionStore.setState({ directories: [directory()] })
    let release!: (value: unknown) => void
    loadSessionHistory.mockReturnValue(new Promise((resolve) => (release = resolve)))
    const retry = reloadActiveTranscript('sess')
    expect(store().sessions['sess'].transcriptLoadFailed).toBe(false)

    release(history('d1', 'd2'))
    await retry
    expect(ids('sess')).toEqual(['d1', 'd2'])
    expect(store().sessions['sess'].transcriptLoadFailed).toBe(false)
    expect(store().sessions['sess'].evicted).toBe(false)
  })

  it('is set when the read fails, and any load that lands clears it', async () => {
    evictedEntry()
    loadSessionHistory.mockRejectedValue(new Error('disk gone'))

    await reloadActiveTranscript('sess')
    expect(store().sessions['sess'].transcriptLoadFailed).toBe(true)

    // The sidebar click path, with no reload involved.
    loadSessionHistory.mockReset()
    loadSessionHistory.mockResolvedValue(history('d1'))
    await loadSessionIntoStore(INFO, { isCurrent: () => true, replace: true })
    expect(store().sessions['sess'].transcriptLoadFailed).toBe(false)
  })

  it('is not set when the session went live meanwhile', async () => {
    evictedEntry()
    let release!: (value: unknown) => void
    loadSessionHistory.mockReturnValue(new Promise((resolve) => (release = resolve)))

    const pending = reloadActiveTranscript('sess')
    patchLocalSession('sess', { sdkActive: true })
    release(history('stale'))
    await pending

    expect(store().sessions['sess'].transcriptLoadFailed).toBe(false)
  })
})

describe('a send waits for the reload in flight', () => {
  it('awaitReloadBeforeSpawn resolves only once the reload settles', async () => {
    evictedEntry()
    let release!: (value: unknown) => void
    loadSessionHistory.mockReturnValue(new Promise((resolve) => (release = resolve)))
    const reload = reloadActiveTranscript('sess')
    expect(awaitTranscriptReload('sess')).toBeDefined()

    let waited = false
    const gate = awaitReloadBeforeSpawn('sess').then(() => (waited = true))
    await Promise.resolve()
    expect(waited).toBe(false)

    release(history('h1', 'h2'))
    await gate
    await reload
    expect(waited).toBe(true)
    expect(ids('sess')).toEqual(['h1', 'h2'])
    // Cleared on settle.
    expect(awaitTranscriptReload('sess')).toBeUndefined()
  })

  it('does not wait when nothing is in flight, or the entry already holds a transcript', async () => {
    evictedEntry()
    await expect(awaitReloadBeforeSpawn('sess')).resolves.toBeUndefined()

    patchLocalSession('sess', { messages: [message('held')] })
    let release!: (value: unknown) => void
    loadSessionHistory.mockReturnValue(new Promise((resolve) => (release = resolve)))
    const reload = reloadActiveTranscript('sess')
    try {
      // A held transcript means a spawn can resume right away; the reload may be slow.
      await expect(awaitReloadBeforeSpawn('sess')).resolves.toBeUndefined()
    } finally {
      release(history('held'))
      await reload
    }
  })

  it('settles on a failed reload too, so a send is never wedged behind it', async () => {
    evictedEntry()
    loadSessionHistory.mockRejectedValue(new Error('disk gone'))
    const reload = reloadActiveTranscript('sess')
    await awaitReloadBeforeSpawn('sess')
    await reload
    expect(store().sessions['sess'].transcriptLoadFailed).toBe(true)
  })
})

describe('a fill that live events already beat', () => {
  it('keeps the entry evicted and unseeded, so the next idle click replaces the tail', async () => {
    // The sender's optimistic turn is all the live entry holds when the fill lands.
    evictedEntry(['tail-1'], { sdkActive: true })
    loadSessionHistory.mockResolvedValue(history('h1', 'h2', 'tail-1'))

    await loadResumedTranscript('sess', { resumeSessionId: 'sess' })

    expect(ids('sess')).toEqual(['tail-1'])
    expect(store().sessions['sess'].evicted).toBe(true)
    expect(store().sessions['sess'].isHistorical).toBe(false)
    // The replica does not call the tail complete.
    const { getReplicaState } = await import('../../stores/replica')
    expect(getReplicaState().sessions['sess'].seeded).toBe(false)

    // The engine goes idle; the sidebar click now replaces it from disk.
    patchLocalSession('sess', { sdkActive: false })
    expect(replaceOnClick(store().sessions['sess'])).toBe(true)
    const result = await loadSessionIntoStore(INFO, {
      isCurrent: () => true,
      markRecent: true,
      replace: replaceOnClick(store().sessions['sess'])
    })

    expect(result).toBe('loaded')
    expect(ids('sess')).toEqual(['h1', 'h2', 'tail-1'])
    expect(store().sessions['sess'].evicted).toBe(false)
  })

  it('a fill that cannot happen releases a live, empty, evicted entry from the spinner', async () => {
    evictedEntry([], { sdkActive: true })
    useSessionStore.setState({ directories: [] })

    await loadResumedTranscript('sess', { resumeSessionId: 'sess' })
    expect(store().sessions['sess'].evicted).toBe(false)

    evictedEntry([], { sdkActive: true })
    loadSessionHistory.mockRejectedValue(new Error('disk gone'))
    await loadResumedTranscript('sess', { resumeSessionId: 'sess' })
    expect(store().sessions['sess'].evicted).toBe(false)
  })

  it('but a held tail keeps its flag when the fill cannot happen', async () => {
    evictedEntry(['tail-1'], { sdkActive: true })
    loadSessionHistory.mockRejectedValue(new Error('disk gone'))

    await loadResumedTranscript('sess', { resumeSessionId: 'sess' })

    expect(store().sessions['sess'].evicted).toBe(true)
  })

  it('an applied fill clears the evicted flag', async () => {
    evictedEntry([], { sdkActive: true })
    loadSessionHistory.mockResolvedValue(history('h1', 'h2'))

    await loadResumedTranscript('sess', { resumeSessionId: 'sess' })

    expect(ids('sess')).toEqual(['h1', 'h2'])
    expect(store().sessions['sess'].evicted).toBe(false)
  })
})

describe('finishHydrate', () => {
  it('never throws, so a post-hydrate read cannot keep the app from rendering', () => {
    // A hydrate stub that returns nothing is exactly what crashed the web entry point.
    expect(() => finishHydrate(undefined as never)).not.toThrow()
    expect(logRelay).toHaveBeenCalledWith(
      'warn',
      'SessionHistory',
      expect.stringContaining('could not start')
    )
  })
})

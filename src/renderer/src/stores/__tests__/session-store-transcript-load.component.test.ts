/**
 * ADR-102 — the store half of navigate-first: the evicted loading PLACEHOLDER
 * (`beginTranscriptLoad`), the identity it must carry, the per-session progress
 * field, and `cleanupEmptySession` no longer dropping a transcript that is only
 * waiting to be read (which scrubbed the session's recents / pins / hidden /
 * custom-title rows — "a recent session disappeared").
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  EMPTY_SESSION_STATE,
  markSubagentUnavailable,
  markViewEvicted,
  setBackgroundLoad,
  setTranscriptLoadProgress,
  useSessionStore
} from '../session-store'
import type { SessionInfo } from '../../../../shared/types'
import { engineMeta } from '../../../../shared/engine-meta'
import { patchLocalSession } from '../replica'
import { seed, resetReplicaSeam } from '@test/helpers/replica-seed'

const store = (): ReturnType<typeof useSessionStore.getState> => useSessionStore.getState()

const info = (sessionId: string, engineId?: SessionInfo['engineId']): SessionInfo => ({
  sessionId,
  cwd: '/p',
  projectKey: '-p',
  title: sessionId,
  timestamp: 1,
  lastActivityAt: 1,
  ...(engineId ? { engineId } : {})
})

beforeEach(() => {
  resetReplicaSeam()
  ;(globalThis as unknown as { window: { api: unknown } }).window = {
    api: { saveSessionConfig: vi.fn(), saveSettings: vi.fn(), logError: vi.fn() }
  } as never
  useSessionStore.setState({
    activeSessionId: null,
    sessions: {},
    directories: [],
    recentSessionIds: [],
    pinnedSessionIds: [],
    hiddenSessionIds: [],
    customTitles: {},
    sessionEngines: {},
    worktreeInfoMap: {},
    defaultPermissionMode: 'default'
  })
})

describe('beginTranscriptLoad — the loading placeholder', () => {
  it('creates an evicted, historical, empty entry that renders the loading view', () => {
    store().beginTranscriptLoad(info('sess'))
    const entry = store().sessions['sess']
    expect(entry).toMatchObject({
      cwd: '/p',
      evicted: true,
      isHistorical: true,
      messages: [],
      transcriptLoadFailed: false,
      transcriptLoadProgress: null
    })
  })

  /**
   * R1. The placeholder is what a prompt typed during the load would resume, so it
   * has to carry the identity the FINISHED load gives the entry. Built from
   * `emptySession` defaults it would be a Claude session in the configured default
   * mode.
   *
   * PRE-FIX (placeholder without the shared identity block): selectedEngineId is
   * 'claude', status.engineId 'claude', permissionMode 'default'.
   */
  it('carries the persisted engine, model and bootstrap permission mode (R1)', () => {
    const model = { engineId: 'opencode' as const, vendorId: 'openrouter', modelId: 'gpt-x' }
    useSessionStore.setState({
      defaultPermissionMode: 'acceptEdits',
      sessionEngines: { oc: { engineId: 'opencode', model } }
    })
    store().beginTranscriptLoad(info('oc', 'opencode'))
    const entry = store().sessions['oc']
    expect(entry.selectedEngineId).toBe('opencode')
    expect(entry.selectedModel).toBe(engineMeta('opencode').encodeModelValue(model))
    expect(entry.status.engineId).toBe('opencode')
    expect(entry.permissionMode).toBe('acceptEdits')
  })

  it('the finished load fills the placeholder without changing its identity, and clears progress', () => {
    const model = { engineId: 'opencode' as const, vendorId: 'openrouter', modelId: 'gpt-x' }
    useSessionStore.setState({ sessionEngines: { oc: { engineId: 'opencode', model } } })
    store().beginTranscriptLoad(info('oc', 'opencode'))
    const before = store().sessions['oc']
    setTranscriptLoadProgress('oc', {
      fraction: 0.5,
      phase: 'reading',
      doneBytes: 1,
      totalBytes: 2,
      etaMs: null
    })

    store().loadHistoricalSession('oc', [], '/p')

    const after = store().sessions['oc']
    expect(after.evicted).toBe(false)
    expect(after.transcriptLoadProgress).toBeNull()
    expect(after.selectedEngineId).toBe(before.selectedEngineId)
    expect(after.selectedModel).toBe(before.selectedModel)
    expect(after.permissionMode).toBe(before.permissionMode)
  })

  it('re-marks an existing evicted entry without touching what it holds', () => {
    seed.created('sess', { cwd: '/p' })
    useSessionStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        sess: { ...s.sessions['sess'], evicted: true, draftText: 'half-typed' }
      }
    }))
    store().beginTranscriptLoad(info('sess'))
    expect(store().sessions['sess']).toMatchObject({ evicted: true, draftText: 'half-typed' })
  })

  it('never touches a live entry', () => {
    seed.created('live', { cwd: '/p' })
    patchLocalSession('live', { sdkActive: true })
    store().beginTranscriptLoad(info('live'))
    expect(store().sessions['live'].evicted).toBe(false)
    expect(store().sessions['live'].isHistorical).toBe(false)
  })
})

describe('cleanupEmptySession leaves a transcript that is only waiting to be read (C4)', () => {
  /** Every registry row a session can have; a pinned session is not also "recent". */
  function registryRows(id: string, section: 'recent' | 'pinned'): void {
    if (section === 'recent') store().addRecentSession(id)
    else store().pinSession(id)
    store().hideSession(id)
    store().setCustomTitle(id, 'my title')
  }

  function expectRowsIntact(id: string, section: 'recent' | 'pinned'): void {
    const s = store()
    expect(s.sessions[id]).toBeDefined()
    expect(section === 'recent' ? s.recentSessionIds : s.pinnedSessionIds).toContain(id)
    expect(s.hiddenSessionIds).toContain(id)
    expect(s.customTitles[id]).toBe('my title')
  }

  /**
   * PRE-FIX: the placeholder is locallyCreated, empty and idle, so switching away
   * dropped it and `forgetDroppedSession` scrubbed every row below.
   */
  it('keeps an EVICTED empty placeholder and all its registry rows across switchSession', () => {
    store().createNewSession('other', '/o', false)
    store().beginTranscriptLoad(info('sess'))
    registryRows('sess', 'recent')
    store().switchSession('sess')

    store().switchSession('other')

    expectRowsIntact('sess', 'recent')
  })

  it('keeps a PINNED empty placeholder pinned', () => {
    store().createNewSession('other', '/o', false)
    store().beginTranscriptLoad(info('sess'))
    registryRows('sess', 'pinned')
    store().switchSession('sess')

    store().switchSession('other')

    expectRowsIntact('sess', 'pinned')
  })

  /**
   * A Claude read error resolves EMPTY, so a failed load can land
   * `evicted: false, isHistorical: true` with no messages.
   *
   * PRE-FIX (evicted-only guard): dropped like a scratch session.
   */
  it('keeps an empty HISTORICAL entry that is no longer evicted', () => {
    store().createNewSession('other', '/o', false)
    store().loadHistoricalSession('sess', [], '/p')
    expect(store().sessions['sess']).toMatchObject({ evicted: false, isHistorical: true })
    registryRows('sess', 'recent')
    store().switchSession('sess')

    store().switchSession('other')

    expectRowsIntact('sess', 'recent')
  })

  it('still drops a genuinely abandoned scratch session (neither flag)', () => {
    store().createNewSession('scratch', '/a')
    store().createNewSession('other', '/o', false)
    store().switchSession('other')
    expect(store().sessions['scratch']).toBeUndefined()
  })
})

describe('transcriptLoadProgress (view-only field)', () => {
  const progress = {
    fraction: 0.25,
    phase: 'reading' as const,
    doneBytes: 1,
    totalBytes: 4,
    etaMs: null
  }

  it('defaults to null, on the template and on a fresh session', () => {
    expect(EMPTY_SESSION_STATE.transcriptLoadProgress).toBeNull()
    store().createNewSession('fresh', '/a')
    expect(store().sessions['fresh'].transcriptLoadProgress).toBeNull()
  })

  it('sets and clears per session, and ignores an unknown id', () => {
    store().beginTranscriptLoad(info('sess'))
    setTranscriptLoadProgress('sess', progress)
    expect(store().sessions['sess'].transcriptLoadProgress).toEqual(progress)
    setTranscriptLoadProgress('sess', null)
    expect(store().sessions['sess'].transcriptLoadProgress).toBeNull()

    setTranscriptLoadProgress('ghost', progress)
    expect(store().sessions['ghost']).toBeUndefined()
  })
})

/**
 * ADR-102 Arc 2 — the background phase's view state (R4). Every commit and every
 * eviction of a transcript bumps `backgroundGeneration`; the bar and the index are
 * written only against the generation they were planned in, and an eviction drops
 * both.
 */
describe('background load view state (ADR-102 Arc 2, R4)', () => {
  const entry = (bytes = 100): never =>
    ({ agentId: 'agent-x', parentToolUseId: null, bytes, order: 1 }) as never
  const bar = { fraction: 0.5, label: 'Loading usage · 50%', statusPending: true, statusBytes: 10 }
  const commit = (): void =>
    store().loadHistoricalSession('sess', [], '/p', [], undefined, null, undefined, {
      subagentIndex: { t1: entry() },
      source: { sessionId: 'sess', projectKey: '-p' },
      statusPending: true,
      statusBytes: 10
    })

  it('defaults to nothing on the template and a fresh session', () => {
    expect(EMPTY_SESSION_STATE).toMatchObject({
      subagentIndex: null,
      transcriptSource: null,
      backgroundLoad: null,
      backgroundGeneration: 0
    })
    store().createNewSession('fresh', '/a')
    expect(store().sessions['fresh']).toMatchObject({ subagentIndex: null, backgroundLoad: null })
  })

  it('a Claude commit stores the index, starts the bar pending, and bumps the generation', () => {
    store().beginTranscriptLoad(info('sess'))
    const before = store().sessions['sess'].backgroundGeneration
    commit()
    const after = store().sessions['sess']
    expect(after.subagentIndex).toEqual({ t1: entry() })
    expect(after.transcriptSource).toEqual({ sessionId: 'sess', projectKey: '-p' })
    expect(after.backgroundLoad).toEqual({
      fraction: 0,
      label: 'Loading usage',
      statusPending: true,
      statusBytes: 10
    })
    expect(after.backgroundGeneration).toBeGreaterThan(before)
  })

  it('a commit without a background phase (another engine) leaves none', () => {
    store().beginTranscriptLoad(info('sess'))
    commit()
    store().loadHistoricalSession('sess', [], '/p')
    expect(store().sessions['sess']).toMatchObject({ subagentIndex: null, backgroundLoad: null })
  })

  it('an eviction drops the index and the bar and bumps the generation', () => {
    store().beginTranscriptLoad(info('sess'))
    commit()
    const generation = store().sessions['sess'].backgroundGeneration
    markViewEvicted(['sess'])
    const evicted = store().sessions['sess']
    expect(evicted).toMatchObject({
      subagentIndex: null,
      transcriptSource: null,
      backgroundLoad: null,
      evicted: true
    })
    expect(evicted.backgroundGeneration).toBeGreaterThan(generation)
  })

  it('beginTranscriptLoad on a resident entry also retires its background phase', () => {
    store().beginTranscriptLoad(info('sess'))
    commit()
    const generation = store().sessions['sess'].backgroundGeneration
    store().beginTranscriptLoad(info('sess'))
    expect(store().sessions['sess'].subagentIndex).toBeNull()
    expect(store().sessions['sess'].backgroundGeneration).toBeGreaterThan(generation)
  })

  it('writes to the bar only against the current generation, and ignores an unknown id', () => {
    store().beginTranscriptLoad(info('sess'))
    commit()
    const generation = store().sessions['sess'].backgroundGeneration
    setBackgroundLoad('sess', generation, bar)
    expect(store().sessions['sess'].backgroundLoad).toEqual(bar)

    setBackgroundLoad('sess', generation - 1, { ...bar, fraction: 0.9 }) // a stale plan
    expect(store().sessions['sess'].backgroundLoad).toEqual(bar)
    setBackgroundLoad('sess', generation - 1, null)
    expect(store().sessions['sess'].backgroundLoad).toEqual(bar)

    setBackgroundLoad('sess', generation, null)
    expect(store().sessions['sess'].backgroundLoad).toBeNull()
    setBackgroundLoad('ghost', 0, bar)
    expect(store().sessions['ghost']).toBeUndefined()
  })

  it('markSubagentUnavailable zeroes one entry, only against the current generation', () => {
    store().beginTranscriptLoad(info('sess'))
    commit()
    const generation = store().sessions['sess'].backgroundGeneration
    markSubagentUnavailable('sess', generation - 1, 't1')
    expect(store().sessions['sess'].subagentIndex?.['t1'].bytes).toBe(100)
    markSubagentUnavailable('sess', generation, 'unlisted')
    markSubagentUnavailable('sess', generation, 't1')
    expect(store().sessions['sess'].subagentIndex?.['t1']).toMatchObject({
      bytes: 0,
      agentId: 'agent-x'
    })
    // The generation is untouched: other fetches planned against it still land.
    expect(store().sessions['sess'].backgroundGeneration).toBe(generation)
  })
})

/**
 * ADR-105 §5 — a reopened parent keeps the running X-Agent records the ledger gave it. The
 * read is authoritative for them: a reload that finds the row finished carries none, and the
 * stale record (its end missed in a gap, or a read that raced the event) must go with it.
 */
describe('loadHistoricalSession — dispatch records', () => {
  const running = {
    'tu-x': { taskId: 'ledger-1', taskType: 'dispatch', isBackgrounded: true, wakesParent: true }
  }
  const call = (activeTasks?: typeof running): void =>
    store().loadHistoricalSession(
      'sess',
      [],
      '/p',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      activeTasks
    )

  it('seeds the running record the read returned', () => {
    call(running)
    expect(store().sessions['sess'].activeTasks).toEqual(running)
  })

  it('a replace reload that finds the row finished clears the stale running record', () => {
    call(running)
    call(undefined)
    expect(store().sessions['sess'].activeTasks).toEqual({})
  })
})

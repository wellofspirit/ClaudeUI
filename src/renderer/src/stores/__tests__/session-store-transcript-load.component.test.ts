/**
 * ADR-102 — the store half of navigate-first: the evicted loading PLACEHOLDER
 * (`beginTranscriptLoad`), the identity it must carry, the per-session progress
 * field, and `cleanupEmptySession` no longer dropping a transcript that is only
 * waiting to be read (which scrubbed the session's recents / pins / hidden /
 * custom-title rows — "a recent session disappeared").
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EMPTY_SESSION_STATE, setTranscriptLoadProgress, useSessionStore } from '../session-store'
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
      etaMs: null,
      subagents: null
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
    etaMs: null,
    subagents: null
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

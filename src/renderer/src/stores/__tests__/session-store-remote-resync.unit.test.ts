/**
 * Mobile/remote reconnect regression (mobile-picker-bug).
 *
 * Every reconnect from a web/remote client re-applies a `sync-full` snapshot
 * built from the DESKTOP renderer's Zustand state. Applying it unconditionally
 * (a) replaces the whole `sessions` map — dropping mobile-hydrated historical
 * sessions the desktop snapshot never saw — and (b) overwrites
 * `activeSessionId` with the desktop's, so the mobile client jumps back to
 * whatever the desktop happens to be looking at (or to welcome/wrong-engine)
 * after backgrounding/returning.
 *
 * `applyRemoteSnapshot(snapshot, isResync)` fixes this: `isResync` is falsy on
 * first hydration (snapshot wins wholesale, unchanged), and true on every
 * subsequent sync-full, where the local `activeSessionId` and any local-only
 * session entries are preserved.
 *
 * Covers:
 * - initial hydration (no isResync arg) adopts the snapshot's activeSessionId
 *   + sessions wholesale (existing-behavior lock).
 * - re-sync with local activeSessionId=X present in the snapshot: keeps X,
 *   refreshes its session data from the snapshot.
 * - re-sync where X is local-only (mobile-hydrated, absent from the
 *   snapshot): keeps X and its local session entry (messages included).
 * - re-sync where X is absent from BOTH local and the snapshot: falls back to
 *   the snapshot's activeSessionId rather than rendering a broken view.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSessionStore } from '../session-store'
import { resetFactoryCounter, makeUserMessage } from '@test/factories/messages'
import type { FullStateSnapshot } from '../../../../shared/remote-protocol'

const store = () => useSessionStore.getState()

function baseSnapshotSession(routingId: string): FullStateSnapshot['sessions'][string] {
  return {
    routingId,
    cwd: '/test',
    messages: [],
    streamingText: '',
    streamingThinking: '',
    status: {
      state: 'idle',
      sessionId: null,
      model: null,
      cwd: null,
      totalCostUsd: 0,
      engineId: 'claude',
      capabilities: {} as any,
      account: null
    },
    pendingApprovals: [],
    todos: [],
    taskNotifications: [],
    taskProgressMap: {},
    subagentMessages: {},
    subagentStreamingText: {},
    subagentStreamingThinking: {},
    permissionMode: 'default',
    effort: 'medium',
    thinkingMode: 'adaptive',
    reasoningVariant: null,
    statusLine: null,
    slashCommands: [],
    sdkSkillNames: []
  }
}

function makeSnapshot(
  sessions: Record<string, FullStateSnapshot['sessions'][string]>,
  activeSessionId: string | null
): FullStateSnapshot {
  return {
    seq: 1,
    sessions,
    directories: [],
    activeSessionId,
    settings: {},
    recentSessionIds: [],
    pinnedSessionIds: [],
    customTitles: {},
    worktreeInfoMap: {}
  }
}

beforeEach(() => {
  resetFactoryCounter()
  ;(globalThis as any).window = globalThis.window || {}
  ;(globalThis as any).window.api = {
    saveSessionConfig: vi.fn(),
    saveSettings: vi.fn(),
    logError: vi.fn()
  } as any

  useSessionStore.setState({
    activeSessionId: null,
    sessions: {},
    recentSessionIds: [],
    pinnedSessionIds: [],
    customTitles: {},
    worktreeInfoMap: {},
    hiddenSessionIds: [],
    hiddenProjectKeys: [],
    sessionEngines: {},
    availableModels: []
  })
})

describe('applyRemoteSnapshot — first hydration (isResync falsy)', () => {
  it('adopts the snapshot activeSessionId + sessions wholesale', () => {
    // Local store already has an (irrelevant, pre-connect) session — first
    // hydration must still stomp it, matching today's behavior.
    store().createNewSession('local-stale', '/stale')
    useSessionStore.setState({ activeSessionId: 'local-stale' })

    const snapshot = makeSnapshot({ 'desktop-active': baseSnapshotSession('desktop-active') }, 'desktop-active')
    store().applyRemoteSnapshot(snapshot)

    expect(store().activeSessionId).toBe('desktop-active')
    expect(store().sessions['desktop-active']).toBeDefined()
    expect(store().sessions['local-stale']).toBeUndefined()
  })
})

describe('applyRemoteSnapshot — re-sync (isResync=true)', () => {
  it('keeps local activeSessionId=X when X is present in the snapshot, refreshing its data', () => {
    store().createNewSession('X', '/test')
    useSessionStore.setState({ activeSessionId: 'X' })

    const refreshedX = { ...baseSnapshotSession('X'), effort: 'high' as const }
    const snapshot = makeSnapshot(
      { X: refreshedX, 'desktop-active': baseSnapshotSession('desktop-active') },
      'desktop-active'
    )
    store().applyRemoteSnapshot(snapshot, true)

    expect(store().activeSessionId).toBe('X')
    // Session data refreshed from the snapshot.
    expect(store().sessions['X'].effort).toBe('high')
    // The desktop's other session is merged in too.
    expect(store().sessions['desktop-active']).toBeDefined()
  })

  it('keeps local-only activeSessionId=X (mobile-hydrated) and its transcript entry', () => {
    store().createNewSession('X', '/mobile-only')
    const msg = makeUserMessage('hello from mobile history')
    useSessionStore.setState((s) => ({
      activeSessionId: 'X',
      sessions: { ...s.sessions, X: { ...s.sessions['X'], messages: [msg] } }
    }))

    // The desktop snapshot has no idea 'X' exists — it's only in the snapshot
    // via a different active session.
    const snapshot = makeSnapshot({ 'desktop-active': baseSnapshotSession('desktop-active') }, 'desktop-active')
    store().applyRemoteSnapshot(snapshot, true)

    expect(store().activeSessionId).toBe('X')
    expect(store().sessions['X']).toBeDefined()
    expect(store().sessions['X'].messages).toEqual([msg])
    // useActiveSession must not fall to EMPTY_SESSION_STATE.
    const active = store().sessions[store().activeSessionId as string]
    expect(active).not.toBeUndefined()
    // The desktop's session is merged in as well.
    expect(store().sessions['desktop-active']).toBeDefined()
  })

  it('falls back to the snapshot activeSessionId when X vanished from both maps', () => {
    // No local session named 'X' at all, and activeSessionId already points
    // at a dead id (e.g. evicted between backgrounding and reconnect).
    useSessionStore.setState({ activeSessionId: 'X', sessions: {} })

    const snapshot = makeSnapshot({ 'desktop-active': baseSnapshotSession('desktop-active') }, 'desktop-active')
    store().applyRemoteSnapshot(snapshot, true)

    expect(store().activeSessionId).toBe('desktop-active')
    expect(store().sessions['desktop-active']).toBeDefined()
  })

  it('adopts the snapshot activeSessionId when local activeSessionId is null', () => {
    useSessionStore.setState({ activeSessionId: null, sessions: {} })

    const snapshot = makeSnapshot({ 'desktop-active': baseSnapshotSession('desktop-active') }, 'desktop-active')
    store().applyRemoteSnapshot(snapshot, true)

    expect(store().activeSessionId).toBe('desktop-active')
  })
})

describe('applyRemoteSnapshot — sentFiles (Files widget) round-trip', () => {
  it('hydrates sentFiles from the snapshot', () => {
    const snap = {
      ...baseSnapshotSession('S'),
      sentFiles: [{ path: 'out/report.html', toolUseId: 'tu-1', caption: 'the report' }]
    }
    store().applyRemoteSnapshot(makeSnapshot({ S: snap }, 'S'))
    expect(store().sessions['S'].sentFiles).toEqual([
      { path: 'out/report.html', toolUseId: 'tu-1', caption: 'the report' }
    ])
  })

  it('falls back to [] when an older remote server omits sentFiles', () => {
    store().applyRemoteSnapshot(makeSnapshot({ S: baseSnapshotSession('S') }, 'S'))
    expect(store().sessions['S'].sentFiles).toEqual([])
  })
})

describe('applyRemoteSnapshot — new-session default mode (ADR-050)', () => {
  // The web client never runs hydrateConfigFromDisk: the snapshot IS its
  // hydration, so the fields hydrate derives from settings must be derived here
  // too. Pre-fix the remote store kept the initial 'default' forever — no mode
  // tab on the welcome input, and sessions CREATED from the remote client
  // spawned without the auto default.
  it('derives defaultPermissionMode from synced settings.defaultAutonomyMode', () => {
    store().applyRemoteSnapshot({
      ...makeSnapshot({}, null),
      settings: { defaultAutonomyMode: 'full' }
    })
    expect(store().defaultPermissionMode).toBe('auto')
  })

  it('an older host that omits the key still yields the shipped auto default', () => {
    // {...DEFAULT_SETTINGS, ...snapshot.settings} fills the gap.
    store().applyRemoteSnapshot(makeSnapshot({}, null))
    expect(store().defaultPermissionMode).toBe('auto')
  })

  it('respects a pinned non-auto pick from the host', () => {
    store().applyRemoteSnapshot({
      ...makeSnapshot({}, null),
      settings: { defaultAutonomyMode: 'ask' }
    })
    expect(store().defaultPermissionMode).toBe('default')
  })

  it('hydrates the host-derived disableAutoMode gate', () => {
    store().applyRemoteSnapshot({
      ...makeSnapshot({}, null),
      autoModeDisabledBySettings: true
    })
    expect(store().autoModeDisabledBySettings).toBe(true)
    // ...and an older host omitting it reads as "not disabled".
    store().applyRemoteSnapshot(makeSnapshot({}, null))
    expect(store().autoModeDisabledBySettings).toBe(false)
  })
})

/**
 * Component tests for session-store Zustand actions.
 * Tests the store's state machine directly — no React rendering required.
 *
 * Pattern: arrange store state → call action → assert resulting state.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useSessionStore, OPENCODE_DEFAULT_MODEL, PI_DEFAULT_MODEL } from '../session-store'
import { claudeModel } from '../../../../shared/types'
import {
  resolveClaudeCapabilities,
  resolveOpencodeCapabilities,
  resolvePiCapabilities
} from '../../../../shared/model-capabilities'
import {
  makeChatMessage,
  makeAssistantMessage,
  makeToolUseBlock,
  makeTaskNotification,
  makeSessionStatus,
  resetFactoryCounter
} from '@test/factories/messages'
import type {
  DiffComment,
  PlanComment,
  WorktreeInfo,
  GitStatusData,
  ModelInfo
} from '../../../../shared/types'
import { engineMeta } from '../../../../shared/engine-meta'
import {
  seed,
  seedSession,
  resetReplicaSeam,
  mirrorStoreIntoReplica
} from '@test/helpers/replica-seed'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const store = () => useSessionStore.getState()

function makeGitStatus(overrides?: Partial<GitStatusData>): GitStatusData {
  return {
    branch: 'main',
    ahead: 0,
    behind: 0,
    trackingBranch: 'origin/main',
    files: [],
    staged: [],
    unstaged: [],
    untracked: [],
    linesAdded: 0,
    linesRemoved: 0,
    ...overrides
  }
}

function makeDiffComment(overrides?: Partial<DiffComment>): DiffComment {
  return {
    id: `comment-${Date.now()}-${Math.random()}`,
    filePath: 'src/foo.ts',
    lineNumber: 10,
    endLineNumber: 10,
    side: 'new',
    lineContent: 'const x = 1',
    comment: 'Consider renaming',
    createdAt: Date.now(),
    ...overrides
  }
}

function makePlanComment(overrides?: Partial<PlanComment>): PlanComment {
  return {
    id: `plan-comment-${Date.now()}-${Math.random()}`,
    selectedText: 'some plan text',
    lineNumber: 5,
    endLineNumber: 5,
    sectionIndex: 0,
    comment: 'Looks good',
    createdAt: Date.now(),
    ...overrides
  }
}

function makeWorktreeInfo(overrides?: Partial<WorktreeInfo>): WorktreeInfo {
  return {
    worktreePath: '/tmp/worktrees/feature-branch',
    worktreeBranch: 'feature/test',
    worktreeName: 'feature-branch',
    originalCwd: '/test',
    gitRoot: '/test',
    originalHeadCommit: 'abc123',
    createdAt: Date.now(),
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  // The replica is a module singleton holding canonical state: resetting only the
  // store would leave the two disagreeing and the next projection would resurrect
  // the previous test's sessions (SyncCore phase 4c).
  resetReplicaSeam()
  resetFactoryCounter()
  ;(globalThis as any).window = globalThis.window || {}
  ;(globalThis as any).window.api = {
    saveSessionConfig: vi.fn(),
    saveSlashCommands: vi.fn(),
    saveSettings: vi.fn(),
    logError: vi.fn(),
    killTerminal: vi.fn(),
    watchBackground: vi.fn(),
    unwatchBackground: vi.fn(),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    deleteProject: vi.fn().mockResolvedValue(undefined)
  } as any

  useSessionStore.setState({
    activeSessionId: null,
    sessions: {},
    directories: [],
    recentSessionIds: [],
    pinnedSessionIds: [],
    customTitles: {},
    worktreeInfoMap: {},
    hiddenSessionIds: [],
    hiddenProjectKeys: [],
    terminalGroups: {}
  })
  mirrorStoreIntoReplica()
})

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

describe('createNewSession', () => {
  it('creates a new session with the given cwd', () => {
    store().createNewSession('r1', '/test/project')
    expect(store().sessions['r1']).toBeDefined()
    expect(store().sessions['r1'].cwd).toBe('/test/project')
  })

  it('prepends routingId to recentSessionIds', () => {
    store().createNewSession('r1', '/a')
    store().createNewSession('r2', '/b')
    expect(store().recentSessionIds[0]).toBe('r2')
    expect(store().recentSessionIds[1]).toBe('r1')
  })

  it('deduplicates recentSessionIds when same id re-created', () => {
    store().createNewSession('r1', '/a')
    store().createNewSession('r2', '/b')
    store().createNewSession('r1', '/a')
    const recents = store().recentSessionIds
    expect(recents.filter((id) => id === 'r1')).toHaveLength(1)
    expect(recents[0]).toBe('r1')
  })

  it('caps recentSessionIds at maxRecentSessions (default 5)', () => {
    for (let i = 1; i <= 7; i++) {
      store().createNewSession(`r${i}`, `/path/${i}`)
    }
    expect(store().recentSessionIds.length).toBeLessThanOrEqual(5)
  })

  it('sets activeSessionId when switchTo is true (default)', () => {
    store().createNewSession('r1', '/test')
    expect(store().activeSessionId).toBe('r1')
  })

  it('does not set activeSessionId when switchTo is false', () => {
    store().createNewSession('r1', '/test', false)
    expect(store().activeSessionId).toBeNull()
  })

  it('sets activeView to chat when switchTo is true', () => {
    store().createNewSession('r1', '/test')
    expect(store().activeView).toEqual({ type: 'chat' })
  })
})

describe('switchSession', () => {
  it('sets activeSessionId to the given routingId', () => {
    store().createNewSession('r1', '/a')
    store().createNewSession('r2', '/b', false)
    store().switchSession('r2')
    expect(store().activeSessionId).toBe('r2')
  })

  it('clears needsAttention on target session', () => {
    store().createNewSession('r1', '/a')
    store().createNewSession('r2', '/b', false)
    store().setNeedsAttention('r2', true)
    store().switchSession('r2')
    expect(store().sessions['r2'].needsAttention).toBe(false)
  })

  it('sets activeView to chat', () => {
    store().createNewSession('r1', '/a')
    useSessionStore.setState({ activeView: { type: 'usage' } })
    store().switchSession('r1')
    expect(store().activeView).toEqual({ type: 'chat' })
  })

  it('cleans up empty current session before switching', () => {
    store().createNewSession('r1', '/a') // active, no messages
    store().createNewSession('r2', '/b', false)
    store().switchSession('r2')
    // r1 had no messages so it should be pruned
    expect(store().sessions['r1']).toBeUndefined()
    expect(store().recentSessionIds).not.toContain('r1')
  })

  /**
   * R6. "Empty" is a local judgement and it does not distinguish an abandoned
   * scratch session from a REAL host session that was cancelled before its first
   * prompt. Dropping the second kind threw away state the host still had — and
   * post-F7 the host's later events for it are honest no-ops, so it never came
   * back; the session was simply gone from this client until the next sync-full.
   *
   * PRE-FIX: `sessions['host-known']` is undefined after the switch.
   */
  it('never cleans up a session the HOST introduced, however empty it looks', () => {
    // Born from the wire, not from createNewSession — then cancelled before any
    // prompt, so it is empty and `sdkActive: false`, exactly like a scratch one.
    seed.created('host-known', { cwd: '/a' })
    seed.status('host-known', makeSessionStatus({ state: 'disconnected' }))
    useSessionStore.setState({ activeSessionId: 'host-known' })
    store().createNewSession('r2', '/b', false)

    store().switchSession('r2')

    expect(store().sessions['host-known']).toBeDefined()
  })

  it('preserves current session when it has messages', () => {
    store().createNewSession('r1', '/a')
    seed.userMessage('r1', { id: 'msg-1', prompt: 'hello' })
    store().createNewSession('r2', '/b', false)
    store().switchSession('r2')
    expect(store().sessions['r1']).toBeDefined()
  })
})

describe('showWelcome', () => {
  it('sets activeSessionId to null', () => {
    store().createNewSession('r1', '/a')
    store().showWelcome()
    expect(store().activeSessionId).toBeNull()
  })

  it('cleans up empty current session', () => {
    store().createNewSession('r1', '/a') // no messages
    store().showWelcome()
    expect(store().sessions['r1']).toBeUndefined()
    expect(store().recentSessionIds).not.toContain('r1')
  })

  it('preserves session with messages when returning to welcome', () => {
    store().createNewSession('r1', '/a')
    seed.userMessage('r1', { id: 'msg-1', prompt: 'hi' })
    store().showWelcome()
    expect(store().sessions['r1']).toBeDefined()
  })
})

describe('loadHistoricalSession', () => {
  it('loads messages into session with isHistorical: true', () => {
    const messages = [makeAssistantMessage('Hello')]
    store().loadHistoricalSession('r1', messages, '/project')
    const session = store().sessions['r1']
    expect(session).toBeDefined()
    expect(session.isHistorical).toBe(true)
    expect(session.messages).toHaveLength(1)
    expect(session.cwd).toBe('/project')
  })

  it('loads taskNotifications when provided', () => {
    const notifications = [makeTaskNotification({ status: 'completed' })]
    store().loadHistoricalSession('r1', [], '/project', notifications)
    expect(store().sessions['r1'].taskNotifications).toHaveLength(1)
  })

  it('loads subagentMessages when provided', () => {
    const subMsg = makeChatMessage({ role: 'assistant' })
    store().loadHistoricalSession('r1', [], '/project', [], { 'tool-1': [subMsg] })
    expect(store().sessions['r1'].subagentMessages['tool-1']).toHaveLength(1)
  })

  it('loads statusLine when provided', () => {
    const statusLine = { text: 'Ready', color: 'green' }
    store().loadHistoricalSession('r1', [], '/project', [], {}, statusLine as any)
    expect(store().sessions['r1'].statusLine).toEqual(statusLine)
  })

  it('sets empty arrays when optional params omitted', () => {
    store().loadHistoricalSession('r1', [], '/project')
    expect(store().sessions['r1'].taskNotifications).toEqual([])
    expect(store().sessions['r1'].subagentMessages).toEqual({})
    expect(store().sessions['r1'].statusLine).toBeNull()
  })
})

describe('forkFromMessage', () => {
  it('seeds a branch with messages 1..N, sets forkOrigin, and switches to it', async () => {
    const messages = [
      makeChatMessage({ id: 'u1' }),
      makeAssistantMessage('first', { id: 'msg_1' }),
      makeChatMessage({ id: 'u2' }),
      makeAssistantMessage('second', { id: 'msg_2' })
    ]
    store().loadHistoricalSession('src-session', messages, '/proj')
    ;(window.api as any).resolveForkAnchor = vi.fn().mockResolvedValue({ anchorUuid: 'anchor-1' })

    const newId = await store().forkFromMessage('src-session', 'msg_1')

    expect(newId).toBeTruthy()
    // idx=1 ('msg_1' is the SECOND message, index 1) + engineId — threaded
    // through for pi's position-based resolver (Claude's resolver ignores both).
    expect(window.api.resolveForkAnchor).toHaveBeenCalledWith(
      'src-session',
      '/proj',
      'msg_1',
      'claude',
      1
    )
    const branch = store().sessions[newId!]
    expect(branch.messages.map((m) => m.id)).toEqual(['u1', 'msg_1'])
    expect(branch.forkOrigin).toEqual({ sourceSessionId: 'src-session', anchorUuid: 'anchor-1' })
    expect(branch.cwd).toBe('/proj')
    expect(store().activeSessionId).toBe(newId)
    // Source session is left untouched.
    expect(store().sessions['src-session'].messages).toHaveLength(4)
  })

  it('deep-copies sliced messages so the branch and source do not alias', async () => {
    const messages = [makeAssistantMessage('only', { id: 'msg_1' })]
    store().loadHistoricalSession('src-session', messages, '/proj')
    ;(window.api as any).resolveForkAnchor = vi.fn().mockResolvedValue({ anchorUuid: 'a1' })

    const newId = await store().forkFromMessage('src-session', 'msg_1')
    const branch = store().sessions[newId!]
    expect(branch.messages[0]).not.toBe(store().sessions['src-session'].messages[0])
    expect(branch.messages[0].content).not.toBe(store().sessions['src-session'].messages[0].content)
  })

  it('returns null and records an error when the anchor cannot be resolved', async () => {
    store().loadHistoricalSession(
      'src-session',
      [makeAssistantMessage('x', { id: 'msg_1' })],
      '/proj'
    )
    ;(window.api as any).resolveForkAnchor = vi
      .fn()
      .mockResolvedValue({ anchorUuid: null, reason: 'message-not-found' })

    const newId = await store().forkFromMessage('src-session', 'msg_1')

    expect(newId).toBeNull()
    expect(store().sessions['src-session'].errors.length).toBeGreaterThan(0)
    // No branch was created or switched to.
    expect(store().activeSessionId).toBeNull()
  })

  it('uses status.sessionId as the source id for a rekeyed live session', async () => {
    store().loadHistoricalSession(
      'routing-temp',
      [makeAssistantMessage('x', { id: 'msg_1' })],
      '/proj'
    )
    useSessionStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        'routing-temp': {
          ...s.sessions['routing-temp'],
          status: makeSessionStatus({ sessionId: 'real-sid' })
        }
      }
    }))
    mirrorStoreIntoReplica()
    ;(window.api as any).resolveForkAnchor = vi.fn().mockResolvedValue({ anchorUuid: 'a1' })

    await store().forkFromMessage('routing-temp', 'msg_1')
    expect(window.api.resolveForkAnchor).toHaveBeenCalledWith(
      'real-sid',
      '/proj',
      'msg_1',
      'claude',
      0
    )
  })

  it('threads engineId + the message index through for pi (position-based resolution)', async () => {
    store().loadHistoricalSession(
      'pi-src-session',
      [
        makeChatMessage({ id: 'u1' }),
        makeAssistantMessage('first', { id: 'a1' }),
        makeChatMessage({ id: 'u2' }),
        makeAssistantMessage('second', { id: 'a2' })
      ],
      '/proj'
    )
    useSessionStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        'pi-src-session': {
          ...s.sessions['pi-src-session'],
          status: makeSessionStatus({ engineId: 'pi', capabilities: resolvePiCapabilities() })
        }
      }
    }))
    mirrorStoreIntoReplica()
    const anchorSpy = vi.fn().mockResolvedValue({ anchorUuid: 'pi:clone-latest' })
    ;(window.api as any).resolveForkAnchor = anchorSpy

    const newId = await store().forkFromMessage('pi-src-session', 'a2')

    expect(newId).toBeTruthy()
    // 'a2' is the LAST message (index 3) — the resolver receives that index,
    // not a re-derivation of it, so the store's own idx computation and the
    // wire call agree on the same number.
    expect(anchorSpy).toHaveBeenCalledWith('pi-src-session', '/proj', 'a2', 'pi', 3)
    expect(store().sessions[newId!].forkOrigin).toEqual({
      sourceSessionId: 'pi-src-session',
      anchorUuid: 'pi:clone-latest'
    })
  })

  it('returns null when the source session does not exist', async () => {
    const newId = await store().forkFromMessage('nope', 'msg_1')
    expect(newId).toBeNull()
  })

  it('returns null + records an error and does NOT resolve an anchor when the engine lacks forkFromMessage', async () => {
    store().loadHistoricalSession(
      'src-session',
      [makeAssistantMessage('x', { id: 'msg_1' })],
      '/proj'
    )
    useSessionStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        'src-session': {
          ...s.sessions['src-session'],
          status: makeSessionStatus({
            engineId: 'opencode',
            capabilities: resolveOpencodeCapabilities()
          })
        }
      }
    }))
    mirrorStoreIntoReplica()
    const anchorSpy = vi.fn()
    ;(window.api as any).resolveForkAnchor = anchorSpy

    const newId = await store().forkFromMessage('src-session', 'msg_1')

    expect(newId).toBeNull()
    expect(anchorSpy).not.toHaveBeenCalled()
    expect(store().sessions['src-session'].errors.length).toBeGreaterThan(0)
  })
})

describe('rekeySession', () => {
  it('renames the session key in sessions', () => {
    store().createNewSession('old-id', '/test')
    seed.rekey('old-id', 'new-id')
    expect(store().sessions['new-id']).toBeDefined()
    expect(store().sessions['old-id']).toBeUndefined()
  })

  it('updates activeSessionId when rekeying active session', () => {
    store().createNewSession('old-id', '/test')
    expect(store().activeSessionId).toBe('old-id')
    seed.rekey('old-id', 'new-id')
    expect(store().activeSessionId).toBe('new-id')
  })

  it('updates recentSessionIds', () => {
    store().createNewSession('old-id', '/test')
    seed.rekey('old-id', 'new-id')
    expect(store().recentSessionIds).toContain('new-id')
    expect(store().recentSessionIds).not.toContain('old-id')
  })

  it('updates pinnedSessionIds', () => {
    store().createNewSession('old-id', '/test')
    store().pinSession('old-id')
    seed.rekey('old-id', 'new-id')
    expect(store().pinnedSessionIds).toContain('new-id')
    expect(store().pinnedSessionIds).not.toContain('old-id')
  })

  it('migrates customTitles to new id', () => {
    store().createNewSession('old-id', '/test')
    store().setCustomTitle('old-id', 'My Session')
    seed.rekey('old-id', 'new-id')
    expect(store().customTitles['new-id']).toBe('My Session')
    expect(store().customTitles['old-id']).toBeUndefined()
  })

  it('migrates worktreeInfoMap to new id', () => {
    store().createNewSession('old-id', '/test')
    useSessionStore.setState({
      worktreeInfoMap: { 'old-id': makeWorktreeInfo() }
    })
    mirrorStoreIntoReplica()
    seed.rekey('old-id', 'new-id')
    expect(store().worktreeInfoMap['new-id']).toBeDefined()
    expect(store().worktreeInfoMap['old-id']).toBeUndefined()
  })

  it('is a no-op when oldId === newId', () => {
    store().createNewSession('r1', '/test')
    const before = store().sessions['r1']
    seed.rekey('r1', 'r1')
    // `rekeyCanonical` returns the state untouched for an identical id. The STATUS
    // the seed carries still applies (that is the event), so compare the fields a
    // rekey would have moved rather than the whole entry.
    expect(Object.keys(store().sessions)).toEqual(['r1'])
    expect(store().sessions['r1'].messages).toBe(before.messages)
    expect(store().sessions['r1'].cwd).toBe(before.cwd)
  })

  it('is a no-op when old session does not exist', () => {
    seed.rekey('ghost', 'new-id')
    expect(store().sessions['new-id']).toBeUndefined()
  })
})

describe('pinSession', () => {
  it('moves session from recents to pinned', () => {
    store().createNewSession('r1', '/test')
    expect(store().recentSessionIds).toContain('r1')
    store().pinSession('r1')
    expect(store().pinnedSessionIds).toContain('r1')
    expect(store().recentSessionIds).not.toContain('r1')
  })

  it('is a no-op when session is already pinned', () => {
    store().createNewSession('r1', '/test')
    store().pinSession('r1')
    const pinnedBefore = [...store().pinnedSessionIds]
    store().pinSession('r1')
    expect(store().pinnedSessionIds).toEqual(pinnedBefore)
  })
})

describe('unpinSession', () => {
  it('moves session from pinned to recents', () => {
    store().createNewSession('r1', '/test')
    store().pinSession('r1')
    store().unpinSession('r1')
    expect(store().pinnedSessionIds).not.toContain('r1')
    expect(store().recentSessionIds).toContain('r1')
  })

  it('prepends to recents when unpinned', () => {
    store().createNewSession('r1', '/a')
    store().createNewSession('r2', '/b')
    store().pinSession('r1')
    store().unpinSession('r1')
    expect(store().recentSessionIds[0]).toBe('r1')
  })
})

// ---------------------------------------------------------------------------
// Hide / unhide
// ---------------------------------------------------------------------------

describe('hideSession', () => {
  it('adds sessionId to hiddenSessionIds', () => {
    store().hideSession('s1')
    expect(store().hiddenSessionIds).toEqual(['s1'])
  })

  it('is a no-op when session is already hidden', () => {
    store().hideSession('s1')
    store().hideSession('s1')
    expect(store().hiddenSessionIds).toEqual(['s1'])
  })

  it('persists hidden set via saveSessionConfig', () => {
    const save = window.api.saveSessionConfig as any
    store().hideSession('s1')
    expect(save).toHaveBeenCalled()
    const lastCall = save.mock.calls.at(-1)![0]
    expect(lastCall.hiddenSessions).toEqual(['s1'])
  })
})

describe('unhideSession', () => {
  it('removes sessionId from hiddenSessionIds', () => {
    store().hideSession('s1')
    store().hideSession('s2')
    store().unhideSession('s1')
    expect(store().hiddenSessionIds).toEqual(['s2'])
  })

  it('is a no-op when session is not hidden', () => {
    store().hideSession('s1')
    const before = store().hiddenSessionIds
    store().unhideSession('ghost')
    expect(store().hiddenSessionIds).toBe(before)
  })
})

describe('hideProject / unhideProject', () => {
  it('adds and removes projectKey', () => {
    store().hideProject('proj-a')
    store().hideProject('proj-b')
    expect(store().hiddenProjectKeys).toEqual(['proj-a', 'proj-b'])
    store().unhideProject('proj-a')
    expect(store().hiddenProjectKeys).toEqual(['proj-b'])
  })

  it('ignores empty projectKey', () => {
    store().hideProject('')
    expect(store().hiddenProjectKeys).toEqual([])
  })

  it('is a no-op on duplicate hide', () => {
    store().hideProject('proj-a')
    store().hideProject('proj-a')
    expect(store().hiddenProjectKeys).toEqual(['proj-a'])
  })
})

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

describe('deleteSession', () => {
  it('invokes window.api.deleteSession with sessionId + projectKey (+ optional engineId)', async () => {
    const spy = window.api.deleteSession as any
    // No engineId (legacy / claude path) — undefined is forwarded
    await store().deleteSession('s1', 'proj-key')
    expect(spy).toHaveBeenCalledWith('s1', 'proj-key', undefined)
    // With engineId
    spy.mockClear()
    await store().deleteSession('s2', 'proj-key', 'opencode')
    expect(spy).toHaveBeenCalledWith('s2', 'proj-key', 'opencode')
  })

  it('scrubs session from recent, pinned, hidden, customTitles, worktreeInfoMap', async () => {
    store().createNewSession('s1', '/test') // adds to recent
    store().pinSession('s1') // moves to pinned
    store().setCustomTitle('s1', 'My Title')
    store().hideSession('s1')
    const wt = makeWorktreeInfo()
    store().setWorktreeInfo('s1', wt)

    await store().deleteSession('s1', 'proj-key')

    expect(store().pinnedSessionIds).not.toContain('s1')
    expect(store().recentSessionIds).not.toContain('s1')
    expect(store().hiddenSessionIds).not.toContain('s1')
    expect(store().customTitles['s1']).toBeUndefined()
    expect(store().worktreeInfoMap['s1']).toBeUndefined()
  })

  it('leaves other sessions untouched', async () => {
    store().createNewSession('s1', '/a')
    store().createNewSession('s2', '/b')
    await store().deleteSession('s1', 'proj-key')
    expect(store().sessions['s2']).toBeDefined()
    expect(store().recentSessionIds).toContain('s2')
  })

  it('purges the session from in-memory sessions, directories, and activeSessionId', async () => {
    store().createNewSession('s1', '/a')
    store().createNewSession('s2', '/a')
    // Set state after createNewSession to avoid cleanupEmptySession side-effects from switchSession
    useSessionStore.setState({
      activeSessionId: 's1',
      directories: [
        {
          cwd: '/a',
          projectKey: 'proj-key',
          folderName: 'a',
          sessions: [
            {
              sessionId: 's1',
              cwd: '/a',
              projectKey: 'proj-key',
              title: 'x',
              timestamp: 0,
              lastActivityAt: 0
            },
            {
              sessionId: 's2',
              cwd: '/a',
              projectKey: 'proj-key',
              title: 'y',
              timestamp: 0,
              lastActivityAt: 0
            }
          ]
        }
      ]
    })
    mirrorStoreIntoReplica()

    await store().deleteSession('s1', 'proj-key')

    expect(store().sessions['s1']).toBeUndefined()
    expect(store().sessions['s2']).toBeDefined()
    expect(store().activeSessionId).toBeNull()
    expect(store().directories[0].sessions.map((s) => s.sessionId)).toEqual(['s2'])
  })

  it('drops an empty directory group after deleting its last session', async () => {
    useSessionStore.setState({
      directories: [
        {
          cwd: '/a',
          projectKey: 'proj-key',
          folderName: 'a',
          sessions: [
            {
              sessionId: 's1',
              cwd: '/a',
              projectKey: 'proj-key',
              title: 'x',
              timestamp: 0,
              lastActivityAt: 0
            }
          ]
        }
      ]
    })
    mirrorStoreIntoReplica()

    await store().deleteSession('s1', 'proj-key')

    expect(store().directories).toEqual([])
  })

  // RN8 — the persisted engine/model row is keyed by routingId; without an
  // explicit delete it outlived every session and grew the config forever.
  it('drops the sessionEngines row and persists the pruned map', async () => {
    store().createNewSession('s1', '/test')
    store().createNewSession('s2', '/test')
    expect(store().sessionEngines['s1']).toBeDefined()
    ;(window.api.saveSessionConfig as any).mockClear()

    await store().deleteSession('s1', 'proj-key')

    expect(store().sessionEngines['s1']).toBeUndefined()
    expect(store().sessionEngines['s2']).toBeDefined() // sibling untouched
    const persisted = (window.api.saveSessionConfig as any).mock.calls.at(-1)[0]
    expect(persisted.sessionEngines['s1']).toBeUndefined()
    expect(persisted.sessionEngines['s2']).toBeDefined()
  })

  it('does not mutate store when the IPC call rejects', async () => {
    ;(window.api.deleteSession as any).mockRejectedValueOnce(new Error('EBUSY'))
    store().createNewSession('s1', '/a')
    store().pinSession('s1')
    const pinnedBefore = [...store().pinnedSessionIds]

    await expect(store().deleteSession('s1', 'proj-key')).rejects.toThrow('EBUSY')
    expect(store().pinnedSessionIds).toEqual(pinnedBefore)
  })
})

describe('deleteProject', () => {
  it('invokes window.api.deleteProject with projectKey', async () => {
    const spy = window.api.deleteProject as any
    await store().deleteProject('proj-key')
    expect(spy).toHaveBeenCalledWith('proj-key')
  })

  it('scrubs all project sessions from recent/pinned/hidden/customTitles and removes the project from hiddenProjects', async () => {
    // Seed directories so the store knows which sessions belong to this project
    useSessionStore.setState({
      directories: [
        {
          cwd: '/test',
          projectKey: 'proj-key',
          folderName: 'test',
          sessions: [
            {
              sessionId: 's1',
              cwd: '/test',
              projectKey: 'proj-key',
              title: 'a',
              timestamp: 0,
              lastActivityAt: 0
            },
            {
              sessionId: 's2',
              cwd: '/test',
              projectKey: 'proj-key',
              title: 'b',
              timestamp: 0,
              lastActivityAt: 0
            }
          ]
        },
        {
          cwd: '/other',
          projectKey: 'other-key',
          folderName: 'other',
          sessions: [
            {
              sessionId: 's3',
              cwd: '/other',
              projectKey: 'other-key',
              title: 'c',
              timestamp: 0,
              lastActivityAt: 0
            }
          ]
        }
      ]
    })
    mirrorStoreIntoReplica()
    store().createNewSession('s1', '/test')
    store().createNewSession('s2', '/test')
    store().createNewSession('s3', '/other')
    store().pinSession('s1')
    store().setCustomTitle('s2', 'Title')
    store().hideSession('s2')
    store().hideProject('proj-key')

    await store().deleteProject('proj-key')

    expect(store().pinnedSessionIds).not.toContain('s1')
    expect(store().recentSessionIds).not.toContain('s1')
    expect(store().recentSessionIds).not.toContain('s2')
    expect(store().hiddenSessionIds).not.toContain('s2')
    expect(store().customTitles['s2']).toBeUndefined()
    expect(store().hiddenProjectKeys).not.toContain('proj-key')
    // Unrelated project untouched
    expect(store().recentSessionIds).toContain('s3')
  })

  it('removes the project directory group and in-memory sessions so the sidebar purges', async () => {
    store().createNewSession('s1', '/test')
    store().createNewSession('s2', '/test') // in-memory-only session in same cwd
    store().createNewSession('s3', '/other')
    useSessionStore.setState({
      activeSessionId: 's1',
      directories: [
        {
          cwd: '/test',
          projectKey: 'proj-key',
          folderName: 'test',
          sessions: [
            {
              sessionId: 's1',
              cwd: '/test',
              projectKey: 'proj-key',
              title: 'a',
              timestamp: 0,
              lastActivityAt: 0
            }
          ]
        },
        {
          cwd: '/other',
          projectKey: 'other-key',
          folderName: 'other',
          sessions: [
            {
              sessionId: 's3',
              cwd: '/other',
              projectKey: 'other-key',
              title: 'c',
              timestamp: 0,
              lastActivityAt: 0
            }
          ]
        }
      ]
    })
    mirrorStoreIntoReplica()

    await store().deleteProject('proj-key')

    // Directory group gone
    expect(store().directories.map((g) => g.projectKey)).toEqual(['other-key'])
    // Both on-disk and in-memory-only sessions for that cwd purged
    expect(store().sessions['s1']).toBeUndefined()
    expect(store().sessions['s2']).toBeUndefined()
    // Unrelated session preserved
    expect(store().sessions['s3']).toBeDefined()
    // Active session cleared since it was inside the deleted project
    expect(store().activeSessionId).toBeNull()
  })

  // RN8 — same as deleteSession, for every routingId the project takes with it.
  it('drops the sessionEngines rows for every purged session and persists the pruned map', async () => {
    store().createNewSession('s1', '/test')
    store().createNewSession('s2', '/test') // in-memory-only, same cwd
    store().createNewSession('s3', '/other')
    useSessionStore.setState({
      directories: [
        {
          cwd: '/test',
          projectKey: 'proj-key',
          folderName: 'test',
          sessions: [
            {
              sessionId: 's1',
              cwd: '/test',
              projectKey: 'proj-key',
              title: 'a',
              timestamp: 0,
              lastActivityAt: 0
            }
          ]
        }
      ]
    })
    mirrorStoreIntoReplica()
    ;(window.api.saveSessionConfig as any).mockClear()

    await store().deleteProject('proj-key')

    expect(store().sessionEngines['s1']).toBeUndefined()
    expect(store().sessionEngines['s2']).toBeUndefined()
    expect(store().sessionEngines['s3']).toBeDefined() // other project untouched
    const persisted = (window.api.saveSessionConfig as any).mock.calls.at(-1)[0]
    expect(persisted.sessionEngines['s1']).toBeUndefined()
    expect(persisted.sessionEngines['s2']).toBeUndefined()
    expect(persisted.sessionEngines['s3']).toBeDefined()
  })

  it('keeps activeSessionId when the active session is not inside the deleted project', async () => {
    store().createNewSession('s1', '/test')
    store().createNewSession('s3', '/other')
    useSessionStore.setState({
      activeSessionId: 's3',
      directories: [
        {
          cwd: '/test',
          projectKey: 'proj-key',
          folderName: 'test',
          sessions: [
            {
              sessionId: 's1',
              cwd: '/test',
              projectKey: 'proj-key',
              title: 'a',
              timestamp: 0,
              lastActivityAt: 0
            }
          ]
        }
      ]
    })
    mirrorStoreIntoReplica()

    await store().deleteProject('proj-key')

    expect(store().activeSessionId).toBe('s3')
  })

  it('does not mutate store when the IPC call rejects', async () => {
    ;(window.api.deleteProject as any).mockRejectedValueOnce(new Error('EACCES'))
    useSessionStore.setState({
      directories: [
        {
          cwd: '/test',
          projectKey: 'proj-key',
          folderName: 'test',
          sessions: [
            {
              sessionId: 's1',
              cwd: '/test',
              projectKey: 'proj-key',
              title: 'a',
              timestamp: 0,
              lastActivityAt: 0
            }
          ]
        }
      ]
    })
    mirrorStoreIntoReplica()
    store().createNewSession('s1', '/test')
    const recentBefore = [...store().recentSessionIds]

    await expect(store().deleteProject('proj-key')).rejects.toThrow('EACCES')
    expect(store().recentSessionIds).toEqual(recentBefore)
  })
})

// ---------------------------------------------------------------------------
// Message / queue actions
// ---------------------------------------------------------------------------

describe('setQueueState', () => {
  it('creates a user message from a consumed item and drops it from the card', () => {
    store().createNewSession('r1', '/test')
    seed.queue('r1', [{ itemId: 'q1', text: 'queued prompt', state: 'queued' }])
    seed.queue('r1', [{ itemId: 'q1', text: 'queued prompt', state: 'consumed' }])
    const session = store().sessions['r1']
    expect(session.messages).toHaveLength(1)
    expect(session.messages[0].id).toBe('steer-q1')
    expect(session.messages[0].role).toBe('user')
    expect(session.messages[0].content[0]).toMatchObject({ type: 'text', text: 'queued prompt' })
    expect(session.queuedItems).toEqual([])
  })

  it('is a no-op when the payload holds nothing consumed', () => {
    store().createNewSession('r1', '/test')
    seed.queue('r1', [])
    expect(store().sessions['r1'].messages).toHaveLength(0)
  })

  it('is a no-op when session does not exist', () => {
    expect(() =>
      seed.queue('ghost', [{ itemId: 'q1', text: 'x', state: 'consumed' }])
    ).not.toThrow()
  })
})

describe('session:user-message (the reducer builds the transcript row)', () => {
  // `addUserMessage` is DELETED. The row is the reducer's — identity included, so
  // every replica agrees on the id (SyncCore phase 4b) — and the attachment
  // ordering these tests pin lives in `shared/sync/reducer.ts`'s
  // `buildUserContentBlocks`.
  //
  // Two assertions did NOT move here, deliberately:
  //  - `planContent`: no channel carries it, and nothing has minted a local user
  //    message since the ExitPlanMode flow started relaying through the server.
  //  - the `recentSessionIds` bump: a SIDE EFFECT of the row arriving, so it is a
  //    post-apply observer in useClaudeEvents and is pinned by that hook's test.
  beforeEach(() => {
    store().createNewSession('r1', '/test')
  })

  it('places image attachments before text', () => {
    seed.userMessage('r1', {
      id: 'u1',
      prompt: 'look at this',
      attachments: [{ mediaType: 'image/png', base64Data: 'AAA', fileName: 'shot.png' }]
    })
    const content = store().sessions['r1'].messages[0].content
    expect(content[0].type).toBe('image')
    expect(content[1].type).toBe('text')
  })

  it('places PDF attachments as document blocks before text', () => {
    seed.userMessage('r1', {
      id: 'u1',
      prompt: 'read this',
      attachments: [{ mediaType: 'application/pdf', base64Data: 'AAA', fileName: 'doc.pdf' }]
    })
    const content = store().sessions['r1'].messages[0].content
    expect(content[0].type).toBe('document')
    expect(content[1].type).toBe('text')
  })

  it('uses the id the emitter minted, so a resync cannot renumber the transcript', () => {
    seed.userMessage('r1', { id: 'msg-from-emitter', timestamp: 42, prompt: 'hi' })
    const msg = store().sessions['r1'].messages[0]
    expect(msg.id).toBe('msg-from-emitter')
    expect(msg.timestamp).toBe(42)
  })
})

describe('removePendingApproval', () => {
  it('removes the approval matching the requestId', () => {
    store().createNewSession('r1', '/test')
    seed.approvalRequest('r1', { requestId: 'req-1', toolName: 'Bash', input: {} })
    seed.approvalRequest('r1', { requestId: 'req-2', toolName: 'Read', input: {} })
    seed.approvalDismiss('r1', 'req-1')
    const approvals = store().sessions['r1'].pendingApprovals
    expect(approvals).toHaveLength(1)
    expect(approvals[0].requestId).toBe('req-2')
  })

  it('leaves approvals unchanged when requestId not found', () => {
    store().createNewSession('r1', '/test')
    seed.approvalRequest('r1', { requestId: 'req-1', toolName: 'Bash', input: {} })
    seed.approvalDismiss('r1', 'ghost-req')
    expect(store().sessions['r1'].pendingApprovals).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Task / subagent actions
// ---------------------------------------------------------------------------

// setTaskStarted / activeTasks (Async-agent Stop-button regression):
// Claude 2.1.219+ makes Agent/Task background-by-default and the tool_use
// input usually omits run_in_background, so TaskCard can no longer infer
// running-vs-complete from tool input alone. task_started/task_notification
// are the authoritative signals — this is the store-level state machine
// behind that fix.
describe('setTaskStarted', () => {
  it('records an activeTasks entry keyed by toolUseId', () => {
    store().createNewSession('r1', '/test')
    seed.taskStarted('r1', { toolUseId: 'tool-1', taskId: 'task-abc', taskType: 'local_agent' })
    expect(store().sessions['r1'].activeTasks['tool-1']).toEqual({
      taskId: 'task-abc',
      taskType: 'local_agent'
    })
  })

  it('does not affect other in-flight tasks', () => {
    store().createNewSession('r1', '/test')
    seed.taskStarted('r1', { toolUseId: 'tool-1', taskId: 'task-a', taskType: 'local_agent' })
    seed.taskStarted('r1', { toolUseId: 'tool-2', taskId: 'task-b', taskType: 'local_bash' })
    expect(store().sessions['r1'].activeTasks['tool-1']).toEqual({
      taskId: 'task-a',
      taskType: 'local_agent'
    })
    expect(store().sessions['r1'].activeTasks['tool-2']).toEqual({
      taskId: 'task-b',
      taskType: 'local_bash'
    })
  })
})

describe('addTaskNotification', () => {
  it('appends notification to taskNotifications', () => {
    store().createNewSession('r1', '/test')
    const notification = makeTaskNotification({ toolUseId: 'tool-1', status: 'completed' })
    seed.taskNotification('r1', notification)
    expect(store().sessions['r1'].taskNotifications).toHaveLength(1)
    expect(store().sessions['r1'].taskNotifications[0]).toEqual(notification)
  })

  // The stop spinner and the live bash tail are per-client VIEW state, so clearing
  // them on a terminal notification is a post-apply observer in useClaudeEvents now
  // (SyncCore phase 4c) rather than part of the fold. Pinned by that hook's test —
  // a store-level test cannot see it, because the hook is not mounted here.

  it('does not modify stoppingTaskIds when toolUseId is null', () => {
    store().createNewSession('r1', '/test')
    store().setTaskStopping('r1', 'tool-1')
    seed.taskNotification('r1', makeTaskNotification({ toolUseId: null }))
    expect(store().sessions['r1'].stoppingTaskIds).toContain('tool-1')
  })

  it('clears the matching activeTasks entry (task_started -> task_notification lifecycle)', () => {
    store().createNewSession('r1', '/test')
    seed.taskStarted('r1', { toolUseId: 'tool-1', taskId: 'task-abc', taskType: 'local_agent' })
    expect(store().sessions['r1'].activeTasks['tool-1']).toBeDefined()

    seed.taskNotification('r1', makeTaskNotification({ toolUseId: 'tool-1', status: 'completed' }))

    expect(store().sessions['r1'].activeTasks['tool-1']).toBeUndefined()
  })

  it('leaves other activeTasks entries untouched', () => {
    store().createNewSession('r1', '/test')
    seed.taskStarted('r1', { toolUseId: 'tool-1', taskId: 'task-a', taskType: 'local_agent' })
    seed.taskStarted('r1', { toolUseId: 'tool-2', taskId: 'task-b', taskType: 'local_agent' })

    seed.taskNotification('r1', makeTaskNotification({ toolUseId: 'tool-1', status: 'completed' }))

    expect(store().sessions['r1'].activeTasks['tool-1']).toBeUndefined()
    expect(store().sessions['r1'].activeTasks['tool-2']).toEqual({
      taskId: 'task-b',
      taskType: 'local_agent'
    })
  })

  it('does not modify activeTasks when toolUseId is null', () => {
    store().createNewSession('r1', '/test')
    seed.taskStarted('r1', { toolUseId: 'tool-1', taskId: 'task-a', taskType: 'local_agent' })
    seed.taskNotification('r1', makeTaskNotification({ toolUseId: null }))
    expect(store().sessions['r1'].activeTasks['tool-1']).toEqual({
      taskId: 'task-a',
      taskType: 'local_agent'
    })
  })
})

describe('setStatus', () => {
  it('updates status fields', () => {
    store().createNewSession('r1', '/test')
    seed.status(
      'r1',
      makeSessionStatus({ state: 'running', model: claudeModel('claude-opus-4-7') })
    )
    expect(store().sessions['r1'].status.state).toBe('running')
    expect(store().sessions['r1'].status.model?.modelId).toBe('claude-opus-4-7')
  })

  it('mirrors a new cwd into the top-level session cwd', () => {
    store().createNewSession('r1', '/test/old')
    seed.status('r1', makeSessionStatus({ state: 'running', cwd: '/test/new' }))
    expect(store().sessions['r1'].cwd).toBe('/test/new')
  })

  // Thinking-span durations are the emitter's (4b) and the renderer's parallel clock
  // is deleted (4c) — see base-session-thinking-span.test.ts.

  // Thinking-span durations are the emitter's (4b) and the renderer's parallel clock
  // is deleted (4c) — see base-session-thinking-span.test.ts.

  // Thinking-span durations are the emitter's (4b) and the renderer's parallel clock
  // is deleted (4c) — see base-session-thinking-span.test.ts.

  it('clears foreground subagent streaming buffers on idle', () => {
    store().createNewSession('r1', '/test')
    seed.message(
      'r1',
      makeChatMessage({
        id: 'asst-1',
        role: 'assistant',
        content: [makeToolUseBlock('Task', { description: 'do work' }, 'tool-fg')]
      })
    )
    seed.subagentStreamThinking('r1', 'tool-fg', 'subagent thinking...')
    seed.subagentStreamText('r1', 'tool-fg', 'subagent answering...')

    seed.status('r1', makeSessionStatus({ state: 'idle' }))

    const s = store().sessions['r1']
    expect(s.subagentStreamingThinking['tool-fg']).toBe('')
    expect(s.subagentStreamingText['tool-fg']).toBe('')
  })

  it('preserves background subagent streaming buffers on idle', () => {
    store().createNewSession('r1', '/test')
    seed.message(
      'r1',
      makeChatMessage({
        id: 'asst-1',
        role: 'assistant',
        content: [
          makeToolUseBlock('Task', { description: 'bg work', run_in_background: true }, 'tool-bg')
        ]
      })
    )
    // appendSubagentStreamingText clears thinking by design (text supersedes
    // thinking in the live preview), so seed both buffers directly.
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        r1: {
          ...state.sessions.r1,
          subagentStreamingThinking: { 'tool-bg': 'still thinking...' },
          subagentStreamingText: { 'tool-bg': 'still answering...' }
        }
      }
    }))
    mirrorStoreIntoReplica()

    seed.status('r1', makeSessionStatus({ state: 'idle' }))

    const s = store().sessions['r1']
    expect(s.subagentStreamingThinking['tool-bg']).toBe('still thinking...')
    expect(s.subagentStreamingText['tool-bg']).toBe('still answering...')
  })

  it('clears foreground but not background subagent buffers when both are present', () => {
    store().createNewSession('r1', '/test')
    seed.message(
      'r1',
      makeChatMessage({
        id: 'asst-1',
        role: 'assistant',
        content: [
          makeToolUseBlock('Task', { description: 'fg' }, 'tool-fg'),
          makeToolUseBlock('Task', { description: 'bg', run_in_background: true }, 'tool-bg')
        ]
      })
    )
    seed.subagentStreamThinking('r1', 'tool-fg', 'fg thinking')
    seed.subagentStreamThinking('r1', 'tool-bg', 'bg thinking')

    seed.status('r1', makeSessionStatus({ state: 'idle' }))

    const s = store().sessions['r1']
    expect(s.subagentStreamingThinking['tool-fg']).toBe('')
    expect(s.subagentStreamingThinking['tool-bg']).toBe('bg thinking')
  })
})

describe('updateTaskProgress', () => {
  it('inserts progress entry by toolUseId', () => {
    store().createNewSession('r1', '/test')
    const progress = {
      toolUseId: 'tool-1',
      toolName: 'Bash',
      parentToolUseId: null,
      elapsedTimeSeconds: 5
    }
    seed.taskProgress('r1', progress)
    expect(store().sessions['r1'].taskProgressMap['tool-1']).toEqual(progress)
  })

  it('updates existing progress entry', () => {
    store().createNewSession('r1', '/test')
    seed.taskProgress('r1', {
      toolUseId: 'tool-1',
      toolName: 'Bash',
      parentToolUseId: null,
      elapsedTimeSeconds: 5
    })
    seed.taskProgress('r1', {
      toolUseId: 'tool-1',
      toolName: 'Bash',
      parentToolUseId: null,
      elapsedTimeSeconds: 10
    })
    expect(store().sessions['r1'].taskProgressMap['tool-1'].elapsedTimeSeconds).toBe(10)
  })
})

describe('addSubagentMessage', () => {
  it('appends new message to subagentMessages[toolUseId]', () => {
    store().createNewSession('r1', '/test')
    const msg = makeAssistantMessage('step 1')
    seed.subagentMessage('r1', 'tool-1', msg)
    expect(store().sessions['r1'].subagentMessages['tool-1']).toHaveLength(1)
  })

  it('upserts by message id when message already exists', () => {
    store().createNewSession('r1', '/test')
    const msg = makeChatMessage({
      id: 'shared-id',
      role: 'assistant',
      content: [{ type: 'text', text: 'v1' }]
    })
    seed.subagentMessage('r1', 'tool-1', msg)
    const updated = makeChatMessage({
      id: 'shared-id',
      role: 'assistant',
      content: [{ type: 'text', text: 'v2' }]
    })
    seed.subagentMessage('r1', 'tool-1', updated)
    const msgs = store().sessions['r1'].subagentMessages['tool-1']
    expect(msgs).toHaveLength(1)
    expect(msgs[0].content[0]).toMatchObject({ text: 'v2' })
  })

  // Thinking-span durations are the emitter's (4b) and the renderer's parallel clock
  // is deleted (4c) — see base-session-thinking-span.test.ts.

  it('is a no-op when the session does not exist — no ghost (F7)', () => {
    // A subagent message can only follow the Task tool_use that started it, which
    // can only follow `session:created`. The bootstrap that used to live here only
    // ever fired for post-DELETE traffic.
    seed.subagentMessage('ghost', 'tool-1', makeAssistantMessage('hi'))
    expect(store().sessions['ghost']).toBeUndefined()
  })
})

describe('appendSubagentMessageBatch', () => {
  it('appends multiple messages in order', () => {
    store().createNewSession('r1', '/test')
    const msgs = [makeAssistantMessage('a'), makeAssistantMessage('b')]
    seed.subagentMessageBatch('r1', 'tool-1', msgs)
    expect(store().sessions['r1'].subagentMessages['tool-1']).toHaveLength(2)
  })

  it('upserts messages that share existing ids', () => {
    store().createNewSession('r1', '/test')
    const m1 = makeChatMessage({
      id: 'x',
      role: 'assistant',
      content: [{ type: 'text', text: 'old' }]
    })
    seed.subagentMessage('r1', 'tool-1', m1)
    const m2 = makeChatMessage({
      id: 'x',
      role: 'assistant',
      content: [{ type: 'text', text: 'new' }]
    })
    seed.subagentMessageBatch('r1', 'tool-1', [m2])
    const msgs = store().sessions['r1'].subagentMessages['tool-1']
    expect(msgs).toHaveLength(1)
    expect(msgs[0].content[0]).toMatchObject({ text: 'new' })
  })

  it('clears streaming text and thinking', () => {
    store().createNewSession('r1', '/test')
    seed.subagentStreamText('r1', 'tool-1', 'partial...')
    seed.subagentMessageBatch('r1', 'tool-1', [makeAssistantMessage('done')])
    expect(store().sessions['r1'].subagentStreamingText['tool-1']).toBe('')
  })
})

describe('appendSubagentToolResult', () => {
  it('appends tool_result block to the matching assistant message in subagentMessages', () => {
    store().createNewSession('r1', '/test')
    const toolMsg = makeChatMessage({
      id: 'agent-msg-1',
      role: 'assistant',
      content: [makeToolUseBlock('Bash', { command: 'ls' }, 'tu-abc')]
    })
    seed.subagentMessage('r1', 'tool-1', toolMsg)
    seed.subagentToolResult('r1', 'tool-1', 'tu-abc', 'file1\nfile2', false)
    const msgs = store().sessions['r1'].subagentMessages['tool-1']
    const result = msgs[0].content.find((b) => b.type === 'tool_result')
    expect(result).toBeDefined()
    expect(result).toMatchObject({
      toolUseId: 'tu-abc',
      toolResult: 'file1\nfile2',
      isError: false
    })
  })

  it('marks isError correctly', () => {
    store().createNewSession('r1', '/test')
    const toolMsg = makeChatMessage({
      id: 'agent-msg-1',
      role: 'assistant',
      content: [makeToolUseBlock('Bash', {}, 'tu-xyz')]
    })
    seed.subagentMessage('r1', 'tool-1', toolMsg)
    seed.subagentToolResult('r1', 'tool-1', 'tu-xyz', 'error: permission denied', true)
    const msgs = store().sessions['r1'].subagentMessages['tool-1']
    const result = msgs[0].content.find((b) => b.type === 'tool_result')
    expect(result).toMatchObject({ isError: true })
  })

  it('is a no-op when session does not exist', () => {
    expect(() => seed.subagentToolResult('ghost', 'tool-1', 'tu-1', 'result', false)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Voice actions
// ---------------------------------------------------------------------------

describe('appendVoiceTranscript', () => {
  it('appends final transcript to draftText with space separator', () => {
    store().createNewSession('r1', '/test')
    useSessionStore.setState({
      sessions: {
        ...store().sessions,
        r1: { ...store().sessions['r1'], draftText: 'existing text' }
      }
    })
    mirrorStoreIntoReplica()
    store().appendVoiceTranscript('r1', 'new words', true)
    expect(store().sessions['r1'].draftText).toBe('existing text new words')
  })

  it('does not double-space when draftText already ends with space', () => {
    store().createNewSession('r1', '/test')
    useSessionStore.setState({
      sessions: {
        ...store().sessions,
        r1: { ...store().sessions['r1'], draftText: 'existing text ' }
      }
    })
    mirrorStoreIntoReplica()
    store().appendVoiceTranscript('r1', 'new words', true)
    expect(store().sessions['r1'].draftText).toBe('existing text new words')
  })

  it('appends to empty draftText without leading space', () => {
    store().createNewSession('r1', '/test')
    store().appendVoiceTranscript('r1', 'first words', true)
    expect(store().sessions['r1'].draftText).toBe('first words')
  })

  it('clears voiceInterimTranscript when isFinal', () => {
    store().createNewSession('r1', '/test')
    store().setVoiceInterimTranscript('r1', 'interim...')
    store().appendVoiceTranscript('r1', 'final text', true)
    expect(store().sessions['r1'].voiceInterimTranscript).toBe('')
  })

  it('updates voiceInterimTranscript when not final', () => {
    store().createNewSession('r1', '/test')
    store().appendVoiceTranscript('r1', 'speaking now...', false)
    expect(store().sessions['r1'].voiceInterimTranscript).toBe('speaking now...')
  })

  it('does not modify draftText for interim transcripts', () => {
    store().createNewSession('r1', '/test')
    useSessionStore.setState({
      sessions: {
        ...store().sessions,
        r1: { ...store().sessions['r1'], draftText: 'typed so far' }
      }
    })
    mirrorStoreIntoReplica()
    store().appendVoiceTranscript('r1', 'partial...', false)
    expect(store().sessions['r1'].draftText).toBe('typed so far')
  })
})

// ---------------------------------------------------------------------------
// Background output actions
// ---------------------------------------------------------------------------

describe('watchBackgroundOutput', () => {
  it('increments backgroundWatcherCounts', () => {
    store().createNewSession('r1', '/test')
    store().watchBackgroundOutput('r1', 'tool-1')
    expect(store().sessions['r1'].backgroundWatcherCounts['tool-1']).toBe(1)
    store().watchBackgroundOutput('r1', 'tool-1')
    expect(store().sessions['r1'].backgroundWatcherCounts['tool-1']).toBe(2)
  })

  it('calls window.api.watchBackground', () => {
    store().createNewSession('r1', '/test')
    store().watchBackgroundOutput('r1', 'tool-1')
    expect((window.api as any).watchBackground).toHaveBeenCalledWith('r1', 'tool-1')
  })

  it('is a no-op when session does not exist', () => {
    expect(() => store().watchBackgroundOutput('ghost', 'tool-1')).not.toThrow()
  })
})

describe('unwatchBackgroundOutput', () => {
  it('decrements backgroundWatcherCounts', () => {
    store().createNewSession('r1', '/test')
    store().watchBackgroundOutput('r1', 'tool-1')
    store().watchBackgroundOutput('r1', 'tool-1')
    store().unwatchBackgroundOutput('r1', 'tool-1')
    expect(store().sessions['r1'].backgroundWatcherCounts['tool-1']).toBe(1)
  })

  it('calls unwatchBackground and removes entries when count reaches 0', () => {
    store().createNewSession('r1', '/test')
    store().watchBackgroundOutput('r1', 'tool-1')
    store().setBackgroundOutput('r1', 'tool-1', 'some tail', 500)
    store().unwatchBackgroundOutput('r1', 'tool-1')
    expect((window.api as any).unwatchBackground).toHaveBeenCalledWith('r1', 'tool-1')
    expect(store().sessions['r1'].backgroundOutputs['tool-1']).toBeUndefined()
    expect(store().sessions['r1'].backgroundWatcherCounts['tool-1']).toBeUndefined()
  })

  it('does not call unwatchBackground while count remains above 0', () => {
    store().createNewSession('r1', '/test')
    store().watchBackgroundOutput('r1', 'tool-1')
    store().watchBackgroundOutput('r1', 'tool-1')
    store().unwatchBackgroundOutput('r1', 'tool-1')
    expect((window.api as any).unwatchBackground).not.toHaveBeenCalled()
  })

  it('is a no-op when session does not exist', () => {
    expect(() => store().unwatchBackgroundOutput('ghost', 'tool-1')).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Terminal actions
// ---------------------------------------------------------------------------

describe('addTerminalTab', () => {
  it('adds tab to group keyed by normalized cwd', () => {
    store().addTerminalTab({ id: 'term-1', title: 'bash', cwd: '/project/' })
    expect(store().terminalGroups['/project']).toBeDefined()
    expect(store().terminalGroups['/project'].tabs).toHaveLength(1)
  })

  it('sets activeTabId to the new tab', () => {
    store().addTerminalTab({ id: 'term-1', title: 'bash', cwd: '/project' })
    expect(store().terminalGroups['/project'].activeTabId).toBe('term-1')
  })

  it('appends to existing group without replacing other tabs', () => {
    store().addTerminalTab({ id: 'term-1', title: 'bash', cwd: '/project' })
    store().addTerminalTab({ id: 'term-2', title: 'zsh', cwd: '/project' })
    expect(store().terminalGroups['/project'].tabs).toHaveLength(2)
    expect(store().terminalGroups['/project'].activeTabId).toBe('term-2')
  })
})

describe('closeTerminalTab', () => {
  // The action is pure TAB STATE and stays that way under ADR-062. Closing a tab
  // in the UI now kills the shell by default, but that kill is sequenced by the
  // panel (`terminal:kill` first, drop the tab only if it succeeded) — a store
  // action that killed on its own would fire on the detach path too, and on
  // every non-user caller of this reducer.
  it('removes the tab WITHOUT killing the pty (the panel owns the kill)', () => {
    store().addTerminalTab({ id: 'term-1', title: 'bash', cwd: '/project' })
    store().closeTerminalTab('term-1')
    expect(store().terminalGroups['/project'].tabs).toHaveLength(0)
    expect((window.api as any).killTerminal).not.toHaveBeenCalled()
  })

  it('updates activeTabId to last remaining tab', () => {
    store().addTerminalTab({ id: 'term-1', title: 'bash', cwd: '/project' })
    store().addTerminalTab({ id: 'term-2', title: 'zsh', cwd: '/project' })
    store().closeTerminalTab('term-2')
    expect(store().terminalGroups['/project'].activeTabId).toBe('term-1')
  })

  it('sets activeTabId to null when no tabs remain', () => {
    store().addTerminalTab({ id: 'term-1', title: 'bash', cwd: '/project' })
    store().closeTerminalTab('term-1')
    expect(store().terminalGroups['/project'].activeTabId).toBeNull()
  })
})

describe('removeTerminalTab', () => {
  it('removes tab without calling killTerminal', () => {
    store().addTerminalTab({ id: 'term-1', title: 'bash', cwd: '/project' })
    store().removeTerminalTab('term-1')
    expect(store().terminalGroups['/project'].tabs).toHaveLength(0)
    expect((window.api as any).killTerminal).not.toHaveBeenCalled()
  })

  it('updates activeTabId to last remaining tab', () => {
    store().addTerminalTab({ id: 'term-1', title: 'bash', cwd: '/project' })
    store().addTerminalTab({ id: 'term-2', title: 'zsh', cwd: '/project' })
    store().removeTerminalTab('term-2')
    expect(store().terminalGroups['/project'].activeTabId).toBe('term-1')
  })
})

describe('removeTerminalGroup', () => {
  it('removes the entire group for the given cwd', () => {
    store().addTerminalTab({ id: 'term-1', title: 'bash', cwd: '/project' })
    store().removeTerminalGroup('/project')
    expect(store().terminalGroups['/project']).toBeUndefined()
  })

  it('normalizes cwd before removing', () => {
    store().addTerminalTab({ id: 'term-1', title: 'bash', cwd: '/project' })
    store().removeTerminalGroup('/project/') // trailing slash
    expect(store().terminalGroups['/project']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Git / Plan / Worktree actions
// ---------------------------------------------------------------------------

describe('setGitStatus', () => {
  it('updates gitStatus on the session', () => {
    store().createNewSession('r1', '/test')
    const status = makeGitStatus({ branch: 'feature' })
    store().setGitStatus('r1', status)
    expect(store().sessions['r1'].gitStatus?.branch).toBe('feature')
  })

  it('caches git status for the session cwd', () => {
    // Create a second session with the same cwd — it should receive cached status
    store().createNewSession('r1', '/shared-cwd')
    const status = makeGitStatus({
      branch: 'main',
      files: [{ path: 'README.md', index: 'M', working: ' ' }]
    })
    store().setGitStatus('r1', status)
    // New session with same cwd should pick up cached status
    store().createNewSession('r2', '/shared-cwd')
    expect(store().sessions['r2'].gitStatus?.branch).toBe('main')
  })
})

describe('selectNextGitFile', () => {
  it('selects the first file from gitStatus.files', () => {
    store().createNewSession('r1', '/test')
    store().setGitStatus(
      'r1',
      makeGitStatus({
        files: [
          { path: 'a.ts', index: 'M', working: ' ' },
          { path: 'b.ts', index: 'M', working: ' ' }
        ]
      })
    )
    store().selectNextGitFile('r1')
    expect(store().sessions['r1'].gitSelectedFile).toBe('a.ts')
  })

  it('sets gitSelectedFile to null when no files in gitStatus', () => {
    store().createNewSession('r1', '/test')
    store().setGitStatus('r1', makeGitStatus({ files: [] }))
    store().selectNextGitFile('r1')
    expect(store().sessions['r1'].gitSelectedFile).toBeNull()
  })

  it('sets gitSelectedFile to null when gitStatus is null', () => {
    store().createNewSession('r1', '/test')
    store().selectNextGitFile('r1')
    expect(store().sessions['r1'].gitSelectedFile).toBeNull()
  })

  it('clears gitFileDiff when selecting next file', () => {
    store().createNewSession('r1', '/test')
    store().setGitFileDiff('r1', { patch: 'diff --git...' })
    store().setGitStatus(
      'r1',
      makeGitStatus({ files: [{ path: 'a.ts', index: 'M', working: ' ' }] })
    )
    store().selectNextGitFile('r1')
    expect(store().sessions['r1'].gitFileDiff).toBeNull()
  })
})

describe('addDiffComment / removeDiffComment / clearDiffComments', () => {
  it('addDiffComment appends a comment', () => {
    store().createNewSession('r1', '/test')
    const comment = makeDiffComment({ id: 'c-1' })
    store().addDiffComment('r1', comment)
    expect(store().sessions['r1'].gitReviewComments).toHaveLength(1)
  })

  it('removeDiffComment removes by id', () => {
    store().createNewSession('r1', '/test')
    store().addDiffComment('r1', makeDiffComment({ id: 'c-1' }))
    store().addDiffComment('r1', makeDiffComment({ id: 'c-2' }))
    store().removeDiffComment('r1', 'c-1')
    expect(store().sessions['r1'].gitReviewComments).toHaveLength(1)
    expect(store().sessions['r1'].gitReviewComments[0].id).toBe('c-2')
  })

  it('clearDiffComments empties the array', () => {
    store().createNewSession('r1', '/test')
    store().addDiffComment('r1', makeDiffComment())
    store().addDiffComment('r1', makeDiffComment())
    store().clearDiffComments('r1')
    expect(store().sessions['r1'].gitReviewComments).toHaveLength(0)
  })
})

describe('openPlanPanel / closePlanPanel', () => {
  it('openPlanPanel sets rightPanel to plan and initializes planReview', () => {
    store().createNewSession('r1', '/test')
    store().openPlanPanel('r1', 'the plan content', 'req-abc')
    const session = store().sessions['r1']
    expect(session.rightPanel).toBe('plan')
    expect(session.planReview).toMatchObject({
      planContent: 'the plan content',
      approvalRequestId: 'req-abc',
      comments: []
    })
  })

  it('closePlanPanel sets rightPanel to none and nulls planReview', () => {
    store().createNewSession('r1', '/test')
    store().openPlanPanel('r1', 'plan', 'req-1')
    store().closePlanPanel('r1')
    expect(store().sessions['r1'].rightPanel).toBe('none')
    expect(store().sessions['r1'].planReview).toBeNull()
  })
})

describe('plan comment CRUD', () => {
  beforeEach(() => {
    store().createNewSession('r1', '/test')
    store().openPlanPanel('r1', 'some plan', 'req-1')
  })

  it('addPlanComment appends a comment', () => {
    const comment = makePlanComment({ id: 'pc-1' })
    store().addPlanComment('r1', comment)
    expect(store().sessions['r1'].planReview?.comments).toHaveLength(1)
  })

  it('updatePlanComment updates the text of an existing comment', () => {
    store().addPlanComment('r1', makePlanComment({ id: 'pc-1', comment: 'original' }))
    store().updatePlanComment('r1', 'pc-1', 'updated text')
    expect(store().sessions['r1'].planReview?.comments[0].comment).toBe('updated text')
  })

  it('updatePlanComment leaves other comments unchanged', () => {
    store().addPlanComment('r1', makePlanComment({ id: 'pc-1', comment: 'keep me' }))
    store().addPlanComment('r1', makePlanComment({ id: 'pc-2', comment: 'change me' }))
    store().updatePlanComment('r1', 'pc-2', 'changed')
    expect(store().sessions['r1'].planReview?.comments[0].comment).toBe('keep me')
  })

  it('removePlanComment removes by id', () => {
    store().addPlanComment('r1', makePlanComment({ id: 'pc-1' }))
    store().addPlanComment('r1', makePlanComment({ id: 'pc-2' }))
    store().removePlanComment('r1', 'pc-1')
    expect(store().sessions['r1'].planReview?.comments).toHaveLength(1)
    expect(store().sessions['r1'].planReview?.comments[0].id).toBe('pc-2')
  })

  it('clearPlanComments empties the array', () => {
    store().addPlanComment('r1', makePlanComment())
    store().addPlanComment('r1', makePlanComment())
    store().clearPlanComments('r1')
    expect(store().sessions['r1'].planReview?.comments).toHaveLength(0)
  })

  it('plan comment actions are no-ops when planReview is null', () => {
    store().closePlanPanel('r1')
    expect(() => store().addPlanComment('r1', makePlanComment())).not.toThrow()
    expect(store().sessions['r1'].planReview).toBeNull()
  })
})

describe('setWorktreeInfo', () => {
  it('updates worktreeInfoMap and session.worktreeInfo', () => {
    store().createNewSession('r1', '/test')
    const info = makeWorktreeInfo()
    store().setWorktreeInfo('r1', info)
    expect(store().worktreeInfoMap['r1']).toEqual(info)
    expect(store().sessions['r1'].worktreeInfo).toEqual(info)
  })

  it('updates session cwd to worktreePath when different', () => {
    store().createNewSession('r1', '/original')
    const info = makeWorktreeInfo({
      worktreePath: '/tmp/worktrees/branch',
      originalCwd: '/original'
    })
    store().setWorktreeInfo('r1', info)
    expect(store().sessions['r1'].cwd).toBe('/tmp/worktrees/branch')
  })

  it('removes from map when info is null', () => {
    store().createNewSession('r1', '/test')
    store().setWorktreeInfo('r1', makeWorktreeInfo())
    store().setWorktreeInfo('r1', null)
    expect(store().worktreeInfoMap['r1']).toBeUndefined()
    expect(store().sessions['r1'].worktreeInfo).toBeNull()
  })
})

describe('clearWorktreeInfo', () => {
  it('removes from worktreeInfoMap and sets session.worktreeInfo to null', () => {
    store().createNewSession('r1', '/test')
    store().setWorktreeInfo('r1', makeWorktreeInfo())
    store().clearWorktreeInfo('r1')
    expect(store().worktreeInfoMap['r1']).toBeUndefined()
    expect(store().sessions['r1'].worktreeInfo).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Settings actions
// ---------------------------------------------------------------------------

describe('applyExternalSettings', () => {
  it('merges incoming settings with DEFAULT_SETTINGS', () => {
    seed.settings({ theme: 'light', expandToolCalls: false })
    expect(store().settings.theme).toBe('light')
    expect(store().settings.expandToolCalls).toBe(false)
  })

  it('fills missing fields from DEFAULT_SETTINGS', () => {
    seed.settings({ theme: 'monokai' })
    // maxRecentSessions should still be the default value (5)
    expect(store().settings.maxRecentSessions).toBe(5)
  })

  it('does not call saveSettings (no disk write)', () => {
    seed.settings({ theme: 'light' })
    expect((window.api as any).saveSettings).not.toHaveBeenCalled()
  })
})

describe('applyExternalSessionConfig', () => {
  it('replaces recentSessionIds', () => {
    seed.sessionsConfig({ recentSessions: ['r1', 'r2'] })
    expect(store().recentSessionIds).toEqual(['r1', 'r2'])
  })

  it('replaces pinnedSessionIds', () => {
    seed.sessionsConfig({ pinnedSessions: ['pinned-1'] })
    expect(store().pinnedSessionIds).toEqual(['pinned-1'])
  })

  it('replaces customTitles', () => {
    seed.sessionsConfig({ customTitles: { r1: 'My Session' } })
    expect(store().customTitles['r1']).toBe('My Session')
  })

  it('replaces worktreeInfoMap', () => {
    const info = makeWorktreeInfo()
    seed.sessionsConfig({ worktreeInfoMap: { r1: info } })
    expect(store().worktreeInfoMap['r1']).toEqual(info)
  })

  it('uses empty defaults when fields are missing', () => {
    seed.sessionsConfig({})
    expect(store().recentSessionIds).toEqual([])
    expect(store().pinnedSessionIds).toEqual([])
    expect(store().customTitles).toEqual({})
    expect(store().worktreeInfoMap).toEqual({})
  })

  it('does not call saveSessionConfig (no disk write)', () => {
    seed.sessionsConfig({ recentSessions: ['r1'] })
    expect((window.api as any).saveSessionConfig).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Mockup panel actions
// ---------------------------------------------------------------------------

describe('openMockupPanel / closeMockupPanel', () => {
  beforeEach(() => {
    store().createNewSession('r1', '/test')
    useSessionStore.setState({ activeSessionId: 'r1' })
  })

  it('opens mockup panel with directory and title', () => {
    store().openMockupPanel('r1', 'abc12345', 'Settings Page')
    const session = store().sessions['r1']
    expect(session.rightPanel).toBe('mockup')
    expect(session.mockupDir).toBe('abc12345')
    expect(session.mockupTitle).toBe('Settings Page')
  })

  it('opens mockup panel without title', () => {
    store().openMockupPanel('r1', 'abc12345')
    const session = store().sessions['r1']
    expect(session.rightPanel).toBe('mockup')
    expect(session.mockupDir).toBe('abc12345')
    expect(session.mockupTitle).toBeNull()
  })

  it('closes mockup panel and clears state', () => {
    store().openMockupPanel('r1', 'abc12345', 'My Mockup')
    store().closeMockupPanel('r1')
    const session = store().sessions['r1']
    expect(session.rightPanel).toBe('none')
    expect(session.mockupDir).toBeNull()
    expect(session.mockupTitle).toBeNull()
  })

  it('replaces previous right panel when opening mockup', () => {
    store().openGitPanel('r1')
    expect(store().sessions['r1'].rightPanel).toBe('git')
    store().openMockupPanel('r1', 'abc12345')
    expect(store().sessions['r1'].rightPanel).toBe('mockup')
  })

  it('does not affect other sessions', () => {
    store().createNewSession('r2', '/test2')
    store().openMockupPanel('r1', 'abc12345', 'Page A')
    expect(store().sessions['r2'].rightPanel).toBe('none')
    expect(store().sessions['r2'].mockupDir).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Engine selection (Phase 5)
// ---------------------------------------------------------------------------

describe('setLastSelectedEngineId', () => {
  it('updates lastSelectedEngineId in store', () => {
    expect(store().lastSelectedEngineId).toBe('claude')
    store().setLastSelectedEngineId('claude')
    expect(store().lastSelectedEngineId).toBe('claude')
  })
})

describe('createNewSession inherits lastSelectedEngineId', () => {
  it('default is claude — new session selectedEngineId is claude', () => {
    store().createNewSession('r1', '/path')
    expect(store().sessions['r1'].selectedEngineId).toBe('claude')
  })

  it('new session status.engineId is claude', () => {
    store().setLastSelectedEngineId('claude')
    store().createNewSession('r1', '/path')
    expect(store().sessions['r1'].status.engineId).toBe('claude')
  })

  it('new session status.capabilities matches claude capabilities', () => {
    store().setLastSelectedEngineId('claude')
    store().createNewSession('r1', '/path')
    const caps = store().sessions['r1'].status.capabilities
    // reasoning.thinking present for default (resolves to opus alias → adaptive thinking)
    // voice, hostedMcp etc. are engine-level — always true for Claude
    expect(caps.voice).toBe(true)
    expect(caps.hostedMcp).toBe(true)
    expect(caps.backgroundTasks).toBe(true)
    expect(caps.canUseMcp).toBe(true)
    expect(caps.isAgentCapable).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Regression: perEngineDefaultModel (session-store.ts ~:91-99). Before that
  // helper existed, BOTH createNewSession and loadHistoricalSession passed
  // `state.opencodeDefaultModel` unconditionally regardless of engineId — a
  // latent bug for 'pi': a fresh/reopened pi session would seed from
  // opencode's default model string instead of pi's own, since
  // PI_DEFAULT_MODEL's fallback in defaultModelValue never triggers while
  // opencodeDefaultModel is truthy (which it always is).
  // -------------------------------------------------------------------------

  afterEach(() => {
    // Restore module-singleton store fields this describe block mutates, so
    // later describe blocks in this file see the defaults they expect.
    useSessionStore.setState({
      lastSelectedEngineId: 'claude',
      piDefaultModel: PI_DEFAULT_MODEL,
      opencodeDefaultModel: OPENCODE_DEFAULT_MODEL
    })
  })

  it('pi engine seeds selectedModel from piDefaultModel, NOT opencodeDefaultModel', () => {
    useSessionStore.setState({
      lastSelectedEngineId: 'pi',
      piDefaultModel: 'anthropic/claude-sonnet-5',
      opencodeDefaultModel: 'opencode/mimo-v2.5-free'
    })
    store().createNewSession('r-pi', '/path')
    expect(store().sessions['r-pi'].selectedEngineId).toBe('pi')
    expect(store().sessions['r-pi'].selectedModel).toBe('anthropic/claude-sonnet-5')
  })

  it('pi engine falls back to PI_DEFAULT_MODEL when piDefaultModel is unset — never opencodeDefaultModel', () => {
    useSessionStore.setState({
      lastSelectedEngineId: 'pi',
      piDefaultModel: PI_DEFAULT_MODEL,
      opencodeDefaultModel: 'opencode/mimo-v2.5-free'
    })
    store().createNewSession('r-pi-2', '/path')
    expect(store().sessions['r-pi-2'].selectedModel).toBe(PI_DEFAULT_MODEL)
    expect(store().sessions['r-pi-2'].selectedModel).not.toBe('opencode/mimo-v2.5-free')
  })
})

describe('resolveClaudeCapabilities (Phase 2 replacement for capabilitiesFor)', () => {
  it('claude has all engine-level capabilities enabled', () => {
    const caps = resolveClaudeCapabilities('claude-opus-4-8')
    expect(caps.voice).toBe(true)
    expect(caps.hostedMcp).toBe(true)
    expect(caps.backgroundTasks).toBe(true)
    expect(caps.subagents).toBe(true)
    expect(caps.plan).toBe(true)
    expect(caps.fork).toBe(true)
    expect(caps.forkFromMessage).toBe(true)
  })

  it('AND-derived gates are correct for Claude + tool-capable model', () => {
    const caps = resolveClaudeCapabilities('claude-opus-4-8')
    expect(caps.canUseMcp).toBe(true)
    expect(caps.canUseSubagents).toBe(true)
    expect(caps.isAgentCapable).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Model picks: capability re-seeding, welcome-screen stickiness, stale defaults
// ---------------------------------------------------------------------------

/** Minimal discovered ModelInfo for a non-claude engine. */
function engineModel(
  engineId: 'opencode' | 'pi',
  value: string,
  extra: Partial<ModelInfo> = {}
): ModelInfo {
  const [vendorId] = value.split('/')
  return {
    value,
    displayName: value,
    description: '',
    engineId,
    vendorId,
    ...extra
  } as ModelInfo
}

const NO_VISION = engineModel('opencode', 'opencode/plain-free', {
  vision: false,
  toolCalling: true
})
const VISION = engineModel('opencode', 'opencode/mimo-v2.5-free', {
  vision: true,
  toolCalling: true
})
const PI_REASONING = engineModel('pi', 'openai-codex/gpt-5.6-luna', {
  vision: true,
  toolCalling: true,
  supportsEffort: true,
  supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max']
})
const PI_PLAIN = engineModel('pi', 'openai-codex/plain', {
  vision: false,
  toolCalling: true,
  supportsEffort: false
})

/** Stage an un-started session on `engineId` seeded from `seedModel`. */
function stageUnstarted(
  routingId: string,
  engineId: 'opencode' | 'pi',
  seedModel: ModelInfo,
  models: ModelInfo[]
): void {
  useSessionStore.setState({ availableModels: models, lastSelectedEngineId: engineId })
  seedSession(routingId, {
    cwd: '/proj',
    selectedEngineId: engineId,
    selectedModel: seedModel.value,
    status: {
      ...makeSessionStatus({ engineId, sessionId: null }),
      capabilities: engineMeta(engineId).seedCapabilities(seedModel.value, seedModel)
    }
  })
  useSessionStore.setState({ activeSessionId: routingId })
}

describe('setSelectedModel - pre-spawn capability re-seed (Item 1)', () => {
  /**
   * PRE-FIX: `setSelectedModel` patched only `selectedModel`, so an un-started
   * session kept the capabilities of the model it was CREATED with. The attach
   * menu stayed hidden and pasted images were silently dropped after switching
   * to a vision model.
   */
  it('re-seeds status.capabilities from the new model on an un-started opencode session', () => {
    stageUnstarted('r-oc', 'opencode', NO_VISION, [NO_VISION, VISION])
    expect(store().sessions['r-oc'].status.capabilities.vision).toBe(false)

    store().setSelectedModel(VISION.value)

    expect(store().sessions['r-oc'].selectedModel).toBe(VISION.value)
    expect(store().sessions['r-oc'].status.capabilities.vision).toBe(true)
    expect(store().sessions['r-oc'].status.capabilities.toolCalling).toBe(true)
  })

  it('leaves status.capabilities alone on a STARTED session (the backend event is authoritative)', () => {
    stageUnstarted('r-oc-live', 'opencode', NO_VISION, [NO_VISION, VISION])
    seedSession('r-oc-live', {
      status: {
        ...makeSessionStatus({ engineId: 'opencode', sessionId: 'ses_live' }),
        capabilities: engineMeta('opencode').seedCapabilities(NO_VISION.value, NO_VISION)
      }
    })

    store().setSelectedModel(VISION.value)

    expect(store().sessions['r-oc-live'].selectedModel).toBe(VISION.value)
    expect(store().sessions['r-oc-live'].status.capabilities.vision).toBe(false)
  })

  it('re-seeds pi effort tiers from the new model (PI_META path)', () => {
    stageUnstarted('r-pi-caps', 'pi', PI_PLAIN, [PI_PLAIN, PI_REASONING])
    expect(store().sessions['r-pi-caps'].status.capabilities.reasoning.effort).toBeUndefined()

    store().setSelectedModel(PI_REASONING.value)

    const caps = store().sessions['r-pi-caps'].status.capabilities
    expect(caps.vision).toBe(true)
    expect(caps.reasoning.effort?.levels).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })
})

describe('welcome-screen model pick stickiness (Item 2)', () => {
  beforeEach(() => {
    localStorage.clear()
    useSessionStore.setState({ lastSelectedModelByEngine: {} })
  })

  /** PRE-FIX: `setSelectedModel` returned early with no active session. */
  it('records a no-session pick under the welcome picker engine and persists it', () => {
    useSessionStore.setState({
      activeSessionId: null,
      lastSelectedEngineId: 'opencode',
      availableModels: [NO_VISION, VISION]
    })

    store().setSelectedModel(VISION.value)

    expect(store().lastSelectedModelByEngine.opencode).toBe(VISION.value)
    expect(localStorage.getItem('lastSelectedModel:opencode')).toBe(VISION.value)
  })

  it('createNewSession seeds the welcome pick - model AND capabilities', () => {
    useSessionStore.setState({
      activeSessionId: null,
      lastSelectedEngineId: 'opencode',
      opencodeDefaultModel: NO_VISION.value,
      opencodeDefaultModelConfigured: true,
      availableModels: [NO_VISION, VISION]
    })
    store().setSelectedModel(VISION.value)

    store().createNewSession('r-welcome', '/proj')

    expect(store().sessions['r-welcome'].selectedModel).toBe(VISION.value)
    expect(store().sessions['r-welcome'].status.capabilities.vision).toBe(true)
  })

  it('a STALE welcome pick falls through to the default resolution', () => {
    useSessionStore.setState({
      activeSessionId: null,
      lastSelectedEngineId: 'opencode',
      lastSelectedModelByEngine: { opencode: 'opencode/deleted-model' },
      opencodeDefaultModel: NO_VISION.value,
      opencodeDefaultModelConfigured: true,
      availableModels: [NO_VISION, VISION]
    })

    store().createNewSession('r-stale-sticky', '/proj')

    expect(store().sessions['r-stale-sticky'].selectedModel).toBe(NO_VISION.value)
    expect(store().sessions['r-stale-sticky'].errors).toEqual([])
  })

  it('keeps picks per engine - an opencode pick never leaks into a pi session', () => {
    useSessionStore.setState({
      activeSessionId: null,
      lastSelectedEngineId: 'opencode',
      availableModels: [VISION, PI_REASONING, PI_PLAIN],
      piDefaultModel: PI_PLAIN.value,
      piDefaultModelConfigured: true
    })
    store().setSelectedModel(VISION.value)

    useSessionStore.setState({ lastSelectedEngineId: 'pi' })
    store().createNewSession('r-pi-iso', '/proj')

    expect(store().lastSelectedModelByEngine.pi).toBeUndefined()
    expect(store().sessions['r-pi-iso'].selectedModel).toBe(PI_PLAIN.value)
  })

  it('an on-session pick is remembered for the NEXT new session on that engine', () => {
    stageUnstarted('r-remember', 'opencode', NO_VISION, [NO_VISION, VISION])
    store().setSelectedModel(VISION.value)

    useSessionStore.setState({ activeSessionId: null })
    store().createNewSession('r-remember-2', '/proj')

    expect(store().sessions['r-remember-2'].selectedModel).toBe(VISION.value)
  })
})

describe('stale CONFIGURED default model errors instead of substituting (Item 3b)', () => {
  beforeEach(() => {
    localStorage.clear()
    useSessionStore.setState({ lastSelectedModelByEngine: {} })
  })

  /**
   * PRE-FIX: `resolveOpencodeModel` substituted the first free zen model, which
   * is how a no-vision model reached a session whose picker showed a vision one.
   */
  it('createNewSession seeds NO model and banners the stale opencode default', () => {
    useSessionStore.setState({
      activeSessionId: null,
      lastSelectedEngineId: 'opencode',
      opencodeDefaultModel: 'openai/gpt-5.5',
      opencodeDefaultModelConfigured: true,
      availableModels: [NO_VISION, VISION]
    })

    store().createNewSession('r-stale-default', '/proj')

    const session = store().sessions['r-stale-default']
    expect(session.selectedEngineId).toBe('opencode')
    expect(session.selectedModel).toBe('')
    expect(session.errors.join(' ')).toContain('openai/gpt-5.5')
    // Not encoded into the registry - a phantom ModelRef would be restored on reopen.
    expect(store().sessionEngines['r-stale-default'].model).toBeUndefined()
  })

  it('the same value NOT configured still falls back silently (builtin heuristic)', () => {
    useSessionStore.setState({
      activeSessionId: null,
      lastSelectedEngineId: 'opencode',
      opencodeDefaultModel: 'openai/gpt-5.5',
      opencodeDefaultModelConfigured: false,
      availableModels: [NO_VISION, VISION]
    })

    store().createNewSession('r-builtin', '/proj')

    // The builtin ladder's own answer (first free zen model), reached with no
    // banner - that silent substitution is the CORRECT behaviour when nothing
    // was configured.
    expect(store().sessions['r-builtin'].selectedModel).toBe(NO_VISION.value)
    expect(store().sessions['r-builtin'].errors).toEqual([])
  })

  it('a stale CONFIGURED pi default behaves the same way', () => {
    useSessionStore.setState({
      activeSessionId: null,
      lastSelectedEngineId: 'pi',
      piDefaultModel: 'openai-codex/gone',
      piDefaultModelConfigured: true,
      availableModels: [PI_PLAIN, PI_REASONING]
    })

    store().createNewSession('r-pi-stale', '/proj')

    expect(store().sessions['r-pi-stale'].selectedModel).toBe('')
    expect(store().sessions['r-pi-stale'].errors.join(' ')).toContain('openai-codex/gone')
  })

  it('an EMPTY engine model list cannot validate, so the configured value passes through', () => {
    useSessionStore.setState({
      activeSessionId: null,
      lastSelectedEngineId: 'pi',
      piDefaultModel: 'openai-codex/not-discovered-yet',
      piDefaultModelConfigured: true,
      availableModels: []
    })

    store().createNewSession('r-pi-cold', '/proj')

    expect(store().sessions['r-pi-cold'].selectedModel).toBe('openai-codex/not-discovered-yet')
    expect(store().sessions['r-pi-cold'].errors).toEqual([])
  })

  it('setOpencodeDefaultModel/setPiDefaultModel track the CONFIGURED flag', () => {
    store().setOpencodeDefaultModel('openai/gpt-5.9')
    expect(store().opencodeDefaultModelConfigured).toBe(true)
    store().setOpencodeDefaultModel('')
    expect(store().opencodeDefaultModelConfigured).toBe(false)
    expect(store().opencodeDefaultModel).toBe(OPENCODE_DEFAULT_MODEL)

    store().setPiDefaultModel('openai-codex/x')
    expect(store().piDefaultModelConfigured).toBe(true)
    store().setPiDefaultModel('')
    expect(store().piDefaultModelConfigured).toBe(false)
    expect(store().piDefaultModel).toBe(PI_DEFAULT_MODEL)
  })
})

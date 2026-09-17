/**
 * The client replica — SyncCore phase 4c.
 *
 * `applyEvent` itself is pinned by `shared/sync/__tests__/reducer.unit.test.ts`;
 * what these tests own is the part that only exists on the CLIENT: the projection
 * from canonical state into the Zustand store, and the three ways state gets in
 * (fold / hydration / sanctioned local write).
 *
 * The properties that are load-bearing rather than incidental:
 *
 *  - **identity-diffing** — an event must not re-write slices it did not touch, or
 *    every in-flight local write (a pick whose `config:*` echo has not landed) gets
 *    reverted by the next unrelated stream delta, and every subscriber re-renders
 *    on every token;
 *  - **view state survives** — the projection writes ONLY sealed fields, which is
 *    the store split ADR-041 asks for, expressed as one function instead of two
 *    Zustand stores;
 *  - **rekey carries the view over and leaves no ghost** — the failure mode the
 *    deleted `rekeySession` action existed to avoid;
 *  - **eviction happens in the replica**, because a store-side strip would be
 *    undone by the very next projection.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSessionStore } from '../session-store'
import {
  getReplicaState,
  hydrateReplica,
  patchLocalSession,
  seedColdSession,
  seedWatchedSession,
  evictLocalSessions,
  dropLocalSessions,
  onReplicaApplied,
  resolveRekeyed,
  isLocallyCreated
} from '../replica'
import { seed, seedSession, emitSync, resetReplicaSeam } from '@test/helpers/replica-seed'
import { toSnapshot } from '../../../../core/shared/sync/state'
import { overlayItemStreams } from '../../../../core/shared/sync/item-stream'
import { makeAssistantMessage, makeSessionStatus } from '@test/factories/messages'

const store = (): ReturnType<typeof useSessionStore.getState> => useSessionStore.getState()

beforeEach(() => {
  resetReplicaSeam()
  useSessionStore.setState({
    activeSessionId: null,
    sessions: {},
    directories: [],
    recentSessionIds: [],
    pinnedSessionIds: [],
    customTitles: {},
    worktreeInfoMap: {},
    sessionEngines: {},
    hiddenSessionIds: [],
    hiddenProjectKeys: [],
    slashCommands: [],
    sdkSkillNames: []
  })
  ;(globalThis as unknown as { window: { api: unknown } }).window = { api: {} } as never
})

describe('the fold projects into the store', () => {
  it('creates a store entry for a session it learns of from the stream', () => {
    seed.created('r1', { cwd: '/project' })
    expect(store().sessions['r1']).toBeDefined()
    expect(store().sessions['r1'].cwd).toBe('/project')
    expect(store().sessions['r1'].sdkActive).toBe(true)
  })

  it('projects item deltas in place and seals the committed message', () => {
    seed.created('r1', { cwd: '/p' })
    seed.streamThinking('r1', 'hmm ')
    let session = store().sessions['r1']
    expect(overlayItemStreams(session.messages, session.itemStreams)[0].content[0]).toEqual({
      type: 'thinking',
      text: 'hmm '
    })

    seed.streamThinking('r1', 'more')
    session = store().sessions['r1']
    expect(overlayItemStreams(session.messages, session.itemStreams)[0].content[0]).toEqual({
      type: 'thinking',
      text: 'hmm more'
    })
    const target = {
      messageId: 'fixture-r1-assistant-thinking',
      blockIndex: 0,
      kind: 'thinking' as const
    }
    emitSync('session:item-seal', [
      'r1',
      {
        target,
        message: {
          id: target.messageId,
          role: 'assistant',
          timestamp: 1,
          content: [{ type: 'thinking', text: 'Final thought', durationMs: 1250 }]
        }
      }
    ])
    session = store().sessions['r1']
    expect(session.itemStreams).toEqual({})
    expect(session.messages[0].content[0]).toEqual({
      type: 'thinking',
      text: 'Final thought',
      durationMs: 1250
    })
  })

  it('leaves per-client VIEW state untouched', () => {
    seed.created('r1', { cwd: '/p' })
    useSessionStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        r1: {
          ...s.sessions['r1'],
          draftText: 'half-typed',
          rightPanel: 'git',
          needsAttention: true,
          errors: ['a transient toast']
        }
      }
    }))

    seed.message('r1', makeAssistantMessage('hi'))

    const session = store().sessions['r1']
    expect(session.draftText).toBe('half-typed')
    expect(session.rightPanel).toBe('git')
    expect(session.needsAttention).toBe(true)
    expect(session.errors).toEqual(['a transient toast'])
    expect(session.messages).toHaveLength(1)
  })

  it('keeps a background owner item active when the parent session becomes idle', () => {
    seed.created('r1', { cwd: '/p' })
    seed.subagentStreamText('r1', 'background-tool', 'still working')
    seed.status('r1', makeSessionStatus({ state: 'idle' }))

    const stream = Object.values(store().sessions['r1'].itemStreams)[0]
    expect(stream.target.ownerToolUseId).toBe('background-tool')
    expect(stream.value).toBe('still working')
  })

  it('does not re-write slices the event did not touch (identity-diffed)', () => {
    seed.created('r1', { cwd: '/p' })
    seed.created('r2', { cwd: '/q' })
    const beforeR2 = store().sessions['r2']
    const beforeRecents = store().recentSessionIds
    const beforeSettings = store().settings

    seed.streamText('r1', 'tokens')

    // Same references: an unrelated session and every app-level slice are skipped,
    // which is what stops a mid-flight local write from being reverted by the next
    // delta (and what keeps subscribers from re-rendering on every token).
    expect(store().sessions['r2']).toBe(beforeR2)
    expect(store().recentSessionIds).toBe(beforeRecents)
    expect(store().settings).toBe(beforeSettings)
  })

  it('projects the app-level worktree map onto each session, so the exit rule clears both', () => {
    seed.created('r1', { cwd: '/wt/feature' })
    emitSync('config:sessions-changed', [
      {
        worktreeInfoMap: {
          r1: {
            worktreePath: '/wt/feature',
            worktreeBranch: 'feature',
            worktreeName: 'feature',
            originalCwd: '/project',
            gitRoot: '/project',
            originalHeadCommit: '',
            createdAt: 0
          }
        }
      }
    ])
    expect(store().sessions['r1'].worktreeInfo?.worktreeName).toBe('feature')

    // cwd back to the original ⇒ the reducer drops the map entry ⇒ the per-session
    // mirror clears with it, through one code path instead of two.
    seed.status('r1', makeSessionStatus({ state: 'idle', cwd: '/project' }))
    expect(store().worktreeInfoMap['r1']).toBeUndefined()
    expect(store().sessions['r1'].worktreeInfo).toBeNull()
  })
})

describe('post-apply observers', () => {
  it('run after the fold is committed, so they read fresh state', () => {
    const seen: Array<[string, number]> = []
    onReplicaApplied((channel) => {
      seen.push([channel, store().sessions['r1']?.messages.length ?? -1])
    })
    seed.created('r1', { cwd: '/p' })
    seed.message('r1', makeAssistantMessage('hi'))

    expect(seen).toEqual([
      ['session:created', 0],
      ['session:message', 1]
    ])
  })

  it('run for non-canonical channels too — a transient handler still needs the hook', () => {
    const seen: string[] = []
    onReplicaApplied((channel) => seen.push(channel))
    emitSync('usage:data', [{}])
    expect(seen).toEqual(['usage:data'])
  })

  it('one throwing observer does not stop the others', () => {
    const seen: string[] = []
    onReplicaApplied(() => {
      throw new Error('boom')
    })
    onReplicaApplied((channel) => seen.push(channel))
    emitSync('usage:data', [{}])
    expect(seen).toEqual(['usage:data'])
  })
})

/**
 * Fake a `window.api` whose registry write fails, and hand back its log relay.
 * The rekey tap's last line reaches disk through `saveSessionConfig`, so this is
 * the only seam a renderer test has for "the persist threw".
 */
function failingPersist(): ReturnType<typeof vi.fn> {
  const logRelay = vi.fn()
  ;(globalThis as unknown as { window: { api: unknown } }).window = {
    api: {
      logRelay,
      saveSessionConfig: () => {
        throw new Error('disk full')
      }
    }
  } as never
  return logRelay
}

describe('rekey', () => {
  it('carries the view state to the new id and leaves no ghost', () => {
    seed.created('old', { cwd: '/p' })
    useSessionStore.setState((s) => ({
      activeSessionId: 'old',
      sessions: { ...s.sessions, old: { ...s.sessions['old'], draftText: 'keep me' } }
    }))
    seed.message('old', makeAssistantMessage('before'))

    seed.rekey('old', 'sdk-1')

    expect(store().sessions['old']).toBeUndefined()
    expect(store().sessions['sdk-1'].draftText).toBe('keep me')
    expect(store().sessions['sdk-1'].messages).toHaveLength(1)
    expect(store().activeSessionId).toBe('sdk-1')
  })

  it('remembers where a retired id went', () => {
    // The move is the only record that the old id ever named this session, and it
    // is erased in the same tick. A caller holding the pre-rekey id across an
    // await (InputBox's send) has nothing else to ask.
    seed.created('old', { cwd: '/p' })
    seed.rekey('old', 'sdk-1')
    expect(resolveRekeyed('old')).toBe('sdk-1')
  })

  it('resolves an id it has no rekey for to itself', () => {
    expect(resolveRekeyed('never-moved')).toBe('never-moved')
  })

  it('carries the local-creation marker even when persisting the registry throws', () => {
    // The persistence reaches disk through `window.api.saveSessionConfig` and can
    // fail; the in-memory bookkeeping must not be a casualty. A still-private
    // session that loses its marker stops being droppable by the empty-session
    // cleanup, so an abandoned scratch session is stranded in the sidebar. The
    // failed write is absorbed in the tap, so the fold itself does not throw —
    // which is what leaves the observers below it reachable (see the next case).
    failingPersist()
    seedSession('local-only', { cwd: '/p' })
    expect(isLocallyCreated('local-only')).toBe(true)

    expect(() => seed.rekey('local-only', 'sdk-1')).not.toThrow()

    expect(isLocallyCreated('sdk-1')).toBe(true)
    expect(isLocallyCreated('local-only')).toBe(false)
    expect(resolveRekeyed('local-only')).toBe('sdk-1')
  })

  it('still runs the post-apply observers when persisting the registry throws', () => {
    // The persist is deliberately LAST in the tap, after every in-memory line —
    // but a throw there used to take the observer loop with it, because
    // `SyncClient` fences the whole tap. The observers are the side-effect halves
    // of the old handlers: notification sounds, attention marks, the historical
    // transcript load, the F4 projection audit. A `sessions.json` write that fails
    // must cost the write, not the turn's side effects.
    failingPersist()
    const seen: Array<[string, unknown[]]> = []
    onReplicaApplied((channel, args) => seen.push([channel, args]))
    seedSession('local-only', { cwd: '/p' })

    seed.rekey('local-only', 'sdk-1')

    expect(seen).toHaveLength(1)
    expect(seen[0][0]).toBe('session:status')
    expect(seen[0][1][0]).toBe('local-only')
  })

  it('relays one warn line when the rekey persist throws', () => {
    // Swallowing the failure silently would trade a skipped observer for an
    // invisible one; the line names the new id and the underlying error so a log
    // reader can tell a full disk from a missing bridge.
    const logRelay = failingPersist()
    seedSession('local-only', { cwd: '/p' })

    seed.rekey('local-only', 'sdk-1')

    expect(logRelay).toHaveBeenCalledTimes(1)
    const [level, source, message] = logRelay.mock.calls[0] as [string, string, string]
    expect(level).toBe('warn')
    expect(source).toBe('Replica')
    expect(message).toContain('sdk-1')
    expect(message).toContain('disk full')
  })

  it('follows a chain of rekeys to the current id', () => {
    seed.created('a', { cwd: '/p' })
    seed.rekey('a', 'b')
    seed.rekey('b', 'c')
    expect(resolveRekeyed('a')).toBe('c')
    expect(resolveRekeyed('b')).toBe('c')
  })
})

describe('sanctioned local writes', () => {
  it('patchLocalSession survives the next projection', () => {
    seed.created('r1', { cwd: '/p' })
    patchLocalSession('r1', { selectedEngineId: 'opencode', selectedModel: 'zen/mimo' })
    // An unrelated event must NOT revert it — the whole reason the pick goes through
    // the replica rather than straight into the store.
    seed.streamText('r1', 'x')
    expect(store().sessions['r1'].selectedEngineId).toBe('opencode')
    expect(store().sessions['r1'].selectedModel).toBe('zen/mimo')
  })

  it('patchLocalSession no-ops for an unknown id unless asked to create', () => {
    patchLocalSession('ghost', { selectedModel: 'opus' })
    expect(store().sessions['ghost']).toBeUndefined()
    patchLocalSession('ghost', { selectedModel: 'opus' }, { create: true })
    expect(store().sessions['ghost'].selectedModel).toBe('opus')
  })

  it('seedColdSession fills an empty transcript', () => {
    patchLocalSession('r1', { cwd: '/p' }, { create: true })
    seedColdSession('r1', { messages: [makeAssistantMessage('from disk')] })
    expect(store().sessions['r1'].messages).toHaveLength(1)
  })

  it('seedColdSession refuses to clobber a live transcript', () => {
    seed.created('r1', { cwd: '/p' })
    seed.message('r1', makeAssistantMessage('live'))
    // A slow `loadSessionHistory` resolving mid-turn must not wipe the turn.
    seedColdSession('r1', { messages: [makeAssistantMessage('stale from disk')] })
    expect(store().sessions['r1'].messages).toHaveLength(1)
    expect(store().sessions['r1'].messages[0].content[0]).toMatchObject({ text: 'live' })
  })

  it('seedWatchedSession REPLACES, where the cold seed would have frozen it', () => {
    seed.created('r1', { cwd: '/p' })
    seed.message('r1', makeAssistantMessage('live'))
    // A watched session's `.jsonl` is its own only writer and only grows, so the
    // refetch this serves must overwrite — the fill-only twin above would pin the
    // transcript to whatever the first read returned.
    seedWatchedSession('r1', { messages: [makeAssistantMessage('from disk')] })
    expect(store().sessions['r1'].messages).toHaveLength(1)
    expect(store().sessions['r1'].messages[0].content[0]).toMatchObject({ text: 'from disk' })
  })

  it('seedWatchedSession NO-OPS for an unknown id (a refetch racing a delete)', () => {
    // The client half of the F7 pairing: the refetch is async, so a read can
    // resolve after `session:removed` dropped the entry. Unlike the host's seed
    // — which bootstraps, because a watched session has no birth event — this one
    // is a refresh of something the client already has, never an introduction.
    seedWatchedSession('never-seen-id', { messages: [makeAssistantMessage('from disk')] })
    expect(store().sessions['never-seen-id']).toBeUndefined()
    expect(getReplicaState().sessions['never-seen-id']).toBeUndefined()
  })

  it('evictLocalSessions strips the heavy arrays through the projection', () => {
    seed.created('r1', { cwd: '/p' })
    seed.message('r1', makeAssistantMessage('big transcript'))
    seed.subagentStreamText('r1', 'agent-1', 'partial')

    evictLocalSessions(['r1'])

    const session = store().sessions['r1']
    expect(session.messages).toEqual([])
    expect(session.itemStreams).toEqual({})
    // The lightweight entry stays resident — draft, engine, mode all survive.
    expect(session.cwd).toBe('/p')
    // A later lifecycle starts from a fresh scaffold; it does not resurrect the transcript.
    seed.streamText('r1', 'x')
    expect(store().sessions['r1'].messages).toHaveLength(1)
    expect(store().sessions['r1'].messages[0].content[0]).toEqual({ type: 'text', text: '' })
  })

  it('dropLocalSessions removes the entry from canonical', () => {
    seed.created('r1', { cwd: '/p' })
    dropLocalSessions(['r1'])
    expect(getReplicaState().sessions['r1']).toBeUndefined()
  })
})

describe('hydration', () => {
  it('rebuilds the store from a snapshot alone', () => {
    seed.created('r1', { cwd: '/p' })
    seed.message('r1', makeAssistantMessage('turn one'))
    const snapshot = toSnapshot(getReplicaState(), 7)

    resetReplicaSeam()
    useSessionStore.setState({ sessions: {}, activeSessionId: null, recentSessionIds: [] })
    hydrateReplica({ ...snapshot, recentSessionIds: ['r1'] }, false)

    expect(store().sessions['r1'].messages).toHaveLength(1)
    // Selection is resolved LOCALLY (ADR-041): core serves null, the client lands on
    // the most recent session the snapshot knows about.
    expect(store().activeSessionId).toBe('r1')
  })

  it('a resync keeps a local-only session the host has never seen', () => {
    // A phone that navigated to a historical session: read from disk, so canonical
    // knows nothing about it. Replacing the map would strand the next prompt.
    patchLocalSession('local-only', { cwd: '/disk' }, { create: true })
    seed.created('r1', { cwd: '/p' })
    const snapshot = toSnapshot(
      { ...getReplicaState(), sessions: { r1: getReplicaState().sessions['r1'] } },
      9
    )

    useSessionStore.setState({ activeSessionId: 'local-only' })
    hydrateReplica(snapshot, true)

    expect(store().sessions['local-only']).toBeDefined()
    expect(store().sessions['r1']).toBeDefined()
    // ...and the client stays where it navigated to.
    expect(store().activeSessionId).toBe('local-only')
  })

  it('a snapshot with no sessions cannot blank the app-level catalogs', () => {
    // They ride the wire PER SESSION (an as-built quirk `toSnapshot` preserves), so
    // an empty snapshot genuinely cannot carry them — see shared/sync/state.ts.
    seed.skills('r1', ['skill-a'])
    expect(store().sdkSkillNames).toEqual(['skill-a'])

    hydrateReplica(toSnapshot({ ...getReplicaState(), sessions: {} }, 11), true)

    expect(store().sdkSkillNames).toEqual(['skill-a'])
  })
})

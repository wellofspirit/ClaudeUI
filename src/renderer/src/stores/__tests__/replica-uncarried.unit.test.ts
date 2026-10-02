/**
 * A snapshot that does not carry a transcript (ADR-087 §2) — the client half.
 *
 * The host drops an exited session's transcript and says `seeded: false`; the
 * client must (a) mark such a session evicted, because the sidebar reloads from
 * disk only for an evicted entry, and (b) when it is the session on screen, read
 * it from disk and REPLACE — on a resync without ever showing an empty chat.
 *
 * The snapshots here come from a real `SyncCore`, so the wire shape under test is
 * the one the host actually produces.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { SyncCore } from '../../../../core/sync/sync-core'
import type { FullStateSnapshot } from '../../../../shared/remote-protocol'
import type { ChatMessage, SessionInfo, SessionStatus } from '../../../../shared/types'
import { markViewEvicted, useSessionStore } from '../session-store'
import { getReplicaState, hydrateReplica, patchLocalSession } from '../replica'
import {
  finishHydrate,
  loadSessionIntoStore,
  reloadActiveTranscript,
  replaceOnClick
} from '../../lib/session-history-load'
import { resetReplicaSeam } from '@test/helpers/replica-seed'

const store = (): ReturnType<typeof useSessionStore.getState> => useSessionStore.getState()

const message = (id: string): ChatMessage => ({
  id,
  role: 'assistant',
  content: [{ type: 'text', text: id }],
  timestamp: 1
})

const GONE_INFO: SessionInfo = {
  sessionId: 'gone',
  cwd: '/p',
  projectKey: '-p',
  title: 'gone',
  timestamp: 1,
  lastActivityAt: 1
}

function exitStatus(id: string): SessionStatus {
  return {
    state: 'disconnected',
    sessionId: id,
    model: null,
    cwd: null,
    totalCostUsd: 0,
    engineId: 'claude',
    capabilities: undefined as never,
    account: null
  } as SessionStatus
}

/** A host with one live session and one whose engine has exited. */
function host(listed = true): {
  core: SyncCore
  beforeExit: () => FullStateSnapshot
  exit: () => void
} {
  const core = new SyncCore()
  core.emit('session:created', ['live', { cwd: '/p' }])
  core.emit('session:message', ['live', message('live-1')])
  core.emit('session:created', ['gone', { cwd: '/p' }])
  core.emit('session:message', ['gone', message('g1')])
  core.emit('session:message', ['gone', message('g2')])
  core.setAppState({
    directories: listed
      ? [{ cwd: '/p', projectKey: '-p', folderName: 'p', sessions: [GONE_INFO] }]
      : [],
    recentSessionIds: ['gone', 'live']
  })
  return {
    core,
    beforeExit: () => core.getSnapshot(),
    exit: () => core.emit('session:status', ['gone', exitStatus('gone')])
  }
}

const loadSessionHistory = vi.fn()
const logRelay = vi.fn()

function history(...ids: string[]): unknown {
  return {
    messages: ids.map(message),
    taskNotifications: [],
    customTitle: null,
    agentIdToToolUseId: {},
    statusLine: null,
    warnings: []
  }
}

beforeEach(() => {
  resetReplicaSeam()
  loadSessionHistory.mockReset()
  logRelay.mockReset()
  ;(globalThis as unknown as { window: { api: unknown } }).window = {
    api: {
      loadSessionHistory,
      loadSubagentHistory: vi.fn(async () => []),
      saveSessionConfig: vi.fn(),
      logRelay
    }
  } as never
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
})

describe('hydrating a snapshot that dropped an exited session', () => {
  it('marks a non-active uncarried session evicted, so the sidebar click reloads it from disk', async () => {
    const h = host()
    h.exit()
    // `live` is first in recents here, so it is the session on screen.
    hydrateReplica({ ...h.core.getSnapshot(), recentSessionIds: ['live', 'gone'] }, false)

    expect(store().activeSessionId).toBe('live')
    const gone = store().sessions['gone']
    expect(gone.messages).toEqual([])
    // Exactly what `handleClickSession` tests before taking its resident fast path.
    expect(gone.evicted).toBe(true)
    expect(gone.isHistorical).toBe(true)
    expect(getReplicaState().sessions['gone'].seeded).toBe(false)
    expect(store().sessions['live'].evicted).toBe(false)
    expect(store().sessions['live'].messages).toHaveLength(1)

    // The click path: same loader the sidebar runs, filling the evicted entry.
    loadSessionHistory.mockResolvedValue(history('g1', 'g2'))
    const loaded = await loadSessionIntoStore(GONE_INFO, {
      isCurrent: () => true,
      markRecent: true
    })

    expect(loaded).toBe('loaded')
    expect(loadSessionHistory).toHaveBeenCalledWith('gone', '-p')
    expect(store().sessions['gone'].messages.map((m) => m.id)).toEqual(['g1', 'g2'])
    expect(store().sessions['gone'].evicted).toBe(false)
  })

  it('a carried session is untouched and nothing needs a reload', () => {
    const h = host()
    expect(hydrateReplica({ ...h.core.getSnapshot(), recentSessionIds: ['gone'] }, false)).toEqual({
      reloadActive: null,
      fillResumed: []
    })
    expect(store().sessions['gone'].evicted).toBe(false)
    expect(store().sessions['gone'].messages).toHaveLength(2)
  })

  it('FRESH hydrate onto an uncarried active session: returns its id, then the reload fills it', async () => {
    const h = host()
    h.exit()

    const outcome = hydrateReplica({ ...h.core.getSnapshot(), recentSessionIds: ['gone'] }, false)

    expect(outcome.reloadActive).toBe('gone')
    expect(store().sessions['gone'].messages).toEqual([])
    expect(store().sessions['gone'].evicted).toBe(true)

    loadSessionHistory.mockResolvedValue(history('g1', 'g2', 'g3'))
    await reloadActiveTranscript('gone')

    expect(store().sessions['gone'].messages.map((m) => m.id)).toEqual(['g1', 'g2', 'g3'])
    expect(store().sessions['gone'].evicted).toBe(false)
    // The recents list is the snapshot's: a reload is not a navigation.
    expect(store().recentSessionIds).toEqual(['gone'])
  })
})

describe('a RESYNC onto an uncarried active session', () => {
  /** Hydrate fully, sit on `gone`, then resync after the host dropped it. */
  function resyncOntoExit(): { uncarried: string | null } {
    const h = host()
    hydrateReplica({ ...h.beforeExit(), recentSessionIds: ['gone', 'live'] }, false)
    expect(store().activeSessionId).toBe('gone')
    expect(store().sessions['gone'].messages).toHaveLength(2)
    h.exit()
    return { uncarried: hydrateReplica(h.core.getSnapshot(), true).reloadActive }
  }

  it('keeps the local transcript on screen under the snapshot light fields', () => {
    const { uncarried } = resyncOntoExit()

    expect(uncarried).toBe('gone')
    expect(store().sessions['gone'].messages.map((m) => m.id)).toEqual(['g1', 'g2'])
    // Light fields still come from the snapshot: the host says the engine is gone.
    expect(store().sessions['gone'].sdkActive).toBe(false)
    // Not marked evicted — the chat holds a transcript, and a click must not blank it.
    expect(store().sessions['gone'].evicted).toBe(false)
    expect(store().activeSessionId).toBe('gone')
  })

  it('replaces it from disk in one step: no empty frame between the strip and the fill', async () => {
    resyncOntoExit()
    loadSessionHistory.mockReturnValue(
      new Promise((resolve) => setTimeout(() => resolve(history('d1', 'd2', 'd3')), 20))
    )
    // The strip and the fill are separate store writes in ONE synchronous turn, so
    // a per-write subscriber would see the gap but nothing can PAINT it. Sampling at
    // macrotask boundaries is the faithful proxy for "no empty frame": a strip that
    // waited for a later task to fill would show up as a zero here.
    const seen: number[] = []
    const sampler = setInterval(() => {
      seen.push(store().sessions['gone'].messages.length)
    }, 1)

    await reloadActiveTranscript('gone')
    await new Promise((resolve) => setTimeout(resolve, 5))
    clearInterval(sampler)

    expect(store().sessions['gone'].messages.map((m) => m.id)).toEqual(['d1', 'd2', 'd3'])
    expect(store().sessions['gone'].evicted).toBe(false)
    expect(seen).toContain(2)
    expect(seen).toContain(3)
    expect(seen).not.toContain(0)
  })

  it('a failed read leaves the local transcript intact and says why', async () => {
    resyncOntoExit()
    loadSessionHistory.mockRejectedValue(new Error('disk gone'))

    await reloadActiveTranscript('gone')

    expect(store().sessions['gone'].messages.map((m) => m.id)).toEqual(['g1', 'g2'])
    // The transcript stays on screen, but it is no longer presented as complete: the
    // kept tail may be truncated, so the next click must reload it.
    expect(store().sessions['gone'].evicted).toBe(true)
    expect(logRelay).toHaveBeenCalledWith(
      'warn',
      'SessionHistory',
      expect.stringContaining('disk gone')
    )
  })

  it('an EMPTY read over a held transcript is a lost file, not a conversation that ended', async () => {
    resyncOntoExit()
    loadSessionHistory.mockResolvedValue(history())

    await reloadActiveTranscript('gone')

    expect(store().sessions['gone'].messages.map((m) => m.id)).toEqual(['g1', 'g2'])
    expect(store().sessions['gone'].evicted).toBe(true)
  })

  it('bails when the session went live while the read was in flight', async () => {
    resyncOntoExit()
    let release!: (value: unknown) => void
    loadSessionHistory.mockReturnValue(new Promise((resolve) => (release = resolve)))

    const pending = reloadActiveTranscript('gone')
    // A turn started meanwhile: events are folding into this transcript now.
    patchLocalSession('gone', { sdkActive: true })
    release(history('stale-1'))
    await pending

    expect(store().sessions['gone'].messages.map((m) => m.id)).toEqual(['g1', 'g2'])
    // A live session is never marked evicted: the flag would send a click over it.
    expect(store().sessions['gone'].evicted).toBe(false)
  })

  it('bails when the user navigated away while the read was in flight', async () => {
    resyncOntoExit()
    let release!: (value: unknown) => void
    loadSessionHistory.mockReturnValue(new Promise((resolve) => (release = resolve)))

    const pending = reloadActiveTranscript('gone')
    useSessionStore.setState({ activeSessionId: 'live' })
    release(history('d1'))
    await pending

    expect(store().sessions['gone'].messages.map((m) => m.id)).toEqual(['g1', 'g2'])
    // Abandoned for any reason but going live: the kept tail is unverified.
    expect(store().sessions['gone'].evicted).toBe(true)
  })
})

describe('reloadActiveTranscript when it cannot read', () => {
  it('leaves the view as it is for a session the directory listing does not know', async () => {
    const h = host(false)
    h.exit()
    hydrateReplica({ ...h.core.getSnapshot(), recentSessionIds: ['gone'] }, false)

    await reloadActiveTranscript('gone')

    expect(loadSessionHistory).not.toHaveBeenCalled()
    expect(store().sessions['gone'].messages).toEqual([])
    // Still evicted: the sidebar click can retry once the listing catches up.
    expect(store().sessions['gone'].evicted).toBe(true)
    expect(logRelay).toHaveBeenCalledWith('warn', 'SessionHistory', expect.stringContaining('gone'))
  })

  it('a failed read on a FRESH hydrate leaves an empty, still-evicted entry the sidebar can retry', async () => {
    const h = host()
    h.exit()
    hydrateReplica({ ...h.core.getSnapshot(), recentSessionIds: ['gone'] }, false)
    loadSessionHistory.mockRejectedValue(new Error('nope'))

    await reloadActiveTranscript('gone')

    expect(store().sessions['gone'].messages).toEqual([])
    expect(store().sessions['gone'].evicted).toBe(true)
  })
})

describe('the shared history loader, per engine', () => {
  it('opencode: seeds the engine, loads the transcript and bumps recents on a click', async () => {
    const loadOpencodeHistory = vi.fn(async () => ({
      messages: [message('o1')],
      statusLine: null,
      lastModel: null
    }))
    Object.assign(window.api, { loadOpencodeHistory })
    const info: SessionInfo = { ...GONE_INFO, sessionId: 'oc-1', engineId: 'opencode' }

    const loaded = await loadSessionIntoStore(info, { isCurrent: () => true, markRecent: true })

    expect(loaded).toBe('loaded')
    expect(loadOpencodeHistory).toHaveBeenCalledWith('oc-1')
    expect(store().sessionEngines['oc-1'].engineId).toBe('opencode')
    expect(store().sessions['oc-1'].messages.map((m) => m.id)).toEqual(['o1'])
    expect(store().recentSessionIds).toContain('oc-1')
  })

  it('opencode: a click paints an empty transcript when the engine is down; a replace does not', async () => {
    Object.assign(window.api, {
      loadOpencodeHistory: vi.fn(async () => Promise.reject(new Error('down')))
    })
    const info: SessionInfo = { ...GONE_INFO, sessionId: 'oc-2', engineId: 'opencode' }

    // Click: best effort, as before.
    expect(await loadSessionIntoStore(info, { isCurrent: () => true })).toBe('loaded')
    expect(store().sessions['oc-2'].messages).toEqual([])

    // Replace over a held transcript: the failure must not wipe it.
    patchLocalSession('oc-2', { messages: [message('held')] })
    expect(await loadSessionIntoStore(info, { isCurrent: () => true, replace: true })).toBe(
      'declined'
    )
    expect(store().sessions['oc-2'].messages.map((m) => m.id)).toEqual(['held'])
  })

  it('opencode: a replace restores the transcript without touching Recent', async () => {
    Object.assign(window.api, {
      loadOpencodeHistory: vi.fn(async () => ({
        messages: [message('new-1'), message('new-2')],
        statusLine: null,
        lastModel: null
      }))
    })
    const info: SessionInfo = { ...GONE_INFO, sessionId: 'oc-3', engineId: 'opencode' }
    patchLocalSession('oc-3', { messages: [message('held')] }, { create: true })

    expect(await loadSessionIntoStore(info, { isCurrent: () => true, replace: true })).toBe(
      'loaded'
    )

    expect(store().sessions['oc-3'].messages.map((m) => m.id)).toEqual(['new-1', 'new-2'])
    expect(store().recentSessionIds).not.toContain('oc-3')
  })

  it('a superseded load commits nothing', async () => {
    loadSessionHistory.mockResolvedValue(history('g1'))
    expect(await loadSessionIntoStore(GONE_INFO, { isCurrent: () => false })).toBe('skipped')
    expect(store().sessions['gone']).toBeUndefined()
  })

  it('codex: a failed read is reported through the caller and replaces nothing', async () => {
    loadSessionHistory.mockRejectedValue(new Error('app-server down'))
    const onCodexError = vi.fn()
    const info: SessionInfo = { ...GONE_INFO, sessionId: 'cx-1', engineId: 'codex' }

    const loaded = await loadSessionIntoStore(info, { isCurrent: () => true, onCodexError })

    expect(loaded).toBe('skipped')
    expect(onCodexError).toHaveBeenNthCalledWith(1, null)
    expect(onCodexError).toHaveBeenLastCalledWith(expect.stringContaining('Codex history'))
    expect(store().sessions['cx-1']).toBeUndefined()
  })
})

describe('the click path after an abandoned reload', () => {
  it('replaces a stale evicted tail instead of keeping it', async () => {
    const h = host()
    hydrateReplica({ ...h.beforeExit(), recentSessionIds: ['gone', 'live'] }, false)
    h.exit()
    hydrateReplica(h.core.getSnapshot(), true)
    loadSessionHistory.mockRejectedValue(new Error('disk gone'))
    await reloadActiveTranscript('gone')
    expect(store().sessions['gone'].evicted).toBe(true)
    expect(store().sessions['gone'].messages).toHaveLength(2)

    // What `handleClickSession` does for an evicted entry that is not live.
    expect(replaceOnClick(store().sessions['gone'])).toBe(true)
    loadSessionHistory.mockReset()
    loadSessionHistory.mockResolvedValue(history('d1', 'd2', 'd3'))
    const loaded = await loadSessionIntoStore(GONE_INFO, {
      isCurrent: () => true,
      markRecent: true,
      replace: replaceOnClick(store().sessions['gone'])
    })

    expect(loaded).toBe('loaded')
    expect(store().sessions['gone'].messages.map((m) => m.id)).toEqual(['d1', 'd2', 'd3'])
    expect(store().sessions['gone'].evicted).toBe(false)
  })

  it('a LIVE evicted entry stays fill-only, and a never-loaded one has nothing to replace', () => {
    patchLocalSession('busy', { sdkActive: true }, { create: true })
    patchLocalSession('quiet', { sdkActive: false }, { create: true })
    expect(replaceOnClick(store().sessions['busy'])).toBe(false)
    expect(replaceOnClick(store().sessions['quiet'])).toBe(true)
    expect(replaceOnClick(undefined)).toBe(false)
  })

  it('an empty evicted entry: replace is the same plain fill, even when the engine read fails', async () => {
    Object.assign(window.api, {
      loadOpencodeHistory: vi.fn(async () => Promise.reject(new Error('down')))
    })
    const info: SessionInfo = { ...GONE_INFO, sessionId: 'oc-9', engineId: 'opencode' }
    patchLocalSession('oc-9', {}, { create: true })
    markViewEvicted(['oc-9'])

    // Today's click on an empty entry paints it (empty) and navigates; replace mode
    // must not turn that into a silent no-op.
    expect(await loadSessionIntoStore(info, { isCurrent: () => true, replace: true })).toBe(
      'loaded'
    )
  })
})

describe('live sessions in a snapshot', () => {
  /** A host whose `resuming` session is mid-resume: live, history read not landed. */
  function midResumeHost(): SyncCore {
    const core = new SyncCore()
    core.emit('session:created', ['gone', { cwd: '/p' }])
    core.emit('session:created', ['resuming', { cwd: '/p', resumeSessionId: 'resuming' }])
    core.setAppState({
      directories: [
        {
          cwd: '/p',
          projectKey: '-p',
          folderName: 'p',
          sessions: [{ ...GONE_INFO, sessionId: 'resuming', title: 'resuming' }, GONE_INFO]
        }
      ],
      recentSessionIds: ['resuming']
    })
    return core
  }

  it('a live unseeded session is filled fold-style and NOT marked evicted', async () => {
    const core = midResumeHost()
    expect(core.getSnapshot().sessions['resuming'].seeded).toBe(false)
    expect(core.getSnapshot().sessions['resuming'].sdkActive).toBe(true)

    const outcome = hydrateReplica({ ...core.getSnapshot(), recentSessionIds: ['resuming'] }, false)

    expect(outcome.fillResumed).toEqual(['resuming'])
    expect(outcome.reloadActive).toBeNull()
    expect(store().sessions['resuming'].evicted).toBe(false)

    loadSessionHistory.mockResolvedValue(history('r1', 'r2'))
    finishHydrate(outcome)
    await vi.waitFor(() => expect(store().sessions['resuming'].messages).toHaveLength(2))

    // The same call the `session:created` observer makes: no fork anchor.
    expect(loadSessionHistory).toHaveBeenCalledWith('resuming', '-p', undefined)
    expect(store().sessions['resuming'].evicted).toBe(false)
    expect(store().sessions['resuming'].isHistorical).toBe(false)
  })

  it('the fill refuses to clobber live events that already arrived, and a failed read is logged', async () => {
    const core = midResumeHost()
    const outcome = hydrateReplica({ ...core.getSnapshot(), recentSessionIds: ['resuming'] }, false)
    patchLocalSession('resuming', { messages: [message('live-1')] })

    loadSessionHistory.mockResolvedValue(history('r1', 'r2'))
    finishHydrate(outcome)
    await vi.waitFor(() => expect(loadSessionHistory).toHaveBeenCalled())
    await Promise.resolve()
    expect(store().sessions['resuming'].messages.map((m) => m.id)).toEqual(['live-1'])

    loadSessionHistory.mockRejectedValue(new Error('disk gone'))
    finishHydrate(outcome)
    await vi.waitFor(() =>
      expect(logRelay).toHaveBeenCalledWith(
        'warn',
        'SessionHistory',
        expect.stringContaining('disk gone')
      )
    )
  })

  it('a dead unseeded session is marked evicted instead', () => {
    const core = midResumeHost()
    core.emit('session:status', ['resuming', exitStatus('resuming')])
    // A resume whose history read never landed before the engine exited: nothing was
    // ever folded in, so there is no transcript to drop - and none carried.
    expect(core.getSnapshot().sessions['resuming'].seeded).toBe(false)
    const outcome = hydrateReplica({ ...core.getSnapshot(), recentSessionIds: ['gone'] }, false)
    expect(outcome.fillResumed).toEqual([])
    expect(store().sessions['resuming'].evicted).toBe(true)
  })

  it('clears a stale evicted flag for a session the snapshot says is live and carried', () => {
    const h = host()
    hydrateReplica({ ...h.core.getSnapshot(), recentSessionIds: ['live', 'gone'] }, false)
    // A `session:created` missed in a gap left the flag on a running session.
    markViewEvicted(['live'])
    expect(store().sessions['live'].evicted).toBe(true)

    hydrateReplica({ ...h.core.getSnapshot(), recentSessionIds: ['live', 'gone'] }, true)

    expect(store().sessions['live'].evicted).toBe(false)
    expect(store().sessions['live'].messages).toHaveLength(1)
  })
})

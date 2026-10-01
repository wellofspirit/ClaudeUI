/**
 * @vitest-environment node
 *
 * Canonical drops an exited session's transcript (ADR-087 §2).
 *
 * Canonical used to keep every transcript for the life of the process, so a
 * snapshot grew with host uptime. Eviction is a host CACHE decision, not an
 * event: nothing rings and nothing is delivered, connected replicas keep what
 * they folded, and only a snapshot says the transcript is gone
 * (`seeded: false`) so a client reads it from disk.
 */

import { describe, it, expect } from 'vitest'
import { SyncCore } from '../sync-core'
import { fromSnapshot, toSnapshot } from '../../shared/sync/state'
import type { ChatMessage, SessionStatus } from '../../../shared/types'

function status(overrides: Partial<SessionStatus> = {}): SessionStatus {
  return {
    state: 'running',
    sessionId: null,
    model: null,
    cwd: null,
    totalCostUsd: 0,
    engineId: 'claude',
    capabilities: undefined as never,
    account: null,
    ...overrides
  } as SessionStatus
}

const message = (id: string): ChatMessage => ({
  id,
  role: 'assistant',
  content: [{ type: 'text', text: id }],
  timestamp: 1
})

/** A live session with a folded transcript, a subagent bucket and light state. */
function liveSession(): { core: SyncCore; delivered: string[] } {
  const core = new SyncCore()
  const delivered: string[] = []
  core.setDelivery((_seq, channel) => delivered.push(channel))
  core.emit('session:created', ['rid', { cwd: '/x' }])
  core.emit('session:message', ['rid', message('m1')])
  core.emit('session:message', ['rid', message('m2')])
  core.emit('session:subagent-message', ['rid', { toolUseId: 'task-1', message: message('sub-1') }])
  core.emit('session:status', ['rid', status({ sessionId: 'rid', totalCostUsd: 1.5 })])
  core.emit('session:permission-mode', ['rid', 'plan'])
  return { core, delivered }
}

const exit = (core: SyncCore, id = 'rid'): void =>
  core.emit('session:status', [
    id,
    status({ state: 'disconnected', sessionId: id, totalCostUsd: 1.5 })
  ])

describe('SyncCore — engine exit drops the transcript', () => {
  it('strips messages, subagent buckets and item streams, and marks the session unseeded', () => {
    const { core } = liveSession()
    expect(core.getCanonicalState().sessions['rid'].messages).toHaveLength(2)

    exit(core)

    const s = core.getCanonicalState().sessions['rid']
    expect(s.messages).toEqual([])
    expect(s.subagentMessages).toEqual({})
    expect(s.itemStreams).toEqual({})
    expect(s.itemStreamRevision).toBe(0)
    expect(s.seeded).toBe(false)
  })

  it('the snapshot entry says so: seeded:false and no transcript', () => {
    const { core } = liveSession()
    exit(core)

    const entry = core.getSnapshot().sessions['rid']
    expect(entry.seeded).toBe(false)
    expect(entry.messages).toEqual([])
    expect(entry.subagentMessages).toEqual({})
  })

  it('keeps the row and every light field', () => {
    const { core } = liveSession()
    exit(core)

    const s = core.getCanonicalState().sessions['rid']
    expect(s.cwd).toBe('/x')
    expect(s.permissionMode).toBe('plan')
    expect(s.status.totalCostUsd).toBe(1.5)
    expect(s.status.sessionId).toBe('rid')
    expect(s.sdkActive).toBe(false)
  })

  it('is a cache decision, not an event: only the status itself rings and is delivered', () => {
    const { core, delivered } = liveSession()
    const seqBefore = core.currentSeq()
    delivered.length = 0

    exit(core)

    expect(core.currentSeq()).toBe(seqBefore + 1)
    expect(delivered).toEqual(['session:status'])
    expect(core.getAfter(seqBefore)?.map((e) => e.channel)).toEqual(['session:status'])
  })

  it('evicts under the POST-rekey id when the exit status carries a new session id', () => {
    const core = new SyncCore()
    core.emit('session:created', ['temp-1', { cwd: '/x' }])
    core.emit('session:message', ['temp-1', message('m1')])

    core.emit('session:status', ['temp-1', status({ state: 'disconnected', sessionId: 'uuid-9' })])

    expect(Object.keys(core.getCanonicalState().sessions)).toEqual(['uuid-9'])
    expect(core.getCanonicalState().sessions['uuid-9'].messages).toEqual([])
    expect(core.getCanonicalState().sessions['uuid-9'].seeded).toBe(false)
  })

  it('an exit for a session canonical never heard of is a harmless no-op', () => {
    const core = new SyncCore()
    exit(core, 'ghost')
    expect(core.getCanonicalState().sessions).toEqual({})
  })

  it('a running status never evicts', () => {
    const { core } = liveSession()
    core.emit('session:status', ['rid', status({ state: 'running', sessionId: 'rid' })])
    core.emit('session:status', ['rid', status({ state: 'idle', sessionId: 'rid' })])
    expect(core.getCanonicalState().sessions['rid'].messages).toHaveLength(2)
    expect(core.getSnapshot().sessions['rid'].seeded).toBeUndefined()
  })
})

describe('SyncCore.evictTranscript — the live guard', () => {
  it('never strips a session whose engine is live', () => {
    const { core } = liveSession()
    core.evictTranscript('rid')
    expect(core.getCanonicalState().sessions['rid'].messages).toHaveLength(2)
    expect(core.getCanonicalState().sessions['rid'].seeded).toBe(true)
  })

  it('never strips a session that is live and idle between turns (sdkActive alone protects it)', () => {
    // The dominant case: the engine is up, no turn is running, `status.state` is
    // `idle`. Only the `sdkActive` half of the guard stands between this session and
    // an empty transcript.
    const { core } = liveSession()
    core.emit('session:status', ['rid', status({ state: 'idle', sessionId: 'rid' })])
    expect(core.getCanonicalState().sessions['rid'].sdkActive).toBe(true)
    expect(core.getCanonicalState().sessions['rid'].status.state).toBe('idle')

    core.evictTranscript('rid')

    expect(core.getCanonicalState().sessions['rid'].messages).toHaveLength(2)
    expect(core.getCanonicalState().sessions['rid'].seeded).toBe(true)
  })

  it('never strips a session that is running a turn even when sdkActive is false', () => {
    const { core } = liveSession()
    exit(core)
    core.seedSession('rid', { messages: [message('h1')] })
    // A status edge can say "running" for a session the exit just marked gone.
    core.emit('session:status', ['rid', status({ state: 'running', sessionId: 'rid' })])
    expect(core.getCanonicalState().sessions['rid'].sdkActive).toBe(false)

    core.evictTranscript('rid')

    expect(core.getCanonicalState().sessions['rid'].messages.map((m) => m.id)).toEqual(['h1'])
  })

  it('is a no-op for an unknown id', () => {
    const core = new SyncCore()
    core.evictTranscript('nope')
    expect(core.getCanonicalState().sessions).toEqual({})
  })

  it('a session that is live again is not stripped, and a later seed refills an evicted one', () => {
    const { core } = liveSession()
    exit(core)
    expect(core.getCanonicalState().sessions['rid'].messages).toEqual([])

    // Resume: the birth event marks the engine live; the history read then lands.
    core.emit('session:created', ['rid', { cwd: '/x', resumeSessionId: 'rid' }])
    // Mid-resume: the engine is live but canonical does not hold the transcript yet,
    // and a client that syncs right now must be told so.
    expect(core.getSnapshot().sessions['rid'].seeded).toBe(false)
    expect(core.getSnapshot().sessions['rid'].sdkActive).toBe(true)
    core.seedSession('rid', { messages: [message('m1'), message('m2')] })

    const s = core.getCanonicalState().sessions['rid']
    expect(s.messages.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(s.seeded).toBe(true)
    expect(core.getSnapshot().sessions['rid'].seeded).toBeUndefined()
  })
})

describe('SyncCore.evictTranscript — what it does not touch, and what it leaves alone', () => {
  it('a session that never held a transcript is not marked unseeded when it exits', () => {
    const core = new SyncCore()
    // Spawned, never prompted, then the engine timed out.
    core.emit('session:created', ['idle', { cwd: '/x' }])
    exit(core, 'idle')

    expect(core.getCanonicalState().sessions['idle'].seeded).toBe(true)
    // A fresh client would otherwise be told to read a conversation from disk that
    // does not exist, and Codex would try to resume a thread that never started.
    expect('seeded' in core.getSnapshot().sessions['idle']).toBe(false)
  })

  it('is idempotent: a second eviction changes nothing, not even the state object', () => {
    const { core } = liveSession()
    exit(core)
    const once = core.getCanonicalState()
    const snapshot = JSON.stringify(core.getSnapshot())

    core.evictTranscript('rid')

    expect(core.getCanonicalState()).toBe(once)
    expect(JSON.stringify(core.getSnapshot())).toBe(snapshot)
  })

  it('evict-then-seed equals a seed that was never preceded by an eviction', () => {
    const history = [message('h1'), message('h2')]
    const resumed = (evictFirst: boolean): SyncCore => {
      const core = new SyncCore()
      if (evictFirst) {
        core.emit('session:created', ['rid', { cwd: '/x' }])
        core.emit('session:message', ['rid', message('old')])
        core.emit('session:subagent-message', [
          'rid',
          { toolUseId: 'task-1', message: message('sub-old') }
        ])
        exit(core)
      }
      core.emit('session:created', ['rid', { cwd: '/x', resumeSessionId: 'rid' }])
      core.seedSession('rid', { messages: history })
      return core
    }

    const evicted = resumed(true).getCanonicalState().sessions['rid']
    const plain = resumed(false).getCanonicalState().sessions['rid']

    // The transcript fields and the flag are exactly what a seed alone produces; the
    // eviction left nothing of the old conversation behind.
    for (const field of [
      'messages',
      'subagentMessages',
      'itemStreams',
      'itemStreamRevision',
      'seeded'
    ] as const) {
      expect(evicted[field], field).toEqual(plain[field])
    }
  })
})

describe('the seeded flag on the wire', () => {
  it('is emitted for EVERY unseeded session — a dropped transcript and a resume still reading', () => {
    const core = new SyncCore()
    // Resumed, history read still in flight: unseeded but live.
    core.emit('session:created', ['resuming', { cwd: '/x', resumeSessionId: 'resuming' }])
    // Exited, transcript dropped.
    core.emit('session:created', ['gone', { cwd: '/x' }])
    core.emit('session:message', ['gone', message('m1')])
    exit(core, 'gone')
    // Complete.
    core.emit('session:created', ['full', { cwd: '/x' }])

    const sessions = core.getSnapshot().sessions
    expect(core.getCanonicalState().sessions['resuming'].seeded).toBe(false)
    // One rule — canonical does not hold this transcript — and `sdkActive` is how a
    // client tells "read it from disk" from "it is arriving".
    expect(sessions['resuming'].seeded).toBe(false)
    expect(sessions['resuming'].sdkActive).toBe(true)
    expect(sessions['gone'].seeded).toBe(false)
    expect(sessions['gone'].sdkActive).toBe(false)
    expect('seeded' in sessions['full']).toBe(false)
  })

  it('fromSnapshot restores seeded:false, and an older snapshot without the field restores seeded', () => {
    const { core } = liveSession()
    core.emit('session:created', ['full', { cwd: '/y' }])
    exit(core)
    const snapshot = core.getSnapshot()

    const restored = fromSnapshot(snapshot)
    expect(restored.sessions['rid'].seeded).toBe(false)
    expect(restored.sessions['full'].seeded).toBe(true)

    // A host that predates the field never sends it.
    const older = structuredClone(snapshot)
    delete older.sessions['rid'].seeded
    expect(fromSnapshot(older).sessions['rid'].seeded).toBe(true)
  })

  it('round-trips through toSnapshot unchanged', () => {
    const { core } = liveSession()
    exit(core)
    const once = toSnapshot(fromSnapshot(core.getSnapshot()), core.currentSeq())
    expect(once.sessions['rid'].seeded).toBe(false)
    expect(once.sessions['rid'].messages).toEqual([])
  })
})

describe('SyncCore.trackSeed / pendingSeed', () => {
  it('reports a read in flight and clears it when the read settles', async () => {
    const core = new SyncCore()
    let release!: () => void
    core.trackSeed(
      'rid',
      new Promise<void>((resolve) => {
        release = resolve
      })
    )
    const pending = core.pendingSeed('rid')
    expect(pending).toBeDefined()
    expect(core.pendingSeed('other')).toBeUndefined()

    release()
    await pending
    await Promise.resolve()
    expect(core.pendingSeed('rid')).toBeUndefined()
  })

  it('clears on failure too, and the wait itself never rejects', async () => {
    const core = new SyncCore()
    core.trackSeed('rid', Promise.reject(new Error('disk gone')))
    await expect(core.pendingSeed('rid')).resolves.toBeUndefined()
    await Promise.resolve()
    expect(core.pendingSeed('rid')).toBeUndefined()
  })

  it('a newer read for the same id is not cleared by the older one settling', async () => {
    const core = new SyncCore()
    let releaseOld!: () => void
    let releaseNew!: () => void
    core.trackSeed(
      'rid',
      new Promise<void>((resolve) => {
        releaseOld = resolve
      })
    )
    core.trackSeed(
      'rid',
      new Promise<void>((resolve) => {
        releaseNew = resolve
      })
    )
    releaseOld()
    await Promise.resolve()
    await Promise.resolve()
    expect(core.pendingSeed('rid')).toBeDefined()

    releaseNew()
    await core.pendingSeed('rid')
    await Promise.resolve()
    expect(core.pendingSeed('rid')).toBeUndefined()
  })
})

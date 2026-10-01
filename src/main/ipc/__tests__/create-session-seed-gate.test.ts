/**
 * @vitest-environment node
 *
 * A prompt sent right after a RESUME waits for canonical's history read
 * (ADR-087 §2).
 *
 * `SyncCore.seedSession` only fills an EMPTY transcript. `session:created` and
 * the history read are separate steps, so a prompt that landed in between used to
 * become the whole transcript — one turn, marked complete — and the history read
 * a no-op. Eviction makes every respawn start from an empty transcript, which
 * turned that rare race into the common path.
 *
 * Drives the real pieces: `prepareAndCreateSession` registers the read with core,
 * `sendPrompt` (the one entry both transports use) waits on it, and the real
 * reducer folds both. Only the engine sessions and the history reader are
 * stubbed; the reader is held open so the race is deterministic.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'

const { TEMP_HOME } = await vi.hoisted(async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  return { TEMP_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'create-seed-gate-')) }
})

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    homedir: () => TEMP_HOME,
    default: { ...actual, homedir: () => TEMP_HOME }
  }
})

vi.mock('../../../core/services/claude-session', () => ({ ClaudeSession: class {} }))
vi.mock('../../../core/opencode/OpencodeSession', () => ({ OpencodeSession: class {} }))
vi.mock('../../../core/pi/PiSession', () => ({ PiSession: class {} }))
vi.mock('../../../core/codex/CodexSession', () => ({ CodexSession: class {} }))
vi.mock('../../../core/providers/claude-spawn-prep', () => ({
  claudeSpawnPrep: vi.fn(async (model?: string) => ({ resolvedModel: model }))
}))
vi.mock('../../../core/opencode/opencode-spawn-prep', () => ({
  opencodeSpawnPrep: vi.fn(async (model?: string) => ({ resolvedModel: model }))
}))
vi.mock('../../../core/pi/pi-spawn-prep', () => ({
  piSpawnPrep: vi.fn(async (model?: string) => ({ resolvedModel: model }))
}))
vi.mock('../../../core/services/skill-scanner', () => ({ scanSkills: vi.fn(async () => []) }))
vi.mock('../../../core/services/claude-settings', () => ({ saveCleanupPeriodDays: vi.fn() }))
vi.mock('../../../core/services/ui-config', () => ({
  loadEngineConfig: () => ({}),
  saveSessionConfig: vi.fn()
}))
vi.mock('../../../core/services/cross-engine-dispatcher', () => ({
  crossEngineDispatcher: { dispatch: vi.fn(), stopDispatch: vi.fn(), disposeFor: vi.fn() },
  crossEngineDispatchAvailable: () => false
}))
vi.mock('../../../core/services/db', () => ({ getSessionMeta: () => undefined }))
vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

type History = {
  messages: unknown[]
  taskNotifications: unknown[]
  customTitle: null
  statusLine: null
  agentIdToToolUseId: Record<string, string>
  warnings: string[]
}
const { readSessionHistory } = vi.hoisted(() => ({
  readSessionHistory: vi.fn(
    async (_id: string, _key: string, _anchor?: string, _engine?: string): Promise<History> => {
      throw new Error('test must arrange the history read')
    }
  )
}))
vi.mock('../../../core/services/engine-history', () => ({ readSessionHistory }))

// Import AFTER mocks.
import { prepareAndCreateSession } from '../../../core/ipc/create-session'
import { sendPrompt } from '../../../core/ipc/handlers-core'
import { syncCore } from '../../../core/services/sync-host'
import type { SessionManager } from '../../../core/services/session-manager'

const RID = 'rid-resume'

const historyOf = (...ids: string[]): History => ({
  messages: ids.map((id) => ({
    id,
    role: 'assistant',
    content: [{ type: 'text', text: id }],
    timestamp: 1
  })),
  taskNotifications: [],
  customTitle: null,
  statusLine: null,
  agentIdToToolUseId: {},
  warnings: []
})

/** A read the test releases by hand — the whole point is the window it holds open. */
function heldRead(): { release: (h: History) => void; fail: (err: Error) => void } {
  let release!: (h: History) => void
  let fail!: (err: Error) => void
  readSessionHistory.mockImplementationOnce(
    () =>
      new Promise<History>((resolve, reject) => {
        release = resolve
        fail = reject
      })
  )
  return { release: (h) => release(h), fail: (err) => fail(err) }
}

function fakeManager(): { manager: SessionManager; runs: string[] } {
  const runs: string[] = []
  const session = {
    engineId: 'claude',
    willQueue: false,
    run: (prompt: string) => {
      runs.push(prompt)
    },
    enqueuePrompt: vi.fn()
  }
  const manager = { create: vi.fn(), get: () => session } as unknown as SessionManager
  return { manager, runs }
}

async function resume(manager: SessionManager): Promise<void> {
  await prepareAndCreateSession(manager, null, {
    routingId: RID,
    cwd: '/r/repo',
    resumeSessionId: RID,
    engineId: 'claude'
  })
}

const transcript = (): string[] =>
  (syncCore.getCanonicalState().sessions[RID]?.messages ?? []).map((m) =>
    m.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
  )

afterEach(() => {
  syncCore.resetCanonicalForTests()
  vi.clearAllMocks()
})

afterAll(() => {
  fs.rmSync(TEMP_HOME, { recursive: true, force: true })
})

describe('sendPrompt after a resume', () => {
  it('lands after the history, not instead of it', async () => {
    const { manager, runs } = fakeManager()
    const read = heldRead()
    await resume(manager)

    const sent = sendPrompt(manager, RID, 'hello')
    // Held: nothing reached the engine or the transcript while the read is open.
    expect(runs).toEqual([])
    expect(transcript()).toEqual([])

    read.release(historyOf('h1', 'h2'))
    await sent

    // PRE-FIX: the prompt folded onto the empty transcript first, `seedSession`
    // then saw a non-empty one and skipped the history — ['hello'].
    expect(transcript()).toEqual(['h1', 'h2', 'hello'])
    expect(runs).toEqual(['hello'])
    expect(syncCore.getCanonicalState().sessions[RID].seeded).toBe(true)
  })

  it('keeps two quick sends in the order they arrived', async () => {
    const { manager, runs } = fakeManager()
    const read = heldRead()
    await resume(manager)

    const first = sendPrompt(manager, RID, 'one')
    const second = sendPrompt(manager, RID, 'two')
    read.release(historyOf('h1'))
    await Promise.all([first, second])

    expect(runs).toEqual(['one', 'two'])
    expect(transcript()).toEqual(['h1', 'one', 'two'])
  })

  it('a failed history read does not wedge the prompt behind it', async () => {
    const { manager, runs } = fakeManager()
    const read = heldRead()
    await resume(manager)

    const sent = sendPrompt(manager, RID, 'hello')
    read.fail(new Error('disk gone'))
    await sent

    expect(runs).toEqual(['hello'])
    expect(transcript()).toEqual(['hello'])
    // And the gate is gone: the next send is synchronous again.
    expect(syncCore.pendingSeed(RID)).toBeUndefined()
  })

  it('stays synchronous when no read is in flight', async () => {
    const { manager, runs } = fakeManager()
    readSessionHistory.mockResolvedValueOnce(historyOf('h1'))
    await resume(manager)
    await syncCore.pendingSeed(RID)
    await Promise.resolve()

    const result = sendPrompt(manager, RID, 'hello')

    expect(result).toBeUndefined()
    expect(runs).toEqual(['hello'])
  })

  it('re-reads the session state after the wait: a session that became busy queues the prompt', async () => {
    const session = {
      engineId: 'claude',
      willQueue: false,
      run: vi.fn(),
      enqueuePrompt: vi.fn()
    }
    const manager = { create: vi.fn(), get: () => session } as unknown as SessionManager
    const read = heldRead()
    await resume(manager)

    const sent = sendPrompt(manager, RID, 'hello')
    // A turn started while the prompt waited (another client sent first, say).
    session.willQueue = true
    read.release(historyOf('h1'))
    await sent

    expect(session.run).not.toHaveBeenCalled()
    expect(session.enqueuePrompt).toHaveBeenCalledWith('hello', undefined, undefined)
    // Queued, not in the transcript: `session:user-message` means "this text is in
    // the transcript" (ADR-053).
    expect(transcript()).toEqual(['h1'])
  })

  it('a respawn that kept its seeded transcript does not make the first prompt wait', async () => {
    const { manager, runs } = fakeManager()
    // The session already holds a seeded, non-empty transcript — it was disposed and
    // recreated in place without passing through an exit.
    await prepareAndCreateSession(manager, null, { routingId: RID, cwd: '/r/repo' })
    syncCore.emit('session:message', [
      RID,
      { id: 'kept-1', role: 'assistant', content: [{ type: 'text', text: 'kept' }], timestamp: 1 }
    ])
    readSessionHistory.mockImplementationOnce(() => new Promise<History>(() => {}))

    await resume(manager)

    expect(readSessionHistory).toHaveBeenCalledTimes(1)
    expect(syncCore.pendingSeed(RID)).toBeUndefined()
    // The read is still pending forever, yet the prompt goes straight through.
    expect(sendPrompt(manager, RID, 'hello')).toBeUndefined()
    expect(runs).toEqual(['hello'])
    expect(transcript()).toEqual(['kept', 'hello'])
  })

  it('a fresh (non-resumed) session never waits', async () => {
    const { manager, runs } = fakeManager()
    await prepareAndCreateSession(manager, null, { routingId: RID, cwd: '/r/repo' })

    expect(sendPrompt(manager, RID, 'hello')).toBeUndefined()
    expect(runs).toEqual(['hello'])
    expect(readSessionHistory).not.toHaveBeenCalled()
  })

  it('still throws synchronously for a session that does not exist', () => {
    const manager = { get: () => undefined } as unknown as SessionManager
    expect(() => sendPrompt(manager, 'nope', 'hello')).toThrow('No session for routingId: nope')
  })

  it('reports a session that vanished while the prompt waited', async () => {
    let alive = true
    const session = { engineId: 'claude', willQueue: false, run: vi.fn(), enqueuePrompt: vi.fn() }
    const manager = {
      create: vi.fn(),
      get: () => (alive ? session : undefined)
    } as unknown as SessionManager
    const read = heldRead()
    await resume(manager)

    const sent = sendPrompt(manager, RID, 'hello')
    alive = false
    read.release(historyOf('h1'))

    await expect(sent).rejects.toThrow('No session for routingId')
    expect(session.run).not.toHaveBeenCalled()
  })
})

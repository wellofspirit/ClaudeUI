/**
 * @vitest-environment node
 *
 * Layer 1 unit tests for session-watcher.
 *
 * Strategy:
 * - Use real fs.watch against real temp files so the debounce→reload path
 *   actually fires. DO NOT mock fs or fs.watch.
 * - Mock `./claude-session` (heavy SDK/Electron deps, only used for its
 *   getExtraWindows() getter) and `./session-history` (heavy transitive
 *   Electron deps via ipc/session.ipc) so the test stays a unit test.
 * - Mock os.homedir() so CLAUDE_PROJECTS_DIR inside session-watcher points
 *   at our per-test temp dir.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { subscribeWindowToSync } from '../../../test/helpers/sync-subscriber-window'
import { clearSyncSubscribersForTests, syncCore } from '../../../core/services/sync-host'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// session-watcher's CLAUDE_PROJECTS_DIR is computed ONCE at module load via
// path.join(os.homedir(), ...). Override HOME/USERPROFILE BEFORE import so
// the constant points at a real, writable temp dir.
const { testHome, loadSessionHistoryMock } = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs')
  const os = require('node:os') as typeof import('node:os')
  const path = require('node:path') as typeof import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-watcher-home-'))
  process.env.HOME = dir
  process.env.USERPROFILE = dir
  return {
    testHome: dir,
    loadSessionHistoryMock: vi.fn(async (sessionId: string, projectKey: string) => ({
      messages: [
        { id: 'm-1', role: 'assistant', content: [{ type: 'text', text: 'hi' }], timestamp: 0 }
      ],
      taskNotifications: [],
      customTitle: null,
      agentIdToToolUseId: {},
      statusLine: null,
      _sessionId: sessionId,
      _projectKey: projectKey
    }))
  }
})

// claude-session is only used for `ClaudeSession.getExtraWindows()`. Stub it
// so we don't drag in the SDK.
vi.mock('../../../core/services/claude-session', () => ({
  ClaudeSession: {
    getExtraWindows: () => new Set()
  }
}))

vi.mock('../../../core/services/session-history', () => ({
  loadSessionHistory: (sessionId: string, projectKey: string) =>
    loadSessionHistoryMock(sessionId, projectKey)
}))

// Silence logger.
vi.mock('../../../core/services/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}))

// Import AFTER mocks.
import { watchSession, unwatchSession, unwatchAll } from '../../../core/services/session-watcher'

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface FakeWin {
  isDestroyed: () => boolean
  webContents: { send: ReturnType<typeof vi.fn> }
  _destroyed: boolean
}

/**
 * A stub window that is also a CLIENT (SyncCore phase 4c): `session:watch-update`
 * is replicated, so it reaches SUBSCRIBERS, not a privileged window. Subscribing
 * the stub keeps every `win.webContents.send` assertion below meaningful.
 */
function makeFakeWindow(): FakeWin {
  const win: FakeWin = {
    _destroyed: false,
    isDestroyed: () => win._destroyed,
    webContents: { send: vi.fn() }
  }
  subscribeWindowToSync(win as unknown as Parameters<typeof subscribeWindowToSync>[0])
  return win
}

interface TestCtx {
  projectKey: string
  sessionId: string
  projectDir: string
  filePath: string
}

async function setupCtx(seed = true): Promise<TestCtx> {
  const projectKey = '-test-' + Math.random().toString(36).slice(2, 10)
  const sessionId = 'sess-' + Math.random().toString(36).slice(2, 10)
  const projectDir = path.join(testHome, '.claude', 'projects', projectKey)
  await fsp.mkdir(projectDir, { recursive: true })
  const filePath = path.join(projectDir, `${sessionId}.jsonl`)
  if (seed) await fsp.writeFile(filePath, '')
  return { projectKey, sessionId, projectDir, filePath }
}

async function cleanupCtx(ctx: TestCtx): Promise<void> {
  unwatchAll()
  await new Promise((r) => setTimeout(r, 10))
  try {
    await fsp.rm(path.join(testHome, '.claude', 'projects', ctx.projectKey), {
      recursive: true,
      force: true,
      maxRetries: 5
    })
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('session-watcher', () => {
  let ctx: TestCtx

  beforeEach(async () => {
    loadSessionHistoryMock.mockClear()
    ctx = await setupCtx()
  })

  afterEach(async () => {
    clearSyncSubscribersForTests()
    await cleanupCtx(ctx)
  })

  it('emits session:watch-update via webContents.send when the JSONL file grows', async () => {
    const win = makeFakeWindow()
    watchSession('routing-1', ctx.sessionId, ctx.projectKey)

    // Cause a change on the watched file.
    await fsp.appendFile(ctx.filePath, JSON.stringify({ type: 'assistant' }) + '\n')

    await vi.waitFor(
      () => {
        expect(loadSessionHistoryMock).toHaveBeenCalledWith(ctx.sessionId, ctx.projectKey)
        expect(win.webContents.send).toHaveBeenCalled()
        const [channel, payload] = win.webContents.send.mock.calls[0]
        expect(channel).toBe('session:watch-update')
        expect(payload.routingId).toBe('routing-1')
        // The notify addresses the transcript; it no longer carries it (S4).
        expect(payload.sessionId).toBe(ctx.sessionId)
        expect(payload.projectKey).toBe(ctx.projectKey)
        expect('messages' in payload).toBe(false)
      },
      { timeout: 3000 }
    )
  })

  /**
   * S4's whole point: the RING entry is a notify, not a transcript.
   *
   * A watched session re-read its entire file into the event payload on every
   * change, so a 5000-entry ring could hold hundreds of full transcripts and
   * every reconnecting client replayed them. The content is a SEED now
   * (`SyncCore.seedWatchedSession`, applied before the notify), and canonical
   * still holds it — so this asserts both halves at once.
   */
  it('rings a NOTIFY, not the transcript, and canonical still holds the content', async () => {
    const before = syncCore.currentSeq()
    watchSession('routing-ring', ctx.sessionId, ctx.projectKey, '/repo/ring')

    await fsp.appendFile(ctx.filePath, JSON.stringify({ type: 'assistant' }) + '\n')

    await vi.waitFor(
      () => {
        const entries = syncCore.getAfter(before) ?? []
        const entry = entries.find((e) => e.channel === 'session:watch-update')
        expect(entry, 'no watch-update reached the ring').toBeDefined()
        const payload = entry!.args[0] as Record<string, unknown>
        // The bloat, gone: no transcript, no notifications, no status line.
        expect(Object.keys(payload).sort()).toEqual(['cwd', 'projectKey', 'routingId', 'sessionId'])
      },
      { timeout: 3000 }
    )

    // The content moved to the seed rather than being dropped, and the seed is
    // ordered BEFORE the notify, so a client refetching on the notify reads
    // state that already contains what the notify announces.
    const session = syncCore.getCanonicalState().sessions['routing-ring']
    expect(session.messages.map((m) => m.id)).toEqual(['m-1'])
    expect(session.cwd).toBe('/repo/ring')
    expect(session.seeded).toBe(true)
  })

  /**
   * The post-await race, closed by S4.
   *
   * The debounce callback AWAITS the file read, and a delete can land inside that
   * await — `handlers-core.deleteSession` unwatches first precisely because the
   * unlink makes the watcher fire one more time, but nothing stopped a read that
   * had ALREADY started. Its seed bootstraps by design and its notify's reducer
   * branch is the one that still bootstraps, so the pair re-minted the session
   * canonical had just removed: a `cwd`-carrying ghost in canonical and in every
   * replica, which is exactly what the unwatch exists to prevent.
   */
  it('a delete landing DURING the read leaves no ghost and emits no notify', async () => {
    const win = makeFakeWindow()
    const before = syncCore.currentSeq()
    let release: (() => void) | null = null
    loadSessionHistoryMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              messages: [
                {
                  id: 'm-1',
                  role: 'assistant',
                  content: [{ type: 'text', text: 'hi' }],
                  timestamp: 0
                }
              ],
              taskNotifications: [],
              customTitle: null,
              agentIdToToolUseId: {},
              statusLine: null,
              _sessionId: ctx.sessionId,
              _projectKey: ctx.projectKey
            })
        })
    )

    watchSession('routing-ghost', ctx.sessionId, ctx.projectKey, '/repo/ghost')
    await fsp.appendFile(ctx.filePath, JSON.stringify({ type: 'assistant' }) + '\n')
    await vi.waitFor(() => expect(loadSessionHistoryMock).toHaveBeenCalled(), { timeout: 3000 })

    // The delete, in production order: unwatch, THEN remove.
    unwatchSession('routing-ghost')
    release!()
    await new Promise((r) => setTimeout(r, 50))

    expect(syncCore.getCanonicalState().sessions['routing-ghost']).toBeUndefined()
    const entries = syncCore.getAfter(before) ?? []
    expect(
      entries.some(
        (e) =>
          e.channel === 'session:watch-update' &&
          (e.args[0] as { routingId?: string }).routingId === 'routing-ghost'
      )
    ).toBe(false)
    expect(win.webContents.send).not.toHaveBeenCalled()
  })

  /**
   * F2. `session:watch-update` is the ONLY event that introduces a watched
   * session — nothing spawns, so there is no `session:created` — which is why
   * its reducer branch is the one place `ensured()` still bootstraps an entry.
   * Without a cwd on the payload that entry was born with `cwd: ''`, and every
   * cwd-keyed feature missed it: git status, the folder name in the sidebar and
   * in notifications, the per-cwd terminal group, `deleteProject`'s live sweep.
   *
   * It has to be an ARGUMENT: `projectKey` is `cwdToProjectKey`'s output, which
   * is documented as lossy and irreversible.
   */
  it('carries the watched session cwd on the update payload', async () => {
    const win = makeFakeWindow()
    watchSession('routing-cwd', ctx.sessionId, ctx.projectKey, '/repo/work')

    await fsp.appendFile(ctx.filePath, JSON.stringify({ type: 'assistant' }) + '\n')

    await vi.waitFor(
      () => {
        expect(win.webContents.send).toHaveBeenCalled()
        const [, payload] = win.webContents.send.mock.calls[0]
        expect(payload.cwd).toBe('/repo/work')
      },
      { timeout: 3000 }
    )
  })

  it('omits cwd entirely when the caller had none (old-shape client)', async () => {
    // Omitted, not blanked: the reducer treats an absent cwd as "leave it alone",
    // so an old `/remote` bundle's 3-arg watch cannot erase a cwd another event
    // already established.
    const win = makeFakeWindow()
    watchSession('routing-nocwd', ctx.sessionId, ctx.projectKey)

    await fsp.appendFile(ctx.filePath, JSON.stringify({ type: 'assistant' }) + '\n')

    await vi.waitFor(
      () => {
        expect(win.webContents.send).toHaveBeenCalled()
        const [, payload] = win.webContents.send.mock.calls[0]
        expect('cwd' in payload).toBe(false)
      },
      { timeout: 3000 }
    )
  })

  it('coalesces multiple rapid writes into a single debounced update', async () => {
    const win = makeFakeWindow()
    watchSession('routing-burst', ctx.sessionId, ctx.projectKey)

    // Burst of writes within the 100ms debounce window.
    for (let i = 0; i < 5; i++) {
      await fsp.appendFile(ctx.filePath, JSON.stringify({ type: 'assistant', i }) + '\n')
    }

    // Wait for at least one update…
    await vi.waitFor(() => expect(win.webContents.send).toHaveBeenCalled(), { timeout: 3000 })
    const callsAfterBurst = win.webContents.send.mock.calls.length

    // Then one further write — the watcher should still be responsive and
    // deliver another update (in-order relative to the first batch).
    await fsp.appendFile(ctx.filePath, JSON.stringify({ type: 'assistant', final: true }) + '\n')

    await vi.waitFor(
      () => expect(win.webContents.send.mock.calls.length).toBeGreaterThan(callsAfterBurst),
      { timeout: 3000 }
    )

    // Every emitted update must target our routingId, in order (no stray
    // routing ids from a different watcher instance leaking in).
    for (const [channel, payload] of win.webContents.send.mock.calls) {
      expect(channel).toBe('session:watch-update')
      expect((payload as { routingId: string }).routingId).toBe('routing-burst')
    }
  })

  it('unwatchSession stops further updates', async () => {
    const win = makeFakeWindow()
    watchSession('routing-stop', ctx.sessionId, ctx.projectKey)

    await fsp.appendFile(ctx.filePath, JSON.stringify({ type: 'assistant' }) + '\n')
    await vi.waitFor(() => expect(win.webContents.send).toHaveBeenCalled(), { timeout: 3000 })

    unwatchSession('routing-stop')
    const callsBefore = win.webContents.send.mock.calls.length

    // Write after unwatch — no further events should fire.
    await fsp.appendFile(ctx.filePath, JSON.stringify({ type: 'assistant', after: true }) + '\n')
    // Wait well past the 100ms debounce.
    await new Promise((r) => setTimeout(r, 400))
    expect(win.webContents.send.mock.calls.length).toBe(callsBefore)
  })

  it('is a silent no-op when the JSONL file does not exist', async () => {
    // Fresh routingId + a sessionId whose file does NOT exist on disk.
    const win = makeFakeWindow()
    const missingSessionId = 'never-created-session'

    expect(() => watchSession('routing-missing', missingSessionId, ctx.projectKey)).not.toThrow()

    // No watcher was registered, so calling unwatch on it is also safe.
    expect(() => unwatchSession('routing-missing')).not.toThrow()

    // Later creating the file and writing to it should NOT produce events,
    // because session-watcher doesn't fall back to polling when the file is
    // absent at watch time (current contract; this test pins it).
    const filePath = path.join(ctx.projectDir, `${missingSessionId}.jsonl`)
    await fsp.writeFile(filePath, JSON.stringify({ type: 'assistant' }) + '\n')
    await new Promise((r) => setTimeout(r, 300))
    expect(win.webContents.send).not.toHaveBeenCalled()
  })

  it('re-watching the same routingId after unwatch works cleanly with no leaks', async () => {
    const win = makeFakeWindow()

    // First lifecycle: watch → event → unwatch.
    watchSession('routing-recycle', ctx.sessionId, ctx.projectKey)
    await fsp.appendFile(ctx.filePath, JSON.stringify({ type: 'assistant', cycle: 1 }) + '\n')
    await vi.waitFor(() => expect(win.webContents.send).toHaveBeenCalled(), { timeout: 3000 })
    const firstCycleCalls = win.webContents.send.mock.calls.length
    unwatchSession('routing-recycle')

    // Second lifecycle: watch again on the same routingId.
    watchSession('routing-recycle', ctx.sessionId, ctx.projectKey)
    await fsp.appendFile(ctx.filePath, JSON.stringify({ type: 'assistant', cycle: 2 }) + '\n')

    await vi.waitFor(
      () => expect(win.webContents.send.mock.calls.length).toBeGreaterThan(firstCycleCalls),
      { timeout: 3000 }
    )

    // Now sanity-check there isn't a duplicate/stale watcher: each write
    // should yield roughly one send call (within debounce coalescing),
    // not two per write.
    const beforeFinal = win.webContents.send.mock.calls.length
    await fsp.appendFile(ctx.filePath, JSON.stringify({ type: 'assistant', cycle: 3 }) + '\n')
    await vi.waitFor(
      () => expect(win.webContents.send.mock.calls.length).toBeGreaterThan(beforeFinal),
      { timeout: 3000 }
    )
    // Allow time for any would-be duplicate handler to also fire.
    await new Promise((r) => setTimeout(r, 300))
    const added = win.webContents.send.mock.calls.length - beforeFinal
    expect(added).toBeLessThanOrEqual(2) // one send, maybe a trailing debounce
    expect(added).toBeGreaterThanOrEqual(1)

    unwatchSession('routing-recycle')
  })
})

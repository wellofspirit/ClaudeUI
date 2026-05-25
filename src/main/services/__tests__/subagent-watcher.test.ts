/**
 * @vitest-environment node
 *
 * Layer 1 unit tests for subagent-watcher.
 *
 * These tests exercise the real fs.watch + chokidar-style debounced polling
 * pipeline against real temp dirs. We DO NOT mock fs — the whole point is to
 * catch regressions in the tail-and-parse loop.
 *
 * Only the logger is mocked, to silence warnings (malformed-line test is
 * expected to emit warnings).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'

// subagent-watcher's CLAUDE_PROJECTS_DIR is computed ONCE at module load via
// path.join(os.homedir(), ...). We set up a single test-home directory before
// the module is imported (vi.hoisted runs before any import, including the
// transitive os.homedir() call) and scope each test to a unique subfolder
// inside it.
const { testHome } = vi.hoisted(() => {
  // Node's os.homedir reads USERPROFILE on Windows, HOME/LOGNAME on Unix.
  // Override these BEFORE the target module is imported.
  const fs = require('node:fs') as typeof import('node:fs')
  const os = require('node:os') as typeof import('node:os')
  const path = require('node:path') as typeof import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-watcher-home-'))
  process.env.HOME = dir
  process.env.USERPROFILE = dir
  return { testHome: dir }
})

// Silence logger writes during tests.
vi.mock('../logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

// Import AFTER mocks are registered.
import {
  watchSubagent,
  unwatchSubagent,
  unwatchAllSubagents,
} from '../subagent-watcher'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestCtx {
  projectKey: string
  sessionId: string
  subagentDir: string
}

async function setupCtx(): Promise<TestCtx> {
  // Scope each test to a unique projectKey inside the shared testHome so
  // concurrent tests don't stomp on each other.
  const projectKey = '-test-' + Math.random().toString(36).slice(2, 10)
  const sessionId = 'session-' + Math.random().toString(36).slice(2, 10)
  const subagentDir = path.join(testHome, '.claude', 'projects', projectKey, sessionId, 'subagents')
  await fsp.mkdir(subagentDir, { recursive: true })
  return { projectKey, sessionId, subagentDir }
}

async function cleanupCtx(ctx: TestCtx): Promise<void> {
  unwatchAllSubagents()
  // Give fs.watch close handles a tick to release on Windows.
  await new Promise((r) => setTimeout(r, 10))
  try {
    await fsp.rm(path.join(testHome, '.claude', 'projects', ctx.projectKey), {
      recursive: true,
      force: true,
      maxRetries: 5,
    })
  } catch {
    /* ignore */
  }
}

/** Build a teammate JSONL line in the format the SDK writes. */
function teammateLine(type: 'user' | 'assistant', textOrBlocks: string | unknown[], opts: {
  uuid?: string
  userType?: string
  messageId?: string
} = {}): string {
  if (type === 'user') {
    return JSON.stringify({
      type: 'user',
      uuid: opts.uuid ?? `user-${Math.random().toString(36).slice(2)}`,
      userType: opts.userType ?? 'external',
      timestamp: new Date().toISOString(),
      message: {
        content: typeof textOrBlocks === 'string'
          ? [{ type: 'text', text: textOrBlocks }]
          : textOrBlocks,
      },
    }) + '\n'
  }
  // assistant
  return JSON.stringify({
    type: 'assistant',
    uuid: opts.uuid ?? `asst-uuid-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    message: {
      id: opts.messageId ?? `msg-${Math.random().toString(36).slice(2)}`,
      content: typeof textOrBlocks === 'string'
        ? [{ type: 'text', text: textOrBlocks }]
        : textOrBlocks,
    },
  }) + '\n'
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('subagent-watcher', () => {
  let ctx: TestCtx

  beforeEach(async () => {
    ctx = await setupCtx()
  })

  afterEach(async () => {
    await cleanupCtx(ctx)
  })

  it('parses initial contents and new appends when file grows', async () => {
    const teammateName = 'ts-advocate'
    const teamName = 'lang-debate'
    const filePath = path.join(ctx.subagentDir, `agent-${teammateName}--${teamName}.jsonl`)

    // Seed with one external user prompt so the watcher has something to parse
    // on initial read.
    const initialPrompt = 'Please review the TypeScript code carefully'
    await fsp.writeFile(filePath, teammateLine('user', initialPrompt))

    const sendFn = vi.fn()
    watchSubagent(
      'tool-use-1',
      ctx.sessionId,
      ctx.projectKey,
      initialPrompt,
      sendFn,
    )

    // Initial read should have already been flushed (startWatching calls it
    // synchronously before attaching the FSWatcher).
    await vi.waitFor(
      () => {
        expect(sendFn).toHaveBeenCalled()
        const firstCall = sendFn.mock.calls[0]
        expect(firstCall[0]).toBe('session:subagent-message-batch')
        expect((firstCall[1] as { toolUseId: string }).toolUseId).toBe('tool-use-1')
        expect((firstCall[1] as { messages: unknown[] }).messages.length).toBeGreaterThan(0)
      },
      { timeout: 2000 },
    )

    // Append an assistant message — the watcher should emit a second batch.
    const before = sendFn.mock.calls.length
    await fsp.appendFile(filePath, teammateLine('assistant', 'Here is my review'))

    await vi.waitFor(
      () => {
        expect(sendFn.mock.calls.length).toBeGreaterThan(before)
        const latest = sendFn.mock.calls[sendFn.mock.calls.length - 1]
        expect(latest[0]).toBe('session:subagent-message-batch')
        const payload = latest[1] as { messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }> }
        const assistantMsg = payload.messages.find((m) => m.role === 'assistant')
        expect(assistantMsg).toBeDefined()
        const textBlock = assistantMsg!.content.find((b) => b.type === 'text')
        expect((textBlock as { text: string }).text).toBe('Here is my review')
      },
      { timeout: 3000 },
    )
  })

  it('skips malformed JSONL lines without crashing', async () => {
    const teammateName = 'bug-tester'
    const teamName = 'qa-team'
    const filePath = path.join(ctx.subagentDir, `agent-${teammateName}--${teamName}.jsonl`)

    // Valid prompt + malformed line + valid assistant message.
    const prompt = 'Find bugs in the parser'
    const malformed = '{this is not valid json at all\n'
    const lines = [
      teammateLine('user', prompt),
      malformed,
      teammateLine('assistant', 'Found three bugs'),
    ].join('')
    await fsp.writeFile(filePath, lines)

    const sendFn = vi.fn()
    watchSubagent(
      'tool-use-malformed',
      ctx.sessionId,
      ctx.projectKey,
      prompt,
      sendFn,
    )

    // Initial batch should include the two valid messages and drop the
    // malformed one — never throw.
    await vi.waitFor(
      () => {
        expect(sendFn).toHaveBeenCalled()
        const payload = sendFn.mock.calls[0][1] as { messages: Array<{ role: string }> }
        const roles = payload.messages.map((m) => m.role)
        expect(roles).toContain('user')
        expect(roles).toContain('assistant')
        // Exactly two parseable messages, the malformed line was dropped.
        expect(payload.messages.length).toBe(2)
      },
      { timeout: 2000 },
    )
  })

  it('stops emitting after unwatchSubagent() is called', async () => {
    const teammateName = 'quiet-agent'
    const teamName = 'silent-team'
    const filePath = path.join(ctx.subagentDir, `agent-${teammateName}--${teamName}.jsonl`)
    const prompt = 'Initial work item description'
    await fsp.writeFile(filePath, teammateLine('user', prompt))

    const sendFn = vi.fn()
    watchSubagent(
      'tool-use-stop',
      ctx.sessionId,
      ctx.projectKey,
      prompt,
      sendFn,
    )

    // Wait for initial batch.
    await vi.waitFor(() => expect(sendFn).toHaveBeenCalled(), { timeout: 2000 })
    const callsAfterInitial = sendFn.mock.calls.length

    // Unwatch and then write more — nothing should be emitted.
    unwatchSubagent('tool-use-stop')
    await fsp.appendFile(filePath, teammateLine('assistant', 'should not be seen'))

    // Wait longer than the 150ms debounce window to confirm no event fires.
    await new Promise((r) => setTimeout(r, 500))
    expect(sendFn.mock.calls.length).toBe(callsAfterInitial)
  })

  it('keeps concurrent subagents isolated', async () => {
    const teamA = { name: 'agent-a', team: 'team-1' }
    const teamB = { name: 'agent-b', team: 'team-1' }
    const fileA = path.join(ctx.subagentDir, `agent-${teamA.name}--${teamA.team}.jsonl`)
    const fileB = path.join(ctx.subagentDir, `agent-${teamB.name}--${teamB.team}.jsonl`)

    await fsp.writeFile(fileA, teammateLine('user', 'Task A description here'))
    await fsp.writeFile(fileB, teammateLine('user', 'Task B description here'))

    const sendA = vi.fn()
    const sendB = vi.fn()
    watchSubagent('use-A', ctx.sessionId, ctx.projectKey, 'Task A description here', sendA)
    watchSubagent('use-B', ctx.sessionId, ctx.projectKey, 'Task B description here', sendB)

    // Wait for both initial reads.
    await vi.waitFor(
      () => {
        expect(sendA).toHaveBeenCalled()
        expect(sendB).toHaveBeenCalled()
      },
      { timeout: 2000 },
    )

    // All sendA payloads must reference toolUseId "use-A" only.
    for (const call of sendA.mock.calls) {
      expect((call[1] as { toolUseId: string }).toolUseId).toBe('use-A')
    }
    for (const call of sendB.mock.calls) {
      expect((call[1] as { toolUseId: string }).toolUseId).toBe('use-B')
    }

    // Append only to A — B must not receive new events.
    const bCallsBefore = sendB.mock.calls.length
    const aCallsBefore = sendA.mock.calls.length
    await fsp.appendFile(fileA, teammateLine('assistant', 'Only for A'))

    await vi.waitFor(
      () => {
        expect(sendA.mock.calls.length).toBeGreaterThan(aCallsBefore)
      },
      { timeout: 3000 },
    )

    // Give B's (nonexistent) debounce plenty of time — it should never fire.
    await new Promise((r) => setTimeout(r, 400))
    expect(sendB.mock.calls.length).toBe(bCallsBefore)
  })

  it('unwatchSubagent is idempotent; unwatchAllSubagents cleans up everything', async () => {
    const teammateName = 'cleanup-agent'
    const teamName = 'cleanup-team'
    const filePath = path.join(ctx.subagentDir, `agent-${teammateName}--${teamName}.jsonl`)
    await fsp.writeFile(filePath, teammateLine('user', 'A cleanup prompt'))

    const sendFn = vi.fn()
    watchSubagent(
      'tool-use-cleanup',
      ctx.sessionId,
      ctx.projectKey,
      'A cleanup prompt',
      sendFn,
    )

    await vi.waitFor(() => expect(sendFn).toHaveBeenCalled(), { timeout: 2000 })

    // Unwatch twice — second call must be a safe no-op, not a throw.
    expect(() => unwatchSubagent('tool-use-cleanup')).not.toThrow()
    expect(() => unwatchSubagent('tool-use-cleanup')).not.toThrow()
    // Unknown id must also be safe.
    expect(() => unwatchSubagent('never-registered')).not.toThrow()

    // unwatchAllSubagents on an empty map must not throw either.
    expect(() => unwatchAllSubagents()).not.toThrow()

    // Now register two, then call unwatchAll and ensure no future events fire
    // when files grow.
    const s2 = vi.fn()
    watchSubagent(
      'tool-use-a',
      ctx.sessionId,
      ctx.projectKey,
      'A cleanup prompt',
      s2,
    )
    await vi.waitFor(() => expect(s2).toHaveBeenCalled(), { timeout: 2000 })
    const beforeAll = s2.mock.calls.length

    unwatchAllSubagents()
    await fsp.appendFile(filePath, teammateLine('assistant', 'post-cleanup write'))
    await new Promise((r) => setTimeout(r, 500))
    expect(s2.mock.calls.length).toBe(beforeAll)
  })
})

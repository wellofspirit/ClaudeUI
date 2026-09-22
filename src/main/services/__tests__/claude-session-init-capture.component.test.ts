/**
 * @vitest-environment node
 *
 * `system/init` capture on the REAL ClaudeSession.
 *
 * The bug this pins: `captureSessionBootstrap` nested its init capture inside
 * the `if (msg.session_id && !this.sessionId)` latch. But `system/init` is not
 * the first message carrying a `session_id` — `system/queued_command_consumed`
 * is (our own `patch/queue-control` Part A3 emits it for EVERY prompt, because
 * the drain path is how an ordinary never-queued prompt reaches its turn, and
 * it lands ahead of init on every turn; see docs/protocol-cc/04-system-subtypes.md
 * §4.2 / §4.10). So the consume message tripped the latch and the init branch
 * never ran.
 *
 * Consequences, all guarded below:
 *  - `resolvedModelId` stayed null, so a `default` session sized its context
 *    window with `getContextWindowSize('default')` → 200K. `default` really
 *    resolves to `claude-opus-5[1m]` (1M), so a 600K-token transcript rendered
 *    as 300% instead of 60%.
 *  - `slash_commands` and `skills` were never emitted. (Slash commands are
 *    masked by `saveSlashCommands` persistence; `session:skills` has no other
 *    Claude emitter, so the skills list was simply empty.)
 *
 * And the second case pins the other half of the fix: cli.js re-emits
 * `system/init` at the head of every turn with the model actually in force, so
 * the resolved id must be RE-captured each time — that is what makes a
 * mid-session `setModel` (a control request, which triggers no fresh init of
 * its own) correct on the following turn.
 *
 * Mock scaffold mirrors claude-session-queue.component.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { subscribeWindowToSync } from '../../../test/helpers/sync-subscriber-window'
import { clearSyncSubscribersForTests } from '../../../core/services/sync-host'
import type { StatusLineData } from '../../../shared/types'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('electron', async () => await import('../../../test/stubs/electron-shim'))

vi.mock('../../../core/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/sdk')>()
  return {
    ...actual,
    query: mockQuery,
    locateBunClaude: (): string => __filename,
    getCliVersion: (): string => '0.0.0-test'
  }
})

vi.mock('../../../core/opencode/OpencodeServerManager', () => ({
  opencodeServerManager: { isBinaryAvailable: (): boolean => false }
}))
vi.mock('../../../core/services/cross-engine-dispatcher', () => ({
  crossEngineDispatcher: { dispatch: vi.fn(), resolveApproval: vi.fn(), disposeFor: vi.fn() },
  crossEngineDispatchAvailable: (): boolean => false
}))
vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
vi.mock('../../../core/services/ui-config', () => ({
  saveSlashCommands: vi.fn(),
  loadEngineConfig: vi.fn(() => ({}))
}))
vi.mock('../../../core/services/claude-mcp', () => ({
  loadMcpServers: vi.fn(() => ({})),
  readDisabledMcpServers: vi.fn(() => [])
}))
vi.mock('../../../core/services/session-history', () => ({
  computeTokenMetrics: vi.fn(async () => ({ totalTokens: 0, totalCostUsd: 0 })),
  fallbackBlockText: vi.fn(() => '')
}))
vi.mock('../../../core/services/skill-scanner', () => ({ scanSkills: vi.fn(async () => []) }))
vi.mock('../../../core/services/subagent-watcher', () => ({ unwatchAllSubagents: vi.fn() }))
vi.mock('../../../core/services/voice-capture', () => ({
  startRecording: vi.fn(),
  stopRecording: vi.fn()
}))
vi.mock('../../../core/services/voice-client', () => ({ VoiceClient: class {} }))
// NOTE: `context-window` is deliberately NOT mocked (the queue test stubs it to
// a flat 200000). The whole point here is the real alias → window resolution.
vi.mock('../../../core/services/usage-fetcher', () => ({
  usageFetcher: { updateFromRateLimitEvent: vi.fn(), fetch: vi.fn(async () => null) }
}))
vi.mock('../../../core/services/usage-provider', () => ({ resolveUsageProvider: vi.fn() }))
vi.mock('../account-manager', () => ({
  accountManager: { getState: vi.fn(() => ({ enabled: false, activeId: null })) }
}))
vi.mock('../../auth/ClaudeAuthProvider', () => ({
  claudeAuthProvider: { buildAccountRef: vi.fn(() => null), updateAuthSource: vi.fn() }
}))

import { ClaudeSession } from '../../../core/services/claude-session'
import type { BrowserWindow } from 'electron'

afterEach(() => {
  clearSyncSubscribersForTests()
})

/** A query handle whose for-await parks until `emit`ted messages arrive. */
function makeControlledHandle(): {
  handle: AsyncIterable<unknown> & Record<string, unknown>
  emit: (msg: unknown) => void
  end: () => void
} {
  const pending: unknown[] = []
  let wake: (() => void) | null = null
  let done = false

  const handle = {
    async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
      for (;;) {
        while (pending.length > 0) yield pending.shift()
        if (done) return
        await new Promise<void>((r) => {
          wake = r
        })
      }
    },
    initializationResult: (): Promise<never> => new Promise<never>(() => {}),
    interrupt: vi.fn(async () => {}),
    dequeueMessage: vi.fn(async () => ({ removed: 1 }))
  }
  return {
    handle,
    emit: (msg) => {
      pending.push(msg)
      wake?.()
      wake = null
    },
    end: () => {
      done = true
      wake?.()
      wake = null
    }
  }
}

/** A stub window that is also a sync SUBSCRIBER (SyncCore phase 4c). */
function makeWin(): { win: BrowserWindow; sent: Array<[string, string, unknown]> } {
  const sent: Array<[string, string, unknown]> = []
  const win = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, routingId: string, data: unknown): void => {
        sent.push([channel, routingId, data])
      }
    }
  } as unknown as BrowserWindow
  subscribeWindowToSync(
    win as unknown as { webContents: { send: (c: string, ...a: unknown[]) => void } }
  )
  return { win, sent }
}

function statusLines(sent: Array<[string, string, unknown]>): StatusLineData[] {
  return sent
    .filter(([channel]) => channel === 'session:status-line')
    .map(([, , data]) => data as StatusLineData)
}

/** The last status line that actually carries a percentage. */
function lastUsedPercentage(sent: Array<[string, string, unknown]>): number | null | undefined {
  return statusLines(sent)
    .map((s) => s.usedPercentage)
    .filter((p): p is number => p !== null && p !== undefined)
    .at(-1)
}

const handles: Array<ReturnType<typeof makeControlledHandle>> = []
const liveSessions: ClaudeSession[] = []

/** An assistant message whose usage totals a 600_000-token context. */
const ASSISTANT_600K = {
  type: 'assistant',
  message: {
    id: 'msg_1',
    model: 'claude-opus-5',
    usage: {
      input_tokens: 100_000,
      output_tokens: 10,
      cache_read_input_tokens: 500_000,
      cache_creation_input_tokens: 0
    },
    content: [{ type: 'text', text: 'ok' }]
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  handles.length = 0
  mockQuery.mockImplementation(() => {
    const h = makeControlledHandle()
    handles.push(h)
    return h.handle
  })
})

afterEach(() => {
  for (const h of handles) h.end()
  for (const s of liveSessions.splice(0)) s.cancel()
})

/** Start a `default`-model session with a live (parked) cli.js run. */
async function startSession(routingId: string): Promise<{
  session: ClaudeSession
  sent: Array<[string, string, unknown]>
  handle: ReturnType<typeof makeControlledHandle>
}> {
  const { win, sent } = makeWin()
  const session = new ClaudeSession(routingId, win, '/tmp/proj')
  liveSessions.push(session)
  void session.run('hello')
  await vi.waitFor(() => expect(handles.length).toBe(1))
  await new Promise<void>((r) => setTimeout(r, 0))
  return { session, sent, handle: handles[0] }
}

describe('ClaudeSession system/init capture (behind queued_command_consumed)', () => {
  it('sizes the context window from the resolved model id, not the `default` alias', async () => {
    const { sent, handle } = await startSession('r-init-window')

    // THE wire order (verified on 2.1.268): the consume notification carries a
    // session_id and precedes init on every turn.
    handle.emit({
      type: 'system',
      subtype: 'queued_command_consumed',
      prompt: 'hello',
      session_id: 's-init-1',
      uuid: 'u1'
    })
    handle.emit({
      type: 'system',
      subtype: 'init',
      session_id: 's-init-1',
      model: 'claude-opus-5[1m]',
      slash_commands: ['review', 'context', 'compact'],
      skills: ['unslop', 'dataviz'],
      mcp_servers: [],
      permissionMode: 'default',
      uuid: 'u2'
    })
    handle.emit(ASSISTANT_600K)

    // 600_000 / 1_000_000 — NOT 300, which is what the 200K `default` fallback
    // produced while the init branch sat behind the sessionId latch.
    await vi.waitFor(() => expect(lastUsedPercentage(sent)).toBe(60))

    // Both halves of the field, not just the percentage derived from them.
    // `contextWindowSize` used to carry the CONSUMPTION under a name that says
    // window — here, 600_000 under the spelling that promised 1_000_000. The
    // pair is now stated explicitly, in the one place the ambiguity was most
    // dangerous: an alias whose real window is five times the fallback.
    expect(statusLines(sent).at(-1)!.contextWindow).toEqual({
      used: 600_000,
      size: 1_000_000
    })

    // The rest of the init payload reached the renderer too.
    const slash = sent.find(([c]) => c === 'session:slash-commands')
    expect(slash).toBeDefined()
    // `context` is CLI-only and filtered out; the others gain their leading '/'.
    expect(slash![2]).toEqual([{ name: '/review' }, { name: '/compact' }])

    const skills = sent.find(([c]) => c === 'session:skills')
    expect(skills).toBeDefined()
    expect(skills![2]).toEqual(['unslop', 'dataviz'])
  })

  it('re-captures the resolved model on a LATER init, resizing the window', async () => {
    const { sent, handle } = await startSession('r-init-recapture')

    handle.emit({
      type: 'system',
      subtype: 'queued_command_consumed',
      prompt: 'hello',
      session_id: 's-init-2',
      uuid: 'u1'
    })
    handle.emit({
      type: 'system',
      subtype: 'init',
      session_id: 's-init-2',
      model: 'claude-opus-5[1m]',
      slash_commands: [],
      skills: [],
      mcp_servers: [],
      uuid: 'u2'
    })
    handle.emit(ASSISTANT_600K)
    await vi.waitFor(() => expect(lastUsedPercentage(sent)).toBe(60))

    // A mid-session setModel is a control request and emits no init of its own;
    // the NEXT turn's init is what reports the model now in force. Pre-fix this
    // was a one-shot capture, so the window stayed on the old model forever.
    handle.emit({
      type: 'system',
      subtype: 'init',
      session_id: 's-init-2',
      model: 'claude-haiku-4-5-20251001',
      slash_commands: [],
      skills: [],
      mcp_servers: [],
      uuid: 'u3'
    })

    // 600_000 / 200_000 — the status line is re-emitted by the init capture
    // itself, without waiting for another assistant message.
    await vi.waitFor(() => expect(lastUsedPercentage(sent)).toBe(300))
  })
})

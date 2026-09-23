/**
 * @vitest-environment node
 *
 * cli.js's own permission verdicts must reach the cards they are about.
 *
 * Claude is the one engine whose auto-mode judge we do not run: the two-stage
 * classifier lives inside cli.js (docs/protocol-cc/14-auto-mode-classifier.md),
 * so `system/permission_denied` — and, behind the `automode-verdict` patch,
 * `system/permission_allowed` — are the ONLY way its verdict reaches the UI.
 * ClaudeUI dropped both, which is why an auto-mode block on Claude showed as a
 * bare red tool_result while pi, opencode and Codex all rendered a verdict.
 *
 * The wire order replayed here is the one PROBED against 2.1.268 on 2026-09-21:
 * the assistant message carrying the `tool_use`, then the system frame, then the
 * `user` tool_result. That order is what makes the binding work at all — the
 * block must already be in the transcript when the frame lands — so it is the
 * thing this file pins.
 *
 * Asserted on CANONICAL state (the same `applyEvent` fold every client runs),
 * not on the emitted events: the bug class is how they fold.
 *
 * Mock scaffold mirrors `claude-tool-result-attach.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ChatMessage, ContentBlock } from '../../../shared/types'
import { subscribeWindowToSync } from '../../../test/helpers/sync-subscriber-window'
import { clearSyncSubscribersForTests } from '../sync-host'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('electron', async () => await import('../../../test/stubs/electron-shim'))

vi.mock('../../sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../sdk')>()
  return {
    ...actual,
    query: mockQuery,
    locateBunClaude: (): string => __filename,
    getCliVersion: (): string => '0.0.0-test'
  }
})

vi.mock('../../opencode/OpencodeServerManager', () => ({
  opencodeServerManager: { isBinaryAvailable: (): boolean => false }
}))
vi.mock('../cross-engine-dispatcher', () => ({
  crossEngineDispatcher: { dispatch: vi.fn(), resolveApproval: vi.fn(), disposeFor: vi.fn() },
  crossEngineDispatchAvailable: (): boolean => false
}))
vi.mock('../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
vi.mock('../ui-config', () => ({
  saveSlashCommands: vi.fn(),
  loadEngineConfig: vi.fn(() => ({}))
}))
vi.mock('../claude-mcp', () => ({
  loadMcpServers: vi.fn(() => ({})),
  readDisabledMcpServers: vi.fn(() => [])
}))
vi.mock('../session-history', () => ({
  computeTokenMetrics: vi.fn(async () => ({ totalTokens: 0, totalCostUsd: 0 })),
  fallbackBlockText: vi.fn(() => '')
}))
vi.mock('../skill-scanner', () => ({ scanSkills: vi.fn(async () => []) }))
vi.mock('../subagent-watcher', () => ({ unwatchAllSubagents: vi.fn() }))
vi.mock('../voice-capture', () => ({ startRecording: vi.fn(), stopRecording: vi.fn() }))
vi.mock('../voice-client', () => ({ VoiceClient: class {} }))
vi.mock('../context-window', () => ({ getContextWindowSize: vi.fn(() => 200000) }))
vi.mock('../usage-fetcher', () => ({
  usageFetcher: { updateFromRateLimitEvent: vi.fn(), fetch: vi.fn(async () => null) }
}))
vi.mock('../usage-provider', () => ({ resolveUsageProvider: vi.fn() }))
vi.mock('../../../main/services/account-manager', () => ({
  accountManager: { getState: vi.fn(() => ({ enabled: false, activeId: null })) }
}))
vi.mock('../../../main/auth/ClaudeAuthProvider', () => ({
  claudeAuthProvider: { buildAccountRef: vi.fn(() => null), updateAuthSource: vi.fn() }
}))

// Import AFTER mocks.
import { ClaudeSession } from '../claude-session'
import { applyEvent } from '../../shared/sync/reducer'
import { emptyCanonicalState } from '../../shared/sync/state'
import type { BrowserWindow } from 'electron'

afterEach(() => {
  clearSyncSubscribersForTests()
})

function makeFakeQueryHandle(
  messages: Array<Record<string, unknown>>
): AsyncIterable<unknown> & Record<string, unknown> {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
      for (const m of messages) yield m
    },
    initializationResult: (): Promise<never> => new Promise<never>(() => {}),
    interrupt: vi.fn(async () => {})
  }
}

/** Captures the sync events a session emits, in order, as a client sees them. */
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

/** Fold the captured events exactly as a replica or the renderer store does. */
function foldCanonical(routingId: string, sent: Array<[string, string, unknown]>): ChatMessage[] {
  let state = emptyCanonicalState()
  let seq = 1
  state = applyEvent(state, {
    channel: 'session:created',
    args: [routingId, { cwd: '/tmp/proj', engineId: 'claude' }],
    seq: seq++
  } as never)
  for (const [channel, rid, data] of sent) {
    state = applyEvent(state, { channel, args: [rid, data], seq: seq++ } as never)
  }
  return state.sessions[routingId]?.messages ?? []
}

const liveSessions: ClaudeSession[] = []

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  for (const s of liveSessions.splice(0)) s.cancel()
})

/**
 * One turn: an assistant message holding a Bash call, a system frame deciding
 * it, then the tool_result — cli.js's own order, with `frame` spliced in where
 * cli.js puts it.
 */
function decidedTurn(
  frame: Record<string, unknown>,
  isError = true
): Array<Record<string, unknown>> {
  return [
    {
      type: 'assistant',
      uuid: 'u-1',
      message: {
        id: 'msg_1',
        role: 'assistant',
        model: 'claude-opus-5',
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'git push --force' } }
        ]
      }
    },
    frame,
    {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            is_error: isError,
            content: 'Permission to use Bash with command git push --force has been denied.'
          }
        ]
      }
    }
  ]
}

/**
 * A frame as cli.js emits it, minus `session_id`: a real one carries cli.js's
 * own id, which rekeys the canonical session mid-fold — orthogonal to what this
 * file is about, and already covered by `session-rekey-mid-stream.e2e.test.ts`.
 */
const deniedFrame = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'system',
  subtype: 'permission_denied',
  tool_name: 'Bash',
  tool_use_id: 'toolu_1',
  message: 'Permission to use Bash with command git push --force has been denied.',
  uuid: 'frame-1',
  ...over
})

/** Run one turn; return the blocks that landed on the call's message. */
async function decide(
  routingId: string,
  frame: Record<string, unknown>,
  isError = true
): Promise<{ blocks: ContentBlock[]; channels: string[]; allBlocks: ContentBlock[] }> {
  mockQuery.mockImplementation(() => makeFakeQueryHandle(decidedTurn(frame, isError)))
  const { win, sent } = makeWin()
  const session = new ClaudeSession(routingId, win, '/tmp/proj')
  liveSessions.push(session)
  await session.run('push it')

  const messages = foldCanonical(routingId, sent)
  const withCall = messages.find((m) =>
    m.content.some((b) => b.type === 'tool_use' && b.toolUseId === 'toolu_1')
  )
  return {
    blocks: withCall?.content ?? [],
    channels: sent.map(([channel]) => channel),
    // Flattened across the whole transcript — the shape a client that ignores
    // message boundaries sees, which is how the ordering question was raised.
    allBlocks: messages.flatMap((m) => m.content)
  }
}

describe('a cli.js permission decision reaches the card it is about', () => {
  it('turns a classifier BLOCK into the verdict pi and opencode already render', async () => {
    const { blocks } = await decide(
      'routing-block',
      deniedFrame({
        decision_reason_type: 'classifier',
        decision_reason: '[Git Destructive] Rewrites published history.'
      })
    )
    expect(blocks.filter((b) => b.type === 'tool_review')).toEqual([
      {
        type: 'tool_review',
        toolUseId: 'toolu_1',
        reviewId: 'frame-1',
        reviewer: 'auto-mode',
        decision: 'denied',
        rule: 'Git Destructive',
        rationale: 'Rewrites published history.'
      }
    ])
    // …and the result still lands, so the card carries both.
    expect(blocks.some((b) => b.type === 'tool_result' && b.toolUseId === 'toolu_1')).toBe(true)
  })

  /**
   * The patched half. Stock cli.js gates its emit on `behavior === "deny"`, so
   * an allowed call carries no frame at all — `patch/automode-verdict` adds
   * this one. Without it Claude shows a verdict only when it blocks, where the
   * other three engines show one either way.
   */
  it('turns a patched classifier ALLOW into an approved verdict', async () => {
    const { blocks } = await decide(
      'routing-allow',
      deniedFrame({
        subtype: 'permission_allowed',
        uuid: 'frame-2',
        decision_reason_type: 'classifier',
        decision_reason: 'Reads only inside the workspace.'
      }),
      false
    )
    const reviews = blocks.filter((b) => b.type === 'tool_review')
    expect(reviews).toHaveLength(1)
    expect(reviews[0]).toMatchObject({
      reviewer: 'auto-mode',
      decision: 'approved',
      reviewId: 'frame-2',
      rationale: 'Reads only inside the workspace.'
    })
  })

  /**
   * The ordering `attachToToolUse` documents: the decision is APPENDED to the
   * message holding the call, so within that message the `tool_use` comes
   * first and the decision after it.
   *
   * Raised by the live verifier (2026-09-21), which saw a flattened transcript
   * read `permission_denial, tool_result, tool_use` and could not attribute it
   * to one message. It has no visible effect — `MessageBubble` pairs by
   * `toolUseId` and filters both auxiliary kinds out of the row flow — but an
   * invariant a comment asserts and nothing checks is one refactor from being
   * false, so both views are pinned here.
   */
  it('appends the decision after the call it is about, in the same message', async () => {
    const { blocks, allBlocks } = await decide(
      'routing-order',
      deniedFrame({ decision_reason_type: 'subcommandResults' })
    )
    const kinds = blocks.map((b) => b.type)
    expect(kinds[0]).toBe('tool_use')
    expect(kinds).toContain('permission_denial')
    expect(kinds.indexOf('permission_denial')).toBeGreaterThan(kinds.indexOf('tool_use'))
    // …and the same holds once message boundaries are flattened away.
    const flat = allBlocks.map((b) => b.type)
    expect(flat.indexOf('permission_denial')).toBeGreaterThan(flat.indexOf('tool_use'))
  })

  it('turns a NON-classifier denial into a denial block, never a verdict', async () => {
    const { blocks } = await decide(
      'routing-rule',
      deniedFrame({ decision_reason_type: 'subcommandResults' })
    )
    expect(blocks.filter((b) => b.type === 'tool_review')).toEqual([])
    expect(blocks.filter((b) => b.type === 'permission_denial')).toEqual([
      {
        type: 'permission_denial',
        toolUseId: 'toolu_1',
        denialId: 'frame-1',
        source: 'subcommandResults'
      }
    ])
  })

  /**
   * A decision made inside a subagent names a call that lives in a SUBAGENT
   * transcript, which `session:tool-review` does not search. Emitting it would
   * be silently dropped by the reducer; dropping it at the producer keeps the
   * boundary explicit and leaves one obvious place to wire subagent verdicts.
   */
  it('drops a decision made inside a subagent rather than mis-binding it', async () => {
    const { blocks, channels } = await decide(
      'routing-subagent',
      deniedFrame({ agent_id: 'agent-7', decision_reason_type: 'classifier', decision_reason: 'x' })
    )
    expect(blocks.filter((b) => b.type === 'tool_review')).toEqual([])
    expect(channels).not.toContain('session:tool-review')
    expect(channels).not.toContain('session:permission-denial')
  })

  it('drops a frame that names no call, instead of parking it', async () => {
    const { channels } = await decide('routing-nocall', deniedFrame({ tool_use_id: '' }))
    expect(channels).not.toContain('session:permission-denial')
  })

  /**
   * "Classifier unavailable" is a `classifier` DENY with no `no_verdict` flag:
   * the call was refused, but no judge weighed it. It must land as a denial
   * saying so — a verdict card would claim a judgment that never happened.
   */
  it('turns an unavailable-classifier block into a no-verdict denial, not a verdict', async () => {
    const { blocks, channels } = await decide(
      'routing-unavailable',
      deniedFrame({ decision_reason_type: 'classifier', decision_reason: 'Classifier unavailable' })
    )
    expect(blocks.filter((b) => b.type === 'tool_review')).toEqual([])
    expect(channels).not.toContain('session:tool-review')
    expect(blocks.filter((b) => b.type === 'permission_denial')).toEqual([
      {
        type: 'permission_denial',
        toolUseId: 'toolu_1',
        denialId: 'frame-1',
        source: 'autoModeNoVerdict',
        reason: 'Classifier unavailable'
      }
    ])
  })

  it('turns a patch-flagged no_verdict block into a no-verdict denial', async () => {
    const { blocks } = await decide(
      'routing-noverdict-deny',
      deniedFrame({
        decision_reason_type: 'classifier',
        decision_reason: 'Auto mode classifier transcript exceeded context window',
        no_verdict: true
      })
    )
    expect(blocks.filter((b) => b.type === 'tool_review')).toEqual([])
    expect(blocks.filter((b) => b.type === 'permission_denial')).toMatchObject([
      { source: 'autoModeNoVerdict' }
    ])
  })

  /** Defensive: the patch never emits one, but an allow nobody judged renders nothing. */
  it('renders nothing for a no-verdict classifier allow', async () => {
    const { blocks, channels } = await decide(
      'routing-noverdict-allow',
      deniedFrame({
        subtype: 'permission_allowed',
        decision_reason_type: 'classifier',
        decision_reason: 'Delivered with a note: the classifier could not review it',
        no_verdict: true
      }),
      false
    )
    expect(blocks.filter((b) => b.type === 'tool_review')).toEqual([])
    expect(blocks.filter((b) => b.type === 'permission_denial')).toEqual([])
    expect(channels).not.toContain('session:tool-review')
    expect(channels).not.toContain('session:permission-denial')
  })

  it('keeps a classifier block but drops its content-free rationale', async () => {
    const { blocks } = await decide(
      'routing-contentfree-deny',
      deniedFrame({ decision_reason_type: 'classifier', decision_reason: 'No reason provided' })
    )
    expect(blocks.filter((b) => b.type === 'tool_review')).toEqual([
      {
        type: 'tool_review',
        toolUseId: 'toolu_1',
        reviewId: 'frame-1',
        reviewer: 'auto-mode',
        decision: 'denied'
      }
    ])
  })

  /**
   * A `permission_allowed` that is NOT the classifier's would mean the patch's
   * filter changed upstream. Ignore it rather than inventing a verdict nobody
   * reached — an allow nothing judged is just the tool running.
   */
  it('ignores a permission_allowed carrying a non-classifier reason', async () => {
    const { blocks } = await decide(
      'routing-odd-allow',
      deniedFrame({ subtype: 'permission_allowed', decision_reason_type: 'rule' }),
      false
    )
    expect(blocks.filter((b) => b.type === 'tool_review')).toEqual([])
    expect(blocks.filter((b) => b.type === 'permission_denial')).toEqual([])
  })
})

/**
 * @vitest-environment node
 *
 * Emitter-timed thinking spans — SyncCore phase 4b, invariant 5.
 *
 * `applyEvent` is clock-free by contract, so the only honest source of "Thought
 * for Xs" is the process that watched the clock. `BaseSession.send` times the
 * span and stamps `ChatMessage.thinkingDurationMs` on the event that seals it;
 * the reducer moves it onto the block (`reducer.unit.test.ts` covers that half).
 *
 * The logic lives on `BaseSession` rather than in each adapter BECAUSE all three
 * engines emit their deltas and messages through this one method — so this file
 * pins the mechanism once, and the last test pins the premise it rests on by
 * scanning the three adapters for a bypass.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import type { ChatMessage, EngineId, SessionStatus } from '../../../shared/types'
import type { ResolvedCapabilities } from '../../../shared/model-capabilities'

/** Captured emissions — the funnel is stubbed so this needs no Electron/DB. */
const { emitted } = vi.hoisted(() => ({
  emitted: [] as Array<{ channel: string; args: unknown[] }>
}))

vi.mock('../../services/sync-host', () => ({
  emitEvent: (channel: string, args: unknown[]) => emitted.push({ channel, args }),
  addExtraSink: vi.fn(),
  removeExtraSink: vi.fn(),
  extraSinks: () => new Set()
}))
vi.mock('../../services/db', () => ({ dispatchedCostsByRouting: () => [] }))
vi.mock('../../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import { BaseSession } from '../BaseSession'

/** Minimal concrete session — only `send` is under test. */
class ProbeSession extends BaseSession {
  readonly engineId: EngineId = 'claude'
  readonly capabilities = {} as ResolvedCapabilities
  readonly willQueue = false
  getSessionId(): string | null {
    return null
  }
  async run(): Promise<void> {}
  async interrupt(): Promise<void> {}
  cancel(): void {}
  resolveApproval(): void {}
  async setModel(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  dispose(): void {}

  /** Public seam for the protected broadcast. */
  emitAs(channel: string, data: unknown): void {
    this.send(channel, data)
  }
}

function probe(): ProbeSession {
  return new ProbeSession('rid', { isDestroyed: () => false } as never, '/repo')
}

/** The message payload for `session:message` emission number `n` (0-based). */
function messagePayloads(): ChatMessage[] {
  return emitted.filter((e) => e.channel === 'session:message').map((e) => e.args[1] as ChatMessage)
}

function status(state: SessionStatus['state']): SessionStatus {
  return { state, sessionId: null, model: null, cwd: null, totalCostUsd: 0 } as SessionStatus
}

const assistant = (id: string, content: ChatMessage['content']): ChatMessage => ({
  id,
  role: 'assistant',
  content,
  timestamp: 0
})

beforeEach(() => {
  emitted.length = 0
  vi.useRealTimers()
})

describe('BaseSession — thinking-span timing', () => {
  it('stamps the elapsed span on the message that seals it (streamed shape)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const session = probe()

    session.emitAs('session:stream', { type: 'thinking', text: 'weighing' })
    vi.setSystemTime(1_002_500)
    // A text delta seals the span, but no block is on the wire yet — the elapsed
    // time is parked for the message that will carry the block.
    session.emitAs('session:stream', { type: 'text', text: 'answer' })
    vi.setSystemTime(1_009_000)
    session.emitAs('session:message', assistant('m1', [{ type: 'text', text: 'answer' }]))

    expect(messagePayloads()[0].thinkingDurationMs).toBe(2500)
    // The delta payloads themselves are untouched — the seal is a message-level
    // fact, and StreamDelta stays the two-field shape every client parses.
    const delta = emitted.find((e) => e.channel === 'session:stream')!.args[1]
    expect(delta).toEqual({ type: 'thinking', text: 'weighing' })
  })

  it('stamps a message that seals the span itself (all-in-one shape)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(500)
    const session = probe()
    session.emitAs('session:stream', { type: 'thinking', text: 'weighing' })
    vi.setSystemTime(1_700)
    // No text delta at all: thinking straight into a tool call, which is a real
    // claude shape. The message's own non-thinking block is the seal.
    session.emitAs(
      'session:message',
      assistant('m1', [
        { type: 'thinking', text: 'weighing' },
        { type: 'tool_use', toolUseId: 't1', toolName: 'Read', toolInput: {} }
      ])
    )
    expect(messagePayloads()[0].thinkingDurationMs).toBe(1200)
  })

  it('measures from the FIRST delta of a span, not the last', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const session = probe()
    session.emitAs('session:stream', { type: 'thinking', text: 'a' })
    vi.setSystemTime(400)
    session.emitAs('session:stream', { type: 'thinking', text: 'b' })
    vi.setSystemTime(1_000)
    session.emitAs('session:message', assistant('m1', [{ type: 'text', text: 'done' }]))
    expect(messagePayloads()[0].thinkingDurationMs).toBe(1000)
  })

  it('ships the duration ONCE — a later message is not re-stamped', () => {
    // The reducer owns the value from the first message on. Re-sending would let
    // a stale duration land on a LATER span's block.
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const session = probe()
    session.emitAs('session:stream', { type: 'thinking', text: 'a' })
    vi.setSystemTime(700)
    session.emitAs('session:stream', { type: 'text', text: 'x' })
    session.emitAs('session:message', assistant('m1', [{ type: 'text', text: 'x' }]))
    session.emitAs('session:message', assistant('m2', [{ type: 'text', text: 'y' }]))

    const payloads = messagePayloads()
    expect(payloads[0].thinkingDurationMs).toBe(700)
    expect(payloads[1].thinkingDurationMs).toBeUndefined()
  })

  it('emits nothing extra when no thinking happened', () => {
    const session = probe()
    session.emitAs('session:stream', { type: 'text', text: 'straight to it' })
    session.emitAs('session:message', assistant('m1', [{ type: 'text', text: 'straight to it' }]))
    const payload = messagePayloads()[0]
    expect('thinkingDurationMs' in payload).toBe(false)
    // And the caller's own object is never mutated — engines keep these messages
    // in their own history.
    expect(payload).toEqual(assistant('m1', [{ type: 'text', text: 'straight to it' }]))
  })

  it('abandons an open span on idle / disconnect / retraction (renderer safety nets)', () => {
    for (const abandon of [
      (s: ProbeSession) => s.emitAs('session:status', status('idle')),
      (s: ProbeSession) => s.emitAs('session:status', status('disconnected')),
      (s: ProbeSession) => s.emitAs('session:messages-retracted', { messageIds: ['m0'] })
    ]) {
      emitted.length = 0
      vi.useFakeTimers()
      vi.setSystemTime(0)
      const session = probe()
      session.emitAs('session:stream', { type: 'thinking', text: 'interrupted' })
      vi.setSystemTime(3_000)
      abandon(session)
      session.emitAs('session:message', assistant('m1', [{ type: 'text', text: 'next turn' }]))
      // An interrupted span has no honest duration: the renderer stamps no block
      // there either (it only sets its own per-session scalar), so neither does
      // the wire.
      expect(messagePayloads()[0].thinkingDurationMs).toBeUndefined()
    }
  })

  it('abandons an ALREADY-SEALED span at a turn boundary (SyncCore phase 4c)', () => {
    // The half 4b left in place. A text delta seals the span and PARKS its elapsed
    // time for the message that will carry the block; when that message never
    // arrives — interrupt, refusal retraction, engine death — the parked value used
    // to survive the boundary and stamp the NEXT turn's first thinking block with
    // the previous turn's duration.
    //
    // It was deliberate in 4b: the renderer's `pendingThinkingDurationMs` leaked the
    // same value the same way, so the two sides agreed and the shadow comparator
    // stayed quiet. 4c deleted the renderer's clock, so there is no mirror left to
    // preserve.
    for (const abandon of [
      (s: ProbeSession) => s.emitAs('session:status', status('idle')),
      (s: ProbeSession) => s.emitAs('session:status', status('disconnected')),
      (s: ProbeSession) => s.emitAs('session:messages-retracted', { messageIds: ['m0'] })
    ]) {
      emitted.length = 0
      vi.useFakeTimers()
      vi.setSystemTime(0)
      const session = probe()
      session.emitAs('session:stream', { type: 'thinking', text: 'first turn' })
      vi.setSystemTime(5_000)
      // Seals the span and parks 5000ms...
      session.emitAs('session:stream', { type: 'text', text: 'x' })
      // ...but the message that would carry it never comes; the turn just ends.
      abandon(session)

      // Next turn: a message with no thinking of its own must carry NO duration.
      session.emitAs('session:message', assistant('m1', [{ type: 'text', text: 'next turn' }]))
      expect(messagePayloads()[0].thinkingDurationMs).toBeUndefined()
    }
  })

  it('degrades on a malformed payload instead of throwing', () => {
    const session = probe()
    session.emitAs('session:stream', null)
    session.emitAs('session:message', null)
    session.emitAs('session:message', { id: 'm1', role: 'assistant' })
    expect(emitted.map((e) => e.channel)).toEqual([
      'session:stream',
      'session:message',
      'session:message'
    ])
  })
})

describe('all three engine adapters inherit the stamp (no bypass)', () => {
  // The premise this file rests on: every engine's thinking deltas AND messages
  // go through `BaseSession.send`. A future adapter that emitted them any other
  // way would silently lose durations for its engine only, and no behavioral test
  // of THIS class would notice.
  const ADAPTERS = [
    'src/core/services/claude-session.ts',
    'src/core/opencode/OpencodeSession.ts',
    'src/core/pi/PiSession.ts'
  ]

  it.each(ADAPTERS)('%s emits stream + message through this.send', (rel) => {
    const src = fs.readFileSync(path.join(process.cwd(), rel), 'utf-8')
    expect(src).toMatch(/this\.send\(\s*'session:stream'/)
    expect(src).toMatch(/this\.send\(\s*'session:message'/)
    // …and never around it.
    expect(src).not.toMatch(/emitEvent\(\s*'session:(stream|message)'/)
    expect(src).not.toMatch(/webContents\s*\.\s*send\(\s*'session:(stream|message)'/)
  })

  it('every adapter can actually open a span (thinking deltas reach the wire)', () => {
    for (const rel of ADAPTERS) {
      const src = fs.readFileSync(path.join(process.cwd(), rel), 'utf-8')
      // claude names the type inline; opencode/pi forward a mapped `streamType`.
      expect(/'thinking'|streamType/.test(src), `${rel} never emits a thinking delta`).toBe(true)
    }
  })
})

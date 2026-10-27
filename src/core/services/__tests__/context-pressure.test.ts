/**
 * @vitest-environment node
 *
 * Context pressure (session tools, slice 4, spec §6.6): the watcher that turns a session's
 * replicated context usage into a banner (ask) or a hand-off instruction (auto) at the end of
 * a turn. Everything runs through the real funnel and canonical state; only the engine
 * sessions (the manager's `get`) and `sendPrompt` are doubles.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineId, SessionStatus, StatusLineData } from '../../../shared/types'
import type { ContextPressureMode } from '../../../shared/context-pressure'
import { OPENCODE_DISPATCH_SESSION_TITLE } from '../../../shared/dispatch-session'
import { CommandRegistry, makeRemoteConnection } from '../../ipc/command-registry'
import { RemoteDispatcher } from '../remote-dispatcher'
import {
  __watchCountForTests,
  configureContextPressure,
  noteHandedOff,
  noteTurnStopped,
  resetContextPressureForTests,
  respondContextPressure
} from '../context-pressure'
import type { SessionManager } from '../session-manager'
import { logger } from '../logger'
import { emitEvent, syncCore } from '../sync-host'

vi.mock('../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

let n = 0
const newId = (label: string): string => `${label}-${process.pid}-${++n}`

const SIZE = 200_000

function status(
  sessionId: string | null,
  state: SessionStatus['state'],
  engineId: EngineId = 'claude'
): SessionStatus {
  return {
    state,
    sessionId,
    model: null,
    cwd: null,
    totalCostUsd: 0,
    engineId,
    account: null
  } as SessionStatus
}

interface SentPrompt {
  routingId: string
  prompt: string
  origin: string | undefined
}
const sent: SentPrompt[] = []
let sendFails: Error | null = null
/** An engine that takes a busy item without ever showing it on a queue event. */
let silentQueue = false
const live = new Set<string>()
const manager = { get: (key: string) => (live.has(key) ? {} : undefined) }

/** A live session canonical and the manager both know, idle. */
function makeSession(engine: EngineId = 'claude'): string {
  const sid = newId('s')
  emitEvent('session:created', [sid, { cwd: '/proj', engineId: engine }])
  emitEvent('session:status', [sid, status(sid, 'idle', engine)])
  live.add(sid)
  return sid
}

const setMode = (mode: ContextPressureMode, thresholds: number[] = [70]): void =>
  emitEvent('config:settings-changed', [{ contextPressure: { mode, thresholds } }])

/** Context usage as a percent of the window (size 0 = unknown window). */
function usage(sid: string, percent: number, size = SIZE): void {
  emitEvent('session:status-line', [
    sid,
    {
      contextWindow: { used: Math.round((percent / 100) * size), size },
      usedPercentage: size > 0 ? percent : null
    } as unknown as StatusLineData
  ])
}

const run = (sid: string, engine: EngineId = 'claude'): void =>
  emitEvent('session:status', [sid, status(sid, 'running', engine)])
const idle = (sid: string, engine: EngineId = 'claude'): void =>
  emitEvent('session:status', [sid, status(sid, 'idle', engine)])

/** A whole turn that ends at `percent`, in the order Claude reports it: idle first, then the reading. */
function turnEndingAt(sid: string, percent: number): void {
  run(sid)
  idle(sid)
  usage(sid, percent)
}

/** The engine takes the queued host instruction into the turn that is running. */
const consume = (sid: string): void =>
  emitEvent('session:queue-changed', [
    sid,
    {
      items: [
        { itemId: `h-${sent.length}`, state: 'consumed', text: 'x', origin: 'host-instruction' }
      ]
    }
  ])

const banner = (sid: string) => syncCore.getCanonicalState().sessions[sid].contextPressure
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))

beforeEach(() => {
  syncCore.resetCanonicalForTests()
  resetContextPressureForTests()
  sent.length = 0
  sendFails = null
  silentQueue = false
  live.clear()
  configureContextPressure({
    manager: manager as unknown as SessionManager,
    sendPrompt: async (routingId, prompt, options) => {
      if (sendFails) throw sendFails
      sent.push({ routingId, prompt, origin: options.origin })
      // What the real sendPrompt does: a busy session queues the item, an idle one starts a turn.
      if (syncCore.getCanonicalState().sessions[routingId]?.status.state === 'running') {
        if (silentQueue) return
        emitEvent('session:queue-changed', [
          routingId,
          {
            items: [
              { itemId: `h-${sent.length}`, state: 'queued', text: prompt, origin: options.origin }
            ]
          }
        ])
      } else {
        emitEvent('session:user-message', [routingId, { prompt, origin: options.origin }])
      }
    }
  })
})

afterEach(() => {
  configureContextPressure(null)
})

describe('when it acts', () => {
  it('fires at the turn end, never mid-turn', async () => {
    setMode('auto')
    const sid = makeSession()
    // An earlier turn finished below the threshold, so the session is eligible to act.
    turnEndingAt(sid, 40)
    run(sid)
    usage(sid, 75)
    usage(sid, 76)
    await flush()
    expect(sent).toHaveLength(0)
    expect(banner(sid)).toBeNull()
    idle(sid)
    await flush()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ routingId: sid, origin: 'host-instruction' })
  })

  it('ask mode shows its banner at the turn end, not mid-turn', () => {
    setMode('ask')
    const sid = makeSession()
    turnEndingAt(sid, 40)
    run(sid)
    usage(sid, 75)
    expect(banner(sid)).toBeNull()
    idle(sid)
    expect(banner(sid)).toEqual({ kind: 'ask', percent: 75 })
  })

  it('counts the reading that Claude reports just after its idle status as the turn end', async () => {
    setMode('auto')
    const sid = makeSession()
    turnEndingAt(sid, 75)
    await flush()
    expect(sent).toHaveLength(1)
    expect(sent[0].prompt).toContain('75 %')
  })

  it('does not act on a reading from a session that has not finished a turn (a resume)', async () => {
    setMode('auto')
    const sid = makeSession()
    usage(sid, 90)
    await flush()
    expect(sent).toHaveLength(0)
    expect(banner(sid)).toBeNull()
  })

  it('never arms on a window of size 0', async () => {
    setMode('ask')
    const sid = makeSession('codex')
    run(sid, 'codex')
    usage(sid, 0, 0)
    emitEvent('session:status-line', [
      sid,
      {
        contextWindow: { used: 190_000, size: 0 },
        usedPercentage: null
      } as unknown as StatusLineData
    ])
    idle(sid, 'codex')
    await flush()
    expect(banner(sid)).toBeNull()
    expect(sent).toHaveLength(0)
  })

  it('does nothing below the threshold, or with the mode off', async () => {
    const sid = makeSession()
    setMode('auto')
    turnEndingAt(sid, 69)
    setMode('off')
    turnEndingAt(sid, 95)
    await flush()
    expect(sent).toHaveLength(0)
    expect(banner(sid)).toBeNull()
  })

  it('acts once per crossing and re-arms when usage drops below the threshold', async () => {
    setMode('auto')
    const sid = makeSession()
    turnEndingAt(sid, 72)
    await flush()
    expect(sent).toHaveLength(1)
    // Still above it, turn after turn: no second firing.
    turnEndingAt(sid, 74)
    turnEndingAt(sid, 80)
    await flush()
    expect(sent).toHaveLength(1)
    // A compaction brings usage down; the next climb is a new crossing.
    emitEvent('session:status-line', [
      sid,
      {
        contextWindow: { used: 40_000, size: SIZE },
        usedPercentage: 20
      } as unknown as StatusLineData
    ])
    turnEndingAt(sid, 71)
    await flush()
    expect(sent).toHaveLength(2)
  })

  it('fires once for several thresholds crossed at once and re-arms only those dropped below', async () => {
    setMode('ask', [30, 50, 70])
    const sid = makeSession()
    turnEndingAt(sid, 75)
    expect(banner(sid)).toEqual({ kind: 'ask', percent: 75 })
    // One firing covers 30, 50 and 70; nothing more until one is re-armed.
    turnEndingAt(sid, 78)
    expect(banner(sid)).toEqual({ kind: 'ask', percent: 75 })
    // Down to 40: 50 and 70 re-arm (the banner for 70 goes with it), 30 stays fired.
    turnEndingAt(sid, 40)
    expect(banner(sid)).toBeNull()
    turnEndingAt(sid, 55)
    expect(banner(sid)).toEqual({ kind: 'ask', percent: 55 })
  })

  it('skips sessions the manager does not hold and dispatch targets', async () => {
    setMode('auto')
    const stray = makeSession()
    live.delete(stray)
    turnEndingAt(stray, 90)
    const target = makeSession('opencode')
    emitEvent('session:message', [
      target,
      {
        id: newId('u'),
        role: 'user',
        content: [{ type: 'text', text: OPENCODE_DISPATCH_SESSION_TITLE }],
        timestamp: Date.now()
      }
    ])
    turnEndingAt(target, 90)
    await flush()
    expect(sent).toHaveLength(0)
  })

  it('waits for a turn that ends by itself after the user stopped one', async () => {
    setMode('auto')
    const sid = makeSession()
    run(sid)
    noteTurnStopped(sid)
    idle(sid)
    usage(sid, 80)
    await flush()
    expect(sent).toHaveLength(0)
    turnEndingAt(sid, 81)
    await flush()
    expect(sent).toHaveLength(1)
  })

  it('follows a session through its rekey: what fired before it does not fire again after', async () => {
    setMode('ask')
    const temp = newId('temp')
    const real = newId('real')
    emitEvent('session:created', [temp, { cwd: '/proj', engineId: 'claude' }])
    emitEvent('session:status', [temp, status(null, 'idle')])
    live.add(temp)
    live.add(real)
    run(temp)
    idle(temp)
    usage(temp, 80)
    expect(banner(temp)).toEqual({ kind: 'ask', percent: 80 })
    expect(respondContextPressure(temp, 'dismiss')).toEqual({ success: true })
    // The engine reports its durable id: canonical moves the session, the watch follows.
    emitEvent('session:status', [temp, status(real, 'running')])
    idle(real)
    usage(real, 85)
    await flush()
    expect(banner(real)).toBeNull()
  })
})

describe('ask mode', () => {
  it('shows the banner at the turn end, replicated in canonical', () => {
    setMode('ask')
    const sid = makeSession()
    run(sid)
    usage(sid, 72)
    expect(banner(sid)).toBeNull()
    idle(sid)
    expect(banner(sid)).toEqual({ kind: 'ask', percent: 72 })
  })

  it('Hand off delivers the host instruction, clears the banner and names the tool per engine', async () => {
    setMode('ask')
    const cases: [EngineId, string][] = [
      ['claude', 'mcp__claude-ui-sessions__session_hand_off'],
      ['opencode', 'claudeui_session_hand_off'],
      ['pi', 'session_hand_off'],
      ['codex', 'session_hand_off']
    ]
    for (const [engine, tool] of cases) {
      const sid = makeSession(engine)
      run(sid, engine)
      idle(sid, engine)
      usage(sid, 73)
      expect(respondContextPressure(sid, 'handoff')).toEqual({ success: true })
      expect(banner(sid)).toBeNull()
      await flush()
      const last = sent[sent.length - 1]
      expect(last.routingId).toBe(sid)
      expect(last.origin).toBe('host-instruction')
      expect(last.prompt).toContain('73 %')
      expect(last.prompt).toContain(`call ${tool} with`)
    }
  })

  it('Not now clears the banner, sends nothing and does not ask again for the same crossing', async () => {
    setMode('ask')
    const sid = makeSession()
    turnEndingAt(sid, 72)
    expect(respondContextPressure(sid, 'dismiss')).toEqual({ success: true })
    expect(banner(sid)).toBeNull()
    turnEndingAt(sid, 75)
    await flush()
    expect(banner(sid)).toBeNull()
    expect(sent).toHaveLength(0)
  })

  it('answers a prompt that is already gone, or a bad answer, with a refusal', () => {
    const sid = makeSession()
    expect(respondContextPressure(sid, 'handoff').success).toBe(false)
    expect(respondContextPressure(sid, 'later').success).toBe(false)
    expect(respondContextPressure(42, 'dismiss').success).toBe(false)
  })

  it('the banner goes when usage falls back below its threshold (a compaction)', () => {
    setMode('ask')
    const sid = makeSession()
    turnEndingAt(sid, 72)
    expect(banner(sid)).not.toBeNull()
    usage(sid, 30)
    expect(banner(sid)).toBeNull()
  })

  it('turning the mode off takes an open banner away', () => {
    setMode('ask')
    const sid = makeSession()
    turnEndingAt(sid, 72)
    setMode('off')
    expect(banner(sid)).toBeNull()
  })
})

describe('auto mode and the outcome', () => {
  it('a hand-off during the instruction turn is handed_off: no banner, and nothing fires until the user speaks', async () => {
    setMode('auto', [70, 90])
    const sid = makeSession()
    turnEndingAt(sid, 75)
    await flush()
    expect(sent).toHaveLength(1)
    // The instruction's turn: the session calls session_hand_off, then finishes.
    run(sid)
    noteHandedOff(sid)
    idle(sid)
    usage(sid, 76)
    expect(banner(sid)).toBeNull()
    // Handed off: even a threshold crossed for the first time stays quiet (90 here).
    turnEndingAt(sid, 80)
    turnEndingAt(sid, 92)
    await flush()
    expect(sent).toHaveLength(1)
    // The host's own instruction is not the user speaking...
    emitEvent('session:user-message', [sid, { prompt: 'x', origin: 'host-instruction' }])
    turnEndingAt(sid, 86)
    await flush()
    expect(sent).toHaveLength(1)
    // ...the user's next prompt lifts the hold, but the crossing that was handed off already
    // counts: the old session still holds its context, so typing in it must not hand off again
    // (a new session per user turn). Only a drop below the threshold re-arms it.
    emitEvent('session:user-message', [sid, { prompt: 'keep going' }])
    turnEndingAt(sid, 87)
    turnEndingAt(sid, 88)
    await flush()
    expect(sent).toHaveLength(1)
    expect(banner(sid)).toBeNull()
    turnEndingAt(sid, 40)
    turnEndingAt(sid, 72)
    await flush()
    expect(sent).toHaveLength(2)
  })

  it('in ask mode the same crossing does not put a banner up for every turn after a hand-off', () => {
    setMode('ask')
    const sid = makeSession()
    turnEndingAt(sid, 75)
    noteHandedOff(sid)
    expect(banner(sid)).toBeNull()
    emitEvent('session:user-message', [sid, { prompt: 'keep going' }])
    turnEndingAt(sid, 78)
    turnEndingAt(sid, 80)
    expect(banner(sid)).toBeNull()
  })

  it('a queued prompt of the user that the engine takes in also ends the hold', async () => {
    setMode('auto')
    const sid = makeSession()
    noteHandedOff(sid)
    emitEvent('session:queue-changed', [
      sid,
      { items: [{ itemId: 'q1', state: 'consumed', text: 'hi', origin: 'host-instruction' }] }
    ])
    turnEndingAt(sid, 80)
    await flush()
    expect(sent).toHaveLength(0)
    emitEvent('session:queue-changed', [
      sid,
      { items: [{ itemId: 'q2', state: 'consumed', text: 'hi' }] }
    ])
    turnEndingAt(sid, 81)
    await flush()
    expect(sent).toHaveLength(1)
  })

  it('no hand-off by the end of the instruction turn is failed: the ask banner shows even in auto', async () => {
    setMode('auto')
    const sid = makeSession()
    turnEndingAt(sid, 75)
    await flush()
    expect(banner(sid)).toBeNull()
    run(sid)
    idle(sid)
    expect(banner(sid)).toEqual({ kind: 'failed', percent: 75 })
    // The banner's Hand off tries again, and a success this time settles it.
    expect(respondContextPressure(sid, 'handoff')).toEqual({ success: true })
    expect(banner(sid)).toBeNull()
    await flush()
    expect(sent).toHaveLength(2)
    run(sid)
    noteHandedOff(sid)
    idle(sid)
    expect(banner(sid)).toBeNull()
  })

  it('an instruction that cannot be delivered is failed too', async () => {
    setMode('auto')
    const sid = makeSession()
    sendFails = new Error('engine is gone')
    turnEndingAt(sid, 75)
    await flush()
    expect(banner(sid)).toEqual({ kind: 'failed', percent: 75 })
  })

  it('a hand-off the user asked for in words clears an open banner', () => {
    setMode('ask')
    const sid = makeSession()
    turnEndingAt(sid, 72)
    expect(banner(sid)).not.toBeNull()
    noteHandedOff(sid)
    expect(banner(sid)).toBeNull()
  })

  it('does not instruct a session that is already waiting on its answer', async () => {
    setMode('auto', [60, 70])
    const sid = makeSession()
    turnEndingAt(sid, 65)
    usage(sid, 75)
    usage(sid, 76)
    await flush()
    expect(sent).toHaveLength(1)
  })
})

describe('an instruction queued behind a running turn', () => {
  /** An ask banner, then the user's next turn is running when Hand off is clicked. */
  async function clickedWhileBusy(): Promise<string> {
    setMode('ask')
    const sid = makeSession()
    turnEndingAt(sid, 72)
    run(sid)
    expect(respondContextPressure(sid, 'handoff')).toEqual({ success: true })
    await flush()
    expect(sent).toHaveLength(1)
    return sid
  }

  it('is not judged at the end of the turn that was already running', async () => {
    const sid = await clickedWhileBusy()
    idle(sid)
    expect(banner(sid)).toBeNull()
    // The next turn takes the instruction in; ending without a hand-off is the failure.
    run(sid)
    consume(sid)
    idle(sid)
    expect(banner(sid)).toEqual({ kind: 'failed', percent: 72 })
  })

  it('a hand-off in the turn that took it in settles it', async () => {
    const sid = await clickedWhileBusy()
    idle(sid)
    run(sid)
    consume(sid)
    noteHandedOff(sid)
    idle(sid)
    expect(banner(sid)).toBeNull()
  })

  it('an instruction that left the queue without being read is failed, not waited on forever', async () => {
    const sid = await clickedWhileBusy()
    emitEvent('session:queue-changed', [sid, { items: [] }])
    expect(banner(sid)).toEqual({ kind: 'failed', percent: 72 })
  })

  it('a turn that dies before the instruction is read ends the wait', async () => {
    const sid = await clickedWhileBusy()
    emitEvent('session:status', [sid, status(sid, 'error')])
    expect(banner(sid)).toEqual({ kind: 'failed', percent: 72 })
  })
})

describe('an instruction that is never seen queued or consumed', () => {
  it('settles as failed at the second clean turn end after delivery, with a warning', async () => {
    setMode('ask')
    silentQueue = true
    const sid = makeSession()
    turnEndingAt(sid, 72)
    run(sid)
    expect(respondContextPressure(sid, 'handoff')).toEqual({ success: true })
    await flush()
    expect(sent).toHaveLength(1)
    expect(banner(sid)).toBeNull()
    idle(sid)
    expect(banner(sid)).toBeNull()
    run(sid)
    idle(sid)
    expect(banner(sid)).toEqual({ kind: 'failed', percent: 72 })
    expect(logger.warn).toHaveBeenCalledWith(
      'ContextPressure',
      expect.stringContaining('never taken in')
    )
    // And the watcher is free again: a later crossing is looked at.
    turnEndingAt(sid, 40)
    turnEndingAt(sid, 74)
    expect(banner(sid)).toEqual({ kind: 'ask', percent: 74 })
  })
})

describe('a turn the user stopped while the instruction was being acted on', () => {
  it('is not the session’s failure: no banner, and the crossing stays fired', async () => {
    setMode('auto')
    const sid = makeSession()
    turnEndingAt(sid, 75)
    await flush()
    expect(sent).toHaveLength(1)
    run(sid)
    noteTurnStopped(sid)
    idle(sid)
    usage(sid, 76)
    expect(banner(sid)).toBeNull()
    turnEndingAt(sid, 80)
    await flush()
    expect(sent).toHaveLength(1)
    expect(banner(sid)).toBeNull()
  })
})

describe('a settings change takes away the prompts it made meaningless', () => {
  it('turning the mode off drops a failed banner too', async () => {
    setMode('auto')
    const sid = makeSession()
    turnEndingAt(sid, 75)
    await flush()
    run(sid)
    idle(sid)
    expect(banner(sid)?.kind).toBe('failed')
    setMode('off')
    expect(banner(sid)).toBeNull()
  })

  it('removing the threshold a banner stands for drops it; keeping it does not', () => {
    setMode('ask', [50, 70])
    const sid = makeSession()
    turnEndingAt(sid, 75)
    expect(banner(sid)).toEqual({ kind: 'ask', percent: 75 })
    setMode('ask', [50, 70, 90])
    expect(banner(sid)).not.toBeNull()
    setMode('ask', [50, 90])
    expect(banner(sid)).toBeNull()
  })
})

describe('with the mode off', () => {
  it('no watch is made for a session, so a hand-off call or a status costs nothing held', () => {
    const sid = makeSession()
    turnEndingAt(sid, 90)
    expect(__watchCountForTests()).toBe(0)
    setMode('ask')
    turnEndingAt(sid, 91)
    expect(__watchCountForTests()).toBe(1)
  })
})

describe('a session in plan mode', () => {
  const plan = (sid: string, mode: 'plan' | 'default'): void =>
    emitEvent('session:permission-mode', [sid, mode])

  it('is never told automatically: the ask banner shows even in auto mode', async () => {
    setMode('auto')
    const sid = makeSession()
    plan(sid, 'plan')
    turnEndingAt(sid, 75)
    await flush()
    expect(sent).toHaveLength(0)
    expect(banner(sid)).toEqual({ kind: 'ask', percent: 75 })
  })

  it('refuses Hand off while in plan mode, keeps the banner, and lets Not now through', async () => {
    setMode('ask')
    const sid = makeSession()
    plan(sid, 'plan')
    turnEndingAt(sid, 75)
    expect(respondContextPressure(sid, 'handoff')).toEqual({
      success: false,
      error: 'Switch out of plan mode to hand off.'
    })
    await flush()
    expect(sent).toHaveLength(0)
    expect(banner(sid)).toEqual({ kind: 'ask', percent: 75 })
    expect(respondContextPressure(sid, 'dismiss')).toEqual({ success: true })
    expect(banner(sid)).toBeNull()
  })

  it('Hand off works once the user leaves plan mode with the banner open', async () => {
    setMode('auto')
    const sid = makeSession()
    plan(sid, 'plan')
    turnEndingAt(sid, 75)
    plan(sid, 'default')
    expect(respondContextPressure(sid, 'handoff')).toEqual({ success: true })
    await flush()
    expect(sent).toHaveLength(1)
    expect(banner(sid)).toBeNull()
  })
})

describe('the respond command over the remote dispatcher', () => {
  it('is the same call as calling the service directly (a chat command on the session)', async () => {
    setMode('ask')
    const sid = makeSession()
    turnEndingAt(sid, 72)
    const registry = new CommandRegistry()
    const dispatcher = new RemoteDispatcher(registry)
    registry.register({
      channel: 'session:context-pressure:respond',
      capability: 'chat',
      kind: 'command',
      sessionIdArg: 0,
      transport: 'remote',
      handler: async (routingId: string, answer: string) =>
        respondContextPressure(routingId, answer)
    })
    const viaDispatcher = await dispatcher.handle(
      {
        type: 'invoke',
        id: '1',
        channel: 'session:context-pressure:respond',
        args: [sid, 'dismiss']
      },
      makeRemoteConnection('password', null)
    )
    expect(viaDispatcher).toEqual({ success: true })
    expect(banner(sid)).toBeNull()
  })
})

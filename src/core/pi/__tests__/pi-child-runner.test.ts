import { describe, expect, it, vi } from 'vitest'
import {
  forwardPiChildStream,
  PiChildRunner,
  type PiChildPrimitives,
  type PiChildRunnerOpts,
  type PiChildSpawnOpts,
  type SpawnPiChildFn
} from '../pi-child-runner'
import type { PiBridgeHost } from '../PiBridgeHost'
import type { PiAgentDelivery } from '../pi-delivery'
import { slimTranscript } from '../../automode/classifier'
import type { PiRpcClient } from '../PiRpcClient'

type Cmd = Record<string, unknown>
type Handler = (cmd: Cmd) => Record<string, unknown> | Promise<Record<string, unknown>>

function defaultHandler(cmd: Cmd): Record<string, unknown> {
  switch (cmd.type) {
    case 'get_state':
      return {
        type: 'response',
        command: 'get_state',
        success: true,
        data: { sessionId: 'child-1' }
      }
    case 'get_last_assistant_text':
      return {
        type: 'response',
        command: 'get_last_assistant_text',
        success: true,
        data: { text: 'child answer' }
      }
    default:
      return { type: 'response', command: String(cmd.type), success: true, data: {} }
  }
}

/** A fake pi child (the dispatcher suite's `makeFakePiTarget` shape): real mapper, fake transport. */
function makeFakeChild(handler: Handler = defaultHandler) {
  const eventHandlers: Array<(ev: Cmd) => void> = []
  const exitHandlers: Array<() => void> = []
  const client = {
    request: vi.fn(async (cmd: Cmd) => handler(cmd)),
    onEvent: vi.fn((cb: (ev: Cmd) => void) => {
      eventHandlers.push(cb)
      return () => {}
    }),
    onExit: vi.fn((cb: () => void) => {
      exitHandlers.push(cb)
      return () => {}
    }),
    dispose: vi.fn()
  }
  const bridgeDispose = vi.fn()
  const spawnCalls: PiChildSpawnOpts[] = []
  const spawn = vi.fn<SpawnPiChildFn>(async (opts) => {
    spawnCalls.push(opts)
    const primitives: PiChildPrimitives = {
      client: client as unknown as PiRpcClient,
      bridgeHost: { dispose: bridgeDispose } as unknown as PiBridgeHost
    }
    return primitives
  })
  return {
    spawn,
    spawnCalls,
    client,
    bridgeDispose,
    push: (ev: Cmd) => {
      for (const cb of eventHandlers) cb(ev)
    },
    exit: () => {
      for (const cb of exitHandlers) cb()
    },
    commandTypes: () => client.request.mock.calls.map((c) => (c[0] as Cmd).type)
  }
}

function assistantEnd(opts: {
  text?: string
  toolUse?: { id: string; name: string; input: Cmd }
  cost?: number
}): Cmd {
  const content: Cmd[] = []
  if (opts.text !== undefined) content.push({ type: 'text', text: opts.text })
  if (opts.toolUse) {
    content.push({
      type: 'toolCall',
      id: opts.toolUse.id,
      name: opts.toolUse.name,
      arguments: opts.toolUse.input
    })
  }
  return {
    type: 'message_end',
    message: {
      role: 'assistant',
      content,
      provider: 'openai-codex',
      model: 'gpt-5.6-luna',
      usage: {
        input: 10,
        output: 5,
        cacheRead: 2,
        cacheWrite: 1,
        reasoning: 3,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: opts.cost ?? 0 }
      },
      stopReason: 'stop',
      timestamp: Date.now()
    }
  }
}

function toolResultEnd(toolCallId: string, text: string): Cmd {
  return {
    type: 'message_end',
    message: {
      role: 'toolResult',
      toolCallId,
      toolName: 'bash',
      content: [{ type: 'text', text }],
      isError: false,
      timestamp: Date.now()
    }
  }
}

const SETTLED = { type: 'agent_settled' }

function runnerOpts(
  child: ReturnType<typeof makeFakeChild>,
  over: Partial<PiChildRunnerOpts> = {}
): PiChildRunnerOpts {
  return {
    cwd: '/tmp/child-cwd',
    model: 'openai-codex/gpt-5.6-luna',
    spawn: child.spawn,
    spawnOpts: { gateHandler: async () => ({ behavior: 'allow' }), args: ['--no-session'] },
    ownerToolUseId: () => 'toolu_owner',
    emit: () => vi.fn(),
    ...over
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('PiChildRunner.start', () => {
  it('spawns with the cwd and spawn opts, then get_state, then set_model with the decoded model', async () => {
    const child = makeFakeChild()
    const runner = await PiChildRunner.start(runnerOpts(child))
    expect(child.spawnCalls).toHaveLength(1)
    expect(child.spawnCalls[0].cwd).toBe('/tmp/child-cwd')
    expect(child.spawnCalls[0].args).toEqual(['--no-session'])
    expect(child.commandTypes()).toEqual(['get_state', 'set_model'])
    expect(child.client.request.mock.calls[1][0]).toMatchObject({
      type: 'set_model',
      provider: 'openai-codex',
      modelId: 'gpt-5.6-luna'
    })
    expect(runner.sessionId).toBe('child-1')
    expect(runner.mapperState.sessionId).toBe('child-1')
    expect(child.client.dispose).not.toHaveBeenCalled()
  })

  it('a get_state without a session id disposes the child and its bridge, then throws', async () => {
    const child = makeFakeChild((cmd) =>
      cmd.type === 'get_state'
        ? { type: 'response', command: 'get_state', success: false, error: 'boom' }
        : defaultHandler(cmd)
    )
    await expect(PiChildRunner.start(runnerOpts(child))).rejects.toThrow('boom')
    expect(child.client.dispose).toHaveBeenCalledTimes(1)
    expect(child.bridgeDispose).toHaveBeenCalledTimes(1)
    expect(child.commandTypes()).toEqual(['get_state'])
  })

  it('a refused set_model disposes and throws pi’s message', async () => {
    const child = makeFakeChild((cmd) =>
      cmd.type === 'set_model'
        ? { type: 'response', command: 'set_model', success: false, error: 'no such model' }
        : defaultHandler(cmd)
    )
    await expect(PiChildRunner.start(runnerOpts(child))).rejects.toThrow('no such model')
    expect(child.client.dispose).toHaveBeenCalledTimes(1)
    expect(child.bridgeDispose).toHaveBeenCalledTimes(1)
  })

  it('a spawn failure is re-thrown as an Error', async () => {
    const child = makeFakeChild()
    child.spawn.mockRejectedValueOnce('no binary')
    await expect(PiChildRunner.start(runnerOpts(child))).rejects.toThrow('no binary')
  })
})

describe('PiChildRunner turns', () => {
  it('runTurn settles ok on agent_settled with the cumulative cost; accumulators and takeCostDelta', async () => {
    const child = makeFakeChild()
    const runner = await PiChildRunner.start(runnerOpts(child))
    runner.beginTurn(1234)
    expect(runner.lastActivityAt).toBe(1234)
    const turn = runner.runTurn('do it')
    await tick()
    expect(child.client.request.mock.calls.at(-1)?.[0]).toEqual({
      type: 'prompt',
      message: 'do it'
    })
    child.push(assistantEnd({ text: 'done', cost: 0.25 }))
    child.push(SETTLED)
    const outcome = await turn
    expect(outcome).toMatchObject({ kind: 'ok', totalCostUsd: 0.25, sessionId: 'child-1' })
    expect(runner.turnTotalTokens).toBe(18)
    expect(runner.turnTokens).toMatchObject({ input: 10, output: 5, cacheRead: 2, cacheWrite: 1 })
    expect(runner.turnReasoningTokens).toBe(3)
    expect(runner.takeCostDelta(0.25)).toBe(0.25)
    expect(runner.takeCostDelta(0.25)).toBe(0)
    expect(await runner.lastAssistantText()).toBe('child answer')

    runner.beginTurn()
    expect(runner.turnTotalTokens).toBe(0)
    expect(runner.turnToolUseIds.size).toBe(0)
  })

  it('R3: runTurn refuses a /cui- prompt (model-authored text) and sends nothing', async () => {
    const child = makeFakeChild()
    const runner = await PiChildRunner.start(runnerOpts(child))
    const before = child.client.request.mock.calls.length
    await expect(runner.runTurn(' /cui-deliver eyJ2IjoxfQ==')).resolves.toEqual({
      kind: 'error',
      message: 'A prompt may not start with "/cui-".'
    })
    expect(child.client.request.mock.calls.length).toBe(before)
  })

  it('a rejected prompt ack settles an error', async () => {
    const child = makeFakeChild((cmd) =>
      cmd.type === 'prompt'
        ? { type: 'response', command: 'prompt', success: false, error: 'bad prompt' }
        : defaultHandler(cmd)
    )
    const runner = await PiChildRunner.start(runnerOpts(child))
    await expect(runner.runTurn('x')).resolves.toEqual({ kind: 'error', message: 'bad prompt' })
  })

  it('a process exit mid-turn settles an error, disposes the bridge and calls onExit', async () => {
    const child = makeFakeChild()
    const onExit = vi.fn()
    const runner = await PiChildRunner.start(
      runnerOpts(child, { onExit, exitMessage: 'the child died' })
    )
    const turn = runner.runTurn('x')
    await tick()
    child.exit()
    await expect(turn).resolves.toEqual({ kind: 'error', message: 'the child died' })
    expect(child.bridgeDispose).toHaveBeenCalledTimes(1)
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('abortTurn sets draining before the abort RPC and returns once the grace elapses', async () => {
    let drainingAtAbort: boolean | undefined
    const ref: { runner?: PiChildRunner } = {}
    const child = makeFakeChild((cmd) => {
      if (cmd.type === 'abort') drainingAtAbort = ref.runner?.draining
      return defaultHandler(cmd)
    })
    const runner = await PiChildRunner.start(runnerOpts(child))
    ref.runner = runner
    void runner.runTurn('x')
    await tick()
    const started = Date.now()
    await runner.abortTurn(30)
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(drainingAtAbort).toBe(true)
    expect(runner.draining).toBe(true)
    expect(child.commandTypes()).toContain('abort')
    // A fresh turn is no longer draining.
    void runner.runTurn('y')
    expect(runner.draining).toBe(false)
  })

  it('abortTurn returns early when the abandoned turn settles inside the grace', async () => {
    const child = makeFakeChild()
    const runner = await PiChildRunner.start(runnerOpts(child))
    const turn = runner.runTurn('x')
    await tick()
    const aborting = runner.abortTurn(60_000)
    child.push(SETTLED)
    await aborting
    await expect(turn).resolves.toMatchObject({ kind: 'ok' })
  })

  it('reconciledTotalCostUsd prefers a larger get_session_stats figure and falls back on failure', async () => {
    let stats: Record<string, unknown> | Error = {
      type: 'response',
      command: 'get_session_stats',
      success: true,
      data: { cost: 0.9 }
    }
    const child = makeFakeChild((cmd) => {
      if (cmd.type !== 'get_session_stats') return defaultHandler(cmd)
      if (stats instanceof Error) throw stats
      return stats
    })
    const runner = await PiChildRunner.start(runnerOpts(child))
    expect(await runner.reconciledTotalCostUsd(100)).toBe(0.9)
    stats = new Error('wedged')
    expect(await runner.reconciledTotalCostUsd(100)).toBe(0)
  })

  it('dispose is idempotent', async () => {
    const child = makeFakeChild()
    const runner = await PiChildRunner.start(runnerOpts(child))
    runner.dispose()
    runner.dispose()
    expect(child.client.dispose).toHaveBeenCalledTimes(1)
    expect(child.bridgeDispose).toHaveBeenCalledTimes(1)
  })
})

describe('PiChildRunner output handling', () => {
  it('streams under the LIVE owner and emitter, re-targeting when they change between events', async () => {
    const child = makeFakeChild()
    let owner: string | undefined = 'toolu_a'
    const emitA = vi.fn()
    const emitB = vi.fn()
    let emit = emitA
    const runner = await PiChildRunner.start(
      runnerOpts(child, { ownerToolUseId: () => owner, emit: () => emit })
    )
    void runner.runTurn('x')
    await tick()
    child.push({ type: 'message_start', message: { role: 'assistant', content: [] } })
    child.push({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hel' }
    })
    owner = 'toolu_b'
    emit = emitB
    child.push({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'lo' }
    })
    const openA = emitA.mock.calls.find((c) => c[0] === 'session:item-open')
    expect(openA?.[1]).toMatchObject({ target: { ownerToolUseId: 'toolu_a' } })
    const deltaB = emitB.mock.calls.find((c) => c[0] === 'session:item-delta')
    expect(deltaB?.[1]).toMatchObject({ target: { ownerToolUseId: 'toolu_b' }, chunk: 'lo' })

    // No owner: nothing is emitted, but accounting and the trajectory still run.
    owner = undefined
    emitB.mockClear()
    child.push(assistantEnd({ text: 'Hello' }))
    expect(emitB).not.toHaveBeenCalled()
    expect(runner.turnTotalTokens).toBe(18)
    expect(runner.trajectory.size).toBe(1)
  })

  it('records assistant messages only in the trajectory and fires onUsage/onToolResult', async () => {
    const child = makeFakeChild()
    const onUsage = vi.fn()
    const onToolResult = vi.fn()
    const emit = vi.fn()
    const runner = await PiChildRunner.start(
      runnerOpts(child, { onUsage, onToolResult, emit: () => emit })
    )
    void runner.runTurn('x')
    await tick()
    child.push(
      assistantEnd({
        text: 'listing',
        toolUse: { id: 'call-1', name: 'bash', input: { command: 'ls' } }
      })
    )
    child.push(toolResultEnd('call-1', 'a b c'))

    expect([...runner.trajectory.values()].map((m) => m.role)).toEqual(['assistant'])
    expect(runner.turnToolUseIds).toEqual(new Set(['call-1']))
    expect(onUsage).toHaveBeenCalledTimes(1)
    expect(onUsage.mock.calls[0][0]).toMatchObject({ kind: 'usage', modelId: 'gpt-5.6-luna' })
    expect(onToolResult).toHaveBeenCalledTimes(1)
    expect(onToolResult.mock.calls[0][0]).toMatchObject({
      kind: 'tool_result',
      toolUseId: 'call-1',
      result: 'a b c',
      isError: false
    })
    const toolResultEmit = emit.mock.calls.find((c) => c[0] === 'session:subagent-tool-result')
    expect(toolResultEmit?.[1]).toEqual({
      toolUseId: 'toolu_owner',
      toolResultToolUseId: 'call-1',
      result: 'a b c',
      isError: false
    })
    // `usage` never reaches the stream.
    expect(emit.mock.calls.some((c) => String(c[0]).includes('usage'))).toBe(false)
  })
})

const deliveryPayload = (deliveryId: string, wake = true): PiAgentDelivery => ({
  v: 1,
  deliveryId,
  kind: 'task-notification',
  text: '<task-notification>\n<status>completed</status>\n</task-notification>',
  wake,
  title: 'Agent "g" completed',
  details: { agentId: 'ag-g', toolUseId: 'call-g', status: 'completed', runIndex: 1 }
})

/** The custom message pi emits for a delivered payload (probe P-S1). */
function deliveredEnd(p: PiAgentDelivery): Cmd {
  return {
    type: 'message_end',
    message: {
      role: 'custom',
      customType: 'claudeui-agent-message',
      content: [{ type: 'text', text: p.text }],
      display: true,
      details: { ...p.details, v: 1, kind: p.kind, deliveryId: p.deliveryId, title: p.title },
      timestamp: Date.now()
    }
  }
}

describe('PiChildRunner deliveries (ADR-089 S3)', () => {
  it('M5 (runner): deliver sends exactly one /cui-deliver prompt decoding to the payload, nothing else', async () => {
    const child = makeFakeChild()
    const runner = await PiChildRunner.start(runnerOpts(child))
    const before = child.client.request.mock.calls.length
    const p = deliveryPayload('d-1')
    await runner.deliver(p)
    const sent = child.client.request.mock.calls.slice(before).map((c) => c[0] as Cmd)
    expect(sent).toHaveLength(1)
    expect(sent[0].type).toBe('prompt')
    const message = String(sent[0].message)
    expect(message.startsWith('/cui-deliver ')).toBe(true)
    expect(message).not.toContain(p.text)
    const decoded = JSON.parse(
      Buffer.from(message.slice('/cui-deliver '.length), 'base64').toString('utf8')
    )
    expect(decoded).toEqual(p)
    expect(child.commandTypes()).not.toContain('steer')
    expect(child.commandTypes()).not.toContain('follow_up')
    expect(runner.pendingDeliveries.has('d-1')).toBe(true)
  })

  it('M3 (runner): the custom message_end clears the delivery, streams a system row under the owner, and never enters the trajectory', async () => {
    const child = makeFakeChild()
    const emit = vi.fn()
    const runner = await PiChildRunner.start(runnerOpts(child, { emit: () => emit }))
    const p = deliveryPayload('d-2')
    await runner.deliver(p)
    child.push(deliveredEnd(p))
    expect(runner.pendingDeliveries.size).toBe(0)
    const rows = emit.mock.calls.filter((c) => c[0] === 'session:subagent-message')
    expect(rows).toHaveLength(1)
    expect(rows[0][1]).toEqual({
      toolUseId: 'toolu_owner',
      message: expect.objectContaining({
        role: 'system',
        content: [
          {
            type: 'context_note',
            title: 'Agent "g" completed',
            fragments: [{ text: p.text, label: 'from an agent, not from you' }]
          }
        ]
      })
    })
    expect(runner.trajectory.size).toBe(0)
    // The child judge's messages are the root transcript followed by the trajectory.
    const root = [
      {
        id: 'u',
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'do X' }],
        timestamp: 0
      }
    ]
    expect(slimTranscript([...root, ...runner.trajectory.values()])).toBe('User: do X')
  })

  it('a refused ack drops the pending delivery', async () => {
    const child = makeFakeChild((cmd) =>
      cmd.type === 'prompt'
        ? { type: 'response', command: 'prompt', success: false, error: 'busy' }
        : defaultHandler(cmd)
    )
    const runner = await PiChildRunner.start(runnerOpts(child))
    await runner.deliver(deliveryPayload('d-3'))
    expect(runner.pendingDeliveries.size).toBe(0)
  })

  it('F3: a runtime send_message error while a delivery is pending drops it and does not end the turn; with none pending it is an ordinary error', async () => {
    const child = makeFakeChild()
    const runner = await PiChildRunner.start(runnerOpts(child))
    const turn = runner.runTurn('x')
    await runner.deliver(deliveryPayload('d-f3'))
    const runtimeError = {
      type: 'extension_error',
      extensionPath: '<runtime>',
      event: 'send_message',
      error: 'boom'
    }
    child.push(runtimeError)
    expect(runner.pendingDeliveries.size).toBe(0)
    let settled: unknown
    void turn.then((o) => (settled = o))
    await tick()
    expect(settled).toBeUndefined()
    child.push(runtimeError)
    await expect(turn).resolves.toEqual({ kind: 'error', message: 'boom' })
  })

  it('awaitTurn sends no prompt and settles on the next agent_settled of a run pi started itself', async () => {
    const child = makeFakeChild()
    const runner = await PiChildRunner.start(runnerOpts(child))
    const before = child.client.request.mock.calls.length
    const waiting = runner.awaitTurn(5_000)
    child.push({ type: 'agent_start' })
    child.push(assistantEnd({ text: 'more', cost: 0.1 }))
    child.push(SETTLED)
    await expect(waiting).resolves.toMatchObject({ kind: 'ok', totalCostUsd: 0.1 })
    expect(child.client.request.mock.calls.length).toBe(before)
    expect(runner.runActive).toBe(false)
  })

  it('awaitTurn returns idle after the grace when no run starts (a passive message alone is not a run)', async () => {
    vi.useFakeTimers()
    try {
      const child = makeFakeChild()
      const runner = await PiChildRunner.start(runnerOpts(child))
      let result: unknown
      void runner.awaitTurn(5_000).then((r) => (result = r))
      child.push(deliveredEnd(deliveryPayload('d-4', false)))
      await vi.advanceTimersByTimeAsync(4_999)
      expect(result).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1)
      expect(result).toEqual({ kind: 'idle' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('awaitTurn keeps waiting past the grace once a run started', async () => {
    vi.useFakeTimers()
    try {
      const child = makeFakeChild()
      const runner = await PiChildRunner.start(runnerOpts(child))
      let result: unknown
      void runner.awaitTurn(5_000).then((r) => (result = r))
      child.push({ type: 'agent_start' })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(result).toBeUndefined()
      child.push(SETTLED)
      await vi.advanceTimersByTimeAsync(0)
      expect(result).toMatchObject({ kind: 'ok' })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('forwardPiChildStream', () => {
  it('emits nothing without an owner and an [error] chunk for an error output', () => {
    const emit = vi.fn()
    forwardPiChildStream({ kind: 'error', message: 'nope' }, undefined, emit, new Set())
    expect(emit).not.toHaveBeenCalled()
    forwardPiChildStream({ kind: 'error', message: 'nope' }, 'toolu_x', emit, new Set())
    expect(emit).toHaveBeenCalledWith('session:subagent-message', {
      toolUseId: 'toolu_x',
      message: expect.objectContaining({
        role: 'assistant',
        content: [{ type: 'text', text: '[error: nope]' }]
      })
    })
  })
})

describe('PiChildRunner — the error of a turn the host aborted (ADR-090)', () => {
  /** P1: pi's aborted model request ends `stopReason: 'error'`, no content. */
  const abortedEnd: Cmd = {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [],
      provider: 'openai-codex',
      model: 'gpt-5.6-luna',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      stopReason: 'error',
      errorMessage: 'The operation was aborted.',
      timestamp: Date.now()
    }
  }
  const errorRows = (emit: ReturnType<typeof vi.fn>): unknown[] =>
    emit.mock.calls.filter(
      (c) => c[0] === 'session:subagent-message' && JSON.stringify(c[1]).includes('[error:')
    )

  it('E2: after abortTurn the error settles the turn but streams no [error: …] row', async () => {
    const child = makeFakeChild()
    const emit = vi.fn()
    const runner = await PiChildRunner.start(runnerOpts(child, { emit: () => emit }))
    const turn = runner.runTurn('x')
    await tick()
    const aborting = runner.abortTurn(60_000)
    child.push({ type: 'message_start', message: { role: 'assistant', content: [] } })
    child.push(abortedEnd)
    await aborting
    await expect(turn).resolves.toEqual({
      kind: 'error',
      message: 'The operation was aborted.'
    })
    expect(errorRows(emit)).toEqual([])
  })

  it('E2 (scope): without an abort the same error is still streamed as a row', async () => {
    const child = makeFakeChild()
    const emit = vi.fn()
    const runner = await PiChildRunner.start(runnerOpts(child, { emit: () => emit }))
    const turn = runner.runTurn('x')
    await tick()
    child.push({ type: 'message_start', message: { role: 'assistant', content: [] } })
    child.push(abortedEnd)
    await expect(turn).resolves.toMatchObject({ kind: 'error' })
    expect(errorRows(emit)).toHaveLength(1)
  })
})

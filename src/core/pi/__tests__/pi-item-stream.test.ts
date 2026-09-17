import { describe, expect, it } from 'vitest'
import { SyncCore } from '../../sync/sync-core'
import { createPiMapperState, mapPiEvent, type PiMapperOutput } from '../event-mapper'
import type { PiAssistantMessage, PiAssistantMessageEvent, PiEvent } from '../pi-protocol'

const assistant = (content: PiAssistantMessage['content'] = []): PiAssistantMessage => ({
  role: 'assistant',
  content,
  api: 'openai-completions',
  provider: 'fixture',
  model: 'fixture',
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  },
  stopReason: 'stop',
  timestamp: 1
})

const update = (assistantMessageEvent: PiAssistantMessageEvent): PiEvent => ({
  type: 'message_update',
  usage: assistant().usage,
  assistantMessageEvent
})

function apply(core: SyncCore, outputs: PiMapperOutput[]): void {
  for (const output of outputs) {
    if (output.kind === 'item_open')
      core.emit('session:item-open', ['pi', { target: output.target, message: output.message }])
    if (output.kind === 'item_delta')
      core.emit('session:item-delta', ['pi', { target: output.target, chunk: output.chunk }])
    if (output.kind === 'item_seal')
      core.emit('session:item-seal', [
        'pi',
        { message: output.message, ...(output.target ? { target: output.target } : {}) }
      ])
    if (output.kind === 'message') core.emit('session:message', ['pi', output.message])
  }
}

describe('Pi per-item streaming through SyncCore', () => {
  it('keeps interleaved thinking/text slots stable and token count out of the ring', () => {
    const core = new SyncCore({ capacity: 20 })
    core.emit('session:created', ['pi', { cwd: '/fixture', engineId: 'pi' }])
    const state = createPiMapperState()
    apply(core, mapPiEvent({ type: 'message_start', message: assistant() }, state))
    apply(
      core,
      mapPiEvent(update({ type: 'thinking_delta', contentIndex: 0, delta: 'why' }), state)
    )
    apply(core, mapPiEvent(update({ type: 'text_delta', contentIndex: 1, delta: 'a' }), state))
    const afterOpens = core.getSnapshot().seq

    for (let index = 0; index < 1_000; index += 1)
      apply(core, mapPiEvent(update({ type: 'text_delta', contentIndex: 1, delta: 'x' }), state))

    expect(core.getSnapshot().seq).toBe(afterOpens)
    const active = Object.values(core.getCanonicalState().sessions.pi.itemStreams)
    expect(active.map((stream) => stream.target.blockIndex).sort()).toEqual([0, 1])
    expect(active.find((stream) => stream.target.kind === 'thinking')?.value).toBe('why')
    expect(active.find((stream) => stream.target.kind === 'text')?.value).toBe(
      `a${'x'.repeat(1_000)}`
    )

    apply(
      core,
      mapPiEvent(
        {
          type: 'message_end',
          message: assistant([
            { type: 'thinking', thinking: 'why' },
            { type: 'text', text: 'authoritative' }
          ])
        },
        state
      )
    )
    const session = core.getCanonicalState().sessions.pi
    expect(Object.keys(session.itemStreams)).toHaveLength(0)
    expect(session.messages).toHaveLength(1)
    expect(session.messages[0].content).toEqual([
      { type: 'thinking', text: 'why', durationMs: expect.any(Number) },
      { type: 'text', text: 'authoritative' }
    ])
  })
})

import { describe, expect, it, vi } from 'vitest'
import { ClaudeItemStreamLifecycle } from '../claude-item-stream'
import type { ChatMessage } from '../../../shared/types'
import { SyncCore } from '../../sync/sync-core'

function harness() {
  const events: Array<{ kind: string; value: unknown }> = []
  const lifecycle = new ClaudeItemStreamLifecycle({
    open: (target, message) => events.push({ kind: 'open', value: { target, message } }),
    delta: (target, chunk) => events.push({ kind: 'delta', value: { target, chunk } }),
    seal: (target, message, owner) =>
      events.push({ kind: 'seal', value: { target, message, owner } }),
    updateLocal: (message, owner) => events.push({ kind: 'local', value: { message, owner } })
  })
  return { lifecycle, events }
}

describe('ClaudeItemStreamLifecycle', () => {
  it('folds 1000 native deltas through SyncCore without reliable prefix growth', () => {
    const core = new SyncCore({ capacity: 20 })
    core.emit('session:created', ['s', { cwd: '/fixture', engineId: 'claude' }])
    const lifecycle = new ClaudeItemStreamLifecycle({
      open: (target, message) => core.emit('session:item-open', ['s', { target, message }]),
      delta: (target, chunk) => core.emit('session:item-delta', ['s', { target, chunk }]),
      seal: (target, message, ownerToolUseId) =>
        core.emit('session:item-seal', [
          's',
          { ...(target ? { target } : {}), message, ...(ownerToolUseId ? { ownerToolUseId } : {}) }
        ]),
      updateLocal: () => {}
    })
    lifecycle.handleEvent({ type: 'message_start', message: { id: 'm' } }, undefined)
    lifecycle.handleEvent(
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      undefined
    )
    lifecycle.handleEvent(
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
      undefined
    )
    const afterOpen = core.getSnapshot().seq
    for (let i = 1; i < 1000; i++) {
      lifecycle.handleEvent(
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
        undefined
      )
    }
    expect(core.getSnapshot().seq).toBe(afterOpen)
    expect(Object.values(core.getCanonicalState().sessions.s.itemStreams)[0].value).toHaveLength(
      1000
    )
  })
  it('keeps block-local assistant snapshots at their native indices', () => {
    vi.spyOn(Date, 'now').mockReturnValue(100)
    const { lifecycle, events } = harness()
    lifecycle.handleEvent({ type: 'message_start', message: { id: 'msg' } }, undefined)
    lifecycle.handleEvent(
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      undefined
    )
    lifecycle.handleEvent(
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'why' } },
      undefined
    )
    lifecycle.handleSnapshot(
      {
        id: 'msg',
        role: 'assistant',
        content: [{ type: 'thinking', text: 'why' }],
        timestamp: 999
      },
      undefined
    )
    lifecycle.handleEvent({ type: 'content_block_stop', index: 0 }, undefined)
    lifecycle.handleEvent(
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      undefined
    )
    lifecycle.handleEvent(
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'answer' } },
      undefined
    )
    lifecycle.handleSnapshot(
      { id: 'msg', role: 'assistant', content: [{ type: 'text', text: 'answer' }], timestamp: 999 },
      undefined
    )
    lifecycle.handleEvent({ type: 'content_block_stop', index: 1 }, undefined)
    lifecycle.handleEvent({ type: 'message_stop' }, undefined)

    const full = events.filter((event) => event.kind === 'seal').at(-1)!.value as {
      message: ChatMessage
      target?: unknown
    }
    expect(full.target).toBeUndefined()
    expect(full.message.timestamp).toBe(100)
    expect(full.message.content).toMatchObject([
      { type: 'thinking', text: 'why' },
      { type: 'text', text: 'answer' }
    ])
  })

  it('isolates equal message ids by direct-child owner and seals root alone', () => {
    const { lifecycle, events } = harness()
    for (const owner of [undefined, 'tool-child']) {
      lifecycle.handleEvent({ type: 'message_start', message: { id: 'same' } }, owner)
      lifecycle.handleEvent(
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        owner
      )
      lifecycle.handleEvent(
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: owner ?? 'root' }
        },
        owner
      )
    }
    lifecycle.sealOwner(undefined)
    const fullSeals = events.filter(
      (event) => event.kind === 'seal' && !(event.value as { target?: unknown }).target
    )
    expect(fullSeals).toHaveLength(1)
    expect((fullSeals[0].value as { owner?: string }).owner).toBeUndefined()
    lifecycle.handleEvent({ type: 'message_stop' }, 'tool-child')
    expect(
      events.filter(
        (event) => event.kind === 'seal' && !(event.value as { target?: unknown }).target
      )
    ).toHaveLength(2)
  })

  it('keeps an equal-id child alive when root output is retracted', () => {
    const { lifecycle, events } = harness()
    for (const owner of [undefined, 'child']) {
      lifecycle.handleEvent({ type: 'message_start', message: { id: 'same' } }, owner)
      lifecycle.handleEvent(
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        owner
      )
      lifecycle.handleEvent(
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
        owner
      )
    }
    lifecycle.retract(['same'])
    lifecycle.handleEvent({ type: 'message_stop' }, 'child')
    expect(
      events.some(
        (event) =>
          event.kind === 'seal' &&
          (event.value as { owner?: string; target?: unknown }).owner === 'child' &&
          !(event.value as { target?: unknown }).target
      )
    ).toBe(true)
  })

  it('seals rollover partials without fabricating an empty successor', () => {
    const { lifecycle, events } = harness()
    lifecycle.handleEvent({ type: 'message_start', message: { id: 'old' } }, undefined)
    lifecycle.handleEvent(
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      undefined
    )
    lifecycle.handleEvent(
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } },
      undefined
    )
    lifecycle.handleEvent({ type: 'message_start', message: { id: 'new' } }, undefined)
    lifecycle.handleEvent({ type: 'message_stop' }, undefined)
    const full = events.filter(
      (event) => event.kind === 'seal' && !(event.value as { target?: unknown }).target
    )
    expect(full).toHaveLength(1)
    expect((full[0].value as { message: ChatMessage }).message.id).toBe('old')
  })

  it('reconciles a final block snapshot after an early child stop seal', () => {
    const { lifecycle, events } = harness()
    lifecycle.handleEvent({ type: 'message_start', message: { id: 'm' } }, 'child')
    for (const [index, text] of ['first', 'partial'].entries()) {
      lifecycle.handleEvent(
        { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
        'child'
      )
      lifecycle.handleEvent(
        { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
        'child'
      )
      if (index === 0) lifecycle.handleEvent({ type: 'content_block_stop', index }, 'child')
    }
    lifecycle.sealOwner('child', true)
    lifecycle.handleEvent(
      { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
      'child'
    )
    lifecycle.handleEvent(
      { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'late' } },
      'child'
    )
    lifecycle.handleSnapshot(
      { id: 'm', role: 'assistant', timestamp: 999, content: [{ type: 'text', text: 'final' }] },
      'child'
    )
    lifecycle.handleEvent({ type: 'message_stop' }, 'child')
    const final = events.filter((event) => event.kind === 'seal').at(-1)!.value as {
      message: ChatMessage
    }
    expect(final.message.content).toMatchObject([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'final' }
    ])
    expect(final.message.content).toHaveLength(2)
  })
})

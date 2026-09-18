import { describe, expect, it, vi } from 'vitest'
import { ClaudeItemStreamLifecycle } from '../claude-item-stream'
import type { ChatMessage } from '../../../shared/types'
import { SyncCore } from '../../sync/sync-core'

function harness() {
  const events: Array<{ kind: string; value: unknown }> = []
  const lifecycle = new ClaudeItemStreamLifecycle({
    open: (target, message, startedAt) =>
      events.push({ kind: 'open', value: { target, message, startedAt } }),
    delta: (target, chunk) => events.push({ kind: 'delta', value: { target, chunk } }),
    seal: (target, message, owner) =>
      events.push({ kind: 'seal', value: { target, message, owner } }),
    updateLocal: (message, owner) => events.push({ kind: 'local', value: { message, owner } }),
    publish: (message, owner) => events.push({ kind: 'publish', value: { message, owner } })
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
      updateLocal: () => {},
      publish: (message) => core.emit('session:message', ['s', message])
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
    expect(
      lifecycle.handleSnapshot(
        {
          id: 'msg',
          role: 'assistant',
          content: [{ type: 'thinking', text: 'why' }],
          timestamp: 999
        },
        undefined
      )
    ).toBe('handled')
    lifecycle.handleEvent({ type: 'content_block_stop', index: 0 }, undefined)
    lifecycle.handleEvent(
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      undefined
    )
    lifecycle.handleEvent(
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'answer' } },
      undefined
    )
    expect(
      lifecycle.handleSnapshot(
        {
          id: 'msg',
          role: 'assistant',
          content: [{ type: 'text', text: 'answer' }],
          timestamp: 999
        },
        undefined
      )
    ).toBe('handled')
    lifecycle.handleEvent({ type: 'content_block_stop', index: 1 }, undefined)
    lifecycle.handleEvent({ type: 'message_stop' }, undefined)

    // The thinking item's OWN clock rides its open, so the live timer counts
    // from the thought rather than from the message.
    const firstOpen = events.find((event) => event.kind === 'open')!.value as {
      target: { kind: string }
      startedAt?: number
    }
    expect(firstOpen.target.kind).toBe('thinking')
    expect(firstOpen.startedAt).toBe(100)
    const textOpen = events.filter((event) => event.kind === 'open').at(-1)!.value as {
      target: { kind: string }
      startedAt?: number
    }
    expect(textOpen.target.kind).toBe('text')
    expect(textOpen.startedAt).toBeUndefined()

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

  it('falls through when a one-block snapshot matches no live block', () => {
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
    lifecycle.handleEvent(
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      undefined
    )
    lifecycle.handleEvent(
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'answer' } },
      undefined
    )
    // No `content_block_start` for a tool_use ever arrived, so the lifecycle has
    // nowhere to put this block: the caller must emit it the ordinary way.
    const before = events.length
    expect(
      lifecycle.handleSnapshot(
        {
          id: 'msg',
          role: 'assistant',
          timestamp: 999,
          content: [{ type: 'tool_use', toolName: 'Bash', toolInput: {}, toolUseId: 'toolu_1' }]
        },
        undefined
      )
    ).toBe('none')
    expect(events.slice(before).filter((event) => event.kind === 'local')).toHaveLength(0)
  })

  it('falls through when every block of an equal-length snapshot mismatches', () => {
    const { lifecycle, events } = harness()
    lifecycle.handleEvent({ type: 'message_start', message: { id: 'msg' } }, undefined)
    lifecycle.handleEvent(
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      undefined
    )
    lifecycle.handleEvent(
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'answer' } },
      undefined
    )
    const before = events.length
    expect(
      lifecycle.handleSnapshot(
        {
          id: 'msg',
          role: 'assistant',
          timestamp: 999,
          content: [{ type: 'thinking', text: 'why' }]
        },
        undefined
      )
    ).toBe('none')
    expect(events.slice(before).filter((event) => event.kind === 'local')).toHaveLength(0)
  })

  it('frees terminal-sealed child states when the root turn ends', () => {
    const { lifecycle, events } = harness()
    for (const owner of [undefined, 'child']) {
      lifecycle.handleEvent(
        { type: 'message_start', message: { id: `m-${owner ?? 'root'}` } },
        owner
      )
      lifecycle.handleEvent(
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        owner
      )
      lifecycle.handleEvent(
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
        owner
      )
    }
    // The child finished but its state is RETAINED for a native message_stop
    // that may never arrive (a background child whose parent turn ends first).
    lifecycle.sealOwner('child', true)
    expect(lifecycle.activeOwnerCount()).toBe(2)

    // The root turn ending is the point at which no straggler can still matter.
    lifecycle.sealOwner(undefined)
    expect(lifecycle.activeOwnerCount()).toBe(0)

    const afterRoot = events.length
    lifecycle.handleEvent({ type: 'message_stop' }, 'child')
    expect(events).toHaveLength(afterRoot)
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

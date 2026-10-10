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
    publish: (message, owner) => events.push({ kind: 'publish', value: { message, owner } }),
    retractToolUses: (messageId, toolUseIds, owner) =>
      events.push({ kind: 'retract', value: { messageId, toolUseIds, owner } })
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
      publish: (message) => core.emit('session:message', ['s', message]),
      retractToolUses: () => {}
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

  /**
   * A tool call cut off mid-stream never runs and never gets a result, and
   * cli.js never snapshots it (verified: session efa47532…, `stop_reason:
   * "max_tokens"` while streaming a Write — the message's snapshots are only
   * its two thinking blocks). Its `{}` scaffold was published the moment the
   * block started, so without a retraction the card spins forever.
   */
  describe('tool calls cut off mid-stream', () => {
    type Harness = ReturnType<typeof harness>
    const OWNER = 'toolu_agent'

    const start = (h: Harness, owner?: string): void =>
      h.lifecycle.handleEvent({ type: 'message_start', message: { id: 'msg' } }, owner)
    const thinking = (h: Harness, index: number, owner?: string): void => {
      h.lifecycle.handleEvent(
        { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } },
        owner
      )
      h.lifecycle.handleEvent(
        { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: 'hm' } },
        owner
      )
      h.lifecycle.handleSnapshot(
        { id: 'msg', role: 'assistant', timestamp: 1, content: [{ type: 'thinking', text: 'hm' }] },
        owner
      )
      h.lifecycle.handleEvent({ type: 'content_block_stop', index }, owner)
    }
    const toolStart = (h: Harness, index: number, id: string, owner?: string): void =>
      h.lifecycle.handleEvent(
        {
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id, name: 'Write', input: {} }
        },
        owner
      )
    const toolSnapshot = (h: Harness, id: string, owner?: string): unknown =>
      h.lifecycle.handleSnapshot(
        {
          id: 'msg',
          role: 'assistant',
          timestamp: 1,
          content: [
            { type: 'tool_use', toolUseId: id, toolName: 'Write', toolInput: { file_path: '/x' } }
          ]
        },
        owner
      )
    const stop = (h: Harness, stopReason: string, owner?: string): void => {
      h.lifecycle.handleEvent({ type: 'message_delta', delta: { stop_reason: stopReason } }, owner)
      h.lifecycle.handleEvent({ type: 'message_stop' }, owner)
    }
    const retractions = (h: Harness): Array<Record<string, unknown>> =>
      h.events.filter((e) => e.kind === 'retract').map((e) => e.value as Record<string, unknown>)
    const finalSeal = (h: Harness): ChatMessage | undefined =>
      (
        h.events
          .filter((e) => e.kind === 'seal' && !(e.value as { target?: unknown }).target)
          .at(-1)?.value as { message: ChatMessage } | undefined
      )?.message
    const lastLocal = (h: Harness): ChatMessage =>
      (h.events.filter((e) => e.kind === 'local').at(-1)!.value as { message: ChatMessage }).message
    const toolIds = (m: ChatMessage | undefined): string[] =>
      (m?.content ?? []).flatMap((b) => (b.type === 'tool_use' ? [b.toolUseId] : []))

    it('retracts the unsnapshotted call when the output limit cuts it', () => {
      const h = harness()
      start(h)
      thinking(h, 0)
      toolStart(h, 1, 'toolu_cut')
      // The scaffold is out on every client already — that is the phantom.
      expect(h.events.some((e) => e.kind === 'publish')).toBe(true)
      stop(h, 'max_tokens')

      expect(retractions(h)).toEqual([
        { messageId: 'msg', toolUseIds: ['toolu_cut'], owner: undefined }
      ])
      expect(finalSeal(h)!.content.map((b) => b.type)).toEqual(['thinking'])
      expect(toolIds(lastLocal(h))).toEqual([])
      // Reported before the seal, so no client ever holds a sealed phantom.
      const kinds = h.events.map((e) => e.kind)
      expect(kinds.indexOf('retract')).toBeLessThan(kinds.lastIndexOf('seal'))
    })

    it('never retracts a call whose message stopped for tool_use, even if its snapshot lags', () => {
      const h = harness()
      start(h, OWNER)
      toolStart(h, 0, 'toolu_real', OWNER)
      h.lifecycle.handleEvent({ type: 'content_block_stop', index: 0 }, OWNER)
      stop(h, 'tool_use', OWNER)
      // A sub-agent's snapshot takes a different path than Patch E's stream
      // events, so it may land only after message_stop.
      toolSnapshot(h, 'toolu_real', OWNER)

      expect(retractions(h)).toEqual([])
      expect(toolIds(finalSeal(h))).toEqual(['toolu_real'])
    })

    it('retracts only the unconfirmed call when a complete one precedes it', () => {
      const h = harness()
      start(h)
      toolStart(h, 0, 'toolu_done')
      expect(toolSnapshot(h, 'toolu_done')).toBe('handled')
      h.lifecycle.handleEvent({ type: 'content_block_stop', index: 0 }, undefined)
      toolStart(h, 1, 'toolu_cut')
      stop(h, 'max_tokens')

      expect(retractions(h)).toEqual([
        { messageId: 'msg', toolUseIds: ['toolu_cut'], owner: undefined }
      ])
      expect(toolIds(finalSeal(h))).toEqual(['toolu_done'])
      expect(toolIds(lastLocal(h))).toEqual(['toolu_done'])
    })

    it('retracts a call cut by sealAll mid-stream (no message_delta at all)', () => {
      const h = harness()
      start(h, OWNER)
      thinking(h, 0, OWNER)
      toolStart(h, 1, 'toolu_cut', OWNER)
      h.lifecycle.sealAll()

      expect(retractions(h)).toEqual([
        { messageId: 'msg', toolUseIds: ['toolu_cut'], owner: OWNER }
      ])
      expect(finalSeal(h)!.content.map((b) => b.type)).toEqual(['thinking'])
    })

    it('counts a snapshot that falls through to the ordinary upsert as confirmation', () => {
      const h = harness()
      start(h)
      thinking(h, 0)
      toolStart(h, 1, 'toolu_real')
      // Neither the one-block nor the equal-length placement applies: 'none'.
      expect(
        h.lifecycle.handleSnapshot(
          {
            id: 'msg',
            role: 'assistant',
            timestamp: 1,
            content: [
              { type: 'thinking', text: 'hm' },
              { type: 'tool_use', toolUseId: 'toolu_real', toolName: 'Write', toolInput: {} },
              { type: 'text', text: 'extra' }
            ]
          },
          undefined
        )
      ).toBe('none')
      stop(h, 'max_tokens')

      expect(retractions(h)).toEqual([])
      expect(toolIds(finalSeal(h))).toEqual(['toolu_real'])
    })

    it('ignores a snapshot of another message when deciding what was confirmed', () => {
      const h = harness()
      start(h)
      toolStart(h, 0, 'toolu_cut')
      h.lifecycle.handleSnapshot(
        {
          id: 'other',
          role: 'assistant',
          timestamp: 1,
          content: [{ type: 'tool_use', toolUseId: 'toolu_cut', toolName: 'Write', toolInput: {} }]
        },
        undefined
      )
      stop(h, 'end_turn')
      expect(retractions(h)).toEqual([
        { messageId: 'msg', toolUseIds: ['toolu_cut'], owner: undefined }
      ])
    })

    it('retracts a message that was nothing but the cut call without sealing it', () => {
      const h = harness()
      start(h)
      toolStart(h, 0, 'toolu_cut')
      stop(h, 'max_tokens')
      expect(retractions(h)).toEqual([
        { messageId: 'msg', toolUseIds: ['toolu_cut'], owner: undefined }
      ])
      expect(finalSeal(h)).toBeUndefined()
      expect(h.lifecycle.activeOwnerCount()).toBe(0)
    })

    it('leaves whole-message retraction as it was', () => {
      const h = harness()
      start(h)
      toolStart(h, 0, 'toolu_cut')
      h.lifecycle.retract(['msg'])
      h.lifecycle.handleEvent({ type: 'message_stop' }, undefined)
      expect(retractions(h)).toEqual([])
      expect(finalSeal(h)).toBeUndefined()
      expect(toolSnapshot(h, 'toolu_cut')).toBe('drop')
    })

    it('leaves no phantom in canonical state once folded through SyncCore', () => {
      const core = new SyncCore({ capacity: 50 })
      core.emit('session:created', ['s', { cwd: '/fixture', engineId: 'claude' }])
      const lifecycle = new ClaudeItemStreamLifecycle({
        open: (target, message) => core.emit('session:item-open', ['s', { target, message }]),
        delta: (target, chunk) => core.emit('session:item-delta', ['s', { target, chunk }]),
        seal: (target, message) =>
          core.emit('session:item-seal', ['s', { ...(target ? { target } : {}), message }]),
        updateLocal: () => {},
        publish: (message) => core.emit('session:message', ['s', message]),
        retractToolUses: (messageId, toolUseIds) =>
          core.emit('session:tool-uses-retracted', ['s', { messageId, toolUseIds }])
      })
      const h = { lifecycle, events: [] } as unknown as Harness
      start(h)
      thinking(h, 0)
      toolStart(h, 1, 'toolu_cut')
      expect(toolIds(core.getCanonicalState().sessions.s.messages[0])).toEqual(['toolu_cut'])
      stop(h, 'max_tokens')

      const [message] = core.getCanonicalState().sessions.s.messages
      expect(message.content.map((b) => b.type)).toEqual(['thinking'])
      expect(core.getCanonicalState().sessions.s.itemStreams).toEqual({})
    })
  })
})

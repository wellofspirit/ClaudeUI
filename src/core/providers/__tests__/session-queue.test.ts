/**
 * @vitest-environment node
 *
 * SessionQueue invariants (ADR-053). The engine suites cover the end-to-end
 * paths; this pins the list semantics they all depend on.
 */
import { describe, it, expect } from 'vitest'
import { SessionQueue } from '../session-queue'
import type { QueuedItem } from '../../../shared/types'

function makeQueue(): { queue: SessionQueue; broadcasts: QueuedItem[][] } {
  const broadcasts: QueuedItem[][] = []
  const queue = new SessionQueue((items) => broadcasts.push(items))
  return { queue, broadcasts }
}

describe('SessionQueue', () => {
  it('mints distinct ids and preserves send order', () => {
    const { queue } = makeQueue()
    const a = queue.add('one')
    const b = queue.add('two')
    expect(a.itemId).not.toBe(b.itemId)
    expect(queue.pending().map((i) => i.text)).toEqual(['one', 'two'])
  })

  it('drops an empty attachment list rather than shipping `attachments: []`', () => {
    const { queue } = makeQueue()
    expect(queue.add('bare', []).attachments).toBeUndefined()
    expect(
      queue.add('with', [{ mediaType: 'image/png', base64Data: 'A' }]).attachments
    ).toHaveLength(1)
  })

  it('consumeByText picks the FIRST matching pending item (duplicates are interchangeable)', () => {
    const { queue } = makeQueue()
    const first = queue.add('again')
    const second = queue.add('again')

    expect(queue.consumeByText('again')?.itemId).toBe(first.itemId)
    expect(queue.pending().map((i) => i.itemId)).toEqual([second.itemId])
    expect(queue.consumeByText('again')?.itemId).toBe(second.itemId)
    // Nothing left to match — safe to call from every engine's ack path.
    expect(queue.consumeByText('again')).toBeUndefined()
  })

  it('emit broadcasts the FULL list once, then prunes terminal items', () => {
    const { queue, broadcasts } = makeQueue()
    queue.add('consumed one')
    const kept = queue.add('still queued')
    queue.consumeByText('consumed one')

    queue.emit()
    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0].map((i) => [i.text, i.state])).toEqual([
      ['consumed one', 'consumed'],
      ['still queued', 'queued']
    ])

    // The consumed item rode exactly one broadcast — a client synthesizes its
    // chat message from that and never sees it again.
    queue.emit()
    expect(broadcasts).toHaveLength(2)
    expect(broadcasts[1].map((i) => i.itemId)).toEqual([kept.itemId])
  })

  it('emit is a no-op on an empty list, so callers can fire it unconditionally', () => {
    const { queue, broadcasts } = makeQueue()
    queue.emit()
    expect(broadcasts).toHaveLength(0)
  })

  it('broadcasts copies — a later mutation cannot rewrite an already-sent payload', () => {
    const { queue, broadcasts } = makeQueue()
    const item = queue.add('mutate me')
    queue.emit()
    queue.setState(item, 'recalled')
    expect(broadcasts[0][0].state).toBe('queued')
  })

  it('tracks forwarding out-of-band, and forgets it once the item is terminal', () => {
    const { queue } = makeQueue()
    const item = queue.add('held')
    expect(queue.nextUnforwarded()).toBe(item)
    expect(queue.isForwarded(item)).toBe(false)

    queue.markForwarded(item)
    expect(queue.nextUnforwarded()).toBeUndefined()
    // Never on the wire — it's a core-side delivery detail, not domain state.
    expect(item).not.toHaveProperty('forwarded')

    queue.unmarkForwarded(item)
    expect(queue.nextUnforwarded()).toBe(item)

    queue.markForwarded(item)
    queue.consumeByText('held')
    queue.emit()
    expect(queue.isForwarded(item)).toBe(false)
  })
})

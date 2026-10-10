/**
 * @vitest-environment node
 *
 * SessionQueue invariants (ADR-053). The engine suites cover the end-to-end
 * paths; this pins the list semantics they all depend on.
 */
import { describe, it, expect } from 'vitest'
import { SessionQueue } from '../session-queue'
import type { AttachmentRef, AttachmentUpload, QueuedItem } from '../../../shared/types'

function makeQueue(): { queue: SessionQueue; broadcasts: QueuedItem[][] } {
  const broadcasts: QueuedItem[][] = []
  const queue = new SessionQueue((items) => broadcasts.push(items))
  return { queue, broadcasts }
}

const UPLOAD: AttachmentUpload = {
  mediaType: 'image/png',
  base64Data: 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=',
  fileName: 'shot.png'
}
const REF: AttachmentRef = {
  mediaType: 'image/png',
  blobId: 'c'.repeat(64),
  bytes: 26,
  fileName: 'shot.png'
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
    expect(queue.add('bare', [], []).attachments).toBeUndefined()
    expect(queue.add('bare', undefined, undefined).attachments).toBeUndefined()
    expect(queue.add('with', [UPLOAD], [REF]).attachments).toHaveLength(1)
  })

  // ADR-087: the item is BROADCAST and folded into canonical state, so it carries
  // refs. The bytes the engine still needs are kept beside it, never on it.
  it('broadcasts refs only, and keeps the upload bytes beside the item', () => {
    const { queue, broadcasts } = makeQueue()
    const item = queue.add('look', [UPLOAD], [REF])

    expect(item.attachments).toEqual([REF])
    expect(queue.uploadsFor(item)).toEqual([UPLOAD])

    queue.emit()
    expect(JSON.stringify(broadcasts)).not.toContain(UPLOAD.base64Data)
    expect(broadcasts[0][0].attachments).toEqual([REF])
    // Still pending, so the drain can still read its bytes after a broadcast.
    expect(queue.uploadsFor(item)).toEqual([UPLOAD])
  })

  it('drops the upload bytes when the item goes terminal, not before', () => {
    const { queue } = makeQueue()
    const consumed = queue.add('a', [UPLOAD], [REF])
    const recalled = queue.add('b', [UPLOAD], [REF])
    const pending = queue.add('c', [UPLOAD], [REF])
    queue.consumeById(consumed.itemId)
    queue.recallById(recalled.itemId)

    // Terminal but not yet broadcast: the terminal transition rides one more emit.
    expect(queue.uploadsFor(consumed)).toBeDefined()
    queue.emit()

    expect(queue.uploadsFor(consumed)).toBeUndefined()
    expect(queue.uploadsFor(recalled)).toBeUndefined()
    expect(queue.uploadsFor(pending)).toEqual([UPLOAD])
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

  it('consumeById takes THAT item, so duplicate texts never collide', () => {
    const { queue } = makeQueue()
    const first = queue.add('again')
    const second = queue.add('again')

    expect(queue.consumeById(second.itemId)?.itemId).toBe(second.itemId)
    expect(queue.pending().map((i) => i.itemId)).toEqual([first.itemId])
    // Already terminal, and an unknown id — both are no-ops, not throws.
    expect(queue.consumeById(second.itemId)).toBeUndefined()
    expect(queue.consumeById('never-queued')).toBeUndefined()
  })

  it('recallById recalls only a still-queued item — a consumed one stays consumed', () => {
    const { queue } = makeQueue()
    const consumed = queue.add('ran')
    const pending = queue.add('dropped')
    queue.consumeById(consumed.itemId)

    // cli.js can report `cancelled` for a message it had already started (the
    // consuming turn was aborted): the steer bubble must not turn into a recall.
    expect(queue.recallById(consumed.itemId)).toBeUndefined()
    expect(consumed.state).toBe('consumed')

    expect(queue.recallById(pending.itemId)?.state).toBe('recalled')
    expect(queue.recallById(pending.itemId)).toBeUndefined()
    expect(queue.recallById('never-queued')).toBeUndefined()
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

  it('stamps each item with its queue time off the wire, and forgets it once terminal (ADR-091 §4)', () => {
    let now = 1_000
    const queue = new SessionQueue(
      () => {},
      () => now
    )
    const first = queue.add('first')
    now = 2_000
    const second = queue.add('second')
    expect(queue.queuedAt(first)).toBe(1_000)
    expect(queue.queuedAt(second)).toBe(2_000)
    expect(first).not.toHaveProperty('queuedAt')

    queue.consumeByText('first')
    queue.emit()
    expect(queue.queuedAt(first)).toBeUndefined()
    expect(queue.queuedAt(second)).toBe(2_000)
  })
})

import { randomUUID } from 'crypto'
import type { QueuedItem } from '../../shared/types'

type Attachments = QueuedItem['attachments']

/**
 * The per-session queue of record (ADR-053 / `docs/architecture/sync-core.md`
 * §Queue).
 *
 * Composed into {@link BaseSession} rather than inlined there: the list is
 * engine-neutral policy with invariants of its own (FIFO order, first-match
 * text correlation, exactly one broadcast per terminal transition), and keeping
 * it in its own object lets those invariants be tested without an Electron
 * BrowserWindow or a live engine.
 *
 * {@link SessionQueue.emit} broadcasts the FULL list — idempotent and
 * replay-safe — and only afterwards prunes the terminal (`consumed`/`recalled`)
 * items. So every client sees each terminal transition exactly once (enough to
 * synthesize the chat message for a consumed item) while the retained list
 * never grows past what is still pending.
 */
export class SessionQueue {
  private items: QueuedItem[] = []
  /**
   * Item ids already handed to the engine. Deliberately NOT part of
   * {@link QueuedItem} (and so never on the wire): it is a core-side delivery
   * detail, not a domain state clients converge on.
   */
  private forwarded = new Set<string>()

  constructor(private readonly broadcast: (items: QueuedItem[]) => void) {}

  /** Items still awaiting consumption, oldest first. Live references. */
  pending(): QueuedItem[] {
    return this.items.filter((item) => item.state === 'queued')
  }

  /** The oldest pending item that has not been handed to the engine yet. */
  nextUnforwarded(): QueuedItem | undefined {
    return this.items.find((item) => item.state === 'queued' && !this.forwarded.has(item.itemId))
  }

  isForwarded(item: QueuedItem): boolean {
    return this.forwarded.has(item.itemId)
  }

  markForwarded(item: QueuedItem): void {
    this.forwarded.add(item.itemId)
  }

  /** Undo a forward whose delivery failed, making the item recallable again. */
  unmarkForwarded(item: QueuedItem): void {
    this.forwarded.delete(item.itemId)
  }

  add(text: string, attachments?: Attachments): QueuedItem {
    const item: QueuedItem = { itemId: randomUUID(), text, state: 'queued' }
    if (attachments && attachments.length > 0) item.attachments = attachments
    this.items.push(item)
    return item
  }

  /**
   * Consume the FIRST pending item whose text matches — the correlation ADR-053
   * pins, because neither cli.js's native queue entries nor an opencode/pi post
   * carry an id we chose. Duplicate texts are interchangeable, so taking the
   * oldest is both deterministic and harmless. Returns undefined (a no-op) for
   * a prompt that was never queued, which is what makes it safe to call from
   * every engine's post-send ack path.
   */
  consumeByText(text: string): QueuedItem | undefined {
    const item = this.items.find((i) => i.state === 'queued' && i.text === text)
    if (item) item.state = 'consumed'
    return item
  }

  setState(item: QueuedItem, state: QueuedItem['state']): void {
    item.state = state
  }

  /**
   * Broadcast the full list, then drop the terminal items. A no-op when there
   * is nothing to report, so callers can fire it unconditionally.
   */
  emit(): void {
    if (this.items.length === 0) return
    this.broadcast(this.items.map((item) => ({ ...item })))
    for (const item of this.items) {
      if (item.state !== 'queued') this.forwarded.delete(item.itemId)
    }
    this.items = this.items.filter((item) => item.state === 'queued')
  }
}

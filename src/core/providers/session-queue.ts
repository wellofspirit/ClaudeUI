import { randomUUID } from 'crypto'
import type { AttachmentRef, AttachmentUpload, QueuedItem } from '../../shared/types'

/**
 * The per-session queue of record (ADR-053 / `docs/architecture/sync-core.md`
 * §Queue).
 *
 * Composed into {@link BaseSession} rather than inlined there: the list is
 * engine-neutral policy with invariants of its own (FIFO order, first-match
 * text or exact-id correlation, exactly one broadcast per terminal transition),
 * and keeping it in its own object lets those invariants be tested without an
 * Electron BrowserWindow or a live engine.
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
  /**
   * The engine-bound bytes of each item's attachments, by item id. Private for
   * the same reason as {@link forwarded}, and for a stronger one: the item is
   * BROADCAST and folded into canonical state, so it carries blob refs only
   * (ADR-087), while the engine still needs the upload it was sent. Dropped with
   * the item when {@link emit} prunes it.
   */
  private uploads = new Map<string, AttachmentUpload[]>()

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

  /**
   * Queue a prompt. `uploads` are what the engine will be handed
   * ({@link uploadsFor}); `refs` are what the broadcast item carries.
   */
  add(text: string, uploads?: AttachmentUpload[], refs?: AttachmentRef[]): QueuedItem {
    const item: QueuedItem = { itemId: randomUUID(), text, state: 'queued' }
    if (refs && refs.length > 0) item.attachments = refs
    if (uploads && uploads.length > 0) this.uploads.set(item.itemId, uploads)
    this.items.push(item)
    return item
  }

  /** The attachment bytes to hand the engine for this item, if it has any. */
  uploadsFor(item: QueuedItem): AttachmentUpload[] | undefined {
    return this.uploads.get(item.itemId)
  }

  /**
   * Consume the FIRST pending item whose text matches — the correlation ADR-053
   * pins for opencode and pi, whose posts carry no id we chose (claude and
   * Codex correlate by id, {@link consumeById}). Duplicate texts are
   * interchangeable, so taking the oldest is both deterministic and harmless.
   * Returns undefined (a no-op) for a prompt that was never queued, which is
   * what makes it safe to call from every engine's post-send ack path.
   */
  consumeByText(text: string): QueuedItem | undefined {
    const item = this.items.find((i) => i.state === 'queued' && i.text === text)
    if (item) item.state = 'consumed'
    return item
  }

  /**
   * Consume ONE named item — the correlation for an engine that carries a
   * client-chosen id end to end (Codex's `clientUserMessageId`, ADR-066;
   * Claude's user-frame `uuid`, whose `command_lifecycle` frames name it back).
   * Text never enters into it, so duplicate texts stay individually
   * addressable. Returns undefined for an id that is unknown or already
   * terminal, so it is as safe to fire unconditionally as {@link consumeByText}.
   */
  consumeById(itemId: string): QueuedItem | undefined {
    return this.settleById(itemId, 'consumed')
  }

  /**
   * Recall ONE named item the engine reports it will never run (Claude's
   * `command_lifecycle` `cancelled` / `discarded` / `refused`). Same contract as
   * {@link consumeById}: undefined, and no change, for an id that is unknown or
   * already terminal — a consumed item stays consumed.
   */
  recallById(itemId: string): QueuedItem | undefined {
    return this.settleById(itemId, 'recalled')
  }

  private settleById(itemId: string, state: 'consumed' | 'recalled'): QueuedItem | undefined {
    const item = this.items.find((i) => i.state === 'queued' && i.itemId === itemId)
    if (item) item.state = state
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
      if (item.state === 'queued') continue
      this.forwarded.delete(item.itemId)
      this.uploads.delete(item.itemId)
    }
    this.items = this.items.filter((item) => item.state === 'queued')
  }
}

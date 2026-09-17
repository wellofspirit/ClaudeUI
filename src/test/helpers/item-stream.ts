import type { TestApp } from './boot-test-app'
import type { ItemStreamTarget } from '../../core/shared/sync/item-stream'

interface ItemDeltaOptions {
  kind?: 'text' | 'thinking'
  messageId?: string
  ownerToolUseId?: string
  /** True only for the first chunk of this explicit item lifecycle. */
  open: boolean
}

/** Emit a real item lifecycle delta with deterministic transcript identity. */
export function emitItemDelta(
  app: TestApp,
  routingId: string,
  chunk: string,
  options: ItemDeltaOptions
): ItemStreamTarget {
  const kind = options.kind ?? 'text'
  const messageId = options.messageId ?? `stream-${routingId}-${kind}`
  const target: ItemStreamTarget = {
    messageId,
    blockIndex: 0,
    kind,
    ...(options.ownerToolUseId ? { ownerToolUseId: options.ownerToolUseId } : {})
  }
  if (options.open) {
    app.emit('session:item-open', routingId, {
      target,
      message: {
        id: messageId,
        role: 'assistant',
        timestamp: 1,
        content: [{ type: kind, text: '' }]
      }
    })
  }
  app.emit('session:item-delta', routingId, { target, chunk })
  return target
}

/** Reliably finish an item and clear its volatile accumulation. */
export function sealItem(
  app: TestApp,
  routingId: string,
  target: ItemStreamTarget,
  text: string
): void {
  app.emit('session:item-seal', routingId, {
    target,
    ownerToolUseId: target.ownerToolUseId,
    message: {
      id: target.messageId,
      role: 'assistant',
      timestamp: 1,
      content: [
        target.kind === 'plan'
          ? {
              type: 'tool_use',
              toolName: 'plan',
              toolInput: { plan: text },
              toolUseId: target.messageId
            }
          : { type: target.kind, text }
      ]
    }
  })
}

export function appendItem(
  app: TestApp,
  routingId: string,
  target: ItemStreamTarget,
  chunk: string
): void {
  app.emit('session:item-delta', routingId, { target, chunk })
}

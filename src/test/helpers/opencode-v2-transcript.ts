/**
 * Live/cold parity for the opencode 2.x mapper (ADR-097 S4): fold the LIVE
 * mapper outputs into a transcript the way the shared reducer would
 * (`core/shared/sync/reducer.ts`: upsert by id keeping appended results,
 * item open/delta/seal on a block, a tool result appended to the message
 * holding its `tool_use`), then normalize it and the COLD converter's output
 * to one comparable shape.
 *
 * The fold is strict where the reducer would silently drop or dedupe: a delta
 * for a block that is not the right kind, a result with no `tool_use` to attach
 * to, a SECOND result for a call, or a second terminal notification for a
 * call throws — mapper bugs the reducer's first-wins rules would hide.
 */
import type { ChatMessage, ContentBlock, TaskNotification } from '../../shared/types'
import type { OpencodeMapperOutput } from '../../core/opencode/event-mapper'
import type { OpencodeHistory } from '../../core/opencode/history'

export type Transcript = OpencodeHistory

export function emptyTranscript(): Transcript {
  return { messages: [], subagentMessages: {}, taskNotifications: [] }
}

function listOf(t: Transcript, owner: string | undefined): ChatMessage[] {
  return owner ? (t.subagentMessages[owner] ??= []) : t.messages
}

function upsert(list: ChatMessage[], message: ChatMessage): void {
  const index = list.findIndex((entry) => entry.id === message.id)
  if (index < 0) {
    list.push(structuredClone(message))
    return
  }
  const kept = list[index].content.filter(
    (block) =>
      block.type === 'tool_result' &&
      !message.content.some((b) => b.type === 'tool_result' && b.toolUseId === block.toolUseId)
  )
  list[index] = {
    ...structuredClone(message),
    content: [...structuredClone(message.content), ...kept]
  }
}

/** Apply live outputs in order (mutates and returns `into`). */
export function foldOutputs(
  outputs: readonly OpencodeMapperOutput[],
  into: Transcript = emptyTranscript()
): Transcript {
  for (const output of outputs) {
    switch (output.kind) {
      case 'message':
        upsert(listOf(into, output.ownerToolUseId), output.message)
        break
      case 'user-message':
        upsert(into.messages, output.message)
        break
      case 'item-open':
        upsert(listOf(into, output.open.target.ownerToolUseId), output.open.message)
        break
      case 'item-seal':
        upsert(
          listOf(into, output.seal.target?.ownerToolUseId ?? output.seal.ownerToolUseId),
          output.seal.message
        )
        break
      case 'item-delta': {
        const { target } = output
        const message = listOf(into, target.ownerToolUseId).find((m) => m.id === target.messageId)
        const block = message?.content[target.blockIndex]
        const kind = target.kind === 'thinking' ? 'thinking' : 'text'
        if (!block || block.type !== kind)
          throw new Error(`item-delta for a missing ${kind} block: ${JSON.stringify(target)}`)
        block.text += output.chunk
        break
      }
      case 'tool-result': {
        const { result } = output
        const list = listOf(into, output.ownerToolUseId)
        const message = [...list]
          .reverse()
          .find((m) =>
            m.content.some((b) => b.type === 'tool_use' && b.toolUseId === result.toolUseId)
          )
        if (!message) throw new Error(`tool-result with no tool_use: ${result.toolUseId}`)
        if (
          message.content.some((b) => b.type === 'tool_result' && b.toolUseId === result.toolUseId)
        )
          throw new Error(`duplicate tool-result: ${result.toolUseId}`)
        message.content.push({
          type: 'tool_result',
          toolUseId: result.toolUseId,
          toolResult: result.result,
          isError: result.isError,
          ...(result.fileDiffs ? { fileDiffs: result.fileDiffs } : {}),
          ...(result.images ? { images: result.images } : {})
        })
        break
      }
      case 'task-notification':
        if (into.taskNotifications.some((n) => n.toolUseId === output.notification.toolUseId))
          throw new Error(`duplicate task-notification: ${output.notification.toolUseId}`)
        into.taskNotifications.push(output.notification)
        break
      default:
        break
    }
  }
  return into
}

function normalizeMessage(message: ChatMessage): ChatMessage {
  const order = new Map<string, number>()
  message.content.forEach((block, index) => {
    if (block.type === 'tool_use') order.set(block.toolUseId, index)
  })
  const results = message.content
    .filter(
      (block): block is Extract<ContentBlock, { type: 'tool_result' }> =>
        block.type === 'tool_result'
    )
    .sort((a, b) => (order.get(a.toolUseId) ?? 0) - (order.get(b.toolUseId) ?? 0))
  return {
    id: message.id,
    role: message.role,
    timestamp: message.timestamp,
    content: [...message.content.filter((block) => block.type !== 'tool_result'), ...results]
  }
}

/** One comparable shape: results after a step's other blocks in call order, notifications by call. */
export function normalizeTranscript(t: Transcript): Transcript {
  const sortNotifications = (list: TaskNotification[]) =>
    [...list].sort((a, b) => String(a.toolUseId).localeCompare(String(b.toolUseId)))
  return {
    messages: t.messages.map(normalizeMessage),
    subagentMessages: Object.fromEntries(
      Object.entries(t.subagentMessages)
        .filter(([, list]) => list.length > 0)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([owner, list]) => [owner, list.map(normalizeMessage)])
    ),
    taskNotifications: sortNotifications(t.taskNotifications)
  }
}

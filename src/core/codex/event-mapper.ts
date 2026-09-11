import type { ChatMessage, ContentBlock, FileDiff, StreamDelta } from '../../shared/types'
import { isImageMediaType } from '../../shared/types'
import type { ThreadItem } from './protocol/v2/ThreadItem'

/** Length-safe composite identity shared by live items and future history readers. */
export function codexItemId(threadId: string, turnId: string, itemId: string): string {
  return `codex:${JSON.stringify([threadId, turnId, itemId])}`
}

export type CodexMappedEvent =
  | { kind: 'message'; message: ChatMessage }
  | { kind: 'stream'; delta: StreamDelta }
  | { kind: 'commandDelta'; toolUseId: string; delta: string }
  | {
      kind: 'toolResult'
      toolUseId: string
      result: string
      isError: boolean
      fileDiffs?: FileDiff[]
    }

/** No clocks or session state: callers supply the observation timestamp. */
export function mapCodexItem(
  threadId: string,
  turnId: string,
  item: ThreadItem,
  completed: boolean,
  timestamp: number
): CodexMappedEvent[] {
  const id = codexItemId(threadId, turnId, item.id)
  const message = (
    content: ContentBlock[],
    role: ChatMessage['role'] = 'assistant'
  ): CodexMappedEvent => ({
    kind: 'message',
    message: {
      id,
      role,
      content,
      timestamp,
      ...(item.type === 'userMessage' && item.clientId ? { replacesMessageId: item.clientId } : {})
    }
  })
  switch (item.type) {
    case 'agentMessage':
      return completed ? [message([{ type: 'text', text: item.text }])] : []
    case 'reasoning':
      return completed
        ? [
            message([
              {
                type: 'thinking',
                text: (item.summary.length ? item.summary : item.content).join('\n\n')
              }
            ])
          ]
        : []
    case 'userMessage':
      return completed
        ? [
            message(
              item.content.flatMap((input): ContentBlock[] =>
                input.type === 'text'
                  ? [{ type: 'text', text: input.text }]
                  : input.type === 'image'
                    ? codexImage(input.url)
                    : []
              ),
              'user'
            )
          ]
        : []
    case 'commandExecution': {
      const outputs: CodexMappedEvent[] = [
        message([
          {
            type: 'tool_use',
            toolUseId: id,
            toolName: 'commandExecution',
            toolInput: { command: item.command, cwd: item.cwd }
          }
        ])
      ]
      if (completed)
        outputs.push({
          kind: 'toolResult',
          toolUseId: id,
          result:
            item.status === 'inProgress'
              ? `Native command did not report completion.\n${item.aggregatedOutput ?? ''}`
              : (item.aggregatedOutput ?? ''),
          isError: item.status !== 'completed' || (item.exitCode !== null && item.exitCode !== 0)
        })
      return outputs
    }
    case 'fileChange': {
      const files = item.changes.map((change): FileDiff => ({
        path: change.path,
        patch: change.diff,
        changeType:
          change.kind.type === 'update' && change.kind.move_path ? 'move' : change.kind.type
      }))
      const outputs: CodexMappedEvent[] = [
        message([
          {
            type: 'tool_use',
            toolUseId: id,
            toolName: 'fileChange',
            toolInput: { files }
          }
        ])
      ]
      if (completed)
        outputs.push({
          kind: 'toolResult',
          toolUseId: id,
          result: files.map((f) => f.patch).join('\n'),
          isError: item.status !== 'completed',
          fileDiffs: files
        })
      return outputs
    }
    default:
      return []
  }
}

function codexImage(url: string): ContentBlock[] {
  const match = /^data:([^;]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(url)
  return match && isImageMediaType(match[1])
    ? [{ type: 'image', mediaType: match[1], base64Data: match[2] }]
    : [{ type: 'text', text: '[Native image reference is not an inline supported image]' }]
}

export function mapCodexDelta(
  method: string,
  params: { threadId: string; turnId: string; itemId: string; delta: string }
): CodexMappedEvent[] {
  if (method === 'item/agentMessage/delta')
    return [{ kind: 'stream', delta: { type: 'text', text: params.delta } }]
  if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta')
    return [{ kind: 'stream', delta: { type: 'thinking', text: params.delta } }]
  if (method === 'item/commandExecution/outputDelta')
    return [
      {
        kind: 'commandDelta',
        toolUseId: codexItemId(params.threadId, params.turnId, params.itemId),
        delta: params.delta
      }
    ]
  return []
}

import type { ChatMessage, ContentBlock, FileDiff, StreamDelta } from '../../shared/types'
import { isImageMediaType } from '../../shared/types'
import type { PatchChangeKind } from './protocol/v2/PatchChangeKind'
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
        patch: codexChangePatch(change),
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

/**
 * The unified diff for one native file change.
 *
 * The wire's `diff` field is NOT a unified diff for every kind — see
 * `format_file_change_diff` in codex-rs (`app-server-protocol/src/protocol/
 * item_builders.rs`):
 *
 *  - `add` / `delete` carry the RAW FILE CONTENT;
 *  - a renamed `update` carries the unified diff with `\n\nMoved to: <path>`
 *    appended (the rename is already expressed as `changeType: 'move'`, and
 *    `FileDiff` has no destination field to put the path in);
 *  - a plain `update` carries the unified diff verbatim.
 *
 * Handing the raw content straight through is what made an add render as
 * "No changes": the viewer's parser finds zero hunks in it.
 *
 * The branch is taken on `kind.type` ALONE, never on what the content looks
 * like: a file whose first line is `---` or `@@` (a .patch fixture, a changelog)
 * is ordinary content, and sniffing would leave exactly those unwrapped.
 */
function codexChangePatch(change: { kind: PatchChangeKind; path: string; diff: string }): string {
  if (change.kind.type === 'add') return contentPatch(change.path, change.diff, 'add')
  if (change.kind.type === 'delete') return contentPatch(change.path, change.diff, 'delete')
  const movedTo = change.kind.move_path
  const trailer = movedTo ? `\n\nMoved to: ${movedTo}` : ''
  return trailer && change.diff.endsWith(trailer)
    ? change.diff.slice(0, -trailer.length)
    : change.diff
}

/**
 * Wrap whole-file content as a unified add/delete diff, the shape
 * `renderer/src/lib/diff/parse-patch.ts` reads (and `GitService.getFilePatch`
 * already emits for untracked files).
 *
 * A file that does not end in a newline keeps that fact: the parser skips the
 * `\ No newline at end of file` marker, so it costs nothing and survives a
 * round-trip through anything else that reads the patch. An EMPTY file has no
 * lines at all and gets an empty `@@ -0,0 +0,0 @@` hunk — one hunk is what keeps
 * the viewer from calling it "No changes", and `--- /dev/null` is what keeps it
 * styled as a pure add.
 */
function contentPatch(path: string, content: string, kind: 'add' | 'delete'): string {
  const lines = content === '' ? [] : content.split('\n')
  const endsWithNewline = lines.length > 0 && lines[lines.length - 1] === ''
  if (endsWithNewline) lines.pop()
  const count = lines.length
  const sign = kind === 'add' ? '+' : '-'
  const header =
    kind === 'add'
      ? [
          `--- /dev/null`,
          `+++ b/${path}`,
          count === 0 ? `@@ -0,0 +0,0 @@` : `@@ -0,0 +1,${count} @@`
        ]
      : [
          `--- a/${path}`,
          `+++ /dev/null`,
          count === 0 ? `@@ -0,0 +0,0 @@` : `@@ -1,${count} +0,0 @@`
        ]
  const body = lines.map((line) => `${sign}${line}`)
  if (count > 0 && !endsWithNewline) body.push('\\ No newline at end of file')
  return [...header, ...body].join('\n')
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

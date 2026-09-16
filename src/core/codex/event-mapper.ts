import type {
  ChatMessage,
  ContentBlock,
  FileDiff,
  StreamDelta,
  TodoItem,
  ToolResultImage
} from '../../shared/types'
import { isImageMediaType } from '../../shared/types'
import type { PatchChangeKind } from './protocol/v2/PatchChangeKind'
import type { ThreadItem } from './protocol/v2/ThreadItem'
import type { SubAgentActivityKind } from './protocol/v2/SubAgentActivityKind'
import type { TurnPlanStep } from './protocol/v2/TurnPlanStep'
import type { JsonValue } from './protocol/serde_json/JsonValue'
import type { FunctionCallOutputBody } from './protocol/FunctionCallOutputBody'

/** Length-safe composite identity shared by live items and future history readers. */
export function codexItemId(threadId: string, turnId: string, itemId: string): string {
  return `codex:${JSON.stringify([threadId, turnId, itemId])}`
}

/**
 * The one-line result a TERMINAL sub-agent activity writes onto the spawn card
 * that minted the child, or undefined for the kinds that are not terminal.
 *
 * `SubAgentActivityKind` is `started | interacted | interrupted | completed`
 * (SubAgentActivityKind.ts) — there is no errored kind, so a v2 card is never
 * red on this path. `completed` is emitted from `core/src/session/mod.rs:2216`
 * only for `AgentStatus::Completed(_)`, so an agent that died leaves no
 * terminal activity at all and its card is closed by teardown instead.
 *
 * This is NOT part of `mapCodexItem`: every activity carries its OWN item id
 * (`started` takes the `spawn_agent` call id — `multi_agents_v2/spawn.rs:247`;
 * `interrupted` the `interrupt_agent` call id — `interrupt_agent.rs:92`;
 * `interacted` the message call id — `message_tool.rs:134`; `completed` the
 * minted `subagent-completed-<child turn id>` — `session/mod.rs:2249`), so
 * nothing in one item names the card it belongs to. The CALLER, which tracks
 * `agentThreadId` -> card, is the only place that binding exists.
 */
export function subAgentActivityResult(kind: SubAgentActivityKind): string | undefined {
  if (kind === 'completed') return 'Agent completed.'
  if (kind === 'interrupted') return 'Agent was interrupted.'
  return undefined
}

export type CodexMappedEvent =
  | { kind: 'message'; message: ChatMessage }
  | { kind: 'stream'; delta: StreamDelta }
  | { kind: 'commandDelta'; toolUseId: string; delta: string }
  | { kind: 'planDelta'; toolUseId: string; delta: string }
  | {
      kind: 'toolResult'
      toolUseId: string
      result: string
      isError: boolean
      fileDiffs?: FileDiff[]
      /** Pictures the call produced — MCP image content, a generated image. */
      images?: ToolResultImage[]
    }

/** A line that is ONE bold span and nothing else — the inner `(?!\*\*)` keeps
 * `**a** and **b**` (two spans) from reading as one wrapper around `a** and **b`. */
const BOLD_LINE = /^\*\*((?:(?!\*\*)[\s\S])+)\*\*$/

/**
 * Drops one wrapping `**…**` from every line that is entirely bold.
 *
 * The ChatGPT backend's reasoning summary is Markdown: for the GPT-5.6/6 models
 * a "detailed" summary is a single bold headline
 * (`**Calculating primes between 100 and 150**`, probed against a real account
 * 2026-09-16), and a longer one opens each paragraph with one. `ThinkingBlock`
 * renders the text verbatim and pre-wrapped (`ThinkingBlock.tsx`), so the
 * asterisks would show — everything else in the app renders a summary as plain
 * text. Only a whole-line span is touched: bold used INSIDE a sentence is the
 * model's emphasis and is left alone rather than half-stripped.
 */
function unbold(text: string): string {
  return text
    .split('\n')
    .map((line) => BOLD_LINE.exec(line.trim())?.[1] ?? line)
    .join('\n')
}

/**
 * `turn/plan/updated`'s steps as the engine-neutral {@link TodoItem}s the
 * floating widget reads.
 *
 * `activeForm` is EMPTY: the wire carries one string per step (`step`) and no
 * gerund form of it, and inventing one ("Doing <step>") would put words in the
 * model's mouth. The widget falls back to `content` when it is blank.
 *
 * Live only — the notification has no thread item and `thread_history.rs`
 * ignores it, so a cold open of the same thread shows no checklist at all.
 */
export function codexPlanSteps(plan: TurnPlanStep[]): TodoItem[] {
  // The caller has an `unknown` array off the wire, so an entry whose `step` is
  // not a string is dropped rather than rendered as `undefined` in the widget.
  return plan
    .filter((entry) => entry && typeof entry.step === 'string')
    .map((entry) => ({
      content: entry.step,
      status:
        entry.status === 'inProgress'
          ? 'in_progress'
          : entry.status === 'completed'
            ? 'completed'
            : 'pending',
      activeForm: ''
    }))
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
    case 'reasoning': {
      if (!completed) return []
      // The ChatGPT backend returns reasoning items with neither summary nor
      // content for some models unless a summary is requested
      // (`model_reasoning_summary`); an empty "Thought" block is noise, so the
      // item maps to nothing (F13). Live and cold history share this mapper.
      const text = unbold((item.summary.length ? item.summary : item.content).join('\n\n'))
      return text.length ? [message([{ type: 'thinking', text }])] : []
    }
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
    case 'collabAgentToolCall': {
      // Codex's native collaboration surface (`multi_agent_v1`: spawn_agent,
      // send_input, wait_agent, close_agent, resume_agent). The wire name is
      // PREFIXED rather than bare: `wait` and `sendInput` are generic enough to
      // collide with a future hosted or native tool, and the prefix keeps
      // CodexEngineToolMap's cases unambiguous at a glance.
      const outputs: CodexMappedEvent[] = [
        message([
          {
            type: 'tool_use',
            toolUseId: id,
            toolName: `collab:${item.tool}`,
            toolInput: {
              prompt: item.prompt,
              model: item.model,
              reasoningEffort: item.reasoningEffort,
              receiverThreadIds: item.receiverThreadIds,
              agentsStates: item.agentsStates
            }
          }
        ])
      ]
      if (completed) {
        const states = Object.entries(item.agentsStates ?? {})
        outputs.push({
          kind: 'toolResult',
          toolUseId: id,
          result: states.length
            ? states
                .map(([thread, state]) =>
                  state?.message
                    ? `${thread}: ${state.status} \u2014 ${state.message}`
                    : `${thread}: ${state?.status ?? 'unknown'}`
                )
                .join('\n')
            : item.receiverThreadIds.length
              ? item.receiverThreadIds.map((thread) => `${thread}: no status reported`).join('\n')
              : 'No agent reported a state for this call.',
          // `interrupted` is deliberately NOT an error: the user (or a parent
          // interrupt) asked for it, and colouring it red would read as a
          // failure of the call rather than of the agent.
          isError:
            item.status === 'failed' ||
            states.some(([, state]) => state?.status === 'errored' || state?.status === 'notFound')
        })
      }
      return outputs
    }
    case 'subAgentActivity': {
      // The v2 collaboration surface's stand-in for `collabAgentToolCall`: a
      // spawn there emits its collab item to ANALYTICS only
      // (`multi_agents_v2/spawn.rs:49-85`), and the transcript gets this
      // instead. Only `started` mints a card, and it is minted in the v1 shape
      // so one `task` normalizer, one TaskCard and one child-binding rule cover
      // both surfaces.
      return item.kind === 'started'
        ? [
            message([
              {
                type: 'tool_use',
                toolUseId: id,
                toolName: 'collab:spawnAgent',
                toolInput: {
                  agentPath: item.agentPath,
                  receiverThreadIds: [item.agentThreadId],
                  agentsStates: {}
                }
              }
            ])
          ]
        : []
    }
    case 'dynamicToolCall': {
      // ClaudeUI's own hosted tools (render_mermaid / create_mockup /
      // show_mockup) ride this channel — see codex-hosted-tools.ts. The tool
      // NAME is the wire name, so the renderer's CodexEngineToolMap keys off
      // the same three strings pi's bare-name registrations use.
      const outputs: CodexMappedEvent[] = [
        message([
          {
            type: 'tool_use',
            toolUseId: id,
            toolName: item.tool,
            toolInput: (item.arguments ?? {}) as Record<string, unknown>
          }
        ])
      ]
      if (completed) {
        // TEXT ONLY. `inputImage`/`inputAudio` are out of scope for this slice:
        // nothing ClaudeUI hosts returns them, and a `tool_result` has no
        // channel for an image today, so rendering the raw data URL as text
        // would be worse than dropping it.
        const text = (item.contentItems ?? [])
          .map((content) => (content.type === 'inputText' ? content.text : ''))
          .filter((line) => line !== '')
          .join('\n')
        const isError = item.status !== 'completed' || item.success === false
        outputs.push({
          kind: 'toolResult',
          toolUseId: id,
          // The v2 item carries NO `error` field (the core's is dropped in
          // `CoreTurnItem::DynamicToolCall` -> `ThreadItem::DynamicToolCall`),
          // so a cancelled call is an empty `failed` item and the only honest
          // thing left to say is that nothing came back.
          result: text || (isError ? 'Hosted tool call did not return a result.' : ''),
          isError
        })
      }
      return outputs
    }
    case 'webSearch': {
      // The wire's `results` are deliberately opaque JSON (`WebSearchItem`'s own
      // doc comment): new fields must pass through without a Codex release. The
      // three the card reads are lifted here and the rest is dropped rather than
      // carried into the renderer as unvalidated shape.
      const results = webSearchResults(item.results)
      const outputs: CodexMappedEvent[] = [
        message([
          {
            type: 'tool_use',
            toolUseId: id,
            toolName: 'webSearch',
            toolInput: {
              query: item.query,
              ...(item.action ? { action: item.action } : {}),
              ...(results.length ? { results } : {})
            }
          }
        ])
      ]
      if (completed)
        outputs.push({
          kind: 'toolResult',
          toolUseId: id,
          // The card renders `results` itself, one row each. With none, the
          // result is EMPTY rather than the query: `WebBody` already shows the
          // query under the action line, and repeating it as a terminal
          // "Result" block says the same thing twice.
          result: results.length
            ? results.map((entry) => `${entry.title} — ${entry.url}`).join('\n')
            : '',
          isError: false
        })
      return outputs
    }
    case 'mcpToolCall': {
      // `mcp__<server>__<tool>` is the name Claude's rule vocabulary uses and
      // the one Slice 4b's approval card already carries, so one `mcp` kind and
      // one body cover the approval and the call.
      //
      // The INPUT is an envelope, not the arguments themselves: the card shows a
      // `read-only` chip from the server's own `readOnlyHint`, and `normalize`
      // is handed the tool name and the input and nothing else. Codex is the
      // only producer of this shape and `CodexEngineToolMap` the only reader.
      const outputs: CodexMappedEvent[] = [
        message([
          {
            type: 'tool_use',
            toolUseId: id,
            toolName: `mcp__${item.server}__${item.tool}`,
            toolInput: {
              // A tool called with a JSON scalar or array has no object to
              // spread; `{ value }` keeps it visible instead of dropping it.
              arguments: isJsonObject(item.arguments) ? item.arguments : { value: item.arguments },
              ...(item.readOnlyHint !== null ? { readOnlyHint: item.readOnlyHint } : {})
            }
          }
        ])
      ]
      if (completed) {
        const text = mcpResultText(item.result?.content)
        const images = mcpResultImages(item.result?.content)
        const isError = item.status === 'failed' || item.error !== null
        outputs.push({
          kind: 'toolResult',
          toolUseId: id,
          result: item.error ? item.error.message : text,
          isError,
          ...(images.length ? { images } : {})
        })
      }
      return outputs
    }
    case 'imageView': {
      // `path` is all the wire carries. The BYTES are attached by the caller
      // (`codex-image-view.ts`), which is where a filesystem read belongs — this
      // mapper is pure and runs on cold history too.
      const outputs: CodexMappedEvent[] = [
        message([
          {
            type: 'tool_use',
            toolUseId: id,
            toolName: 'imageView',
            toolInput: { path: item.path }
          }
        ])
      ]
      // The result is EMPTY on purpose. `FileReadBody` renders `toolResult` as
      // the file's CONTENT, so putting the path there would print it as if it
      // were file text, under a header that already shows it. An empty result
      // is the image-only Read shape `ToolCard` is built for: its body section
      // collapses away and the returned-image strip renders regardless.
      if (completed) outputs.push({ kind: 'toolResult', toolUseId: id, result: '', isError: false })
      return outputs
    }
    case 'imageGeneration': {
      const outputs: CodexMappedEvent[] = [
        message([
          {
            type: 'tool_use',
            toolUseId: id,
            toolName: 'imageGeneration',
            toolInput: {
              ...(item.revisedPrompt !== null ? { prompt: item.revisedPrompt } : {}),
              ...(item.savedPath !== undefined ? { savedPath: item.savedPath } : {})
            }
          }
        ])
      ]
      if (completed) {
        // The only failure the wire models is the usage limit. `resetsAt` is a
        // unix SECOND stamp on this item (`ImageGenerationFailure`); it is
        // rendered as an ISO instant rather than a relative phrase because this
        // mapper has no clock.
        if (item.failure)
          outputs.push({
            kind: 'toolResult',
            toolUseId: id,
            result:
              item.failure.resetsAt !== null
                ? `Image generation limit reached. Resets at ${new Date(item.failure.resetsAt * 1000).toISOString()}.`
                : 'Image generation limit reached.',
            isError: true
          })
        else
          outputs.push({
            kind: 'toolResult',
            toolUseId: id,
            result: item.savedPath ?? '',
            isError: item.status !== 'completed',
            // Always PNG: `ImageGenerationItem.result` is the base64 PNG the
            // hosted tool returns (the `transparentBackground` flag is a PNG
            // property). A blank result carries no strip rather than a broken
            // thumbnail.
            ...(item.result
              ? { images: [{ mediaType: 'image/png' as const, base64Data: item.result }] }
              : {})
          })
      }
      return outputs
    }
    case 'sleep': {
      const outputs: CodexMappedEvent[] = [
        message([
          {
            type: 'tool_use',
            toolUseId: id,
            toolName: 'sleep',
            toolInput: { durationMs: item.durationMs }
          }
        ])
      ]
      // The row reads the duration off the INPUT; the result exists only to
      // resolve the card out of its "waiting" state.
      if (completed) outputs.push({ kind: 'toolResult', toolUseId: id, result: '', isError: false })
      return outputs
    }
    case 'plan':
      // Native plan mode's `<proposed_plan>`, streamed by `item/plan/delta` and
      // completed with the whole markdown. An in-progress item carries the text
      // so far, which is exactly what the card should show while it grows.
      return [
        message([
          { type: 'tool_use', toolUseId: id, toolName: 'plan', toolInput: { plan: item.text } }
        ])
      ]
    case 'contextCompaction':
      // The item carries an id and nothing else — no summary — so this is the
      // hairline form of the separator, never the expandable amber card.
      return completed ? [message([{ type: 'compact_separator' }], 'system')] : []
    case 'hookPrompt':
      // UNTRUSTED: a hook is a third-party script whose output was injected into
      // the model's prompt. `context_note` is rendered verbatim, never markdown.
      return completed && item.fragments.length
        ? [
            message(
              [
                {
                  type: 'context_note',
                  title: 'Injected context',
                  fragments: item.fragments.map((fragment) => ({
                    text: fragment.text,
                    label: fragment.hookRunId
                  }))
                }
              ],
              'system'
            )
          ]
        : []
    case 'functionCallOutput': {
      // A `function_call_output` some OTHER client submitted as turn input (the
      // desktop app answering an async question, a hook). There is no matching
      // call item to attach it to, so the card is result-only and says where it
      // came from.
      if (!completed) return []
      const images = functionOutputImages(item.output)
      return [
        message([
          {
            type: 'tool_use',
            toolUseId: id,
            toolName: item.name,
            toolInput: {
              ...(item.namespace !== null ? { namespace: item.namespace } : {}),
              source: 'another client'
            }
          }
        ]),
        {
          kind: 'toolResult',
          toolUseId: id,
          result: functionOutputText(item.output),
          isError: false,
          ...(images.length ? { images } : {})
        }
      ]
    }
    case 'enteredReviewMode':
      // A thin verbatim notice. `review` is `user_facing_hint`, which the core
      // leaves empty when it has none.
      return completed
        ? [
            message(
              [{ type: 'text', text: `Review started: ${item.review || 'Review requested.'}` }],
              'system'
            )
          ]
        : []
    case 'exitedReviewMode':
      // The rendered explanation plus findings. Markdown BY DECISION (F20): it
      // is the model's own structured review, and flattening it to plain text
      // loses the numbered findings and their file:line citations.
      return completed && item.review
        ? [message([{ type: 'review_result', text: item.review }], 'system')]
        : []
    default:
      return []
  }
}

/** A JSON object, told apart from an array, a scalar and null. */
function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One string field of an opaque JSON record, or '' when it is absent or not a string. */
function jsonString(record: { [key: string]: JsonValue }, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

/**
 * The renderable rows inside `WebSearchItem.results`.
 *
 * The wire declares the array opaque on purpose, so nothing here trusts its
 * shape: a non-object entry, or one with neither a title nor a url, is dropped
 * rather than rendered as `undefined`. The title falls back to the url so a
 * result never renders as a blank row, and the URL is passed through as TEXT —
 * the renderer is what decides whether an `https?:` url becomes a link.
 */
function webSearchResults(
  results: JsonValue[] | null | undefined
): { title: string; url: string; snippet?: string }[] {
  if (!Array.isArray(results)) return []
  return results.flatMap((entry) => {
    if (!isJsonObject(entry)) return []
    const url = jsonString(entry, 'url')
    const title = jsonString(entry, 'title') || url
    if (!title && !url) return []
    const snippet = jsonString(entry, 'snippet')
    return [{ title, url, ...(snippet ? { snippet } : {}) }]
  })
}

/**
 * The text of an MCP tool result, joined from its `{type:'text', text}` content
 * blocks.
 *
 * MCP content is opaque JSON on this wire (`McpToolCallResult.content`), and
 * everything it carries is UNTRUSTED server output — it reaches the card as
 * plain text and never the markdown pipeline. Resource blocks are skipped: a
 * resource is a URI the reader cannot follow from here.
 */
function mcpResultText(content: JsonValue[] | null | undefined): string {
  if (!Array.isArray(content)) return ''
  return content
    .flatMap((entry) =>
      isJsonObject(entry) && entry.type === 'text' && typeof entry.text === 'string'
        ? [entry.text]
        : []
    )
    .join('\n')
}

/** The `{type:'image', data, mimeType}` blocks of an MCP result, allowlisted types only. */
function mcpResultImages(content: JsonValue[] | null | undefined): ToolResultImage[] {
  if (!Array.isArray(content)) return []
  return content.flatMap((entry) => {
    if (!isJsonObject(entry) || entry.type !== 'image') return []
    const mediaType = entry.mimeType
    const data = entry.data
    return isImageMediaType(mediaType) && typeof data === 'string' && data.length
      ? [{ mediaType, base64Data: data }]
      : []
  })
}

/**
 * The text of a `functionCallOutput`. The body is a bare string, or the
 * Responses content-item array — of which only `input_text` has anything a
 * reader can see (`input_audio` and `encrypted_content` do not, and
 * `input_image` rides {@link functionOutputImages} instead).
 */
function functionOutputText(output: FunctionCallOutputBody): string {
  if (typeof output === 'string') return output
  return output.flatMap((entry) => (entry.type === 'input_text' ? [entry.text] : [])).join('\n')
}

/** The `input_image` entries of a `functionCallOutput`, as inline data URLs only. */
function functionOutputImages(output: FunctionCallOutputBody): ToolResultImage[] {
  if (typeof output === 'string') return []
  return output.flatMap((entry) => {
    if (entry.type !== 'input_image') return []
    const match = /^data:([^;]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(entry.image_url)
    return match && isImageMediaType(match[1])
      ? [{ mediaType: match[1], base64Data: match[2] }]
      : []
  })
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
    // An EMPTY delta maps to nothing: the caller turns a thinking delta into an
    // item-scoped message upsert, so an empty one opens a "Thought" block with
    // no text under it — which is what a `summary = "none"` turn would produce.
    // The text is otherwise passed through WHOLE, asterisks included: the
    // backend can split a headline mid-token across deltas, so no single delta
    // can be recognised as a wrapper. The completed item's canonical `summary`
    // is where {@link unbold} runs, and it upserts over this under the same id.
    return params.delta.length
      ? [{ kind: 'stream', delta: { type: 'thinking', text: params.delta } }]
      : []
  if (method === 'item/plan/delta')
    // Native plan mode streams the `<proposed_plan>` body. Its own event kind
    // rather than a `stream`: `StreamDelta` is a replicated channel shape whose
    // only members are text and thinking, and the plan is not either — the
    // caller accumulates this into an item-scoped upsert of the `plan` tool_use
    // under the plan item's id (`<turnId>-plan`), which `mergeContentBlocks`
    // then lets the completed item replace by `toolUseId`.
    return params.delta.length
      ? [
          {
            kind: 'planDelta',
            toolUseId: codexItemId(params.threadId, params.turnId, params.itemId),
            delta: params.delta
          }
        ]
      : []
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

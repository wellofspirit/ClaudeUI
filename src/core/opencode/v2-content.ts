/**
 * opencode 2.x payloads → ClaudeUI content, shared by the LIVE mapper
 * (`v2-event-mapper.ts`) and the COLD history converter (`v2-history.ts`), so
 * a turn read back from `GET /message` renders exactly as it streamed
 * (ADR-093 S4). Everything here is pure apart from `blobStore` interning.
 *
 * Wire facts (opencode v2.0.24, `vendor/opencode-v2-src`):
 * - A tool result is `content: Tool.Content[]` (`{type:'text',text}` |
 *   `{type:'file',uri,mime,name?}`) plus free-form `metadata`
 *   (`schema/src/tool.ts`, `core/src/session/runner/publish-llm-event.ts`).
 * - `edit`, `write` (ask only) and `patch` carry `metadata.files:
 *   FileDiff.Info[]` = `{file, patch, additions, deletions, status:
 *   added|deleted|modified}` (`core/src/tool/plugin/{edit,patch}.ts`,
 *   `schema/src/file-diff.ts`).
 * - `subagent` answers `<subagent sessionID="…" state="completed">\n…\n</subagent>`
 *   with `metadata {sessionID, status: completed|running}`; its failures keep
 *   `(sessionID: …)` in the message (`core/src/tool/plugin/subagent.ts`).
 * - A user prompt is `{text, files?: {data(base64), mime, source, name?}[]}`
 *   (`schema/src/prompt.ts`); the stored `user` row and the inbox payload
 *   share it.
 * - The `question` tool asks through a form whose fields are `q<i>`, type
 *   `string` (single choice) or `multiselect`, `title` = header,
 *   `description` = question (`core/src/tool/plugin/question.ts`).
 * - Sessions migrated from 1.x keep their 1.x tool names and argument names
 *   (`bash`, `task` + `metadata.sessionId`, `apply_patch`, `filePath`;
 *   `core/src/database/v1-migration.bun.ts`), so both vocabularies are read.
 */
import type {
  AskUserQuestion,
  ChatMessage,
  ContentBlock,
  FileDiff,
  ToolResultImage
} from '../../shared/types'
import { isImageMediaType } from '../../shared/types'
import { blobStore } from '../services/blob-store'
import type {
  Form_Field,
  Form_Info,
  Prompt_FileAttachment,
  Session_StructuredError,
  Tool_Content
} from './protocol-v2/openapi'

type JsonRecord = { readonly [key: string]: unknown }

/** The `session:tool-result` payload, plus the error type for consumers that branch on it. */
export interface OpencodeToolResult {
  toolUseId: string
  result: string
  isError: boolean
  fileDiffs?: FileDiff[]
  images?: ToolResultImage[]
  /** `Session.StructuredError.type` of a failed call (`permission.rejected`, `aborted`, …). */
  errorType?: string
}

/** 2.x names of the subagent tool, plus the 1.x one a migrated session still holds. */
export const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(['subagent', 'task'])
/** 2.x shell tool, plus the 1.x name a migrated session still holds. */
export const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set(['shell', 'bash'])

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// --- Tool results -----------------------------------------------------------

/**
 * Decode a `data:<mime>;base64,<data>` URI whose header matches `mime`
 * exactly; null for anything else (a `file://` uri, a mismatched header).
 */
function base64DataUri(uri: string, mime: string): string | null {
  const comma = uri.indexOf(',')
  if (comma === -1 || uri.slice(0, comma) !== `data:${mime};base64`) return null
  return uri.slice(comma + 1) || null
}

/** Images a tool returned as `file` content (a `read` of a .png, an MCP image). PDFs and uris are skipped. */
export function toolContentImages(
  content: readonly Tool_Content[] | undefined
): ToolResultImage[] | undefined {
  const images: ToolResultImage[] = []
  for (const item of content ?? []) {
    if (item.type !== 'file' || !isImageMediaType(item.mime)) continue
    const data = base64DataUri(item.uri, item.mime)
    const ref = data ? blobStore.put(item.mime, data) : null
    if (!ref) continue
    images.push({ mediaType: item.mime, ...ref, ...(item.name ? { fileName: item.name } : {}) })
  }
  return images.length > 0 ? images : undefined
}

/** The text a tool returned, its text items joined the way opencode joins them for a notification. */
export function toolContentText(content: readonly Tool_Content[] | undefined): string {
  return (content ?? [])
    .flatMap((item) => (item.type === 'text' && item.text ? [item.text] : []))
    .join('\n\n')
}

const SUBAGENT_ENVELOPE = /^<subagent sessionID="[^"]*" state="[^"]*">\n([\s\S]*)\n<\/subagent>$/

/** The child's answer without the `<subagent …>` envelope the model is given. */
export function unwrapSubagentOutput(text: string): string {
  return SUBAGENT_ENVELOPE.exec(text)?.[1] ?? text
}

const FILE_DIFF_STATUS = { added: 'add', deleted: 'delete', modified: 'update' } as const

/**
 * Per-file unified diffs from a tool's `metadata.files` (2.x `edit`/`patch`),
 * or a 1.x migrated part's `files[]` / `filediff`. Shape-gated, never
 * name-gated: a shell's `{exit, truncated}` metadata never matches.
 */
export function toolFileDiffs(metadata: JsonRecord | undefined): FileDiff[] | undefined {
  if (!metadata) return undefined
  const diffs: FileDiff[] = []
  const files = Array.isArray(metadata.files) ? metadata.files : []
  for (const raw of files) {
    if (!isRecord(raw) || typeof raw.patch !== 'string' || raw.patch.length === 0) continue
    // 2.x FileDiff.Info `file`; 1.x apply_patch `relativePath` / `filePath`.
    const path =
      (typeof raw.file === 'string' && raw.file) ||
      (typeof raw.relativePath === 'string' && raw.relativePath) ||
      (typeof raw.filePath === 'string' ? raw.filePath : '')
    if (!path) continue
    const status = raw.status ?? raw.type
    const changeType =
      typeof status === 'string' && status in FILE_DIFF_STATUS
        ? FILE_DIFF_STATUS[status as keyof typeof FILE_DIFF_STATUS]
        : status === 'add' || status === 'update' || status === 'delete' || status === 'move'
          ? status
          : undefined
    diffs.push({
      path,
      patch: raw.patch,
      ...(typeof raw.additions === 'number' ? { additions: raw.additions } : {}),
      ...(typeof raw.deletions === 'number' ? { deletions: raw.deletions } : {}),
      ...(changeType ? { changeType } : {})
    })
  }
  // 1.x edit: a singular `filediff`.
  const single = metadata.filediff
  if (diffs.length === 0 && isRecord(single) && typeof single.patch === 'string' && single.patch) {
    const path = typeof single.file === 'string' ? single.file : ''
    if (path)
      diffs.push({
        path,
        patch: single.patch,
        ...(typeof single.additions === 'number' ? { additions: single.additions } : {}),
        ...(typeof single.deletions === 'number' ? { deletions: single.deletions } : {}),
        changeType: 'update'
      })
  }
  return diffs.length > 0 ? diffs : undefined
}

/** A successful call's result as ClaudeUI shows it. */
export function toolSuccessResult(
  toolUseId: string,
  name: string,
  content: readonly Tool_Content[] | undefined,
  metadata: JsonRecord | undefined
): OpencodeToolResult {
  const text = toolContentText(content)
  const fileDiffs = toolFileDiffs(metadata)
  const images = toolContentImages(content)
  return {
    toolUseId,
    result: SUBAGENT_TOOL_NAMES.has(name) ? unwrapSubagentOutput(text) : text,
    isError: false,
    ...(fileDiffs ? { fileDiffs } : {}),
    ...(images ? { images } : {})
  }
}

/** A failed call's result: whatever content it kept, then the error message (the reason a denial gave). */
export function toolFailureResult(
  toolUseId: string,
  error: Session_StructuredError,
  content: readonly Tool_Content[] | undefined,
  metadata: JsonRecord | undefined
): OpencodeToolResult {
  const text = toolContentText(content)
  const parts = [text, error.message].filter(
    (part, index, all) => part && all.indexOf(part) === index
  )
  const fileDiffs = toolFileDiffs(metadata)
  return {
    toolUseId,
    result: parts.join('\n\n'),
    isError: true,
    errorType: error.type,
    ...(fileDiffs ? { fileDiffs } : {})
  }
}

const SESSION_ID_IN_TEXT = /sessionID(?:="|: )(ses_[A-Za-z0-9]+)/

/**
 * The child session a subagent call ran (or is running): `metadata.sessionID`
 * (2.x; `sessionId` on a 1.x `task` part), else the id its result or error
 * text names. Undefined for any other tool.
 */
export function subagentChildSession(
  name: string,
  metadata: JsonRecord | undefined,
  text?: string
): string | undefined {
  if (!SUBAGENT_TOOL_NAMES.has(name)) return undefined
  const fromMetadata = metadata?.sessionID ?? metadata?.sessionId
  if (typeof fromMetadata === 'string' && fromMetadata) return fromMetadata
  return text ? SESSION_ID_IN_TEXT.exec(text)?.[1] : undefined
}

/** True when the subagent call returned while its child keeps running (`background:true`). */
export function subagentBackgrounded(metadata: JsonRecord | undefined): boolean {
  return metadata?.status === 'running' || metadata?.background === true
}

// --- User prompts -----------------------------------------------------------

/**
 * An inline image/PDF attachment as a content block; null for anything else
 * (a mentioned file arrives as `source:{type:'uri'}` and text mime, and is
 * already expanded into the prompt — opencode's own mention handling).
 */
function attachmentBlock(file: Prompt_FileAttachment): ContentBlock | null {
  if (file.source.type !== 'inline') return null
  const isImage = isImageMediaType(file.mime)
  if (!isImage && file.mime !== 'application/pdf') return null
  const ref = file.data ? blobStore.put(file.mime, file.data) : null
  if (!ref) return null
  const fileName = file.name ? { fileName: file.name } : {}
  return isImage
    ? { type: 'image', mediaType: file.mime as never, ...ref, ...fileName }
    : { type: 'document', mediaType: 'application/pdf', ...ref, ...fileName }
}

/**
 * A delivered user prompt as the transcript row the live echo also builds:
 * attachments first, then the text (`buildUserContentBlocks` order). The id
 * is the inbox id, which is the stored `user` row's id (opencode projects
 * `session.inbox.delivered` into that row; `core/src/session/projector.ts`).
 */
export function userChatMessage(
  id: string,
  prompt: { readonly text: string; readonly files?: readonly Prompt_FileAttachment[] },
  timestamp: number
): ChatMessage | null {
  const content: ContentBlock[] = []
  for (const file of prompt.files ?? []) {
    const block = attachmentBlock(file)
    if (block) content.push(block)
  }
  if (prompt.text) content.push({ type: 'text', text: prompt.text })
  return content.length > 0 ? { id, role: 'user', content, timestamp } : null
}

// --- Compaction -------------------------------------------------------------

/** The separator row a completed compaction leaves, with opencode's summary behind it. */
export function compactionChatMessage(id: string, summary: string, timestamp: number): ChatMessage {
  return {
    id,
    role: 'system',
    content: [{ type: 'compact_separator', ...(summary ? { text: summary } : {}) }],
    timestamp
  }
}

/** opencode's message id for a row an event wrote (`SessionMessage.ID.fromEvent`). */
export function messageIdFromEvent(eventID: string): string {
  return eventID.replace(/^evt_/, 'msg_')
}

// --- Forms ------------------------------------------------------------------

/** One field of a form, as a reply needs it: the answer key and whether it takes a list. */
export interface OpencodeFormField {
  readonly key: string
  readonly multiSelect: boolean
  /**
   * Option label (what the question shows and the card answers with) → the
   * option VALUE a reply must carry. Absent for a field without options (a
   * free-form answer is sent as typed).
   */
  readonly values?: Readonly<Record<string, string>>
}

function fieldQuestion(field: Form_Field): AskUserQuestion {
  const options = 'options' in field && Array.isArray(field.options) ? field.options : []
  return {
    question: field.description ?? field.title ?? field.key,
    header: field.title ?? '',
    options: options.map((option) => ({
      label: option.label || option.value,
      description: option.description ?? ''
    })),
    multiSelect: field.type === 'multiselect'
  }
}

/**
 * A form as AskUserQuestion's questions, in field order, and the keys a reply
 * must use (`{answer: {q0: "label"}}` — a string for a single choice, a list
 * for a multiselect; an array for a single choice is rejected,
 * FormInvalidAnswerError). Hidden and `external` fields are not asked.
 */
export function formQuestions(form: Form_Info): {
  questions: AskUserQuestion[]
  fields: OpencodeFormField[]
} {
  const asked = form.fields.filter((field) => field.type !== 'external' && !field.hidden)
  return {
    questions: asked.map(fieldQuestion),
    fields: asked.map((field) => {
      const options = 'options' in field && Array.isArray(field.options) ? field.options : []
      return {
        key: field.key,
        multiSelect: field.type === 'multiselect',
        ...(options.length > 0
          ? {
              values: Object.fromEntries(
                options.map((option) => [option.label || option.value, option.value])
              )
            }
          : {})
      }
    })
  }
}

/** The tool call a form belongs to (`metadata.tool.id` on the question tool's form). */
export function formToolCall(form: Form_Info): string | undefined {
  const tool = isRecord(form.metadata) ? form.metadata.tool : undefined
  return isRecord(tool) && typeof tool.id === 'string' ? tool.id : undefined
}

/** A JSON record input, or `{}` for a still-streaming (string) one. */
export function toolInputRecord(input: unknown): Record<string, unknown> {
  return isRecord(input) ? { ...input } : {}
}

/**
 * The one place Claude's wire content blocks and usage fields are decoded.
 *
 * A Claude assistant/user frame (live stream-json, a headless dispatch target, a
 * transcript line in `~/.claude/projects`, a subagent transcript) carries the same
 * Anthropic blocks whichever path delivers it, so every path maps them here:
 *
 *   - claude-session.ts, dispatch-claude-targets.ts   live frames
 *   - claude-item-stream.ts                           `content_block_start` blocks
 *   - session-history.ts, subagent-watcher.ts         transcript replay and tail
 *   - automation-manager.ts                           automation-run tool results
 *   - assistant-message.ts                            frame -> ChatMessage
 *
 * A new block type is added to `claudeContentBlock` and nowhere else. Input is
 * untrusted (a file on disk, a wire frame): a malformed field becomes `''` / `{}`,
 * never `undefined` in a required field and never a throw.
 *
 * Leaf module: imports only shared types and `tool-result-content`.
 */
import type { ChatMessage, ContentBlock, ToolResultImage } from '../../shared/types'
import { extractToolResultContent } from './tool-result-content'

/**
 * Render text for a `fallback` content block — the canonical-replacement frame
 * cli.js emits when a refused partial is retracted and the turn retried on a
 * fallback model (docs/protocol-cc/04-system-subtypes.md §4.20). Live sessions
 * normally evict the whole message via retracted_message_uuids; this text is
 * the fallback rendering when the frame survives (history, older CLIs).
 */
export function fallbackBlockText(block: Record<string, unknown>): string {
  const from = (block.from as Record<string, unknown> | undefined)?.model
  const to = (block.to as Record<string, unknown> | undefined)?.model
  return `Switched models${from ? ` from ${from}` : ''}${to ? ` to ${to}` : ''}.`
}

/** One decoded `tool_result` block of a user frame / transcript line. */
export interface ClaudeToolResult {
  toolUseId: string
  text: string
  isError: boolean
  /** Present only when at least one image survived; never an empty array. */
  images?: ToolResultImage[]
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** The `tool_result` ContentBlock for a decoded result. */
export function claudeToolResultBlock(
  r: ClaudeToolResult
): Extract<ContentBlock, { type: 'tool_result' }> {
  return {
    type: 'tool_result',
    toolUseId: r.toolUseId,
    toolResult: r.text,
    isError: r.isError,
    ...(r.images ? { images: r.images } : {})
  }
}

function toolResultOf(raw: Record<string, unknown>): ClaudeToolResult {
  const { text, images } = extractToolResultContent(raw.content)
  return {
    toolUseId: str(raw.tool_use_id),
    text,
    isError: !!raw.is_error,
    ...(images ? { images } : {})
  }
}

/** One raw Anthropic content block -> the ContentBlock every engine path renders. */
export function claudeContentBlock(raw: Record<string, unknown>): ContentBlock {
  switch (raw.type) {
    case 'text':
      return { type: 'text', text: str(raw.text) }
    case 'thinking':
      return { type: 'thinking', text: str(raw.thinking) }
    case 'tool_use':
      return {
        type: 'tool_use',
        toolName: str(raw.name),
        toolInput:
          raw.input && typeof raw.input === 'object' ? (raw.input as Record<string, unknown>) : {},
        toolUseId: str(raw.id)
      }
    case 'tool_result':
      return claudeToolResultBlock(toolResultOf(raw))
    case 'fallback':
      return { type: 'text', text: fallbackBlockText(raw) }
    default:
      return { type: 'text', text: JSON.stringify(raw) }
  }
}

/** Map a message's `content`; null when it is not an array. */
export function claudeContentBlocks(content: unknown): ContentBlock[] | null {
  if (!Array.isArray(content)) return null
  return content.map((b) =>
    b && typeof b === 'object'
      ? claudeContentBlock(b as Record<string, unknown>)
      : { type: 'text', text: JSON.stringify(b) }
  )
}

/**
 * The `tool_result` blocks of a user line's (or frame's) array content. Skips a
 * non-object entry, another block type and a missing/empty `tool_use_id`.
 */
export function claudeToolResults(content: unknown): ClaudeToolResult[] {
  if (!Array.isArray(content)) return []
  const results: ClaudeToolResult[] = []
  for (const entry of content) {
    if (!entry || typeof entry !== 'object') continue
    const raw = entry as Record<string, unknown>
    if (raw.type !== 'tool_result' || !raw.tool_use_id || typeof raw.tool_use_id !== 'string')
      continue
    results.push(toolResultOf(raw))
  }
  return results
}

/**
 * An assistant line/frame -> ChatMessage. Null when `message` is missing or its
 * `content` is not an array. Partial snapshots of one API message share
 * `message.id`, which is the id here so a re-sent snapshot upserts.
 */
export function claudeAssistantMessage(
  line: Record<string, unknown>,
  opts: { fallbackId: () => string; timestamp: number }
): ChatMessage | null {
  const message = line.message as Record<string, unknown> | undefined
  if (!message) return null
  const blocks = claudeContentBlocks(message.content)
  if (!blocks) return null
  const id = (message.id as string) || (line.uuid as string) || opts.fallbackId()
  return {
    id,
    role: 'assistant',
    content: blocks,
    timestamp: opts.timestamp,
    ...(typeof message.model === 'string' && message.model ? { model: message.model } : {})
  }
}

/**
 * Upsert merge for a message re-sent as a partial snapshot: keep old tool_use /
 * tool_result blocks the new one lacks (by id), old text / thinking when the new
 * has none, then the new blocks.
 */
export function mergeAssistantSnapshot(
  old: ContentBlock[],
  incoming: ContentBlock[]
): ContentBlock[] {
  const toolUseIds = new Set<string>()
  const toolResultIds = new Set<string>()
  let hasText = false
  let hasThinking = false
  for (const b of incoming) {
    if (b.type === 'tool_use') toolUseIds.add(b.toolUseId)
    else if (b.type === 'tool_result') toolResultIds.add(b.toolUseId)
    else if (b.type === 'text') hasText = true
    else if (b.type === 'thinking') hasThinking = true
  }
  const preserved = old.filter((b) => {
    if (b.type === 'tool_use' && b.toolUseId && !toolUseIds.has(b.toolUseId)) return true
    if (b.type === 'tool_result' && b.toolUseId && !toolResultIds.has(b.toolUseId)) return true
    if (b.type === 'text' && !hasText) return true
    if (b.type === 'thinking' && !hasThinking) return true
    return false
  })
  return [...preserved, ...incoming]
}

export interface ClaudeUsageTokens {
  input: number
  output: number
  /** Cache writes at any TTL. */
  cacheWrite: number
  /** The 1h-TTL subset of `cacheWrite` (billed higher than the 5m rest). */
  cacheWrite1h: number
  cacheRead: number
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** Decode an Anthropic `usage` object; a missing or non-finite field is 0. */
export function claudeUsageTokens(usage: unknown): ClaudeUsageTokens {
  const u = usage && typeof usage === 'object' ? (usage as Record<string, unknown>) : {}
  const creation = u.cache_creation
  return {
    input: count(u.input_tokens),
    output: count(u.output_tokens),
    cacheWrite: count(u.cache_creation_input_tokens),
    cacheWrite1h: count(
      creation && typeof creation === 'object'
        ? (creation as Record<string, unknown>).ephemeral_1h_input_tokens
        : 0
    ),
    cacheRead: count(u.cache_read_input_tokens)
  }
}

/** The prompt size one API call saw: fresh input plus both cache figures. */
export function claudeContextLength(t: ClaudeUsageTokens): number {
  return t.input + t.cacheRead + t.cacheWrite
}

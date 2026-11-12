/**
 * history.ts
 *
 * pi's cold history: stored session entries (`~/.pi/agent/sessions/**.jsonl`) to
 * ChatMessage[]. The live twin is `event-mapper.ts`; both build their content
 * blocks through the same helpers.
 */

import type { ChatMessage, ContentBlock } from '../../shared/types'
import { isImageMediaType } from '../../shared/types'
import type {
  PiAgentMessage,
  PiImageContent,
  PiSessionEntry,
  PiTextContent,
  PiToolResultMessage
} from './pi-protocol'
import { piModelLabel } from './event-mapper'
import { piAssistantBlock, piToolResultBlock } from './pi-blocks'
import { piCustomMessageToChat } from './pi-custom-message'
import { parseSkillInvocationEnvelope } from '../services/claude-skill-invoke'
import { blobStore } from '../services/blob-store'

/**
 * Convert a single stored pi AgentMessage entry to a ChatMessage, or null if
 * it doesn't render as its own message. EXPORTED so PiSession's resume replay
 * reuses this EXACT conversion (single source of truth — the pattern
 * opencode's cold history follows too, `opencode/history.ts`).
 *
 * Mapping (same field conventions as the live mapper — event-mapper.ts; blocks come from pi-blocks.ts):
 *   user      → role 'user', string/array content → text/image blocks; a Claude skill's
 *               expansion envelope → role 'system' with a `cli_command` block
 *   assistant → role 'assistant', text/thinking/toolCall → text/thinking/tool_use
 *               blocks; a completed toolCall ALSO gets a `tool_result` block
 *               immediately after it (looked up via `toolResultsByCallId`) —
 *               mirrors opencode's cold-history tool_use+tool_result pairing
 *               (tool results live in the SAME message as their tool_use, not
 *               as their own message — unlike the live mapper's separate
 *               `session:tool-result` event, which the caller
 *               (PiSession.replayStoredHistory) re-derives from these embedded
 *               blocks, exactly like OpencodeSession does).
 *   toolResult → null (folded into the preceding assistant message above,
 *               never its own ChatMessage — it has no independent entry here
 *               because pi's toolResult entries carry no displayable role of
 *               their own once merged).
 *   bashExecution → null (pi's RPC `bash` command output; no UI surface for
 *               it yet — out of M1 scope).
 *
 * M2: rich diff — pi's `edit` tool result carries a ready-made unified diff at
 * `details.patch`, and (unlike the live mapper) this function DOES have both
 * the toolCall's `arguments.path` and the toolResult's `details` in scope at
 * once. Deferred anyway, for consistency: pi's live and replayed tool cards
 * should render identically in M1, and the live path (event-mapper.ts) can't
 * do this without extra plumbing — see its identical note.
 */
export function convertPiEntryMessage(
  entryId: string,
  message: PiAgentMessage,
  toolResultsByCallId: ReadonlyMap<string, PiToolResultMessage>
): ChatMessage | null {
  if (message.role === 'user') {
    const content = convertPiTextOrImageContent(message.content)
    if (content.length === 0) return null
    // A typed Claude skill `/name args` reached pi as its expansion (the envelope); show what was
    // typed, as Claude's own history does.
    const first = content[0]
    const typed = first.type === 'text' ? parseSkillInvocationEnvelope(first.text) : null
    if (typed) {
      return {
        id: entryId,
        role: 'system',
        content: [{ type: 'cli_command', ...typed }],
        timestamp: message.timestamp
      }
    }
    return { id: entryId, role: 'user', content, timestamp: message.timestamp }
  }

  if (message.role === 'assistant') {
    const content: ContentBlock[] = []
    for (const block of message.content) {
      content.push(piAssistantBlock(block))
      if (block.type === 'toolCall') {
        const result = toolResultsByCallId.get(block.id)
        if (result) content.push(piToolResultBlock(result))
      }
    }
    if (content.length === 0) return null
    const model = piModelLabel(message)
    return {
      id: entryId,
      role: 'assistant',
      content,
      timestamp: message.timestamp,
      ...(model ? { model } : {})
    }
  }

  // toolResult (folded above) / bashExecution (out of scope) — no own message.
  return null
}

function convertPiTextOrImageContent(
  content: string | Array<PiTextContent | PiImageContent>
): ContentBlock[] {
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : []
  }
  const blocks: ContentBlock[] = []
  for (const b of content) {
    if (b.type === 'text') {
      if (b.text) blocks.push({ type: 'text', text: b.text })
    } else if (isImageMediaType(b.mimeType)) {
      const ref = blobStore.put(b.mimeType, b.data)
      if (ref) blocks.push({ type: 'image', mediaType: b.mimeType, ...ref })
    }
    // Unrecognised mime types are dropped — see IMAGE_MEDIA_TYPES. So is a
    // payload the blob store refuses (ADR-087).
  }
  return blocks
}

/**
 * Convert a whole active-branch entry list to ChatMessage[], in order.
 * Two passes: (1) index every toolResult message by toolCallId, (2) convert
 * `message`/`compaction`/`custom_message` entries (everything else —
 * model_change, thinking_level_change, branch_summary, label, custom — is
 * skipped, matching the opencode converter's "silently skip unknown/irrelevant
 * types" precedent).
 */
export function convertPiSessionEntries(entries: PiSessionEntry[]): ChatMessage[] {
  const toolResultsByCallId = new Map<string, PiToolResultMessage>()
  for (const e of entries) {
    if (e.type === 'message' && e.message.role === 'toolResult') {
      toolResultsByCallId.set(e.message.toolCallId, e.message)
    }
  }

  const messages: ChatMessage[] = []
  for (const e of entries) {
    if (e.type === 'message') {
      const msg = convertPiEntryMessage(e.id, e.message, toolResultsByCallId)
      if (msg) messages.push(msg)
    } else if (e.type === 'compaction') {
      const ts = Date.parse(e.timestamp)
      messages.push({
        id: e.id,
        role: 'system',
        // The WHOLE summary, not its first line (F20). `CompactSeparator`
        // renders a non-empty `text` as the expandable amber card and shows the
        // body only when the user opens it, so there was never a reason to
        // throw away the rest — and pi is the one harness that has one.
        content: [{ type: 'compact_separator', text: e.summary }],
        timestamp: Number.isFinite(ts) ? ts : Date.now()
      })
    } else if (e.type === 'custom_message' && e.display) {
      // An extension injected this into the model's context. It was dropped
      // entirely, so the transcript disagreed with what the model saw. Same row
      // type as any injected context, titled by the extension that wrote it, and
      // rendered VERBATIM — an extension's text is third-party text. The live
      // mapper uses the same converter (ADR-089 S3), and ClaudeUI's own agent
      // messages are recognised there by customType + details, never by text.
      const ts = Date.parse(e.timestamp)
      const msg = piCustomMessageToChat({
        id: e.id,
        customType: e.customType,
        content: e.content,
        display: e.display,
        details: e.details,
        timestamp: Number.isFinite(ts) ? ts : Date.now()
      })
      if (msg) messages.push(msg)
    }
  }
  return messages
}

/**
 * Shared decoder for a Claude `tool_result` block's `content` field.
 *
 * Six producers used to hand-roll the same collapse:
 *
 *   Array.isArray(c) ? c.map((b) => (b.text as string) || '').join('\n') : c
 *
 * which turned an image-returning tool (Read on a .png, a screenshot tool, an
 * MCP tool returning a rendering) into an empty string — the image was dropped
 * at the process boundary and could never reach the renderer. This module is the
 * single implementation for all of them:
 *
 *   - claude-session.ts        `extractToolResultsFromContent` (live)
 *   - session-history.ts       user-line + assistant-line tool_results (main
 *                              parser and the subagent `parseJsonlFile`)
 *   - assistant-message.ts     assistant-embedded tool_result
 *   - subagent-watcher.ts      live subagent transcript tailing
 *   - automation-manager.ts    automation-run tool_results
 *   - cross-engine-dispatcher.ts  dispatched Claude subagent mirror
 *
 * The text collapse is preserved BYTE-FOR-BYTE (an image block still
 * contributes its empty string to the '\n'-join) so threading images through is
 * purely additive — no existing rendering shifts.
 *
 * Everything here treats its input as untrusted (a transcript on disk, a wire
 * frame): malformed blocks are skipped, never thrown on.
 */

import { isImageMediaType, type ToolResultImage } from '../../shared/types'

export interface ToolResultContent {
  /** The joined result text — identical to what the old inline collapse produced. */
  text: string
  /** Present only when at least one image survived; never an empty array. */
  images?: ToolResultImage[]
}

/**
 * Pull the images out of a tool_result's array content. Claude persists and
 * streams them as ordinary content blocks (verified against real transcripts in
 * ~/.claude/projects and the live stream-json frames):
 *
 *   { type:'image', source:{ type:'base64', media_type:'image/png', data:'<b64>' } }
 *
 * Non-base64 sources (`{type:'url'}`), empty payloads, and media types outside
 * `IMAGE_MEDIA_TYPES` are skipped. `document` blocks are ignored — a PDF returned
 * by a tool has no thumbnail affordance, and the gallery is images-only.
 *
 * Sibling to `extractAttachmentBlocks` in session-history.ts, which reads the
 * SAME wire shape off a `type:'user'` line but produces prompt-attachment
 * `ContentBlock`s (and handles `document`) rather than `ToolResultImage`s.
 *
 * The transcript/wire carries no filename for these, so `fileName` is omitted.
 */
export function extractToolResultImages(content: unknown): ToolResultImage[] {
  if (!Array.isArray(content)) return []
  const images: ToolResultImage[] = []
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue
    const block = raw as Record<string, unknown>
    if (block.type !== 'image') continue
    const source = block.source as Record<string, unknown> | undefined
    if (!source || source.type !== 'base64') continue
    const mediaType = source.media_type
    const data = source.data
    if (!isImageMediaType(mediaType) || typeof data !== 'string' || !data) continue
    images.push({ mediaType, base64Data: data })
  }
  return images
}

/**
 * Decode a tool_result `content` field into the renderer-facing text + images.
 *
 * `content` is either a plain string or an array of content blocks. Spread the
 * result onto a `tool_result` ContentBlock / IPC payload:
 *
 *   const { text, images } = extractToolResultContent(block.content)
 *   { type: 'tool_result', toolUseId, toolResult: text, ...(images ? { images } : {}) }
 */
export function extractToolResultContent(content: unknown): ToolResultContent {
  if (typeof content === 'string') return { text: content }
  if (!Array.isArray(content)) return { text: '' }

  // Preserved verbatim from the six call sites this replaced.
  const text = content
    .map((c) => ((c as Record<string, unknown> | null)?.text as string) || '')
    .join('\n')

  const images = extractToolResultImages(content)
  return images.length > 0 ? { text, images } : { text }
}

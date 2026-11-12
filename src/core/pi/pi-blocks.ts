/**
 * pi-blocks.ts
 *
 * The one place a pi wire or stored content block becomes a ClaudeUI
 * `ContentBlock`. The live mapper (`event-mapper.ts`) and the cold history
 * converter (`history.ts`) both build through these, so a replayed transcript
 * carries the same blocks the live stream showed.
 */
import type { ContentBlock, ToolResultImage } from '../../shared/types'
import { isImageMediaType } from '../../shared/types'
import { blobStore } from '../services/blob-store'
import type {
  PiAssistantContentBlock,
  PiImageContent,
  PiTextContent,
  PiToolResultMessage
} from './pi-protocol'

/**
 * One assistant content block: text → text, thinking → thinking (NOTE: wire
 * field is `thinking`, not `text`), toolCall → tool_use
 * { toolUseId: id, toolName: name, toolInput: arguments }.
 */
export function piAssistantBlock(block: PiAssistantContentBlock): ContentBlock {
  if (block.type === 'text') return { type: 'text', text: block.text }
  if (block.type === 'thinking') return { type: 'thinking', text: block.thinking }
  return {
    type: 'tool_use',
    toolUseId: block.id,
    toolName: block.name,
    toolInput: block.arguments
  }
}

/** Join the text blocks of a pi toolResult's content. */
export function piToolResultText(content: Array<PiTextContent | PiImageContent>): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is PiTextContent => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

/**
 * Images a pi tool RETURNED, from its toolResult content blocks
 * (`PiImageContent`: `{type:'image', data:<base64>, mimeType}` — note the
 * camelCase `mimeType`, unlike Claude's nested `source.media_type`).
 *
 * `mimeType` is a free-form string on the wire, so it is filtered through
 * `IMAGE_MEDIA_TYPES`; pi carries no filename, so `fileName` is omitted.
 * The bytes are interned into the blob store and the images carry refs
 * (ADR-087). Returns undefined (not []) when there is nothing to carry.
 */
export function piToolResultImages(
  content: Array<PiTextContent | PiImageContent>
): ToolResultImage[] | undefined {
  if (!Array.isArray(content)) return undefined
  const images: ToolResultImage[] = []
  for (const b of content) {
    if (b.type !== 'image') continue
    if (!isImageMediaType(b.mimeType) || !b.data) continue
    const ref = blobStore.put(b.mimeType, b.data)
    if (ref) images.push({ mediaType: b.mimeType, ...ref })
  }
  return images.length > 0 ? images : undefined
}

/** A pi tool result (live `toolResult` message or stored entry) as its `tool_result` block. */
export function piToolResultBlock(
  result: Pick<PiToolResultMessage, 'toolCallId' | 'content' | 'isError'>
): Extract<ContentBlock, { type: 'tool_result' }> & { isError: boolean } {
  const images = piToolResultImages(result.content)
  return {
    type: 'tool_result',
    toolUseId: result.toolCallId,
    toolResult: piToolResultText(result.content),
    isError: result.isError,
    ...(images ? { images } : {})
  }
}

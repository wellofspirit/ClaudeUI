/**
 * Gallery derivation — turns a `ChatMessage[]` into the galleries
 * `ImageViewerOverlay` pages through.
 *
 * Two galleries, each a flat list in message order:
 *   - **Attachments** — every `image` block on a **user** message, i.e. what the
 *     user attached to a prompt. This is what a chat thumbnail opens.
 *   - **Tool results** — images an engine returned from a tool call
 *     (`tool_result.images`, see `ToolResultImage`): Read on a .png, a
 *     screenshot tool, an MCP tool rendering something. This is what a tool
 *     card's thumbnail strip opens.
 *
 * Entries are blob REFS, not `data:` URIs (ADR-087): the transcript carries
 * `{blobId, mediaType}` and the viewer fetches the bytes for the entry it is
 * showing. Deriving a gallery therefore allocates nothing image-sized, which is
 * what lets it re-run on every streaming partial without a cache.
 */

import type { ChatMessage, ContentBlock } from '../../../../../shared/types'
import type { ViewerRasterImage } from './ImageViewerOverlay'

export const ATTACHMENTS_TAB_ID = 'attachments'
export const TOOL_RESULTS_TAB_ID = 'toolResults'
export const ATTACHMENTS_TAB_LABEL = 'Attachments'
export const TOOL_RESULTS_TAB_LABEL = 'Tool results'

/** A gallery entry plus the identity a thumbnail uses to find its own index. */
export type GalleryEntry = Extract<ViewerRasterImage, { blob: unknown }> & {
  key: string
  /**
   * Tool-results gallery only: the tool call that returned this image, and the
   * image's index within that result. A tool card knows only these two — it has
   * no access to its own `ChatMessage.id` — so `openToolResult` resolves the
   * gallery position from them instead of from `key`.
   */
  toolUseId?: string
  indexWithinResult?: number
}

export interface DerivedGalleries {
  attachments: GalleryEntry[]
  toolResults: GalleryEntry[]
}

type ImageBlock = Extract<ContentBlock, { type: 'image' }>

/**
 * Identity of one attached image: its message plus its index **among that
 * message's image blocks** — the same basis `MessageBubble` maps over, so a
 * thumbnail and this gallery agree without either passing indices around.
 */
export function attachmentKey(messageId: string, indexWithinMessage: number): string {
  return `${messageId}#${indexWithinMessage}`
}

/** The image blocks of one message, in content order — `MessageBubble`'s own filter. */
export function imageBlocksOf(message: ChatMessage): ImageBlock[] {
  return message.content.filter((b): b is ImageBlock => b.type === 'image')
}

export function deriveAttachmentGallery(messages: ChatMessage[]): GalleryEntry[] {
  const entries: GalleryEntry[] = []
  for (const message of messages) {
    if (message.role !== 'user') continue
    imageBlocksOf(message).forEach((block, i) => {
      entries.push({
        key: attachmentKey(message.id, i),
        blob: { blobId: block.blobId, mediaType: block.mediaType },
        fileName: block.fileName
      })
    })
  }
  return entries
}

/**
 * Identity of one tool-result image: the message, the tool call that returned
 * it, and its index within that result. `toolUseId` alone is not enough (a tool
 * can return several images) and `messageId` alone is not enough (one assistant
 * message holds many tool calls).
 */
export function toolResultKey(
  messageId: string,
  toolUseId: string,
  indexWithinResult: number
): string {
  return `${messageId}#${toolUseId}#${indexWithinResult}`
}

export function deriveToolResultGallery(messages: ChatMessage[]): GalleryEntry[] {
  const entries: GalleryEntry[] = []
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== 'tool_result' || !block.images) continue
      block.images.forEach((image, i) => {
        entries.push({
          key: toolResultKey(message.id, block.toolUseId, i),
          blob: { blobId: image.blobId, mediaType: image.mediaType },
          fileName: image.fileName,
          toolUseId: block.toolUseId,
          indexWithinResult: i
        })
      })
    }
  }
  return entries
}

export function deriveGalleries(messages: ChatMessage[]): DerivedGalleries {
  return {
    attachments: deriveAttachmentGallery(messages),
    toolResults: deriveToolResultGallery(messages)
  }
}

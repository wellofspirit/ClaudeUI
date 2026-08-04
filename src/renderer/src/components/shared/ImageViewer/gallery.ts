/**
 * Gallery derivation — turns a `ChatMessage[]` into the galleries
 * `ImageViewerOverlay` pages through.
 *
 * Two galleries, each a flat list in message order:
 *   - **Attachments** — every `image` block on a **user** message, i.e. what the
 *     user attached to a prompt. This is what a chat thumbnail opens.
 *   - **Tool results** — images an engine returned from a tool call. See the
 *     TODO on `deriveToolResultGallery`: the wire field is not in `ContentBlock`
 *     yet, so this gallery is empty in practice today.
 */

import type { ChatMessage, ContentBlock } from '../../../../../shared/types'
import type { ViewerImage } from './ImageViewerOverlay'

export const ATTACHMENTS_TAB_ID = 'attachments'
export const TOOL_RESULTS_TAB_ID = 'toolResults'
export const ATTACHMENTS_TAB_LABEL = 'Attachments'
export const TOOL_RESULTS_TAB_LABEL = 'Tool results'

/** A gallery entry plus the identity a thumbnail uses to find its own index. */
export interface GalleryEntry extends ViewerImage {
  key: string
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

/**
 * `data:` URIs are built once per block object and cached.
 *
 * The gallery is re-derived whenever the message array changes identity — which
 * during a streaming turn is every partial. Re-encoding a multi-MB base64 payload
 * into a fresh string on each of those would be a real allocation storm; user
 * message blocks are stable objects, so a WeakMap makes repeat derivations a
 * pointer lookup. (It also drops the entries automatically when a session is
 * evicted.)
 */
const dataUriCache = new WeakMap<ImageBlock, string>()

function imageSrc(block: ImageBlock): string {
  const cached = dataUriCache.get(block)
  if (cached !== undefined) return cached
  const src = `data:${block.mediaType};base64,${block.base64Data}`
  dataUriCache.set(block, src)
  return src
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
        src: imageSrc(block),
        fileName: block.fileName
      })
    })
  }
  return entries
}

/**
 * Shape this reader assumes for images attached to a tool result.
 *
 * TODO(tool-result-images): `ContentBlock`'s `tool_result` variant carries no
 * `images` field yet — threading engine-returned images through the wire is a
 * follow-up task. Rather than stub the gallery out to `[]` (which would leave the
 * whole multi-tab code path dead), the reader is written defensively against this
 * assumed shape and validates every field at runtime, so an engine that starts
 * emitting either form lights the tab up. When the field lands on `ContentBlock`
 * for real, delete this interface and the cast in `readToolResultImages` — the
 * rest of the function is already correct.
 */
interface ToolResultImagesShape {
  images?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Read the images off one `tool_result` block. Accepts either a ready-made `src`
 * or a `mediaType` + `base64Data` pair (the form the `image` content block uses);
 * anything else in the array is skipped rather than rendered as a broken image.
 */
function readToolResultImages(block: ContentBlock): ViewerImage[] {
  if (block.type !== 'tool_result') return []
  const raw = (block as ContentBlock & ToolResultImagesShape).images
  if (!Array.isArray(raw)) return []

  const out: ViewerImage[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const fileName = optionalString(item.fileName)
    const src = optionalString(item.src)
    if (src) {
      out.push({ src, fileName })
      continue
    }
    const mediaType = optionalString(item.mediaType)
    const base64Data = optionalString(item.base64Data)
    if (mediaType && base64Data) {
      out.push({ src: `data:${mediaType};base64,${base64Data}`, fileName })
    }
  }
  return out
}

export function deriveToolResultGallery(messages: ChatMessage[]): GalleryEntry[] {
  const entries: GalleryEntry[] = []
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== 'tool_result') continue
      readToolResultImages(block).forEach((image, i) => {
        entries.push({ ...image, key: `${message.id}#${block.toolUseId}#${i}` })
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

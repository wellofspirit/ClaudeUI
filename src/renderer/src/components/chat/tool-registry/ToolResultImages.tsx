/**
 * ToolResultImages — the thumbnail strip for images a TOOL returned.
 *
 * Rendered by `ToolCard` in the shared result area rather than by each kind
 * body: any tool can return an image (Read on a .png, a screenshot tool, an MCP
 * tool rendering something), and `tool_result.images` is kind-agnostic, so one
 * placement covers every standard kind with no per-kind edits. The two
 * custom-layout kinds (diagram/mockup) render their own card and so are NOT
 * covered — they synthesize their own visual from the tool INPUT and have never
 * carried returned images.
 *
 * Styling mirrors `MessageBubble`'s user-attachment strip, at the smaller 120px
 * cap that suits a tool card's density.
 *
 * Clicking opens the shared viewer on its "Tool results" tab via
 * `openToolResult`. With no `ImageGalleryProvider` mounted above (tests, or a
 * host that hasn't wrapped its list) the thumbnails still render, just inert —
 * the same contract MessageBubble follows.
 */

import type { ToolResultImage } from '../../../../../shared/types'
import { useImageGallery } from '../../shared/ImageViewer'

export function ToolResultImages({
  toolUseId,
  images
}: {
  toolUseId: string
  images: ToolResultImage[]
}): React.JSX.Element {
  const { openToolResult, enabled } = useImageGallery()

  return (
    <div data-testid="ToolResultImages" className="px-3 py-2.5 flex gap-2 flex-wrap">
      {images.map((image, i) => (
        <button
          key={i}
          type="button"
          data-testid="ToolResultImages.thumb"
          data-id={String(i)}
          disabled={!enabled}
          onClick={() => openToolResult(toolUseId, i)}
          aria-label={image.fileName ? `View image ${image.fileName}` : 'View tool result image'}
          title={image.fileName}
          className={`block rounded-lg leading-none ${
            enabled ? 'cursor-zoom-in' : 'cursor-default'
          }`}
        >
          <img
            src={`data:${image.mediaType};base64,${image.base64Data}`}
            alt={image.fileName || 'Tool result image'}
            className="max-w-[120px] max-h-[120px] rounded-lg object-contain"
          />
        </button>
      ))}
    </div>
  )
}

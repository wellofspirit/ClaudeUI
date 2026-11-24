/**
 * The `media` view of a hosted `generate_image` / `generate_video` call: the same on every
 * engine (their arguments match, `media-generation.ts`). Kept apart from `hosted-tools.ts`,
 * whose rows are a permission input; `hostedToolView` there calls this for the `media` kind.
 */
import { MEDIA_TOOL_NAMES, type MediaKind } from './media-generation'
import type { ToolView } from './tool-kinds'

type MediaView = Extract<ToolView, { kind: 'media' }>

/** The media kind of a BARE hosted tool name, or null when it is not one of the two. */
export function mediaKindOfTool(bareName: string): MediaKind | null {
  if (bareName === MEDIA_TOOL_NAMES.image) return 'image'
  if (bareName === MEDIA_TOOL_NAMES.video) return 'video'
  return null
}

/**
 * Whether a tool name, in any engine's spelling (`mcp__claude-ui-media__generate_image`,
 * `claudeui_generate_image`, bare `generate_image`), is one of the two media tools.
 */
export function isMediaToolName(toolName: string): boolean {
  const bare = toolName.replace(/^mcp__claude-ui-media__/, '').replace(/^claudeui_/, '')
  return mediaKindOfTool(bare) !== null
}

const text = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v : undefined

/** An engine's input is model-written: take only what has the documented type. */
export function mediaToolView(media: MediaKind, input: Record<string, unknown>): MediaView {
  const images = Array.isArray(input.images)
    ? input.images.filter((p): p is string => typeof p === 'string' && p !== '')
    : []
  return {
    kind: 'media',
    media,
    prompt: text(input.prompt),
    model: text(input.model),
    path: text(input.path),
    ...(images.length > 0 ? { images } : {})
  }
}

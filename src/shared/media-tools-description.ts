/**
 * The one description and parameter schema of ClaudeUI's hosted `generate_image` / `generate_video`
 * tools. Every engine registers its own copy of the tool (Claude's `claude-ui-media` SDK MCP server,
 * opencode's `claudeui` MCP host, pi's bridge extension); the prose lives here once. The pi bridge
 * source interpolates it at module load (it cannot import), and `pi-bridge-source.test.ts` pins it.
 *
 * Pure strings and plain data, no imports beyond types: usable from the renderer, core and the pi
 * bridge's build alike. No backtick or `${` may appear in any string here (the pi bridge source is a
 * template literal).
 */
import type { MediaKind } from './media-generation'

const SHARED =
  'The job runs in the background: the call returns at once with the job id and the path the file will be ' +
  'saved to, and you are notified when it finishes (the notice arrives as a message, never from the user). ' +
  'Do not poll for the file and do not request it again while the job runs. '

const MODEL_NOTE =
  'Never set model unless the user asks for a specific one; the available values come from ' +
  'Settings > Media generation, and an unset model uses the one the user configured. '

/** The tool description, per kind. */
export const MEDIA_TOOL_DESCRIPTIONS: Record<MediaKind, string> = {
  image:
    'Generate an image from a text prompt, or edit or combine local images when images are given. ' +
    SHARED +
    MODEL_NOTE +
    'The file is saved inside the workspace, by default under .claude/ui/media/; pass path only to choose ' +
    'a location inside the workspace.',
  video:
    'Generate a short video from a text prompt, optionally animating from a first (and last) frame image. ' +
    'Video jobs can take several minutes. ' +
    SHARED +
    MODEL_NOTE +
    'The file is saved inside the workspace, by default under .claude/ui/media/; pass path only to choose ' +
    'a location inside the workspace.'
}

export const MEDIA_PROMPT_PARAM = 'What to generate, or how to change the given images.'
export const MEDIA_IMAGES_PARAM_IMAGE =
  'Optional local image paths (1 to 8) to edit or use as references. Absolute, or relative to the working directory.'
export const MEDIA_IMAGES_PARAM_VIDEO =
  'Optional local image paths (at most 2): the first frame, then optionally the last frame. Absolute, or relative to the working directory.'
export const MEDIA_MODEL_PARAM =
  'Model reference. Never set this unless the user asks for a specific model; omit it to use the configured one.'
export const MEDIA_PATH_PARAM =
  'Optional output path inside the workspace (relative to the working directory, or absolute). Omit it to save under .claude/ui/media/.'
export const MEDIA_DURATION_PARAM = 'Optional video length in seconds; omit for the model default.'
export const MEDIA_ASPECT_PARAM = 'Optional aspect ratio.'
export const MEDIA_ASPECTS = ['16:9', '9:16', '1:1'] as const

export interface MediaParamSchema {
  type: 'object'
  properties: Record<string, Record<string, unknown>>
  required: string[]
}

/** The JSON schema of a tool's input (opencode's host and the pi bridge; Claude builds zod from the same strings). */
export function mediaToolSchema(kind: MediaKind): MediaParamSchema {
  const properties: Record<string, Record<string, unknown>> = {
    prompt: { type: 'string', description: MEDIA_PROMPT_PARAM },
    images: {
      type: 'array',
      items: { type: 'string' },
      description: kind === 'video' ? MEDIA_IMAGES_PARAM_VIDEO : MEDIA_IMAGES_PARAM_IMAGE
    },
    model: { type: 'string', description: MEDIA_MODEL_PARAM },
    path: { type: 'string', description: MEDIA_PATH_PARAM }
  }
  if (kind === 'video') {
    properties.duration = { type: 'number', description: MEDIA_DURATION_PARAM }
    properties.aspect = {
      type: 'string',
      enum: [...MEDIA_ASPECTS],
      description: MEDIA_ASPECT_PARAM
    }
  }
  return { type: 'object', properties, required: ['prompt'] }
}

/**
 * The engine-neutral body of the hosted `generate_image` / `generate_video` tool call: takes the
 * model-written input as it came off the wire, starts the job through the job service and words
 * the answer. Claude's `claude-ui-media` server, opencode's `claudeui` host and pi's `handleHostedTool`
 * each resolve the caller (routing id, cwd, tool-use id, root or subagent) themselves and call this.
 */
import { z } from 'zod'
import type { MediaKind } from '../../shared/media-generation'
import {
  MEDIA_ASPECT_PARAM,
  MEDIA_ASPECTS,
  MEDIA_DURATION_PARAM,
  MEDIA_IMAGES_PARAM_IMAGE,
  MEDIA_IMAGES_PARAM_VIDEO,
  MEDIA_MODEL_PARAM,
  MEDIA_PATH_PARAM,
  MEDIA_PROMPT_PARAM
} from '../../shared/media-tools-description'
import type { MediaJobInput, MediaStartArgs, MediaStartResult } from './media-jobs'
import { noticeText } from './media-job-text'

export const MEDIA_PLAN_MODE_REFUSAL =
  'generate_image and generate_video are not available in plan mode. Leave plan mode to generate media.'

export type MediaStartFn = (args: MediaStartArgs) => Promise<MediaStartResult>

export interface MediaToolReply {
  text: string
  isError: boolean
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

/** Model-written input: keep only what has the documented type. */
export function parseMediaInput(kind: MediaKind, raw: Record<string, unknown>): MediaJobInput {
  const images = Array.isArray(raw.images)
    ? raw.images.filter((p): p is string => typeof p === 'string' && p !== '')
    : []
  const input: MediaJobInput = {
    prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
    ...(images.length > 0 ? { images } : {}),
    ...(str(raw.model) ? { model: str(raw.model) } : {}),
    ...(str(raw.path) ? { path: str(raw.path) } : {})
  }
  if (kind === 'video') {
    if (typeof raw.duration === 'number' && Number.isFinite(raw.duration) && raw.duration > 0) {
      input.duration = raw.duration
    }
    const aspect = MEDIA_ASPECTS.find((a) => a === raw.aspect)
    if (aspect) input.aspect = aspect
  }
  return input
}

export interface MediaCall {
  routingId: string
  cwd: string
  engineId: string
  toolUseId: string | null
  kind: MediaKind
  /** A subagent caller (or one that cannot be attributed): wait for the outcome. */
  foreground: boolean
  input: Record<string, unknown>
}

/** Start the job and word the tool result. */
export async function runMediaTool(start: MediaStartFn, call: MediaCall): Promise<MediaToolReply> {
  const input = parseMediaInput(call.kind, call.input)
  const started = await start({
    routingId: call.routingId,
    cwd: call.cwd,
    engineId: call.engineId,
    toolUseId: call.toolUseId,
    kind: call.kind,
    input,
    foreground: call.foreground
  })
  if (!started.ok) return { text: started.error, isError: true }
  const job = {
    id: started.jobId,
    kind: call.kind,
    modelLabel: started.modelLabel,
    inputPaths: input.images ?? []
  }
  if (started.final) {
    return { text: noticeText(job, started.final), isError: started.final.status !== 'completed' }
  }
  const word = call.kind === 'video' ? 'Video' : 'Image'
  return {
    text:
      `${word} job ${started.jobId} started with ${started.modelLabel}; it will be saved to ` +
      `${started.path}. You will be notified when it finishes. Do not poll or re-request it.`,
    isError: false
  }
}

/** The tool's input as a zod raw shape (Claude's SDK server and opencode's MCP host), worded by the shared module. */
export function mediaZodShape(kind: MediaKind): Record<string, z.ZodType> {
  const common = {
    prompt: z.string().describe(MEDIA_PROMPT_PARAM),
    images: z
      .array(z.string())
      .optional()
      .describe(kind === 'video' ? MEDIA_IMAGES_PARAM_VIDEO : MEDIA_IMAGES_PARAM_IMAGE),
    model: z.string().optional().describe(MEDIA_MODEL_PARAM),
    path: z.string().optional().describe(MEDIA_PATH_PARAM)
  }
  return kind === 'video'
    ? {
        ...common,
        duration: z.number().optional().describe(MEDIA_DURATION_PARAM),
        aspect: z.enum(MEDIA_ASPECTS).optional().describe(MEDIA_ASPECT_PARAM)
      }
    : common
}

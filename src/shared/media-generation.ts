/**
 * Media generation (ClaudeUI's hosted `generate_image` / `generate_video`): the
 * contract the host job service, the three engine surfaces, the settings page and
 * the chat card share. Spec: `.work/media-generation/spec.md` in the arc worktree.
 */

/** Which kind of media a job makes. */
export type MediaKind = 'image' | 'video'

/** Where a job's model runs: the ChatGPT plan's included usage, or a key the user connected. */
export type MediaSource = 'chatgpt-plan' | 'openai' | 'openrouter'

/** The ChatGPT plan's single image entry ("ChatGPT Plan"): OpenAI picks the model, quality and size. */
export const CHATGPT_PLAN_MODEL_REF = 'chatgpt-plan'

/**
 * A model reference as the tools, the settings and the ledger write it:
 * `chatgpt-plan`, `openai/<id>` or `openrouter/<id>`.
 */
export type MediaModelRef = string

/** A selectable model, as the catalog lists it for the connected sources only. */
export interface MediaCatalogModel {
  ref: MediaModelRef
  kind: MediaKind
  source: MediaSource
  /** Display name ("ChatGPT Plan", "GPT Image 2.6 Flare"). */
  name: string
  /** Takes input images (edits, references, first/last frame). */
  acceptsImages: boolean
  /** Free tier marker from the catalog (`:free` ids, zero cost). */
  free?: boolean
}

/** A model setting: Automatic, Off (no tool), or one model. */
export type MediaModelChoice = 'auto' | 'off' | MediaModelRef

export type MediaImageQuality = 'low' | 'medium' | 'high'

/** Where a file goes when the agent gives no path. */
export type MediaSaveTo = 'media' | 'generated'

export interface MediaGenerationSettings {
  /** Offer the tools to each engine. opencode: ours replaces opencode's own media tools. */
  engines: { claude: boolean; pi: boolean; opencode: boolean }
  imageModel: MediaModelChoice
  videoModel: MediaModelChoice
  /** For keyed models; the ChatGPT plan ignores it. */
  imageQuality: MediaImageQuality
  /** Jobs running at once per app; the rest wait in a queue. */
  concurrency: number
  /** A job still running after this fails and the agent is told. */
  timeoutMinutes: number
  saveTo: MediaSaveTo
}

export const DEFAULT_MEDIA_GENERATION: MediaGenerationSettings = {
  engines: { claude: true, pi: true, opencode: true },
  imageModel: 'auto',
  videoModel: 'off',
  imageQuality: 'high',
  concurrency: 4,
  timeoutMinutes: 10,
  saveTo: 'media'
}

/**
 * The saved `mediaGeneration` app setting, field by field over the defaults: a
 * missing or wrongly typed field takes its default, so a partial or hand-edited
 * value never reaches the job service.
 */
export function resolveMediaGeneration(saved: unknown): MediaGenerationSettings {
  const d = DEFAULT_MEDIA_GENERATION
  const s = typeof saved === 'object' && saved !== null ? (saved as Record<string, unknown>) : {}
  const engines =
    typeof s.engines === 'object' && s.engines !== null
      ? (s.engines as Record<string, unknown>)
      : {}
  const bool = (v: unknown, f: boolean): boolean => (typeof v === 'boolean' ? v : f)
  const str = <T extends string>(v: unknown, f: T, allowed?: readonly T[]): T =>
    typeof v === 'string' && v !== '' && (!allowed || allowed.includes(v as T)) ? (v as T) : f
  const int = (v: unknown, f: number, min: number, max: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : f
  return {
    engines: {
      claude: bool(engines.claude, d.engines.claude),
      pi: bool(engines.pi, d.engines.pi),
      opencode: bool(engines.opencode, d.engines.opencode)
    },
    imageModel: str(s.imageModel, d.imageModel),
    videoModel: str(s.videoModel, d.videoModel),
    imageQuality: str(s.imageQuality, d.imageQuality, ['low', 'medium', 'high'] as const),
    concurrency: int(s.concurrency, d.concurrency, 1, 16),
    timeoutMinutes: int(s.timeoutMinutes, d.timeoutMinutes, 1, 120),
    saveTo: str(s.saveTo, d.saveTo, ['media', 'generated'] as const)
  }
}

/** The tool names, per engine spelling. */
export const MEDIA_TOOL_NAMES = {
  image: 'generate_image',
  video: 'generate_video'
} as const satisfies Record<MediaKind, string>

/** Claude's SDK MCP server for the media tools: its own, outside `allowedTools`, so calls are asked. */
export const CLAUDE_MEDIA_MCP_SERVER = 'claude-ui-media'

/** The ChatGPT plan's usage, from the `x-codex-*` headers of its last response. */
export interface MediaPlanUsage {
  usedPercent: number | null
  resetsInSeconds: number | null
  /** When the snapshot was taken (epoch ms). */
  at: number
}

/**
 * A media job's outcome on its task notification (`TaskNotification.media`): what
 * the card draws once the job ends. `blobId` is set for an image (and a video under
 * the blob size cap); `fileId` names the saved file for the authenticated media file
 * route both clients load (video playback, Open).
 */
export interface MediaJobResult {
  kind: MediaKind
  jobId: string
  /** The final saved path (the start path is provisional: the extension follows the provider's format). */
  path: string
  mime: string
  bytes: number
  width?: number
  height?: number
  /** Seconds, for a video. */
  durationSeconds?: number
  blobId?: string
  fileId?: string
  /** The model as the card names it ("ChatGPT Plan", "Qwen Image 3"). */
  modelLabel: string
  source: MediaSource
  /** Wall time of the provider call, ms. */
  elapsedMs: number
  /** USD, when the provider reports it. */
  costUsd?: number
  planUsage?: MediaPlanUsage
  /** The prompt the provider says it actually used, when it rewrote it. */
  revisedPrompt?: string
  /** Input images the job edited from, as saved paths (Before/After). */
  inputs?: string[]
}

/** `taskType` of a media job's task records. */
export const MEDIA_TASK_TYPE = 'media'

/** Sender key prefix of a media job's completion notice (`media-job:<jobId>`). */
export const MEDIA_JOB_KEY_PREFIX = 'media-job:'

/** What `window.api.listMediaModels()` answers: the catalog for the connected sources only. */
export interface MediaCatalog {
  models: MediaCatalogModel[]
  /** Which sources are connected now (ChatGPT signed in and not needing re-auth; a key present and enabled). */
  connected: Record<MediaSource, boolean>
  /** The last ChatGPT plan usage snapshot, if a job has run this app session. */
  planUsage?: MediaPlanUsage
}

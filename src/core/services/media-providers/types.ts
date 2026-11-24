/**
 * The seam between the media job service (`media-jobs.ts`) and the provider
 * clients. A provider makes ONE generation and returns the bytes; the job service
 * owns paths, files, blobs, the ledger, the card events and the notice.
 */
import type { MediaKind, MediaPlanUsage, MediaSource } from '../../../shared/media-generation'

export interface MediaInputImage {
  /** Bytes of a local input image the job service already read and checked. */
  bytes: Buffer
  mime: string
}

export interface MediaGenerateRequest {
  kind: MediaKind
  source: MediaSource
  /** The provider's model id (`gpt-image-2.6-flare`, `qwen/qwen-image-3`); ignored for the ChatGPT plan. */
  modelId: string
  prompt: string
  images: MediaInputImage[]
  /** Keyed image models only. */
  quality?: 'low' | 'medium' | 'high'
  /** Video only. */
  durationSeconds?: number
  aspect?: '16:9' | '9:16' | '1:1'
  /** Abort = Stop on the card, the give-up timeout, or the session closing. */
  signal: AbortSignal
  /**
   * Video jobs: called once with the provider's own job id as soon as it exists, so the
   * ledger keeps it (a paid job is not lost silently on restart).
   */
  onProviderJobId?: (id: string) => void
}

export interface MediaGenerateResult {
  bytes: Buffer
  mime: string
  width?: number
  height?: number
  durationSeconds?: number
  revisedPrompt?: string
  costUsd?: number
  planUsage?: MediaPlanUsage
}

/** A provider failure the card and the agent may read: `message` is already truncated and credential-free. */
export class MediaProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = 'MediaProviderError'
  }
}

export interface MediaProvider {
  readonly source: MediaSource
  generate(request: MediaGenerateRequest): Promise<MediaGenerateResult>
}

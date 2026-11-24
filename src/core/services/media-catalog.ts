/**
 * The media catalog: image and video models for the CONNECTED sources only
 * (ChatGPT signed in; an OpenAI or OpenRouter key present and enabled), and the
 * resolution of a job's model (explicit → setting → Automatic).
 *
 * Contract stub: slice A (catalog + providers) fills the bodies; the job service
 * (slice B) and the IPC query code against these signatures.
 */
import type {
  MediaCatalog,
  MediaKind,
  MediaModelRef,
  MediaSource
} from '../../shared/media-generation'

export interface ResolvedMediaModel {
  ref: MediaModelRef
  source: MediaSource
  /** The provider's own id (ignored for the ChatGPT plan). */
  modelId: string
  /** The card's name for it ("ChatGPT Plan"). */
  label: string
  acceptsImages: boolean
}

/** Every selectable model of the connected sources, plus which sources are connected. */
export async function listMediaModels(): Promise<MediaCatalog> {
  throw new Error('media-catalog: not implemented')
}

/**
 * The model a job runs on: `explicit` (the tool's `model` argument) when given and
 * available, else the setting, else Automatic. `{ error }` names why none fits
 * (nothing connected, the setting is Off, an unknown or unavailable model, no model
 * that takes input images when `needsImages`).
 */
export async function resolveMediaModel(
  kind: MediaKind,
  explicit: MediaModelRef | undefined,
  needsImages: boolean
): Promise<ResolvedMediaModel | { error: string }> {
  void kind
  void explicit
  void needsImages
  throw new Error('media-catalog: not implemented')
}

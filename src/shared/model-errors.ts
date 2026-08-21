/**
 * The refusal an EXPLICIT, user-configured model reference produces once the
 * engine stops offering that model.
 *
 * Owner ruling (2026-08-21): a model the user named — an engine default, an
 * auto-mode judge model, a dispatch default, a per-session remembered pick —
 * must ERROR when it disappears, never resolve to a silent substitute. The
 * substitute is not a smaller version of the same thing: capabilities differ
 * (the regression that surfaced this swapped a vision model for a no-vision one
 * and dropped pasted images on the floor), and cost and behaviour differ too.
 * BUILT-IN heuristic defaults carry no such promise and keep falling back
 * quietly — that distinction is the caller's to make, not this type's.
 *
 * Lives in `shared/` rather than beside either engine's discovery module: both
 * opencode and pi throw it, and an engine importing another engine's internals
 * to construct an error would be the wrong dependency edge.
 *
 * The message is USER-FACING verbatim. It crosses the IPC boundary as a
 * stringified rejection and the renderer renders it into an error banner
 * (`Failed to send message: ${err}`), so it names the model and the settings
 * surface that owns it — an unactionable "model not found" is exactly what made
 * the silent substitute look like the kinder option.
 */
import type { EngineId } from './types'

/** Stable machine-readable marker, for callers that must branch on the cause. */
export const MODEL_UNAVAILABLE_CODE = 'MODEL_UNAVAILABLE'

export class ModelUnavailableError extends Error {
  readonly code = MODEL_UNAVAILABLE_CODE
  readonly engineId: EngineId
  /** The model VALUE that was requested and is no longer offered. */
  readonly requested: string

  constructor(engineId: EngineId, requested: string) {
    super(
      `Model "${requested}" is no longer available for ${engineId}. ` +
        `Pick an available model, or change the configured default in Settings → Engines → ${engineId}.`
    )
    this.name = 'ModelUnavailableError'
    this.engineId = engineId
    this.requested = requested
  }
}

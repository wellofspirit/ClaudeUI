/**
 * model-override.ts — what `vendors/anthropic.json`'s model mapping actually
 * does to a Claude spawn (ADR-074 §9).
 *
 * The mapping has two jobs with a switch each: PIN one model for every session
 * (`ANTHROPIC_MODEL`) and RENAME the aliases for a gateway that names Claude's
 * models differently (`ANTHROPIC_DEFAULT_{SONNET,OPUS,HAIKU}_MODEL`). A file
 * written before the split has only `enabled`, which both switches fall back
 * to — so an older config keeps setting all four vars.
 *
 * shared/ — pure, renderer-safe, so anything that needs to say what the
 * mapping does reads the same rule `applyModelEnv` spawns with.
 */
import type { ModelOverrideSettings } from './types'

/** Each slot is the value to send, or `null` when it must stay unset. */
export interface EffectiveModelOverride {
  pin: string | null
  sonnet: string | null
  opus: string | null
  haiku: string | null
}

export function effectiveModelOverride(
  mo: Partial<ModelOverrideSettings> | undefined
): EffectiveModelOverride {
  const pinOn = mo?.pinEnabled ?? mo?.enabled ?? false
  const renameOn = mo?.renameEnabled ?? mo?.enabled ?? false
  // An empty field is "keep Claude's own name", never an empty env var.
  const when = (on: boolean, value: string | undefined): string | null =>
    on && value ? value : null
  return {
    pin: when(pinOn, mo?.model),
    sonnet: when(renameOn, mo?.sonnetModel),
    opus: when(renameOn, mo?.opusModel),
    haiku: when(renameOn, mo?.haikuModel)
  }
}

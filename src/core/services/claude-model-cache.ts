import type { ModelInfo } from '../../shared/types'

/**
 * The Claude model catalog as cli.js last reported it (`supportedModels()`), kept
 * in one place so a reader that is not a session (an automation run or a dispatched
 * Claude agent deciding its starting effort) sees the same rows the picker does,
 * instead of falling back to id heuristics that cannot judge an alias (`default`,
 * `opus`).
 *
 * A leaf module: `claude-model-catalog.ts`, which fills it, imports
 * `claude-session.ts`, and a reader on the dispatch side of that file cannot import
 * it back (`src/shared/__tests__/import-cycles.test.ts`). Everything else imports
 * these through `claude-model-catalog.ts`, which re-exports them.
 *
 * Written by `queryClaudeModels`, the ONE place that asks cli.js for
 * `supportedModels()`. Readers that must not wait on a fetch use
 * {@link cachedClaudeModels}, which returns whatever was last seen at ANY age: a
 * stale catalog still names the right row for a model, and `[]` before the first
 * fetch is a state the callers already handle (they resolve from the model value
 * alone, as the renderer does when its own catalog lacks the row).
 */
let cached: { models: ModelInfo[]; at: number } | null = null

export function setCachedClaudeModels(models: ModelInfo[]): void {
  cached = { models, at: Date.now() }
}

/** The catalog if it is younger than `maxAgeMs`, else null (the TTL-bound picker read). */
export function freshClaudeModels(maxAgeMs: number): ModelInfo[] | null {
  return cached && Date.now() - cached.at < maxAgeMs ? cached.models : null
}

/** Whatever catalog was last seen, of any age; `[]` before the first fetch. */
export function cachedClaudeModels(): ModelInfo[] {
  return cached?.models ?? []
}

/** Test seam. */
export function resetCachedClaudeModels(): void {
  cached = null
}

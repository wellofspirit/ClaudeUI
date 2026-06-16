/**
 * Codex model list loader.
 *
 * Spawns a short-lived app-server, calls model/list (paginating via nextCursor),
 * maps each V2Model to ClaudeUI's ModelInfo shape, and returns the result.
 *
 * Mapping notes:
 * - model.model → value/id (the slug sent back in turn/start requests)
 * - model.displayName → displayName (humanized, titlecased by toDisplayName)
 * - supportsEffort: true — all Codex models have supportedReasoningEfforts
 * - supportedEffortLevels: the reasoningEffort strings cast to our EffortLevel
 *   union. Codex uses "low"/"medium"/"high" which happen to be a subset of
 *   ClaudeUI's EffortLevel = 'low'|'medium'|'high'|'xhigh'|'max'.
 * - supportsAdaptiveThinking: false — Codex has no adaptive thinking mode.
 * - description: empty (Codex models don't have a human description field, just displayName).
 */

import { withCodexAppServer } from './codexQuery'
import type { ModelInfo } from '../../shared/types'
import { logger } from '../services/logger'
import type { V2Model } from './protocol/schema'

// Codex uses "low" | "medium" | "high" (and potentially others).
// ClaudeUI's EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'.
// Only pass through values that are in the union; unknown ones still show
// up since ModelInfo.supportedEffortLevels is typed loosely at runtime.
const EFFORT_LEVEL_PASSTHROUGH = new Set<string>(['low', 'medium', 'high', 'xhigh', 'max'])

function toDisplayName(model: V2Model): string {
  // Mirror t3code's toDisplayName: capitalize 'gpt' → 'GPT', capitalize
  // first letter after each dash.
  return model.displayName
    .replace(/^gpt/i, 'GPT')
    .replace(/-([a-z])/g, (_, c: string) => '-' + c.toUpperCase())
}

/** Map a single V2Model to ClaudeUI's ModelInfo. */
export function mapCodexModelToModelInfo(model: V2Model): ModelInfo {
  const effortLevels = model.supportedReasoningEfforts
    .map((opt) => opt.reasoningEffort)
    .filter((e) => EFFORT_LEVEL_PASSTHROUGH.has(e)) as ModelInfo['supportedEffortLevels']

  return {
    value: model.model,
    displayName: toDisplayName(model),
    description: '',
    supportsEffort: true,
    supportedEffortLevels: effortLevels && effortLevels.length > 0 ? effortLevels : undefined,
    supportsAdaptiveThinking: false,
  }
}

/**
 * Load the list of Codex models by spawning a short-lived app-server and
 * calling model/list (paginating if nextCursor is present).
 *
 * @param cwd       Working directory for the app-server spawn.
 * @param timeoutMs Total timeout for the operation (default: 15 s).
 */
export async function loadCodexModels(
  cwd: string,
  timeoutMs = 15_000
): Promise<ModelInfo[]> {
  logger.debug('codexModels', 'loading model list')

  const models = await withCodexAppServer(
    cwd,
    async (client) => {
      const result: ModelInfo[] = []
      let cursor: string | null | undefined = undefined

      do {
        const response = await client.request('model/list', cursor ? { cursor } : {})
        for (const m of response.data) {
          result.push(mapCodexModelToModelInfo(m))
        }
        cursor = typeof response.nextCursor === 'string' ? response.nextCursor : null
      } while (cursor)

      return result
    },
    timeoutMs
  )

  logger.debug('codexModels', `loaded ${models.length} models`)
  return models
}

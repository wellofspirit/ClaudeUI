import type { ModelInfo } from '../../shared/types'
import { claudeAliasForModel, claudeConfigWithAliases } from '../../shared/model-capabilities'
import { runningAutomationManager } from '../ipc/automation-commands'
import { logger } from './logger'
import { loadEngineConfig, saveEngineConfig } from './ui-config'

/**
 * Move the host's saved concrete Claude picks to the alias that resolves to them
 * in `catalog` (ADR-100): `engines/claude.json`'s default model and dispatch
 * default/allowlist, and every automation's model. Ids no alias reaches stay as
 * they are, for the stale-model path (ADR-059).
 *
 * Run on every non-empty catalog fetch: idempotent, it writes only what moved, so
 * a pick an older build saves later is moved by the next fetch. Never throws — it
 * runs inside the catalog fetch, which must not fail over a config write.
 * Starting efforts need no pass of their own: an effort saved under the resolved
 * id is still read for its alias row (`claudeLegacyEffortKey`), and moved onto
 * the alias key when the row is next edited. The renderer's own copies (the last
 * pick in localStorage, its engine-config snapshot) are moved by the store.
 */
export function migrateSavedClaudeModels(catalog: readonly ModelInfo[]): void {
  if (catalog.length === 0) return
  try {
    const config = loadEngineConfig('claude')
    const next = claudeConfigWithAliases(config, catalog)
    if (next !== config) saveEngineConfig('claude', next)
    runningAutomationManager()?.remapModels((model) => claudeAliasForModel(model, catalog))
  } catch (err) {
    logger.warn('ClaudeModelAliasMigration', 'Failed to move saved Claude models to aliases', err)
  }
}

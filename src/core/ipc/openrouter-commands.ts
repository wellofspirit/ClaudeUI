/**
 * The four `openrouter:*` channels (Usage Analytics › OpenRouter), declared ONCE
 * and served by both transports, like `usage-hub-commands.ts`.
 *
 * All `config` queries: they are figures, read through the vault key the host
 * already holds. No shape here carries that key (or the creator and workspace
 * ids OpenRouter attaches to it) back out — `openrouter-dashboard.ts` maps every
 * answer field by field and throws only fixed messages, which is what makes
 * these safe to reach from a remote client. `safeHandler` envelopes them (the
 * clients `unwrap`), so no result type may carry an `ok` key.
 */

import type { CommandRegistration } from './command-registry'
import { safeHandler } from './safe-handler'
import { openrouterDashboard } from '../services/openrouter-dashboard'

/** Unbound beside the other shared-file families before `registerSessionIpc` re-registers. */
export const OPENROUTER_CHANNELS = [
  'openrouter:status',
  'openrouter:overview',
  'openrouter:models',
  'openrouter:model-endpoints'
] as const

export function openrouterCommands(): Array<Omit<CommandRegistration, 'transport'>> {
  return [
    {
      channel: 'openrouter:status',
      capability: 'config',
      kind: 'query',
      handler: safeHandler(async () => openrouterDashboard.status())
    },
    {
      channel: 'openrouter:overview',
      capability: 'config',
      kind: 'query',
      handler: safeHandler(async () => openrouterDashboard.overview())
    },
    {
      channel: 'openrouter:models',
      capability: 'config',
      kind: 'query',
      // The argument is whatever a remote caller sent; the service validates it.
      handler: safeHandler(async (scope?: unknown) => openrouterDashboard.models(scope))
    },
    {
      channel: 'openrouter:model-endpoints',
      capability: 'config',
      kind: 'query',
      handler: safeHandler(async (modelId?: unknown) => openrouterDashboard.modelEndpoints(modelId))
    }
  ]
}

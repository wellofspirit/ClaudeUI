import { opencodeServerManager } from './OpencodeServerManager'
import { OpencodeClient } from './OpencodeClient'
import { PERSISTED_SESSIONS_DIR } from '../services/persisted-sessions-dir'
import type { EngineModelGroup, ModelInfo } from '../../shared/types'
import { logger } from '../services/logger'

let cachedGroups: EngineModelGroup[] | null = null

/** Per-model context-window cache: key = "providerID/modelID", value = tokens. */
const contextWindowCache = new Map<string, number>()

/**
 * Discover opencode providers + models by spinning up a transient server in
 * PERSISTED_SESSIONS_DIR, calling GET /config/providers, then releasing.
 *
 * Returns [] on any failure (binary missing, spawn error, network error) —
 * opencode is optional and Claude must not break.
 *
 * Value convention: `"<providerID>/<modelID>"` so the string-based
 * ISession.setModel()/session:create(model) contract is preserved.
 * OpencodeSession parses it back to { providerID, modelID }.
 */
export async function discoverOpencodeModels(): Promise<EngineModelGroup[]> {
  if (cachedGroups) return cachedGroups

  try {
    const conn = await opencodeServerManager.acquire(PERSISTED_SESSIONS_DIR)
    const client = new OpencodeClient(conn.baseUrl, conn.authHeader)
    try {
      const resp = await client.getConfigProviders()
      const groups: EngineModelGroup[] = []

      for (const provider of resp.providers ?? []) {
        const models: ModelInfo[] = Object.entries(provider.models ?? {}).map(([modelId, m]) => {
          const caps = m.capabilities
          const vision = !!(caps?.attachment || caps?.input?.image)
          const toolCalling = !!caps?.toolcall
          // Build a human-friendly description: "providerName · modelId"
          const description = `${provider.name} · ${m.name || modelId}`
          // Cache the context window size for status-line usage (% used).
          if (m.limit?.context) {
            contextWindowCache.set(`${provider.id}/${modelId}`, m.limit.context)
          }
          return {
            value: `${provider.id}/${modelId}`,
            displayName: m.name || modelId,
            description,
            engineId: 'opencode' as const,
            vendorId: provider.id,
            vision,
            toolCalling,
            supportsEffort: false,
            supportsAdaptiveThinking: false
          }
        })

        if (models.length > 0) {
          groups.push({
            engineId: 'opencode',
            vendorId: provider.id,
            vendorName: provider.name,
            models
          })
        }
      }

      cachedGroups = groups
      return groups
    } finally {
      opencodeServerManager.release(PERSISTED_SESSIONS_DIR)
    }
  } catch (err) {
    logger.warn('opencode', `Model discovery failed (opencode optional): ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

/**
 * Returns the context-window token count for a specific model as reported by
 * /config/providers (`model.limit.context`). Returns 0 if the model is not in
 * the discovery cache (discovery hasn't run yet, or the model has no limit).
 */
export function getOpencodeModelContextWindow(providerID: string, modelID: string): number {
  return contextWindowCache.get(`${providerID}/${modelID}`) ?? 0
}

/** Invalidate the model discovery cache (call on auth change). */
export function invalidateOpencodeModelCache(): void {
  cachedGroups = null
  contextWindowCache.clear()
}

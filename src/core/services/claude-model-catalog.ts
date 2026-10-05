import type { ModelInfo } from '../../shared/types'
import { query as sdkQuery } from '../sdk'
import { ensureHostTokenFresh } from '../sdk/host-token'
import { getSdkExecutableOpts } from './claude-session'
import { PERSISTED_SESSIONS_DIR } from './persisted-sessions-dir'

/**
 * The Claude model catalog as cli.js last reported it (`supportedModels()`), kept
 * in one place so a reader that is not a session — an automation run deciding its
 * starting effort — sees the same rows the picker does, instead of falling back to
 * id heuristics that cannot judge an alias (`default`, `opus`).
 *
 * Written by {@link queryClaudeModels} — the ONE place that asks cli.js for
 * `supportedModels()`, whichever transport (desktop IPC, remote WebSocket,
 * claudeui-server) the picker fetch came in on — so every picker fetch feeds
 * automation runs, headless hosts included. Readers that must not wait on a fetch use {@link cachedClaudeModels}, which
 * returns whatever was last seen at ANY age: a stale catalog still names the
 * right row for a model, and `[]` before the first fetch is a state the callers
 * already handle (they resolve from the model value alone, as the renderer does
 * when its own catalog lacks the row).
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

/**
 * Ask cli.js for Claude's model list through a throwaway init-only query and
 * record it in the catalog above. Uncached: the TTL-bound read is the caller's
 * ({@link freshClaudeModels}). `onInit` receives the same initialize response
 * (the user's account) for a caller that reports login status from it; its
 * failure is non-fatal, and the remote transport, which has no such side effects,
 * omits it.
 */
export async function queryClaudeModels(
  onInit?: (init: Record<string, unknown>) => void
): Promise<ModelInfo[]> {
  const abort = new AbortController()
  await ensureHostTokenFresh()
  const q = sdkQuery({
    prompt: '',
    options: {
      ...getSdkExecutableOpts(),
      cwd: PERSISTED_SESSIONS_DIR,
      abortController: abort,
      // Init-only: killed right after the initialize response.
      reloadPlugins: false
    }
  })
  try {
    const handle = q as unknown as {
      supportedModels(): Promise<ModelInfo[]>
      initializationResult(): Promise<Record<string, unknown>>
    }
    const models = await handle.supportedModels()
    setCachedClaudeModels(models)
    if (onInit) {
      try {
        onInit(await handle.initializationResult())
      } catch {
        /* non-fatal — per-session init will still report status */
      }
    }
    return models
  } finally {
    abort.abort()
  }
}

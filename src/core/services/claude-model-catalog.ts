import type { ModelInfo } from '../../shared/types'
import { claudePickerModels } from '../../shared/model-capabilities'
import { query as sdkQuery } from '../sdk'
import { ensureHostTokenFresh } from '../sdk/host-token'
import { getSdkExecutableOpts } from './claude-session'
import { migrateSavedClaudeModels } from './claude-model-alias-migration'
import { PERSISTED_SESSIONS_DIR } from './persisted-sessions-dir'
import { cachedClaudeModels, setCachedClaudeModels } from './claude-model-cache'

// The catalog itself (what cli.js last reported, at any age) lives in the leaf module
// `claude-model-cache.ts`, so a reader that this file's own imports reach (the dispatch
// side of `claude-session.ts`) can read it without an import cycle. `queryClaudeModels`
// is the ONE place that fills it, whichever transport (desktop IPC, remote WebSocket,
// claudeui-server) the picker fetch came in on, so every picker fetch feeds the readers
// that are not sessions, headless hosts included.
export {
  cachedClaudeModels,
  freshClaudeModels,
  resetCachedClaudeModels,
  setCachedClaudeModels
} from './claude-model-cache'

/**
 * Ask cli.js for Claude's model list through a throwaway init-only query and
 * record it in the catalog. Uncached: the TTL-bound read is the caller's
 * ({@link freshClaudeModels}). Concrete rows an alias covers are dropped here
 * (`claudePickerModels`), so every transport and the catalog list aliases where
 * one exists, and a non-empty answer
 * moves the host's saved concrete picks to their aliases (ADR-100). `onInit`
 * receives the same initialize response (the user's account) for a caller that
 * reports login status from it; its failure is non-fatal, and the remote
 * transport, which has no such side effects, omits it.
 */
export async function queryClaudeModels(
  onInit?: (init: Record<string, unknown>) => void,
  signal?: AbortSignal
): Promise<ModelInfo[]> {
  const abort = new AbortController()
  // A caller that stops waiting (see ensureClaudeModels) must not leave cli.js running.
  if (signal?.aborted) abort.abort()
  else signal?.addEventListener('abort', () => abort.abort(), { once: true })
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
    const models = claudePickerModels(await handle.supportedModels())
    // An aborted query (a timed-out catalog wait) answers `[]` without asking
    // cli.js; caching that would serve an empty picker for the whole TTL.
    if (!abort.signal.aborted && models.length > 0) {
      setCachedClaudeModels(models)
      migrateSavedClaudeModels(models)
    }
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

/** Longest a run waits for a cold cli.js init: past this the run goes ahead value-only. */
const ENSURE_TIMEOUT_MS = 15_000

let inFlight: Promise<ModelInfo[]> | null = null

/**
 * The catalog for a reader that may be the first thing to need it: a headless host
 * (claudeui-server) boots with no picker ever having fetched, so an automation run
 * would judge `default`/`opus` from the bare value. Returns what is cached (any
 * age) without a query; else populates it through {@link queryClaudeModels} —
 * without `onInit`, so no login/status side effects — bounded by `timeoutMs`.
 * Concurrent callers share ONE query. Never throws: a failure or timeout resolves
 * `[]` (the caller's value-only judgement), the failure reported through `onError`.
 */
export async function ensureClaudeModels(
  onError: (err: unknown) => void,
  timeoutMs = ENSURE_TIMEOUT_MS
): Promise<ModelInfo[]> {
  const have = cachedClaudeModels()
  if (have.length > 0) return have
  if (!inFlight) {
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Claude model catalog query timed out after ${timeoutMs}ms`))
        abort.abort()
      }, timeoutMs)
    })
    const query = queryClaudeModels(undefined, abort.signal)
    // The race loser's rejection (abort kills the child) must not go unhandled.
    query.catch(() => {})
    const flight = Promise.race([query, timeout]).finally(() => {
      clearTimeout(timer)
      if (inFlight === flight) inFlight = null
    })
    inFlight = flight
  }
  try {
    return await inFlight
  } catch (err) {
    onError(err)
    return []
  }
}

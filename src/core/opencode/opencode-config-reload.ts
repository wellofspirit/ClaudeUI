/**
 * After ClaudeUI writes opencode's config (settings, raw editor, providers,
 * tools, agent files — ADR-097 S8): drop ClaudeUI's own caches of what that
 * config decides (model discovery; the sessions' agent lists, via the server
 * manager's config listeners) and reload the running servers' locations
 * (`OpencodeServerManager.reloadConfig`: `POST /api/location/reload` on idle
 * servers, then hosted-tools readiness again).
 *
 * Writes come in bursts (a pane commits several leaves, a provider sync writes
 * then vends), so reloads are debounced and never overlap. Fire-and-forget for
 * the writers: a save never waits on, or fails because of, a reload.
 */
import { opencodeServerManager, type ConfigReloadReport } from './OpencodeServerManager'
import { invalidateOpencodeModelCache } from './model-discovery'
import { logger } from '../services/logger'

export const CONFIG_RELOAD_DEBOUNCE_MS = 300

let timer: ReturnType<typeof setTimeout> | null = null
let running: Promise<ConfigReloadReport | null> = Promise.resolve(null)
let waiters: ((report: ConfigReloadReport | null) => void)[] = []

/** Run one reload now (after any in flight). Exported for the contract suite. */
export function reloadOpencodeConfigNow(): Promise<ConfigReloadReport | null> {
  invalidateOpencodeModelCache()
  running = running
    .catch(() => null)
    .then(() => opencodeServerManager.reloadConfig())
    .catch((err: unknown) => {
      logger.warn('opencode-config-reload', `reload failed: ${String(err)}`)
      return null
    })
  return running
}

/**
 * Schedule a reload for a config write `reason` names (logged). Resolves with
 * the report of the reload that covered it.
 */
export function scheduleOpencodeConfigReload(reason: string): Promise<ConfigReloadReport | null> {
  invalidateOpencodeModelCache()
  logger.info('opencode-config-reload', `config written (${reason}); reload scheduled`)
  if (timer) clearTimeout(timer)
  const settled = new Promise<ConfigReloadReport | null>((resolve) => waiters.push(resolve))
  timer = setTimeout(() => {
    timer = null
    const batch = waiters
    waiters = []
    void reloadOpencodeConfigNow().then((report) => batch.forEach((resolve) => resolve(report)))
  }, CONFIG_RELOAD_DEBOUNCE_MS)
  timer.unref?.()
  return settled
}

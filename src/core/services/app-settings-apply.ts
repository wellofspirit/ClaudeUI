/**
 * The one place core's side effects of the app settings run, from canonical state:
 *   1. the usage poll interval (`usageFetcher`)
 *   2. the token-analytics debounce (`blockUsageService`)
 *   3. the log level and filter (`logger`)
 *   4. the session idle timeout (the session manager)
 *   5. the media-generation settings, which live opencode sessions re-apply (their ruleset offers our tools)
 *
 * A new core effect of a setting goes here and nowhere else. It runs once at boot
 * ({@link startApplyingSettings}) and on every `config:settings-changed`, whatever its
 * source (a client's save, the settings.json watcher): host observers run after the
 * reducer, so canonical already holds the new document. Values come from `appSetting`,
 * so a key nobody saved applies the shared default.
 */
import { addHostObserver } from './sync-host'
import { appSetting } from './app-settings'
import { usageFetcher } from './usage-fetcher'
import { blockUsageService } from './block-usage'
import { logger } from './logger'

export interface SettingsHost {
  setSessionTimeout(ms: number): void
  /** Re-apply the rules of every live opencode session (its media tools follow the media settings). */
  notifyMediaSettingsChanged?(): void
}

let host: SettingsHost | null = null
let lastMediaKey: string | undefined

/** Every core side effect of the app settings, from canonical state. */
export function applySettings(): void {
  usageFetcher.setIntervalSecs(appSetting('usageRefreshSecs'))
  blockUsageService.setDebounceSecs(appSetting('analyticsRefreshSecs'))
  logger.applyFilter(appSetting('logFilter'), appSetting('logLevel'))
  host?.setSessionTimeout(appSetting('sessionTimeoutMins') * 60 * 1000)
  // Media generation: Claude and pi read their toggle at the next spawn; opencode's ruleset is live.
  const mediaKey = JSON.stringify(appSetting('mediaGeneration'))
  const mediaChanged = lastMediaKey !== undefined && lastMediaKey !== mediaKey
  lastMediaKey = mediaKey
  if (mediaChanged) host?.notifyMediaSettingsChanged?.()
}

/** Boot: name the session manager, apply once. Called by `registerSessionIpc` after the canonical seed. */
export function startApplyingSettings(manager: SettingsHost): void {
  host = manager
  applySettings()
}

// Registered at module load (like `context-pressure.ts`), so repeated boots do not stack observers.
addHostObserver((channel) => {
  if (channel === 'config:settings-changed') applySettings()
})

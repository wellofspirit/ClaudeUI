/**
 * Core's one reader of app settings (`~/.claude/ui/settings.json`).
 *
 * It reads canonical sync state, which the boot seed (`sync-seed.ts`), every client
 * save and the settings.json watcher all feed, so it is the in-memory truth whichever
 * source a change came from. A key nobody saved resolves to the shared default
 * (`src/shared/app-settings.ts`), so core cannot run with a default the UI does not show.
 *
 * Imports only `./sync-host` and the shared schema: five services read through here and
 * none may inherit the usage or session graph from it.
 */
import { syncCore } from './sync-host'
import { resolveAppSetting, type AppSettings } from '../../shared/app-settings'

export function appSetting<K extends keyof AppSettings>(key: K): AppSettings[K] {
  return resolveAppSetting(syncCore.getCanonicalState().settings, key)
}

/**
 * The value saved for `key`, as saved, or undefined when none is: no default
 * applied. Only for carrying a saved value through a write unchanged
 * (`saveUiSettings` keeps the host-owned keys, `HOST_OWNED_SETTINGS`), so a key
 * nobody set stays unset and keeps following its default. To act on a setting,
 * read `appSetting`.
 */
export function savedAppSetting(key: keyof AppSettings): unknown {
  const saved: unknown = syncCore.getCanonicalState().settings
  if (typeof saved !== 'object' || saved === null) return undefined
  const value = (saved as Record<string, unknown>)[key]
  return value === null ? undefined : value
}

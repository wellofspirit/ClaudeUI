/**
 * Canonical-freshness seeds — SyncCore phase 4b (Part A of the cutover).
 *
 * Canonical state is built from the event stream, but four snapshot fields have
 * no event to be built from: the sidebar's directory listing (a QUERY), the app
 * settings and session-registry config (FILES every client used to read for
 * itself at boot), and the derived `autoModeDisabledBySettings` gate. Before the
 * cutover that did not matter — the snapshot came from the desktop renderer,
 * which had read all of it during its own hydration. After the cutover, a phone
 * that connects to a freshly-booted desktop gets whatever core knows: without
 * this module that is an empty sidebar, default settings (wrong theme), and empty
 * recents/pins/titles until the first save of the session happens to fire a
 * `config:*` watcher event.
 *
 * So core reads the same sources the renderer reads, at the same moment in boot.
 * These are refreshes of query-shaped state, not domain events (see
 * `SyncCore.setAppState`) — nothing is appended to the ring and nothing is
 * broadcast, because no client's state changes: every client either already read
 * the file itself or will receive it in its next snapshot.
 *
 * Every read is best-effort. A malformed settings file must not take down app
 * boot, and a stale-but-present canonical field is strictly better than a failed
 * start — the pre-4b behavior for all of these was "empty", so a caught error
 * degrades to exactly that.
 */

import { loadSettings, loadSessionConfig, loadSlashCommands } from './ui-config'
import { loadClaudePermissions } from './claude-settings'
import { listDirectories } from './session-history'
import { syncCore } from './sync-host'
import { logger } from './logger'

const LOG_SOURCE = 'sync-seed'

/**
 * Re-read the sidebar's directory listing into canonical state.
 *
 * Called at boot and on exactly the trigger that emits
 * `session:directories-changed` (the debounced `~/.claude/projects` watcher in
 * `ipc/session.ipc.ts`), so the notify every client already acts on and core's
 * own refresh cannot drift apart: a client that refetches after the notify and a
 * client that resyncs afterwards see the same listing.
 */
export async function refreshCanonicalDirectories(): Promise<void> {
  try {
    syncCore.setDirectories(await listDirectories())
  } catch (err) {
    logger.warn(LOG_SOURCE, `directory refresh failed (canonical keeps its previous list)`, err)
  }
}

/**
 * Seed the app-level snapshot fields from disk, once at boot.
 *
 * Mirrors `hydrateConfigFromDisk` in the renderer store, field for field, minus
 * everything that is per-client view state. `sdkSkillNames` is deliberately NOT
 * seeded: the renderer does not populate it at boot either (it only ever arrives
 * on `session:skills`, at engine spawn), so seeding it would make canonical
 * DISAGREE with the replica it is about to become the source for.
 */
export async function seedCanonicalAppState(): Promise<void> {
  try {
    // Raw on-disk settings, exactly as the `config:settings-changed` payload
    // carries them — every client merges its own defaults over the top
    // (`applyRemoteSnapshot`), so shipping the merged copy would bake THIS
    // process's defaults into another client's state.
    syncCore.setAppState({ settings: loadSettings() as Record<string, unknown> })
  } catch (err) {
    logger.warn(LOG_SOURCE, 'settings seed failed', err)
  }

  try {
    const config = loadSessionConfig()
    syncCore.setAppState({
      recentSessionIds: config.recentSessions ?? [],
      pinnedSessionIds: config.pinnedSessions ?? [],
      customTitles: config.customTitles ?? {},
      worktreeInfoMap: config.worktreeInfoMap ?? {},
      hiddenSessions: config.hiddenSessions ?? [],
      hiddenProjects: config.hiddenProjects ?? [],
      sessionEngines: config.sessionEngines ?? {}
    })
  } catch (err) {
    logger.warn(LOG_SOURCE, 'session-config seed failed', err)
  }

  try {
    // ADR-050: the flag a remote client cannot derive, because it cannot read
    // ~/.claude/settings.json. Same expression the renderer store uses.
    const permissions = loadClaudePermissions('user')
    syncCore.setAppState({
      autoModeDisabledBySettings: permissions?.disableAutoMode === 'disable'
    })
  } catch (err) {
    logger.warn(LOG_SOURCE, 'auto-mode gate seed failed', err)
  }

  try {
    // The cached command list the renderer loads with `loadSlashCommands()`.
    // A live engine replaces it wholesale on `session:slash-commands` at spawn.
    syncCore.setAppState({ slashCommands: loadSlashCommands() })
  } catch (err) {
    logger.warn(LOG_SOURCE, 'slash-command seed failed', err)
  }

  await refreshCanonicalDirectories()
}

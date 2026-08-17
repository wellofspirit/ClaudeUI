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
 * Most of these are refreshes of query-shaped state, not domain events (see
 * `SyncCore.setAppState`): nothing is appended to the ring and nothing is
 * broadcast, because no client's state changes — every client either already read
 * the file itself or will receive it in its next snapshot.
 *
 * **`directories` is the exception, and it is a real one.** It is the only field
 * here that also changes while the app RUNS (sessions appear and disappear under
 * `~/.claude/projects`, in opencode's store and in `~/.pi`), so it is the only one
 * clients must be told about live. It rides the replicated
 * `session:directories-changed` channel — which means {@link refreshCanonicalDirectories}
 * DOES append to the ring, including once at boot. Everything else here stays a
 * silent `setAppState`.
 *
 * Every read is best-effort. A malformed settings file must not take down app
 * boot, and a stale-but-present canonical field is strictly better than a failed
 * start — the pre-4b behavior for all of these was "empty", so a caught error
 * degrades to exactly that.
 */

import { loadSettings, loadSessionConfig, loadSlashCommands } from './ui-config'
import { loadClaudePermissions } from './claude-settings'
import { listDirectories } from './session-history'
import { listOpencodeSessionsGlobal } from './opencode-session-list'
import { listPiSessionsGlobal } from './pi-session-list'
import { mergeOpencodeIntoDirectories, mergePiIntoDirectories } from '../../shared/directory-merge'
import { emitEvent } from './sync-host'
import { syncCore } from './sync-host'
import { logger } from './logger'
import type { DirectoryGroup } from '../../shared/types'

const LOG_SOURCE = 'sync-seed'

/**
 * The sidebar's directory tree, ALL THREE engines, in one place.
 *
 * This merge used to live in every client (`Sidebar.tsx`), over three separate
 * queries, writing the result into that client's own `directories`. Canonical
 * meanwhile held `listDirectories()` — Claude only — so the two were structurally
 * different lists, not two views of one: every `sync-full` force-projected the
 * Claude-only subset over the merged one and a reconnecting client's opencode/pi
 * rows disappeared until its next poll. Main owns both list sources, so the merge
 * belongs here and the result is what canonical holds and what the query returns.
 *
 * Claude is the base and its failure is the caller's to handle (see
 * {@link refreshCanonicalDirectories}); opencode and pi are best-effort exactly
 * as they were client-side — not installed, server down, no sessions yet — and
 * degrade to "the list without that engine's rows".
 */
export async function listAllDirectories(): Promise<DirectoryGroup[]> {
  const claude = await listDirectories()
  let merged = claude
  try {
    const opencodeInfos = await listOpencodeSessionsGlobal()
    if (opencodeInfos.length > 0) merged = mergeOpencodeIntoDirectories(merged, opencodeInfos)
  } catch (err) {
    logger.debug(LOG_SOURCE, `opencode session list unavailable: ${String(err)}`)
  }
  try {
    const piInfos = await listPiSessionsGlobal()
    if (piInfos.length > 0) merged = mergePiIntoDirectories(merged, piInfos)
  } catch (err) {
    logger.debug(LOG_SOURCE, `pi session list unavailable: ${String(err)}`)
  }
  return merged
}

/**
 * Smallest gap between two directory emissions. The listing is a full payload on
 * a 5000-entry ring, so the cadence is a real budget, not a micro-optimisation —
 * see {@link refreshCanonicalDirectories}.
 */
const EMIT_MIN_INTERVAL_MS = 5_000

/** A walk is running; a request that arrives during one is coalesced, not queued N deep. */
let refreshInFlight = false
/** A refresh was requested while one was in flight — run exactly one more afterwards. */
let refreshPending = false
/** `Date.now()` of the last emission, for the throttle. */
let lastEmitAtMs = 0
/** The deferred emit a throttled MEMBERSHIP change scheduled, if any. */
let trailingTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Re-read the merged directory listing and REPLICATE it.
 *
 * `session:directories-changed` carries the listing now instead of being a
 * payload-less "refetch" notify, so canonical and every live client get the same
 * value from the same fold — the refetch-per-client round trip (and the window in
 * which each client had a different answer) is gone.
 *
 * ## Why this is rate-limited, and why "changed" is not enough on its own
 *
 * The trigger is the 500 ms-debounced RECURSIVE watcher on `~/.claude/projects`,
 * and every assistant chunk appends to the active session's `.jsonl`. Each append
 * moves that file's mtime, and `SessionInfo.lastActivityAt` is derived from mtime,
 * so a plain "did the listing change?" test says YES for a turn's whole duration.
 * The debounce is trailing-resetting, so the rate is one tick per quiet gap of
 * ≥500 ms rather than two per second — but a long turn still has many such gaps
 * (every tool call, every pause between chunks), and each one would push a FULL
 * merged listing into a 5000-entry ring, evicting the transcript history a
 * reconnecting client actually needs. Three guards, each closing a different hole:
 *
 *  1. **In-flight coalescing.** A refresh requested while a walk is running sets a
 *     flag instead of starting a second walk. Without it, overlapping walks can
 *     finish out of order and emit a STALE listing after a fresh one — the ring is
 *     ordered, so that is not self-correcting.
 *  2. **A {@link EMIT_MIN_INTERVAL_MS} floor between emissions**, which is what
 *     actually bounds the ring cost.
 *  3. **Membership vs. reordering.** A change in WHICH sessions exist (a create, a
 *     delete, a session appearing from another engine) is user-visible and must not
 *     be dropped, so a throttled membership change schedules a trailing refresh. A
 *     change that only moves `lastActivityAt` — the mtime churn above — is dropped
 *     instead, because the 30 s poll re-reads it anyway, so the worst case is the
 *     same staleness the per-client 30 s poll had before the merge moved main-side.
 *
 * A failed CLAUDE listing emits nothing at all: canonical keeps its previous
 * value, which is strictly better than replacing a good sidebar with an empty one.
 */
export async function refreshCanonicalDirectories(): Promise<void> {
  if (refreshInFlight) {
    refreshPending = true
    return
  }
  // A trailing emit is already booked and we are still inside the floor, so this
  // walk could not publish anything the booked one will not. Return BEFORE
  // `listAllDirectories()` — the walk is a disk tree read plus an opencode HTTP
  // call plus a `~/.pi` read, and doing it once per watcher tick only to discard
  // the result is the expensive half of the flood. The FIRST throttled call still
  // walks, which is what classifies the change as membership vs. reorder in the
  // first place.
  if (trailingTimer && Date.now() - lastEmitAtMs < EMIT_MIN_INTERVAL_MS) return
  refreshInFlight = true
  try {
    const directories = await listAllDirectories()
    const current = syncCore.getCanonicalState().directories
    if (sameListing(current, directories)) return

    const membershipChanged = membershipKey(current) !== membershipKey(directories)
    const sinceLastMs = Date.now() - lastEmitAtMs
    if (sinceLastMs >= EMIT_MIN_INTERVAL_MS) {
      lastEmitAtMs = Date.now()
      emitEvent('session:directories-changed', [directories])
      return
    }
    if (membershipChanged) scheduleTrailingRefresh(EMIT_MIN_INTERVAL_MS - sinceLastMs)
    // Reorder-only churn inside the window is dropped on purpose — the poll has it.
  } catch (err) {
    logger.warn(LOG_SOURCE, `directory refresh failed (canonical keeps its previous list)`, err)
  } finally {
    refreshInFlight = false
    if (refreshPending) {
      refreshPending = false
      void refreshCanonicalDirectories()
    }
  }
}

/**
 * Re-run once the throttle window closes. At most ONE timer is outstanding, and
 * it is `unref`'d so a pending sidebar refresh can never hold the process open.
 */
function scheduleTrailingRefresh(delayMs: number): void {
  if (trailingTimer) return
  trailingTimer = setTimeout(
    () => {
      trailingTimer = null
      void refreshCanonicalDirectories()
    },
    Math.max(delayMs, 0)
  )
  trailingTimer.unref?.()
}

/**
 * Structural equality for the listing. `JSON.stringify` rather than a deep walk:
 * the shape is plain data with a stable key order (one builder), and being wrong
 * in the CHEAP direction — a false "changed" — costs one throttled ring entry,
 * not correctness.
 */
function sameListing(a: DirectoryGroup[], b: DirectoryGroup[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * WHAT the sidebar lists — which sessions exist and what each is called —
 * ignoring only how recently each was touched.
 *
 * This is the half of a listing change a user notices and that no later trigger
 * is guaranteed to re-derive within a useful time, so it is the half allowed to
 * defeat the throttle. `title` is in the key for exactly that reason: renaming a
 * session (or a generated title landing) is a visible edit, and treating it as
 * churn would leave every OTHER client showing the old name until the 30 s poll.
 *
 * `lastActivityAt` is the one field deliberately excluded: it is derived from the
 * transcript's mtime, so it moves on every append, which is the churn being
 * bounded.
 */
function membershipKey(groups: DirectoryGroup[]): string {
  return groups
    .map(
      (g) =>
        `${g.projectKey}:${g.sessions
          .map((x) => `${x.sessionId}\u0000${x.title}`)
          .sort()
          .join(',')}`
    )
    .sort()
    .join('|')
}

/**
 * Test seam: forget the throttle + coalescing state.
 *
 * Production refreshes are minutes apart at worst and seconds apart at best, but
 * a test drives several in the same millisecond, where the throttle would defer
 * the second one and make the assertion depend on wall-clock timing.
 */
export function resetDirectoryRefreshStateForTests(): void {
  refreshInFlight = false
  refreshPending = false
  lastEmitAtMs = 0
  if (trailingTimer) clearTimeout(trailingTimer)
  trailingTimer = null
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
    // (the client replica's hydration path), so shipping the merged copy would bake THIS
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

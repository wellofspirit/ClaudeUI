/**
 * Codex session file watcher.
 *
 * Mirrors the structure of session-watcher.ts but targets Codex rollout-*.jsonl
 * files and reloads history via loadCodexHistory (which spawns a short-lived
 * app-server thread/read call) instead of the Claude JSONL parser.
 *
 * NOTE: loadCodexHistory spawns a new app-server process on each debounced
 * change. This is acceptable because:
 *   - Watch is user-initiated (not background polling).
 *   - The debounce window (~300 ms) collapses rapid successive writes into a
 *     single reload, keeping spawn frequency low in practice.
 */

import * as fs from 'node:fs'
import type { BrowserWindow } from 'electron'
import { resolveCodexRolloutPath } from './codexSessions'
import { loadCodexHistory } from './CodexHistory'
import { logger } from '../services/logger'

interface CodexWatchEntry {
  watcher: fs.FSWatcher
  debounceTimer: ReturnType<typeof setTimeout> | null
}

const watchers = new Map<string, CodexWatchEntry>()

/**
 * Start watching the rollout file for the given Codex session.
 *
 * On each debounced file-change event, reloads history via loadCodexHistory
 * (spawns app-server) and sends `session:watch-update` to `win` with the same
 * payload shape as the Claude watcher:
 *   { routingId, messages, taskNotifications: [], statusLine: null }
 *
 * No-ops if already watching this routingId or if the rollout file cannot be
 * resolved.
 */
export async function watchCodexSession(
  routingId: string,
  sessionId: string,
  cwd: string,
  win: BrowserWindow
): Promise<void> {
  if (watchers.has(routingId)) return

  const rolloutPath = await resolveCodexRolloutPath(sessionId)
  if (!rolloutPath) {
    logger.warn(
      'CodexWatcher',
      `watchCodexSession: rollout file not found for session ${sessionId}`
    )
    return
  }

  const entry: CodexWatchEntry = {
    watcher: null!,
    debounceTimer: null
  }

  const watcher = fs.watch(rolloutPath, () => {
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
    entry.debounceTimer = setTimeout(async () => {
      try {
        // NOTE: loadCodexHistory spawns an app-server per change — acceptable
        // for a debounced, user-initiated watch (see module-level comment).
        const { messages } = await loadCodexHistory(sessionId, cwd)
        if (!win.isDestroyed()) {
          win.webContents.send('session:watch-update', {
            routingId,
            messages,
            taskNotifications: [],
            statusLine: null
          })
        }
      } catch (err) {
        logger.warn(
          'CodexWatcher',
          `Parse error during watch update for ${sessionId}`,
          err
        )
      }
    }, 300)
  })

  entry.watcher = watcher
  watchers.set(routingId, entry)
}

/**
 * Stop watching the Codex session for the given routingId.
 * No-ops if not currently watching.
 */
export function unwatchCodexSession(routingId: string): void {
  const entry = watchers.get(routingId)
  if (!entry) return
  if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
  entry.watcher.close()
  watchers.delete(routingId)
}

/** Stop all active Codex watchers — called on app quit. */
export function unwatchAllCodex(): void {
  for (const routingId of Array.from(watchers.keys())) {
    unwatchCodexSession(routingId)
  }
}

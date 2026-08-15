import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { emitEvent } from './sync-host'
import { loadSessionHistory } from './session-history'
import { logger } from './logger'

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')

interface WatchEntry {
  routingId: string
  sessionId: string
  projectKey: string
  cwd: string
  watcher: fs.FSWatcher
  debounceTimer: ReturnType<typeof setTimeout> | null
}

const watchers = new Map<string, WatchEntry>()

/**
 * Start watching a persisted transcript and re-broadcast it on every change.
 *
 * `cwd` is the watched session's working directory, and it has to be an ARGUMENT
 * because it cannot be recovered here: `projectKey` is `cwdToProjectKey`'s output,
 * which replaces every non-alphanumeric character with `-` and is documented as
 * lossy and irreversible. Every caller has it — the sidebar row the user clicked
 * the eye on carries `SessionInfo.cwd`.
 *
 * Why it matters: `session:watch-update` is the ONLY event that introduces a
 * watched session (nothing spawns, so there is no `session:created`), so its
 * reducer branch is the one place `ensured()` still bootstraps an entry — and
 * without a cwd that entry was born with `cwd: ''`. Every cwd-keyed feature then
 * missed it: git status, the folder name in the sidebar and in notifications, the
 * per-cwd terminal group, `deleteProject`'s live-session sweep.
 *
 * Optional so an older client (a cached `/remote` bundle) still watches, just
 * without the cwd — the reducer leaves the existing value alone when it is absent.
 */
export function watchSession(
  routingId: string,
  sessionId: string,
  projectKey: string,
  cwd?: string
): void {
  // Already watching this routingId
  if (watchers.has(routingId)) return

  const filePath = path.join(CLAUDE_PROJECTS_DIR, projectKey, `${sessionId}.jsonl`)
  if (!fs.existsSync(filePath)) return

  const entry: WatchEntry = {
    routingId,
    sessionId,
    projectKey,
    cwd: cwd ?? '',
    watcher: null!,
    debounceTimer: null
  }

  const watcher = fs.watch(filePath, () => {
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
    entry.debounceTimer = setTimeout(async () => {
      try {
        const { messages, taskNotifications, statusLine } = await loadSessionHistory(
          sessionId,
          projectKey
        )
        emitEvent('session:watch-update', [
          {
            routingId,
            messages,
            taskNotifications,
            statusLine,
            // Omitted rather than sent empty when the caller had none: the
            // reducer treats an absent cwd as "leave it alone", and blanking a
            // cwd another event already established would be strictly worse.
            ...(entry.cwd ? { cwd: entry.cwd } : {})
          }
        ])
      } catch (err) {
        logger.warn('SessionWatcher', `Parse error during watch update for ${sessionId}`, err)
      }
    }, 100)
  })

  // fs.watch emits 'error' on Windows when the watched JSONL is deleted/renamed.
  // Without a listener that becomes a process-level uncaughtException, and the
  // dead entry lingers in `watchers` so `watchers.has(routingId)` permanently
  // blocks re-watching (M-CL5). Tear the dead watcher down so a later
  // watchSession() can re-establish it.
  watcher.on('error', (err) => {
    logger.warn('SessionWatcher', `watch error for ${sessionId}; removing dead watcher`, err)
    const cur = watchers.get(routingId)
    if (cur && cur.watcher === watcher) {
      if (cur.debounceTimer) clearTimeout(cur.debounceTimer)
      watchers.delete(routingId)
    }
    try {
      watcher.close()
    } catch {
      /* already dead */
    }
  })

  entry.watcher = watcher
  watchers.set(routingId, entry)
}

export function unwatchSession(routingId: string): void {
  const entry = watchers.get(routingId)
  if (!entry) return
  if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
  entry.watcher.close()
  watchers.delete(routingId)
}

export function unwatchAll(): void {
  watchers.forEach((_, routingId) => unwatchSession(routingId))
}

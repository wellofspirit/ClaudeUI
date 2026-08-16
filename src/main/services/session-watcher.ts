import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { emitEvent, syncCore } from './sync-host'
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
 * Start watching a persisted transcript and announce every change.
 *
 * Since phase 5 S4 the re-read goes to canonical as a SEED
 * (`SyncCore.seedWatchedSession`) and the event is a tiny notify — see the
 * emission below. Before that, every file change put a full transcript on the
 * wire AND in the 5000-entry ring, which a reconnecting client then replayed.
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
        // Still the live watch for this id? The read above is an AWAIT, and a
        // delete can land inside it: `handlers-core.deleteSession` /
        // `deleteProject` unwatch every id they are about to remove BEFORE the
        // cancel, precisely because unlinking the `.jsonl` makes this watcher fire
        // one more time — but that only stops reads that have not STARTED. Without
        // this check, the pair below re-mints the session the delete just removed:
        // the seed bootstraps by design, and the notify's reducer branch is the one
        // that still bootstraps too, so the ghost reaches canonical AND every
        // replica. The identity comparison (not just presence) also covers the
        // watch → unwatch → re-watch cycle, where a stale read must not speak for
        // the new watcher.
        if (watchers.get(routingId) !== entry) return
        // A watched session's file changed, so the transcript did — but it does
        // NOT ride the wire (phase 5 S4). Canonical takes it as a SEED, and the
        // event that follows is a notify every client answers with one refetch
        // through the cold-history path it already has.
        //
        // Order is load-bearing: the seed lands FIRST, so the state a client
        // reads when it reacts to the notify already contains what the notify
        // announces. (A snapshot carries it too, so a fresh client never refetches
        // at all.)
        syncCore.seedWatchedSession(routingId, {
          messages,
          taskNotifications,
          statusLine,
          ...(entry.cwd ? { cwd: entry.cwd } : {})
        })
        emitEvent('session:watch-update', [
          {
            routingId,
            // Where to refetch from. `projectKey` is `cwdToProjectKey`'s lossy,
            // irreversible output and `sessionId` need not equal `routingId`, so
            // neither is derivable by a client — the emitter is the only holder.
            sessionId,
            projectKey,
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

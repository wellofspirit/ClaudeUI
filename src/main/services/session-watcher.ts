import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import type { BrowserWindow } from 'electron'
import { emitEvent } from './sync-host'
import { loadSessionHistory } from './session-history'
import { logger } from './logger'

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')

interface WatchEntry {
  routingId: string
  sessionId: string
  projectKey: string
  watcher: fs.FSWatcher
  debounceTimer: ReturnType<typeof setTimeout> | null
}

const watchers = new Map<string, WatchEntry>()

export function watchSession(
  routingId: string,
  sessionId: string,
  projectKey: string,
  win: BrowserWindow
): void {
  // Already watching this routingId
  if (watchers.has(routingId)) return

  const filePath = path.join(CLAUDE_PROJECTS_DIR, projectKey, `${sessionId}.jsonl`)
  if (!fs.existsSync(filePath)) return

  const entry: WatchEntry = {
    routingId,
    sessionId,
    projectKey,
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
        emitEvent(
          'session:watch-update',
          [{ routingId, messages, taskNotifications, statusLine }],
          'all',
          win
        )
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

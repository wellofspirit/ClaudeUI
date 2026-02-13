import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import type { BrowserWindow } from 'electron'
import { loadSessionHistory } from './session-history'

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
        const { messages, taskNotifications } = await loadSessionHistory(sessionId, projectKey)
        if (!win.isDestroyed()) {
          win.webContents.send('session:watch-update', { routingId, messages, taskNotifications })
        }
      } catch {
        // Ignore parse errors during rapid writes
      }
    }, 100)
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

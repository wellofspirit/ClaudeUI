/**
 * Every open mockup `fs.watch`, process-wide, by the directory it watches (ADR-112, C-S7).
 *
 * The desktop IPC registrar and the remote one each keep their own watcher map, so neither can
 * see the other's. The worktree remover needs both: on Windows an open watch handle on a
 * directory blocks deleting it (and everything above it), so the watches under a worktree about
 * to be removed must be closed first. Each registrar tracks its watcher here and hands over the
 * `close` that also drops it from its own map.
 */

import { pathEqualOrInside } from './worktree-root'

interface TrackedWatcher {
  dirPath: string
  close: () => void
}

const tracked = new Set<TrackedWatcher>()

/** Register an open watch of `dirPath`; returns the function that forgets it again. */
export function trackMockupWatcher(dirPath: string, close: () => void): () => void {
  const entry: TrackedWatcher = { dirPath, close }
  tracked.add(entry)
  return () => {
    tracked.delete(entry)
  }
}

/**
 * Close every tracked watch at or inside `root`. Returns how many were closed.
 *
 * Containment is LEXICAL (`pathEqualOrInside` on the spellings as given): a watch registered
 * through a junction or a short name is not found by the canonical path. That is acceptable
 * because the watchers' own `error` listener drops a watch whose directory goes away anyway.
 */
export function closeMockupWatchersUnder(root: string): number {
  let closed = 0
  for (const entry of [...tracked]) {
    if (!pathEqualOrInside(root, entry.dirPath)) continue
    tracked.delete(entry)
    try {
      entry.close()
    } catch {
      // Already closed: nothing holds the directory.
    }
    closed++
  }
  return closed
}

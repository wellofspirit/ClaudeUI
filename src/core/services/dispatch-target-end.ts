/**
 * Ending an X-Agent for good (ADR-105 §5), as far as the ledger row alone can do it.
 *
 * An X-Agent ends when the user stops it from its card or when its parent session is
 * deleted. The dispatcher does the live part (stop the run, release the process, dismiss
 * its approvals); what is left is state on disk that a row can name: the ledger row goes
 * `stopped` (never resumed again) and the harness's own session is removed where the
 * engine allows it. Claude's transcript and Codex's thread stay (the user's to delete).
 *
 * This is also what the boot sweep uses for a parent that no longer exists, so it lives
 * apart from the dispatcher (which cannot be imported at seed time).
 */
import { rm } from 'node:fs/promises'
import { deleteOpencodeSession, deleteOpencodeSessionWhenServerUp } from './opencode-session-list'
import {
  dispatchLedger,
  dispatchPiSessionDir,
  liveDispatchTargets,
  type DispatchLedgerStore,
  type DispatchTargetRow
} from './dispatch-target-ledger'
import { dispatchScratchpadKey, removePiScratchpad } from '../pi/pi-scratchpad'
import { claudeSessionsWithNoRecord } from './session-meta-prune'
import { logger } from './logger'

const LOG = 'DispatchEnd'

export interface HarnessCleanupDeps {
  /** opencode's `DELETE /api/session/{id}` (best effort, never throws). */
  deleteOpencodeSession?: (sessionId: string) => Promise<void>
  /** Remove a pi X-Agent's session directory. */
  removeDir?: (dir: string) => Promise<void>
  /** Remove a pi X-Agent's scratchpad by its key (link-safe, never throws). */
  removeScratchpad?: (key: string) => void
  /** Where the pi session directory sits under (tests). Defaults to the user's home. */
  home?: string
}

/** pi's process may still be releasing its files on Windows: a few retries. */
const removeTree = (dir: string): Promise<void> =>
  rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })

/**
 * Remove the harness-side state of an X-Agent that has ended: opencode's session, pi's
 * session directory. Best effort — a failure is logged and leaves the state behind (the
 * row says `stopped`, so nothing resumes it). Never throws.
 */
export async function removeHarnessState(
  row: Pick<DispatchTargetRow, 'id' | 'engine' | 'harnessRef'>,
  deps: HarnessCleanupDeps = {}
): Promise<void> {
  try {
    if (row.engine === 'opencode') {
      await (deps.deleteOpencodeSession ?? deleteOpencodeSession)(row.harnessRef)
    } else if (row.engine === 'pi') {
      // The id is a validated ref (`dispatchPiSessionDir` throws on anything else), so the
      // path is always the one directory under ~/.claude/ui/dispatch/pi.
      // Its scratchpad (ADR-110) is session state too: gone with the X-Agent, never before.
      // First: it never throws, and the removal below may.
      ;(deps.removeScratchpad ?? removePiScratchpad)(dispatchScratchpadKey(row.id))
      await (deps.removeDir ?? removeTree)(dispatchPiSessionDir(row.id, deps.home))
    }
  } catch (err) {
    logger.warn(
      LOG,
      `could not remove the ${row.engine} state of X-Agent ${row.id}: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

export interface OrphanSweepDeps extends HarnessCleanupDeps {
  /**
   * Queue an opencode session for deletion once a server is reachable (the sweep runs at
   * boot and must not start one). Defaults to `deleteOpencodeSessionWhenServerUp`.
   */
  deferOpencodeDelete?: (sessionId: string) => void
  rows?: () => DispatchTargetRow[]
  /** Which of these Claude parent ids provably no longer exist. */
  goneParents?: (claudeParentIds: string[]) => string[]
  ledger?: Pick<DispatchLedgerStore, 'update'>
  now?: () => number
}

/**
 * Boot: end the X-Agents whose parent session no longer exists (its deletion happened
 * while the app was closed, in another build, or before X-Agents ended with their parent).
 *
 * Conservative on purpose: a parent is "gone" only when it can be PROVEN. That is
 * possible for a Claude parent alone — no transcript in any project dir and no mention
 * in `sessions.json`, the criteria the session-registry prune already trusts. The other
 * engines keep their sessions in stores that need a running server or a configurable
 * path, so a row under one of them is left alone, as is every row when the Claude store
 * proves nothing. Returns how many rows were ended. Never throws.
 */
export function sweepOrphanDispatchTargets(deps: OrphanSweepDeps = {}): number {
  try {
    const rows = (deps.rows ?? liveDispatchTargets)().filter((r) => r.parentEngine === 'claude')
    if (rows.length === 0) return 0
    const parents = [...new Set(rows.map((r) => r.parentSessionId))]
    const gone = new Set((deps.goneParents ?? claudeSessionsWithNoRecord)(parents))
    const ledger = deps.ledger ?? dispatchLedger
    const now = deps.now ?? Date.now
    let ended = 0
    for (const row of rows) {
      if (!gone.has(row.parentSessionId)) continue
      try {
        ledger.update(row.id, { state: 'stopped', lastActiveAt: now() })
      } catch (err) {
        // Without the row saying so, the harness state must stay: the row would resume it.
        logger.warn(LOG, `could not end X-Agent ${row.id}: ${String(err)}`)
        continue
      }
      // pi's directory goes now; opencode's session waits for a server that is up anyway.
      const defer = deps.deferOpencodeDelete ?? deleteOpencodeSessionWhenServerUp
      void removeHarnessState(row, {
        ...deps,
        deleteOpencodeSession: async (sessionId) => defer(sessionId)
      })
      ended++
    }
    if (ended > 0) logger.info(LOG, `ended ${ended} X-Agent(s) whose parent session is gone`)
    return ended
  } catch (err) {
    logger.warn(LOG, `orphan sweep failed: ${err instanceof Error ? err.message : String(err)}`)
    return 0
  }
}

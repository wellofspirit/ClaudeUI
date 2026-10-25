/**
 * Quit-time worktree removal (ADR-112, C-S1): the quit modal's "Remove all" hands main the
 * worktree paths with `confirmQuit(paths)`, and main deletes them AFTER the services are torn
 * down, so no engine process or shell holds their cwd. (The old flow deleted them from the
 * renderer BEFORE quitting, with live sessions still running in them — on Windows a partial
 * delete, and the quit then raced the delete.)
 *
 * Every dependency is injected so the ordering, the retry ladder and the wiring are unit-testable
 * without an app: {@link createQuitRemovalDeps} builds the real closure from narrow handles, so
 * `main/index.ts` only passes the services in.
 */

import type { WorktreeRemoveResult } from '../../shared/types'
import type { WorktreeRemoveOptions } from '../../core/services/worktree'

export interface QuitRemovalDeps {
  /**
   * End whatever still holds a directory: cancel the live sessions (their engine processes), release
   * the X-Agents (background ones too) and kill the shells. Synchronous kill requests; the OS may
   * take a moment to release the cwd.
   */
  stopHolders(): void
  /** Remove one worktree by path, holders NOT enforced (all are stopped). May throw for a path that is no worktree. */
  remove(worktreePath: string): Promise<WorktreeRemoveResult>
  /** Let killed processes release their cwd before the first delete (ms). Default 750. */
  settleMs?: number
  /** Waits between the attempts at a `partial` / `failed` path (ms): one retry per rung. Default 750, 2000, 5000. */
  retryDelaysMs?: readonly number[]
  /** Test seam. */
  sleep?(ms: number): Promise<void>
  /** One line per path and outcome; the removal itself logs at info already. */
  debug(message: string): void
  warn(message: string): void
}

/** `app:quit-confirm` carries at most this many paths (a crafted array cannot queue unbounded git work). */
export const QUIT_PATHS_MAX = 500

/** The renderer's `confirmQuit(paths)` argument as a bounded list of non-empty strings. */
export function sanitiseQuitPaths(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((p): p is string => typeof p === 'string' && p !== '').slice(0, QUIT_PATHS_MAX)
}

const DEFAULT_SETTLE_MS = 750
/** A killed engine (or a scanner on the freshly emptied directory) can take seconds to let go. */
const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [750, 2000, 5000]

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Deepest paths first, so a worktree nested in another goes before its container. */
function innerFirst(paths: string[]): string[] {
  return [...new Set(paths)].sort((a, b) => b.length - a.length)
}

/**
 * Remove the confirmed worktrees. Never throws: each path is logged with its outcome, and a
 * `partial` / `failed` result is retried after each delay of the ladder (a killed engine may
 * still be exiting). What is still there afterwards shows in the worktree manager next launch.
 */
export async function removeWorktreesAfterTeardown(
  paths: string[],
  deps: QuitRemovalDeps
): Promise<void> {
  if (paths.length === 0) return
  const sleep = deps.sleep ?? wait
  const ladder = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
  try {
    deps.stopHolders()
  } catch (err) {
    deps.warn(`Quit: stopping the worktree holders failed: ${errText(err)}`)
  }
  await sleep(deps.settleMs ?? DEFAULT_SETTLE_MS)

  const attempt = async (worktreePath: string): Promise<WorktreeRemoveResult | null> => {
    try {
      return await deps.remove(worktreePath)
    } catch (err) {
      deps.warn(`Quit: could not remove worktree ${worktreePath}: ${errText(err)}`)
      return null
    }
  }

  for (const worktreePath of innerFirst(paths)) {
    let result = await attempt(worktreePath)
    for (const delay of ladder) {
      if (!result || (result.outcome !== 'partial' && result.outcome !== 'failed')) break
      await sleep(delay)
      result = (await attempt(worktreePath)) ?? result
    }
    if (result) {
      deps.debug(
        `Quit: worktree ${worktreePath}: ${result.outcome}${result.reason ? ` (${result.reason})` : ''}` +
          (result.failures?.length ? `, ${result.failures.length} path(s) left` : '')
      )
    }
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** What {@link createQuitRemovalDeps} needs from the app: narrow handles, no services. */
export interface QuitRemovalWiring {
  /** Every session the manager still holds. */
  forEachSession(visit: (session: { routingId: string; cancel(): void }) => void): void
  killTerminals(): void
  /** Release every live X-Agent target, background runs included. */
  releaseDispatchTargets(): void
  /**
   * `removeWorktreeAtPath` (core): finds the repo and the inventory entry from the path, or, for
   * a worktree whose folder is already gone, from the recorded repo root (third argument).
   */
  removeAtPath(
    worktreePath: string,
    opts: WorktreeRemoveOptions,
    recordedGitRoot?: string
  ): Promise<WorktreeRemoveResult>
  /** The repo root ClaudeUI recorded when it created the worktree at this path, if any. */
  recordedGitRoot?(worktreePath: string): string | undefined
  /** Close the file watchers under a path before its first delete. */
  beforeWalk(worktreePath: string): void
  /**
   * Drop the recorded worktree entries of fully removed paths (a partial one keeps its record, so
   * the retry ladder still passes `createdOnly`). FORGET ONLY at quit: anything that
   * re-lists directories would spawn a fresh engine process after the teardown.
   */
  forgetEntries(worktreePaths: string[]): void
  /** C-S11: only worktrees ClaudeUI created are removed here, whatever the renderer sent. */
  createdOnly(worktreePath: string): boolean
  debug(message: string): void
  warn(message: string): void
  settleMs?: number
  retryDelaysMs?: readonly number[]
  sleep?(ms: number): Promise<void>
}

export function createQuitRemovalDeps(wiring: QuitRemovalWiring): QuitRemovalDeps {
  return {
    stopHolders: () => {
      // Each step on its own: one failing must not leave the others' processes holding the cwd.
      wiring.forEachSession((session) => {
        try {
          session.cancel()
        } catch (err) {
          // The engine's server may already be gone (disposed by the teardown): fine.
          wiring.debug(`Quit: cancelling session ${session.routingId} failed: ${errText(err)}`)
        }
      })
      for (const [what, stop] of [
        ['releasing the X-Agents', wiring.releaseDispatchTargets],
        ['killing the terminals', wiring.killTerminals]
      ] as const) {
        try {
          stop()
        } catch (err) {
          wiring.warn(`Quit: ${what} failed: ${errText(err)}`)
        }
      }
    },
    // Everything that held a directory is stopped: holders are NOT enforced. The entry is found
    // from the PATH against the inventory (not by spelling), like the legacy removal.
    remove: (worktreePath) =>
      wiring.removeAtPath(
        worktreePath,
        {
          enforceHolders: false,
          beforeWalk: wiring.beforeWalk,
          forgetEntries: wiring.forgetEntries,
          createdOnly: wiring.createdOnly
        },
        wiring.recordedGitRoot?.(worktreePath)
      ),
    settleMs: wiring.settleMs,
    retryDelaysMs: wiring.retryDelaysMs,
    sleep: wiring.sleep,
    debug: wiring.debug,
    warn: wiring.warn
  }
}

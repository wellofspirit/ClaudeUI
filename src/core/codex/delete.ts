import { homedir } from 'node:os'
import { CodexService } from './CodexService'
import type { CodexClientOptions } from './CodexAppServerClient'
import { locateCodexBinary } from './codex-locate'
import { discoverCodexForks, type CodexReadTuning } from './history'
import { logger } from '../services/logger'
import {
  deleteCodexFork,
  deleteCodexSessionOverrides,
  deleteSessionMeta,
  listCodexForks,
  type CodexFork
} from '../services/db'
import type { CodexDeleteNode, CodexDeletePlan } from '../../shared/codex-types'

/**
 * Deleting a Codex session, which is never one thread on its own.
 *
 * ## What the binary enforces (pinned by `codex-lifecycle.integration.test.ts`)
 *
 * `thread/delete` is refused while a fork still references the thread's
 * history: the local store scans the rollout reference index and answers
 * `cannot delete thread <id>: forked history still references it`
 * (`thread-store/src/local/delete_thread.rs::ensure_no_external_references`).
 * ARCHIVING the fork does not lift it — only deleting the fork does. So a
 * branched session is a SUBTREE delete, leaf-first, and that is the whole
 * shape of this module.
 *
 * It is also refused while any process holds the thread: the store takes a
 * per-thread lock FILE (`$CODEX_HOME/thread-writer-locks/<id>.lock`,
 * `writer_lock.rs`) and a second app-server gets
 * `thread <id> already has an active writer`. The lock is released when the
 * holding process exits, not when we ask it to — see {@link deleteCodexSubtree}.
 *
 * Both refusals, and "no such thread", collapse to the SAME JSON-RPC `-32600`,
 * and the client keeps native payloads out of core, so a caller cannot tell
 * them apart. Every decision here is made from what ClaudeUI itself knows
 * (the fork registry, the session manager), never from the refusal.
 *
 * NATIVE CHILDREN ARE NOT IN THE PLAN. A spawned collab agent is a thread with
 * a `parentThreadId`, and `thread/delete` already removes the whole spawn
 * subtree in one call: the app-server expands the id through
 * `state_db_spawn_subtree_thread_ids` and deletes descendants before the root
 * (`app-server/src/request_processors/thread_delete.rs`). The spawn graph is
 * in the shared state DB, so a delete issued from a different process sees the
 * children too. Only FORKS have to be walked here.
 */

const LOG_SOURCE = 'codex-delete'

type CodexDeleteOptions = Pick<CodexClientOptions, 'cwd' | 'env'>

/** Everything a node needs beyond its id, looked up per thread by the caller. */
export interface CodexNodeFacts {
  /** The sidebar title, when the listing carries one. */
  title: string | null
  /** Whether a live ClaudeUI session still holds the thread. */
  live: boolean
}

/**
 * The subtree of `rootThreadId` in the fork registry, leaf-first.
 *
 * Pure in its inputs so the ordering can be tested without a database or a
 * binary. `forks` is `listCodexForks()` — every branch ClaudeUI has ever
 * minted, each with the thread it was cut from — and the subtree is every
 * transitive fork of the root, forks of forks included.
 *
 * Ordering is DEPTH DESCENDING, stable within a depth by registry order, so
 * the root is always last and no node is ever deleted before one that
 * references it. A registry that somehow contains a cycle (`forkedFromId`
 * chains are written once and never rewritten, so it should not) cannot loop
 * this: a thread already in the plan is never expanded twice.
 */
export function buildCodexDeletePlan(
  rootThreadId: string,
  forks: CodexFork[],
  facts: (threadId: string) => CodexNodeFacts
): CodexDeletePlan {
  const children = new Map<string, string[]>()
  for (const fork of forks) {
    if (!fork.forkedFromId || fork.forkedFromId === fork.threadId) continue
    const siblings = children.get(fork.forkedFromId)
    if (siblings) siblings.push(fork.threadId)
    else children.set(fork.forkedFromId, [fork.threadId])
  }
  const nodes: CodexDeleteNode[] = []
  const seen = new Set<string>([rootThreadId])
  for (let queue = [rootThreadId], depth = 0; queue.length; depth++) {
    const next: string[] = []
    for (const threadId of queue) {
      nodes.push({ threadId, depth, ...facts(threadId) })
      for (const child of children.get(threadId) ?? [])
        if (!seen.has(child)) {
          seen.add(child)
          next.push(child)
        }
    }
    queue = next
  }
  return {
    nodes,
    order: [...nodes].sort((a, b) => b.depth - a.depth).map((node) => node.threadId)
  }
}

/**
 * The plan for one Codex session: the registry, plus the branches the registry
 * has forgotten.
 *
 * The registry is ClaudeUI's own record of every `thread/fork` it minted (db
 * v16) and the native listing never returns a fork, so the registry is normally
 * the only way to learn a branch exists. Normally is not enough here: a branch
 * missing from it makes the native delete refuse the ROOT, with a `-32600` that
 * says nothing about why (it happened — the first adoption sweep believed a
 * transient refusal and registered nothing). So a delete also pays for one
 * bounded sweep of the codex ids only `session_meta` knows about, and registers
 * what it finds — see `history.discoverCodexForks`. The confirmation modal asks
 * for its plan through this same function, so what the user agrees to and what
 * the walk does are computed the same way.
 */
export async function codexDeletePlan(
  rootThreadId: string,
  facts: (threadId: string) => CodexNodeFacts,
  options: CodexDeleteWalkOptions = {}
): Promise<CodexDeletePlan> {
  const forks = await discoverCodexForks(
    { cwd: options.cwd ?? homedir(), env: options.env },
    options
  ).catch((error) => {
    // A sweep that cannot run must not take the delete with it: the registry on
    // its own is what this always used, and it is right in every case but the
    // one this sweep exists for.
    logger.warn(
      LOG_SOURCE,
      `delete plan could not sweep for unregistered branches: ${error instanceof Error ? error.message : String(error)}`
    )
    return listCodexForks()
  })
  return buildCodexDeletePlan(rootThreadId, forks, facts)
}

/**
 * How long the walk keeps retrying a refused delete of a thread it just
 * stopped, and how long it waits between tries.
 *
 * A ClaudeUI session's `cancel()` is synchronous — it flips the session closed
 * and emits `disconnected` in the same tick — but what the native delete needs
 * is the app-server PROCESS to be gone, because the writer lock is an OS file
 * lock held by that process. `CodexAppServerClient.terminate` sends `SIGTERM`
 * and escalates to `SIGKILL` after `killGraceMs` (1 s), so the lock can outlive
 * the stop by about that long. The window below covers the escalation with
 * margin; without it, deleting a live branch is a coin flip.
 *
 * This retry is for STOPPED nodes ONLY. A thread held by something ClaudeUI did
 * not start (another ClaudeUI window, a terminal `codex`) is refused on the
 * first try and stays refused, and retrying it would only delay the honest
 * error.
 */
export const STOPPED_HOLDER_RETRY_MS = 3_000
export const STOPPED_HOLDER_RETRY_INTERVAL_MS = 500

/**
 * Refuse early when there is no app-server to ask.
 *
 * `locateCodexBinary`, not `codexBinaryAvailable`: the latter also demands the
 * code-mode host beside the binary, which a MODEL TURN needs and a delete does
 * not. Without this the first refusal message would read "Codex refused to
 * delete X (Codex transport: binary-unavailable)", which blames the binary for
 * not being there.
 */
function assertCodexInstalled(): void {
  if (!locateCodexBinary()) throw new Error('Codex is not installed')
}

/** Forget everything ClaudeUI stored about a thread the binary has deleted. */
function forgetThread(threadId: string): void {
  deleteCodexFork(threadId)
  deleteCodexSessionOverrides(threadId)
  deleteSessionMeta(threadId)
}

/**
 * Delete ONE thread natively and forget ClaudeUI's rows for it.
 *
 * The rows are removed only after the binary has confirmed the delete: a
 * refusal must leave the branch findable, or the sidebar would lose a session
 * that still exists.
 */
export async function deleteCodexThread(
  threadId: string,
  options: CodexDeleteOptions = { cwd: homedir() }
): Promise<void> {
  assertCodexInstalled()
  const service = new CodexService(options)
  try {
    await service.deleteThread(threadId)
  } finally {
    service.dispose()
  }
  forgetThread(threadId)
}

/** The side effects the walk does not own — handlers-core's, passed in. */
export interface CodexDeleteHooks {
  /** Stop watching a transcript that is about to stop existing. */
  unwatch: (threadId: string) => void
  /** Stop a live session holding the thread (releases the native writer lock). */
  stop: (threadId: string) => void
  /** Replicate the removal, so every client drops the row. */
  removeSession: (threadId: string) => void
}

/**
 * Test seams: the native service and the clock. Neither is injected in
 * production. `service`, `sleep` and `confirmDelayMs` are also the read tuning
 * {@link codexDeletePlan} hands to the fork sweep, so one options object
 * describes the whole delete.
 */
export interface CodexDeleteWalkOptions extends Partial<CodexDeleteOptions>, CodexReadTuning {
  retryWindowMs?: number
  retryIntervalMs?: number
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** The name to put in front of a user: the sidebar title, else the raw thread id. */
function label(node: CodexDeleteNode): string {
  return node.title ? `"${node.title}"` : node.threadId
}

/**
 * Walk a delete plan leaf-first, stopping non-destructively at the first
 * refusal.
 *
 * Per node, in this order: unwatch (a watcher must not fire for a file that is
 * disappearing), stop the holder if one is live, replicate the removal, then
 * ask the binary. A refusal ends the walk THERE — nothing after it is touched,
 * everything before it is already gone — and the thrown error says which node
 * refused and how much of the plan landed. The caller refreshes the sidebar
 * listing afterwards, which puts back the rows that survived: the fork registry
 * still has them, so the refused branch reappears rather than silently
 * vanishing from every client.
 *
 * ONE service for the whole subtree: each `CodexService` read spawns an
 * app-server process, and a three-node plan does not need three of them.
 */
export async function deleteCodexSubtree(
  plan: CodexDeletePlan,
  hooks: CodexDeleteHooks,
  options: CodexDeleteWalkOptions = {}
): Promise<void> {
  if (!plan.order.length) return
  if (!options.service) assertCodexInstalled()
  const sleep = options.sleep ?? wait
  const retryWindow = options.retryWindowMs ?? STOPPED_HOLDER_RETRY_MS
  const interval = options.retryIntervalMs ?? STOPPED_HOLDER_RETRY_INTERVAL_MS
  const byId = new Map(plan.nodes.map((node) => [node.threadId, node]))
  const service =
    options.service ?? new CodexService({ cwd: options.cwd ?? homedir(), env: options.env })
  const deleted: string[] = []
  try {
    for (const threadId of plan.order) {
      const node = byId.get(threadId)
      if (!node) continue
      hooks.unwatch(threadId)
      if (node.live) hooks.stop(threadId)
      hooks.removeSession(threadId)
      // Only a thread WE just stopped gets a second chance; see the constants.
      const deadline = node.live ? Date.now() + retryWindow : 0
      for (;;) {
        try {
          await service.deleteThread(threadId)
          break
        } catch (error) {
          if (Date.now() >= deadline) {
            const reason = error instanceof Error ? error.message : String(error)
            throw new Error(
              `Codex refused to delete ${label(node)} (${reason}). ` +
                `${deleted.length} of ${plan.order.length} threads were deleted; ` +
                `${plan.order.length - deleted.length} remain.`
            )
          }
          await sleep(interval)
        }
      }
      forgetThread(threadId)
      deleted.push(threadId)
    }
  } finally {
    if (!options.service) service.dispose()
  }
}

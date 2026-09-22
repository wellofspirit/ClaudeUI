import { homedir } from 'node:os'
import { CodexService } from './CodexService'
import type { CodexClientOptions } from './CodexAppServerClient'
import { locateCodexBinary } from './codex-locate'
import type { CodexReadTuning } from './history'
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
 * It is also refused while ANOTHER process holds the thread: the store takes a
 * per-thread lock FILE (`$CODEX_HOME/thread-writer-locks/<id>.lock`,
 * `writer_lock.rs`) and a second app-server gets
 * `thread <id> already has an active writer`. The HOLDER may delete its own
 * loaded thread, idle or mid-turn (ADR-069 probe P5), so since ADR-069 §3 every
 * delete is issued on the host that has the thread loaded — which is the host
 * the session was running on, whatever account it follows. That is what retired
 * the stop-then-wait this module used to need: stopping a session no longer ends
 * a process, and there is no lock to wait out.
 *
 * Both refusals, and "no such thread", collapse to the SAME JSON-RPC `-32600`,
 * and the client keeps native payloads out of core, so a caller cannot tell
 * them apart. Every decision here is made from what ClaudeUI itself knows
 * (the lineage cache, the session manager), never from the refusal.
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
 * The subtree of `rootThreadId` in the lineage cache, leaf-first.
 *
 * Pure in its inputs so the ordering can be tested without a database or a
 * binary. `forks` is `listCodexForks()` — every cached BRANCH, each with the
 * thread it was cut from — and the subtree is every transitive fork of the
 * root, forks of forks included.
 *
 * Ordering is DEPTH DESCENDING, stable within a depth by cache order, so the
 * root is always last and no node is ever deleted before one that references
 * it. A cache that somehow contains a cycle cannot loop this: a thread already
 * in the plan is never expanded twice.
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
 * The plan for one Codex session, read from the LINEAGE CACHE alone.
 *
 * This used to sweep: every codex `session_meta` id the fork registry did not
 * name got a `thread/read`, four at a time, on every plan — including the one
 * the confirmation modal opens. It had to, because a root never earned a
 * registry row, so the candidate set never shrank (~0.9 s with 25 sessions on
 * 2026-09-13) and a branch the registry had forgotten made the native delete
 * refuse the ROOT with a `-32600` that says nothing about why.
 *
 * The cache (db v17) records ROOTS too, so "have I asked about this thread?"
 * is now answerable without asking the binary: the launch scan fills it in the
 * background, `listCodexSessions` adds anything that appears while the app
 * runs, and a plan is a synchronous read of what they learned. The one case
 * that cost the sweep its keep — a branch the cache does not know about — is
 * handled where the evidence actually appears, in {@link deleteCodexSubtree}:
 * a refused node triggers ONE full rescan, and the walk continues if that
 * changed the plan.
 *
 * The confirmation modal asks for its plan through this same function, so what
 * the user agrees to and what the walk does are computed the same way.
 */
export function codexDeletePlan(
  rootThreadId: string,
  facts: (threadId: string) => CodexNodeFacts
): CodexDeletePlan {
  return buildCodexDeletePlan(rootThreadId, listCodexForks(), facts)
}

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
  const service = new CodexService({ ...options, identity: { accountId: null }, label: 'delete' })
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
 * Test seams: the native service and the clock, plus the one production knob —
 * {@link CodexDeleteWalkOptions.replan}. Neither the service nor the clock is
 * injected in production.
 */
export interface CodexDeleteWalkOptions
  extends
    Partial<CodexDeleteOptions>,
    // `service` ALONE of the read tuning: the walk has no clock left to fake
    // since the delete goes to the thread's holder and is accepted or refused on
    // the first try (ADR-069 §3).
    Pick<CodexReadTuning, 'service'> {
  /**
   * Re-learn lineage and rebuild the plan after a refusal, ONCE per walk.
   *
   * The caller owns it because the caller owns the plan's inputs: the root id,
   * the liveness/title lookup, and (for a project sweep) the set of threads
   * earlier walks already removed. `handlers-core` passes a closure that runs
   * the full lineage scan and rebuilds; omit it and a refusal fails as it
   * always did.
   */
  replan?: () => Promise<CodexDeletePlan>
}

/** The name to put in front of a user: the sidebar title, else the raw thread id. */
function label(node: CodexDeleteNode): string {
  return node.title ? `"${node.title}"` : node.threadId
}

/**
 * Walk a delete plan leaf-first, stopping non-destructively at the first
 * refusal the rescan cannot explain.
 *
 * Per node, in this order: unwatch (a watcher must not fire for a file that is
 * disappearing), stop the holder if one is live, replicate the removal, then
 * ask the binary. Stopping is still first, and it is still what makes the
 * delete legal — but only because it settles the session's cards and detaches
 * it, not because it frees a lock: the thread stays loaded on the host, and the
 * delete goes to that same host, which may delete what it holds (probe P5). A
 * refusal ends the walk THERE — nothing after it is touched,
 * everything before it is already gone — and the thrown error says which node
 * refused and how much of the plan landed. The caller refreshes the sidebar
 * listing afterwards, which puts back the rows that survived: the lineage cache
 * still has them, so the refused branch reappears rather than silently
 * vanishing from every client.
 *
 * ## The one rescan
 *
 * Every refusal is the same `-32600`, so the walk cannot ask the binary WHY.
 * The one cause it can do something about is a branch the lineage cache does
 * not know — a fork minted by another client, or by a build that predates the
 * cache — which makes the binary refuse the node that branch still references.
 * So the first refusal of a walk buys ONE {@link CodexDeleteWalkOptions.replan}:
 * a full lineage rescan, then a rebuilt plan.
 *
 * If that plan differs from what is left of this one, the walk CONTINUES on it
 * rather than restarting: the nodes already deleted are skipped (their rows are
 * forgotten, so a rebuilt plan does not name them anyway) and the newly
 * discovered branches sort below the refused node, which is exactly where the
 * leaf-first order needs them. If the plan is unchanged, the refusal was
 * something else — a holder ClaudeUI cannot stop, a thread that is already gone
 * — and the original error is thrown as it always was.
 *
 * ONE service for the whole subtree. Since ADR-069 the reads share the home's
 * host rather than a process each, so this is no longer a spawn budget — it is
 * still one service so the whole walk speaks to one lease per node. Which HOST
 * answers is decided per thread by the registry: the one that has it loaded,
 * else the active account's.
 *
 * Returns the threads it actually deleted, in the order it deleted them — which
 * a rescan can make LONGER than the plan it was handed, and which a project
 * sweep needs so it does not plan a second delete of a thread this walk already
 * removed (that would be refused as "no such thread", indistinguishable from a
 * real refusal).
 */
export async function deleteCodexSubtree(
  plan: CodexDeletePlan,
  hooks: CodexDeleteHooks,
  options: CodexDeleteWalkOptions = {}
): Promise<string[]> {
  if (!plan.order.length) return []
  if (!options.service) assertCodexInstalled()
  const service =
    options.service ??
    new CodexService({
      cwd: options.cwd ?? homedir(),
      env: options.env,
      identity: { accountId: null },
      label: 'delete'
    })
  const deleted = new Set<string>()
  const remaining = (candidate: CodexDeletePlan): string[] =>
    candidate.order.filter((threadId) => !deleted.has(threadId))
  let current = plan
  let byId = new Map(plan.nodes.map((node) => [node.threadId, node]))
  let rescanned = false
  try {
    for (let index = 0; index < current.order.length; index++) {
      const threadId = current.order[index]
      if (deleted.has(threadId)) continue
      const node = byId.get(threadId)
      if (!node) continue
      hooks.unwatch(threadId)
      if (node.live) hooks.stop(threadId)
      hooks.removeSession(threadId)
      let refusal: Error | null = null
      try {
        // No retry, and none to write: the delete is issued on the host that
        // holds the thread, and a holder's own delete is accepted immediately —
        // idle or mid-turn (ADR-069 probe P5). Before the host model this had to
        // outwait a dying process's writer lock for up to three seconds.
        await service.deleteThread(threadId)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        refusal = new Error(
          `Codex refused to delete ${label(node)} (${reason}). ` +
            `${deleted.size} of ${current.order.length} threads were deleted; ` +
            `${current.order.length - deleted.size} remain.`
        )
      }
      if (refusal) {
        const rebuilt =
          rescanned || !options.replan ? null : await options.replan().catch(() => null)
        rescanned = true
        if (!rebuilt || remaining(rebuilt).join('\u0000') === remaining(current).join('\u0000'))
          throw refusal
        logger.warn(
          LOG_SOURCE,
          `${label(node)} was refused; a lineage rescan found ${remaining(rebuilt).length - remaining(current).length} more thread(s). Continuing.`
        )
        current = rebuilt
        byId = new Map(rebuilt.nodes.map((entry) => [entry.threadId, entry]))
        index = -1
        continue
      }
      forgetThread(threadId)
      deleted.add(threadId)
    }
    return [...deleted]
  } finally {
    if (!options.service) service.dispose()
  }
}

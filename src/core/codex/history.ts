import { homedir } from 'node:os'
import { CodexService } from './CodexService'
import type { CodexClientOptions } from './CodexAppServerClient'
import { codexBinaryAvailable, locateCodexBinary } from './codex-locate'
import { codexItemId, mapCodexItem, subAgentActivityResult } from './event-mapper'
import { assertCodexProvider } from './model-selection'
import type { SessionInfo, ChatMessage, ForkAnchorResult } from '../../shared/types'
import type { SessionHistoryResult } from '../services/session-history'
import { cwdToProjectKey } from '../../shared/project-key'
import {
  setSessionMeta,
  getSessionMeta,
  allSessionMeta,
  ensureCodexSessionOverrides,
  listCodexForks,
  listCodexLineage,
  recordCodexLineage
} from '../services/db'
import { CodexTransportError } from './CodexAppServerClient'
import { logger } from '../services/logger'
import type { Thread } from './protocol/v2/Thread'

const LOG_SOURCE = 'codex-history'

type CodexReadOptions = Pick<CodexClientOptions, 'cwd' | 'env'>

/** How many metadata-only reads the fork pass keeps on the wire at once. */
const FORK_READ_CONCURRENCY = 4

/**
 * The JSON-RPC code the app-server answers with for an id it cannot resolve.
 *
 * `thread/read` answers `-32600` (Invalid Request) for every id it cannot
 * resolve at all — "thread not loaded: <id>" when neither the rollout nor a
 * live thread exists, "invalid thread id: <err>" when it does not even parse
 * (`app-server/src/request_processors/thread_processor.rs` `read_thread_view` /
 * `thread_read_response_inner`, both through `error_code.rs::invalid_request`).
 * Everything that is merely BROKEN — an IO failure reading the rollout, a store
 * fault — becomes `-32603` (Internal), and a transport fault never reaches a
 * JSON-RPC code at all.
 *
 * **It is NOT proof that the thread is gone, and one read is never enough.**
 * Observed on a real machine (2026-09-13): a fresh app-server answered `-32600`
 * for two forks that read back fine moments later, and the adoption sweep
 * believed it — it marked itself done with zero forks registered and both
 * branches fell out of the sidebar and out of every delete plan. The lookup
 * behind the answer is not a single index probe: `find_thread_path_by_id_str`
 * (`rollout/src/list.rs`) tries the state DB, then a filename scan, then a
 * `file_search::run` over the sessions tree, and "not found" from any of that
 * is reported as the same refusal as "no such thread". So a refusal is only
 * believed when a SECOND, independent read answers it again — see
 * {@link readThreads}.
 *
 * The client collapses a JSON-RPC error to `rpc-error-<code>` and drops the
 * native message (CodexService keeps payloads out of core), so the code is all
 * there is to match on.
 */
const THREAD_UNRESOLVABLE = 'rpc-error--32600'

/**
 * How long to wait before asking a second time whether a refused id is really
 * gone. Long enough to be a genuinely separate attempt (the first one's client
 * has been released by then, so the confirmation runs on its own process),
 * short enough that a sidebar refresh does not visibly stall.
 */
export const REFUSAL_CONFIRM_MS = 750

/** Test seams for the read path: a pre-made service, and the clock. */
export interface CodexReadTuning {
  /** Use this service instead of spawning one. Never disposed by the callee. */
  service?: CodexService
  confirmDelayMs?: number
  sleep?: (ms: number) => Promise<void>
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** One metadata-only read's outcome: the thread, or why there is none. */
type ForkRead =
  { threadId: string; thread: Thread } | { threadId: string; thread: null; unresolvable: boolean }

/** One `thread/read`, never throwing: the thread, or the reason there is none. */
async function readOne(service: CodexService, threadId: string): Promise<ForkRead> {
  try {
    const { thread } = await service.readThread({ threadId, includeTurns: false })
    return { threadId, thread }
  } catch (error) {
    return {
      threadId,
      thread: null,
      unresolvable: error instanceof CodexTransportError && error.code === THREAD_UNRESOLVABLE
    }
  }
}

/**
 * Read `ids` metadata-only, {@link FORK_READ_CONCURRENCY} at a time, in the
 * order they were given. One failure never fails the batch — it is reported.
 *
 * Every id the first pass refused is then read AGAIN, one at a time, after a
 * pause: only a refusal that survives that counts as "gone for good", and every
 * classification is logged so the next such event is diagnosable. The second
 * pass is sequential and unhurried on purpose — the first pass is four
 * concurrent reads against a just-spawned process, which is the exact shape
 * that produced the false refusals this rule exists for.
 */
async function readThreads(
  service: CodexService,
  ids: string[],
  tuning: CodexReadTuning = {}
): Promise<ForkRead[]> {
  const results = new Array<ForkRead>(ids.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(FORK_READ_CONCURRENCY, ids.length) }, async () => {
      for (let index = next++; index < ids.length; index = next++)
        results[index] = await readOne(service, ids[index])
    })
  )
  const suspects = results.flatMap((read, index) =>
    read.thread === null && read.unresolvable ? [index] : []
  )
  if (!suspects.length) return results
  await (tuning.sleep ?? wait)(tuning.confirmDelayMs ?? REFUSAL_CONFIRM_MS)
  for (const index of suspects) {
    const confirmed = await readOne(service, ids[index])
    results[index] = confirmed
    if (confirmed.thread)
      logger.warn(
        LOG_SOURCE,
        `thread/read refused ${ids[index]} transiently; the re-read resolved it. Not pruned.`
      )
    else if (confirmed.unresolvable)
      logger.warn(LOG_SOURCE, `thread/read refused ${ids[index]} twice; treating it as deleted.`)
  }
  return results
}

/** A thread that belongs in the sidebar — a root, not a native child or a scratch thread. */
function listable(thread: Thread): boolean {
  return !thread.parentThreadId && !thread.ephemeral
}

/**
 * WHICH ids one pass of the lineage scan reads.
 *
 *  - `new` — listed threads the cache has never heard of. The cheapest pass and
 *    the only one a sidebar refresh may run: an ACTIVE thread's `updatedAt`
 *    moves on every turn, so a "changed" pass on the 30 s poll would re-read
 *    the session the user is talking to, forever.
 *  - `changed` — the launch pass. `new`, plus any listed thread whose
 *    `updatedAt` no longer matches the one its lineage was read at (a thread
 *    can be forked by another client between launches), plus every codex
 *    `session_meta` id the cache does not know and the listing does not carry
 *    (a branch that predates the cache, or one that has never run a turn).
 *  - `all` — every id ClaudeUI knows about, cache row or not, `verified_at`
 *    ignored. Paid exactly once, by a delete the binary refused: at that point
 *    the cache is provably missing something and one full re-read is cheaper
 *    than a wrong answer.
 */
export type CodexScanMode = 'new' | 'changed' | 'all'

/** The codex ids `session_meta` carries, whatever the native listing says. */
function codexSessionMetaIds(): string[] {
  return Object.entries(allSessionMeta())
    .filter(([, meta]) => meta.engineId === 'codex')
    .map(([id]) => id)
}

/** What one lineage scan did: how many threads it read, and how much it learned. */
export interface CodexLineageScan {
  read: number
  learned: number
}

/**
 * Learn the lineage of every thread this pass has to read, and CACHE THE ANSWER
 * either way.
 *
 * The row is the whole point: v16 recorded branches only, so a root was a
 * candidate for a metadata read forever and the delete sweep never shrank. Here
 * a root earns `(null, updatedAt)`, a branch earns `(source, updatedAt)`, and an
 * id the binary refuses TWICE earns `(null, null)` — a tombstone, which is not a
 * branch, is not a sidebar row, and is not read again unless the native listing
 * carries the id once more. Only a non-definitive failure (a transport fault, a
 * single unconfirmed refusal) leaves the row alone, so the next pass retries it.
 *
 * Returns how many threads were read and how many rows changed the answer the
 * cache would have given — the caller uses the latter to decide whether the
 * sidebar needs re-reading.
 */
async function refreshCodexLineage(
  service: CodexService,
  listed: Thread[],
  mode: CodexScanMode,
  tuning: CodexReadTuning
): Promise<CodexLineageScan> {
  const cache = new Map(listCodexLineage().map((row) => [row.threadId, row]))
  const listedById = new Map(listed.filter(listable).map((thread) => [thread.id, thread]))
  const candidates = new Set<string>()
  for (const [id, thread] of listedById)
    if (
      mode === 'all' ||
      !cache.has(id) ||
      (mode === 'changed' && cache.get(id)!.verifiedAt !== thread.updatedAt)
    )
      candidates.add(id)
  if (mode !== 'new') {
    for (const id of codexSessionMetaIds())
      if (mode === 'all' || (!cache.has(id) && !listedById.has(id))) candidates.add(id)
    if (mode === 'all') for (const id of cache.keys()) candidates.add(id)
  }
  const reads = await readThreads(service, [...candidates], tuning)
  let learned = 0
  for (const read of reads) {
    const known = cache.get(read.threadId)
    if (read.thread) {
      // A thread that claims itself as its own source is a lineage nothing can
      // walk, so it is cached as a root.
      const source =
        read.thread.forkedFromId && read.thread.forkedFromId !== read.thread.id
          ? read.thread.forkedFromId
          : null
      if (!known || known.forkedFromId !== source) {
        learned++
        if (source)
          logger.warn(LOG_SOURCE, `Codex lineage scan: ${read.thread.id} is a branch of ${source}`)
      }
      recordCodexLineage(read.thread.id, source, read.thread.updatedAt)
    } else if (read.unresolvable) {
      if (!known || known.forkedFromId !== null) learned++
      recordCodexLineage(read.threadId, null, null)
    }
  }
  return { read: reads.length, learned }
}

/**
 * The lineage scan, as a whole: one `thread/list`, then the metadata reads that
 * pass needs.
 *
 * Wired at boot (`boot/core-services.ts`) in the background, and re-run in the
 * `all` mode by a delete the binary refused. Gated on `locateCodexBinary`
 * rather than `codexBinaryAvailable`: reading a thread's metadata needs the
 * app-server and nothing else, and the delete plan this cache feeds is gated
 * the same way.
 */
export async function scanCodexLineage(
  options: CodexReadOptions = { cwd: homedir() },
  tuning: CodexReadTuning = {},
  mode: CodexScanMode = 'changed'
): Promise<CodexLineageScan> {
  if (!tuning.service && !locateCodexBinary()) return { read: 0, learned: 0 }
  const service = tuning.service ?? new CodexService({ ...options, label: 'lineage-scan' })
  try {
    return await refreshCodexLineage(service, await service.listAllThreads(), mode, tuning)
  } finally {
    if (!tuning.service) service.dispose()
  }
}

/**
 * How many spawned child threads one cold read will reconstruct.
 *
 * A root can spawn as many agents as the native depth/thread limits allow, and
 * each one is a full `thread/read` on the same process. The cap bounds a cold
 * open of a heavily parallel session; the excess simply has no transcript, the
 * same as a child whose thread the binary no longer resolves.
 */
const CHILD_READ_LIMIT = 16

/** Record a listed thread's identity and project it as one sidebar row. */
function adoptThread(thread: Thread): SessionInfo {
  ensureCodexSessionOverrides(thread.id)
  const existing = getSessionMeta(thread.id)
  const model =
    existing?.engineId === 'codex' && existing.model?.vendorId === thread.modelProvider
      ? existing.model.modelId
      : thread.model
  setSessionMeta(thread.id, {
    engineId: 'codex',
    ...(model
      ? {
          model: { engineId: 'codex', vendorId: thread.modelProvider, modelId: model }
        }
      : {})
  })
  return {
    sessionId: thread.id,
    engineId: 'codex',
    cwd: thread.cwd,
    projectKey: cwdToProjectKey(thread.cwd),
    title: thread.name || thread.preview?.slice(0, 100) || 'Codex session',
    timestamp: thread.createdAt * 1000,
    lastActivityAt: thread.updatedAt * 1000
  }
}

/**
 * Every Codex thread ClaudeUI can still show.
 *
 * `thread/list` is the native listing and it does not return a fork until the
 * fork has run a turn of its own (pinned by
 * `src/integration/codex/codex-lifecycle.integration.test.ts`), so a fresh
 * branch would vanish from the sidebar on the next restart. The lineage cache
 * is what names those branches: `CodexSession.start` records every thread
 * `thread/fork` mints, the launch scan records everything else, and this reads
 * back exactly the cached BRANCHES the native listing omits — so a fork that
 * has since run a turn is one row, not two.
 *
 * It also runs the scan's cheapest pass first ({@link CodexScanMode} `new`):
 * a thread created outside ClaudeUI while the app runs is listed but unknown to
 * the cache, and reading its lineage here is what keeps a delete plan honest
 * without waiting for the next launch. `new` and not `changed` on purpose — the
 * session the user is talking to changes its `updatedAt` every turn, and this
 * runs on a 30 s poll.
 *
 * A read the binary refuses TWICE ({@link THREAD_UNRESOLVABLE}) tombstones the
 * row, which drops the branch from the sidebar and from every plan; a single
 * refusal, or any other failure, keeps it and skips that fork for this round,
 * because neither a transport blip nor a cold app-server may delete a branch.
 * One failure never fails the list.
 */
export async function listCodexSessions(
  options: CodexReadOptions = { cwd: homedir() },
  tuning: CodexReadTuning = {}
): Promise<SessionInfo[]> {
  if (!codexBinaryAvailable()) return []
  const service = tuning.service ?? new CodexService({ ...options, label: 'history-list' })
  try {
    const listed = await service.listAllThreads()
    const sessions = listed.filter(listable).map(adoptThread)
    const native = new Set(listed.map((thread) => thread.id))
    // A thread that appeared while the app was running — another client's fork,
    // a terminal `codex` — is listed and uncached, and nothing else would learn
    // its lineage before the next launch.
    await refreshCodexLineage(service, listed, 'new', tuning)
    // The cached branches the native listing does not carry: a fork that has not
    // run a turn yet. One that HAS is already a row above, and reading it again
    // would make it two.
    const ids = listCodexForks()
      .map((fork) => fork.threadId)
      .filter((id) => !native.has(id))
    for (const read of await readThreads(service, ids, tuning)) {
      if (read.thread) {
        if (listable(read.thread)) sessions.push(adoptThread(read.thread))
      } else if (read.unresolvable) recordCodexLineage(read.threadId, null, null)
    }
    return sessions
  } finally {
    if (!tuning.service) service.dispose()
  }
}

/**
 * Which native turn a branch off `messageId` must be cut through.
 *
 * Codex's fork granularity is the TURN, and every Codex message id is
 * `codex:[threadId, turnId, itemId]` (`event-mapper.codexItemId`), so the
 * anchor is just the turn that owns the clicked row — which means a branch
 * keeps the WHOLE turn containing it, not the transcript up to that message.
 * There is no JSONL and no Claude-style line uuid on this engine.
 */
export async function resolveCodexForkAnchor(
  threadId: string,
  messageId: string,
  options: CodexReadOptions = { cwd: homedir() }
): Promise<ForkAnchorResult> {
  const turnId = codexTurnId(messageId)
  if (!turnId) return { anchorUuid: null, reason: 'not-a-codex-message' }
  const service = new CodexService({ ...options, label: 'history-read' })
  try {
    const thread = await service.history(threadId)
    const turn = thread.turns.find((entry) => entry.id === turnId)
    if (!turn) return { anchorUuid: null, reason: 'turn-not-found' }
    // `thread/fork` refuses an in-progress turn outright, so this is the honest
    // refusal rather than a native error the user cannot act on.
    if (turn.status === 'inProgress') return { anchorUuid: null, reason: 'turn-in-progress' }
    return { anchorUuid: turnId }
  } catch {
    return { anchorUuid: null, reason: 'read-failed' }
  } finally {
    service.dispose()
  }
}

/** The turn id inside a `codex:` message id, or null for any other id. */
function codexTurnId(messageId: string): string | null {
  if (!messageId.startsWith('codex:')) return null
  try {
    const parts: unknown = JSON.parse(messageId.slice('codex:'.length))
    if (!Array.isArray(parts) || typeof parts[1] !== 'string' || !parts[1]) return null
    return parts[1]
  } catch {
    return null
  }
}

/**
 * A Codex thread's transcript, optionally cut at a turn.
 *
 * `throughTurnId` is the BRANCH seed: `create-session.ts` seeds a fork's
 * canonical transcript from the SOURCE thread, and without the cut every client
 * would show the source's post-anchor turns above an engine that forked before
 * them. It is the same anchor `thread/fork` took as `lastTurnId`, so "through,
 * inclusive" here means what it means there. An anchor the thread does not carry
 * is a failed seed, not a silent full read — the caller turns it into the
 * "native context was not replaced" banner, which is then the honest outcome.
 */
export async function loadCodexHistory(
  threadId: string,
  options: CodexReadOptions = { cwd: homedir() },
  throughTurnId?: string
): Promise<SessionHistoryResult> {
  const service = new CodexService({ ...options, label: 'history-read' })
  /** Child thread id → the parent `collabAgentToolCall` tool_use it renders under. */
  const childCards = new Map<string, string>()
  try {
    const thread = await service.history(threadId)
    assertCodexProvider(thread.modelProvider)
    let turns = thread.turns
    if (throughTurnId !== undefined) {
      const cut = turns.findIndex((turn) => turn.id === throughTurnId)
      if (cut === -1) throw new Error('Codex fork anchor turn is not in this thread')
      turns = turns.slice(0, cut + 1)
    }
    const messages = new Map<string, ChatMessage>()
    for (const turn of turns) {
      for (const item of turn.items) {
        // Native children (ADR-066 slice F). Only `spawnAgent` mints a thread,
        // so it is the only call that owns a transcript; the later `wait` /
        // `closeAgent` calls name the SAME children and must not claim them.
        if (item.type === 'collabAgentToolCall' && item.tool === 'spawnAgent')
          for (const child of item.receiverThreadIds)
            if (!childCards.has(child))
              childCards.set(child, codexItemId(thread.id, turn.id, item.id))
        // The v2 surface's equivalent pair: `started` is the card, and a
        // terminal activity — whose item id is its own, never the spawn call's
        // — closes it through `agentThreadId`.
        if (item.type === 'subAgentActivity') {
          if (item.kind === 'started') {
            if (!childCards.has(item.agentThreadId))
              childCards.set(item.agentThreadId, codexItemId(thread.id, turn.id, item.id))
          } else {
            const card = childCards.get(item.agentThreadId)
            const result = subAgentActivityResult(item.kind)
            const message = card ? messages.get(card) : undefined
            if (card && message && result !== undefined)
              message.content = [
                ...message.content.filter(
                  (block) => block.type !== 'tool_result' || block.toolUseId !== card
                ),
                { type: 'tool_result', toolUseId: card, toolResult: result, isError: false }
              ]
          }
        }
        for (const event of mapCodexItem(
          thread.id,
          turn.id,
          item,
          true,
          (turn.startedAt ?? thread.createdAt) * 1000
        )) {
          if (event.kind === 'message') messages.set(event.message.id, event.message)
          if (event.kind === 'toolResult') {
            const message = messages.get(event.toolUseId)
            if (message)
              message.content = [
                ...message.content.filter(
                  (block) => block.type !== 'tool_result' || block.toolUseId !== event.toolUseId
                ),
                {
                  type: 'tool_result',
                  toolUseId: event.toolUseId,
                  toolResult: event.result,
                  isError: event.isError,
                  ...(event.fileDiffs ? { fileDiffs: event.fileDiffs } : {})
                }
              ]
          }
        }
      }
    }
    return {
      messages: [...messages.values()],
      taskNotifications: [],
      customTitle: thread.name,
      statusLine: null,
      agentIdToToolUseId: {},
      subagentMessages: await readCodexChildren(service, childCards),
      warnings: turns.some((turn) => turn.status === 'interrupted')
        ? [
            'Native interrupted-tool history may omit unresolved work. A durable presentation supplement is not implemented.'
          ]
        : []
    }
  } finally {
    service.dispose()
  }
}

/**
 * The transcripts of the child threads a cold-read root spawned, by the parent
 * card's tool_use id.
 *
 * DEPTH ONE, deliberately: a grandchild's messages belong to ITS parent's card,
 * which lives inside a subagent transcript the renderer does not nest, and the
 * live path refuses the same shape for the same reason. One unreadable child
 * (deleted, archived, or refused by the binary) costs that child's transcript
 * and nothing else — the root's own history is what the user asked for.
 */
async function readCodexChildren(
  service: CodexService,
  childCards: Map<string, string>
): Promise<Record<string, ChatMessage[]>> {
  const transcripts: Record<string, ChatMessage[]> = {}
  for (const [childThreadId, card] of [...childCards].slice(0, CHILD_READ_LIMIT)) {
    const child = await service.history(childThreadId).catch(() => undefined)
    if (!child) continue
    const messages = new Map<string, ChatMessage>()
    for (const turn of child.turns) {
      for (const item of turn.items) {
        for (const event of mapCodexItem(
          child.id,
          turn.id,
          item,
          true,
          (turn.startedAt ?? child.createdAt) * 1000
        )) {
          if (event.kind === 'message') messages.set(event.message.id, event.message)
          if (event.kind === 'toolResult') {
            const message = messages.get(event.toolUseId)
            if (message)
              message.content = [
                ...message.content.filter(
                  (block) => block.type !== 'tool_result' || block.toolUseId !== event.toolUseId
                ),
                {
                  type: 'tool_result',
                  toolUseId: event.toolUseId,
                  toolResult: event.result,
                  isError: event.isError,
                  ...(event.fileDiffs ? { fileDiffs: event.fileDiffs } : {})
                }
              ]
          }
        }
      }
    }
    if (messages.size) transcripts[card] = [...(transcripts[card] ?? []), ...messages.values()]
  }
  return transcripts
}

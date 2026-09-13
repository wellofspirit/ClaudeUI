import { homedir } from 'node:os'
import { CodexService } from './CodexService'
import type { CodexClientOptions } from './CodexAppServerClient'
import { codexBinaryAvailable } from './codex-locate'
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
  registerCodexFork,
  listCodexForks,
  deleteCodexFork,
  codexForkSweepDone,
  markCodexForkSweepDone
} from '../services/db'
import { CodexTransportError } from './CodexAppServerClient'
import type { Thread } from './protocol/v2/Thread'

type CodexReadOptions = Pick<CodexClientOptions, 'cwd' | 'env'>

/** How many metadata-only reads the fork pass keeps on the wire at once. */
const FORK_READ_CONCURRENCY = 4

/**
 * The ONE JSON-RPC code that means "this thread id will never resolve again".
 *
 * `thread/read` answers `-32600` (Invalid Request) for every id the app-server
 * cannot resolve at all — "thread not loaded: <id>" when neither the rollout
 * nor a live thread exists, "invalid thread id: <err>" when it does not even
 * parse (`app-server/src/request_processors/thread_processor.rs`
 * `read_thread_view` / `thread_read_response_inner`, both through
 * `error_code.rs::invalid_request`). Everything that is merely BROKEN — an IO
 * failure reading the rollout, a store fault — becomes `-32603` (Internal), and
 * a transport fault never reaches a JSON-RPC code at all. That asymmetry is
 * what makes pruning on this code safe; it is pinned against the real binary by
 * `codex-lifecycle.integration.test.ts` (`readDeletedFork`).
 *
 * The client collapses a JSON-RPC error to `rpc-error-<code>` and drops the
 * native message (CodexService keeps payloads out of core), so the code is all
 * there is to match on.
 */
const THREAD_UNRESOLVABLE = 'rpc-error--32600'

/** One metadata-only read's outcome: the thread, or why there is none. */
type ForkRead =
  { threadId: string; thread: Thread } | { threadId: string; thread: null; unresolvable: boolean }

/**
 * Read `ids` metadata-only, {@link FORK_READ_CONCURRENCY} at a time, in the
 * order they were given. One failure never fails the batch — it is reported.
 */
async function readThreads(service: CodexService, ids: string[]): Promise<ForkRead[]> {
  const results = new Array<ForkRead>(ids.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(FORK_READ_CONCURRENCY, ids.length) }, async () => {
      for (let index = next++; index < ids.length; index = next++) {
        const threadId = ids[index]
        try {
          const { thread } = await service.readThread({ threadId, includeTurns: false })
          results[index] = { threadId, thread }
        } catch (error) {
          results[index] = {
            threadId,
            thread: null,
            unresolvable: error instanceof CodexTransportError && error.code === THREAD_UNRESOLVABLE
          }
        }
      }
    })
  )
  return results
}

/** A thread that belongs in the sidebar — a root, not a native child or a scratch thread. */
function listable(thread: Thread): boolean {
  return !thread.parentThreadId && !thread.ephemeral
}

/**
 * ONE-TIME adoption of the forks that predate the registry (db v16).
 *
 * Before the registry, a fork was only findable by re-reading every codex id in
 * `session_meta` the native list omitted. Existing users' branches are still
 * only recorded there, so the first list after the migration runs that sweep
 * exactly once and writes what it finds into the registry. "Exactly once" is
 * the marker row in `codex_forks` itself (`markCodexForkSweepDone`) — no
 * separate settings flag, and not the table's emptiness, which would re-sweep
 * forever for a user who has no forks at all.
 *
 * The marker is set only when every id in the sweep was ANSWERED (resolved, or
 * definitively refused). A transport failure mid-sweep leaves it unset so the
 * next refresh retries: marking done on a broken read would silently drop a
 * real fork, which is the one outcome this must never have.
 */
async function adoptLegacyForks(service: CodexService, native: Set<string>): Promise<Thread[]> {
  const unlisted = Object.entries(allSessionMeta())
    .filter(([id, meta]) => meta.engineId === 'codex' && !native.has(id))
    .map(([id]) => id)
  const reads = await readThreads(service, unlisted)
  const adopted: Thread[] = []
  for (const read of reads) {
    if (!read.thread || !listable(read.thread)) continue
    registerCodexFork(read.thread.id, read.thread.forkedFromId ?? null)
    adopted.push(read.thread)
  }
  if (reads.every((read) => read.thread !== null || read.unresolvable)) markCodexForkSweepDone()
  return adopted
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
 * `thread/list` is the native listing and it NEVER returns forks (pinned by
 * `src/integration/codex/codex-lifecycle.integration.test.ts`), so a branch
 * would vanish from the sidebar on the next restart. The forks are therefore
 * named explicitly: `CodexSession.start` registers every thread `thread/fork`
 * mints (db v16), and this reads back exactly those ids, four at a time.
 *
 * That registry replaces the old derivation — "every codex `session_meta` id
 * the native list omits" — which after a few deletions was mostly dead ids
 * re-probed on every sidebar refresh. A read the binary refuses DEFINITIVELY
 * ({@link THREAD_UNRESOLVABLE}) drops the row; any other failure keeps it and
 * skips that fork for this round, because a transport blip must never delete a
 * branch. One failure never fails the list.
 */
export async function listCodexSessions(
  options: CodexReadOptions = { cwd: homedir() }
): Promise<SessionInfo[]> {
  if (!codexBinaryAvailable()) return []
  const service = new CodexService(options)
  try {
    const listed = await service.listAllThreads()
    const sessions = listed.filter(listable).map(adoptThread)
    const native = new Set(listed.map((thread) => thread.id))
    // Existing users' forks live only in `session_meta`; adopt them once.
    const adopted = codexForkSweepDone() ? [] : await adoptLegacyForks(service, native)
    for (const thread of adopted) sessions.push(adoptThread(thread))
    const seen = new Set([...native, ...adopted.map((thread) => thread.id)])
    const ids = listCodexForks()
      .map((fork) => fork.threadId)
      .filter((id) => !seen.has(id))
    for (const read of await readThreads(service, ids)) {
      if (read.thread) {
        if (listable(read.thread)) sessions.push(adoptThread(read.thread))
      } else if (read.unresolvable) deleteCodexFork(read.threadId)
    }
    return sessions
  } finally {
    service.dispose()
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
  const service = new CodexService(options)
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
  const service = new CodexService(options)
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

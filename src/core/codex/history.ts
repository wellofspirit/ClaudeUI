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
  ensureCodexSessionOverrides
} from '../services/db'
import type { Thread } from './protocol/v2/Thread'

type CodexReadOptions = Pick<CodexClientOptions, 'cwd' | 'env'>

/** How many metadata-only reads the fork sweep keeps on the wire at once. */
const FORK_READ_CONCURRENCY = 4

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
 * would vanish from the sidebar on the next restart. Since `CodexSession.start`
 * writes `session_meta` for every thread it owns, the codex ids in that table
 * minus the natively listed ones are exactly the forks plus threads deleted
 * behind our back: read each one, keep what the binary still resolves, and drop
 * what it refuses. One failure never fails the list.
 */
export async function listCodexSessions(
  options: CodexReadOptions = { cwd: homedir() }
): Promise<SessionInfo[]> {
  if (!codexBinaryAvailable()) return []
  const service = new CodexService(options)
  try {
    const listed = await service.listAllThreads()
    const sessions = listed
      .filter((thread) => !thread.parentThreadId && !thread.ephemeral)
      .map(adoptThread)
    const native = new Set(listed.map((thread) => thread.id))
    const unlisted = Object.entries(allSessionMeta())
      .filter(([id, meta]) => meta.engineId === 'codex' && !native.has(id))
      .map(([id]) => id)
    let next = 0
    await Promise.all(
      Array.from({ length: Math.min(FORK_READ_CONCURRENCY, unlisted.length) }, async () => {
        for (let index = next++; index < unlisted.length; index = next++) {
          const thread = await service
            .readThread({ threadId: unlisted[index], includeTurns: false })
            .then((result) => result.thread)
            .catch(() => undefined)
          if (thread && !thread.parentThreadId && !thread.ephemeral)
            sessions.push(adoptThread(thread))
        }
      })
    )
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

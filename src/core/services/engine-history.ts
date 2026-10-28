import type { EngineId, SessionInfo, StatusLineData } from '../../shared/types'
import { getSessionMeta } from './db'
import { withSessionCards } from './session-links'
import { withProposalCards } from './session-proposals'
import { withDispatchTasks } from './dispatch-task-history'
import {
  listDirectories,
  loadSessionHistory as loadClaudeHistory,
  resolveForkAnchor,
  type LoadHistoryOptions,
  type SessionHistoryResult
} from './session-history'
import { listPiSessionsGlobal, loadPiSessionHistory, deletePiSession } from './pi-session-list'
import {
  listOpencodeSessionsGlobal,
  loadOpencodeSessionHistory,
  deleteOpencodeSession
} from './opencode-session-list'
import { deleteSessionFiles } from './delete-session-files'
import type { ForkAnchorResult } from '../../shared/types'

interface EngineHistory {
  /**
   * `options` (byte progress, `deferStatusLine`) are the Claude reader's
   * (ADR-102); every other engine ignores them — the caller shows an
   * indeterminate bar, and their readers return the status line inline.
   */
  read(
    sessionId: string,
    projectKey: string,
    anchor?: string,
    options?: LoadHistoryOptions
  ): Promise<SessionHistoryResult>
  list(): Promise<SessionInfo[]>
  /** Resolves `false` when the engine could not delete the session (best-effort deleters); a refusal throws. */
  delete(sessionId: string, projectKey: string): Promise<boolean | void>
  forkAnchor(
    sessionId: string,
    cwd: string,
    messageId: string,
    messageIndex: number
  ): Promise<ForkAnchorResult>
}
/**
 * An engine whose reader returns only a transcript (and, since S1d, the status
 * line it rebuilt from it) in the engine-neutral shape: the remaining fields
 * are Claude-transcript concepts those engines have nothing to put in.
 */
const bare = (load: {
  messages: SessionHistoryResult['messages']
  statusLine?: StatusLineData | null
  /** pi's host-run subagent transcripts (ADR-089), passed through inline. */
  subagentMessages?: SessionHistoryResult['subagentMessages']
  /** pi's host-run subagents' terminal events (ADR-089 S3). */
  taskNotifications?: SessionHistoryResult['taskNotifications']
}): SessionHistoryResult => ({
  messages: load.messages,
  taskNotifications: load.taskNotifications ?? [],
  customTitle: null,
  statusLine: load.statusLine ?? null,
  agentIdToToolUseId: {},
  warnings: [],
  ...(load.subagentMessages ? { subagentMessages: load.subagentMessages } : {})
})
const readers: Record<EngineId, EngineHistory> = {
  claude: {
    read: (...args) => loadClaudeHistory(...args),
    list: async () => (await listDirectories()).flatMap((group) => group.sessions),
    delete: (id, key) => deleteSessionFiles(id, key),
    forkAnchor: (id, cwd, message, index) => resolveForkAnchor(id, cwd, message, 'claude', index)
  },
  pi: {
    read: async (id) => bare(await loadPiSessionHistory(id)),
    list: () => listPiSessionsGlobal(),
    delete: (id) => deletePiSession(id),
    forkAnchor: (id, cwd, message, index) => resolveForkAnchor(id, cwd, message, 'pi', index)
  },
  opencode: {
    read: async (id) => bare(await loadOpencodeSessionHistory(id)),
    list: () => listOpencodeSessionsGlobal(),
    delete: (id) => deleteOpencodeSession(id),
    forkAnchor: async () => {
      throw new Error('opencode fork is not implemented')
    }
  }
}

export function historyFor(engineId: string | undefined): EngineHistory {
  const id = engineId ?? 'claude'
  if (!Object.hasOwn(readers, id)) throw new Error(`Unsupported history engine: ${id}`)
  return readers[id as EngineId]
}

export function readSessionHistory(
  sessionId: string,
  projectKey: string,
  anchor?: string,
  engineId?: EngineId,
  options?: LoadHistoryOptions
): Promise<SessionHistoryResult> {
  const storedEngine = getSessionMeta(sessionId)?.engineId
  if (engineId && storedEngine && engineId !== storedEngine)
    throw new Error('History engine does not match persisted session identity')
  return historyFor(engineId ?? storedEngine)
    .read(sessionId, projectKey, anchor, options)
    .then((result) => {
      // No engine writes anything for a session card or a proposal card, so a cold
      // read puts the parent's cards back (slices 1b and 1c-b), proposals in the
      // state they are in now. Not for an anchored read: only a fork passes an
      // anchor, and a fork is a new session that started and proposed none of the
      // source's.
      if (anchor) return result
      const messages = withProposalCards(sessionId, withSessionCards(sessionId, result.messages))
      // ...and the cards of its X-Agents (ADR-105 §5), which the dispatcher emits and no
      // transcript holds; they join on the launching tool call, so the messages come first.
      return withDispatchTasks(
        sessionId,
        messages === result.messages ? result : { ...result, messages }
      )
    })
}

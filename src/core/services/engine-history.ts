import type { EngineId, SessionInfo } from '../../shared/types'
import { getSessionMeta } from './db'
import {
  listDirectories,
  loadSessionHistory as loadClaudeHistory,
  resolveForkAnchor,
  type SessionHistoryResult
} from './session-history'
import { listPiSessionsGlobal, loadPiSessionHistory, deletePiSession } from './pi-session-list'
import {
  listOpencodeSessionsGlobal,
  loadOpencodeSessionHistory,
  deleteOpencodeSession
} from './opencode-session-list'
import { deleteSessionFiles } from './delete-session-files'
import { listCodexSessions, loadCodexHistory, resolveCodexForkAnchor } from '../codex/history'
import { deleteCodexThread } from '../codex/delete'
import type { ForkAnchorResult } from '../../shared/types'

interface EngineHistory {
  read(sessionId: string, projectKey: string, anchor?: string): Promise<SessionHistoryResult>
  list(): Promise<SessionInfo[]>
  delete(sessionId: string, projectKey: string): Promise<void>
  forkAnchor(
    sessionId: string,
    cwd: string,
    messageId: string,
    messageIndex: number
  ): Promise<ForkAnchorResult>
}
const bare = (messages: SessionHistoryResult['messages']): SessionHistoryResult => ({
  messages,
  taskNotifications: [],
  customTitle: null,
  statusLine: null,
  agentIdToToolUseId: {},
  warnings: []
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
  },
  codex: {
    // The anchor is a native TURN id, never a Claude JSONL line uuid — the codex
    // `forkAnchor` below is the only thing that mints one — so it is forwarded
    // as the cut, which is what seeds a branch's canonical transcript.
    read: (id, _projectKey, anchor) =>
      anchor ? loadCodexHistory(id, undefined, anchor) : loadCodexHistory(id),
    list: listCodexSessions,
    // ONE thread, which is all this engine-neutral seam can express. The
    // binary refuses to delete a thread a fork still references, so a branched
    // session is deleted through `handlers-core.deleteSession`'s leaf-first
    // subtree walk instead — this entry is the leaf case and the walk's own
    // per-node call shares its implementation (`core/codex/delete.ts`).
    delete: (id) => deleteCodexThread(id),
    // Turn-granular and native: no JSONL line uuid and no `messageIndex`, since
    // the Codex message id already carries the turn that owns the row.
    forkAnchor: (id, cwd, message) => resolveCodexForkAnchor(id, message, { cwd })
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
  engineId?: EngineId
): Promise<SessionHistoryResult> {
  const storedEngine = getSessionMeta(sessionId)?.engineId
  if (engineId && storedEngine && engineId !== storedEngine)
    throw new Error('History engine does not match persisted session identity')
  return historyFor(engineId ?? storedEngine).read(sessionId, projectKey, anchor)
}

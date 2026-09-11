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
import { listCodexSessions, loadCodexHistory } from '../codex/history'
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
const unsupported = async (): Promise<never> => {
  throw new Error(
    'Codex deletion and fork are unsupported until native lifecycle verification is complete'
  )
}

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
    read: (id, _projectKey, anchor) => {
      if (anchor) throw new Error('Codex history cannot use a Claude message anchor')
      return loadCodexHistory(id)
    },
    list: listCodexSessions,
    delete: unsupported,
    forkAnchor: unsupported
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

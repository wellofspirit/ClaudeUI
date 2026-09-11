import { homedir } from 'node:os'
import { CodexService } from './CodexService'
import type { CodexClientOptions } from './CodexAppServerClient'
import { codexBinaryAvailable } from './codex-locate'
import { mapCodexItem } from './event-mapper'
import { assertCodexProvider } from './model-selection'
import type { SessionInfo, ChatMessage } from '../../shared/types'
import type { SessionHistoryResult } from '../services/session-history'
import { cwdToProjectKey } from '../../shared/project-key'
import { setSessionMeta, getSessionMeta, ensureCodexSessionOverrides } from '../services/db'

export async function listCodexSessions(): Promise<SessionInfo[]> {
  if (!codexBinaryAvailable()) return []
  const service = new CodexService({ cwd: homedir() })
  try {
    const sessions: SessionInfo[] = []
    for (const thread of await service.listAllThreads()) {
      if (thread.parentThreadId || thread.ephemeral) continue
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
      sessions.push({
        sessionId: thread.id,
        engineId: 'codex',
        cwd: thread.cwd,
        projectKey: cwdToProjectKey(thread.cwd),
        title: thread.name || thread.preview?.slice(0, 100) || 'Codex session',
        timestamp: thread.createdAt * 1000,
        lastActivityAt: thread.updatedAt * 1000
      })
    }
    return sessions
  } finally {
    service.dispose()
  }
}

export async function loadCodexHistory(
  threadId: string,
  options: Pick<CodexClientOptions, 'cwd' | 'env'> = { cwd: homedir() }
): Promise<SessionHistoryResult> {
  const service = new CodexService(options)
  try {
    const thread = await service.history(threadId)
    assertCodexProvider(thread.modelProvider)
    const messages = new Map<string, ChatMessage>()
    for (const turn of thread.turns) {
      for (const item of turn.items) {
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
      warnings: thread.turns.some((turn) => turn.status === 'interrupted')
        ? [
            'Native interrupted-tool history may omit unresolved work. A durable presentation supplement is not implemented.'
          ]
        : []
    }
  } finally {
    service.dispose()
  }
}

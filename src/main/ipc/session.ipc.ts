import { ipcMain, dialog, BrowserWindow } from 'electron'
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk'
import { SessionManager } from '../services/session-manager'
import { listDirectories, loadSessionHistory, loadSubagentHistory, loadBackgroundOutput } from '../services/session-history'
import type { ApprovalDecision, ModelInfo } from '../../shared/types'

let cachedModels: ModelInfo[] | null = null

async function fetchModels(): Promise<ModelInfo[]> {
  if (cachedModels) return cachedModels

  const abort = new AbortController()
  const q = sdkQuery({
    prompt: '',
    options: {
      cwd: process.cwd(),
      abortController: abort
    }
  })

  try {
    const models = await (q as unknown as { supportedModels(): Promise<ModelInfo[]> }).supportedModels()
    cachedModels = models
    return models
  } finally {
    abort.abort()
  }
}

export function registerSessionIpc(win: BrowserWindow): void {
  const manager = new SessionManager()

  ipcMain.handle('session:pick-folder', async () => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle(
    'session:create',
    (_event, routingId: string, cwd: string, effort?: string, resumeSessionId?: string) => {
      manager.create(routingId, win, cwd, effort, resumeSessionId)
    }
  )

  ipcMain.handle('session:send', (_event, routingId: string, prompt: string) => {
    const session = manager.get(routingId)
    if (!session) throw new Error(`No session for routingId: ${routingId}`)
    session.run(prompt)
  })

  ipcMain.handle('session:cancel', (_event, routingId: string) => {
    manager.cancel(routingId)
  })

  ipcMain.handle(
    'session:approval-response',
    (_event, routingId: string, requestId: string, decision: ApprovalDecision, answers?: Record<string, string>) => {
      manager.get(routingId)?.resolveApproval(requestId, decision, answers)
    }
  )

  ipcMain.handle('session:watch-background', (_e, routingId: string, toolUseId: string) => {
    manager.get(routingId)?.watchBackground(toolUseId)
  })

  ipcMain.handle('session:unwatch-background', (_e, routingId: string, toolUseId: string) => {
    manager.get(routingId)?.unwatchBackground(toolUseId)
  })

  ipcMain.handle(
    'session:read-background-range',
    (_e, routingId: string, toolUseId: string, offset: number, length: number) => {
      return manager.get(routingId)?.readBackgroundRange(toolUseId, offset, length) ?? ''
    }
  )

  ipcMain.handle('session:stop-task', async (_e, routingId: string, toolUseId: string) => {
    const session = manager.get(routingId)
    if (!session) {
      return { success: false, error: 'No active session' }
    }
    return await session.stopTask(toolUseId)
  })

  ipcMain.handle('session:set-permission-mode', async (_e, routingId: string, mode: string) => {
    await manager.get(routingId)?.setPermissionMode(mode)
  })

  ipcMain.handle('session:set-model', async (_e, routingId: string, model: string) => {
    await manager.get(routingId)?.setModel(model)
  })

  ipcMain.handle('session:set-effort', (_e, routingId: string, effort: string) => {
    manager.get(routingId)?.setEffort(effort)
  })

  ipcMain.handle('session:get-models', async () => {
    return await fetchModels()
  })

  ipcMain.handle('session:get-plan-content', (_e, routingId: string) => {
    return manager.get(routingId)?.getPlanContent() ?? null
  })

  ipcMain.handle('session:get-session-log-path', (_e, routingId: string) => {
    return manager.get(routingId)?.getSessionLogPath() ?? null
  })

  ipcMain.handle('session:list-directories', async () => {
    return await listDirectories()
  })

  ipcMain.handle('session:load-history', async (_e, sessionId: string, projectKey: string) => {
    return await loadSessionHistory(sessionId, projectKey)
  })

  ipcMain.handle('session:load-subagent-history', async (_e, sessionId: string, projectKey: string, agentId: string) => {
    return await loadSubagentHistory(sessionId, projectKey, agentId)
  })

  ipcMain.handle('session:load-background-output', (_e, projectKey: string, taskId: string, outputFile?: string) => {
    return loadBackgroundOutput(projectKey, taskId, outputFile)
  })
}

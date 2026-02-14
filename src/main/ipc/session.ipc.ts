import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { ipcMain, dialog, BrowserWindow } from 'electron'
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk'
import { SessionManager } from '../services/session-manager'
import { listDirectories, loadSessionHistory, loadSubagentHistory, loadBackgroundOutput } from '../services/session-history'
import { watchSession, unwatchSession } from '../services/session-watcher'
import type { ApprovalDecision, ModelInfo } from '../../shared/types'

let cachedModels: ModelInfo[] | null = null

const TITLE_SYSTEM_PROMPT =
  'Your task: output ONLY a short title (1-3 words) that captures the main topic of the user\'s conversation. No explanation, no quotes, no JSON, no markdown — just the title itself. Use title case. Examples: Fix Login Bug, Auth Feature, Refactor API, Debug Tests, Rename Sessions'

async function generateTitle(conversationText: string): Promise<string | null> {
  const abort = new AbortController()
  console.log('[generateTitle] request:', conversationText.length, 'chars:', conversationText.slice(0, 200))

  try {
    const q = sdkQuery({
      prompt: conversationText,
      options: {
        cwd: process.cwd(),
        abortController: abort,
        systemPrompt: TITLE_SYSTEM_PROMPT,
        model: 'claude-haiku-4-5-20251001',
        maxTurns: 1,
        tools: [],
        thinking: { type: 'disabled' },
        persistSession: false
      }
    })

    let result = ''
    for await (const message of q) {
      if (!message || typeof message !== 'object') continue
      const msg = message as Record<string, unknown>
      if (msg.type === 'assistant') {
        const betaMessage = msg.message as { content?: Array<{ type: string; text?: string }> } | undefined
        if (betaMessage?.content) {
          for (const block of betaMessage.content) {
            if (block.type === 'text' && block.text) result += block.text
          }
        }
      }
    }

    console.log('[generateTitle] response:', JSON.stringify(result))

    // Take the first line, strip quotes/punctuation, limit to 3 words
    const cleaned = result.trim().split('\n')[0].replace(/^["'`]+|["'`]+$/g, '').trim()
    const words = cleaned.split(/\s+/).slice(0, 3).join(' ')
    if (words.length >= 2) {
      console.log('[generateTitle] title:', words)
      return words
    }
    console.log('[generateTitle] no usable title extracted')
    return null
  } catch (err) {
    console.error('[generateTitle] error:', err)
    return null
  } finally {
    abort.abort()
  }
}

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
    (_event, routingId: string, cwd: string, effort?: string, resumeSessionId?: string, permissionMode?: string) => {
      manager.create(routingId, win, cwd, effort, resumeSessionId, permissionMode)
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

  ipcMain.handle('session:generate-title', async (_e, conversationText: string) => {
    return await generateTitle(conversationText)
  })

  ipcMain.handle('session:write-custom-title', async (_e, sessionId: string, projectKey: string, title: string) => {
    const filePath = path.join(os.homedir(), '.claude', 'projects', projectKey, `${sessionId}.jsonl`)
    const entry = JSON.stringify({ type: 'custom-title', customTitle: title, sessionId })
    await fs.promises.appendFile(filePath, entry + '\n', { mode: 0o600 })
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

  ipcMain.handle('session:watch-session', (_e, routingId: string, sessionId: string, projectKey: string) => {
    watchSession(routingId, sessionId, projectKey, win)
  })

  ipcMain.handle('session:unwatch-session', (_e, routingId: string) => {
    unwatchSession(routingId)
  })

  // Watch ~/.claude/projects/ for JSONL changes and notify renderer to refresh
  startProjectsWatcher(win)
}

function startProjectsWatcher(win: BrowserWindow): void {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects')
  if (!fs.existsSync(projectsDir)) return

  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  const notify = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      if (!win.isDestroyed()) {
        win.webContents.send('session:directories-changed')
      }
    }, 500)
  }

  // Watch each project subdirectory for JSONL file changes
  // (fs.watch recursive option works on macOS and Windows)
  try {
    fs.watch(projectsDir, { recursive: true }, (_event, filename) => {
      if (filename && filename.endsWith('.jsonl')) {
        notify()
      }
    })
  } catch {
    // Fallback: silently ignore if watching fails
  }
}

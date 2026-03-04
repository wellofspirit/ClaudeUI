import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { ipcMain, dialog, BrowserWindow } from 'electron'
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk'
import { SessionManager } from '../services/session-manager'
import { getCliJsPath, ClaudeSession } from '../services/claude-session'
import { listDirectories, loadSessionHistory, loadSubagentHistory, buildSubagentFileMap, loadBackgroundOutput } from '../services/session-history'
import { watchSession, unwatchSession } from '../services/session-watcher'
import { loadSettings, saveSettings, loadSessionConfig, saveSessionConfig, loadSlashCommands, saveSlashCommands, startConfigWatcher } from '../services/ui-config'
import { loadClaudePermissions, saveClaudePermissions } from '../services/claude-settings'
import { loadMcpServers, saveMcpServers, readDisabledMcpServers, writeDisabledMcpServers } from '../services/claude-mcp'
import { scanSkills } from '../services/skill-scanner'
import type { UISettings, UISessionConfig, SlashCommandCache } from '../services/ui-config'
import { gitServiceManager } from '../services/git-service'
import { createWorktree, getWorktreeStatus, removeWorktree, listWorktrees } from '../services/worktree'
import { usageFetcher } from '../services/usage-fetcher'
import { blockUsageService } from '../services/block-usage'
import type { ApprovalDecision, ModelInfo, SandboxSettings, PermissionSuggestion, IpcResult } from '../../shared/types'
import { logger } from '../services/logger'

/**
 * Wraps an async IPC handler with try-catch, returning a standardized IpcResult envelope.
 * Use this for handlers that can throw (git, MCP, worktree, file operations) but NOT for
 * fire-and-forget handlers (session:send) or those that already have proper error handling.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function safeHandler<T>(handler: (...args: any[]) => Promise<T>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (...args: any[]): Promise<IpcResult<T>> => {
    try {
      const data = await handler(...args)
      return { ok: true, data }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      logger.error('IPC', error)
      return { ok: false, error }
    }
  }
}

let cachedModels: ModelInfo[] | null = null

const TITLE_SYSTEM_PROMPT =
  'Your task: output ONLY a short title (1-3 words) that captures the main topic of the user\'s conversation. No explanation, no quotes, no JSON, no markdown — just the title itself. Use title case. Examples: Fix Login Bug, Auth Feature, Refactor API, Debug Tests, Rename Sessions'

const COMMIT_MSG_SYSTEM_PROMPT =
  'You are a commit message generator. Given a git diff of staged changes, write a concise conventional commit message. Output ONLY the commit message — no explanation, no quotes, no markdown. Use imperative mood. First line should be a short summary (max 72 chars). If needed, add a blank line followed by bullet points for details. Focus on the "why" not the "what".'

async function generateTitle(conversationText: string): Promise<string | null> {
  const abort = new AbortController()
  logger.debug('generateTitle', `request: ${conversationText.length} chars`)

  try {
    const cliPath = getCliJsPath()
    const q = sdkQuery({
      prompt: conversationText,
      options: {
        ...(cliPath ? { pathToClaudeCodeExecutable: cliPath } : {}),
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

    logger.debug('generateTitle', `response: ${JSON.stringify(result)}`)

    // Take the first line, strip quotes/punctuation, limit to 3 words
    const cleaned = result.trim().split('\n')[0].replace(/^["'`]+|["'`]+$/g, '').trim()
    const words = cleaned.split(/\s+/).slice(0, 3).join(' ')
    if (words.length >= 2) {
      logger.debug('generateTitle', `title: ${words}`)
      return words
    }
    logger.debug('generateTitle', 'no usable title extracted')
    return null
  } catch (err) {
    logger.error('generateTitle', 'Failed to generate title', err)
    return null
  } finally {
    abort.abort()
  }
}

async function generateCommitMessage(diff: string): Promise<string | null> {
  const abort = new AbortController()
  logger.debug('generateCommitMessage', `request: ${diff.length} chars`)

  try {
    const cliPath = getCliJsPath()
    const q = sdkQuery({
      prompt: diff,
      options: {
        ...(cliPath ? { pathToClaudeCodeExecutable: cliPath } : {}),
        cwd: process.cwd(),
        abortController: abort,
        systemPrompt: COMMIT_MSG_SYSTEM_PROMPT,
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

    logger.debug('generateCommitMessage', `response: ${JSON.stringify(result)}`)

    const cleaned = result.trim()
    if (cleaned.length >= 3) {
      return cleaned
    }
    logger.debug('generateCommitMessage', 'no usable message extracted')
    return null
  } catch (err) {
    logger.error('generateCommitMessage', 'Failed to generate commit message', err)
    return null
  } finally {
    abort.abort()
  }
}

async function fetchModels(): Promise<ModelInfo[]> {
  if (cachedModels) return cachedModels

  const abort = new AbortController()
  const cliPath = getCliJsPath()
  const q = sdkQuery({
    prompt: '',
    options: {
      ...(cliPath ? { pathToClaudeCodeExecutable: cliPath } : {}),
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

const SESSION_IPC_CHANNELS = [
  'session:pick-folder', 'session:create', 'session:rekey', 'session:send',
  'session:cancel', 'session:approval-response', 'session:watch-background',
  'session:unwatch-background', 'session:read-background-range', 'session:stop-task',
  'session:background-task', 'session:dequeue-message',
  'session:set-permission-mode', 'session:set-model', 'session:set-effort',
  'session:get-models', 'session:generate-title', 'session:generate-commit-message',
  'session:write-custom-title', 'session:get-plan-content', 'session:get-session-log-path',
  'session:list-directories', 'session:load-history', 'session:load-subagent-history',
  'session:build-subagent-file-map', 'session:load-background-output',
  'session:watch-session', 'session:unwatch-session',
  'config:load-settings', 'config:save-settings', 'config:load-sessions',
  'config:save-sessions', 'config:load-slash-commands', 'config:save-slash-commands',
  'config:load-skill-details',
  'session:send-to-teammate', 'session:broadcast-to-team', 'session:get-team-info',
  'session:open-teams-view',
  'git:check-repo', 'git:status', 'git:branches', 'git:checkout', 'git:create-branch',
  'git:file-patch', 'git:file-contents', 'git:stage-file', 'git:unstage-file', 'git:discard-file',
  'git:stage-all', 'git:unstage-all', 'git:commit', 'git:push', 'git:push-with-upstream', 'git:pull', 'git:fetch',
  'git:start-watching', 'git:stop-watching',
  'file:list-dir',
  'usage:fetch', 'usage:fetch-block',
  'claude:load-permissions', 'claude:save-permissions',
  'mcp:status', 'mcp:toggle', 'mcp:reconnect', 'mcp:set-servers',
  'mcp:load-servers', 'mcp:save-servers',
  'mcp:read-disabled', 'mcp:toggle-disabled',
  'worktree:create', 'worktree:status', 'worktree:remove', 'worktree:list',
  'app:quit-confirm',
  'session:sandbox-violation'
]

export function registerSessionIpc(win: BrowserWindow): void {
  // Remove previous handlers to allow re-registration (e.g. macOS dock re-open)
  for (const channel of SESSION_IPC_CHANNELS) {
    ipcMain.removeHandler(channel)
  }

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
    (_event, routingId: string, cwd: string, effort?: string, resumeSessionId?: string, permissionMode?: string, model?: string) => {
      const settings = loadSettings() as Record<string, unknown>
      const sandboxConfig = (settings.sandbox as SandboxSettings) || undefined
      manager.create(routingId, win, cwd, effort, resumeSessionId, permissionMode, model, sandboxConfig)
    }
  )

  ipcMain.handle('session:rekey', (_event, oldId: string, newId: string) => {
    manager.rekey(oldId, newId)
  })

  ipcMain.handle('session:send', (_event, routingId: string, prompt: string, attachments?: Array<{ mediaType: string; base64Data: string; fileName?: string }>) => {
    const session = manager.get(routingId)
    if (!session) throw new Error(`No session for routingId: ${routingId}`)
    session.run(prompt, attachments)
  })

  ipcMain.handle('session:cancel', (_event, routingId: string) => {
    manager.cancel(routingId)
  })

  ipcMain.handle(
    'session:approval-response',
    (_event, routingId: string, requestId: string, decision: ApprovalDecision, answers?: Record<string, string>, updatedPermissions?: PermissionSuggestion[]) => {
      manager.get(routingId)?.resolveApproval(requestId, decision, answers, updatedPermissions)
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

  ipcMain.handle('session:background-task', async (_e, routingId: string, toolUseId: string) => {
    const session = manager.get(routingId)
    if (!session) {
      return { success: false, error: 'No active session' }
    }
    return await session.backgroundTask(toolUseId)
  })

  ipcMain.handle('session:dequeue-message', async (_e, routingId: string, value: string) => {
    const session = manager.get(routingId)
    if (!session) return { removed: 0 }
    return await session.dequeueMessage(value)
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

  ipcMain.handle('session:generate-commit-message', async (_e, diff: string) => {
    return await generateCommitMessage(diff)
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

  ipcMain.handle('file:list-dir', async (_e, dirPath: string) => {
    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
      const HIDDEN_NAMES = new Set(['node_modules', '.git', '.DS_Store', '__pycache__', '.next', '.cache'])
      const result: Array<{ name: string; isDirectory: boolean }> = []
      for (const entry of entries) {
        if (entry.name.startsWith('.') || HIDDEN_NAMES.has(entry.name)) continue
        result.push({ name: entry.name, isDirectory: entry.isDirectory() || entry.isSymbolicLink() })
      }
      // Sort: directories first, then alphabetical within each group
      result.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      })
      // Check if this directory is a filesystem root (parent resolves to itself)
      // Return resolved path in POSIX format so renderer can rewrite relative dirs
      const resolved = path.resolve(dirPath)
      const isRoot = path.dirname(resolved) === resolved
      const resolvedPosix = resolved.replace(/\\/g, '/').replace(/\/$/, '')
      return { entries: result, isRoot, resolvedPath: resolvedPosix }
    } catch {
      return { entries: [], isRoot: false, resolvedPath: '' }
    }
  })

  ipcMain.handle('session:load-history', async (_e, sessionId: string, projectKey: string) => {
    return await loadSessionHistory(sessionId, projectKey)
  })

  ipcMain.handle('session:load-subagent-history', async (_e, sessionId: string, projectKey: string, agentId: string) => {
    return await loadSubagentHistory(sessionId, projectKey, agentId)
  })

  ipcMain.handle('session:build-subagent-file-map', (_e, sessionId: string, projectKey: string, taskPrompts: Record<string, string>) => {
    return buildSubagentFileMap(sessionId, projectKey, taskPrompts)
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

  // UI config persistence (~/.claude/ui/)
  ipcMain.handle('config:load-settings', () => loadSettings())
  ipcMain.handle('config:save-settings', (_e, settings: UISettings) => {
    saveSettings(settings)
    // Propagate usage refresh interval change
    if (typeof (settings as Record<string, unknown>).usageRefreshSecs === 'number') {
      usageFetcher.setIntervalSecs((settings as Record<string, unknown>).usageRefreshSecs as number)
    }
    // Propagate session idle timeout change
    const timeoutMins = (settings as Record<string, unknown>).sessionTimeoutMins
    if (typeof timeoutMins === 'number') {
      manager.setSessionTimeout(timeoutMins * 60 * 1000)
    }
  })
  ipcMain.handle('config:load-sessions', () => loadSessionConfig())
  ipcMain.handle('config:save-sessions', (_e, config: UISessionConfig) => saveSessionConfig(config))
  ipcMain.handle('config:load-slash-commands', () => loadSlashCommands())
  ipcMain.handle('config:save-slash-commands', (_e, commands: SlashCommandCache[]) => saveSlashCommands(commands))
  ipcMain.handle('config:load-skill-details', (_e, cwd: string) => scanSkills(cwd))

  // Claude permission settings (allow/deny/ask rules)
  ipcMain.handle('claude:load-permissions', (_e, scope: string, cwd?: string) =>
    loadClaudePermissions(scope as 'user' | 'project' | 'local', cwd))
  ipcMain.handle('claude:save-permissions', (_e, scope: string, permissions: unknown, cwd?: string) =>
    saveClaudePermissions(scope as 'user' | 'project' | 'local', permissions as never, cwd))

  // MCP server management (via SDK Query object)
  ipcMain.handle('mcp:status', async (_e, routingId: string) => {
    const session = manager.get(routingId)
    if (!session) return []
    return await session.mcpServerStatus()
  })

  ipcMain.handle('mcp:toggle', safeHandler(async (_e: unknown, routingId: string, serverName: string, enabled: boolean) => {
    const session = manager.get(routingId)
    if (!session) throw new Error('No active session')
    await session.mcpToggleServer(serverName, enabled)
  }))

  ipcMain.handle('mcp:reconnect', safeHandler(async (_e: unknown, routingId: string, serverName: string) => {
    const session = manager.get(routingId)
    if (!session) throw new Error('No active session')
    await session.mcpReconnectServer(serverName)
  }))

  ipcMain.handle('mcp:set-servers', safeHandler(async (_e: unknown, routingId: string, servers: Record<string, unknown>) => {
    const session = manager.get(routingId)
    if (!session) throw new Error('No active session')
    return await session.mcpSetServers(servers)
  }))

  // MCP config file read/write (direct file access, no session needed)
  ipcMain.handle('mcp:load-servers', (_e, scope: string, cwd?: string) =>
    loadMcpServers(scope as 'user' | 'project' | 'local', cwd))
  ipcMain.handle('mcp:save-servers', (_e, scope: string, servers: Record<string, unknown>, cwd?: string) =>
    saveMcpServers(scope as 'user' | 'project' | 'local', servers as never, cwd))

  // MCP disabled state (direct ~/.claude.json access, no session needed)
  ipcMain.handle('mcp:read-disabled', (_e, cwd: string) => {
    return readDisabledMcpServers(cwd)
  })

  ipcMain.handle('mcp:toggle-disabled', async (_e, cwd: string, serverName: string, enabled: boolean) => {
    const disabled = readDisabledMcpServers(cwd)
    let updated: string[]
    if (enabled) {
      updated = disabled.filter(n => n !== serverName)
    } else {
      updated = disabled.includes(serverName) ? disabled : [...disabled, serverName]
    }
    writeDisabledMcpServers(cwd, updated)
  })

  // Teammate inbox handlers
  ipcMain.handle(
    'session:send-to-teammate',
    async (_e, _routingId: string, sanitizedTeamName: string, sanitizedAgentName: string, message: string) => {
      const inboxDir = path.join(os.homedir(), '.claude', 'teams', sanitizedTeamName, 'inboxes')
      await fs.promises.mkdir(inboxDir, { recursive: true })
      const inboxPath = path.join(inboxDir, `${sanitizedAgentName}.json`)
      let items: unknown[] = []
      try {
        const raw = await fs.promises.readFile(inboxPath, 'utf-8')
        items = JSON.parse(raw)
      } catch (err) { logger.warn('IPC', `Failed to read teammate inbox: ${inboxPath}`, err) }
      items.push({ from: 'user', text: message, timestamp: new Date().toISOString(), read: false })
      await fs.promises.writeFile(inboxPath, JSON.stringify(items, null, 2), { mode: 0o600 })
    }
  )

  ipcMain.handle(
    'session:broadcast-to-team',
    async (_e, _routingId: string, sanitizedTeamName: string, sanitizedAgentNames: string[], message: string) => {
      const inboxDir = path.join(os.homedir(), '.claude', 'teams', sanitizedTeamName, 'inboxes')
      await fs.promises.mkdir(inboxDir, { recursive: true })
      const entry = { from: 'user', text: message, timestamp: new Date().toISOString(), read: false }
      for (const name of sanitizedAgentNames) {
        const inboxPath = path.join(inboxDir, `${name}.json`)
        let items: unknown[] = []
        try {
          const raw = await fs.promises.readFile(inboxPath, 'utf-8')
          items = JSON.parse(raw)
        } catch (err) { logger.warn('IPC', `Failed to read teammate inbox: ${inboxPath}`, err) }
        items.push(entry)
        await fs.promises.writeFile(inboxPath, JSON.stringify(items, null, 2), { mode: 0o600 })
      }
    }
  )

  // Team info query (pull-based)
  ipcMain.handle('session:get-team-info', (_e, routingId: string) => {
    return manager.getTeamInfo(routingId)
  })

  // Teams-view window
  let teamsViewWindow: BrowserWindow | null = null
  ipcMain.handle('session:open-teams-view', (_e, _routingId: string) => {
    if (teamsViewWindow && !teamsViewWindow.isDestroyed()) {
      teamsViewWindow.focus()
      return
    }
    teamsViewWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      minWidth: 600,
      minHeight: 400,
      title: 'Agent Monitor',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        sandbox: false
      }
    })
    ClaudeSession.addExtraWindow(teamsViewWindow)
    teamsViewWindow.on('closed', () => {
      if (teamsViewWindow) ClaudeSession.removeExtraWindow(teamsViewWindow)
      teamsViewWindow = null
    })

    // Load with ?view=teams-view&routingId=<id> query params
    const { is } = require('@electron-toolkit/utils')
    const searchParams = `view=teams-view&routingId=${encodeURIComponent(_routingId)}`
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      teamsViewWindow.loadURL(process.env['ELECTRON_RENDERER_URL'] + '?' + searchParams)
    } else {
      teamsViewWindow.loadFile(path.join(__dirname, '../renderer/index.html'), { search: searchParams })
    }
  })

  // -------------------------------------------------------------------------
  // Git integration IPC handlers
  // -------------------------------------------------------------------------

  ipcMain.handle('git:check-repo', safeHandler(async (_e: unknown, cwd: string) => {
    const svc = gitServiceManager.get(cwd)
    try {
      return await svc.isGitRepo()
    } finally {
      gitServiceManager.release(cwd)
    }
  }))

  ipcMain.handle('git:status', safeHandler(async (_e: unknown, cwd: string) => {
    const svc = gitServiceManager.get(cwd)
    try {
      return await svc.getStatus()
    } finally {
      gitServiceManager.release(cwd)
    }
  }))

  ipcMain.handle('git:branches', safeHandler(async (_e: unknown, cwd: string) => {
    const svc = gitServiceManager.get(cwd)
    try {
      return await svc.getBranches()
    } finally {
      gitServiceManager.release(cwd)
    }
  }))

  ipcMain.handle('git:checkout', safeHandler(async (_e: unknown, cwd: string, branch: string) => {
    const svc = gitServiceManager.get(cwd)
    try {
      await svc.checkout(branch)
    } finally {
      gitServiceManager.release(cwd)
    }
  }))

  ipcMain.handle('git:create-branch', safeHandler(async (_e: unknown, cwd: string, name: string) => {
    const svc = gitServiceManager.get(cwd)
    try {
      await svc.createBranch(name)
    } finally {
      gitServiceManager.release(cwd)
    }
  }))

  ipcMain.handle('git:file-patch', safeHandler(async (_e: unknown, cwd: string, filePath: string, staged: boolean, ignoreWhitespace: boolean) => {
    const svc = gitServiceManager.get(cwd)
    try {
      return await svc.getFilePatch(filePath, staged, ignoreWhitespace)
    } finally {
      gitServiceManager.release(cwd)
    }
  }))

  ipcMain.handle('git:file-contents', safeHandler(async (_e: unknown, cwd: string, filePath: string, staged: boolean) => {
    const svc = gitServiceManager.get(cwd)
    try {
      return await svc.getFileContents(filePath, staged)
    } finally {
      gitServiceManager.release(cwd)
    }
  }))

  ipcMain.handle('git:stage-file', safeHandler(async (_e: unknown, cwd: string, filePath: string) => {
    const svc = gitServiceManager.get(cwd)
    try {
      await svc.stageFile(filePath)
    } finally {
      gitServiceManager.release(cwd)
    }
  }))

  ipcMain.handle('git:unstage-file', safeHandler(async (_e: unknown, cwd: string, filePath: string) => {
    const svc = gitServiceManager.get(cwd)
    try {
      await svc.unstageFile(filePath)
    } finally {
      gitServiceManager.release(cwd)
    }
  }))

  ipcMain.handle('git:discard-file', safeHandler(async (_e: unknown, cwd: string, filePath: string) => {
    const svc = gitServiceManager.get(cwd)
    try {
      await svc.discardFile(filePath)
    } finally {
      gitServiceManager.release(cwd)
    }
  }))

  ipcMain.handle('git:stage-all', safeHandler(async (_e: unknown, cwd: string) => {
    const svc = gitServiceManager.get(cwd)
    try {
      await svc.stageAll()
    } finally {
      gitServiceManager.release(cwd)
    }
  }))

  ipcMain.handle('git:unstage-all', safeHandler(async (_e: unknown, cwd: string) => {
    const svc = gitServiceManager.get(cwd)
    try {
      await svc.unstageAll()
    } finally {
      gitServiceManager.release(cwd)
    }
  }))

  ipcMain.handle('git:commit', safeHandler(async (_e: unknown, cwd: string, message: string) => {
    const svc = gitServiceManager.get(cwd)
    try {
      return await svc.commit(message)
    } finally {
      gitServiceManager.release(cwd)
    }
  }))

  ipcMain.handle('git:push', safeHandler(async (_e: unknown, cwd: string) => {
    const svc = gitServiceManager.get(cwd)
    try {
      await svc.push()
    } finally {
      gitServiceManager.release(cwd)
    }
  }))

  ipcMain.handle('git:push-with-upstream', safeHandler(async (_e: unknown, cwd: string, branch: string) => {
    const svc = gitServiceManager.get(cwd)
    try {
      await svc.pushWithUpstream(branch)
    } finally {
      gitServiceManager.release(cwd)
    }
  }))

  ipcMain.handle('git:pull', safeHandler(async (_e: unknown, cwd: string) => {
    const svc = gitServiceManager.get(cwd)
    try {
      return await svc.pull()
    } finally {
      gitServiceManager.release(cwd)
    }
  }))

  ipcMain.handle('git:fetch', safeHandler(async (_e: unknown, cwd: string) => {
    const svc = gitServiceManager.get(cwd)
    try {
      await svc.fetch()
    } finally {
      gitServiceManager.release(cwd)
    }
  }))

  // Git polling — persistent service per cwd
  const gitWatchers = new Map<string, { refCount: number }>()

  ipcMain.handle('git:start-watching', async (_e, cwd: string) => {
    const existing = gitWatchers.get(cwd)
    if (existing) {
      existing.refCount++
      return
    }
    gitWatchers.set(cwd, { refCount: 1 })
    const svc = gitServiceManager.get(cwd)
    svc.startPolling((status) => {
      if (!win.isDestroyed()) {
        win.webContents.send('git:status-update', { cwd, status })
      }
    }, 5000)
  })

  ipcMain.handle('git:stop-watching', async (_e, cwd: string) => {
    const entry = gitWatchers.get(cwd)
    if (!entry) return
    entry.refCount--
    if (entry.refCount <= 0) {
      gitWatchers.delete(cwd)
      const svc = gitServiceManager.getIfExists(cwd)
      svc?.stopPolling()
      gitServiceManager.release(cwd)
    }
  })

  // -------------------------------------------------------------------------
  // Worktree IPC handlers
  // -------------------------------------------------------------------------

  ipcMain.handle('worktree:create', safeHandler(async (_e: unknown, cwd: string, name: string) => {
    return await createWorktree(cwd, name)
  }))

  ipcMain.handle('worktree:status', safeHandler(async (_e: unknown, worktreePath: string, originalHead: string) => {
    return await getWorktreeStatus(worktreePath, originalHead)
  }))

  ipcMain.handle('worktree:remove', safeHandler(async (_e: unknown, worktreePath: string, branch: string, gitRoot: string) => {
    await removeWorktree(worktreePath, branch, gitRoot)
  }))

  ipcMain.handle('worktree:list', safeHandler(async (_e: unknown, cwd: string) => {
    return await listWorktrees(cwd)
  }))

  // Watch ~/.claude/projects/ for JSONL changes and notify renderer to refresh
  startProjectsWatcher(win)

  // Watch ~/.claude/ui/ config files for cross-instance sync
  startConfigWatcher(win)

  // Account usage polling (5hr / 7-day rate limits)
  usageFetcher.setWindow(win)
  // Apply saved refresh interval before starting
  const savedSettings = loadSettings() as Record<string, unknown>
  if (typeof savedSettings.usageRefreshSecs === 'number') {
    usageFetcher.setIntervalSecs(savedSettings.usageRefreshSecs)
  }
  // Apply saved session idle timeout
  if (typeof savedSettings.sessionTimeoutMins === 'number') {
    manager.setSessionTimeout(savedSettings.sessionTimeoutMins * 60 * 1000)
  }
  usageFetcher.startPolling()

  ipcMain.handle('usage:fetch', async () => {
    return usageFetcher.fetch()
  })

  // Block usage analytics
  blockUsageService.setWindow(win)
  blockUsageService.recalculate().catch((err) => { logger.error('BlockUsage', 'Initial recalculation failed', err) })

  ipcMain.handle('usage:fetch-block', async () => {
    return blockUsageService.getData() ?? (await blockUsageService.recalculate())
  })
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
  } catch (err) {
    logger.warn('ProjectsWatcher', 'Failed to watch projects directory', err)
  }
}

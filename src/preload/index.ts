import { contextBridge, ipcRenderer } from 'electron'
import type { ApprovalDecision, ClaudeAPI, PermissionSuggestion } from '../shared/types'

const api: ClaudeAPI = {
  platform: process.platform,
  pickFolder: () => ipcRenderer.invoke('session:pick-folder'),
  createSession: (routingId: string, cwd: string, effort?: string, resumeSessionId?: string, permissionMode?: string, model?: string) =>
    ipcRenderer.invoke('session:create', routingId, cwd, effort, resumeSessionId, permissionMode, model),
  rekeySession: (oldId: string, newId: string) =>
    ipcRenderer.invoke('session:rekey', oldId, newId),
  sendPrompt: (routingId: string, prompt: string, attachments?: Array<{ mediaType: string; base64Data: string; fileName?: string }>) =>
    ipcRenderer.invoke('session:send', routingId, prompt, attachments),
  cancelSession: (routingId: string) =>
    ipcRenderer.invoke('session:cancel', routingId),
  respondApproval: (routingId: string, requestId: string, decision: ApprovalDecision, answers?: Record<string, string>, updatedPermissions?: PermissionSuggestion[]) =>
    ipcRenderer.invoke('session:approval-response', routingId, requestId, decision, answers, updatedPermissions),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window:maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  listDirectories: () => ipcRenderer.invoke('session:list-directories'),
  loadSessionHistory: (sessionId: string, projectKey: string) =>
    ipcRenderer.invoke('session:load-history', sessionId, projectKey),
  loadSubagentHistory: (sessionId: string, projectKey: string, agentId: string) =>
    ipcRenderer.invoke('session:load-subagent-history', sessionId, projectKey, agentId),
  buildSubagentFileMap: (sessionId: string, projectKey: string, taskPrompts: Record<string, string>) =>
    ipcRenderer.invoke('session:build-subagent-file-map', sessionId, projectKey, taskPrompts),
  loadBackgroundOutput: (projectKey: string, taskId: string, outputFile?: string) =>
    ipcRenderer.invoke('session:load-background-output', projectKey, taskId, outputFile),

  onMessage: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('session:message', handler)
    return () => ipcRenderer.removeListener('session:message', handler)
  },
  onStreamEvent: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('session:stream', handler)
    return () => ipcRenderer.removeListener('session:stream', handler)
  },
  onApprovalRequest: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('session:approval-request', handler)
    return () => ipcRenderer.removeListener('session:approval-request', handler)
  },
  onStatus: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('session:status', handler)
    return () => ipcRenderer.removeListener('session:status', handler)
  },
  onResult: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('session:result', handler)
    return () => ipcRenderer.removeListener('session:result', handler)
  },
  onError: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('session:error', handler)
    return () => ipcRenderer.removeListener('session:error', handler)
  },
  onToolResult: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('session:tool-result', handler)
    return () => ipcRenderer.removeListener('session:tool-result', handler)
  },
  onTaskProgress: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('session:task-progress', handler)
    return () => ipcRenderer.removeListener('session:task-progress', handler)
  },
  onMaximizeChange: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, isMaximized: boolean): void => cb(isMaximized)
    ipcRenderer.on('window:maximized-change', handler)
    return () => ipcRenderer.removeListener('window:maximized-change', handler)
  },
  onTaskNotification: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('session:task-notification', handler)
    return () => ipcRenderer.removeListener('session:task-notification', handler)
  },
  onSubagentStream: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('session:subagent-stream', handler)
    return () => ipcRenderer.removeListener('session:subagent-stream', handler)
  },
  onSubagentMessage: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('session:subagent-message', handler)
    return () => ipcRenderer.removeListener('session:subagent-message', handler)
  },
  onSubagentMessageBatch: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('session:subagent-message-batch', handler)
    return () => ipcRenderer.removeListener('session:subagent-message-batch', handler)
  },
  onSubagentToolResult: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('session:subagent-tool-result', handler)
    return () => ipcRenderer.removeListener('session:subagent-tool-result', handler)
  },
  onSlashCommands: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('session:slash-commands', handler)
    return () => ipcRenderer.removeListener('session:slash-commands', handler)
  },
  onPermissionMode: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('session:permission-mode', handler)
    return () => ipcRenderer.removeListener('session:permission-mode', handler)
  },
  onBackgroundOutput: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('session:background-output', handler)
    return () => ipcRenderer.removeListener('session:background-output', handler)
  },
  onSandboxViolation: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('session:sandbox-violation', handler)
    return () => ipcRenderer.removeListener('session:sandbox-violation', handler)
  },
  watchBackground: (routingId: string, toolUseId: string) =>
    ipcRenderer.invoke('session:watch-background', routingId, toolUseId),
  unwatchBackground: (routingId: string, toolUseId: string) =>
    ipcRenderer.invoke('session:unwatch-background', routingId, toolUseId),
  readBackgroundRange: (routingId: string, toolUseId: string, offset: number, length: number) =>
    ipcRenderer.invoke('session:read-background-range', routingId, toolUseId, offset, length),
  stopTask: (routingId: string, toolUseId: string) =>
    ipcRenderer.invoke('session:stop-task', routingId, toolUseId),
  dequeueMessage: (routingId: string, value: string) =>
    ipcRenderer.invoke('session:dequeue-message', routingId, value),
  onSteerConsumed: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('session:steer-consumed', handler)
    return () => ipcRenderer.removeListener('session:steer-consumed', handler)
  },
  setPermissionMode: (routingId: string, mode: string) =>
    ipcRenderer.invoke('session:set-permission-mode', routingId, mode),
  setModel: (routingId: string, model: string) =>
    ipcRenderer.invoke('session:set-model', routingId, model),
  setEffort: (routingId: string, effort: string) =>
    ipcRenderer.invoke('session:set-effort', routingId, effort),
  getModels: () => ipcRenderer.invoke('session:get-models'),
  generateTitle: (conversationText: string) =>
    ipcRenderer.invoke('session:generate-title', conversationText),
  generateCommitMessage: (diff: string) =>
    ipcRenderer.invoke('session:generate-commit-message', diff),
  writeCustomTitle: (sessionId: string, projectKey: string, title: string) =>
    ipcRenderer.invoke('session:write-custom-title', sessionId, projectKey, title),
  getPlanContent: (routingId: string) =>
    ipcRenderer.invoke('session:get-plan-content', routingId),
  getSessionLogPath: (routingId: string) =>
    ipcRenderer.invoke('session:get-session-log-path', routingId),
  watchSession: (routingId: string, sessionId: string, projectKey: string) =>
    ipcRenderer.invoke('session:watch-session', routingId, sessionId, projectKey),
  unwatchSession: (routingId: string) =>
    ipcRenderer.invoke('session:unwatch-session', routingId),
  onWatchUpdate: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('session:watch-update', handler)
    return () => ipcRenderer.removeListener('session:watch-update', handler)
  },
  onDirectoriesChanged: (cb) => {
    const handler = (): void => cb()
    ipcRenderer.on('session:directories-changed', handler)
    return () => ipcRenderer.removeListener('session:directories-changed', handler)
  },
  sendToTeammate: (routingId: string, sanitizedTeamName: string, sanitizedAgentName: string, message: string) =>
    ipcRenderer.invoke('session:send-to-teammate', routingId, sanitizedTeamName, sanitizedAgentName, message),
  broadcastToTeam: (routingId: string, sanitizedTeamName: string, sanitizedAgentNames: string[], message: string) =>
    ipcRenderer.invoke('session:broadcast-to-team', routingId, sanitizedTeamName, sanitizedAgentNames, message),
  getTeamInfo: (routingId: string) =>
    ipcRenderer.invoke('session:get-team-info', routingId),
  openTeamsViewWindow: (routingId: string) =>
    ipcRenderer.invoke('session:open-teams-view', routingId),
  onTeammateDetected: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('session:teammate-detected', handler)
    return () => ipcRenderer.removeListener('session:teammate-detected', handler)
  },
  onTeamCreated: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('session:team-created', handler)
    return () => ipcRenderer.removeListener('session:team-created', handler)
  },
  onTeamDeleted: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('session:team-deleted', handler)
    return () => ipcRenderer.removeListener('session:team-deleted', handler)
  },
  // Terminal (PTY) operations
  createTerminal: (cwd: string) => ipcRenderer.invoke('terminal:create', cwd),
  writeTerminal: (id: string, data: string) => ipcRenderer.invoke('terminal:write', id, data),
  resizeTerminal: (id: string, cols: number, rows: number) =>
    ipcRenderer.invoke('terminal:resize', id, cols, rows),
  killTerminal: (id: string) => ipcRenderer.invoke('terminal:kill', id),
  killTerminalsByCwd: (cwd: string) => ipcRenderer.invoke('terminal:kill-by-cwd', cwd),
  onTerminalData: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('terminal:data', handler)
    return () => ipcRenderer.removeListener('terminal:data', handler)
  },
  onTerminalExit: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('terminal:exit', handler)
    return () => ipcRenderer.removeListener('terminal:exit', handler)
  },

  // Worktree operations
  createWorktree: (cwd: string, name: string) => ipcRenderer.invoke('worktree:create', cwd, name),
  getWorktreeStatus: (worktreePath: string, originalHead: string) =>
    ipcRenderer.invoke('worktree:status', worktreePath, originalHead),
  removeWorktree: (worktreePath: string, branch: string, gitRoot: string) =>
    ipcRenderer.invoke('worktree:remove', worktreePath, branch, gitRoot),
  listWorktrees: (cwd: string) => ipcRenderer.invoke('worktree:list', cwd),

  // App lifecycle
  onBeforeQuit: (cb: () => void) => {
    const handler = (): void => cb()
    ipcRenderer.on('app:before-quit', handler)
    return () => ipcRenderer.removeListener('app:before-quit', handler)
  },
  confirmQuit: () => ipcRenderer.invoke('app:quit-confirm'),

  // Git operations
  gitCheckRepo: (cwd: string) => ipcRenderer.invoke('git:check-repo', cwd),
  gitGetStatus: (cwd: string) => ipcRenderer.invoke('git:status', cwd),
  gitGetBranches: (cwd: string) => ipcRenderer.invoke('git:branches', cwd),
  gitCheckout: (cwd: string, branch: string) => ipcRenderer.invoke('git:checkout', cwd, branch),
  gitCreateBranch: (cwd: string, name: string) => ipcRenderer.invoke('git:create-branch', cwd, name),
  gitGetFilePatch: (cwd: string, filePath: string, staged: boolean, ignoreWhitespace: boolean) =>
    ipcRenderer.invoke('git:file-patch', cwd, filePath, staged, ignoreWhitespace),
  gitGetFileContents: (cwd: string, filePath: string, staged: boolean) =>
    ipcRenderer.invoke('git:file-contents', cwd, filePath, staged),
  gitStageFile: (cwd: string, filePath: string) => ipcRenderer.invoke('git:stage-file', cwd, filePath),
  gitUnstageFile: (cwd: string, filePath: string) => ipcRenderer.invoke('git:unstage-file', cwd, filePath),
  gitDiscardFile: (cwd: string, filePath: string) => ipcRenderer.invoke('git:discard-file', cwd, filePath),
  gitStageAll: (cwd: string) => ipcRenderer.invoke('git:stage-all', cwd),
  gitUnstageAll: (cwd: string) => ipcRenderer.invoke('git:unstage-all', cwd),
  gitCommit: (cwd: string, message: string) => ipcRenderer.invoke('git:commit', cwd, message),
  gitPush: (cwd: string) => ipcRenderer.invoke('git:push', cwd),
  gitPushWithUpstream: (cwd: string, branch: string) => ipcRenderer.invoke('git:push-with-upstream', cwd, branch),
  gitPull: (cwd: string) => ipcRenderer.invoke('git:pull', cwd),
  gitFetch: (cwd: string) => ipcRenderer.invoke('git:fetch', cwd),
  gitStartWatching: (cwd: string) => ipcRenderer.invoke('git:start-watching', cwd),
  gitStopWatching: (cwd: string) => ipcRenderer.invoke('git:stop-watching', cwd),
  onGitStatusUpdate: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('git:status-update', handler)
    return () => ipcRenderer.removeListener('git:status-update', handler)
  },

  listDir: (dirPath: string) => ipcRenderer.invoke('file:list-dir', dirPath),
  openInVSCode: (cwd: string) => ipcRenderer.invoke('app:open-in-vscode', cwd),
  loadSettings: () => ipcRenderer.invoke('config:load-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('config:save-settings', settings),
  loadSessionConfig: () => ipcRenderer.invoke('config:load-sessions'),
  saveSessionConfig: (config) => ipcRenderer.invoke('config:save-sessions', config),
  loadSlashCommands: () => ipcRenderer.invoke('config:load-slash-commands'),
  saveSlashCommands: (commands) => ipcRenderer.invoke('config:save-slash-commands', commands),
  loadSkillDetails: (cwd: string) => ipcRenderer.invoke('config:load-skill-details', cwd),
  onSkills: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('session:skills', handler)
    return () => ipcRenderer.removeListener('session:skills', handler)
  },
  onStatusLine: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('session:status-line', handler)
    return () => ipcRenderer.removeListener('session:status-line', handler)
  },
  onSettingsChanged: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as Record<string, unknown>)
    ipcRenderer.on('config:settings-changed', handler)
    return () => ipcRenderer.removeListener('config:settings-changed', handler)
  },
  onSessionConfigChanged: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('config:sessions-changed', handler)
    return () => ipcRenderer.removeListener('config:sessions-changed', handler)
  },

  // Account usage (5hr / 7-day rate limits)
  fetchAccountUsage: () => ipcRenderer.invoke('usage:fetch'),
  onAccountUsage: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('usage:data', handler)
    return () => ipcRenderer.removeListener('usage:data', handler)
  },

  // Block usage analytics
  fetchBlockUsage: () => ipcRenderer.invoke('usage:fetch-block'),
  onBlockUsage: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('usage:block-data', handler)
    return () => ipcRenderer.removeListener('usage:block-data', handler)
  },

  // Claude permissions (allow/deny/ask rule management)
  loadClaudePermissions: (scope, cwd?) =>
    ipcRenderer.invoke('claude:load-permissions', scope, cwd),
  saveClaudePermissions: (scope, permissions, cwd?) =>
    ipcRenderer.invoke('claude:save-permissions', scope, permissions, cwd),

  // MCP server management
  mcpServerStatus: (routingId: string) =>
    ipcRenderer.invoke('mcp:status', routingId),
  mcpToggleServer: (routingId: string, serverName: string, enabled: boolean) =>
    ipcRenderer.invoke('mcp:toggle', routingId, serverName, enabled),
  mcpReconnectServer: (routingId: string, serverName: string) =>
    ipcRenderer.invoke('mcp:reconnect', routingId, serverName),
  mcpSetServers: (routingId: string, servers: Record<string, unknown>) =>
    ipcRenderer.invoke('mcp:set-servers', routingId, servers),
  loadMcpServers: (scope: string, cwd?: string) =>
    ipcRenderer.invoke('mcp:load-servers', scope, cwd),
  saveMcpServers: (scope: string, servers: Record<string, unknown>, cwd?: string) =>
    ipcRenderer.invoke('mcp:save-servers', scope, servers, cwd),
  mcpReadDisabled: (cwd: string) =>
    ipcRenderer.invoke('mcp:read-disabled', cwd),
  mcpToggleDisabled: (cwd: string, serverName: string, enabled: boolean) =>
    ipcRenderer.invoke('mcp:toggle-disabled', cwd, serverName, enabled),
  onMcpServers: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('session:mcp-servers', handler)
    return () => ipcRenderer.removeListener('session:mcp-servers', handler)
  },

  // Automation
  listAutomations: () => ipcRenderer.invoke('automation:list'),
  saveAutomation: (automation) => ipcRenderer.invoke('automation:save', automation),
  deleteAutomation: (id: string) => ipcRenderer.invoke('automation:delete', id),
  runAutomationNow: (id: string) => ipcRenderer.invoke('automation:run-now', id),
  toggleAutomation: (id: string, enabled: boolean) => ipcRenderer.invoke('automation:toggle', id, enabled),
  listAutomationRuns: (automationId: string) => ipcRenderer.invoke('automation:list-runs', automationId),
  loadAutomationRunHistory: (automationId: string, runId: string) =>
    ipcRenderer.invoke('automation:load-run-history', automationId, runId),
  cancelAutomationRun: (id: string) => ipcRenderer.invoke('automation:cancel', id),
  dismissAutomationRun: (automationId: string, runId: string) =>
    ipcRenderer.invoke('automation:dismiss-run', automationId, runId),
  sendAutomationMessage: (id: string, prompt: string) => ipcRenderer.invoke('automation:send-message', id, prompt),
  onAutomationRunUpdate: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('automation:run-update', handler)
    return () => ipcRenderer.removeListener('automation:run-update', handler)
  },
  onAutomationsChanged: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('automation:changed', handler)
    return () => ipcRenderer.removeListener('automation:changed', handler)
  },
  onAutomationRunMessage: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('automation:run-message', handler)
    return () => ipcRenderer.removeListener('automation:run-message', handler)
  },
  onAutomationStreamEvent: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('automation:stream-event', handler)
    return () => ipcRenderer.removeListener('automation:stream-event', handler)
  },
  onAutomationProcessing: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on('automation:processing', handler)
    return () => ipcRenderer.removeListener('automation:processing', handler)
  },

  logError: (source: string, message: string) => {
    ipcRenderer.send('log:error', source, message)
  }
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('api', api)
} else {
  // @ts-expect-error global augmentation
  window.api = api
}

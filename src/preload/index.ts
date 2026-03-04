import { contextBridge, ipcRenderer } from 'electron'
import type { ApprovalDecision, ClaudeAPI, PermissionSuggestion } from '../shared/types'

/**
 * Factory for IPC event handler registration.
 * Forwards all arguments from ipcRenderer.on (after the IpcRendererEvent) to the callback.
 */
function onEvent<T extends (...args: never[]) => void>(channel: string): (cb: T) => () => void {
  return (cb: T) => {
    const handler = (_: Electron.IpcRendererEvent, ...args: unknown[]): void => (cb as Function)(...args)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  }
}

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

  // Routed session events — each passes (routingId, data) as separate args
  onMessage: onEvent('session:message'),
  onStreamEvent: onEvent('session:stream'),
  onApprovalRequest: onEvent('session:approval-request'),
  onStatus: onEvent('session:status'),
  onResult: onEvent('session:result'),
  onError: onEvent('session:error'),
  onToolResult: onEvent('session:tool-result'),
  onTaskProgress: onEvent('session:task-progress'),
  onTaskNotification: onEvent('session:task-notification'),
  onSubagentStream: onEvent('session:subagent-stream'),
  onSubagentMessage: onEvent('session:subagent-message'),
  onSubagentMessageBatch: onEvent('session:subagent-message-batch'),
  onSubagentToolResult: onEvent('session:subagent-tool-result'),
  onSlashCommands: onEvent('session:slash-commands'),
  onPermissionMode: onEvent('session:permission-mode'),
  onBackgroundOutput: onEvent('session:background-output'),
  onSandboxViolation: onEvent('session:sandbox-violation'),
  onSteerConsumed: onEvent('session:steer-consumed'),
  onTeammateDetected: onEvent('session:teammate-detected'),
  onTeamCreated: onEvent('session:team-created'),
  onTeamDeleted: onEvent('session:team-deleted'),
  onSkills: onEvent('session:skills'),
  onStatusLine: onEvent('session:status-line'),
  onMcpServers: onEvent('session:mcp-servers'),

  // Non-routed events (no routingId prefix)
  onMaximizeChange: onEvent('window:maximized-change'),
  onWatchUpdate: onEvent('session:watch-update'),
  onDirectoriesChanged: onEvent('session:directories-changed'),
  onGitStatusUpdate: onEvent('git:status-update'),
  onSettingsChanged: onEvent('config:settings-changed'),
  onSessionConfigChanged: onEvent('config:sessions-changed'),
  onAccountUsage: onEvent('usage:data'),
  onBlockUsage: onEvent('usage:block-data'),
  onTerminalData: onEvent('terminal:data'),
  onTerminalExit: onEvent('terminal:exit'),
  onAutomationRunUpdate: onEvent('automation:run-update'),
  onAutomationsChanged: onEvent('automation:changed'),
  onAutomationRunMessage: onEvent('automation:run-message'),
  onAutomationStreamEvent: onEvent('automation:stream-event'),
  onAutomationProcessing: onEvent('automation:processing'),
  onBeforeQuit: onEvent('app:before-quit'),

  watchBackground: (routingId: string, toolUseId: string) =>
    ipcRenderer.invoke('session:watch-background', routingId, toolUseId),
  unwatchBackground: (routingId: string, toolUseId: string) =>
    ipcRenderer.invoke('session:unwatch-background', routingId, toolUseId),
  readBackgroundRange: (routingId: string, toolUseId: string, offset: number, length: number) =>
    ipcRenderer.invoke('session:read-background-range', routingId, toolUseId, offset, length),
  stopTask: (routingId: string, toolUseId: string) =>
    ipcRenderer.invoke('session:stop-task', routingId, toolUseId),
  backgroundTask: (routingId: string, toolUseId: string) =>
    ipcRenderer.invoke('session:background-task', routingId, toolUseId),
  dequeueMessage: (routingId: string, value: string) =>
    ipcRenderer.invoke('session:dequeue-message', routingId, value),
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
  sendToTeammate: (routingId: string, sanitizedTeamName: string, sanitizedAgentName: string, message: string) =>
    ipcRenderer.invoke('session:send-to-teammate', routingId, sanitizedTeamName, sanitizedAgentName, message),
  broadcastToTeam: (routingId: string, sanitizedTeamName: string, sanitizedAgentNames: string[], message: string) =>
    ipcRenderer.invoke('session:broadcast-to-team', routingId, sanitizedTeamName, sanitizedAgentNames, message),
  getTeamInfo: (routingId: string) =>
    ipcRenderer.invoke('session:get-team-info', routingId),
  openTeamsViewWindow: (routingId: string) =>
    ipcRenderer.invoke('session:open-teams-view', routingId),
  // Terminal (PTY) operations
  createTerminal: (cwd: string) => ipcRenderer.invoke('terminal:create', cwd),
  writeTerminal: (id: string, data: string) => ipcRenderer.invoke('terminal:write', id, data),
  resizeTerminal: (id: string, cols: number, rows: number) =>
    ipcRenderer.invoke('terminal:resize', id, cols, rows),
  killTerminal: (id: string) => ipcRenderer.invoke('terminal:kill', id),
  killTerminalsByCwd: (cwd: string) => ipcRenderer.invoke('terminal:kill-by-cwd', cwd),

  // Worktree operations
  createWorktree: (cwd: string, name: string) => ipcRenderer.invoke('worktree:create', cwd, name),
  getWorktreeStatus: (worktreePath: string, originalHead: string) =>
    ipcRenderer.invoke('worktree:status', worktreePath, originalHead),
  removeWorktree: (worktreePath: string, branch: string, gitRoot: string) =>
    ipcRenderer.invoke('worktree:remove', worktreePath, branch, gitRoot),
  listWorktrees: (cwd: string) => ipcRenderer.invoke('worktree:list', cwd),

  // App lifecycle
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

  listDir: (dirPath: string) => ipcRenderer.invoke('file:list-dir', dirPath),
  openInVSCode: (cwd: string) => ipcRenderer.invoke('app:open-in-vscode', cwd),
  loadSettings: () => ipcRenderer.invoke('config:load-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('config:save-settings', settings),
  loadSessionConfig: () => ipcRenderer.invoke('config:load-sessions'),
  saveSessionConfig: (config) => ipcRenderer.invoke('config:save-sessions', config),
  loadSlashCommands: () => ipcRenderer.invoke('config:load-slash-commands'),
  saveSlashCommands: (commands) => ipcRenderer.invoke('config:save-slash-commands', commands),
  loadSkillDetails: (cwd: string) => ipcRenderer.invoke('config:load-skill-details', cwd),

  // Account usage (5hr / 7-day rate limits)
  fetchAccountUsage: () => ipcRenderer.invoke('usage:fetch'),

  // Block usage analytics
  fetchBlockUsage: () => ipcRenderer.invoke('usage:fetch-block'),

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

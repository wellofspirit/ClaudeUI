/**
 * WebSocket-backed implementation of ClaudeAPI.
 *
 * This is a mechanical translation of src/preload/index.ts — every
 * ipcRenderer.invoke becomes connection.invoke, every ipcRenderer.on
 * becomes an event listener registration. The remote server dispatches
 * to the same handler functions that IPC uses.
 */

import type { ApprovalDecision, ClaudeAPI, PermissionSuggestion } from '../shared/types'
import type { RemoteConnection } from './connection'

type Listener = (...args: unknown[]) => void

/**
 * Create event listener registration that mirrors preload's onEvent().
 * Events arrive via the connection's event handler.
 */
function createEventRegistry() {
  const listeners = new Map<string, Set<Listener>>()

  function on(channel: string) {
    return (cb: Listener): (() => void) => {
      if (!listeners.has(channel)) listeners.set(channel, new Set())
      listeners.get(channel)!.add(cb)
      return () => listeners.get(channel)?.delete(cb)
    }
  }

  function emit(channel: string, ...args: unknown[]): void {
    listeners.get(channel)?.forEach((cb) => {
      try { cb(...args) } catch { /* prevent one listener from breaking others */ }
    })
  }

  function clear(): void {
    listeners.clear()
  }

  return { on, emit, clear }
}

export function createWebSocketApi(connection: RemoteConnection): ClaudeAPI {
  const { on, emit } = createEventRegistry()

  // Wire up the connection's event handler to dispatch to registered listeners
  connection.setEventHandler((channel: string, ...args: unknown[]) => {
    emit(channel, ...args)
  })

  // Helper: invoke that mirrors preload's unwrap() for safeHandler envelopes
  async function unwrap<T>(channel: string, ...args: unknown[]): Promise<T> {
    const result = await connection.invoke(channel, ...args)
    if (result && typeof result === 'object' && 'ok' in result) {
      const envelope = result as { ok: boolean; data?: unknown; error?: string }
      if (!envelope.ok) throw new Error(envelope.error ?? `Remote ${channel} failed`)
      return envelope.data as T
    }
    return result as T
  }

  const api: ClaudeAPI = {
    platform: 'web',

    // Desktop-only: return null or no-op on web
    pickFolder: async () => {
      // Web can't open native dialogs — caller should provide a text input
      return null
    },

    createSession: (routingId, cwd, effort?, resumeSessionId?, permissionMode?, model?) =>
      connection.invoke('session:create', routingId, cwd, effort, resumeSessionId, permissionMode, model) as Promise<void>,

    rekeySession: (oldId, newId) =>
      connection.invoke('session:rekey', oldId, newId) as Promise<void>,

    sendPrompt: (routingId, prompt, attachments?) =>
      connection.invoke('session:send', routingId, prompt, attachments) as Promise<void>,

    cancelSession: (routingId) =>
      connection.invoke('session:cancel', routingId) as Promise<void>,

    respondApproval: (routingId: string, requestId: string, decision: ApprovalDecision, answers?: Record<string, string>, updatedPermissions?: PermissionSuggestion[]) =>
      connection.invoke('session:approval-response', routingId, requestId, decision, answers, updatedPermissions) as Promise<void>,

    // Window controls — no-op on web
    minimizeWindow: async () => {},
    maximizeWindow: async () => {},
    closeWindow: async () => {},

    listDirectories: () =>
      connection.invoke('session:list-directories') as Promise<ReturnType<ClaudeAPI['listDirectories']>>,

    loadSessionHistory: (sessionId, projectKey) =>
      connection.invoke('session:load-history', sessionId, projectKey) as Promise<ReturnType<ClaudeAPI['loadSessionHistory']>>,

    loadSubagentHistory: (sessionId, projectKey, agentId) =>
      connection.invoke('session:load-subagent-history', sessionId, projectKey, agentId) as Promise<ReturnType<ClaudeAPI['loadSubagentHistory']>>,

    buildSubagentFileMap: (sessionId, projectKey, taskPrompts) =>
      connection.invoke('session:build-subagent-file-map', sessionId, projectKey, taskPrompts) as Promise<ReturnType<ClaudeAPI['buildSubagentFileMap']>>,

    loadBackgroundOutput: (projectKey, taskId, outputFile?) =>
      connection.invoke('session:load-background-output', projectKey, taskId, outputFile) as Promise<ReturnType<ClaudeAPI['loadBackgroundOutput']>>,

    // Routed session events
    onSessionCreated: on('session:created') as ClaudeAPI['onSessionCreated'],
    onUserMessage: on('session:user-message') as ClaudeAPI['onUserMessage'],
    onMessage: on('session:message') as ClaudeAPI['onMessage'],
    onStreamEvent: on('session:stream') as ClaudeAPI['onStreamEvent'],
    onApprovalRequest: on('session:approval-request') as ClaudeAPI['onApprovalRequest'],
    onStatus: on('session:status') as ClaudeAPI['onStatus'],
    onResult: on('session:result') as ClaudeAPI['onResult'],
    onError: on('session:error') as ClaudeAPI['onError'],
    onToolResult: on('session:tool-result') as ClaudeAPI['onToolResult'],
    onTaskProgress: on('session:task-progress') as ClaudeAPI['onTaskProgress'],
    onTaskNotification: on('session:task-notification') as ClaudeAPI['onTaskNotification'],
    onSubagentStream: on('session:subagent-stream') as ClaudeAPI['onSubagentStream'],
    onSubagentMessage: on('session:subagent-message') as ClaudeAPI['onSubagentMessage'],
    onSubagentMessageBatch: on('session:subagent-message-batch') as ClaudeAPI['onSubagentMessageBatch'],
    onSubagentToolResult: on('session:subagent-tool-result') as ClaudeAPI['onSubagentToolResult'],
    onSlashCommands: on('session:slash-commands') as ClaudeAPI['onSlashCommands'],
    onPermissionMode: on('session:permission-mode') as ClaudeAPI['onPermissionMode'],
    onBackgroundOutput: on('session:background-output') as ClaudeAPI['onBackgroundOutput'],
    onSandboxViolation: on('session:sandbox-violation') as ClaudeAPI['onSandboxViolation'],
    onSteerConsumed: on('session:steer-consumed') as ClaudeAPI['onSteerConsumed'],
    onTeammateDetected: on('session:teammate-detected') as ClaudeAPI['onTeammateDetected'],
    onTeamCreated: on('session:team-created') as ClaudeAPI['onTeamCreated'],
    onTeamDeleted: on('session:team-deleted') as ClaudeAPI['onTeamDeleted'],
    onSkills: on('session:skills') as ClaudeAPI['onSkills'],
    onStatusLine: on('session:status-line') as ClaudeAPI['onStatusLine'],
    onMcpServers: on('session:mcp-servers') as ClaudeAPI['onMcpServers'],

    // Non-routed events
    onMaximizeChange: on('window:maximized-change') as ClaudeAPI['onMaximizeChange'],
    onWatchUpdate: on('session:watch-update') as ClaudeAPI['onWatchUpdate'],
    onDirectoriesChanged: on('session:directories-changed') as ClaudeAPI['onDirectoriesChanged'],
    onGitStatusUpdate: on('git:status-update') as ClaudeAPI['onGitStatusUpdate'],
    onSettingsChanged: on('config:settings-changed') as ClaudeAPI['onSettingsChanged'],
    onSessionConfigChanged: on('config:sessions-changed') as ClaudeAPI['onSessionConfigChanged'],
    onAccountUsage: on('usage:data') as ClaudeAPI['onAccountUsage'],
    onBlockUsage: on('usage:block-data') as ClaudeAPI['onBlockUsage'],
    onTerminalData: on('terminal:data') as ClaudeAPI['onTerminalData'],
    onTerminalExit: on('terminal:exit') as ClaudeAPI['onTerminalExit'],
    onAutomationRunUpdate: on('automation:run-update') as ClaudeAPI['onAutomationRunUpdate'],
    onAutomationsChanged: on('automation:changed') as ClaudeAPI['onAutomationsChanged'],
    onAutomationRunMessage: on('automation:run-message') as ClaudeAPI['onAutomationRunMessage'],
    onAutomationStreamEvent: on('automation:stream-event') as ClaudeAPI['onAutomationStreamEvent'],
    onAutomationProcessing: on('automation:processing') as ClaudeAPI['onAutomationProcessing'],
    onBeforeQuit: on('app:before-quit') as ClaudeAPI['onBeforeQuit'],

    // Background task control
    watchBackground: (routingId, toolUseId) =>
      connection.invoke('session:watch-background', routingId, toolUseId) as Promise<void>,
    unwatchBackground: (routingId, toolUseId) =>
      connection.invoke('session:unwatch-background', routingId, toolUseId) as Promise<void>,
    readBackgroundRange: (routingId, toolUseId, offset, length) =>
      connection.invoke('session:read-background-range', routingId, toolUseId, offset, length) as Promise<string>,

    // Task control
    stopTask: (routingId, toolUseId) =>
      connection.invoke('session:stop-task', routingId, toolUseId) as Promise<{ success: boolean; error?: string }>,
    backgroundTask: (routingId, toolUseId) =>
      connection.invoke('session:background-task', routingId, toolUseId) as Promise<{ success: boolean; error?: string }>,
    dequeueMessage: (routingId, value) =>
      connection.invoke('session:dequeue-message', routingId, value) as Promise<{ removed: number }>,

    // Session settings
    setPermissionMode: (routingId, mode) =>
      connection.invoke('session:set-permission-mode', routingId, mode) as Promise<void>,
    setModel: (routingId, model) =>
      connection.invoke('session:set-model', routingId, model) as Promise<void>,
    setEffort: (routingId, effort) =>
      connection.invoke('session:set-effort', routingId, effort) as Promise<void>,
    getModels: () =>
      connection.invoke('session:get-models') as Promise<ReturnType<ClaudeAPI['getModels']>>,

    // Generation
    generateTitle: (conversationText) =>
      connection.invoke('session:generate-title', conversationText) as Promise<string | null>,
    generateCommitMessage: (diff) =>
      connection.invoke('session:generate-commit-message', diff) as Promise<string | null>,

    writeCustomTitle: (sessionId, projectKey, title) =>
      connection.invoke('session:write-custom-title', sessionId, projectKey, title) as Promise<void>,
    getPlanContent: (routingId) =>
      connection.invoke('session:get-plan-content', routingId) as Promise<string | null>,
    getSessionLogPath: (routingId) =>
      connection.invoke('session:get-session-log-path', routingId) as Promise<string | null>,

    // Watch
    watchSession: (routingId, sessionId, projectKey) =>
      connection.invoke('session:watch-session', routingId, sessionId, projectKey) as Promise<void>,
    unwatchSession: (routingId) =>
      connection.invoke('session:unwatch-session', routingId) as Promise<void>,

    // Team
    sendToTeammate: (routingId, sanitizedTeamName, sanitizedAgentName, message) =>
      connection.invoke('session:send-to-teammate', routingId, sanitizedTeamName, sanitizedAgentName, message) as Promise<void>,
    broadcastToTeam: (routingId, sanitizedTeamName, sanitizedAgentNames, message) =>
      connection.invoke('session:broadcast-to-team', routingId, sanitizedTeamName, sanitizedAgentNames, message) as Promise<void>,
    getTeamInfo: (routingId) =>
      connection.invoke('session:get-team-info', routingId) as Promise<ReturnType<ClaudeAPI['getTeamInfo']>>,
    openTeamsViewWindow: async () => {}, // No-op on web

    // Terminal — not available on web, return no-ops/empty
    createTerminal: async () => '',
    writeTerminal: async () => {},
    resizeTerminal: async () => {},
    killTerminal: async () => {},
    killTerminalsByCwd: async () => [],

    // Worktree — not available on web
    createWorktree: async () => { throw new Error('Worktrees not available in remote mode') },
    getWorktreeStatus: async () => { throw new Error('Worktrees not available in remote mode') },
    removeWorktree: async () => { throw new Error('Worktrees not available in remote mode') },
    listWorktrees: async () => [],

    // App lifecycle
    confirmQuit: async () => {}, // No-op on web

    // Git — route through remote server
    gitCheckRepo: (cwd) => unwrap('git:check-repo', cwd),
    gitGetStatus: (cwd) => unwrap('git:status', cwd),
    gitGetBranches: (cwd) => unwrap('git:branches', cwd),
    gitCheckout: (cwd, branch) => unwrap('git:checkout', cwd, branch),
    gitCreateBranch: (cwd, name) => unwrap('git:create-branch', cwd, name),
    gitGetFilePatch: (cwd, filePath, staged, ignoreWhitespace) =>
      unwrap('git:file-patch', cwd, filePath, staged, ignoreWhitespace),
    gitGetFileContents: (cwd, filePath, staged) =>
      unwrap('git:file-contents', cwd, filePath, staged),
    gitStageFile: (cwd, filePath) => unwrap('git:stage-file', cwd, filePath),
    gitUnstageFile: (cwd, filePath) => unwrap('git:unstage-file', cwd, filePath),
    gitDiscardFile: (cwd, filePath) => unwrap('git:discard-file', cwd, filePath),
    gitStageAll: (cwd) => unwrap('git:stage-all', cwd),
    gitUnstageAll: (cwd) => unwrap('git:unstage-all', cwd),
    gitCommit: (cwd, message) => unwrap('git:commit', cwd, message),
    gitPush: (cwd) => unwrap('git:push', cwd),
    gitPushWithUpstream: (cwd, branch) => unwrap('git:push-with-upstream', cwd, branch),
    gitPull: (cwd) => unwrap('git:pull', cwd),
    gitFetch: (cwd) => unwrap('git:fetch', cwd),
    gitStartWatching: async () => {}, // Git polling not supported in remote
    gitStopWatching: async () => {},

    // File ops
    listDir: (dirPath) =>
      connection.invoke('file:list-dir', dirPath) as Promise<ReturnType<ClaudeAPI['listDir']>>,
    openInVSCode: async () => {}, // No-op on web

    // Config
    loadSettings: () =>
      connection.invoke('config:load-settings') as Promise<ReturnType<ClaudeAPI['loadSettings']>>,
    saveSettings: (settings) => connection.invoke('config:save-settings', settings),
    loadSessionConfig: () =>
      connection.invoke('config:load-sessions') as Promise<ReturnType<ClaudeAPI['loadSessionConfig']>>,
    saveSessionConfig: (config) => connection.invoke('config:save-sessions', config),
    loadSlashCommands: () =>
      connection.invoke('config:load-slash-commands') as Promise<ReturnType<ClaudeAPI['loadSlashCommands']>>,
    saveSlashCommands: async () => {}, // Read-only
    loadSkillDetails: (cwd) =>
      connection.invoke('config:load-skill-details', cwd) as Promise<ReturnType<ClaudeAPI['loadSkillDetails']>>,

    // Usage
    fetchAccountUsage: () =>
      connection.invoke('usage:fetch') as Promise<ReturnType<ClaudeAPI['fetchAccountUsage']>>,
    fetchBlockUsage: () =>
      connection.invoke('usage:fetch-block') as Promise<ReturnType<ClaudeAPI['fetchBlockUsage']>>,

    // Claude permissions (read-only)
    loadClaudePermissions: (scope, cwd?) =>
      connection.invoke('claude:load-permissions', scope, cwd) as Promise<ReturnType<ClaudeAPI['loadClaudePermissions']>>,
    saveClaudePermissions: async () => {}, // Read-only

    // MCP
    mcpServerStatus: (routingId) =>
      connection.invoke('mcp:status', routingId) as Promise<ReturnType<ClaudeAPI['mcpServerStatus']>>,
    mcpToggleServer: async () => {}, // Not available in remote
    mcpReconnectServer: async () => {},
    mcpSetServers: async () => ({ added: [], removed: [], errors: {} }),
    loadMcpServers: (scope, cwd?) =>
      connection.invoke('mcp:load-servers', scope, cwd) as Promise<ReturnType<ClaudeAPI['loadMcpServers']>>,
    saveMcpServers: async () => {},
    mcpReadDisabled: (cwd) =>
      connection.invoke('mcp:read-disabled', cwd) as Promise<ReturnType<ClaudeAPI['mcpReadDisabled']>>,
    mcpToggleDisabled: async () => {},

    // Automation — not available on web
    listAutomations: async () => [],
    saveAutomation: async () => {},
    deleteAutomation: async () => {},
    runAutomationNow: async () => {},
    toggleAutomation: async () => {},
    listAutomationRuns: async () => [],
    loadAutomationRunHistory: async () => [],
    cancelAutomationRun: async () => {},
    dismissAutomationRun: async () => {},
    sendAutomationMessage: async () => {},

    // Remote access (not needed on the web client itself)
    getNetworkInterfaces: async () => [],
    startRemoteServer: async () => { throw new Error('Not available in remote mode') },
    stopRemoteServer: async () => {},
    getRemoteStatus: async () => ({ running: false, port: null, token: null, lanUrl: null, tunnelUrl: null, tunnelState: null, tunnelError: null, connectedClients: 0, clientIps: [] }),
    onRemoteStatus: () => () => {},

    // Error logging — send to server
    logError: (source, message) => {
      console.error(`[${source}]`, message)
    }
  }

  return api
}

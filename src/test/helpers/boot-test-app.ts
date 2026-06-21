/**
 * bootTestApp — Orchestrator for Layer 2 (component) and Layer 3 (E2E) tests.
 *
 * Wires main-process services + renderer store in a single Node/jsdom process.
 * Only two fakes: Electron transport (TestIpcBridge) and SDK (event generator stub).
 *
 * Usage in test files:
 *
 *   // At top of test file, BEFORE any imports from main/:
 *   vi.mock('electron', () => import('../../test/stubs/electron-shim'))
 *   vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: sdkStub.queryFn }))
 *
 *   // In test:
 *   const app = await bootTestApp({ sdkEvents: textResponseSequence('session-1', 'Hello') })
 *   // ... use app.api, app.store, app.bridge
 */

import { TestIpcBridge } from '../bridges/test-ipc-bridge'
import { setIpcBridge } from '../stubs/electron-shim'
import type { ClaudeAPI } from '../../shared/types'

// Build a ClaudeAPI object backed by the bridge.
// This mirrors src/preload/index.ts but uses bridge.ipcRenderer instead of Electron's.
function buildTestApi(bridge: TestIpcBridge): ClaudeAPI {
  const { ipcRenderer } = bridge

  function onEvent<T extends (...args: never[]) => void>(channel: string): (cb: T) => () => void {
    return (cb: T) => {
      const handler = (_: unknown, ...args: unknown[]): void => (cb as Function)(...args)
      ipcRenderer.on(channel, handler)
      return () => {
        ipcRenderer.removeListener(channel, handler)
      }
    }
  }

  async function unwrap<T>(channel: string, ...args: unknown[]): Promise<T> {
    const result = await ipcRenderer.invoke(channel, ...args)
    if (result && typeof result === 'object' && 'ok' in result) {
      if (!(result as any).ok) throw new Error((result as any).error ?? `IPC ${channel} failed`)
      return (result as any).data as T
    }
    return result as T
  }

  return {
    platform: process.platform,
    pickFolder: () => ipcRenderer.invoke('session:pick-folder'),
    createSession: (
      routingId,
      cwd,
      effort?,
      resumeSessionId?,
      permissionMode?,
      model?,
      thinkingMode?
    ) =>
      ipcRenderer.invoke(
        'session:create',
        routingId,
        cwd,
        effort,
        resumeSessionId,
        permissionMode,
        model,
        thinkingMode
      ),
    rekeySession: (oldId, newId) => ipcRenderer.invoke('session:rekey', oldId, newId),
    sendPrompt: (routingId, prompt, attachments?) =>
      ipcRenderer.invoke('session:send', routingId, prompt, attachments),
    cancelSession: (routingId) => ipcRenderer.invoke('session:cancel', routingId),
    interruptSession: (routingId) => ipcRenderer.invoke('session:interrupt', routingId),
    respondApproval: (routingId, requestId, decision, answers?, updatedPermissions?) =>
      ipcRenderer.invoke(
        'session:approval-response',
        routingId,
        requestId,
        decision,
        answers,
        updatedPermissions
      ),
    minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
    maximizeWindow: () => ipcRenderer.invoke('window:maximize'),
    closeWindow: () => ipcRenderer.invoke('window:close'),
    listDirectories: () => ipcRenderer.invoke('session:list-directories'),
    loadSessionHistory: (sessionId, projectKey) =>
      ipcRenderer.invoke('session:load-history', sessionId, projectKey),
    loadSubagentHistory: (sessionId, projectKey, agentId) =>
      ipcRenderer.invoke('session:load-subagent-history', sessionId, projectKey, agentId),
    buildSubagentFileMap: (sessionId, projectKey, taskPrompts) =>
      ipcRenderer.invoke('session:build-subagent-file-map', sessionId, projectKey, taskPrompts),
    loadBackgroundOutput: (projectKey, taskId, outputFile?) =>
      ipcRenderer.invoke('session:load-background-output', projectKey, taskId, outputFile),

    // Routed session events
    onSessionCreated: onEvent('session:created'),
    onUserMessage: onEvent('session:user-message'),
    onMessage: onEvent('session:message'),
    onStreamEvent: onEvent('session:stream'),
    onApprovalRequest: onEvent('session:approval-request'),
    onStatus: onEvent('session:status'),
    onResult: onEvent('session:result'),
    onError: onEvent('session:error'),
    onWarning: onEvent('session:warning'),
    onMessagesRetracted: onEvent('session:messages-retracted'),
    onToolResult: onEvent('session:tool-result'),
    onTaskProgress: onEvent('session:task-progress'),
    onTaskNotification: onEvent('session:task-notification'),
    onSubagentStream: onEvent('session:subagent-stream'),
    onSubagentMessage: onEvent('session:subagent-message'),
    onSubagentMessageBatch: onEvent('session:subagent-message-batch'),
    onSubagentToolResult: onEvent('session:subagent-tool-result'),
    onSlashCommands: onEvent('session:slash-commands'),
    onPermissionMode: onEvent('session:permission-mode'),
    onBashOutput: onEvent('session:bash-output'),
    onBackgroundOutput: onEvent('session:background-output'),
    onSandboxViolation: onEvent('session:sandbox-violation'),
    onSteerConsumed: onEvent('session:steer-consumed'),
    onSkills: onEvent('session:skills'),
    onAuthSource: onEvent('session:auth-source'),
    onStatusLine: onEvent('session:status-line'),
    onMcpServers: onEvent('session:mcp-servers'),
    onPlanSteps: onEvent('session:plan'),

    // Non-routed events
    onMaximizeChange: onEvent('window:maximized-change'),
    onWatchUpdate: onEvent('session:watch-update'),
    onDirectoriesChanged: onEvent('session:directories-changed'),
    onGitStatusUpdate: onEvent('git:status-update'),
    onSettingsChanged: onEvent('config:settings-changed'),
    onSessionConfigChanged: onEvent('config:sessions-changed'),
    onAccountUsage: onEvent('usage:data'),
    onBlockUsage: onEvent('usage:block-data'),
    onAuthState: onEvent('auth:state'),
    onAccountsChanged: onEvent('account:changed'),
    onAccountRespawnSessions: onEvent('account:respawn-sessions'),
    onTerminalData: onEvent('terminal:data'),
    onTerminalExit: onEvent('terminal:exit'),
    onAutomationRunUpdate: onEvent('automation:run-update'),
    onAutomationsChanged: onEvent('automation:changed'),
    onAutomationRunMessage: onEvent('automation:run-message'),
    onAutomationStreamEvent: onEvent('automation:stream-event'),
    onAutomationProcessing: onEvent('automation:processing'),
    onBeforeQuit: onEvent('app:before-quit'),

    watchBackground: (routingId, toolUseId) =>
      ipcRenderer.invoke('session:watch-background', routingId, toolUseId),
    unwatchBackground: (routingId, toolUseId) =>
      ipcRenderer.invoke('session:unwatch-background', routingId, toolUseId),
    readBackgroundRange: (routingId, toolUseId, offset, length) =>
      ipcRenderer.invoke('session:read-background-range', routingId, toolUseId, offset, length),
    stopTask: (routingId, toolUseId) =>
      ipcRenderer.invoke('session:stop-task', routingId, toolUseId),
    backgroundTask: (routingId, toolUseId) =>
      ipcRenderer.invoke('session:background-task', routingId, toolUseId),
    dequeueMessage: (routingId, value) =>
      ipcRenderer.invoke('session:dequeue-message', routingId, value),
    askSideQuestion: (routingId, question) =>
      ipcRenderer.invoke('session:ask-side-question', routingId, question),
    setPermissionMode: (routingId, mode) =>
      ipcRenderer.invoke('session:set-permission-mode', routingId, mode),
    setModel: (routingId, model) => ipcRenderer.invoke('session:set-model', routingId, model),
    setEffort: (routingId, effort) => ipcRenderer.invoke('session:set-effort', routingId, effort),
    setThinkingMode: (routingId, mode) =>
      ipcRenderer.invoke('session:set-thinking-mode', routingId, mode),
    getModels: () => ipcRenderer.invoke('session:get-models'),
    getEngineModels: () => ipcRenderer.invoke('session:get-engine-models'),
    generateTitle: (conversationText) =>
      ipcRenderer.invoke('session:generate-title', conversationText),
    generateCommitMessage: (diff) => ipcRenderer.invoke('session:generate-commit-message', diff),
    writeCustomTitle: (sessionId, projectKey, title) =>
      ipcRenderer.invoke('session:write-custom-title', sessionId, projectKey, title),
    getPlanContent: (routingId) => ipcRenderer.invoke('session:get-plan-content', routingId),
    getSessionLogPath: (routingId) => ipcRenderer.invoke('session:get-session-log-path', routingId),
    watchSession: (routingId, sessionId, projectKey) =>
      ipcRenderer.invoke('session:watch-session', routingId, sessionId, projectKey),
    unwatchSession: (routingId) => ipcRenderer.invoke('session:unwatch-session', routingId),

    // Terminal
    createTerminal: (cwd) => ipcRenderer.invoke('terminal:create', cwd),
    writeTerminal: (id, data) => ipcRenderer.invoke('terminal:write', id, data),
    resizeTerminal: (id, cols, rows) => ipcRenderer.invoke('terminal:resize', id, cols, rows),
    killTerminal: (id) => ipcRenderer.invoke('terminal:kill', id),
    killTerminalsByCwd: (cwd) => ipcRenderer.invoke('terminal:kill-by-cwd', cwd),

    // Worktree
    createWorktree: (cwd, name) => unwrap('worktree:create', cwd, name),
    getWorktreeStatus: (worktreePath, originalHead) =>
      unwrap('worktree:status', worktreePath, originalHead),
    removeWorktree: (worktreePath, branch, gitRoot) =>
      unwrap('worktree:remove', worktreePath, branch, gitRoot),
    listWorktrees: (cwd) => unwrap('worktree:list', cwd),

    // App
    confirmQuit: () => ipcRenderer.invoke('app:quit-confirm'),

    // Git
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
    gitStartWatching: (cwd) => unwrap('git:start-watching', cwd),
    gitStopWatching: (cwd) => unwrap('git:stop-watching', cwd),

    deleteSession: (sessionId, projectKey) =>
      ipcRenderer.invoke('session:delete-session', sessionId, projectKey),
    deleteProject: (projectKey) => ipcRenderer.invoke('session:delete-project', projectKey),

    listDir: (dirPath) => ipcRenderer.invoke('file:list-dir', dirPath),
    openInVSCode: (cwd) => ipcRenderer.invoke('app:open-in-vscode', cwd),
    loadSettings: () => ipcRenderer.invoke('config:load-settings'),
    saveSettings: (settings) => ipcRenderer.invoke('config:save-settings', settings),
    loadSessionConfig: () => ipcRenderer.invoke('config:load-sessions'),
    saveSessionConfig: (config) => ipcRenderer.invoke('config:save-sessions', config),
    loadSlashCommands: () => ipcRenderer.invoke('config:load-slash-commands'),
    saveSlashCommands: (commands) => ipcRenderer.invoke('config:save-slash-commands', commands),
    scanCustomCommands: (cwd) => ipcRenderer.invoke('config:scan-custom-commands', cwd),
    loadSkillDetails: (cwd) => ipcRenderer.invoke('config:load-skill-details', cwd),

    fetchAccountUsage: () => ipcRenderer.invoke('usage:fetch'),
    fetchBlockUsage: () => ipcRenderer.invoke('usage:fetch-block'),
    signIn: () => ipcRenderer.invoke('auth:sign-in'),
    submitOAuthCode: (code: string) => ipcRenderer.invoke('auth:submit-code', code),
    cancelSignIn: () => ipcRenderer.invoke('auth:cancel'),
    getAccounts: () => ipcRenderer.invoke('account:get'),
    setMultiAccountEnabled: (enabled: boolean) =>
      ipcRenderer.invoke('account:set-enabled', enabled),
    addAccount: () => ipcRenderer.invoke('account:add'),
    switchAccount: (id: string) => ipcRenderer.invoke('account:switch', id),
    deleteAccount: (id: string) => ipcRenderer.invoke('account:delete', id),

    loadClaudePermissions: (scope, cwd?) =>
      ipcRenderer.invoke('claude:load-permissions', scope, cwd),
    saveClaudePermissions: (scope, permissions, cwd?) =>
      ipcRenderer.invoke('claude:save-permissions', scope, permissions, cwd),

    mcpServerStatus: (routingId) => ipcRenderer.invoke('mcp:status', routingId),
    mcpToggleServer: (routingId, serverName, enabled) =>
      unwrap('mcp:toggle', routingId, serverName, enabled),
    mcpReconnectServer: (routingId, serverName) => unwrap('mcp:reconnect', routingId, serverName),
    mcpSetServers: (routingId, servers) => unwrap('mcp:set-servers', routingId, servers),
    loadMcpServers: (scope, cwd?) => ipcRenderer.invoke('mcp:load-servers', scope, cwd),
    saveMcpServers: (scope, servers, cwd?) =>
      ipcRenderer.invoke('mcp:save-servers', scope, servers, cwd),
    removeMcpServer: (scope, serverName, cwd?) =>
      ipcRenderer.invoke('mcp:remove-server', scope, serverName, cwd),
    mcpReadDisabled: (cwd) => ipcRenderer.invoke('mcp:read-disabled', cwd),
    mcpToggleDisabled: (cwd, serverName, enabled) =>
      ipcRenderer.invoke('mcp:toggle-disabled', cwd, serverName, enabled),

    listAutomations: () => ipcRenderer.invoke('automation:list'),
    saveAutomation: (automation) => ipcRenderer.invoke('automation:save', automation),
    deleteAutomation: (id) => ipcRenderer.invoke('automation:delete', id),
    runAutomationNow: (id) => ipcRenderer.invoke('automation:run-now', id),
    toggleAutomation: (id, enabled) => ipcRenderer.invoke('automation:toggle', id, enabled),
    listAutomationRuns: (automationId) => ipcRenderer.invoke('automation:list-runs', automationId),
    loadAutomationRunHistory: (automationId, runId) =>
      ipcRenderer.invoke('automation:load-run-history', automationId, runId),
    cancelAutomationRun: (id) => ipcRenderer.invoke('automation:cancel', id),
    dismissAutomationRun: (automationId, runId) =>
      ipcRenderer.invoke('automation:dismiss-run', automationId, runId),
    sendAutomationMessage: (id, prompt) =>
      ipcRenderer.invoke('automation:send-message', id, prompt),

    testProxyConnection: (proxy) => unwrap('proxy:test-connection', proxy),
    loadEngineConfig: (engineId) => ipcRenderer.invoke('config:load-engine-config', engineId),
    saveEngineConfig: (engineId, config) =>
      ipcRenderer.invoke('config:save-engine-config', engineId, config),
    loadVendorConfig: (vendorId) => ipcRenderer.invoke('config:load-vendor-config', vendorId),
    saveVendorConfig: (vendorId, config) =>
      ipcRenderer.invoke('config:save-vendor-config', vendorId, config),

    logError: (source, message) => {
      ipcRenderer.send('log:error', source, message)
    },

    getNetworkInterfaces: () => ipcRenderer.invoke('remote:interfaces'),
    startRemoteServer: (opts?) => ipcRenderer.invoke('remote:start', opts),
    stopRemoteServer: () => ipcRenderer.invoke('remote:stop'),
    getRemoteStatus: () => ipcRenderer.invoke('remote:status'),
    onRemoteStatus: onEvent('remote:status'),

    voiceStartServer: (routingId) => unwrap('voice:start-server', routingId),
    voiceStopServer: (routingId) => unwrap('voice:stop-server', routingId),
    voiceStartRecording: (routingId, language) =>
      unwrap('voice:start-recording', routingId, language),
    voiceStopRecording: (routingId) => unwrap('voice:stop-recording', routingId),
    onVoiceTranscript: onEvent('voice:transcript'),
    onVoiceState: onEvent('voice:state'),
    onVoiceError: onEvent('voice:error'),

    logRelay: (level, source, message) => ipcRenderer.send('log:relay', level, source, message),

    getVersionInfo: () => ipcRenderer.invoke('app:version-info'),
    openLogViewer: () => ipcRenderer.invoke('log-viewer:open'),

    listPlugins: () => ipcRenderer.invoke('plugin:list'),
    reloadPlugin: (id) => ipcRenderer.invoke('plugin:reload', id),
    getPluginViews: () => ipcRenderer.invoke('plugin:views'),
    getPluginPreloadPath: () => ipcRenderer.invoke('plugin:preload-path') as Promise<string>,
    onPluginViewsChanged: onEvent('plugin:views-changed'),

    // Mockup preview
    readMockupHtml: (cwd, directory) => unwrap('mockup:read-html', cwd, directory),
    watchMockup: (cwd, directory) => ipcRenderer.invoke('mockup:watch', cwd, directory),
    unwatchMockup: (cwd, directory) => ipcRenderer.invoke('mockup:unwatch', cwd, directory),
    onMockupFileChanged: onEvent('mockup:file-changed'),
    getMockupPreviewUrl: (cwd, directory) => `mockup-asset://test.m/${cwd}/${directory}`
  } as ClaudeAPI
}

export interface TestApp {
  bridge: TestIpcBridge
  api: ClaudeAPI
  /** Emit an event from main to renderer (simulates webContents.send) */
  emit: (channel: string, ...args: any[]) => void
  /** Cleanup — call in afterEach() */
  teardown: () => void
}

/**
 * Boot the test app. Sets up TestIpcBridge, wires it to electron shim,
 * and builds window.api.
 *
 * NOTE: The caller must set up vi.mock('electron') and vi.mock('@anthropic-ai/claude-agent-sdk')
 * BEFORE calling this function, since module mocks must be hoisted.
 */
export async function bootTestApp(): Promise<TestApp> {
  // 1. Create bridge and wire to electron shim
  const bridge = new TestIpcBridge()
  setIpcBridge(bridge)

  // 2. Register stub IPC handlers for channels the store uses internally.
  // These prevent "no handler registered" errors when store actions
  // call window.api.saveSessionConfig(), etc.
  const stubChannels = [
    'config:save-sessions',
    'config:save-settings',
    'config:load-settings',
    'config:load-sessions',
    'config:save-slash-commands',
    'config:load-slash-commands',
    'config:scan-custom-commands',
    'config:load-engine-config',
    'config:save-engine-config',
    'config:load-vendor-config',
    'config:save-vendor-config',
    'usage:fetch',
    'usage:fetch-block',
    'plugin:views',
    'log-viewer:open',
    'app:version-info'
  ]
  for (const channel of stubChannels) {
    bridge.ipcMain.handle(channel, async () => null)
  }

  // 3. Build window.api backed by bridge
  const api = buildTestApi(bridge)

  // Assign to globalThis.window.api for hooks/components that read it
  ;(globalThis as any).window = globalThis.window || {}
  ;(globalThis as any).window.api = api

  return {
    bridge,
    api,
    emit: (channel: string, ...args: any[]) => {
      bridge.webContents.send(channel, ...args)
    },
    teardown: () => {
      bridge.reset()
      delete (globalThis as any).window.api
    }
  }
}

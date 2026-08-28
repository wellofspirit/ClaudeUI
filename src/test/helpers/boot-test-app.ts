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
import { SyncClient } from '../../core/shared/sync/sync-client'
import { resetSyncClientForTests, onSyncEvent } from '../../core/shared/sync/client-registry'
import { installSyncSeam, resetSyncSeam, emitSync, nextSeq, advanceSeqTo } from './replica-seed'
import { channelSpec } from '../../core/shared/sync/channels'
import {
  startReplica,
  hydrateReplica,
  resetReplicaForTests
} from '../../renderer/src/stores/replica'
import type { SyncEventMap } from '../../core/shared/sync/events'
import type { FullStateSnapshot } from '../../shared/remote-protocol'
import type { ClaudeAPI } from '../../shared/types'

// Build a ClaudeAPI object backed by the bridge.
// This mirrors src/preload/index.ts but uses bridge.ipcRenderer instead of Electron's.
function buildTestApi(bridge: TestIpcBridge): ClaudeAPI {
  const { ipcRenderer } = bridge

  /**
   * HOST-LOCAL channels only — mirrors `src/preload/index.ts` since SyncCore
   * phase 4c. Replicated / volatile events reach the renderer through the
   * harness's `SyncClient` instead (see {@link TestApp.emit}).
   */
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
    resolveForkAnchor: (sessionId, cwd, messageId) =>
      ipcRenderer.invoke('session:resolve-fork-anchor', sessionId, cwd, messageId),
    loadOpencodeHistory: (sessionId) =>
      ipcRenderer.invoke('session:load-opencode-history', sessionId),
    listPiSessionsGlobal: () => ipcRenderer.invoke('session:list-pi'),
    loadPiHistory: (sessionId) => ipcRenderer.invoke('session:load-pi-history', sessionId),
    sendPrompt: (routingId, prompt, attachments?) =>
      ipcRenderer.invoke('session:send', routingId, prompt, attachments),
    cancelSession: (routingId) => ipcRenderer.invoke('session:cancel', routingId),
    clearConversation: (routingId, permissionMode) =>
      ipcRenderer.invoke('session:clear-conversation', routingId, permissionMode),
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
    listOpencodeSessionsGlobal: () => ipcRenderer.invoke('session:list-opencode'),
    loadSessionHistory: (sessionId, projectKey, resumeSessionAt) =>
      ipcRenderer.invoke('session:load-history', sessionId, projectKey, resumeSessionAt),
    loadSubagentHistory: (sessionId, projectKey, agentId) =>
      ipcRenderer.invoke('session:load-subagent-history', sessionId, projectKey, agentId),
    buildSubagentFileMap: (sessionId, projectKey, taskPrompts) =>
      ipcRenderer.invoke('session:build-subagent-file-map', sessionId, projectKey, taskPrompts),
    loadBackgroundOutput: (projectKey, taskId, outputFile?) =>
      ipcRenderer.invoke('session:load-background-output', projectKey, taskId, outputFile),

    // The sync transport is installed by bootTestApp itself, so there is no port
    // to acquire (mirrors the web adapter).
    acquireSyncPort: () => {},

    // Host-local events only — see the `onEvent` note.
    onMaximizeChange: onEvent('window:maximized-change'),
    onAuthState: onEvent('auth:state'),
    onAccountsChanged: onEvent('account:changed'),
    onAccountRespawnSessions: onEvent('account:respawn-sessions'),
    onTerminalData: onEvent('terminal:data'),
    onTerminalResized: onEvent('terminal:resized'),
    onTerminalExit: onEvent('terminal:exit'),
    onBeforeQuit: onEvent('app:before-quit'),

    watchBackground: (routingId, toolUseId) =>
      ipcRenderer.invoke('session:watch-background', routingId, toolUseId),
    unwatchBackground: (routingId, toolUseId) =>
      ipcRenderer.invoke('session:unwatch-background', routingId, toolUseId),
    readBackgroundRange: (routingId, toolUseId, offset, length) =>
      ipcRenderer.invoke('session:read-background-range', routingId, toolUseId, offset, length),
    stopTask: (routingId, toolUseId, isDispatch) =>
      ipcRenderer.invoke('session:stop-task', routingId, toolUseId, isDispatch),
    backgroundTask: (routingId, toolUseId) =>
      ipcRenderer.invoke('session:background-task', routingId, toolUseId),
    dequeueMessage: (routingId, value) =>
      ipcRenderer.invoke('session:dequeue-message', routingId, value),
    recallQueued: (routingId) => ipcRenderer.invoke('session:recall-queued', routingId),
    askSideQuestion: (routingId, question) =>
      ipcRenderer.invoke('session:ask-side-question', routingId, question),
    setPermissionMode: (routingId, mode) =>
      ipcRenderer.invoke('session:set-permission-mode', routingId, mode),
    setModel: (routingId, model) => ipcRenderer.invoke('session:set-model', routingId, model),
    setEffort: (routingId, effort) => ipcRenderer.invoke('session:set-effort', routingId, effort),
    setThinkingMode: (routingId, mode) =>
      ipcRenderer.invoke('session:set-thinking-mode', routingId, mode),
    setReasoningVariant: (routingId, variant) =>
      ipcRenderer.invoke('session:set-reasoning-variant', routingId, variant),
    getModels: () => ipcRenderer.invoke('session:get-models'),
    getEngineModels: () => ipcRenderer.invoke('session:get-engine-models'),
    getOpencodeProviders: () => ipcRenderer.invoke('session:get-opencode-providers'),
    setOpencodeProviderDisabled: (providerId, disabled) =>
      ipcRenderer.invoke('session:set-opencode-provider-disabled', providerId, disabled),
    removeOpencodeProvider: (providerId, kind) =>
      ipcRenderer.invoke('session:remove-opencode-provider', providerId, kind),
    getOpencodeProviderModels: (providerId) =>
      ipcRenderer.invoke('session:get-opencode-provider-models', providerId),
    getPiModelCatalogGroups: () => ipcRenderer.invoke('session:get-pi-model-catalog'),
    engineIsInstalled: (engineId) => ipcRenderer.invoke('engine:is-installed', engineId),
    getPiBinaryPath: () => ipcRenderer.invoke('pi:binary-path'),
    getPiAuthStatus: () => ipcRenderer.invoke('pi:auth-status'),
    generateTitle: (conversationText) =>
      ipcRenderer.invoke('session:generate-title', conversationText),
    generateCommitMessage: (diff) => ipcRenderer.invoke('session:generate-commit-message', diff),
    writeCustomTitle: (sessionId, projectKey, title) =>
      ipcRenderer.invoke('session:write-custom-title', sessionId, projectKey, title),
    getPlanContent: (routingId) => ipcRenderer.invoke('session:get-plan-content', routingId),
    getSessionLogPath: (routingId) => ipcRenderer.invoke('session:get-session-log-path', routingId),
    watchSession: (routingId, sessionId, projectKey, cwd) =>
      ipcRenderer.invoke('session:watch-session', routingId, sessionId, projectKey, cwd),
    unwatchSession: (routingId) => ipcRenderer.invoke('session:unwatch-session', routingId),

    // Terminal
    createTerminal: (cwd, index) => ipcRenderer.invoke('terminal:create', cwd, index),
    writeTerminal: (id, data) => ipcRenderer.invoke('terminal:write', id, data),
    resizeTerminal: (id, cols, rows) => ipcRenderer.invoke('terminal:resize', id, cols, rows),
    killTerminal: (id) => ipcRenderer.invoke('terminal:kill', id),
    killTerminalsByCwd: (cwd) => ipcRenderer.invoke('terminal:kill-by-cwd', cwd),
    terminalAvailability: () => ipcRenderer.invoke('terminal:availability'),
    terminalPool: (cwd) => ipcRenderer.invoke('terminal:pool', cwd),
    watchStreams: (sessionIds, automationIds) =>
      ipcRenderer.invoke('stream:watch', { sessionIds, automationRuns: automationIds }),
    // Mirrors preload: step-up is remote-only, but attach/detach are real on the
    // desktop transport too (the terminal pool means a tab can resolve to a pty
    // this surface never spawned, and attach is what replays its scrollback).
    terminalStepUp: async () => ({ ok: true }),
    terminalStepUpPasskey: async () => ({ ok: true }),
    attachTerminal: (id) => ipcRenderer.invoke('terminal:attach', id),
    detachTerminal: (id) => ipcRenderer.invoke('terminal:detach', id),
    onTerminalDetached: () => () => {},

    // Worktree
    createWorktree: (cwd, name) => unwrap('worktree:create', cwd, name),
    getWorktreeStatus: (worktreePath, originalHead) =>
      unwrap('worktree:status', worktreePath, originalHead),
    removeWorktree: (worktreePath, branch, gitRoot) =>
      unwrap('worktree:remove', worktreePath, branch, gitRoot),
    listWorktrees: (cwd) => unwrap('worktree:list', cwd),

    // App
    confirmQuit: () => ipcRenderer.invoke('app:quit-confirm'),
    cancelQuit: () => ipcRenderer.invoke('app:quit-cancel'),

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
    watchGit: (cwds) => unwrap('git:watch', { cwds }),

    deleteSession: (sessionId, projectKey, engineId?) =>
      ipcRenderer.invoke('session:delete-session', sessionId, projectKey, engineId),
    deleteProject: (projectKey) => ipcRenderer.invoke('session:delete-project', projectKey),

    listDir: (dirPath) => ipcRenderer.invoke('file:list-dir', dirPath),
    listPlaces: () => ipcRenderer.invoke('file:list-places'),
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
    setUsageAccountFilter: async () => {},
    refreshPrices: async () => ({ count: 0, refreshedAt: Date.now() }),
    fetchDispatchedUsage: () => ipcRenderer.invoke('usage:fetch-dispatched'),
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
    isWorkspaceTrusted: (cwd) => ipcRenderer.invoke('claude:workspace-trust', cwd),

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
    getCleanupPeriodDays: () => ipcRenderer.invoke('claude:get-cleanup-period'),
    setCleanupPeriodDays: (days) => ipcRenderer.invoke('claude:set-cleanup-period', days),

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
    vendorAuthProbe: async () => ({}),
    vendorAuthListOptions: async () => ({}),
    vendorAuthListKeys: async () => ({}),
    vendorAuthSetKey: async () => {},
    vendorAuthOauthAuthorize: async () => {
      throw new Error('Vendor auth not available in tests')
    },
    vendorAuthOauthCallback: async () => {
      throw new Error('Vendor auth not available in tests')
    },
    vendorAuthRemove: async () => {},
    vendorAuthOauthCancel: async () => {},
    loadEngineConfig: (engineId) => ipcRenderer.invoke('config:load-engine-config', engineId),
    saveEngineConfig: (engineId, config) =>
      ipcRenderer.invoke('config:save-engine-config', engineId, config),
    loadVendorConfig: (vendorId) => ipcRenderer.invoke('config:load-vendor-config', vendorId),
    saveVendorConfig: (vendorId, config) =>
      ipcRenderer.invoke('config:save-vendor-config', vendorId, config),
    loadOpencodeSettings: () => unwrap('config:load-opencode-settings'),
    saveOpencodeSettings: (settings) => unwrap('config:save-opencode-settings', settings),
    readOpencodeNativeRaw: async () => ({ config: {}, path: '' }),
    patchOpencodeNative: async () => {},
    readPiNativeRaw: async () => ({ config: {}, path: '', text: '' }),
    patchPiNative: async () => {},
    writePiNativeText: async () => {},
    readPiModelsRaw: async () => ({ config: {}, path: '', text: '', managedProviderIds: [] }),
    patchPiModels: async () => {},
    listOpencodeAgents: async () => [],
    readOpencodeAgent: async () => null,
    saveOpencodeAgent: async () => {},
    deleteOpencodeAgent: async () => {},
    setOpencodeAgentDisabled: async () => {},
    generateOpencodeAgent: async () => ({ identifier: '', whenToUse: '', systemPrompt: '' }),

    logError: (source, message) => {
      ipcRenderer.send('log:error', source, message)
    },

    getNetworkInterfaces: () => ipcRenderer.invoke('remote:interfaces'),
    startRemoteServer: (opts?) => ipcRenderer.invoke('remote:start', opts),
    stopRemoteServer: () => ipcRenderer.invoke('remote:stop'),
    getRemoteStatus: () => ipcRenderer.invoke('remote:status'),
    onRemoteStatus: onEvent('remote:status'),
    getRemoteStatusView: () => ipcRenderer.invoke('remote:status-view'),
    getRemoteConfig: () => ipcRenderer.invoke('remote:get-config'),
    setRemoteConfig: (partial) => ipcRenderer.invoke('remote:set-config', partial),
    setRemotePassword: (password) => ipcRenderer.invoke('remote:set-password', password),
    clearRemotePassword: () => ipcRenderer.invoke('remote:clear-password'),
    detectTailscale: () => ipcRenderer.invoke('remote:tailscale-detect'),
    forceReserve: () => ipcRenderer.invoke('remote:force-reserve'),

    // Remote-access settings (ADR-054 §6) — real desktop channels, like the
    // preload's. The desktop connection is the host anchor and is exempt from
    // the settings-session gate, so they behave here as `remote:set-config` does.
    authcfgApply: (patch) => ipcRenderer.invoke('authcfg:apply', patch),
    authcfgEnd: () => ipcRenderer.invoke('authcfg:end'),
    authcfgSetPassword: (password) => ipcRenderer.invoke('authcfg:set-password', password),
    authcfgLanLink: () => ipcRenderer.invoke('authcfg:lan-link'),
    authcfgRotateLanKey: () => ipcRenderer.invoke('authcfg:rotate-lan-key'),

    // Passkeys — mirrors the preload split: the four management verbs are real
    // desktop channels, the two ceremony verbs are not registered there at all.
    webauthnCredentials: () => ipcRenderer.invoke('webauthn:credentials'),
    webauthnRename: (credId, nickname) => ipcRenderer.invoke('webauthn:rename', credId, nickname),
    webauthnRevoke: (credId) => ipcRenderer.invoke('webauthn:revoke', credId),
    webauthnMintEnrollToken: () => ipcRenderer.invoke('webauthn:mint-enroll-token'),
    webauthnRegisterOptions: async () => {
      throw new Error('Passkey enrollment runs in a browser')
    },
    webauthnRegisterVerify: async () => {
      throw new Error('Passkey enrollment runs in a browser')
    },

    voiceStartServer: (routingId) => unwrap('voice:start-server', routingId),
    voiceStopServer: (routingId) => unwrap('voice:stop-server', routingId),
    voiceStartRecording: (routingId, language) =>
      unwrap('voice:start-recording', routingId, language),
    voiceStopRecording: (routingId) => unwrap('voice:stop-recording', routingId),
    onVoiceTranscript: onEvent('voice:transcript'),
    onVoiceState: onEvent('voice:state'),

    logRelay: (level, source, message) => ipcRenderer.send('log:relay', level, source, message),

    getVersionInfo: () => ipcRenderer.invoke('app:version-info'),
    listSharedProviders: () => unwrap('shared-provider:list'),
    getSharedProviderStatuses: () => unwrap('shared-provider:statuses'),
    listSharedProviderModels: (id) => unwrap('shared-provider:models', id),
    saveSharedProvider: (definition) => unwrap('shared-provider:save', definition),
    removeSharedProvider: (id) => unwrap('shared-provider:remove', id),
    setSharedProviderRoute: (id, harness, enabled) =>
      unwrap('shared-provider:set-route', id, harness, enabled),
    setSharedProviderApiKey: (id, key) => unwrap('shared-provider:set-key', id, key),
    syncSharedProvider: (id) => unwrap('shared-provider:sync', id),
    disconnectSharedProvider: (id) => unwrap('shared-provider:disconnect', id),
    setSharedProviderDefaultModel: (id, harness, modelId) =>
      unwrap('shared-provider:set-default', id, harness, modelId),
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
    getMockupPreviewUrl: (cwd, directory) => `mockup-asset://test.m/${cwd}/${directory}`
  } as ClaudeAPI
}

export interface TestApp {
  bridge: TestIpcBridge
  api: ClaudeAPI
  /**
   * Deliver one event from main to the renderer.
   *
   * Routes by channel CLASS, exactly as the production delivery adapter does
   * (`services/sync-host.ts`) — which is what makes this a seam rather than a
   * parallel universe:
   *
   *  - `host-local` → `bridge.webContents.send`, the targeted lane the preload's
   *    surviving `onEvent` listeners read;
   *  - replicated / volatile → the harness's real {@link SyncClient}, with an
   *    auto-incrementing seq, through the same `receiveEvent` path the MessagePort
   *    and WebSocket transports use.
   *
   * The signature is unchanged from before SyncCore phase 4c, so existing
   * `app.emit('session:message', rid, msg)` call sites keep working — only the
   * plumbing underneath moved.
   */
  emit: (channel: string, ...args: any[]) => void
  /** The seq the next {@link TestApp.emit} of a ringed channel will carry. */
  nextSeq: () => number
  /**
   * Subscribe to a replicated / volatile channel, the way the renderer does.
   *
   * Tests that hand-wire handlers (the e2e flows mirror `useClaudeEvents`) use
   * this instead of `bridge.ipcRenderer.on`: those channels no longer travel on
   * the bridge at all.
   *
   * Overloaded: a literal channel name gets the typed `SyncEventMap` callback; a
   * `string` channel (an e2e harness building its own handler table in a loop)
   * falls through to the loose form.
   */
  onSync: {
    <K extends keyof SyncEventMap>(channel: K, cb: SyncEventMap[K]): () => void
    (channel: string, cb: (...args: any[]) => void): () => void
  }
  /** Hydrate the renderer from a full snapshot, as a `sync-full` frame would. */
  syncFull: (state: FullStateSnapshot, epoch?: string) => void
  /** The harness's sync client — installed in the shared registry at boot. */
  syncClient: SyncClient
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
  /** Re-broadcast a config save as its `config:*-changed` echo (assigned below). */
  let echo: (channel: string, args: unknown[]) => void = () => {}

  // 1. Create bridge and wire to electron shim
  const bridge = new TestIpcBridge()
  setIpcBridge(bridge)

  // 2. Register stub IPC handlers for channels the store uses internally.
  // These prevent "no handler registered" errors when store actions
  // call window.api.saveSessionConfig(), etc.
  //
  // The two config SAVES are not inert stubs: production echoes the saved payload
  // back as `config:sessions-changed` / `config:settings-changed`, and since
  // SyncCore phase 4c that echo reaches the client that saved (it is what makes
  // an optimistic registry write correctable). A harness that swallowed the echo
  // would let a regression in the echo path pass every test.
  const stubChannels = [
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
  bridge.ipcMain.handle('config:save-sessions', async (_e: unknown, config: unknown) => {
    echo('config:sessions-changed', [config])
    return null
  })
  bridge.ipcMain.handle('config:save-settings', async (_e: unknown, settings: unknown) => {
    echo('config:settings-changed', [settings])
    return null
  })

  // 3. Build window.api backed by bridge
  const api = buildTestApi(bridge)

  // Assign to globalThis.window.api for hooks/components that read it
  ;(globalThis as any).window = globalThis.window || {}
  ;(globalThis as any).window.api = api

  // 4. Install the sync transport seam (SyncCore phase 4c).
  //
  // A REAL SyncClient, not a stub: cursor discipline, gap detection and the
  // readiness gate are the properties phase 0 exists to guarantee, and a harness
  // that faked them would let a regression in any of the three pass every test.
  // The gate is opened immediately — a test asserting on state after `emit()`
  // cannot wait for a React effect to call `markSyncReady()`, and the ordering
  // that gate protects (listeners before ready) is covered by the sync-client
  // unit tests instead.
  resetSyncClientForTests()
  const syncClient = new SyncClient({
    // A gap in a test means the test emitted out of order; asking the harness for
    // a resync it cannot answer would hide that, so leave it loud-by-absence.
    requestResync: () => {}
  })
  // ONE seq counter for the harness and for `replica-seed`'s direct emitters: two
  // would manufacture gaps and trip the client's resync detection.
  installSyncSeam(syncClient)
  echo = emitSync

  // 5. Install the REPLICA (SyncCore phase 4c). The store's replicated slices are
  // the shared reducer's output now, so a harness that skipped this would show an
  // empty transcript for every `emit`. Reset first: the module holds a canonical
  // mirror for the page's lifetime and a test must not inherit the previous one.
  resetReplicaForTests()
  startReplica()
  let hasHydrated = false
  syncClient.setFullStateHandler((state) => {
    const isResync = hasHydrated
    hasHydrated = true
    hydrateReplica(state, isResync)
  })

  return {
    bridge,
    api,
    syncClient,
    nextSeq,
    emit: (channel: string, ...args: any[]) => {
      if (channelSpec(channel)?.cls === 'host-local') {
        bridge.webContents.send(channel, ...args)
        return
      }
      emitSync(channel, args)
    },
    onSync: ((channel: string, cb: (...args: any[]) => void) =>
      onSyncEvent(channel as keyof SyncEventMap, cb as never)) as TestApp['onSync'],
    syncFull: (state: FullStateSnapshot, epoch = 'test-epoch') => {
      // Keep the seam's cursor at or past the snapshot watermark, or the next
      // `emit` would look like a replay and be dropped.
      advanceSeqTo(state.seq)
      syncClient.applyFullState(state, epoch, state.seq)
    },
    teardown: () => {
      bridge.reset()
      resetSyncClientForTests()
      resetReplicaForTests()
      resetSyncSeam()
      delete (globalThis as any).window.api
    }
  }
}

import { contextBridge, ipcRenderer } from 'electron'
import type {
  ApprovalDecision,
  ClaudeAPI,
  PermissionSuggestion,
  ProxySettings
} from '../shared/types'
import { buildMockupUrl } from '../shared/mockup-url'

/**
 * Factory for IPC event handler registration.
 * Forwards all arguments from ipcRenderer.on (after the IpcRendererEvent) to the callback.
 *
 * **HOST-LOCAL channels only, as of SyncCore phase 4c.** Replicated and volatile
 * events no longer ride `webContents.send`: they arrive on the sync port and are
 * subscribed to in the renderer via `shared/sync/client-registry.onSyncEvent`.
 * What is left here is the host talking to its own shell — window chrome, the
 * native OAuth flow, voice capture, desktop PTY bytes, the log-viewer window,
 * plugin views, quit handshake — none of which a remote client has or wants.
 */
function onEvent<T extends (...args: never[]) => void>(channel: string): (cb: T) => () => void {
  return (cb: T) => {
    const handler = (_: Electron.IpcRendererEvent, ...args: unknown[]): void =>
      (cb as unknown as (...a: unknown[]) => void)(...args)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  }
}

// ---------------------------------------------------------------------------
// Sync port hand-off (SyncCore phase 4c)
// ---------------------------------------------------------------------------
//
// `MessagePort` is not a type `contextBridge` can marshal, so the preload takes
// delivery of the port and forwards it into the main world with
// `window.postMessage(..., [port])` — the transfer path Electron's own
// message-ports guide prescribes for exactly this. The renderer installs its
// `message` listener first and then calls `acquireSyncPort()`, so we hold the port
// until it is asked for: main can (and does) post it before the renderer's
// bundle has finished evaluating.

/** Must match `renderer/src/sync/desktop-transport.ts`. */
const SYNC_PORT_MESSAGE = 'claudeui:sync-port'

let heldSyncPort: Electron.MessagePortMain | MessagePort | null = null
let syncPortRequested = false

function forwardSyncPort(): void {
  if (!heldSyncPort || !syncPortRequested) return
  const port = heldSyncPort
  heldSyncPort = null
  window.postMessage(SYNC_PORT_MESSAGE, '*', [port as unknown as MessagePort])
}

ipcRenderer.on('sync-port', (event) => {
  // A reload gets a brand-new channel from main; if one was held un-acquired
  // (renderer never asked), it belongs to a document that is gone.
  heldSyncPort = event.ports[0] ?? null
  forwardSyncPort()
})

/**
 * Unwrap safeHandler's { ok, data, error } envelope.
 * Throws on { ok: false } so callers can .catch() as expected.
 */
async function unwrap<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = await ipcRenderer.invoke(channel, ...args)
  if (result && typeof result === 'object' && 'ok' in result) {
    if (!result.ok) throw new Error(result.error ?? `IPC ${channel} failed`)
    return result.data as T
  }
  return result as T
}

const api: ClaudeAPI = {
  platform: process.platform,
  pickFolder: () => ipcRenderer.invoke('session:pick-folder'),
  createSession: (
    routingId: string,
    cwd: string,
    effort?: string,
    resumeSessionId?: string,
    permissionMode?: string,
    model?: string,
    thinkingMode?: string,
    resumeSessionAt?: string,
    forkSession?: boolean,
    engineId?: import('../shared/types').EngineId
  ) =>
    ipcRenderer.invoke(
      'session:create',
      routingId,
      cwd,
      effort,
      resumeSessionId,
      permissionMode,
      model,
      thinkingMode,
      resumeSessionAt,
      forkSession,
      engineId
    ),
  resolveForkAnchor: (
    sessionId: string,
    cwd: string,
    messageId: string,
    engineId: import('../shared/types').EngineId,
    messageIndex: number
  ) =>
    ipcRenderer.invoke(
      'session:resolve-fork-anchor',
      sessionId,
      cwd,
      messageId,
      engineId,
      messageIndex
    ),
  sendPrompt: (
    routingId: string,
    prompt: string,
    attachments?: Array<{ mediaType: string; base64Data: string; fileName?: string }>
  ) => ipcRenderer.invoke('session:send', routingId, prompt, attachments),
  cancelSession: (routingId: string) => ipcRenderer.invoke('session:cancel', routingId),
  clearConversation: (routingId: string, permissionMode?: string) =>
    ipcRenderer.invoke('session:clear-conversation', routingId, permissionMode),
  interruptSession: (routingId: string) => ipcRenderer.invoke('session:interrupt', routingId),
  respondApproval: (
    routingId: string,
    requestId: string,
    decision: ApprovalDecision,
    answers?: Record<string, string>,
    updatedPermissions?: PermissionSuggestion[]
  ) =>
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
  loadOpencodeHistory: (sessionId: string) =>
    ipcRenderer.invoke('session:load-opencode-history', sessionId),
  listPiSessionsGlobal: () => ipcRenderer.invoke('session:list-pi'),
  loadPiHistory: (sessionId: string) => ipcRenderer.invoke('session:load-pi-history', sessionId),
  loadSessionHistory: (sessionId: string, projectKey: string, resumeSessionAt?: string) =>
    ipcRenderer.invoke('session:load-history', sessionId, projectKey, resumeSessionAt),
  loadSubagentHistory: (sessionId: string, projectKey: string, agentId: string) =>
    ipcRenderer.invoke('session:load-subagent-history', sessionId, projectKey, agentId),
  buildSubagentFileMap: (
    sessionId: string,
    projectKey: string,
    taskPrompts: Record<string, string>
  ) => ipcRenderer.invoke('session:build-subagent-file-map', sessionId, projectKey, taskPrompts),
  loadBackgroundOutput: (projectKey: string, taskId: string, outputFile?: string) =>
    ipcRenderer.invoke('session:load-background-output', projectKey, taskId, outputFile),

  // Sync transport (SyncCore phase 4c). Every replicated / volatile channel
  // arrives on the port, not here — see the `onEvent` doc comment.
  acquireSyncPort: () => {
    syncPortRequested = true
    forwardSyncPort()
  },

  // Host-local events: the host process talking to its own shell.
  onMaximizeChange: onEvent('window:maximized-change'),
  onAuthState: onEvent('auth:state'),
  onAccountsChanged: onEvent('account:changed'),
  onAccountRespawnSessions: onEvent('account:respawn-sessions'),
  onTerminalData: onEvent('terminal:data'),
  // Host-local like the bytes: the pty's geometry changed because some surface
  // refitted it (ADR-060). A narrow Electron window runs the MOBILE fork, which
  // mirrors the shared width rather than pushing its own, so the desktop
  // renderer needs this event too — it is not a remote-only concern.
  onTerminalResized: onEvent('terminal:resized'),
  onTerminalExit: onEvent('terminal:exit'),
  onBeforeQuit: onEvent('app:before-quit'),

  watchBackground: (routingId: string, toolUseId: string) =>
    ipcRenderer.invoke('session:watch-background', routingId, toolUseId),
  unwatchBackground: (routingId: string, toolUseId: string) =>
    ipcRenderer.invoke('session:unwatch-background', routingId, toolUseId),
  readBackgroundRange: (routingId: string, toolUseId: string, offset: number, length: number) =>
    ipcRenderer.invoke('session:read-background-range', routingId, toolUseId, offset, length),
  stopTask: (routingId: string, toolUseId: string, isDispatch?: boolean) =>
    ipcRenderer.invoke('session:stop-task', routingId, toolUseId, isDispatch),
  backgroundTask: (routingId: string, toolUseId: string) =>
    ipcRenderer.invoke('session:background-task', routingId, toolUseId),
  dequeueMessage: (routingId: string, value: string) =>
    ipcRenderer.invoke('session:dequeue-message', routingId, value),
  recallQueued: (routingId: string) => ipcRenderer.invoke('session:recall-queued', routingId),
  askSideQuestion: (routingId: string, question: string) =>
    ipcRenderer.invoke('session:ask-side-question', routingId, question),
  setPermissionMode: (routingId: string, mode: string) =>
    ipcRenderer.invoke('session:set-permission-mode', routingId, mode),
  setModel: (routingId: string, model: string) =>
    ipcRenderer.invoke('session:set-model', routingId, model),
  setEffort: (routingId: string, effort: string) =>
    ipcRenderer.invoke('session:set-effort', routingId, effort),
  setThinkingMode: (routingId: string, mode: string) =>
    ipcRenderer.invoke('session:set-thinking-mode', routingId, mode),
  setReasoningVariant: (routingId: string, variant: string | null) =>
    ipcRenderer.invoke('session:set-reasoning-variant', routingId, variant),
  getModels: () => ipcRenderer.invoke('session:get-models'),
  getEngineModels: () => ipcRenderer.invoke('session:get-engine-models'),
  getOpencodeProviders: () => ipcRenderer.invoke('session:get-opencode-providers'),
  setOpencodeProviderDisabled: (providerId: string, disabled: boolean) =>
    ipcRenderer.invoke('session:set-opencode-provider-disabled', providerId, disabled),
  removeOpencodeProvider: (providerId, kind) =>
    ipcRenderer.invoke('session:remove-opencode-provider', providerId, kind),
  getOpencodeProviderModels: (providerId: string) =>
    ipcRenderer.invoke('session:get-opencode-provider-models', providerId),
  getPiModelCatalogGroups: () => ipcRenderer.invoke('session:get-pi-model-catalog'),
  engineIsInstalled: (engineId) => ipcRenderer.invoke('engine:is-installed', engineId),
  getPiBinaryPath: () => ipcRenderer.invoke('pi:binary-path'),
  getPiAuthStatus: () => ipcRenderer.invoke('pi:auth-status'),
  generateTitle: (conversationText: string) =>
    ipcRenderer.invoke('session:generate-title', conversationText),
  generateCommitMessage: (diff: string) =>
    ipcRenderer.invoke('session:generate-commit-message', diff),
  writeCustomTitle: (sessionId: string, projectKey: string, title: string) =>
    ipcRenderer.invoke('session:write-custom-title', sessionId, projectKey, title),
  getPlanContent: (routingId: string) => ipcRenderer.invoke('session:get-plan-content', routingId),
  getSessionLogPath: (routingId: string) =>
    ipcRenderer.invoke('session:get-session-log-path', routingId),
  watchSession: (routingId: string, sessionId: string, projectKey: string, cwd?: string) =>
    ipcRenderer.invoke('session:watch-session', routingId, sessionId, projectKey, cwd),
  unwatchSession: (routingId: string) => ipcRenderer.invoke('session:unwatch-session', routingId),
  // Terminal (PTY) operations
  createTerminal: (cwd: string, index?: number) =>
    ipcRenderer.invoke('terminal:create', cwd, index),
  writeTerminal: (id: string, data: string) => ipcRenderer.invoke('terminal:write', id, data),
  resizeTerminal: (id: string, cols: number, rows: number) =>
    ipcRenderer.invoke('terminal:resize', id, cols, rows),
  killTerminal: (id: string) => ipcRenderer.invoke('terminal:kill', id),
  killTerminalsByCwd: (cwd: string) => ipcRenderer.invoke('terminal:kill-by-cwd', cwd),
  terminalAvailability: () => ipcRenderer.invoke('terminal:availability'),
  // Real IPC on desktop (unlike availability, which is a constant here): the
  // pool is main-process state, and the desktop is just as capable of reopening
  // a slot whose shell is still running as a phone is.
  terminalPool: (cwd: string) => ipcRenderer.invoke('terminal:pool', cwd),
  // The volatile lane's subscription verb (phase 5 S1). Real IPC on the desktop
  // too: the renderer is client #1 and its deltas ride the same watched lane a
  // phone's do — there is no privileged local path any more.
  watchStreams: (sessionIds: string[], automationIds?: string[]) =>
    ipcRenderer.invoke('stream:watch', { sessionIds, automationRuns: automationIds }),
  // Step-up is a REMOTE concept (SyncCore phase 2): the desktop renderer is the
  // host surface, already holding a non-decaying `shell` grant, so there is
  // nothing to step up to. Local no-op, deliberately not an IPC round trip.
  //
  // That covers the `settings` intent too (ADR-054 §6): the host anchor's editor
  // unlocks with no ceremony and has no TTL, so this answers `ok` with NO
  // `settingsSessionExpiresAt` — and the pane reads that absence as "no
  // countdown", which is the truth here rather than a missing field.
  terminalStepUp: async () => ({ ok: true }),
  // Same reasoning for the passkey factor: nothing to prove when you are the
  // host surface, and this renderer could not run a ceremony anyway (no RP ID
  // on `file://` — see the webauthn block below).
  terminalStepUpPasskey: async () => ({ ok: true }),
  // Attach/detach, by contrast, are REAL here now that terminals are a per-cwd
  // pool: a desktop tab can resolve to a pty another surface spawned, and the
  // attach is what replays that terminal's scrollback onto `terminal:data`.
  attachTerminal: (id: string) => ipcRenderer.invoke('terminal:attach', id),
  detachTerminal: (id: string) => ipcRenderer.invoke('terminal:detach', id),
  // Only the server drops attachments (policy flip, decay, backpressure), and
  // none of those apply to the host surface.
  onTerminalDetached: () => () => {},

  // Worktree operations — all use safeHandler
  createWorktree: (cwd: string, name: string) => unwrap('worktree:create', cwd, name),
  getWorktreeStatus: (worktreePath: string, originalHead: string) =>
    unwrap('worktree:status', worktreePath, originalHead),
  removeWorktree: (worktreePath: string, branch: string, gitRoot: string) =>
    unwrap('worktree:remove', worktreePath, branch, gitRoot),
  listWorktrees: (cwd: string) => unwrap('worktree:list', cwd),

  // App lifecycle
  confirmQuit: () => ipcRenderer.invoke('app:quit-confirm'),
  cancelQuit: () => ipcRenderer.invoke('app:quit-cancel'),

  // Git operations — all handlers use safeHandler, so unwrap the { ok, data } envelope
  gitCheckRepo: (cwd: string) => unwrap<boolean>('git:check-repo', cwd),
  gitGetStatus: (cwd: string) => unwrap('git:status', cwd),
  gitGetBranches: (cwd: string) => unwrap('git:branches', cwd),
  gitCheckout: (cwd: string, branch: string) => unwrap('git:checkout', cwd, branch),
  gitCreateBranch: (cwd: string, name: string) => unwrap('git:create-branch', cwd, name),
  gitGetFilePatch: (cwd: string, filePath: string, staged: boolean, ignoreWhitespace: boolean) =>
    unwrap('git:file-patch', cwd, filePath, staged, ignoreWhitespace),
  gitGetFileContents: (cwd: string, filePath: string, staged: boolean) =>
    unwrap('git:file-contents', cwd, filePath, staged),
  gitStageFile: (cwd: string, filePath: string) => unwrap('git:stage-file', cwd, filePath),
  gitUnstageFile: (cwd: string, filePath: string) => unwrap('git:unstage-file', cwd, filePath),
  gitDiscardFile: (cwd: string, filePath: string) => unwrap('git:discard-file', cwd, filePath),
  gitStageAll: (cwd: string) => unwrap('git:stage-all', cwd),
  gitUnstageAll: (cwd: string) => unwrap('git:unstage-all', cwd),
  gitCommit: (cwd: string, message: string) => unwrap('git:commit', cwd, message),
  gitPush: (cwd: string) => unwrap('git:push', cwd),
  gitPushWithUpstream: (cwd: string, branch: string) =>
    unwrap('git:push-with-upstream', cwd, branch),
  gitPull: (cwd: string) => unwrap('git:pull', cwd),
  gitFetch: (cwd: string) => unwrap('git:fetch', cwd),
  // Per-connection git interest (phase 5 S2): a REPLACE set, not a
  // start/stop pair. Real IPC on the desktop too — the renderer is one
  // connection among several and its interest joins the same union.
  watchGit: (cwds: string[]) => unwrap('git:watch', { cwds }),

  listDir: (dirPath: string) => ipcRenderer.invoke('file:list-dir', dirPath),
  listPlaces: () => ipcRenderer.invoke('file:list-places'),
  openInVSCode: (cwd: string) => ipcRenderer.invoke('app:open-in-vscode', cwd),
  openPath: (filePath: string) => ipcRenderer.invoke('shell:open-path', filePath),
  showInFolder: (filePath: string) => ipcRenderer.invoke('shell:show-in-folder', filePath),
  // `sessionKey` is ignored on the desktop transport (see FileAPI docs) — the
  // absolute path is all main needs, and main re-validates it.
  getSentFilePreview: (_sessionKey: string, filePath: string) =>
    ipcRenderer.invoke('file:sent-file-preview', filePath),
  loadSettings: () => ipcRenderer.invoke('config:load-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('config:save-settings', settings),
  loadSessionConfig: () => ipcRenderer.invoke('config:load-sessions'),
  saveSessionConfig: (config) => ipcRenderer.invoke('config:save-sessions', config),
  deleteSession: (
    sessionId: string,
    projectKey: string,
    engineId?: import('../shared/types').EngineId
  ) => unwrap<void>('session:delete-session', sessionId, projectKey, engineId),
  deleteProject: (projectKey: string) => unwrap<void>('session:delete-project', projectKey),
  loadSlashCommands: () => ipcRenderer.invoke('config:load-slash-commands'),
  saveSlashCommands: (commands) => ipcRenderer.invoke('config:save-slash-commands', commands),
  scanCustomCommands: (cwd: string) => ipcRenderer.invoke('config:scan-custom-commands', cwd),
  loadSkillDetails: (cwd: string) => ipcRenderer.invoke('config:load-skill-details', cwd),

  // Account usage (5hr / 7-day rate limits)
  fetchAccountUsage: () => ipcRenderer.invoke('usage:fetch'),

  // Block usage analytics
  fetchBlockUsage: () => ipcRenderer.invoke('usage:fetch-block'),
  setUsageAccountFilter: (account: string | null) =>
    ipcRenderer.invoke('usage:set-account-filter', account),

  // Cross-engine dispatched usage (ADR-033 M4-B)
  fetchDispatchedUsage: () => ipcRenderer.invoke('usage:fetch-dispatched'),

  // Native Anthropic OAuth (ADR-014)
  signIn: () => ipcRenderer.invoke('auth:sign-in'),
  submitOAuthCode: (code: string) => ipcRenderer.invoke('auth:submit-code', code),
  cancelSignIn: () => ipcRenderer.invoke('auth:cancel'),
  getAccounts: () => ipcRenderer.invoke('account:get'),
  setMultiAccountEnabled: (enabled: boolean) => ipcRenderer.invoke('account:set-enabled', enabled),
  addAccount: () => ipcRenderer.invoke('account:add'),
  switchAccount: (id: string) => ipcRenderer.invoke('account:switch', id),
  deleteAccount: (id: string) => ipcRenderer.invoke('account:delete', id),

  // Claude permissions (allow/deny/ask rule management)
  loadClaudePermissions: (scope, cwd?) => ipcRenderer.invoke('claude:load-permissions', scope, cwd),
  saveClaudePermissions: (scope, permissions, cwd?) =>
    ipcRenderer.invoke('claude:save-permissions', scope, permissions, cwd),
  isWorkspaceTrusted: (cwd) => ipcRenderer.invoke('claude:workspace-trust', cwd),

  // Transcript retention window (cleanupPeriodDays in ~/.claude/settings.json)
  getCleanupPeriodDays: () => ipcRenderer.invoke('claude:get-cleanup-period'),
  setCleanupPeriodDays: (days) => ipcRenderer.invoke('claude:set-cleanup-period', days),

  // MCP server management — toggle/reconnect/set-servers use safeHandler
  mcpServerStatus: (routingId: string) => ipcRenderer.invoke('mcp:status', routingId),
  mcpToggleServer: (routingId: string, serverName: string, enabled: boolean) =>
    unwrap('mcp:toggle', routingId, serverName, enabled),
  mcpReconnectServer: (routingId: string, serverName: string) =>
    unwrap('mcp:reconnect', routingId, serverName),
  mcpSetServers: (routingId: string, servers: Record<string, unknown>) =>
    unwrap('mcp:set-servers', routingId, servers),
  loadMcpServers: (scope: string, cwd?: string) =>
    ipcRenderer.invoke('mcp:load-servers', scope, cwd),
  saveMcpServers: (scope: string, servers: Record<string, unknown>, cwd?: string) =>
    ipcRenderer.invoke('mcp:save-servers', scope, servers, cwd),
  removeMcpServer: (scope: string, serverName: string, cwd?: string) =>
    ipcRenderer.invoke('mcp:remove-server', scope, serverName, cwd),
  mcpReadDisabled: (cwd: string) => ipcRenderer.invoke('mcp:read-disabled', cwd),
  mcpToggleDisabled: (cwd: string, serverName: string, enabled: boolean) =>
    ipcRenderer.invoke('mcp:toggle-disabled', cwd, serverName, enabled),

  // Automation
  listAutomations: () => ipcRenderer.invoke('automation:list'),
  saveAutomation: (automation) => ipcRenderer.invoke('automation:save', automation),
  deleteAutomation: (id: string) => ipcRenderer.invoke('automation:delete', id),
  runAutomationNow: (id: string) => ipcRenderer.invoke('automation:run-now', id),
  toggleAutomation: (id: string, enabled: boolean) =>
    ipcRenderer.invoke('automation:toggle', id, enabled),
  listAutomationRuns: (automationId: string) =>
    ipcRenderer.invoke('automation:list-runs', automationId),
  loadAutomationRunHistory: (automationId: string, runId: string) =>
    ipcRenderer.invoke('automation:load-run-history', automationId, runId),
  cancelAutomationRun: (id: string) => ipcRenderer.invoke('automation:cancel', id),
  dismissAutomationRun: (automationId: string, runId: string) =>
    ipcRenderer.invoke('automation:dismiss-run', automationId, runId),
  sendAutomationMessage: (id: string, prompt: string) =>
    ipcRenderer.invoke('automation:send-message', id, prompt),

  testProxyConnection: (proxy: ProxySettings) => unwrap('proxy:test-connection', proxy),

  // Engine-routed per-vendor auth (opencode multi-vendor auth, Phase 5c)
  vendorAuthProbe: (engineId: import('../shared/types').EngineId) =>
    unwrap('vendor-auth:probe', engineId),
  vendorAuthListOptions: (engineId: import('../shared/types').EngineId) =>
    unwrap('vendor-auth:list-options', engineId),
  vendorAuthListKeys: (engineId: import('../shared/types').EngineId) =>
    unwrap('vendor-auth:list-keys', engineId),
  vendorAuthSetKey: (engineId: import('../shared/types').EngineId, vendorId: string, key: string) =>
    unwrap('vendor-auth:set-key', engineId, vendorId, key),
  vendorAuthOauthAuthorize: (
    engineId: import('../shared/types').EngineId,
    vendorId: string,
    method: number,
    inputs?: Record<string, string>
  ) => unwrap('vendor-auth:oauth-authorize', engineId, vendorId, method, inputs),
  vendorAuthOauthCallback: (
    engineId: import('../shared/types').EngineId,
    vendorId: string,
    method: number,
    code?: string
  ) => unwrap('vendor-auth:oauth-callback', engineId, vendorId, method, code),
  vendorAuthRemove: (engineId: import('../shared/types').EngineId, vendorId: string) =>
    unwrap('vendor-auth:remove', engineId, vendorId),
  vendorAuthOauthCancel: (engineId: import('../shared/types').EngineId) =>
    unwrap('vendor-auth:oauth-cancel', engineId),

  loadEngineConfig: (engineId: string) => ipcRenderer.invoke('config:load-engine-config', engineId),
  saveEngineConfig: (engineId: string, config: import('../shared/types').EngineConfig) =>
    ipcRenderer.invoke('config:save-engine-config', engineId, config),
  loadOpencodeSettings: () => unwrap('config:load-opencode-settings'),
  saveOpencodeSettings: (settings: import('../shared/types').OpencodeConfigSettings) =>
    unwrap('config:save-opencode-settings', settings),
  readOpencodeNativeRaw: () => unwrap('config:read-opencode-native-raw'),
  patchOpencodeNative: (patches: import('../shared/types').RawConfigPatch[]) =>
    unwrap('config:patch-opencode-native', patches),
  readPiNativeRaw: () => unwrap('config:read-pi-native-raw'),
  patchPiNative: (patches: import('../shared/types').RawConfigPatch[]) =>
    unwrap('config:patch-pi-native', patches),
  writePiNativeText: (text: string) => unwrap('config:write-pi-native-text', text),
  readPiModelsRaw: () => unwrap('config:read-pi-models-raw'),
  patchPiModels: (patches: import('../shared/types').RawConfigPatch[]) =>
    unwrap('config:patch-pi-models', patches),
  listOpencodeAgents: (cwd?: string) => unwrap('opencode-agents:list', cwd),
  readOpencodeAgent: (
    name: string,
    scope: import('../shared/types').OpencodeAgentScope,
    cwd?: string
  ) => unwrap('opencode-agents:read', name, scope, cwd),
  saveOpencodeAgent: (input: import('../shared/types').OpencodeAgentInput, cwd?: string) =>
    unwrap('opencode-agents:save', input, cwd),
  deleteOpencodeAgent: (
    name: string,
    scope: import('../shared/types').OpencodeAgentScope,
    cwd?: string
  ) => unwrap('opencode-agents:delete', name, scope, cwd),
  setOpencodeAgentDisabled: (
    name: string,
    scope: import('../shared/types').OpencodeAgentScope,
    cwd: string | undefined,
    disabled: boolean
  ) => unwrap('opencode-agents:set-disabled', name, scope, cwd, disabled),
  generateOpencodeAgent: (description: string, cwd?: string) =>
    unwrap('opencode-agents:generate', description, cwd),
  loadVendorConfig: (vendorId: string) => ipcRenderer.invoke('config:load-vendor-config', vendorId),
  saveVendorConfig: (vendorId: string, config: import('../shared/types').VendorConfig) =>
    ipcRenderer.invoke('config:save-vendor-config', vendorId, config),
  listSharedProviders: () => unwrap('shared-provider:list'),
  getSharedProviderStatuses: () => unwrap('shared-provider:statuses'),
  listSharedProviderModels: (id: string) => unwrap('shared-provider:models', id),
  saveSharedProvider: (definition) => unwrap('shared-provider:save', definition),
  removeSharedProvider: (id: string) => unwrap('shared-provider:remove', id),
  setSharedProviderRoute: (id, harness, enabled) =>
    unwrap('shared-provider:set-route', id, harness, enabled),
  setSharedProviderApiKey: (id: string, key: string) => unwrap('shared-provider:set-key', id, key),
  syncSharedProvider: (id: string) => unwrap('shared-provider:sync', id),
  disconnectSharedProvider: (id: string) => unwrap('shared-provider:disconnect', id),
  setSharedProviderDefaultModel: (id, harness, modelId?) =>
    unwrap('shared-provider:set-default', id, harness, modelId),

  logError: (source: string, message: string) => {
    ipcRenderer.send('log:error', source, message)
  },

  // Remote access
  getNetworkInterfaces: () => ipcRenderer.invoke('remote:interfaces'),
  startRemoteServer: (opts?: { port?: number; host?: string }) =>
    ipcRenderer.invoke('remote:start', opts),
  stopRemoteServer: () => ipcRenderer.invoke('remote:stop'),
  getRemoteStatus: () => ipcRenderer.invoke('remote:status'),
  onRemoteStatus: onEvent('remote:status'),
  getRemoteConfig: () => ipcRenderer.invoke('remote:get-config'),
  setRemoteConfig: (partial) => ipcRenderer.invoke('remote:set-config', partial),
  setRemotePassword: (password: string) => ipcRenderer.invoke('remote:set-password', password),
  clearRemotePassword: () => ipcRenderer.invoke('remote:clear-password'),
  detectTailscale: () => ipcRenderer.invoke('remote:tailscale-detect'),
  forceReserve: () => ipcRenderer.invoke('remote:force-reserve'),

  // Remote-access settings, the ROUTINE subset (ADR-054 §6). Real IPC here
  // rather than a refusal: the channels are registered on BOTH transports
  // (authcfg.ipc.ts) precisely so the capability/kind declaration is one
  // reviewed fact, and the desktop connection — being the host anchor — is
  // exempt from the settings-session gate, so they behave here exactly as
  // `remote:set-config` does. The desktop pane nonetheless SAVES through
  // `setRemoteConfig`: it is the host path, and it is the only writer of the
  // `off` master switch (with its typed confirmation).
  authcfgApply: (patch) => ipcRenderer.invoke('authcfg:apply', patch),
  authcfgEnd: () => ipcRenderer.invoke('authcfg:end'),
  authcfgSetPassword: (password: string) => ipcRenderer.invoke('authcfg:set-password', password),
  // The LAN channel link + rotation (ADR-056). Session-gated on the web, free
  // here — the desktop connection IS the host anchor.
  authcfgLanLink: () => ipcRenderer.invoke('authcfg:lan-link'),
  authcfgRotateLanKey: () => ipcRenderer.invoke('authcfg:rotate-lan-key'),

  // Passkeys (ADR-052) — MANAGEMENT ONLY on this transport. `webauthn.ipc.ts`
  // registers exactly these four channels; the two register verbs below are
  // deliberately absent from it, so wiring them here would be an invoke against
  // a channel that does not exist.
  webauthnCredentials: () => ipcRenderer.invoke('webauthn:credentials'),
  webauthnRename: (credId: string, nickname: string | null) =>
    ipcRenderer.invoke('webauthn:rename', credId, nickname),
  webauthnRevoke: (credId: string) => ipcRenderer.invoke('webauthn:revoke', credId),
  webauthnMintEnrollToken: () => ipcRenderer.invoke('webauthn:mint-enroll-token'),
  // The ceremony verbs REFUSE here rather than round-tripping. The desktop
  // renderer loads from `file://` (or the vite dev origin), so it has no RP ID
  // to bind a credential to and `webauthnOrigin` is null on its connection —
  // there is no ceremony to run, and pretending otherwise would produce a
  // credential that can never assert. Desktop-side enrollment is the QR /
  // one-time-link flow (`webauthnMintEnrollToken` above).
  webauthnRegisterOptions: async () => {
    throw new Error('Passkey enrollment runs in a browser — use the enrollment link or QR code.')
  },
  webauthnRegisterVerify: async () => {
    throw new Error('Passkey enrollment runs in a browser — use the enrollment link or QR code.')
  },

  // Voice input
  voiceStartServer: (routingId: string) => unwrap('voice:start-server', routingId),
  voiceStopServer: (routingId: string) => unwrap('voice:stop-server', routingId),
  voiceStartRecording: (routingId: string, language: string) =>
    unwrap('voice:start-recording', routingId, language),
  voiceStopRecording: (routingId: string) => unwrap('voice:stop-recording', routingId),
  onVoiceTranscript: onEvent('voice:transcript'),
  onVoiceState: onEvent('voice:state'),

  // Renderer → main process log relay
  logRelay: (level: string, source: string, message: string) =>
    ipcRenderer.send('log:relay', level, source, message),

  // Version info
  getVersionInfo: () => ipcRenderer.invoke('app:version-info'),

  // Log viewer
  openLogViewer: () => ipcRenderer.invoke('log-viewer:open'),

  // Plugin system
  listPlugins: () => ipcRenderer.invoke('plugin:list'),
  reloadPlugin: (id: string) => ipcRenderer.invoke('plugin:reload', id),
  getPluginViews: () => ipcRenderer.invoke('plugin:views'),
  getPluginPreloadPath: () => ipcRenderer.invoke('plugin:preload-path') as Promise<string>,
  onPluginViewsChanged: onEvent('plugin:views-changed'),

  // Usage pricing refresh (Phase 9b — desktop-only, spawns local opencode server)
  refreshPrices: () => unwrap<{ count: number; refreshedAt: number }>('usage:refresh-prices'),

  // Mockup preview
  readMockupHtml: (cwd: string, directory: string) => unwrap('mockup:read-html', cwd, directory),
  watchMockup: (cwd: string, directory: string) =>
    ipcRenderer.invoke('mockup:watch', cwd, directory),
  unwatchMockup: (cwd: string, directory: string) =>
    ipcRenderer.invoke('mockup:unwatch', cwd, directory),
  getMockupPreviewUrl: (cwd: string, directory: string, opts?: { dark?: boolean }) =>
    buildMockupUrl(cwd, directory, { dark: opts?.dark, parentOrigin: window.location.origin })
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('api', api)
} else {
  // The augmentation now loads in this project too (src/shared/window-api.d.ts),
  // so the assignment typechecks and the suppression it needed is gone. The cast
  // is what remains necessary: `api` is a structural superset of `ClaudeAPI`.
  window.api = api as unknown as Window['api']
}

// Prime the main process with the markdown source of whatever was right-
// clicked (if any) before Electron emits its `context-menu` event.
// Synchronous IPC guarantees the value is in place by the time the native
// menu is built. Capture phase ensures we run before any in-renderer
// listener that might preventDefault.
window.addEventListener(
  'contextmenu',
  (event) => {
    const target = event.target as Element | null
    const el = target?.closest?.('[data-markdown-source]') as HTMLElement | null
    const source = el?.dataset.markdownSource ?? null
    try {
      ipcRenderer.sendSync('context-menu:set-markdown', source)
    } catch {
      // Main may not have registered yet (very early in startup) — ignore.
    }
  },
  { capture: true }
)

/**
 * The invoke surface of `ClaudeAPI`, declared once.
 *
 * The desktop preload (over `ipcRenderer`), the browser client (over a `RemoteConnection`) and
 * the test helper (over a test `ipcRenderer`) all used to restate the same
 * `name: (a, b) => invoke('channel', a, b)` per method. Each client now supplies a transport and
 * `buildInvokeApi` / `buildEventApi` build the pass-through members from the tables below; only
 * the genuinely client-specific members stay hand-written in each client.
 *
 * Wire contract: a built member puts exactly `arity` positional args on the transport, missing
 * ones `undefined` (the web client marshals them as JSON `null`, and the handlers rely on that,
 * see `core/ipc/wire-args.ts`), unless the entry shapes them with `wire`.
 *
 * Only methods that are the SAME call in the desktop and web clients are in `API_INVOKES`.
 * Methods the two transports do differently (desktop-only, web-only, another channel, local
 * computation, another envelope) are not; a member is in at most one table, which the clients'
 * `Omit<ClaudeAPI, ...>` hand-written half enforces at compile time.
 */

import type { ClaudeAPI } from './types'
import type { InvokeProgress } from './remote-protocol'

/** `invoke`: the raw result. `unwrap`: the `safeHandler` `{ ok, data, error }` envelope. */
export type InvokeMode = 'invoke' | 'unwrap'

export interface InvokeEntry {
  readonly channel: string
  /**
   * Number of positional args the client forwards. Checked at compile time against the
   * parameter count of the `ClaudeAPI` method ({@link InvokeTable}), so a new parameter cannot
   * be silently dropped.
   */
  readonly arity: number
  readonly mode: InvokeMode
  /**
   * Progress-capable (ADR-102). A number is the position of the `onProgress` parameter: with a
   * callback the call goes through the transport's progress call, without one it is a plain
   * invoke. `'always'` is a method declared `withProgress` that has no callback parameter: it
   * always rides the progress path, with a no-op callback, so the remote timeout can slide.
   */
  readonly progress?: number | 'always'
  /**
   * Shapes the wire args from the `arity` positional args (the progress slot included).
   * Default: the positional args minus the progress slot.
   */
  readonly wire?: (args: readonly unknown[]) => readonly unknown[]
}

/** What a client supplies to build its pass-through members. */
export interface InvokeTransport {
  /** Prefix of the error thrown for a `{ ok: false }` envelope without an `error` text. */
  readonly failurePrefix: string
  invoke(channel: string, args: readonly unknown[]): Promise<unknown>
  invokeWithProgress(
    channel: string,
    args: readonly unknown[],
    onProgress: (progress: InvokeProgress) => void
  ): Promise<unknown>
  /** Host-local event subscription: `on(channel)(cb)` registers, and returns the unsubscribe. */
  on(channel: string): EventSubscribe
}

export type EventSubscribe = (cb: never) => () => void

type ArityOf<K extends keyof ClaudeAPI> =
  NonNullable<ClaudeAPI[K]> extends (...args: infer P) => unknown ? Required<P>['length'] : never

/** The shape both invoke tables must satisfy: every key a `ClaudeAPI` method, `arity` its parameter count. */
export type InvokeTable = {
  readonly [K in keyof ClaudeAPI]?: InvokeEntry & { readonly arity: ArityOf<K> }
}

/** `wire` helper: an optional trailing array goes on the wire only when it names something. */
function whenNonEmpty(value: unknown): unknown[] {
  return (value as { length?: number } | null | undefined)?.length ? [value] : []
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/** Pass-through members that are the same call in the desktop and the web client. */
export const API_INVOKES = {
  addAccount: { channel: 'account:add', arity: 0, mode: 'invoke' },
  deleteAccount: { channel: 'account:delete', arity: 1, mode: 'invoke' },
  getAccounts: { channel: 'account:get', arity: 0, mode: 'invoke' },
  setMultiAccountEnabled: { channel: 'account:set-enabled', arity: 1, mode: 'invoke' },
  switchAccount: { channel: 'account:switch', arity: 1, mode: 'invoke' },
  getVersionInfo: { channel: 'app:version-info', arity: 0, mode: 'invoke' },
  cancelSignIn: { channel: 'auth:cancel', arity: 0, mode: 'invoke' },
  signIn: { channel: 'auth:sign-in', arity: 0, mode: 'invoke' },
  submitOAuthCode: { channel: 'auth:submit-code', arity: 1, mode: 'invoke' },
  authcfgApply: { channel: 'authcfg:apply', arity: 1, mode: 'invoke' },
  authcfgEnd: { channel: 'authcfg:end', arity: 0, mode: 'invoke' },
  authcfgLanLink: { channel: 'authcfg:lan-link', arity: 0, mode: 'invoke' },
  authcfgRotateLanKey: { channel: 'authcfg:rotate-lan-key', arity: 0, mode: 'invoke' },
  cancelAutomationRun: { channel: 'automation:cancel', arity: 1, mode: 'invoke' },
  deleteAutomation: { channel: 'automation:delete', arity: 1, mode: 'invoke' },
  dismissAutomationRun: { channel: 'automation:dismiss-run', arity: 2, mode: 'invoke' },
  listAutomations: { channel: 'automation:list', arity: 0, mode: 'invoke' },
  listAutomationRuns: { channel: 'automation:list-runs', arity: 1, mode: 'invoke' },
  loadAutomationRunHistory: { channel: 'automation:load-run-history', arity: 2, mode: 'invoke' },
  runAutomationNow: { channel: 'automation:run-now', arity: 1, mode: 'invoke' },
  saveAutomation: { channel: 'automation:save', arity: 1, mode: 'invoke' },
  sendAutomationMessage: { channel: 'automation:send-message', arity: 2, mode: 'invoke' },
  toggleAutomation: { channel: 'automation:toggle', arity: 2, mode: 'invoke' },
  judgeModelSupport: { channel: 'automode:judge-model-support', arity: 2, mode: 'invoke' },
  judgeRouteResting: { channel: 'automode:judge-route-resting', arity: 3, mode: 'invoke' },
  getBlob: { channel: 'blob:get', arity: 1, mode: 'invoke' },
  getCleanupPeriodDays: { channel: 'claude:get-cleanup-period', arity: 0, mode: 'invoke' },
  loadClaudePermissions: { channel: 'claude:load-permissions', arity: 2, mode: 'invoke' },
  saveClaudePermissions: { channel: 'claude:save-permissions', arity: 3, mode: 'invoke' },
  setCleanupPeriodDays: { channel: 'claude:set-cleanup-period', arity: 1, mode: 'invoke' },
  setClaudeDisableAutoMode: { channel: 'claude:set-disable-auto-mode', arity: 1, mode: 'invoke' },
  setWorkspaceTrust: { channel: 'claude:set-workspace-trust', arity: 2, mode: 'invoke' },
  getWorkspaceTrust: { channel: 'claude:workspace-trust', arity: 1, mode: 'invoke' },
  listAgentTypes: { channel: 'config:list-agent-types', arity: 2, mode: 'unwrap' },
  loadEngineConfig: { channel: 'config:load-engine-config', arity: 1, mode: 'invoke' },
  loadOpencodeSettings: { channel: 'config:load-opencode-settings', arity: 0, mode: 'unwrap' },
  loadSessionConfig: { channel: 'config:load-sessions', arity: 0, mode: 'invoke' },
  loadSettings: { channel: 'config:load-settings', arity: 0, mode: 'invoke' },
  loadSharedAutoMode: { channel: 'config:load-shared-automode', arity: 0, mode: 'invoke' },
  loadSkillDetails: { channel: 'config:load-skill-details', arity: 2, mode: 'invoke' },
  loadSlashCommands: { channel: 'config:load-slash-commands', arity: 0, mode: 'invoke' },
  loadVendorConfig: { channel: 'config:load-vendor-config', arity: 1, mode: 'invoke' },
  patchOpencodeNative: { channel: 'config:patch-opencode-native', arity: 1, mode: 'unwrap' },
  patchPiModels: { channel: 'config:patch-pi-models', arity: 1, mode: 'unwrap' },
  patchPiNative: { channel: 'config:patch-pi-native', arity: 1, mode: 'unwrap' },
  readOpencodeNativeRaw: { channel: 'config:read-opencode-native-raw', arity: 0, mode: 'unwrap' },
  readPiModelsRaw: { channel: 'config:read-pi-models-raw', arity: 0, mode: 'unwrap' },
  readPiNativeRaw: { channel: 'config:read-pi-native-raw', arity: 0, mode: 'unwrap' },
  saveEngineConfig: { channel: 'config:save-engine-config', arity: 2, mode: 'invoke' },
  saveOpencodeSettings: { channel: 'config:save-opencode-settings', arity: 2, mode: 'unwrap' },
  saveSessionConfig: { channel: 'config:save-sessions', arity: 1, mode: 'invoke' },
  saveSettings: { channel: 'config:save-settings', arity: 1, mode: 'invoke' },
  saveSharedAutoMode: { channel: 'config:save-shared-automode', arity: 1, mode: 'invoke' },
  saveSlashCommands: { channel: 'config:save-slash-commands', arity: 1, mode: 'invoke' },
  saveVendorConfig: { channel: 'config:save-vendor-config', arity: 2, mode: 'invoke' },
  setOpencodeToolDisabled: {
    channel: 'config:set-opencode-tool-disabled',
    arity: 2,
    mode: 'unwrap'
  },
  writePiNativeText: { channel: 'config:write-pi-native-text', arity: 1, mode: 'unwrap' },
  engineIsInstalled: { channel: 'engine:is-installed', arity: 1, mode: 'invoke' },
  listDir: { channel: 'file:list-dir', arity: 1, mode: 'invoke' },
  listPlaces: { channel: 'file:list-places', arity: 0, mode: 'invoke' },
  gitGetBranches: { channel: 'git:branches', arity: 1, mode: 'unwrap' },
  gitCheckRepo: { channel: 'git:check-repo', arity: 1, mode: 'unwrap' },
  gitCheckout: { channel: 'git:checkout', arity: 2, mode: 'unwrap' },
  gitCommit: { channel: 'git:commit', arity: 2, mode: 'unwrap' },
  gitCreateBranch: { channel: 'git:create-branch', arity: 3, mode: 'unwrap' },
  gitDiscardFile: { channel: 'git:discard-file', arity: 2, mode: 'unwrap' },
  gitFetch: { channel: 'git:fetch', arity: 1, mode: 'unwrap' },
  gitGetFileContents: { channel: 'git:file-contents', arity: 3, mode: 'unwrap' },
  gitGetFilePatch: { channel: 'git:file-patch', arity: 4, mode: 'unwrap' },
  gitPull: { channel: 'git:pull', arity: 2, mode: 'unwrap' },
  gitPush: { channel: 'git:push', arity: 1, mode: 'unwrap' },
  gitPushWithUpstream: { channel: 'git:push-with-upstream', arity: 2, mode: 'unwrap' },
  gitStageAll: { channel: 'git:stage-all', arity: 1, mode: 'unwrap' },
  gitStageFile: { channel: 'git:stage-file', arity: 2, mode: 'unwrap' },
  gitStashPush: { channel: 'git:stash-push', arity: 1, mode: 'unwrap' },
  gitStashRestore: { channel: 'git:stash-restore', arity: 2, mode: 'unwrap' },
  gitGetStatus: { channel: 'git:status', arity: 1, mode: 'unwrap' },
  gitUnstageAll: { channel: 'git:unstage-all', arity: 1, mode: 'unwrap' },
  gitUnstageFile: { channel: 'git:unstage-file', arity: 2, mode: 'unwrap' },
  watchGit: { channel: 'git:watch', arity: 1, mode: 'unwrap', wire: (a) => [{ cwds: a[0] }] },
  answerHarnessUpgradePrompt: {
    channel: 'harness:answer-upgrade-prompt',
    arity: 0,
    mode: 'invoke'
  },
  checkHarnessUpdates: { channel: 'harness:check-updates', arity: 0, mode: 'invoke' },
  detectHarnesses: {
    channel: 'harness:detect',
    arity: 1,
    mode: 'invoke',
    wire: (a) => [a[0] ? { ids: a[0] } : {}]
  },
  installHarness: {
    channel: 'harness:install',
    arity: 2,
    mode: 'invoke',
    wire: (a) => [{ id: a[0], version: a[1] }]
  },
  cancelHarnessInstall: {
    channel: 'harness:install-cancel',
    arity: 2,
    mode: 'invoke',
    wire: (a) => [{ id: a[0], version: a[1] }]
  },
  setHarnessSelection: {
    channel: 'harness:set-selection',
    arity: 2,
    mode: 'invoke',
    wire: (a) => [{ id: a[0], selection: a[1] }]
  },
  setHarnessUpdateMode: {
    channel: 'harness:set-update-mode',
    arity: 1,
    mode: 'invoke',
    wire: (a) => [{ mode: a[0] }]
  },
  harnessState: { channel: 'harness:state', arity: 0, mode: 'invoke' },
  updateHarnesses: { channel: 'harness:update-all', arity: 0, mode: 'invoke' },
  harnessVersions: {
    channel: 'harness:versions',
    arity: 1,
    mode: 'invoke',
    wire: (a) => [{ id: a[0] }]
  },
  ideAvailability: { channel: 'ide:availability', arity: 0, mode: 'invoke' },
  ideMintEntry: {
    channel: 'ide:mint-entry',
    arity: 2,
    mode: 'invoke',
    wire: (a) => [{ folder: a[0], themeKind: a[1] }]
  },
  mcpCliAdd: { channel: 'mcp:cli-add', arity: 4, mode: 'invoke' },
  mcpCliRemove: { channel: 'mcp:cli-remove', arity: 3, mode: 'invoke' },
  loadMcpCatalog: { channel: 'mcp:load-catalog', arity: 1, mode: 'invoke' },
  loadMcpServers: { channel: 'mcp:load-servers', arity: 2, mode: 'invoke' },
  mcpReadDisabled: { channel: 'mcp:read-disabled', arity: 1, mode: 'invoke' },
  mcpReconnectServer: { channel: 'mcp:reconnect', arity: 2, mode: 'unwrap' },
  mcpReloadServers: { channel: 'mcp:reload', arity: 2, mode: 'unwrap' },
  removeMcpServer: { channel: 'mcp:remove-server', arity: 3, mode: 'invoke' },
  saveMcpServers: { channel: 'mcp:save-servers', arity: 3, mode: 'invoke' },
  mcpSetServers: { channel: 'mcp:set-servers', arity: 2, mode: 'unwrap' },
  mcpServerStatus: { channel: 'mcp:status', arity: 1, mode: 'invoke' },
  mcpToggleServer: { channel: 'mcp:toggle', arity: 3, mode: 'unwrap' },
  mcpToggleDisabled: { channel: 'mcp:toggle-disabled', arity: 3, mode: 'invoke' },
  readMockupHtml: { channel: 'mockup:read-html', arity: 2, mode: 'unwrap' },
  unwatchMockup: { channel: 'mockup:unwatch', arity: 2, mode: 'invoke' },
  watchMockup: { channel: 'mockup:watch', arity: 2, mode: 'invoke' },
  setProviderModelAllowlist: { channel: 'models:set-provider-allowlist', arity: 3, mode: 'unwrap' },
  deleteOpencodeAgent: { channel: 'opencode-agents:delete', arity: 3, mode: 'unwrap' },
  generateOpencodeAgent: { channel: 'opencode-agents:generate', arity: 2, mode: 'unwrap' },
  listOpencodeAgents: { channel: 'opencode-agents:list', arity: 1, mode: 'unwrap' },
  readOpencodeAgent: { channel: 'opencode-agents:read', arity: 3, mode: 'unwrap' },
  saveOpencodeAgent: { channel: 'opencode-agents:save', arity: 2, mode: 'unwrap' },
  setOpencodeAgentDisabled: { channel: 'opencode-agents:set-disabled', arity: 4, mode: 'unwrap' },
  openrouterModelEndpoints: { channel: 'openrouter:model-endpoints', arity: 1, mode: 'unwrap' },
  openrouterModels: { channel: 'openrouter:models', arity: 1, mode: 'unwrap' },
  openrouterOverview: { channel: 'openrouter:overview', arity: 0, mode: 'unwrap' },
  openrouterStatus: { channel: 'openrouter:status', arity: 0, mode: 'unwrap' },
  getPiAuthStatus: { channel: 'pi:auth-status', arity: 0, mode: 'invoke' },
  getPiBinaryPath: { channel: 'pi:binary-path', arity: 0, mode: 'invoke' },
  listProviderAccounts: { channel: 'provider-account:list', arity: 1, mode: 'unwrap' },
  removeProviderAccount: { channel: 'provider-account:remove', arity: 2, mode: 'unwrap' },
  switchProviderAccount: { channel: 'provider-account:switch', arity: 2, mode: 'unwrap' },
  listProviderRegistry: { channel: 'provider-registry:list', arity: 0, mode: 'unwrap' },
  testProxyConnection: { channel: 'proxy:test-connection', arity: 1, mode: 'unwrap' },
  getRemoteStatusView: { channel: 'remote:status-view', arity: 0, mode: 'invoke' },
  allowPeerMessages: { channel: 'session:allow-peer-messages', arity: 1, mode: 'invoke' },
  respondApproval: { channel: 'session:approval-response', arity: 5, mode: 'invoke' },
  approveBlocked: { channel: 'session:approve-blocked', arity: 2, mode: 'invoke' },
  askSideQuestion: { channel: 'session:ask-side-question', arity: 2, mode: 'invoke' },
  backgroundTask: { channel: 'session:background-task', arity: 2, mode: 'invoke' },
  buildSubagentFileMap: { channel: 'session:build-subagent-file-map', arity: 3, mode: 'invoke' },
  cancelSession: { channel: 'session:cancel', arity: 1, mode: 'invoke' },
  clearConversation: { channel: 'session:clear-conversation', arity: 2, mode: 'invoke' },
  respondContextPressure: { channel: 'session:context-pressure:respond', arity: 2, mode: 'invoke' },
  createSession: { channel: 'session:create', arity: 2, mode: 'invoke' },
  deleteProject: { channel: 'session:delete-project', arity: 1, mode: 'unwrap' },
  deleteSession: { channel: 'session:delete-session', arity: 3, mode: 'unwrap' },
  dequeueMessage: { channel: 'session:dequeue-message', arity: 2, mode: 'invoke' },
  generateCommitMessage: { channel: 'session:generate-commit-message', arity: 1, mode: 'invoke' },
  generateTitle: { channel: 'session:generate-title', arity: 1, mode: 'invoke' },
  getEngineModels: { channel: 'session:get-engine-models', arity: 1, mode: 'invoke' },
  getModels: { channel: 'session:get-models', arity: 0, mode: 'invoke' },
  getOpencodeProviderModels: {
    channel: 'session:get-opencode-provider-models',
    arity: 1,
    mode: 'invoke'
  },
  getOpencodeProviders: { channel: 'session:get-opencode-providers', arity: 0, mode: 'invoke' },
  getPiModelCatalogGroups: { channel: 'session:get-pi-model-catalog', arity: 0, mode: 'invoke' },
  getPlanContent: { channel: 'session:get-plan-content', arity: 1, mode: 'invoke' },
  getSessionLogPath: { channel: 'session:get-session-log-path', arity: 1, mode: 'invoke' },
  interruptSession: { channel: 'session:interrupt', arity: 1, mode: 'invoke' },
  setSessionGrouped: { channel: 'session:link:set-grouped', arity: 2, mode: 'invoke' },
  listDirectories: { channel: 'session:list-directories', arity: 0, mode: 'invoke' },
  listOpencodeSessionsGlobal: { channel: 'session:list-opencode', arity: 0, mode: 'invoke' },
  listPiSessionsGlobal: { channel: 'session:list-pi', arity: 0, mode: 'invoke' },
  loadBackgroundOutput: { channel: 'session:load-background-output', arity: 3, mode: 'invoke' },
  loadSessionHistory: {
    channel: 'session:load-history',
    arity: 5,
    mode: 'invoke',
    progress: 3,
    wire: (a) => (a[4] ? [a[0], a[1], a[2], a[4]] : [a[0], a[1], a[2]])
  },
  loadOpencodeHistory: { channel: 'session:load-opencode-history', arity: 1, mode: 'invoke' },
  loadPiHistory: { channel: 'session:load-pi-history', arity: 1, mode: 'invoke' },
  loadSessionStatusLine: {
    channel: 'session:load-status-line',
    arity: 3,
    mode: 'invoke',
    progress: 2
  },
  loadSubagentHistory: { channel: 'session:load-subagent-history', arity: 3, mode: 'invoke' },
  dismissSessionProposal: { channel: 'session:proposal:dismiss', arity: 1, mode: 'invoke' },
  startSessionProposal: { channel: 'session:proposal:start', arity: 2, mode: 'invoke' },
  readBackgroundRange: { channel: 'session:read-background-range', arity: 4, mode: 'invoke' },
  recallQueued: { channel: 'session:recall-queued', arity: 1, mode: 'invoke' },
  removeOpencodeProvider: { channel: 'session:remove-opencode-provider', arity: 2, mode: 'invoke' },
  sendPrompt: { channel: 'session:send', arity: 3, mode: 'invoke' },
  setEffort: { channel: 'session:set-effort', arity: 2, mode: 'invoke' },
  setModel: { channel: 'session:set-model', arity: 2, mode: 'invoke' },
  setOpencodeProviderDisabled: {
    channel: 'session:set-opencode-provider-disabled',
    arity: 2,
    mode: 'invoke'
  },
  setPermissionMode: { channel: 'session:set-permission-mode', arity: 2, mode: 'invoke' },
  setReasoningVariant: { channel: 'session:set-reasoning-variant', arity: 2, mode: 'invoke' },
  setThinkingMode: { channel: 'session:set-thinking-mode', arity: 2, mode: 'invoke' },
  stopTask: { channel: 'session:stop-task', arity: 3, mode: 'invoke' },
  unwatchBackground: { channel: 'session:unwatch-background', arity: 2, mode: 'invoke' },
  unwatchSession: { channel: 'session:unwatch-session', arity: 1, mode: 'invoke' },
  watchBackground: { channel: 'session:watch-background', arity: 2, mode: 'invoke' },
  watchSession: { channel: 'session:watch-session', arity: 4, mode: 'invoke' },
  writeCustomTitle: { channel: 'session:write-custom-title', arity: 3, mode: 'invoke' },
  adoptSharedProviderNativeKey: {
    channel: 'shared-provider:adopt-native',
    arity: 2,
    mode: 'unwrap'
  },
  disconnectSharedProvider: { channel: 'shared-provider:disconnect', arity: 1, mode: 'unwrap' },
  getSharedProviderOwnKeyHolders: {
    channel: 'shared-provider:own-key-holders',
    arity: 1,
    mode: 'unwrap'
  },
  probeSharedEndpoint: { channel: 'shared-provider:probe', arity: 1, mode: 'unwrap' },
  removeSharedProvider: { channel: 'shared-provider:remove', arity: 1, mode: 'unwrap' },
  saveSharedProvider: { channel: 'shared-provider:save', arity: 1, mode: 'unwrap' },
  setSharedProviderCuration: { channel: 'shared-provider:set-curation', arity: 2, mode: 'unwrap' },
  setSharedProviderDefaultModel: {
    channel: 'shared-provider:set-default',
    arity: 3,
    mode: 'unwrap'
  },
  setSharedProviderDisabled: {
    channel: 'shared-provider:set-disabled',
    arity: 3,
    mode: 'unwrap',
    wire: (a) => [a[0], a[1], ...whenNonEmpty(a[2])]
  },
  setSharedProviderApiKey: {
    channel: 'shared-provider:set-key',
    arity: 3,
    mode: 'unwrap',
    wire: (a) => [a[0], a[1], ...whenNonEmpty(a[2])]
  },
  setSharedProviderRoute: { channel: 'shared-provider:set-route', arity: 3, mode: 'unwrap' },
  syncSharedProvider: { channel: 'shared-provider:sync', arity: 1, mode: 'unwrap' },
  useSharedProviderStoredKey: {
    channel: 'shared-provider:use-stored-key',
    arity: 2,
    mode: 'unwrap'
  },
  attachTerminal: { channel: 'terminal:attach', arity: 1, mode: 'invoke' },
  createTerminal: { channel: 'terminal:create', arity: 2, mode: 'invoke' },
  detachTerminal: { channel: 'terminal:detach', arity: 1, mode: 'invoke' },
  killTerminal: { channel: 'terminal:kill', arity: 1, mode: 'invoke' },
  terminalPool: { channel: 'terminal:pool', arity: 1, mode: 'invoke' },
  configureUsageHub: { channel: 'usage-hub:configure', arity: 1, mode: 'invoke' },
  forgetUsageHub: { channel: 'usage-hub:forget', arity: 0, mode: 'invoke' },
  resyncUsageHub: { channel: 'usage-hub:resync', arity: 0, mode: 'invoke' },
  setUsageHubSecret: { channel: 'usage-hub:set-secret', arity: 1, mode: 'invoke' },
  usageHubStatus: { channel: 'usage-hub:status', arity: 0, mode: 'invoke' },
  syncUsageHubNow: { channel: 'usage-hub:sync-now', arity: 0, mode: 'invoke' },
  fetchChatgptLimits: {
    channel: 'usage:chatgpt-limits',
    arity: 1,
    mode: 'invoke',
    wire: (a) => [a[0] ?? false]
  },
  fetchUsageDashboard: {
    channel: 'usage:dashboard',
    arity: 2,
    mode: 'invoke',
    wire: (a) => [{ range: a[0], scope: a[1] }]
  },
  fetchAccountUsage: { channel: 'usage:fetch', arity: 0, mode: 'invoke' },
  fetchBlockUsage: { channel: 'usage:fetch-block', arity: 0, mode: 'invoke' },
  fetchAccountLimits: {
    channel: 'usage:limits',
    arity: 1,
    mode: 'invoke',
    wire: (a) => [a[0] ?? false]
  },
  refreshPrices: { channel: 'usage:refresh-prices', arity: 0, mode: 'unwrap' },
  setUsageAccountFilter: { channel: 'usage:set-account-filter', arity: 1, mode: 'invoke' },
  fetchUsageWindows: {
    channel: 'usage:windows',
    arity: 1,
    mode: 'invoke',
    wire: (a) => [a[0] ?? {}]
  },
  vendorAuthDeviceCodeStart: { channel: 'vendor-auth:device-code-start', arity: 2, mode: 'unwrap' },
  vendorAuthDeviceCodeStatus: {
    channel: 'vendor-auth:device-code-status',
    arity: 1,
    mode: 'unwrap'
  },
  vendorAuthListKeys: { channel: 'vendor-auth:list-keys', arity: 1, mode: 'unwrap' },
  vendorAuthListOptions: { channel: 'vendor-auth:list-options', arity: 1, mode: 'unwrap' },
  vendorAuthOauthAuthorize: { channel: 'vendor-auth:oauth-authorize', arity: 4, mode: 'unwrap' },
  vendorAuthOauthCallback: { channel: 'vendor-auth:oauth-callback', arity: 4, mode: 'unwrap' },
  vendorAuthOauthCancel: { channel: 'vendor-auth:oauth-cancel', arity: 1, mode: 'unwrap' },
  vendorAuthProbe: { channel: 'vendor-auth:probe', arity: 1, mode: 'unwrap' },
  vendorAuthRemove: { channel: 'vendor-auth:remove', arity: 2, mode: 'unwrap' },
  vendorAuthSetKey: { channel: 'vendor-auth:set-key', arity: 3, mode: 'unwrap' },
  voicePackInstall: { channel: 'voice:pack-install', arity: 0, mode: 'invoke' },
  voicePackInstallCancel: { channel: 'voice:pack-install-cancel', arity: 0, mode: 'invoke' },
  voicePackRemove: { channel: 'voice:pack-remove', arity: 0, mode: 'invoke' },
  voicePackStatus: { channel: 'voice:pack-status', arity: 0, mode: 'invoke' },
  webauthnCredentials: { channel: 'webauthn:credentials', arity: 0, mode: 'invoke' },
  webauthnMintEnrollToken: { channel: 'webauthn:mint-enroll-token', arity: 0, mode: 'invoke' },
  webauthnRename: { channel: 'webauthn:rename', arity: 2, mode: 'invoke' },
  webauthnRevoke: { channel: 'webauthn:revoke', arity: 1, mode: 'invoke' },
  createWorktree: { channel: 'worktree:create', arity: 3, mode: 'unwrap', progress: 'always' },
  inspectWorktree: { channel: 'worktree:inspect', arity: 2, mode: 'unwrap' },
  inventoryWorktrees: { channel: 'worktree:inventory', arity: 1, mode: 'unwrap' },
  measureWorktree: { channel: 'worktree:measure', arity: 3, mode: 'unwrap', progress: 2 },
  removeWorktree: { channel: 'worktree:remove', arity: 3, mode: 'unwrap', progress: 'always' },
  removeWorktrees: { channel: 'worktree:remove-many', arity: 3, mode: 'unwrap', progress: 2 },
  getWorktreeStatus: { channel: 'worktree:status', arity: 2, mode: 'unwrap' }
} as const satisfies InvokeTable

/** Host-local `onX` subscriptions that are the same channel in the desktop and the web client. */
export const API_EVENTS = {
  onAccountRespawnSessions: 'account:respawn-sessions',
  onAccountsChanged: 'account:changed',
  onAuthState: 'auth:state',
  onBeforeQuit: 'app:before-quit',
  onMaximizeChange: 'window:maximized-change',
  onVoiceState: 'voice:state',
  onVoiceTranscript: 'voice:transcript'
} as const satisfies Partial<Record<keyof ClaudeAPI, string>>

/**
 * Pass-through members only the desktop transport serves: the preload and the test helper build
 * them, the web client keeps its own stubs, refusals or wire mechanisms. Includes the four
 * members whose envelope differs between the clients (`resolveForkAnchor`,
 * `listSharedProviders`, `getSharedProviderStatuses`, `listSharedProviderModels`): the entries
 * here are the desktop side exactly as it was, and the web client keeps its own.
 */
export const DESKTOP_INVOKES = {
  openInVSCode: { channel: 'app:open-in-vscode', arity: 1, mode: 'invoke' },
  cancelQuit: { channel: 'app:quit-cancel', arity: 0, mode: 'invoke' },
  confirmQuit: { channel: 'app:quit-confirm', arity: 1, mode: 'invoke', wire: (a) => [a[0] ?? []] },
  ackQuitPrompt: { channel: 'app:quit-prompting', arity: 0, mode: 'invoke' },
  authcfgSetPassword: { channel: 'authcfg:set-password', arity: 1, mode: 'invoke' },
  getSentFilePreview: {
    channel: 'file:sent-file-preview',
    arity: 2,
    mode: 'invoke',
    wire: (a) => [a[1]]
  },
  openLogViewer: { channel: 'log-viewer:open', arity: 0, mode: 'invoke' },
  listPlugins: { channel: 'plugin:list', arity: 0, mode: 'invoke' },
  getPluginPreloadPath: { channel: 'plugin:preload-path', arity: 0, mode: 'invoke' },
  reloadPlugin: { channel: 'plugin:reload', arity: 1, mode: 'invoke' },
  getPluginViews: { channel: 'plugin:views', arity: 0, mode: 'invoke' },
  clearRemotePassword: { channel: 'remote:clear-password', arity: 0, mode: 'invoke' },
  forceReserve: { channel: 'remote:force-reserve', arity: 0, mode: 'invoke' },
  getRemoteConfig: { channel: 'remote:get-config', arity: 0, mode: 'invoke' },
  getNetworkInterfaces: { channel: 'remote:interfaces', arity: 0, mode: 'invoke' },
  setRemoteConfig: { channel: 'remote:set-config', arity: 1, mode: 'invoke' },
  setRemotePassword: { channel: 'remote:set-password', arity: 1, mode: 'invoke' },
  startRemoteServer: { channel: 'remote:start', arity: 1, mode: 'invoke' },
  getRemoteStatus: { channel: 'remote:status', arity: 0, mode: 'invoke' },
  stopRemoteServer: { channel: 'remote:stop', arity: 0, mode: 'invoke' },
  detectTailscale: { channel: 'remote:tailscale-detect', arity: 0, mode: 'invoke' },
  pickFolder: { channel: 'session:pick-folder', arity: 0, mode: 'invoke' },
  resolveForkAnchor: { channel: 'session:resolve-fork-anchor', arity: 5, mode: 'invoke' },
  listSharedProviders: { channel: 'shared-provider:list', arity: 0, mode: 'unwrap' },
  listSharedProviderModels: { channel: 'shared-provider:models', arity: 1, mode: 'unwrap' },
  getSharedProviderStatuses: { channel: 'shared-provider:statuses', arity: 0, mode: 'unwrap' },
  openPath: { channel: 'shell:open-path', arity: 1, mode: 'invoke' },
  showInFolder: { channel: 'shell:show-in-folder', arity: 1, mode: 'invoke' },
  watchStreams: {
    channel: 'stream:watch',
    arity: 2,
    mode: 'invoke',
    wire: (a) => [{ sessionIds: a[0], automationRuns: a[1] }]
  },
  terminalAvailability: { channel: 'terminal:availability', arity: 0, mode: 'invoke' },
  killTerminalsByCwd: { channel: 'terminal:kill-by-cwd', arity: 1, mode: 'invoke' },
  resizeTerminal: { channel: 'terminal:resize', arity: 3, mode: 'invoke' },
  writeTerminal: { channel: 'terminal:write', arity: 2, mode: 'invoke' },
  voiceStart: { channel: 'voice:start-recording', arity: 3, mode: 'unwrap' },
  voiceStop: { channel: 'voice:stop-recording', arity: 1, mode: 'unwrap' },
  closeWindow: { channel: 'window:close', arity: 0, mode: 'invoke' },
  maximizeWindow: { channel: 'window:maximize', arity: 0, mode: 'invoke' },
  minimizeWindow: { channel: 'window:minimize', arity: 0, mode: 'invoke' }
} as const satisfies InvokeTable

/** Host-local events only the desktop transport serves (see {@link DESKTOP_INVOKES}). */
export const DESKTOP_EVENTS = {
  onPluginViewsChanged: 'plugin:views-changed',
  onRemoteStatus: 'remote:status',
  onTerminalData: 'terminal:data',
  onTerminalExit: 'terminal:exit',
  // The pty's geometry changed because some surface refitted it (ADR-060). A narrow Electron
  // window runs the MOBILE fork, which mirrors the shared width, so the desktop needs it too.
  onTerminalResized: 'terminal:resized'
} as const satisfies Partial<Record<keyof ClaudeAPI, string>>

/** Every channel a table member rides, for the parity tests. */
export type ApiInvokeChannel = (typeof API_INVOKES)[keyof typeof API_INVOKES]['channel']
export type DesktopInvokeChannel = (typeof DESKTOP_INVOKES)[keyof typeof DESKTOP_INVOKES]['channel']

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

type Member = (...args: unknown[]) => Promise<unknown>

/**
 * Unwrap `safeHandler`'s `{ ok, data, error }` envelope. Throws on `{ ok: false }` so callers can
 * `.catch()`. Any other value (no `ok` key) passes through: result objects in this codebase never
 * carry an `ok` key unless they ARE the envelope.
 */
export function unwrapEnvelope<T>(failurePrefix: string, channel: string, result: unknown): T {
  if (result && typeof result === 'object' && 'ok' in result) {
    const envelope = result as { ok: boolean; data?: unknown; error?: string }
    if (!envelope.ok) throw new Error(envelope.error ?? `${failurePrefix} ${channel} failed`)
    return envelope.data as T
  }
  return result as T
}

export function buildMember(entry: InvokeEntry, transport: InvokeTransport): Member {
  const { channel, arity, mode, progress, wire } = entry
  const send = (args: unknown[]): Promise<unknown> => {
    const positional = Array.from({ length: arity }, (_, i) => args[i])
    const wireArgs = wire ? wire(positional) : positional.filter((_, i) => i !== progress)
    if (progress === 'always') return transport.invokeWithProgress(channel, wireArgs, () => {})
    const onProgress = typeof progress === 'number' ? positional[progress] : undefined
    return onProgress
      ? transport.invokeWithProgress(
          channel,
          wireArgs,
          onProgress as (progress: InvokeProgress) => void
        )
      : transport.invoke(channel, wireArgs)
  }
  if (mode === 'invoke') return (...args) => send(args)
  return async (...args) => unwrapEnvelope(transport.failurePrefix, channel, await send(args))
}

/** Build the pass-through invoke members of `table` over `transport`. */
export function buildInvokeApi<T extends Readonly<Record<string, InvokeEntry>>>(
  table: T,
  transport: InvokeTransport
): Pick<ClaudeAPI, Extract<keyof T, keyof ClaudeAPI>> {
  const api: Record<string, Member> = {}
  for (const [name, entry] of Object.entries(table)) api[name] = buildMember(entry, transport)
  return api as Pick<ClaudeAPI, Extract<keyof T, keyof ClaudeAPI>>
}

/** Build the host-local `onX` subscriptions of `table` over `transport`. */
export function buildEventApi<T extends Readonly<Record<string, string>>>(
  table: T,
  transport: InvokeTransport
): Pick<ClaudeAPI, Extract<keyof T, keyof ClaudeAPI>> {
  const api: Record<string, EventSubscribe> = {}
  for (const [name, channel] of Object.entries(table)) api[name] = transport.on(channel)
  return api as Pick<ClaudeAPI, Extract<keyof T, keyof ClaudeAPI>>
}

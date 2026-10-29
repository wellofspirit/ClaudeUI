import { contextBridge, ipcRenderer } from 'electron'
import type {
  ApprovalDecision,
  AttachmentUpload,
  ClaudeAPI,
  LoadSessionHistoryOptions,
  PermissionSuggestion,
  ProxySettings
} from '../shared/types'
import { buildMockupUrl } from '../shared/mockup-url'
import { verifierHooksEnabled } from '../shared/verifier-hooks'
import { INVOKE_PROGRESS_EVENT, INVOKE_WITH_PROGRESS_CHANNEL } from '../shared/progress-throttle'
import type { InvokeProgress } from '../shared/remote-protocol'

/**
 * Factory for IPC event handler registration.
 * Forwards all arguments from ipcRenderer.on (after the IpcRendererEvent) to the callback.
 *
 * **HOST-LOCAL channels only, as of SyncCore phase 4c.** Replicated and volatile
 * events no longer ride `webContents.send`: they arrive on the sync port and are
 * subscribed to in the renderer via `shared/sync/client-registry.onSyncEvent`.
 * What is left here is the host talking to its own shell — window chrome, the
 * native OAuth flow, voice state/transcripts, desktop PTY bytes, the log-viewer window,
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
  return unwrapResult<T>(channel, await ipcRenderer.invoke(channel, ...args))
}

function unwrapResult<T>(channel: string, result: unknown): T {
  if (result && typeof result === 'object' && 'ok' in result) {
    const envelope = result as { ok: boolean; data?: unknown; error?: string }
    if (!envelope.ok) throw new Error(envelope.error ?? `IPC ${channel} failed`)
    return envelope.data as T
  }
  return result as T
}

// ---------------------------------------------------------------------------
// Invoke with progress (ADR-102)
// ---------------------------------------------------------------------------
//
// `ipcRenderer.invoke` resolves once, so a call that reports progress rides the
// `invoke:with-progress` channel and gets `invoke:progress (callId, p)` messages
// from main, routed here to the call's own callback. INTERNAL: deliberately NOT a
// member of `api` / not exposed on contextBridge — only the named wrappers below
// (`loadSessionHistory`) are, so the main world cannot pick the channel.

const progressListeners = new Map<string, (progress: InvokeProgress) => void>()
let progressCallSeq = 0

ipcRenderer.on(INVOKE_PROGRESS_EVENT, (_event, callId: unknown, progress: InvokeProgress) => {
  if (typeof callId !== 'string') return
  try {
    progressListeners.get(callId)?.(progress)
  } catch {
    // A throwing listener must not break the router for every other call.
  }
})

async function invokeWithProgress<T>(
  channel: string,
  args: unknown[],
  onProgress: (progress: InvokeProgress) => void
): Promise<T> {
  const callId = `${++progressCallSeq}`
  progressListeners.set(callId, onProgress)
  try {
    return (await ipcRenderer.invoke(INVOKE_WITH_PROGRESS_CHANNEL, callId, channel, ...args)) as T
  } finally {
    progressListeners.delete(callId)
  }
}

const api: ClaudeAPI = {
  codexApproval: (id, requestId, decision) =>
    unwrap('session:codex-approval', id, requestId, decision),
  codexAuthStatus: () => unwrap('codex:auth-status'),
  readCodexConfig: () => unwrap('codex-config:read'),
  writeCodexConfig: (edits, expectedVersion) =>
    unwrap('codex-config:write', edits, expectedVersion),
  recompileCodexRules: () => unwrap('codex:recompile-rules'),
  codexDeletePlan: (threadId) => unwrap('session:codex-delete-plan', threadId),
  platform: process.platform,
  // Resolved here, in the one process that sees BOTH forms of the opt-in: the
  // env var (inherited from main) and the `--claudeui-verifier-hooks` switch main
  // forwards via `additionalArguments`. The renderer has neither, so it reads the
  // answer off `window.api` instead. See `src/shared/verifier-hooks.ts`.
  verifierHooks: verifierHooksEnabled(),
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
    engineId?: import('../shared/types').EngineId,
    announce?: { effort?: string | null; thinkingMode?: string | null }
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
      engineId,
      announce
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
  sendPrompt: (routingId: string, prompt: string, attachments?: AttachmentUpload[]) =>
    ipcRenderer.invoke('session:send', routingId, prompt, attachments),
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
  approveBlocked: (routingId: string, toolUseId: string) =>
    ipcRenderer.invoke('session:approve-blocked', routingId, toolUseId),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window:maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  listDirectories: () => ipcRenderer.invoke('session:list-directories'),
  listOpencodeSessionsGlobal: () => ipcRenderer.invoke('session:list-opencode'),
  loadOpencodeHistory: (sessionId: string) =>
    ipcRenderer.invoke('session:load-opencode-history', sessionId),
  listPiSessionsGlobal: () => ipcRenderer.invoke('session:list-pi'),
  loadPiHistory: (sessionId: string) => ipcRenderer.invoke('session:load-pi-history', sessionId),
  loadSessionHistory: (
    sessionId: string,
    projectKey: string,
    resumeSessionAt?: string,
    onProgress?: (progress: InvokeProgress) => void,
    options?: LoadSessionHistoryOptions
  ) => {
    // The options ride as a 4th wire arg only when given: a call without them is
    // the exact 3-arg invoke an older host understands.
    const wireArgs = options
      ? [sessionId, projectKey, resumeSessionAt, options]
      : [sessionId, projectKey, resumeSessionAt]
    return onProgress
      ? invokeWithProgress('session:load-history', wireArgs, onProgress)
      : ipcRenderer.invoke('session:load-history', ...wireArgs)
  },
  loadSessionStatusLine: (
    sessionId: string,
    projectKey: string,
    onProgress?: (progress: InvokeProgress) => void
  ) =>
    onProgress
      ? invokeWithProgress('session:load-status-line', [sessionId, projectKey], onProgress)
      : ipcRenderer.invoke('session:load-status-line', sessionId, projectKey),
  loadSubagentHistory: (sessionId: string, projectKey: string, agentId: string) =>
    ipcRenderer.invoke('session:load-subagent-history', sessionId, projectKey, agentId),
  getBlob: (blobId: string) => ipcRenderer.invoke('blob:get', blobId),
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
  allowPeerMessages: (routingId: string) =>
    ipcRenderer.invoke('session:allow-peer-messages', routingId),
  setSessionGrouped: (routingId: string, grouped: boolean) =>
    ipcRenderer.invoke('session:link:set-grouped', routingId, grouped),
  startSessionProposal: (proposalId: string, grouped?: boolean) =>
    ipcRenderer.invoke('session:proposal:start', proposalId, grouped),
  dismissSessionProposal: (proposalId: string) =>
    ipcRenderer.invoke('session:proposal:dismiss', proposalId),
  respondContextPressure: (routingId: string, answer: 'handoff' | 'dismiss') =>
    ipcRenderer.invoke('session:context-pressure:respond', routingId, answer),
  recallQueued: (routingId: string) => ipcRenderer.invoke('session:recall-queued', routingId),
  askSideQuestion: (routingId: string, question: string) =>
    ipcRenderer.invoke('session:ask-side-question', routingId, question),
  setPermissionMode: (routingId: string, mode: string) =>
    ipcRenderer.invoke('session:set-permission-mode', routingId, mode),
  setModel: (routingId: string, model: string) =>
    ipcRenderer.invoke('session:set-model', routingId, model),
  setEffort: (routingId: string, effort: string) =>
    ipcRenderer.invoke('session:set-effort', routingId, effort),
  setSessionAccount: (routingId: string, accountId: string | null) =>
    ipcRenderer.invoke('session:set-account', routingId, accountId),
  setThinkingMode: (routingId: string, mode: string) =>
    ipcRenderer.invoke('session:set-thinking-mode', routingId, mode),
  setReasoningVariant: (routingId: string, variant: string | null) =>
    ipcRenderer.invoke('session:set-reasoning-variant', routingId, variant),
  getModels: () => ipcRenderer.invoke('session:get-models'),
  getEngineModels: (engineId) => ipcRenderer.invoke('session:get-engine-models', engineId),
  judgeModelSupport: (engineId, values) =>
    ipcRenderer.invoke('automode:judge-model-support', engineId, values),
  judgeRouteResting: (engineId, model, accountId) =>
    ipcRenderer.invoke('automode:judge-route-resting', engineId, model, accountId),
  getOpencodeProviders: () => ipcRenderer.invoke('session:get-opencode-providers'),
  setOpencodeProviderDisabled: (providerId: string, disabled: boolean) =>
    ipcRenderer.invoke('session:set-opencode-provider-disabled', providerId, disabled),
  removeOpencodeProvider: (providerId, kind) =>
    ipcRenderer.invoke('session:remove-opencode-provider', providerId, kind),
  getOpencodeProviderModels: (providerId: string) =>
    ipcRenderer.invoke('session:get-opencode-provider-models', providerId),
  getPiModelCatalogGroups: () => ipcRenderer.invoke('session:get-pi-model-catalog'),
  engineIsInstalled: (engineId) => ipcRenderer.invoke('engine:is-installed', engineId),
  harnessState: () => ipcRenderer.invoke('harness:state'),
  harnessVersions: (id) => ipcRenderer.invoke('harness:versions', { id }),
  setHarnessSelection: (id, selection) =>
    ipcRenderer.invoke('harness:set-selection', { id, selection }),
  installHarness: (id, version) => ipcRenderer.invoke('harness:install', { id, version }),
  cancelHarnessInstall: (id, version) =>
    ipcRenderer.invoke('harness:install-cancel', { id, version }),
  detectHarnesses: (ids) => ipcRenderer.invoke('harness:detect', ids ? { ids } : {}),
  setHarnessUpdateMode: (mode) => ipcRenderer.invoke('harness:set-update-mode', { mode }),
  updateHarnesses: () => ipcRenderer.invoke('harness:update-all'),
  checkHarnessUpdates: () => ipcRenderer.invoke('harness:check-updates'),
  answerHarnessUpgradePrompt: () => ipcRenderer.invoke('harness:answer-upgrade-prompt'),
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
  // Remote IDE (ADR-064). Real IPC on the desktop too, and deliberately not a
  // constant like `terminalAvailability` is: the answer depends on the host's
  // toggle and on whether a VS Code CLI is actually installed, neither of which
  // the renderer can know — and the desktop settings pane is the surface that
  // renders the typed probe result.
  ideAvailability: () => ipcRenderer.invoke('ide:availability'),
  ideMintEntry: (folder: string, themeKind?: 'dark' | 'light') =>
    ipcRenderer.invoke('ide:mint-entry', { folder, themeKind }),
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
  // Declared `withProgress` like removeWorktree: always on the progress path, no callback.
  createWorktree: (cwd: string, name: string, opts?: { base?: 'head' | 'default' }) =>
    invokeWithProgress('worktree:create', [cwd, name, opts], () => {}).then((r) =>
      unwrapResult('worktree:create', r)
    ),
  getWorktreeStatus: (worktreePath: string, originalHead: string) =>
    unwrap('worktree:status', worktreePath, originalHead),
  // Declared `withProgress` (the remote client's timeout slides on it), so it always rides the
  // progress path; the signature has no callback, hence the no-op.
  removeWorktree: (worktreePath: string, branch: string, gitRoot: string) =>
    invokeWithProgress('worktree:remove', [worktreePath, branch, gitRoot], () => {}).then((r) =>
      unwrapResult('worktree:remove', r)
    ),
  inventoryWorktrees: (cwd: string) => unwrap('worktree:inventory', cwd),
  inspectWorktree: (cwd: string, id: string) => unwrap('worktree:inspect', cwd, id),
  // The progress path only when a callback is given (ADR-102); the safeHandler envelope
  // rides back through `invokeWithProgress` unchanged, so it is unwrapped here.
  measureWorktree: (cwd: string, id: string, onProgress?: (progress: InvokeProgress) => void) =>
    onProgress
      ? invokeWithProgress('worktree:measure', [cwd, id], onProgress).then((r) =>
          unwrapResult('worktree:measure', r)
        )
      : unwrap('worktree:measure', cwd, id),
  removeWorktrees: (cwd: string, ids: string[], onProgress?: (progress: InvokeProgress) => void) =>
    onProgress
      ? invokeWithProgress('worktree:remove-many', [cwd, ids], onProgress).then((r) =>
          unwrapResult('worktree:remove-many', r)
        )
      : unwrap('worktree:remove-many', cwd, ids),

  // App lifecycle
  confirmQuit: (removeWorktreePaths?: string[]) =>
    ipcRenderer.invoke('app:quit-confirm', removeWorktreePaths ?? []),
  cancelQuit: () => ipcRenderer.invoke('app:quit-cancel'),
  ackQuitPrompt: () => ipcRenderer.invoke('app:quit-prompting'),

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
  fetchChatgptLimits: (refresh?: boolean) =>
    ipcRenderer.invoke('usage:chatgpt-limits', refresh ?? false),

  // Block usage analytics
  fetchBlockUsage: () => ipcRenderer.invoke('usage:fetch-block'),
  setUsageAccountFilter: (account: string | null) =>
    ipcRenderer.invoke('usage:set-account-filter', account),

  // The metering dashboard (ADR-071 §6/§7/§8)
  fetchAccountLimits: (refresh?: boolean) => ipcRenderer.invoke('usage:limits', refresh ?? false),
  fetchUsageWindows: (query) => ipcRenderer.invoke('usage:windows', query ?? {}),
  fetchUsageDashboard: (range, scope) => ipcRenderer.invoke('usage:dashboard', { range, scope }),

  // The usage hub (ADR-072). `setUsageHubSecret` is write-only — no channel here
  // reads a device credential back.
  usageHubStatus: () => ipcRenderer.invoke('usage-hub:status'),
  configureUsageHub: (input) => ipcRenderer.invoke('usage-hub:configure', input),
  setUsageHubSecret: (secret: string) => ipcRenderer.invoke('usage-hub:set-secret', secret),
  syncUsageHubNow: () => ipcRenderer.invoke('usage-hub:sync-now'),
  resyncUsageHub: () => ipcRenderer.invoke('usage-hub:resync'),
  forgetUsageHub: () => ipcRenderer.invoke('usage-hub:forget'),

  // The OpenRouter tab (Usage Analytics): safeHandler envelopes, hence `unwrap`.
  openrouterStatus: () => unwrap('openrouter:status'),
  openrouterOverview: () => unwrap('openrouter:overview'),
  openrouterModels: (scope) => unwrap('openrouter:models', scope),
  openrouterModelEndpoints: (modelId) => unwrap('openrouter:model-endpoints', modelId),

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
  vendorAuthDeviceCodeStart: (engineId: import('../shared/types').EngineId, vendorId: string) =>
    unwrap('vendor-auth:device-code-start', engineId, vendorId),
  vendorAuthDeviceCodeStatus: (engineId: import('../shared/types').EngineId) =>
    unwrap('vendor-auth:device-code-status', engineId),
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
  saveOpencodeSettings: (
    settings: import('../shared/types').OpencodeConfigSettings,
    base?: import('../shared/types').OpencodeConfigSettings
  ) => unwrap('config:save-opencode-settings', settings, base),
  readOpencodeNativeRaw: () => unwrap('config:read-opencode-native-raw'),
  patchOpencodeNative: (patches: import('../shared/types').RawConfigPatch[]) =>
    unwrap('config:patch-opencode-native', patches),
  setOpencodeToolDisabled: (action: string, disabled: boolean) =>
    unwrap('config:set-opencode-tool-disabled', action, disabled),
  readPiNativeRaw: () => unwrap('config:read-pi-native-raw'),
  patchPiNative: (patches: import('../shared/types').RawConfigPatch[]) =>
    unwrap('config:patch-pi-native', patches),
  writePiNativeText: (text: string) => unwrap('config:write-pi-native-text', text),
  readPiModelsRaw: () => unwrap('config:read-pi-models-raw'),
  patchPiModels: (patches: import('../shared/types').RawConfigPatch[]) =>
    unwrap('config:patch-pi-models', patches),
  setProviderModelAllowlist: (
    engine: 'opencode' | 'pi',
    providerId: string,
    models: string[] | null
  ) => unwrap('models:set-provider-allowlist', engine, providerId, models),
  listOpencodeAgents: (cwd?: string) => unwrap('opencode-agents:list', cwd),
  listAgentTypes: (engine: import('../shared/types').EngineId, cwd?: string) =>
    unwrap('config:list-agent-types', engine, cwd),
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
  loadSharedAutoMode: () => ipcRenderer.invoke('config:load-shared-automode'),
  saveSharedAutoMode: (config: import('../shared/types').SharedAutoModeConfig) =>
    ipcRenderer.invoke('config:save-shared-automode', config),
  listProviderRegistry: () => unwrap('provider-registry:list'),
  listProviderAccounts: (providerId: string) => unwrap('provider-account:list', providerId),
  switchProviderAccount: (providerId: string, accountId: string) =>
    unwrap('provider-account:switch', providerId, accountId),
  removeProviderAccount: (providerId: string, accountId: string) =>
    unwrap('provider-account:remove', providerId, accountId),
  setProviderAccountsPerSession: (providerId: string, enabled: boolean) =>
    unwrap('provider-account:set-per-session', providerId, enabled),
  listSharedProviders: () => unwrap('shared-provider:list'),
  getSharedProviderStatuses: () => unwrap('shared-provider:statuses'),
  listSharedProviderModels: (id: string) => unwrap('shared-provider:models', id),
  saveSharedProvider: (definition) => unwrap('shared-provider:save', definition),
  probeSharedEndpoint: (input) => unwrap('shared-provider:probe', input),
  removeSharedProvider: (id: string) => unwrap('shared-provider:remove', id),
  setSharedProviderRoute: (id, harness, enabled) =>
    unwrap('shared-provider:set-route', id, harness, enabled),
  // `replaceOwn` (the harnesses the user agreed to overwrite) goes on the
  // wire only when it names one (S7f).
  setSharedProviderApiKey: (id, key, replaceOwn) =>
    unwrap('shared-provider:set-key', id, key, ...(replaceOwn?.length ? [replaceOwn] : [])),
  adoptSharedProviderNativeKey: (id, keep) => unwrap('shared-provider:adopt-native', id, keep),
  setSharedProviderCuration: (id, curation) => unwrap('shared-provider:set-curation', id, curation),
  setSharedProviderDisabled: (id, disabled, replaceOwn) =>
    unwrap(
      'shared-provider:set-disabled',
      id,
      disabled,
      ...(replaceOwn?.length ? [replaceOwn] : [])
    ),
  syncSharedProvider: (id: string) => unwrap('shared-provider:sync', id),
  useSharedProviderStoredKey: (id, harness) =>
    unwrap('shared-provider:use-stored-key', id, harness),
  getSharedProviderOwnKeyHolders: (id) => unwrap('shared-provider:own-key-holders', id),
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
  // The redacted twin (owner ruling, 2026-08-28), registered for BOTH transports
  // in `core/ipc/remote-view-commands.ts`. Real IPC here rather than a local
  // projection, for the same reason the `authcfg:*` verbs are: one declaration,
  // one redaction, so the desktop cannot drift from what a phone is shown. The
  // desktop UI keeps using the full `remote:status` above — it is the host
  // anchor, and it needs the link fields this view drops.
  getRemoteStatusView: () => ipcRenderer.invoke('remote:status-view'),
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

  // Voice input — the transport only; the renderer owns the microphone. Audio is
  // a fire-and-forget `send`, not an invoke: ~7 a second, nothing to answer.
  voiceStart: (routingId: string, language: string, opts?: { preview?: boolean }) =>
    unwrap('voice:start-recording', routingId, language, opts),
  voiceAudio: (routingId: string, dataB64: string) =>
    ipcRenderer.send('voice:audio', routingId, dataB64),
  voiceStop: (routingId: string) => unwrap('voice:stop-recording', routingId),
  onVoiceTranscript: onEvent('voice:transcript'),
  onVoiceState: onEvent('voice:state'),
  // The on-device speech pack (ADR-101 §6). Plain results (no safeHandler
  // envelope, and no `ok` key in any of them), so `invoke` like the harness
  // manager's. The three writes declare `admin`; the desktop holds it.
  voicePackStatus: () => ipcRenderer.invoke('voice:pack-status'),
  voicePackInstall: () => ipcRenderer.invoke('voice:pack-install'),
  voicePackInstallCancel: () => ipcRenderer.invoke('voice:pack-install-cancel'),
  voicePackRemove: () => ipcRenderer.invoke('voice:pack-remove'),

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

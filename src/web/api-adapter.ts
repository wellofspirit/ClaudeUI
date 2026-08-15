/**
 * WebSocket-backed implementation of ClaudeAPI.
 *
 * This is a mechanical translation of src/preload/index.ts — every
 * ipcRenderer.invoke becomes connection.invoke, every ipcRenderer.on
 * becomes an event listener registration. The remote server dispatches
 * to the same handler functions that IPC uses.
 */

import type {
  ApprovalDecision,
  ClaudeAPI,
  PermissionSuggestion,
  TerminalAvailability
} from '../shared/types'
import { buildMockupHttpUrl } from '../shared/mockup-url'
import { buildSentFileUrl } from '../shared/sent-file-url'
import { derivePasswordProof } from './password-proof'
import type { RemoteConnection } from './connection'

declare global {
  interface Window {
    /** Mockup-scoped auth token injected by the remote server into the served
     *  web-client HTML (only when the WS token in the URL is valid). */
    __MOCKUP_TOKEN__?: string
    /** File-scoped auth token for `/sent-file` URLs, delivered over the
     *  authenticated WS in `sync-full` (ADR-043 §5). Undefined on desktop —
     *  SentFilesWidget uses its presence as the "remote download is available"
     *  probe. */
    __FILE_TOKEN__?: string
  }
}

function sharedProviderRemoteMutation(..._args: unknown[]): Promise<never> {
  return Promise.reject(
    new Error('Shared provider settings can only be changed from the desktop app')
  )
}

export function createWebSocketApi(connection: RemoteConnection): ClaudeAPI {
  // Listener registration mirrors preload's onEvent(). The registry itself
  // lives in the connection's SyncClient — it has to be the thing that knows an
  // event was dispatched, or the cursor advances past events nobody applied
  // (SyncCore phase 0 ack discipline).
  const on = (channel: string): ReturnType<RemoteConnection['on']> => connection.on(channel)

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

    createSession: (
      routingId,
      cwd,
      effort?,
      resumeSessionId?,
      permissionMode?,
      model?,
      thinkingMode?,
      resumeSessionAt?,
      forkSession?,
      engineId?
    ) =>
      connection.invoke(
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
      ) as Promise<void>,

    resolveForkAnchor: (sessionId, cwd, messageId, engineId, messageIndex) =>
      unwrap('session:resolve-fork-anchor', sessionId, cwd, messageId, engineId, messageIndex),

    sendPrompt: (routingId, prompt, attachments?) =>
      connection.invoke('session:send', routingId, prompt, attachments) as Promise<void>,

    cancelSession: (routingId) => connection.invoke('session:cancel', routingId) as Promise<void>,
    clearConversation: (routingId, permissionMode) =>
      connection.invoke('session:clear-conversation', routingId, permissionMode) as Promise<void>,

    interruptSession: (routingId) =>
      connection.invoke('session:interrupt', routingId) as Promise<void>,

    respondApproval: (
      routingId: string,
      requestId: string,
      decision: ApprovalDecision,
      answers?: Record<string, string>,
      updatedPermissions?: PermissionSuggestion[]
    ) =>
      connection.invoke(
        'session:approval-response',
        routingId,
        requestId,
        decision,
        answers,
        updatedPermissions
      ) as Promise<void>,

    // Window controls — no-op on web
    minimizeWindow: async () => {},
    maximizeWindow: async () => {},
    closeWindow: async () => {},

    listDirectories: () =>
      connection.invoke('session:list-directories') as ReturnType<ClaudeAPI['listDirectories']>,
    listOpencodeSessionsGlobal: () =>
      connection.invoke('session:list-opencode') as ReturnType<
        ClaudeAPI['listOpencodeSessionsGlobal']
      >,
    loadOpencodeHistory: (sessionId: string) =>
      connection.invoke('session:load-opencode-history', sessionId) as ReturnType<
        ClaudeAPI['loadOpencodeHistory']
      >,
    // Not yet registered on RemoteDispatcher (remote/web session listing is
    // out of M1 scope) — mirrors the opencode pair above, same pre-existing gap.
    listPiSessionsGlobal: () =>
      connection.invoke('session:list-pi') as ReturnType<ClaudeAPI['listPiSessionsGlobal']>,
    loadPiHistory: (sessionId: string) =>
      connection.invoke('session:load-pi-history', sessionId) as ReturnType<
        ClaudeAPI['loadPiHistory']
      >,

    loadSessionHistory: (sessionId, projectKey, resumeSessionAt) =>
      connection.invoke(
        'session:load-history',
        sessionId,
        projectKey,
        resumeSessionAt
      ) as ReturnType<ClaudeAPI['loadSessionHistory']>,

    loadSubagentHistory: (sessionId, projectKey, agentId) =>
      connection.invoke(
        'session:load-subagent-history',
        sessionId,
        projectKey,
        agentId
      ) as ReturnType<ClaudeAPI['loadSubagentHistory']>,

    buildSubagentFileMap: (sessionId, projectKey, taskPrompts) =>
      connection.invoke(
        'session:build-subagent-file-map',
        sessionId,
        projectKey,
        taskPrompts
      ) as ReturnType<ClaudeAPI['buildSubagentFileMap']>,

    loadBackgroundOutput: (projectKey, taskId, outputFile?) =>
      connection.invoke(
        'session:load-background-output',
        projectKey,
        taskId,
        outputFile
      ) as ReturnType<ClaudeAPI['loadBackgroundOutput']>,

    askSideQuestion: (routingId, question) =>
      connection.invoke('session:ask-side-question', routingId, question) as ReturnType<
        ClaudeAPI['askSideQuestion']
      >,

    deleteSession: (sessionId, projectKey, engineId?) =>
      unwrap('session:delete-session', sessionId, projectKey, engineId),
    deleteProject: (projectKey) => unwrap('session:delete-project', projectKey),

    // Every replicated / volatile subscription is GONE from this adapter
    // (SyncCore phase 4c). It was the hand-maintained mirror of the preload's
    // per-channel surface — ADR-008's typecheck could only ever compare the
    // signatures, never the behavior. Both clients now subscribe through the one
    // `SyncClient` this connection already owned, typed by `SyncEventMap`:
    // `shared/sync/client-registry.onSyncEvent`. The INVOKE side of this adapter
    // is untouched.
    //
    // A web client has no port to acquire — the connection installed its client
    // before `window.api` existed (see web/main.tsx).
    acquireSyncPort: () => {},

    // Host-local channels. A remote client mostly has no such surface, so these
    // are either dead subscriptions kept for signature parity or genuinely
    // per-transport implementations (terminal bytes ride the volatile WS lane).
    onMaximizeChange: on('window:maximized-change') as ClaudeAPI['onMaximizeChange'],
    // Terminal output is the VOLATILE lane (SyncCore phase 2): `term-data` /
    // `term-exit` frames targeted at attached sockets, never event-log channels
    // — PTY bytes must not be replayable from a ring buffer.
    onTerminalData: ((cb: Parameters<ClaudeAPI['onTerminalData']>[0]) =>
      connection.onTerminalData(cb)) as ClaudeAPI['onTerminalData'],
    onTerminalExit: ((cb: Parameters<ClaudeAPI['onTerminalExit']>[0]) =>
      connection.onTerminalExit(cb)) as ClaudeAPI['onTerminalExit'],
    onBeforeQuit: on('app:before-quit') as ClaudeAPI['onBeforeQuit'],

    // Background task control
    watchBackground: (routingId, toolUseId) =>
      connection.invoke('session:watch-background', routingId, toolUseId) as Promise<void>,
    unwatchBackground: (routingId, toolUseId) =>
      connection.invoke('session:unwatch-background', routingId, toolUseId) as Promise<void>,
    readBackgroundRange: (routingId, toolUseId, offset, length) =>
      connection.invoke(
        'session:read-background-range',
        routingId,
        toolUseId,
        offset,
        length
      ) as Promise<string>,

    // Task control
    stopTask: (routingId, toolUseId, isDispatch) =>
      connection.invoke('session:stop-task', routingId, toolUseId, isDispatch) as Promise<{
        success: boolean
        error?: string
      }>,
    backgroundTask: (routingId, toolUseId) =>
      connection.invoke('session:background-task', routingId, toolUseId) as Promise<{
        success: boolean
        error?: string
      }>,
    dequeueMessage: (routingId, value) =>
      connection.invoke('session:dequeue-message', routingId, value) as Promise<{
        removed: number
      }>,
    recallQueued: (routingId) =>
      connection.invoke('session:recall-queued', routingId) as Promise<{
        recalled: string[]
        notRecalled: number
      }>,

    // Session settings
    setPermissionMode: (routingId, mode) =>
      connection.invoke('session:set-permission-mode', routingId, mode) as Promise<void>,
    setModel: (routingId, model) =>
      connection.invoke('session:set-model', routingId, model) as Promise<void>,
    setEffort: (routingId, effort) =>
      connection.invoke('session:set-effort', routingId, effort) as Promise<void>,
    setThinkingMode: (routingId, mode) =>
      connection.invoke('session:set-thinking-mode', routingId, mode) as Promise<void>,
    setReasoningVariant: (routingId, variant) =>
      connection.invoke('session:set-reasoning-variant', routingId, variant) as Promise<void>,
    getModels: () => connection.invoke('session:get-models') as ReturnType<ClaudeAPI['getModels']>,
    getEngineModels: () =>
      connection.invoke('session:get-engine-models') as ReturnType<ClaudeAPI['getEngineModels']>,
    getOpencodeProviders: () =>
      connection.invoke('session:get-opencode-providers') as ReturnType<
        ClaudeAPI['getOpencodeProviders']
      >,
    setOpencodeProviderDisabled: (providerId, disabled) =>
      connection.invoke(
        'session:set-opencode-provider-disabled',
        providerId,
        disabled
      ) as ReturnType<ClaudeAPI['setOpencodeProviderDisabled']>,
    removeOpencodeProvider: (providerId, kind) =>
      connection.invoke('session:remove-opencode-provider', providerId, kind) as ReturnType<
        ClaudeAPI['removeOpencodeProvider']
      >,
    getOpencodeProviderModels: (providerId) =>
      connection.invoke('session:get-opencode-provider-models', providerId) as ReturnType<
        ClaudeAPI['getOpencodeProviderModels']
      >,
    getPiModelCatalogGroups: () =>
      connection.invoke('session:get-pi-model-catalog') as ReturnType<
        ClaudeAPI['getPiModelCatalogGroups']
      >,
    engineIsInstalled: (engineId) =>
      connection.invoke('engine:is-installed', engineId) as ReturnType<
        ClaudeAPI['engineIsInstalled']
      >,
    getPiBinaryPath: () =>
      connection.invoke('pi:binary-path') as ReturnType<ClaudeAPI['getPiBinaryPath']>,
    getPiAuthStatus: () =>
      connection.invoke('pi:auth-status') as ReturnType<ClaudeAPI['getPiAuthStatus']>,
    listSharedProviders: () =>
      connection.invoke('shared-provider:list') as ReturnType<ClaudeAPI['listSharedProviders']>,
    getSharedProviderStatuses: () =>
      connection.invoke('shared-provider:statuses') as ReturnType<
        ClaudeAPI['getSharedProviderStatuses']
      >,
    listSharedProviderModels: (id) =>
      connection.invoke('shared-provider:models', id) as ReturnType<
        ClaudeAPI['listSharedProviderModels']
      >,
    saveSharedProvider: sharedProviderRemoteMutation,
    removeSharedProvider: sharedProviderRemoteMutation,
    setSharedProviderRoute: sharedProviderRemoteMutation,
    setSharedProviderApiKey: sharedProviderRemoteMutation,
    syncSharedProvider: sharedProviderRemoteMutation,
    disconnectSharedProvider: sharedProviderRemoteMutation,
    setSharedProviderDefaultModel: sharedProviderRemoteMutation,

    // Generation
    generateTitle: (conversationText) =>
      connection.invoke('session:generate-title', conversationText) as Promise<string | null>,
    generateCommitMessage: (diff) =>
      connection.invoke('session:generate-commit-message', diff) as Promise<string | null>,

    writeCustomTitle: (sessionId, projectKey, title) =>
      connection.invoke(
        'session:write-custom-title',
        sessionId,
        projectKey,
        title
      ) as Promise<void>,
    getPlanContent: (routingId) =>
      connection.invoke('session:get-plan-content', routingId) as Promise<string | null>,
    getSessionLogPath: (routingId) =>
      connection.invoke('session:get-session-log-path', routingId) as Promise<string | null>,

    // Watch
    watchSession: (routingId, sessionId, projectKey, cwd) =>
      connection.invoke(
        'session:watch-session',
        routingId,
        sessionId,
        projectKey,
        cwd
      ) as Promise<void>,
    unwatchSession: (routingId) =>
      connection.invoke('session:unwatch-session', routingId) as Promise<void>,

    // Terminal (SyncCore phase 2 — ADR-052). Reachable over remote behind three
    // server-side gates: the desktop opt-in toggle, a stepped-up `shell` grant,
    // and that grant's idle decay. Everything here is refused server-side until
    // all three hold, so the client never has to be trusted about them.
    // `index` is the pool slot: asking for terminal 0 of a cwd the desktop
    // already has a shell open in attaches to THAT pty (tmux-style) instead of
    // spawning a second one. A host that predates the pool ignores the extra
    // argument and answers exactly as before.
    createTerminal: (cwd, index) =>
      connection.invoke('terminal:create', cwd, index) as Promise<string>,
    // Keystrokes ride the `term-input` FRAME rather than an invoke: one
    // request/response round trip per keypress is pure overhead, and the frame
    // is what refreshes the grant's idle deadline.
    writeTerminal: async (id, data) => {
      connection.sendTerminalInput(id, data)
    },
    resizeTerminal: async (id, cols, rows) => {
      connection.sendTerminalResize(id, cols, rows)
    },
    killTerminal: (id) => connection.invoke('terminal:kill', id) as Promise<void>,
    // Desktop-only lifecycle sweep (cold-session cleanup); not on the remote
    // surface, so a web client never mass-kills the operator's shells.
    killTerminalsByCwd: async () => [],
    terminalAvailability: () =>
      connection.invoke('terminal:availability') as ReturnType<ClaudeAPI['terminalAvailability']>,
    terminalStepUp: async (password) => {
      // Proof params come from `terminal:availability`, NOT `/remote/auth-info`:
      // auth-info advertises authentication methods, and over the tunnel the
      // server (correctly) refuses password auth, so it omits `password` there —
      // which used to make a step-up impossible on that transport even though
      // the ceremony itself is transport-independent (the proof rides the
      // already-authenticated, E2E-encrypted channel).
      let availability: TerminalAvailability
      try {
        availability = (await connection.invoke('terminal:availability')) as TerminalAvailability
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          retryable: true
        }
      }
      if (!availability.stepUp) {
        // No credential provisioned ⇒ no step-up factor exists. Same verdict the
        // server would give, minus a pointless round trip.
        return {
          ok: false,
          code: 'no-password',
          error:
            'Set a remote-access password in Settings › Remote on the desktop app — the terminal needs it to confirm it is you.',
          retryable: false
        }
      }
      const proof = await derivePasswordProof(
        password,
        availability.stepUp.saltHex,
        availability.stepUp.kdf
      )
      const response = await connection.stepUp(proof)
      return {
        ok: response.ok,
        error: response.error,
        code: response.code,
        retryable: response.retryable,
        expiresAt: response.expiresAt
      }
    },
    attachTerminal: (id) => connection.invoke('terminal:attach', id) as Promise<boolean>,
    detachTerminal: (id) => connection.invoke('terminal:detach', id) as Promise<void>,
    onTerminalDetached: ((cb: Parameters<ClaudeAPI['onTerminalDetached']>[0]) =>
      connection.onTerminalDetached(cb)) as ClaudeAPI['onTerminalDetached'],

    // Worktree — not available on web
    createWorktree: async () => {
      throw new Error('Worktrees not available in remote mode')
    },
    getWorktreeStatus: async () => {
      throw new Error('Worktrees not available in remote mode')
    },
    removeWorktree: async () => {
      throw new Error('Worktrees not available in remote mode')
    },
    listWorktrees: async () => [],

    // App lifecycle — quit is desktop-only; no-ops that resolve on web.
    confirmQuit: async () => {}, // No-op on web
    cancelQuit: async () => {}, // No-op on web

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
    // Live watching is real over remote: the server shares one poller per cwd
    // with the desktop (gitWatchRegistry) and pushes git:status-update over the
    // bridge. Without these the pill never rendered — gitStatus stayed null.
    gitStartWatching: (cwd) => unwrap('git:start-watching', cwd),
    gitStopWatching: (cwd) => unwrap('git:stop-watching', cwd),

    // File ops
    listDir: (dirPath) =>
      connection.invoke('file:list-dir', dirPath) as ReturnType<ClaudeAPI['listDir']>,
    openInVSCode: async () => {}, // No-op on web

    // Sent-file preview: no RPC — the src IS an authenticated same-origin URL
    // to the server's /sent-file route, so the browser streams the bytes
    // instead of tunnelling a data: URL through the WS.
    getSentFilePreview: async (sessionKey, filePath) => {
      const token = window.__FILE_TOKEN__
      if (!token) return { error: 'Preview is not available yet' }
      return {
        src: buildSentFileUrl(window.location.origin, sessionKey, filePath, {
          token,
          inline: true
        })
      }
    },

    // Mockup preview — HTML is read from the server's filesystem and rendered client-side
    readMockupHtml: (cwd, directory) => unwrap('mockup:read-html', cwd, directory),
    watchMockup: (cwd, directory) =>
      connection.invoke('mockup:watch', cwd, directory) as Promise<void>,
    unwatchMockup: (cwd, directory) =>
      connection.invoke('mockup:unwatch', cwd, directory) as Promise<void>,
    getMockupPreviewUrl: (cwd, directory, opts) =>
      buildMockupHttpUrl(window.location.origin, cwd, directory, {
        token: window.__MOCKUP_TOKEN__ ?? '',
        dark: opts?.dark,
        parentOrigin: window.location.origin
      }),

    // Config
    loadSettings: () =>
      connection.invoke('config:load-settings') as ReturnType<ClaudeAPI['loadSettings']>,
    saveSettings: (settings) =>
      connection.invoke('config:save-settings', settings) as Promise<void>,
    loadSessionConfig: () =>
      connection.invoke('config:load-sessions') as ReturnType<ClaudeAPI['loadSessionConfig']>,
    saveSessionConfig: (config) =>
      connection.invoke('config:save-sessions', config) as Promise<void>,
    loadSlashCommands: () =>
      connection.invoke('config:load-slash-commands') as ReturnType<ClaudeAPI['loadSlashCommands']>,
    saveSlashCommands: async () => {}, // Read-only
    scanCustomCommands: (cwd) =>
      connection.invoke('config:scan-custom-commands', cwd) as ReturnType<
        ClaudeAPI['scanCustomCommands']
      >,
    loadSkillDetails: (cwd) =>
      connection.invoke('config:load-skill-details', cwd) as ReturnType<
        ClaudeAPI['loadSkillDetails']
      >,

    // Usage
    fetchAccountUsage: () =>
      connection.invoke('usage:fetch') as ReturnType<ClaudeAPI['fetchAccountUsage']>,
    fetchBlockUsage: () =>
      connection.invoke('usage:fetch-block') as ReturnType<ClaudeAPI['fetchBlockUsage']>,
    setUsageAccountFilter: (account) =>
      connection.invoke('usage:set-account-filter', account) as ReturnType<
        ClaudeAPI['setUsageAccountFilter']
      >,
    fetchDispatchedUsage: () =>
      connection.invoke('usage:fetch-dispatched') as ReturnType<ClaudeAPI['fetchDispatchedUsage']>,

    // Native OAuth (ADR-014) — desktop-only (opens a local browser + loopback).
    // sign-in/submit/cancel are blocklisted on the remote dispatcher; only the
    // read-only status query is forwarded.
    signIn: async () => {
      throw new Error('Login is only available on the desktop app.')
    },
    submitOAuthCode: async () => {
      throw new Error('Login is only available on the desktop app.')
    },
    cancelSignIn: async () => {},
    onAuthState: on('auth:state') as ClaudeAPI['onAuthState'],

    // Multi-account (ADR-015) — read-only over remote; mutations are desktop-only.
    getAccounts: () => connection.invoke('account:get') as ReturnType<ClaudeAPI['getAccounts']>,
    setMultiAccountEnabled: async () => {
      throw new Error('Account management is only available on the desktop app.')
    },
    addAccount: async () => {
      throw new Error('Account management is only available on the desktop app.')
    },
    switchAccount: async () => {
      throw new Error('Account management is only available on the desktop app.')
    },
    deleteAccount: async () => {
      throw new Error('Account management is only available on the desktop app.')
    },
    onAccountsChanged: on('account:changed') as ClaudeAPI['onAccountsChanged'],
    onAccountRespawnSessions: on(
      'account:respawn-sessions'
    ) as ClaudeAPI['onAccountRespawnSessions'],

    // Claude permissions — full parity: the remote handler runs the same
    // save + hot-reload fan-out as the desktop IPC.
    loadClaudePermissions: (scope, cwd?) =>
      connection.invoke('claude:load-permissions', scope, cwd) as ReturnType<
        ClaudeAPI['loadClaudePermissions']
      >,
    saveClaudePermissions: (scope, permissions, cwd?) =>
      connection.invoke('claude:save-permissions', scope, permissions, cwd) as Promise<void>,
    isWorkspaceTrusted: (cwd) =>
      connection.invoke('claude:workspace-trust', cwd) as Promise<boolean>,

    // Transcript retention window (cleanupPeriodDays)
    getCleanupPeriodDays: () =>
      connection.invoke('claude:get-cleanup-period') as ReturnType<
        ClaudeAPI['getCleanupPeriodDays']
      >,
    setCleanupPeriodDays: (days) =>
      connection.invoke('claude:set-cleanup-period', days) as Promise<void>,

    // MCP
    mcpServerStatus: (routingId) =>
      connection.invoke('mcp:status', routingId) as ReturnType<ClaudeAPI['mcpServerStatus']>,
    mcpToggleServer: async () => {}, // Not available in remote
    mcpReconnectServer: async () => {},
    mcpSetServers: async () => ({ added: [], removed: [], errors: {} }),
    loadMcpServers: (scope, cwd?) =>
      connection.invoke('mcp:load-servers', scope, cwd) as ReturnType<ClaudeAPI['loadMcpServers']>,
    saveMcpServers: async () => {},
    removeMcpServer: async () => {}, // Read-only on web
    mcpReadDisabled: (cwd) =>
      connection.invoke('mcp:read-disabled', cwd) as ReturnType<ClaudeAPI['mcpReadDisabled']>,
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
    startRemoteServer: async () => {
      throw new Error('Not available in remote mode')
    },
    stopRemoteServer: async () => {},
    getRemoteStatus: async () => ({
      running: false,
      port: null,
      token: null,
      lanUrl: null,
      tunnelUrl: null,
      tunnelState: null,
      tunnelError: null,
      connectedClients: 0,
      clientIps: [],
      clientLogins: [],
      tls: null,
      lastError: null,
      authMethods: []
    }),
    onRemoteStatus: () => () => {},
    // Persisted remote-server config (Phase 1) is main-only IPC on the
    // desktop — never registered on the remote dispatcher (see
    // RemoteDispatcher.BLOCKED), so a remote/web client must never be able to
    // read/rotate the credential or flip transport/autostart flags.
    getRemoteConfig: async () => {
      throw new Error('Not available in remote mode')
    },
    setRemoteConfig: async () => {
      throw new Error('Not available in remote mode')
    },
    setRemotePassword: async () => {
      throw new Error('Not available in remote mode')
    },
    clearRemotePassword: async () => {
      throw new Error('Not available in remote mode')
    },
    detectTailscale: async () => {
      throw new Error('Not available in remote mode')
    },
    // Mutating this machine's `tailscale serve` config is desktop-only
    // (`remote:force-reserve` is in RemoteDispatcher.BLOCKED) — a remote client
    // must never take over the transport it is talking through (ADR-042).
    forceReserve: async () => {
      throw new Error('Not available in remote mode')
    },

    // Voice input — not available on web (audio hardware is on the server)
    voiceStartServer: async () => {},
    voiceStopServer: async () => {},
    voiceStartRecording: async () => {},
    voiceStopRecording: async () => {},
    onVoiceTranscript: on('voice:transcript') as ClaudeAPI['onVoiceTranscript'],
    onVoiceState: on('voice:state') as ClaudeAPI['onVoiceState'],

    // Error logging — send to server
    logError: (source, message) => {
      console.error(`[${source}]`, message)
    },
    logRelay: (level, source, message) => {
      // Fire-and-forget; on web there's no main-process log file, so mirror to console.
      console.log(`[${source}] ${level}: ${message}`)
    },

    // Version info — reflects the remote server's build
    getVersionInfo: () =>
      connection.invoke('app:version-info') as ReturnType<ClaudeAPI['getVersionInfo']>,

    // Desktop-only — no native debug window / proxy stack on the web client
    openLogViewer: async () => {},
    testProxyConnection: async () => ({
      ok: false,
      latencyMs: 0,
      error: 'Not available in remote mode'
    }),
    loadEngineConfig: async () => ({}),
    saveEngineConfig: async () => {},
    loadVendorConfig: async () => ({}),
    saveVendorConfig: async () => {},
    loadOpencodeSettings: async () => ({}),
    saveOpencodeSettings: async () => {},
    readOpencodeNativeRaw: async () => ({ config: {}, path: '' }),
    patchOpencodeNative: async () => {},
    listOpencodeAgents: async () => [],
    readOpencodeAgent: async () => null,
    saveOpencodeAgent: async () => {},
    deleteOpencodeAgent: async () => {},
    setOpencodeAgentDisabled: async () => {},
    generateOpencodeAgent: async () => {
      throw new Error('Not available in remote mode')
    },

    // Vendor auth (opencode multi-vendor) — desktop-only; web client is read-only
    vendorAuthProbe: async () => ({}),
    vendorAuthListOptions: async () => ({}),
    vendorAuthListKeys: async () => ({}),
    vendorAuthSetKey: async () => {},
    vendorAuthOauthAuthorize: async () => {
      throw new Error('Vendor auth is only available on the desktop app.')
    },
    vendorAuthOauthCallback: async () => {
      throw new Error('Vendor auth is only available on the desktop app.')
    },
    vendorAuthRemove: async () => {},
    vendorAuthOauthCancel: async () => {},

    // Plugin system — desktop-only, stubbed out on web
    listPlugins: async () => [],
    reloadPlugin: async () => {},
    getPluginViews: async () => [],
    getPluginPreloadPath: async () => '',
    onPluginViewsChanged: () => () => {},

    // Desktop-only: spawns a local opencode server — not available in remote mode (Phase 9b)
    refreshPrices: async () => ({ count: 0, refreshedAt: Date.now() })
  }

  return api
}

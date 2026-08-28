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
import { BrowserVoiceCapture } from './voice-capture'

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
  // One microphone per client, matching the server's one-capture-per-connection
  // rule (services/remote-voice.ts). Constructed eagerly and cheaply — it touches
  // no device until `start()`.
  const voiceCapture = new BrowserVoiceCapture({
    sendAudio: (dataB64) => connection.sendVoiceAudio(dataB64)
  })

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
    // The geometry twin of the host lane's `terminal:resized` (ADR-060): a
    // `term-resized` frame on the same attached-sockets-only lane.
    onTerminalResized: ((cb: Parameters<ClaudeAPI['onTerminalResized']>[0]) =>
      connection.onTerminalResized(cb)) as ClaudeAPI['onTerminalResized'],
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
    // The host answers everything except `passkey`: whether a ceremony is
    // possible is a fact about THIS browser's origin and this socket's auth
    // method, which `terminal:availability` is answered by a service that knows
    // neither. Merged here so the prompt has one object to branch on.
    terminalAvailability: async () => {
      const availability = (await connection.invoke(
        'terminal:availability'
      )) as TerminalAvailability
      return { ...availability, passkey: connection.passkeyAvailable() }
    },
    // Which slots of this cwd already hold a live shell. Refused (like every
    // `shell` channel) until the three gates hold — the caller treats a refusal
    // as "nothing known", never as "nothing running".
    terminalPool: (cwd) => connection.invoke('terminal:pool', cwd) as Promise<number[]>,
    watchStreams: async (sessionIds, automationIds) => {
      await connection.invoke('stream:watch', { sessionIds, automationRuns: automationIds })
    },
    terminalStepUp: async (password, intent) => {
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
      const response = await connection.stepUp(proof, intent)
      return {
        ok: response.ok,
        error: response.error,
        code: response.code,
        retryable: response.retryable,
        expiresAt: response.expiresAt,
        settingsSessionExpiresAt: response.settingsSessionExpiresAt
      }
    },
    // Passkey step-up (ADR-052 decision 5). No local pre-checks at all, unlike
    // the password path above: the challenge request IS the probe, and its
    // refusal codes (`passkey-unavailable`, `throttled`) are what the prompt
    // branches on. Guessing client-side would only be able to guess wrong.
    terminalStepUpPasskey: async (intent) => {
      const response = await connection.stepUpWithPasskey(intent)
      return {
        ok: response.ok,
        error: response.error,
        code: response.code,
        retryable: response.retryable,
        expiresAt: response.expiresAt,
        settingsSessionExpiresAt: response.settingsSessionExpiresAt
      }
    },
    // The reply shape is `TerminalAttachResult` from this build's host and a
    // bare boolean from an older one (ADR-060 version skew) — passed through
    // verbatim either way; the caller narrows.
    attachTerminal: (id) =>
      connection.invoke('terminal:attach', id) as ReturnType<ClaudeAPI['attachTerminal']>,
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
    watchGit: (cwds) => unwrap('git:watch', { cwds }),

    // File ops
    listDir: (dirPath) =>
      connection.invoke('file:list-dir', dirPath) as ReturnType<ClaudeAPI['listDir']>,
    listPlaces: () => connection.invoke('file:list-places') as ReturnType<ClaudeAPI['listPlaces']>,
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

    // Native OAuth (ADR-014) — remote since ADR-057/S4. The host does NOT open
    // its own browser for these calls: it returns `manualUrl` on the state and
    // the client drives the two-step paste-back flow itself (S4-UI). The token
    // EXCHANGE still happens host-side; no token material crosses the wire.
    signIn: () => connection.invoke('auth:sign-in') as ReturnType<ClaudeAPI['signIn']>,
    submitOAuthCode: (code) =>
      connection.invoke('auth:submit-code', code) as ReturnType<ClaudeAPI['submitOAuthCode']>,
    cancelSignIn: () => connection.invoke('auth:cancel') as Promise<void>,
    // Still host-local by classification (sync-channels.md) — a remote client
    // learns its own flow's outcome from the invoke returns above, not from here.
    onAuthState: on('auth:state') as ClaudeAPI['onAuthState'],

    // Multi-account (ADR-015) — the mutations are `config`-capability commands
    // registered on both transports since S4 (core/ipc/auth-commands.ts).
    getAccounts: () => connection.invoke('account:get') as ReturnType<ClaudeAPI['getAccounts']>,
    setMultiAccountEnabled: (enabled) =>
      connection.invoke('account:set-enabled', enabled) as ReturnType<
        ClaudeAPI['setMultiAccountEnabled']
      >,
    // Carries `pendingSignIn` back for a remote caller — see AccountsState.
    addAccount: () => connection.invoke('account:add') as ReturnType<ClaudeAPI['addAccount']>,
    switchAccount: (id) =>
      connection.invoke('account:switch', id) as ReturnType<ClaudeAPI['switchAccount']>,
    deleteAccount: (id) =>
      connection.invoke('account:delete', id) as ReturnType<ClaudeAPI['deleteAccount']>,
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
    // The READ is real over remote as of ADR-054 decision 6: `authcfg:get`, an
    // `admin`-gated QUERY answering the same sanitized object the desktop's
    // `remote:get-config` does. Making the routine settings web-reachable is
    // unimplementable without it — a pane cannot administer a surface it cannot
    // render — and it carries no secret (salt/hash/KDF never leave main; only a
    // `passwordSet` boolean does).
    getRemoteConfig: () =>
      connection.invoke('authcfg:get') as ReturnType<ClaudeAPI['getRemoteConfig']>,
    // The WRITE stays host-anchor only: `remote:set-config` is the one writer
    // that can reach the `off` master switch, and it has no remote registration
    // at all. The routine subset is `authcfg:*` below.
    setRemoteConfig: async () => {
      throw new Error(
        'Transport and authentication-disabling settings can only be changed on the host — ' +
          'use the desktop app (or the server console on a headless install).'
      )
    },
    // Password ROTATION is reachable (authcfgSetPassword below); these two are
    // the host-anchor `remote:*` credential channels, which are not.
    setRemotePassword: async () => {
      throw new Error('Not available in remote mode')
    },
    clearRemotePassword: async () => {
      throw new Error('Not available in remote mode')
    },
    // ADR-054 §6 — the routine remote-access settings, behind `admin` AND a live
    // settings-editing session. A locked editor answers the typed
    // `needs-settings-session`, which the connection's step-up gate deliberately
    // does NOT intercept: unlocking is the operator pressing Edit, not an
    // ambient retry, so this rejection reaches the pane and re-locks it.
    authcfgApply: (patch) =>
      connection.invoke('authcfg:apply', patch) as ReturnType<ClaudeAPI['authcfgApply']>,
    authcfgEnd: () => connection.invoke('authcfg:end') as ReturnType<ClaudeAPI['authcfgEnd']>,
    // Success and disconnection are the SAME event here when the caller is
    // password-authenticated: the server drops every socket holding the old
    // password — the actor included — before the invoke response goes out. So
    // the two are raced. A passkey actor is not disconnected and simply wins with
    // the normal response; a password actor wins with close-4008 instead of
    // sitting out a 30-second timeout on a rotation that worked. A REFUSAL
    // (needs-step-up after a dismissed ceremony, a weak password) still rejects,
    // because the invoke settles and the close never comes.
    //
    // The close is STRONG EVIDENCE, not proof. 4008 means "the password this
    // socket holds is gone", and in the window between sending and settling that
    // could in principle be somebody ELSE's rotation — a second admin, or the
    // host anchor — in which case this call reports success for a write that may
    // never have landed. Single-operator deployment, a window of milliseconds,
    // and the confirmation copy deliberately says the device has been signed out
    // rather than asserting whose password is now in force; the alternative
    // (correlating the close to this request) needs a wire field the protocol
    // does not have. Recorded so the next reader knows it is a considered trade.
    authcfgSetPassword: async (password) => {
      const rotatedAndDisconnected = connection
        .whenCredentialsChanged()
        .then(() => ({ ok: true }) as const)
      const answered = connection.invoke('authcfg:set-password', password) as ReturnType<
        ClaudeAPI['authcfgSetPassword']
      >
      return Promise.race([answered, rotatedAndDisconnected])
    },
    // ADR-056 item C. Both are session-gated like `authcfg:apply` — `lan-link` is
    // a `query` and would otherwise be free, but it hands out the channel key.
    authcfgLanLink: () =>
      connection.invoke('authcfg:lan-link') as ReturnType<ClaudeAPI['authcfgLanLink']>,
    authcfgRotateLanKey: () =>
      connection.invoke('authcfg:rotate-lan-key') as ReturnType<ClaudeAPI['authcfgRotateLanKey']>,

    detectTailscale: async () => {
      throw new Error('Not available in remote mode')
    },
    // Mutating this machine's `tailscale serve` config is desktop-only
    // (`remote:force-reserve` is in RemoteDispatcher.BLOCKED) — a remote client
    // must never take over the transport it is talking through (ADR-042).
    forceReserve: async () => {
      throw new Error('Not available in remote mode')
    },

    // Passkeys (ADR-052). All SIX verbs, unlike the desktop preload: this is the
    // only surface that can actually run a ceremony, because it is the only one
    // served from an origin with an RP ID. Reachability is the server's call —
    // `enroll` / `admin` are outside the base remote grant set, so a plain token
    // connection gets "permission denied" from the registry, which is the point.
    webauthnCredentials: () =>
      connection.invoke('webauthn:credentials') as ReturnType<ClaudeAPI['webauthnCredentials']>,
    webauthnRename: (credId, nickname) =>
      connection.invoke('webauthn:rename', credId, nickname) as ReturnType<
        ClaudeAPI['webauthnRename']
      >,
    webauthnRevoke: (credId) =>
      connection.invoke('webauthn:revoke', credId) as ReturnType<ClaudeAPI['webauthnRevoke']>,
    webauthnMintEnrollToken: () =>
      connection.invoke('webauthn:mint-enroll-token') as ReturnType<
        ClaudeAPI['webauthnMintEnrollToken']
      >,
    webauthnRegisterOptions: () =>
      connection.invoke('webauthn:register-options') as ReturnType<
        ClaudeAPI['webauthnRegisterOptions']
      >,
    webauthnRegisterVerify: (payload) =>
      connection.invoke('webauthn:register-verify', payload) as ReturnType<
        ClaudeAPI['webauthnRegisterVerify']
      >,

    // Voice input — SyncCore phase 5 S3. It USED to be four no-ops here ("audio
    // hardware is on the server"), which left the mic button rendered and inert
    // on web. It is now a real capture: the browser's AudioWorklet produces the
    // 16 kHz i16LE PCM the cli.js voice server wants, `voice:start` binds this
    // connection's audio to the session, and the transcripts come back as lane
    // frames targeted at this socket — landing in `on('voice:transcript')` below,
    // which is the same listener the desktop's host-local send feeds.
    //
    // The two SERVER verbs stay no-ops: starting and stopping the transcription
    // server inside cli.js is `voice:start`'s business, and nothing on the web
    // client calls them (the desktop's InputBox does not either — ClaudeSession
    // starts the server lazily from voiceStartRecording).
    voiceStartServer: async () => {},
    voiceStopServer: async () => {},
    voiceStartRecording: async (routingId, language) => {
      // IDEMPOTENT, defensively. `BrowserVoiceCapture.start()` already no-ops
      // while active, but that alone is not enough: a second call would still
      // reach `voice:start`, and the server answers that by tearing the live
      // capture down and building a new one — an interrupted sentence. The mic
      // button's own `voiceState !== 'idle'` guard cannot cover this, because
      // that state arrives from the server a round trip later, so two presses
      // inside the window both see `idle`. This is the check that holds.
      if (voiceCapture.isActive()) return
      // Microphone FIRST, engine second: a denied permission must not spawn a
      // cli.js child and open a Deepgram stream nobody will speak into. Blocks
      // captured while `voice:start` is in flight are held by the controller and
      // flushed on `arm()`, so the first second of speech is not lost to the
      // round trip.
      await voiceCapture.start()
      try {
        await connection.invoke('voice:start', routingId, language)
      } catch (err) {
        await voiceCapture.stop()
        throw err
      }
      voiceCapture.arm()
    },
    voiceStopRecording: async () => {
      await voiceCapture.stop()
      // Always told, even if the capture was never armed: the server may be
      // holding a stream open, and finalization is what flushes the last
      // transcript back.
      await connection.invoke('voice:stop')
    },
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

    // Desktop-only by ABSENCE of a channel: `log-viewer:open` is a raw
    // `ipcMain.handle` registration (main/services/log-viewer.ts) with no remote
    // twin, and a browser has no native window to open anyway.
    openLogViewer: async () => {},
    // Stubbed even though `proxy:test-connection` IS registered for both
    // transports (config-commands.ts, `config`): it is a probe of the HOST's
    // egress, not a setting, so a stub misinforms without losing state — unlike
    // the saves below, whose stubs silently discarded the user's edit. Wiring it
    // is its own call; the local-surface table in the parity test is what keeps
    // that a decision rather than drift.
    testProxyConnection: async () => ({
      ok: false,
      latencyMs: 0,
      error: 'Not available in remote mode'
    }),

    // Engine / vendor / engine-native config. Every channel below is registered
    // for BOTH transports in core/ipc/config-commands.ts under `capability:
    // 'config'`, so these mirror preload 1:1 instead of stubbing. Wiring them
    // widens nothing: the capability gate is SERVER-side, in the channel
    // registry, and it already applied to these channels whether or not this
    // client could reach them. What the stubs broke was honest callers — every
    // remote settings pane (auto mode, dispatch, the pi ClaudeUI half, vendor
    // endpoints, the opencode Configuration panes) rendered and then resolved a
    // save that went nowhere.
    //
    // `unwrap` appears exactly where preload uses it. The four engine/vendor
    // channels are plain handlers, so a throw is already a rejection over the
    // wire; the rest are safeHandler-wrapped and answer an { ok, data } envelope.
    loadEngineConfig: (engineId) =>
      connection.invoke('config:load-engine-config', engineId) as ReturnType<
        ClaudeAPI['loadEngineConfig']
      >,
    saveEngineConfig: (engineId, config) =>
      connection.invoke('config:save-engine-config', engineId, config) as Promise<void>,
    loadVendorConfig: (vendorId) =>
      connection.invoke('config:load-vendor-config', vendorId) as ReturnType<
        ClaudeAPI['loadVendorConfig']
      >,
    saveVendorConfig: (vendorId, config) =>
      connection.invoke('config:save-vendor-config', vendorId, config) as Promise<void>,
    loadOpencodeSettings: () => unwrap('config:load-opencode-settings'),
    saveOpencodeSettings: (settings) => unwrap('config:save-opencode-settings', settings),
    readOpencodeNativeRaw: () => unwrap('config:read-opencode-native-raw'),
    patchOpencodeNative: (patches) => unwrap('config:patch-opencode-native', patches),
    readPiNativeRaw: () => unwrap('config:read-pi-native-raw'),
    patchPiNative: (patches) => unwrap('config:patch-pi-native', patches),
    writePiNativeText: (text) => unwrap('config:write-pi-native-text', text),
    readPiModelsRaw: () => unwrap('config:read-pi-models-raw'),
    patchPiModels: (patches) => unwrap('config:patch-pi-models', patches),

    // opencode agent CRUD — the same family, split across two capabilities:
    // `config` for the five file verbs, `chat` for `generate` because it spends
    // model tokens. Both are in the base grant set, so an authenticated remote
    // connection reaches all six.
    listOpencodeAgents: (cwd) => unwrap('opencode-agents:list', cwd),
    readOpencodeAgent: (name, scope, cwd) => unwrap('opencode-agents:read', name, scope, cwd),
    saveOpencodeAgent: (input, cwd) => unwrap('opencode-agents:save', input, cwd),
    deleteOpencodeAgent: (name, scope, cwd) => unwrap('opencode-agents:delete', name, scope, cwd),
    setOpencodeAgentDisabled: (name, scope, cwd, disabled) =>
      unwrap('opencode-agents:set-disabled', name, scope, cwd, disabled),
    generateOpencodeAgent: (description, cwd) =>
      unwrap('opencode-agents:generate', description, cwd),

    // Engine-routed per-vendor auth — registered on both transports since S4
    // (core/ipc/auth-commands.ts), so this mirrors preload 1:1 through `unwrap`
    // (every one of these handlers is safeHandler-wrapped). They used to be
    // stubbed as desktop-only; the stubs for the MUTATIONS were the worse half —
    // `vendorAuthSetKey` resolved silently, so a remote user could "save" an API
    // key that went nowhere. `oauth-authorize` refuses opencode's `auto` method
    // for a remote caller; `oauth-callback` accepts the pasted URL/code (ADR-057).
    vendorAuthProbe: (engineId) => unwrap('vendor-auth:probe', engineId),
    vendorAuthListOptions: (engineId) => unwrap('vendor-auth:list-options', engineId),
    vendorAuthListKeys: (engineId) => unwrap('vendor-auth:list-keys', engineId),
    vendorAuthSetKey: (engineId, vendorId, key) =>
      unwrap('vendor-auth:set-key', engineId, vendorId, key),
    vendorAuthOauthAuthorize: (engineId, vendorId, method, inputs) =>
      unwrap('vendor-auth:oauth-authorize', engineId, vendorId, method, inputs),
    vendorAuthOauthCallback: (engineId, vendorId, method, code) =>
      unwrap('vendor-auth:oauth-callback', engineId, vendorId, method, code),
    vendorAuthRemove: (engineId, vendorId) => unwrap('vendor-auth:remove', engineId, vendorId),
    vendorAuthOauthCancel: (engineId) => unwrap('vendor-auth:oauth-cancel', engineId),

    // Plugin system — desktop-only by ABSENCE of a channel, like the log viewer:
    // the four `plugin:*` handlers are raw `ipcMain.handle` registrations in
    // main/index.ts, and a plugin view is a `<webview>` hosting a preload script
    // from the host's disk, which a browser cannot load at all.
    listPlugins: async () => [],
    reloadPlugin: async () => {},
    getPluginViews: async () => [],
    getPluginPreloadPath: async () => '',
    onPluginViewsChanged: () => () => {},

    // Stubbed even though `usage:refresh-prices` IS registered for both
    // transports (config-commands.ts, `config`). Same reasoning as
    // `testProxyConnection`: it refreshes a HOST-side cache rather than saving
    // anything the user typed, so the stub costs a refusal, not an edit.
    refreshPrices: async () => ({ count: 0, refreshedAt: Date.now() })
  }

  return api
}

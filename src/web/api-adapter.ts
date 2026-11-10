/**
 * WebSocket-backed implementation of ClaudeAPI.
 *
 * The pass-through members (every `ipcRenderer.invoke` of the preload and every host-local
 * `ipcRenderer.on`) are built from the shared tables in `shared/api-invoke-table.ts` over this
 * connection; what is written out below is only what this client does differently: desktop-only
 * members that are stubs or refusals here, members that ride another wire mechanism (terminal
 * frames, voice frames) and members computed locally. The remote server dispatches to the same
 * handler functions that IPC uses.
 */

import type { ClaudeAPI, TerminalAvailability } from '../shared/types'
import { buildMockupHttpUrl } from '../shared/mockup-url'
import { buildSentFileUrl } from '../shared/sent-file-url'
import {
  API_EVENTS,
  API_INVOKES,
  buildEventApi,
  buildInvokeApi,
  unwrapEnvelope,
  type InvokeTransport
} from '../shared/api-invoke-table'
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

/** The members that are not a pass-through of the shared tables: this client's own. */
type WebOwnApi = Omit<ClaudeAPI, keyof typeof API_INVOKES | keyof typeof API_EVENTS>

export function createWebSocketApi(connection: RemoteConnection): ClaudeAPI {
  // Listener registration mirrors preload's onEvent(). The registry itself
  // lives in the connection's SyncClient — it has to be the thing that knows an
  // event was dispatched, or the cursor advances past events nobody applied
  // (SyncCore phase 0 ack discipline).
  const transport: InvokeTransport = {
    failurePrefix: 'Remote',
    invoke: (channel, args) => connection.invoke(channel, ...args),
    invokeWithProgress: (channel, args, onProgress) =>
      connection.invokeWithProgress(channel, [...args], onProgress),
    on: (channel) => connection.on(channel)
  }

  // The one hand-written member that still unwraps (see `resolveForkAnchor`).
  const unwrap = async <T>(channel: string, ...args: unknown[]): Promise<T> =>
    unwrapEnvelope<T>('Remote', channel, await connection.invoke(channel, ...args))

  const own: WebOwnApi = {
    platform: 'web',
    // Never on the web client. The verifier hooks are a LOCAL harness affordance
    // (`scripts/app-shot.mjs` driving the real Electron app); a browser reaching
    // the app over the remote transport is not that, and publishing the store on
    // `window` there would hand a shared page's scripts every transcript. Hard
    // literal, not a plumbed flag — there is no version of this that is true.
    verifierHooks: false,

    // Desktop-only: return null or no-op on web
    pickFolder: async () => {
      // Web can't open native dialogs — caller should provide a text input
      return null
    },

    // Envelope differs from the desktop's (it answers the plain result): kept as is.
    resolveForkAnchor: (sessionId, cwd, messageId, engineId, messageIndex) =>
      unwrap('session:resolve-fork-anchor', sessionId, cwd, messageId, engineId, messageIndex),

    // Window controls — no-op on web
    minimizeWindow: async () => {},
    maximizeWindow: async () => {},
    closeWindow: async () => {},

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
    //
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

    // Shared-provider reads: the web client answers the plain result.
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

    // Terminal (SyncCore phase 2 — ADR-052). Reachable over remote behind three
    // server-side gates: the desktop opt-in toggle, a stepped-up `shell` grant,
    // and that grant's idle decay. Everything here is refused server-side until
    // all three hold, so the client never has to be trusted about them.
    // `index` is the pool slot: asking for terminal 0 of a cwd the desktop
    // already has a shell open in attaches to THAT pty (tmux-style) instead of
    // spawning a second one. A host that predates the pool ignores the extra
    // argument and answers exactly as before.
    //
    // Keystrokes ride the `term-input` FRAME rather than an invoke: one
    // request/response round trip per keypress is pure overhead, and the frame
    // is what refreshes the grant's idle deadline.
    writeTerminal: async (id, data) => {
      connection.sendTerminalInput(id, data)
    },
    resizeTerminal: async (id, cols, rows) => {
      connection.sendTerminalResize(id, cols, rows)
    },
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
    // The volatile lane's subscription verb; the desktop's answer is passed through, here the
    // result is dropped.
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
    onTerminalDetached: ((cb: Parameters<ClaudeAPI['onTerminalDetached']>[0]) =>
      connection.onTerminalDetached(cb)) as ClaudeAPI['onTerminalDetached'],

    // App lifecycle — quit is desktop-only; no-ops that resolve on web.
    confirmQuit: async () => {}, // No-op on web
    cancelQuit: async () => {}, // No-op on web
    ackQuitPrompt: async () => {}, // No-op on web

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
    getMockupPreviewUrl: (cwd, directory, opts) =>
      buildMockupHttpUrl(window.location.origin, cwd, directory, {
        token: window.__MOCKUP_TOKEN__ ?? '',
        dark: opts?.dark,
        parentOrigin: window.location.origin
      }),

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
    // The REDACTED status (`getRemoteStatusView`, a table member) is real over remote (owner
    // ruling, 2026-08-28): `remote:status-view`, a `config` QUERY declared for both transports in
    // `core/ipc/remote-view-commands.ts`, carrying running state, port, the connected-client
    // list, tunnel state, auth methods, the last listen error and a redacted `tls` — and neither
    // `lanUrl`/`tunnelUrl` nor anything derived from them, which is why the two stubs here stay
    // stubs.
    //
    // No event twin: `remote:status` is host-local by classification, so the web
    // settings view polls the view while it is on screen.
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
    // at all. The routine subset is `authcfg:*` (table members).
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
    webauthnRegisterOptions: () =>
      connection.invoke('webauthn:register-options') as ReturnType<
        ClaudeAPI['webauthnRegisterOptions']
      >,
    webauthnRegisterVerify: (payload) =>
      connection.invoke('webauthn:register-verify', payload) as ReturnType<
        ClaudeAPI['webauthnRegisterVerify']
      >,

    // Voice input — the TRANSPORT only. The microphone is the renderer's
    // (`renderer/src/lib/voice/`, shared with the desktop window), which calls
    // these: `voice:start` binds this connection's audio to the session, the
    // audio rides the `voice-audio` lane frame, and the transcripts come back as
    // lane frames targeted at this socket — landing in `on('voice:transcript')`
    // (`onVoiceTranscript`, a table member), the same listener the desktop's
    // host-local send feeds.
    //
    // `opts` rides only when given: the verb's third argument is the client's
    // `{ preview: false }`, and a base call stays the two-argument frame it
    // always was.
    voiceStart: async (routingId, language, opts) => {
      if (opts) await connection.invoke('voice:start', routingId, language, opts)
      else await connection.invoke('voice:start', routingId, language)
    },
    // The lane frame carries no session id: the capture is the CONNECTION's, and
    // the server routes by that (core/services/voice-relay.ts).
    voiceAudio: (_routingId, dataB64) => connection.sendVoiceAudio(dataB64),
    voiceStop: async () => {
      await connection.invoke('voice:stop')
    },

    // Error logging — send to server
    logError: (source, message) => {
      console.error(`[${source}]`, message)
    },
    logRelay: (level, source, message) => {
      // Fire-and-forget; on web there's no main-process log file, so mirror to console.
      console.log(`[${source}] ${level}: ${message}`)
    },

    // Desktop-only by ABSENCE of a channel: `log-viewer:open` is a raw
    // `ipcMain.handle` registration (main/services/log-viewer.ts) with no remote
    // twin, and a browser has no native window to open anyway.
    openLogViewer: async () => {},

    // Plugin system — desktop-only by ABSENCE of a channel, like the log viewer:
    // the four `plugin:*` handlers are raw `ipcMain.handle` registrations in
    // main/index.ts, and a plugin view is a `<webview>` hosting a preload script
    // from the host's disk, which a browser cannot load at all.
    listPlugins: async () => [],
    reloadPlugin: async () => {},
    getPluginViews: async () => [],
    getPluginPreloadPath: async () => '',
    onPluginViewsChanged: () => () => {}
  }

  return {
    ...buildInvokeApi(API_INVOKES, transport),
    ...buildEventApi(API_EVENTS, transport),
    ...own
  }
}

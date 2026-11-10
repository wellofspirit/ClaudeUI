import { contextBridge, ipcRenderer } from 'electron'
import type { ClaudeAPI } from '../shared/types'
import { buildMockupUrl } from '../shared/mockup-url'
import { verifierHooksEnabled } from '../shared/verifier-hooks'
import { INVOKE_PROGRESS_EVENT, INVOKE_WITH_PROGRESS_CHANNEL } from '../shared/progress-throttle'
import type { InvokeProgress } from '../shared/remote-protocol'
import {
  API_EVENTS,
  API_INVOKES,
  DESKTOP_EVENTS,
  DESKTOP_INVOKES,
  buildEventApi,
  buildInvokeApi,
  type InvokeTransport
} from '../shared/api-invoke-table'

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

// ---------------------------------------------------------------------------
// Invoke with progress (ADR-102)
// ---------------------------------------------------------------------------
//
// `ipcRenderer.invoke` resolves once, so a call that reports progress rides the
// `invoke:with-progress` channel and gets `invoke:progress (callId, p)` messages
// from main, routed here to the call's own callback. INTERNAL: deliberately NOT a
// member of `api` / not exposed on contextBridge — only the named wrappers built
// from the invoke table (`loadSessionHistory`, ...) are, so the main world cannot
// pick the channel.

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

async function invokeWithProgress(
  channel: string,
  args: readonly unknown[],
  onProgress: (progress: InvokeProgress) => void
): Promise<unknown> {
  const callId = `${++progressCallSeq}`
  progressListeners.set(callId, onProgress)
  try {
    return await ipcRenderer.invoke(INVOKE_WITH_PROGRESS_CHANNEL, callId, channel, ...args)
  } finally {
    progressListeners.delete(callId)
  }
}

/**
 * The pass-through members (`shared/api-invoke-table.ts`) are built over this. `unwrap` is the
 * `safeHandler` envelope: a `{ ok: false }` answer throws, so callers can `.catch()`.
 */
const transport: InvokeTransport = {
  failurePrefix: 'IPC',
  invoke: (channel, args) => ipcRenderer.invoke(channel, ...args),
  invokeWithProgress,
  on: (channel) => onEvent(channel)
}

/** The members that are not a table pass-through: the preload's own. */
type PreloadOwnApi = Omit<
  ClaudeAPI,
  | keyof typeof API_INVOKES
  | keyof typeof API_EVENTS
  | keyof typeof DESKTOP_INVOKES
  | keyof typeof DESKTOP_EVENTS
>

const own: PreloadOwnApi = {
  platform: process.platform,
  // Resolved here, in the one process that sees BOTH forms of the opt-in: the
  // env var (inherited from main) and the `--claudeui-verifier-hooks` switch main
  // forwards via `additionalArguments`. The renderer has neither, so it reads the
  // answer off `window.api` instead. See `src/shared/verifier-hooks.ts`.
  verifierHooks: verifierHooksEnabled(),

  // Sync transport (SyncCore phase 4c). Every replicated / volatile channel
  // arrives on the port, not here — see the `onEvent` doc comment.
  acquireSyncPort: () => {
    syncPortRequested = true
    forwardSyncPort()
  },

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
  // Only the server drops attachments (policy flip, decay, backpressure), and
  // none of those apply to the host surface.
  onTerminalDetached: () => () => {},

  // Passkeys (ADR-052) — MANAGEMENT ONLY on this transport. `webauthn.ipc.ts`
  // registers exactly four channels; the two register verbs below are
  // deliberately absent from it, so wiring them here would be an invoke against
  // a channel that does not exist.
  //
  // The ceremony verbs REFUSE here rather than round-tripping. The desktop
  // renderer loads from `file://` (or the vite dev origin), so it has no RP ID
  // to bind a credential to and `webauthnOrigin` is null on its connection —
  // there is no ceremony to run, and pretending otherwise would produce a
  // credential that can never assert. Desktop-side enrollment is the QR /
  // one-time-link flow (`webauthnMintEnrollToken`).
  webauthnRegisterOptions: async () => {
    throw new Error('Passkey enrollment runs in a browser — use the enrollment link or QR code.')
  },
  webauthnRegisterVerify: async () => {
    throw new Error('Passkey enrollment runs in a browser — use the enrollment link or QR code.')
  },

  // Voice input — the transport only; the renderer owns the microphone. Audio is
  // a fire-and-forget `send`, not an invoke: ~7 a second, nothing to answer.
  voiceAudio: (routingId: string, dataB64: string) =>
    ipcRenderer.send('voice:audio', routingId, dataB64),

  logError: (source: string, message: string) => {
    ipcRenderer.send('log:error', source, message)
  },
  // Renderer → main process log relay
  logRelay: (level: string, source: string, message: string) =>
    ipcRenderer.send('log:relay', level, source, message),

  // Mockup preview
  getMockupPreviewUrl: (cwd: string, directory: string, opts?: { dark?: boolean }) =>
    buildMockupUrl(cwd, directory, { dark: opts?.dark, parentOrigin: window.location.origin })
}

// Everything else is one declaration each, in `shared/api-invoke-table.ts`. Notes that used to sit
// beside the hand-written members and still hold:
//  - Terminal pool, remote IDE (ADR-064), `watchStreams` (phase 5 S1) and `watchGit` (phase 5 S2)
//    are real IPC on the desktop too, not constants: the renderer is one connection among several.
//  - The `authcfg:*` routine settings (ADR-054 §6) are registered on BOTH transports so the
//    capability/kind declaration is one reviewed fact; the desktop connection is the host anchor
//    and is exempt from the settings-session gate, so they behave like `remote:set-config`.
//  - `getRemoteStatusView` is the redacted twin (`core/ipc/remote-view-commands.ts`): real IPC
//    rather than a local projection so the desktop cannot drift from what a phone is shown.
//  - Worktree create/remove are declared `withProgress`: always on the progress path.
const api: ClaudeAPI = {
  ...buildInvokeApi(API_INVOKES, transport),
  ...buildInvokeApi(DESKTOP_INVOKES, transport),
  ...buildEventApi(API_EVENTS, transport),
  ...buildEventApi(DESKTOP_EVENTS, transport),
  ...own
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

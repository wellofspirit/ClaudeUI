import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { claudeLoginSignal } from '../services/claude-login-state'
import { SessionManager } from '../services/session-manager'
import { configureContextPressure } from '../services/context-pressure'
import { configureSessionTools } from '../services/session-tools'
import { startApplyingSettings } from '../services/app-settings-apply'
import { emitEvent } from '../services/sync-host'
import { STREAM_WATCH_COMMAND } from './stream-watch'
import { GIT_WATCH_COMMAND } from './git-watch'
import { getHostWindow } from '../services/host-window'
import { seedCanonicalAppState, refreshCanonicalDirectories } from '../services/sync-seed'
import { voiceRefusal } from '../services/voice-gate'
import { desktopVoiceOwner, desktopVoiceOwnerKey, voiceRelay } from '../services/voice-relay'
import { startConfigWatcher } from '../services/ui-config'
import { startClaudeSandboxWatcher } from '../services/claude-sandbox-watch'
import { gitWatchRegistry } from '../services/git-watch-registry'
import { usageFetcher } from '../services/usage-fetcher'
import { serviceSession } from '../services/service-session'
import { blockUsageService } from '../services/block-usage'
import { crossEngineDispatcher } from '../services/cross-engine-dispatcher'
import {
  hostIsPackaged,
  pickHostDirectory,
  reportHostLoginStatus,
  updateClaudeAuthSource
} from '../host'
import type { ModelInfo } from '../../shared/types'
import { logger } from '../services/logger'
import { onOpencodeSessionListChanged } from '../services/opencode-session-list'
import type { ISession } from '../providers/ISession'
import { prepareAndCreateSession } from './create-session'
import { freshClaudeModels, queryClaudeModels } from '../services/claude-model-catalog'
import { safeHandler } from './safe-handler'
import { handleIpc, unbindDesktopChannels } from './desktop-transport-binding'
import { configCommands } from './config-commands'
import { gitCommands } from './git-commands'
import { mockupCommands } from './mockup-commands'
import { usageMeteringCommands } from './usage-metering-commands'
import { appStateCommands } from './app-state-commands'
import { modelCommands } from './model-commands'
import { sessionCommands } from './session-commands'
import { sessionHistoryCommands } from './session-history-commands'
import { authCommands, type AuthCommandDeps } from './auth-commands'
import { usageHubCommands, USAGE_HUB_CHANNELS } from './usage-hub-commands'
import { openrouterCommands, OPENROUTER_CHANNELS } from './openrouter-commands'
import { harnessCommands, HARNESS_CHANNELS } from './harness-commands'
import { voicePackCommands, VOICE_PACK_CHANNELS } from './voice-pack-commands'
import { sendPrompt } from './handlers-core'

// `safeHandler` (the IpcResult envelope) and `handleIpc` (the desktop transport
// adapter) both moved out of this file with the S1b registration sweep: the
// channels that sweep shares with the WebSocket transport are declared once, in
// an Electron-free module, so the envelope had to become Electron-free too — and
// `automation.ipc.ts` needed the same adapter rather than a second copy of it.
// See `safe-handler.ts` / `desktop-transport.ts`.

// The model list is derived from cli.js's initialize response, which reflects
// ~/.claude.json's additionalModelOptionsCache. That cache is warmed by cli.js's
// bootstrap fetch a few seconds AFTER a spawn's init resolves (fire-and-forget),
// so newly-entitled models (e.g. Fable) can be absent from the very first fetch on
// a cold cache. A short TTL lets a subsequent picker fetch (the renderer re-fetches
// on cwd change / a model reload) pick them up without an app restart.
const MODELS_CACHE_TTL_MS = 2 * 60_000

/** Has a desktop model fetch reported login status from cli.js's init yet? */
let loginStatusReported = false

/** Test seam: forget that a desktop fetch has reported, so the next one queries again. */
export function resetLoginStatusReportedForTests(): void {
  loginStatusReported = false
}

async function fetchModels(): Promise<ModelInfo[]> {
  // A remote picker fetch fills the same catalog, so a fresh one need not be
  // ours: the desktop's FIRST fetch still queries, because only it reports login
  // status from the init response (the remote path has no auth side effects).
  const fresh = loginStatusReported ? freshClaudeModels(MODELS_CACHE_TTL_MS) : null
  if (fresh) return fresh

  const models = await queryClaudeModels((init) => {
    // The same initialize response carries the user's account — report login
    // status at app load so the sign-in banner is accurate before any chat
    // session is opened. ADR-014.
    // reportLoginStatus broadcasts session:auth-source to the window (legacy
    // path). Through the `HostAuth` seam since S3 stage 1b — status-only, and
    // a no-op with no host wired.
    reportHostLoginStatus(init?.account)
    // Also update the ClaudeAuthProvider probe cache so probe() and session.account
    // are accurate from the first model-fetch, before any chat session opens.
    // The same signal the banner reads (claude-login-state.ts).
    if (init?.account) {
      const { loggedIn, account } = claudeLoginSignal(init.account)
      updateClaudeAuthSource(loggedIn ? 'authenticated' : 'none', account)
    }
  })
  // Set once the query answered, whether or not its init could be read: a
  // failed read is non-fatal (per-session init reports status too), and must not
  // send every later fetch past the cache.
  loginStatusReported = true
  return models
}

const SESSION_IPC_CHANNELS = [
  // The volatile lane's subscription verb (phase 5 S1) — registered below like
  // every other channel here, so it must be removable like every other one too.
  'stream:watch',
  'session:pick-folder',
  'session:create',
  'session:rekey',
  'session:resolve-fork-anchor',
  'session:send',
  'session:cancel',
  'session:interrupt',
  'session:approval-response',
  'session:approve-blocked',
  'session:watch-background',
  'session:unwatch-background',
  'session:read-background-range',
  'session:stop-task',
  'session:background-task',
  'session:dequeue-message',
  'session:allow-peer-messages',
  'session:link:set-grouped',
  'session:proposal:start',
  'session:proposal:dismiss',
  'session:context-pressure:respond',
  'session:ask-side-question',
  'session:set-permission-mode',
  'session:set-model',
  'session:set-effort',
  'session:set-reasoning-variant',
  'session:get-models',
  'session:get-engine-models',
  'automode:judge-model-support',
  'automode:judge-route-resting',
  'session:get-opencode-providers',
  'session:set-opencode-provider-disabled',
  'session:remove-opencode-provider',
  'session:get-opencode-provider-models',
  'session:get-pi-model-catalog',
  'session:generate-title',
  'session:generate-commit-message',
  'session:write-custom-title',
  'session:get-plan-content',
  'session:get-session-log-path',
  'session:delete-session',
  'session:delete-project',
  'session:clear-conversation',
  'session:list-directories',
  'session:list-opencode',
  'session:load-opencode-history',
  'session:list-pi',
  'session:load-pi-history',
  'session:load-history',
  'session:load-status-line',
  'session:load-subagent-history',
  'blob:get',
  'session:build-subagent-file-map',
  'session:load-background-output',
  'session:watch-session',
  'session:unwatch-session',
  'config:load-settings',
  'config:save-settings',
  'config:load-sessions',
  'config:save-sessions',
  'config:load-slash-commands',
  'config:save-slash-commands',
  'config:load-skill-details',
  'config:load-opencode-settings',
  'config:save-opencode-settings',
  'config:read-opencode-native-raw',
  'config:patch-opencode-native',
  'config:list-agent-types',
  'opencode-agents:list',
  'opencode-agents:read',
  'opencode-agents:save',
  'opencode-agents:delete',
  'opencode-agents:set-disabled',
  'opencode-agents:generate',
  'git:check-repo',
  'git:status',
  'git:branches',
  'git:checkout',
  'git:create-branch',
  'git:file-patch',
  'git:file-contents',
  'git:stage-file',
  'git:unstage-file',
  'git:discard-file',
  'git:stage-all',
  'git:unstage-all',
  'git:commit',
  'git:push',
  'git:push-with-upstream',
  'git:pull',
  'git:stash-push',
  'git:stash-restore',
  'git:fetch',
  'git:watch',
  'file:list-dir',
  'file:list-places',
  'usage:fetch',
  'usage:fetch-block',
  'usage:chatgpt-limits',
  'usage:limits',
  'usage:windows',
  'usage:dashboard',
  'usage:set-account-filter',
  'usage:refresh-prices',
  'auth:sign-in',
  'auth:submit-code',
  'auth:cancel',
  'account:get',
  'account:set-enabled',
  'account:add',
  'account:switch',
  'account:delete',
  'claude:load-permissions',
  'claude:save-permissions',
  'claude:get-cleanup-period',
  'claude:set-cleanup-period',
  'claude:set-disable-auto-mode',
  'claude:set-sandbox',
  'claude:sandbox-scopes',
  'mcp:status',
  'mcp:toggle',
  'mcp:reconnect',
  'mcp:set-servers',
  'mcp:load-servers',
  'mcp:load-catalog',
  'mcp:cli-add',
  'mcp:cli-remove',
  'mcp:reload',
  'mcp:save-servers',
  'mcp:remove-server',
  'mcp:read-disabled',
  'mcp:toggle-disabled',
  'worktree:create',
  'worktree:status',
  'worktree:remove',
  'worktree:inventory',
  'worktree:inspect',
  'worktree:measure',
  'worktree:remove-many',
  'app:quit-confirm',
  'session:sandbox-violation',
  'voice:start-recording',
  'voice:stop-recording',
  'proxy:test-connection',
  'vendor-auth:probe',
  'vendor-auth:list-options',
  'vendor-auth:list-keys',
  'vendor-auth:set-key',
  'vendor-auth:oauth-authorize',
  'vendor-auth:device-code-start',
  'vendor-auth:device-code-status',
  'vendor-auth:oauth-callback',
  'vendor-auth:oauth-cancel',
  'vendor-auth:remove'
]

/** Shared SessionManager — created once, used by both IPC and remote handlers. */
let sharedManager: SessionManager | null = null
export function getSessionManager(): SessionManager | null {
  return sharedManager
}

/**
 * Register every session/config/git/usage channel and start the window-independent
 * services behind them.
 *
 * **Takes no window (SyncCore phase 4d).** It used to take the one it was called
 * with from `createWindow`, which made the whole surface — including the canonical
 * seeds and the watchers below — window-lifetime code that could not run at all
 * without a `BrowserWindow`. It is called once from `bootCore()` now, BEFORE any
 * window decision, so the two places that genuinely want the host's window (a
 * native folder picker and the spawn handle a session holds) read it from
 * `services/host-window.ts` at USE time and cope with `null`.
 */
export function registerSessionIpc(authDeps: AuthCommandDeps): SessionManager {
  // Remove previous handlers to allow re-registration (e.g. a second bootCore in
  // a test; production boots core exactly once).
  unbindDesktopChannels([
    ...SESSION_IPC_CHANNELS,
    ...USAGE_HUB_CHANNELS,
    ...OPENROUTER_CHANNELS,
    ...HARNESS_CHANNELS,
    ...VOICE_PACK_CHANNELS
  ])

  const manager = new SessionManager()
  sharedManager = manager
  // The session tools create sessions and send prompts through the same functions
  // the commands below use; the service sits under this layer, so it is handed them.
  configureSessionTools({
    manager,
    // A message to an X-Agent steers its running turn or starts a run of it (ADR-105 §4).
    xAgents: { message: (request) => crossEngineDispatcher.messageXAgent(request) },
    createSession: (args) => prepareAndCreateSession(manager, getHostWindow(), args),
    sendPrompt: (routingId, prompt, options) =>
      sendPrompt(manager, routingId, prompt, undefined, options)
  })
  // No turn-end notes: a session that was started from another reports nothing back
  // (session-notes.ts is dormant on purpose — nothing here enables it).
  // So does the context-pressure watcher's hand-off instruction.
  configureContextPressure({
    manager,
    sendPrompt: (routingId, prompt, options) =>
      sendPrompt(manager, routingId, prompt, undefined, options)
  })

  // The volatile lane's subscription verb (phase 5 S1). Same declaration the
  // remote transport registers — see `ipc/stream-watch.ts`.
  handleIpc(STREAM_WATCH_COMMAND)

  handleIpc({
    channel: 'session:pick-folder',
    capability: 'host',
    kind: 'command',
    handler: async () => {
      // `host` capability, so only the desktop client can reach this. The native
      // dialog itself is a HOST act — Electron's overload set even makes the
      // window-parented and unparented calls two different calls — so it lives
      // behind the `HostPicker` seam (S3 stage 1b) and the desktop wires
      // `dialog.showOpenDialog` into it from `boot-core`. A headless server has
      // no operator at a console to show a picker to, so it wires nothing and
      // this resolves to `null` — the same answer a cancelled dialog gives.
      return await pickHostDirectory()
    }
  })

  // The live-session channels: one declaration both transports spread
  // (`ipc/session-commands.ts`); the desktop envelopes the two `delete-*` verbs.
  for (const cmd of sessionCommands(manager, 'desktop')) {
    handleIpc(cmd)
  }

  // Session listing, transcript history and the folder browser: one declaration both
  // transports spread (`ipc/session-history-commands.ts`).
  for (const cmd of sessionHistoryCommands()) {
    handleIpc(cmd)
  }

  // Voice input handlers (gated by capabilities.voice: Claude on a binary
  // carrying the voice-server patch; opencode and pi on a host the
  // on-device speech pack supports, ADR-101).
  //
  // The microphone is the RENDERER's (`renderer/src/lib/voice/`): these two verbs
  // only bind the desktop window's pushed audio — the `voice:audio` IPC message,
  // fed in by `main/ipc/voice-feed.ts` — to the session's voice server, through
  // the same relay a remote browser's capture uses. They stay registry commands,
  // so "a microphone was opened on this session" is in the audit trail.
  //
  // The capture OWNER is the host window. Handlers never see Electron's invoke
  // event (desktop-transport-binding.ts), so the owner is not read off the IPC
  // sender; it does not need to be — the host window is the only renderer that
  // carries the voice API (the log viewer has its own preload), so it IS the
  // sender. The audio feed keys by `event.sender.id`, and the two meet in
  // `desktopVoiceOwnerKey`.
  handleIpc({
    channel: 'voice:start-recording',
    capability: 'host',
    kind: 'command',
    sessionIdArg: 0,
    handler: safeHandler(
      async (routingId: string, language: string, opts?: { preview?: boolean }) => {
        const session = manager.get(routingId)
        if (!session) throw new Error('No active session')
        const refusal = voiceRefusal(session)
        if (refusal) throw new Error(refusal)
        const win = getHostWindow()
        if (!win) throw new Error('No desktop window to capture for')
        await voiceRelay.start(manager, desktopVoiceOwner(win), routingId, language, {
          preview: opts?.preview
        })
      }
    )
  })

  handleIpc({
    channel: 'voice:stop-recording',
    capability: 'host',
    kind: 'command',
    sessionIdArg: 0,
    // Not gated on the session: the capture is the WINDOW's, and a session that
    // vanished (or lost voice) mid-press must still release it. Idempotent.
    handler: safeHandler(async (_routingId: string) => {
      const win = getHostWindow()
      if (!win) return
      await voiceRelay.stop(desktopVoiceOwnerKey(win.webContents.id))
    })
  })

  // The model catalog, opencode providers and title / commit-message generation: one
  // declaration both transports spread (`ipc/model-commands.ts`). The desktop's Claude model
  // read is `fetchModels` (TTL cache + login-status report); the remote's has no auth side effects.
  for (const cmd of modelCommands(fetchModels)) {
    handleIpc(cmd)
  }

  // The app-state reads and settings writes (UI config, engine/pi/account status, the shared-
  // provider reads, Claude permissions/trust/retention, MCP reads): one declaration both
  // transports spread (`ipc/app-state-commands.ts`); the desktop envelopes the shared-provider reads.
  // (The shared-provider MUTATIONS are `ipc/auth-commands.ts`, ADR-057.)
  for (const cmd of appStateCommands(manager, 'desktop')) {
    handleIpc(cmd)
  }

  // -------------------------------------------------------------------------
  // Git integration IPC handlers
  // -------------------------------------------------------------------------

  // One declaration, both transports (`ipc/git-commands.ts`); the desktop envelopes them.
  for (const cmd of gitCommands('desktop')) {
    handleIpc(cmd)
  }

  // Git polling — one poller per cwd, shared with the remote path through
  // gitWatchRegistry. GitService.startPolling() holds a SINGLE callback, so two
  // independent starts on one cwd would silently clobber each other; the registry
  // is what keeps every connection's interest coexisting on one poller. This is
  // also the only place that knows the fan-out, so it installs it.
  gitWatchRegistry.init((cwd, status) => {
    emitEvent('git:status-update', [{ cwd, status }])
  })

  // Per-connection interest (phase 5 S2). Same declaration the remote transport
  // registers — see `ipc/git-watch.ts`. The desktop is a connection like any
  // other: it dispatches under the process-wide `hostConnection()` id, which is
  // what its watch set is keyed by.
  handleIpc(GIT_WATCH_COMMAND)

  // The config / worktree family (S1b). ONE declaration per channel, spread here
  // for the desktop and in `remote-handlers.ts` for the WebSocket — see
  // `ipc/config-commands.ts` for what is in it and why each entry is reachable
  // from a phone.
  for (const cmd of configCommands(manager)) {
    handleIpc(cmd)
  }

  // Watch ~/.claude/projects/ for JSONL changes and notify renderer to refresh
  startProjectsWatcher()

  // Watch ~/.claude/ui/ config files for cross-instance sync. The watcher emits
  // through the funnel now, so it no longer needs an extra-window accessor.
  startConfigWatcher()
  // The shared sandbox block of Claude Code's own settings file: an outside edit shows live.
  startClaudeSandboxWatcher()

  // SyncCore phase 4b: canonical state is the `sync-full` source, so the fields
  // that come from files/queries rather than events have to be in it before the
  // first client connects. Non-blocking — nothing here gates IPC registration.
  void seedCanonicalAppState()

  // Order is load-bearing: the seed sets canonical settings synchronously, before its first await.
  startApplyingSettings(manager)

  // Account usage polling (5hr / 7-day rate limits).
  // Real-time updates come from SDK rate_limit_event messages (free, from
  // inference headers). Background polling (the `usageRefreshSecs` setting,
  // default 120 s) fetches supplementary data (per-model breakdowns,
  // extra_usage). Disk cache avoids API calls on every launch.
  // Wire up SDK usage relay — tries active user sessions first, then
  // the always-on service session as fallback.
  usageFetcher.setSessionGetter(async () => {
    // Try active sessions first (they're already running; costUsd capability implies getUsage)
    const sessions: ISession[] = []
    manager.forEach((s) => sessions.push(s))
    for (const session of sessions) {
      try {
        const data = await session.getUsage?.()
        if (data != null) return data
      } catch {
        /* try next session */
      }
    }
    // Fall back to the service session (spawns lazily on first call)
    return serviceSession.getUsage()
  })
  // The poll ITSELF is started by `startCoreServices`, after the host's
  // `afterSessionGraph` hook has applied the active credential dir; `applySettings`
  // sets its interval above.

  // Block usage analytics — watches JSONL files for changes (no polling).
  // Full scan on startup, then event-driven recalculation on file changes.
  // Disabled in dev builds to avoid snapshot write conflicts with the prod
  // instance. Set CLAUDE_UI_DEV_USAGE=1 to enable for testing.
  const skipUsageInDev = !hostIsPackaged() && !process.env.CLAUDE_UI_DEV_USAGE
  if (!skipUsageInDev) {
    // Phase 7 Pass 2 (Full SQL): run the backfill reconciler FIRST so usage_event
    // holds out-of-tool Claude + opencode usage before the first dashboard
    // emission (no flash of missing per-engine/opencode data). recalculate() is
    // itself self-sufficient for the Claude dashboard — it self-upserts its
    // freshly-parsed JSONL into usage_event, then reads SQL-sourced blocks and
    // the hourly buckets it rolls up — so even if reconcile is slow/fails, the
    // Claude blocks + history are never empty.
    //
    // Lazy import: usage-reconciler statically imports block-usage →
    // usage-fetcher → claude-session, so a static import from this module (which
    // is imported by claude-session) would form a static cycle. Loaded here at
    // IPC startup instead.
    import('../../core/services/usage-reconciler')
      .then(({ usageReconciler }) => {
        usageReconciler
          .reconcileAll()
          .catch(() => {})
          .finally(() => {
            blockUsageService.recalculate().catch((err) => {
              logger.error('BlockUsage', 'Initial recalculation failed', err)
            })
          })
        usageReconciler.start()
      })
      .catch(() => {})
    blockUsageService.startWatching()
  } else {
    logger.info(
      'IPC',
      'Dev mode — skipping block usage writes (set CLAUDE_UI_DEV_USAGE=1 to enable)'
    )
  }

  // The usage metering channels — always registered so the renderer never gets "no handler"
  // errors; one declaration both transports spread (`ipc/usage-metering-commands.ts`).
  for (const cmd of usageMeteringCommands()) {
    handleIpc(cmd)
  }

  // Native Anthropic OAuth (ADR-014), multi-account MUTATIONS (ADR-015), the
  // engine-routed per-vendor auth channels (Phase 5c) and the shared-provider
  // MUTATIONS live in `ipc/auth-commands.ts` (S4 vendor-OAuth series, ADR-057): ONE
  // declaration both transports spread, so the remote UI can drive them too. `config`
  // since ADR-056 (engine/vendor credentials, not the session-security surface). The
  // desktop-auth subsystem stays in `src/main`, so the factory takes
  // `requireEngineAuth` / `setAccountEnabled` injected here.
  for (const cmd of authCommands(authDeps)) {
    handleIpc(cmd)
  }

  // The usage hub (ADR-072 §7), from the same shared declarations the remote
  // transport spreads. Not inline like the `usage:*` family above: six channels,
  // one of them a credential write, and one declaration is what keeps the
  // capability and the sanitiser identical on both transports.
  for (const cmd of usageHubCommands()) {
    handleIpc(cmd)
  }

  // The OpenRouter tab's reads, from the same declarations the remote transport
  // spreads: `config` queries, key read from the vault per call (never returned).
  for (const cmd of openrouterCommands()) {
    handleIpc(cmd)
  }

  // The harness manager (ADR-082 arc 2), from the same declarations the remote
  // transport spreads: reads are `config`, every write `admin` (§7).
  for (const cmd of harnessCommands()) {
    handleIpc(cmd)
  }

  // The speech pack (ADR-101 §6): status is `chat`, install/cancel/remove `admin`.
  for (const cmd of voicePackCommands()) {
    handleIpc(cmd)
  }

  // Mockup preview (read HTML + live-reload watch) — `ipc/mockup-commands.ts`; the desktop
  // envelopes the read.
  for (const cmd of mockupCommands('desktop')) {
    handleIpc(cmd)
  }

  return manager
}

/** Matches the 30 s cadence the sidebar polled at before the merge moved here. */
const DIRECTORY_POLL_MS = 30_000

/**
 * Keep the replicated sidebar listing fresh: a watcher on Claude's transcripts,
 * plus a poll for the two engines that have no watchable path.
 *
 * The POLL is unconditional and starts first, deliberately. Only Claude keeps
 * transcripts under `~/.claude/projects`; opencode keeps sessions in its own
 * store and pi in `~/.pi`, so on a machine that has never run Claude the watcher
 * below returns early and the poll would be the ONLY thing that ever refreshed
 * the sidebar. `refreshCanonicalDirectories` emits only when the merged listing
 * actually changed, so a quiet host adds nothing to the ring; `unref()` keeps
 * the timer from holding the process open at quit.
 */
function startProjectsWatcher(): void {
  setInterval(() => {
    void refreshCanonicalDirectories()
  }, DIRECTORY_POLL_MS).unref?.()
  // opencode's list is refreshed from its server in the background (ADR-097
  // §6, S9): a refresh that changed it re-emits the merged listing at once.
  onOpencodeSessionListChanged(() => void refreshCanonicalDirectories())

  const projectsDir = path.join(os.homedir(), '.claude', 'projects')
  if (!fs.existsSync(projectsDir)) return

  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  const notify = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      // ONE call: it re-reads the MERGED listing and emits
      // `session:directories-changed` carrying it (only when the listing really
      // changed), so canonical and every live client are updated by the same
      // fold — the refetch-per-client round trip is gone. Fire-and-forget: the
      // watcher must not wait on a directory walk.
      void refreshCanonicalDirectories()
    }, 500)
  }

  // Watch each project subdirectory for JSONL file changes
  // (fs.watch recursive option works on macOS and Windows)
  try {
    fs.watch(projectsDir, { recursive: true }, (_event, filename) => {
      if (filename && filename.endsWith('.jsonl')) {
        notify()
      }
    })
  } catch (err) {
    logger.warn('ProjectsWatcher', 'Failed to watch projects directory', err)
  }
}

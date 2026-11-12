import { RemoteDispatcher } from '../services/remote-dispatcher'
import { STREAM_WATCH_COMMAND } from './stream-watch'
import { GIT_WATCH_COMMAND } from './git-watch'
import { SessionManager } from '../services/session-manager'
import { syncTimingReports } from '../services/sync-timing-report'
import { SYNC_REPORT_TIMING_CHANNEL } from '../shared/sync/sync-timing'
import { hostAppVersion } from '../host'
import type { ModelInfo } from '../../shared/types'
import { getCliVersion } from '../sdk/harness'
import { queryClaudeModels } from '../services/claude-model-catalog'
import { logger } from '../services/logger'
import { terminalService } from '../services/terminal-service'
import { remoteVoiceOwner, voiceRelay } from '../services/voice-relay'
import {
  registerCommand,
  type CommandConnection,
  type CommandRegistration
} from './command-registry'
// The JSON-null normaliser. It was defined in this file until the command
// modules both transports share were swept for the same class — see its doc
// comment for what `null` does downstream and where it is deliberately left
// alone.
import { opt } from './wire-args'
import { configCommands } from './config-commands'
import { gitCommands } from './git-commands'
import { mockupCommands } from './mockup-commands'
import { usageMeteringCommands } from './usage-metering-commands'
import { appStateCommands } from './app-state-commands'
import { modelCommands } from './model-commands'
import { sessionCommands } from './session-commands'
import { sessionHistoryCommands } from './session-history-commands'
import { ideCommands, type IdeCommandHost } from './ide-commands'
import { usageHubCommands } from './usage-hub-commands'
import { openrouterCommands } from './openrouter-commands'
import { harnessCommands } from './harness-commands'
import { voicePackCommands } from './voice-pack-commands'
import { remoteViewCommands, type RemoteStatusHost } from './remote-view-commands'
import { authCommands, type AuthCommandDeps } from './auth-commands'
import { AUTOMATION_COMMANDS } from './automation-commands'
import {
  mintEnrollToken,
  webauthnCredentials,
  webauthnRegisterOptions,
  webauthnRegisterVerify,
  webauthnRename,
  webauthnRevoke,
  type RemoteAuthSurfaceHost,
  type RegisterVerifyResult
} from './webauthn-commands'
import {
  authcfgApply,
  authcfgEnd,
  authcfgGet,
  authcfgLanLink,
  authcfgRotateLanKey,
  authcfgSetPassword,
  type AuthcfgApplyPatch,
  type AuthcfgHost
} from './authcfg-commands'
import type { RegistrationResponseJSON } from '@simplewebauthn/server'

/**
 * Registers the remote-transport handlers on the shared command registry.
 * These are the same operations exposed via IPC, but called by the WebSocket
 * server instead of ipcMain.handle.
 *
 * Gating is fail-closed (SyncCore phase 1 — ADR-051/052): every channel here
 * DECLARES a capability, and a remote connection can only reach it if that
 * capability is in its grant set. Desktop-only surfaces (`window:*`,
 * `terminal:*`, `auth:*`, account mutations, `remote:*` config, …) are simply
 * not registered here, and their capabilities (`host`/`shell`/`admin`) are not
 * granted to remote connections — so registering one by accident could not
 * expose it either. That double property replaces the old dispatcher denylist.
 */

/**
 * Register one remote-transport command. Counterpart of session.ipc.ts's
 * `handleIpc`; the registry is the same instance, so a channel served by both
 * surfaces must agree on capability/kind or registration throws.
 */
function handleRemote(reg: Omit<CommandRegistration, 'transport'>): void {
  registerCommand({ ...reg, transport: 'remote' })
}

/** What `app:version-info` answers. */
export interface VersionInfo {
  appVersion: string
  cliVersion: string
}

/**
 * What `app:version-info` serves unless a host overrides it
 * ({@link registerRemoteVersionInfo}): the version the host published
 * (`setHostAppVersion`, which the desktop sets from `app.getVersion()` and
 * claudeui-server from its package manifest, `unknown` when it has none) and the
 * Claude Code version of the harness that would spawn — read per call, since the
 * harness selection can change while the host runs (ADR-082).
 */
const defaultVersionInfo = (): VersionInfo => ({
  appVersion: hostAppVersion(),
  cliVersion: getCliVersion()
})

let versionInfoSource: () => VersionInfo = defaultVersionInfo

/** Test seam: drop any override, so `app:version-info` serves the host's defaults again. */
export function resetRemoteVersionInfoForTests(): void {
  versionInfoSource = defaultVersionInfo
}

/**
 * Override what `app:version-info` answers. Order-independent: the channel itself
 * is registered by {@link registerRemoteHandlers} (so every host that serves the
 * remote surface — the desktop AND claudeui-server — serves it), and this only
 * replaces its source, whether it runs before or after that. The desktop passes
 * its display-form version.
 *
 * A function is read per call: the Claude Code version follows the harness
 * selection, so the desktop passes one that asks `getCliVersion()`.
 */
export function registerRemoteVersionInfo(versionInfo: VersionInfo | (() => VersionInfo)): void {
  versionInfoSource = typeof versionInfo === 'function' ? versionInfo : () => versionInfo
}

/** Uncached claude model list (no auth-source side effects — those are
 *  desktop-only; see handlers-core.ts rationale). Goes through the shared query
 *  that also records the host's model catalog, so a remote picker fetch feeds
 *  automation runs the way a desktop one does. */
async function claudeSupportedModels(): Promise<ModelInfo[]> {
  return queryClaudeModels()
}

/**
 * Register the remote transport's command surface.
 *
 * **Takes no window (SyncCore phase 4d).** It used to capture `createWindow`'s
 * window purely to hand it to `prepareAndCreateSession` as the new session's host
 * handle; core registers this BEFORE any window decision now, so the handle is
 * read at spawn time from `services/host-window.ts` and is `null` when the app
 * runs windowless.
 */
export function registerRemoteHandlers(
  dispatcher: RemoteDispatcher,
  manager: SessionManager,
  /**
   * The running remote server: the auth-surface host for
   * `webauthn:mint-enroll-token` and the `authcfg:*` family, and — since the
   * 2026-08-28 status-view ruling — the STATUS SOURCE behind the redacted
   * `remote:status-view` (it is the same object in every deployment, so a second
   * parameter would only be a second way to hand over the same server).
   *
   * Optional so the existing two-argument call sites (and every test) keep
   * working; absent, each of those channels still registers but throws — the
   * channel SET must not depend on runtime configuration, or the parity pins
   * would report a different surface in tests than in production.
   */
  enrollTokens?: RemoteAuthSurfaceHost & AuthcfgHost & RemoteStatusHost & IdeCommandHost,
  /**
   * The desktop-auth dependencies for the vendor-OAuth / account / native-OAuth
   * command family (ADR-057, S4). Optional for the SAME reason `enrollTokens` is
   * — the channel SET must not depend on runtime configuration, or the parity
   * pins would report a different surface in tests than in production. Absent
   * (every existing two/three-arg call site, and the tests), the channels still
   * register but each handler throws `auth surface unavailable` on dispatch.
   * `boot-core` passes the real `engineAuthRegistry` / `account-manager`.
   */
  authDeps?: AuthCommandDeps
): void {
  // Registered here, not by `registerRemoteVersionInfo`, so the channel exists
  // whatever order a host calls them in (the desktop calls the latter BEFORE
  // `bootCore` gets here; claudeui-server never calls it).
  handleRemote({
    channel: 'app:version-info',
    capability: 'config',
    kind: 'query',
    handler: async () => versionInfoSource()
  })

  // -------------------------------------------------------------------------
  // Sessions: lifecycle, control, listing and history, models, and the volatile lane
  // -------------------------------------------------------------------------

  // The live-session channels: one declaration both transports spread
  // (`ipc/session-commands.ts`); answered bare here.
  for (const cmd of sessionCommands(manager, 'remote')) {
    handleRemote(cmd)
  }

  // The volatile lane's subscription verb (phase 5 S1). Same declaration the
  // desktop transport registers — see `ipc/stream-watch.ts`.
  handleRemote(STREAM_WATCH_COMMAND)

  // Session listing, transcript history and the folder browser: one declaration both
  // transports spread (`ipc/session-history-commands.ts`).
  for (const cmd of sessionHistoryCommands()) {
    handleRemote(cmd)
  }

  // The model catalog, opencode providers and title / commit-message generation: one
  // declaration both transports spread (`ipc/model-commands.ts`), here with the Claude model
  // read that has no desktop auth-source side effects.
  for (const cmd of modelCommands(claudeSupportedModels)) {
    handleRemote(cmd)
  }

  // The web client's cost of one full sync, into the host log (`SyncStats`). The
  // desktop renderer relays its own through `log:relay`; a browser has no such
  // channel, so this is the one narrow door: ONE object of numbers, validated and
  // formatted by the host, rate-limited per connection (hence `withConnection`).
  // `chat` because every connection that can sync holds it — the snapshot this
  // reports on is chat-class data — and a `query`, so it is neither audited nor
  // behind step-up. Remote-only on purpose: nothing on the desktop calls it.
  handleRemote({
    channel: SYNC_REPORT_TIMING_CHANNEL,
    capability: 'chat',
    kind: 'query',
    withConnection: true,
    handler: async (connection: CommandConnection, report: unknown) =>
      syncTimingReports.report(connection.connectionId, report)
  })

  // -------------------------------------------------------------------------
  // Config (read-write, synced bidirectionally)
  // -------------------------------------------------------------------------

  // The app-state reads and settings writes (UI config, engine/pi/account status, the shared-
  // provider reads, Claude permissions/trust/retention, MCP reads): one declaration both
  // transports spread (`ipc/app-state-commands.ts`); answered bare here.
  for (const cmd of appStateCommands(manager, 'remote')) {
    handleRemote(cmd)
  }

  // -------------------------------------------------------------------------
  // Usage (`ipc/usage-metering-commands.ts`)
  // -------------------------------------------------------------------------

  for (const cmd of usageMeteringCommands()) {
    handleRemote(cmd)
  }

  // -------------------------------------------------------------------------
  // Git — full parity incl. mutations (user decision: token is the sole gate).
  // Same gitServiceManager the desktop git:* IPC handlers use (get/release).
  //
  // Live watching goes through gitWatchRegistry, the SAME registry the desktop
  // `git:watch` handler uses. Neither side may start its own poller:
  // GitService.startPolling() holds a single callback, so a second start would
  // replace the other surface's broadcast. The registry runs at most one poller
  // per cwd, driven by the UNION of every connection's interest set, and fans
  // `git:status-update` out as an ordinary replicated event.
  // -------------------------------------------------------------------------

  // Per-connection interest (phase 5 S2). Same declaration the desktop transport
  // registers — see `ipc/git-watch.ts`.
  handleRemote(GIT_WATCH_COMMAND)

  // One declaration, both transports (`ipc/git-commands.ts`); answered bare here.
  for (const cmd of gitCommands('remote')) {
    handleRemote(cmd)
  }

  // -------------------------------------------------------------------------
  // Mockup preview — read HTML + watch the mockup directory for live reloads
  // (`ipc/mockup-commands.ts`; answered bare here)
  // -------------------------------------------------------------------------

  for (const cmd of mockupCommands('remote')) {
    handleRemote(cmd)
  }

  // -------------------------------------------------------------------------
  // Terminal (SyncCore phase 2 — ADR-052 decision 6, security.md §Terminal posture)
  //
  // The first channels on this surface whose capability is NOT in
  // AUTH_OFF_GRANTS. Registering them does not expose them: `shell` is
  // granted only by the step-up ceremony (a transport frame — see
  // remote-server.ts), only while the desktop-side "Allow remote terminal"
  // toggle is ON, and only until the grant decays. Three gates in series, all
  // server-side.
  // -------------------------------------------------------------------------

  // `index` (optional) selects the slot in this cwd's terminal POOL, so a phone
  // opening "terminal 0" of a repo lands on the same pty the desktop has open.
  // An older web bundle sends no index and still gets a fresh pty in the next
  // free slot — the pre-pool behavior, unchanged.
  handleRemote({
    channel: 'terminal:create',
    capability: 'shell',
    kind: 'command',
    withConnection: true,
    handler: async (connection: CommandConnection, cwd: string, index?: number) =>
      terminalService.create(connection, cwd, index)
  })

  // `terminal:write` stays registered even though the web client prefers the
  // `term-input` FRAME (no invoke bookkeeping per keystroke): it keeps the two
  // surfaces symmetrical, and it is the same gates either way.
  handleRemote({
    channel: 'terminal:write',
    capability: 'shell',
    kind: 'command',
    withConnection: true,
    handler: async (connection: CommandConnection, id: string, data: string) => {
      terminalService.write(connection, id, data)
    }
  })

  handleRemote({
    channel: 'terminal:resize',
    capability: 'shell',
    kind: 'command',
    withConnection: true,
    handler: async (connection: CommandConnection, id: string, cols: number, rows: number) => {
      terminalService.resize(connection, id, cols, rows)
    }
  })

  handleRemote({
    channel: 'terminal:kill',
    capability: 'shell',
    kind: 'command',
    withConnection: true,
    handler: async (connection: CommandConnection, id: string) => {
      terminalService.kill(connection, id)
    }
  })

  // DELIBERATE EXCEPTION to "subscriptions are queries": attach/detach are
  // subscription toggles with no domain effect, which would normally make them
  // `query` (and therefore unaudited). security.md §Audit requires terminal
  // lifecycle — spawn/attach/detach/exit with identity — in the audit trail, so
  // they are declared `command` purely to be audited. They still carry no PTY
  // content; only who attached to which terminal, and when.
  handleRemote({
    channel: 'terminal:attach',
    capability: 'shell',
    kind: 'command',
    withConnection: true,
    handler: async (connection: CommandConnection, id: string) =>
      terminalService.attach(connection, id)
  })
  handleRemote({
    channel: 'terminal:detach',
    capability: 'shell',
    kind: 'command',
    withConnection: true,
    handler: async (connection: CommandConnection, id: string) => {
      terminalService.detach(connection, id)
    }
  })

  // Live slots of one cwd's pool — the "a shell is still running here" badge on
  // the open/reopen affordance. `shell`, unlike `terminal:availability` below:
  // availability answers "may I?" and must be answerable before the grant
  // exists, while this reports the state of the operator's shells and belongs
  // behind the same three gates as the rest of the terminal surface.
  handleRemote({
    channel: 'terminal:pool',
    capability: 'shell',
    kind: 'query',
    withConnection: true,
    handler: async (connection: CommandConnection, cwd: string) =>
      terminalService.poolSlots(connection, cwd)
  })

  // -------------------------------------------------------------------------
  // Voice capture (phase 5 S3)
  // -------------------------------------------------------------------------
  //
  // The audio itself never comes through here — it rides the `voice-audio` lane
  // frame, because ~7 request/response round trips a second would be pure
  // bookkeeping and the audit trail would be a wall of noise hiding the row that
  // matters. These two verbs are that row: `chat`, `command`, audited, so "a
  // microphone was opened on this session by this identity at this time" is in
  // the trail while nothing about the speech ever is (security.md §Audit).
  //
  // `chat` and not something stronger: a capture produces a draft message, which
  // is exactly what `session:send` already lets this connection do. `withConnection`
  // because a capture belongs to the socket that started it — the audio arrives on
  // it, the transcripts go back to it alone, and it is what the capture dies with.
  handleRemote({
    channel: 'voice:start',
    capability: 'chat',
    kind: 'command',
    sessionIdArg: 0,
    withConnection: true,
    handler: async (
      connection: CommandConnection,
      routingId: string,
      language?: string | null,
      // `{ preview: false }` is the client's "no live preview" setting; anything
      // else (absent, null, a stray shape) leaves preview on — the relay only
      // reads an explicit `false`.
      opts?: { preview?: boolean } | null
    ) =>
      voiceRelay.start(
        manager,
        remoteVoiceOwner(connection.connectionId),
        routingId,
        opt(language),
        { preview: opts?.preview }
      )
  })

  handleRemote({
    channel: 'voice:stop',
    capability: 'chat',
    kind: 'command',
    withConnection: true,
    handler: async (connection: CommandConnection) => voiceRelay.stop(connection.connectionId)
  })

  // Capability honesty: the ONLY thing a web client needs to decide whether to
  // render the terminal affordance, and whether to prompt for step-up first.
  // `config` (not `shell`) on purpose — asking "may I?" must be answerable
  // without already holding the grant.
  handleRemote({
    channel: 'terminal:availability',
    capability: 'config',
    kind: 'query',
    withConnection: true,
    handler: async (connection: CommandConnection) => terminalService.availability(connection)
  })

  // -------------------------------------------------------------------------
  // Remote IDE (ADR-064) — VS Code `serve-web` behind the `ide` capability
  // -------------------------------------------------------------------------
  //
  // Declared in `ide-commands.ts` and spread by BOTH transports (the desktop half
  // is `registerIdeIpc`, called from core-services once the server exists), so
  // the capability/kind pair is one reviewed fact rather than a remote-only one.
  // `enrollTokens` is the running `RemoteServer` and supplies both things the
  // declarations cannot answer themselves: which origin a connection was
  // classified as, and which IDE service this process installed (`setIdeService`
  // is the ONE injection point — importing the module singleton here instead
  // would make that setter a lie in any deployment or test that injected a
  // different one). Absent (tests, remote-disabled harnesses) the channels still
  // register and throw — the channel SET must not depend on runtime config.
  for (const cmd of ideCommands(enrollTokens ?? null)) {
    handleRemote(cmd)
  }

  // -------------------------------------------------------------------------
  // The usage hub (ADR-072 §7)
  // -------------------------------------------------------------------------
  //
  // From the same declarations the desktop transport spreads. Remote on purpose:
  // the combined dashboard the hub feeds is not desktop-only, and neither is the
  // settings group that configures it. `capability: 'config'`, like the rest of
  // the metering surface — and no shape here can return the device secret.
  for (const cmd of usageHubCommands()) {
    handleRemote(cmd)
  }

  // -------------------------------------------------------------------------
  // The OpenRouter tab (Usage Analytics)
  // -------------------------------------------------------------------------
  //
  // From the same declarations the desktop transport spreads. `config` queries:
  // the figures are the dashboard's, and the vault key they are read with never
  // appears in an answer (see `openrouter-commands.ts`).
  for (const cmd of openrouterCommands()) {
    handleRemote(cmd)
  }

  // -------------------------------------------------------------------------
  // The harness manager (ADR-082 arc 2, §7)
  // -------------------------------------------------------------------------
  //
  // From the same declarations the desktop spreads. Every device sees the
  // Installed page (`harness:state` / `harness:versions` are `config` queries);
  // installing, choosing a source and running detection are `admin`, because
  // putting a program on the host from a phone is close to remote code
  // execution. A base connection is refused them by the registry.
  for (const cmd of harnessCommands()) {
    handleRemote(cmd)
  }

  // -------------------------------------------------------------------------
  // The speech pack (ADR-101 §6)
  // -------------------------------------------------------------------------
  //
  // From the same declarations the desktop spreads. `voice:pack-status` is a
  // `chat` query (any connection that can hold the mic can learn it needs the
  // model); install, cancel and remove are `admin`, so a base connection is
  // refused them by the registry.
  for (const cmd of voicePackCommands()) {
    handleRemote(cmd)
  }

  // -------------------------------------------------------------------------
  // Passkeys (ADR-052) — enrollment + credential management
  // -------------------------------------------------------------------------
  //
  // `enroll` and `admin` are both OUTSIDE the base remote grant set, so these
  // are reachable only from a passkey-authenticated connection, a break-glass
  // password connection, or (for the two `enroll` verbs) a one-time enrollment
  // link. The ceremony verbs are `withConnection` because the challenge binding
  // and the RP ID are per-connection facts the caller must not be able to
  // supply.
  //
  // The three management WRITES (`rename`, `revoke`, `mint-enroll-token`) also
  // require a live SETTINGS-EDITING SESSION on the calling connection (ADR-054
  // decision 6): the transport classifies them `authcfg` (`PASSKEY_ADMIN_CHANNELS`
  // in `step-up-tier.ts`) and refuses a locked editor with the typed
  // `needs-settings-session`; they are `withConnection` so each body can assert
  // the session again. The list is a free read, like `authcfg:get`.

  handleRemote({
    channel: 'webauthn:register-options',
    capability: 'enroll',
    kind: 'query',
    withConnection: true,
    handler: async (connection: CommandConnection) => webauthnRegisterOptions(connection)
  })

  handleRemote({
    channel: 'webauthn:register-verify',
    capability: 'enroll',
    kind: 'command',
    withConnection: true,
    handler: async (
      connection: CommandConnection,
      payload: { response: RegistrationResponseJSON; nickname?: string | null }
    ): Promise<RegisterVerifyResult> =>
      webauthnRegisterVerify(connection, payload, enrollTokens ?? null)
  })

  handleRemote({
    channel: 'webauthn:credentials',
    capability: 'admin',
    kind: 'query',
    handler: async () => webauthnCredentials()
  })

  handleRemote({
    channel: 'webauthn:rename',
    capability: 'admin',
    kind: 'command',
    withConnection: true,
    handler: async (connection: CommandConnection, credId: string, nickname: string | null) =>
      webauthnRename(connection, credId, nickname)
  })

  handleRemote({
    channel: 'webauthn:revoke',
    capability: 'admin',
    kind: 'command',
    // `withConnection` because revoking the LAST credential flips the AUTO
    // policy, and the resulting audit row must name the actor (who is also the
    // one client spared the re-admission disconnect).
    withConnection: true,
    handler: async (connection: CommandConnection, credId: string) =>
      webauthnRevoke(connection, credId, enrollTokens ?? null)
  })

  // Minting a link for ANOTHER device from an already-trusted phone. Requires
  // `tailscale serve` to be up — the URL's hostname is the RP ID the new
  // credential binds to (see RemoteServer.mintEnrollToken).
  handleRemote({
    channel: 'webauthn:mint-enroll-token',
    capability: 'admin',
    kind: 'command',
    withConnection: true,
    handler: async (connection: CommandConnection) =>
      mintEnrollToken(connection, enrollTokens ?? null)
  })

  // -------------------------------------------------------------------------
  // Remote-access settings (ADR-054 decision 6 — the host anchor)
  // -------------------------------------------------------------------------
  //
  // The THIRD deliberate widening of the remote surface. Every mutation declares
  // `admin` (outside the base grant set, so authenticating never suffices) AND
  // requires a live SETTINGS-EDITING SESSION on the calling connection (ADR-054
  // §6 amendment) — the transport classifies this namespace as `authcfg` and
  // refuses a locked editor with the typed `needs-settings-session`, which the
  // client must NOT cure ambiently.
  //
  // What is NOT here is the point: the `off` master switch. Auth-DISABLING
  // operations stay host-anchor only, and they stay in `remote:set-config`,
  // which has no remote registration at all. `authcfg:apply` refuses an `off`
  // auth-mode with a typed error rather than silently dropping it.

  // The READ half. A `query`, so it is classified `read` and costs no ceremony:
  // an operator must be able to SEE the tier before being asked to prove
  // presence in order to change it. Still `admin`, so only a passkey /
  // break-glass connection reaches it at all.
  handleRemote({
    channel: 'authcfg:get',
    capability: 'admin',
    kind: 'query',
    withConnection: true,
    handler: async (connection: CommandConnection) => authcfgGet(connection)
  })

  // The SAVE. One batch, validated together and written once, so a refused
  // field changes nothing and one operator action produces one audit row and
  // one 4009 sweep (ADR-054 §6 amendment). It replaces `set-tier` /
  // `set-auth-mode` / `set-retention`, which are gone.
  handleRemote({
    channel: 'authcfg:apply',
    capability: 'admin',
    kind: 'command',
    withConnection: true,
    handler: async (connection: CommandConnection, patch: AuthcfgApplyPatch) =>
      authcfgApply(connection, patch, enrollTokens ?? null)
  })

  // Closing the editor. Idempotent and callable without a session — a client
  // that lost track must be able to say "I am done" without proving it started.
  handleRemote({
    channel: 'authcfg:end',
    capability: 'admin',
    kind: 'command',
    withConnection: true,
    handler: async (connection: CommandConnection) => authcfgEnd(connection)
  })

  handleRemote({
    channel: 'authcfg:set-password',
    capability: 'admin',
    kind: 'command',
    withConnection: true,
    handler: async (connection: CommandConnection, password: string) =>
      authcfgSetPassword(connection, password, enrollTokens ?? null)
  })

  // The LAN channel link + its rotation (ADR-056 item C). Registered on this
  // transport too, per the everything-remote ruling — a headless box has no
  // desktop pane to read the link from. `lan-link` is a `query` and is STILL
  // session-gated (`AUTHCFG_CHANNELS`): the free-read rule that exempts
  // `authcfg:get` is about displaying settings, and this hands out a key.
  handleRemote({
    channel: 'authcfg:lan-link',
    capability: 'admin',
    kind: 'query',
    withConnection: true,
    handler: async (connection: CommandConnection) =>
      authcfgLanLink(connection, enrollTokens ?? null)
  })

  handleRemote({
    channel: 'authcfg:rotate-lan-key',
    capability: 'admin',
    kind: 'command',
    withConnection: true,
    handler: async (connection: CommandConnection) =>
      authcfgRotateLanKey(connection, enrollTokens ?? null)
  })

  // The REDACTED status read (owner ruling, 2026-08-28) — the ONLY `remote:*`
  // channel with a registration on this transport, and a `query` at that. Its
  // declaration and its field-picking redaction live in
  // `ipc/remote-view-commands.ts`, which both transports spread.
  //
  // The self-kill protection is STRUCTURAL: every remote-server mutation
  // (`remote:start` / `stop` / `set-config` / `set-password` /
  // `clear-password` / `force-reserve`) is raw `ipcMain.handle` on the host
  // anchor with no `CommandRegistration` anywhere, so a remote client has no
  // channel to call — it is not a hidden button and not a capability refusal.
  // Adding one here would break that; don't.
  for (const cmd of remoteViewCommands(enrollTokens ?? null)) {
    handleRemote(cmd)
  }

  // -------------------------------------------------------------------------
  // The config / worktree family + the automations (S1b — the everything-remote
  // ruling, 2026-08-17)
  // -------------------------------------------------------------------------
  //
  // Both families are spread from the SAME declarations the desktop registrar
  // uses (`ipc/config-commands.ts`, `ipc/automation-commands.ts`) — the
  // stream-watch / git-watch pattern, applied to everything this series ported.
  // `AUTOMATION_COMMANDS` is one frozen constant shared by both transports;
  // `configCommands(manager)` is a factory called once per registrar, so the
  // config family's handlers are distinct closures over the same code and the
  // same manager. Either way capability/kind cannot drift: the registry's
  // conflict-throw compares the declaration, never handler identity.
  // Every entry declares `config`, `git` or `chat`: all three are in
  // AUTH_OFF_GRANTS, so these are reachable by any authenticated connection, and
  // the mutations still meet the mutation window on the `strong` tier.
  //
  // Nothing host-PHYSICAL rides along: no dialog, no window, no console. Those
  // (`session:pick-folder`, `app:open-in-vscode`, `window:*`) declare `host` and
  // have no registration here at all.
  for (const cmd of configCommands(manager)) {
    handleRemote(cmd)
  }
  for (const cmd of AUTOMATION_COMMANDS) {
    handleRemote(cmd)
  }

  // The vendor-OAuth / account-mutation / native-OAuth family (S4, ADR-057).
  // Same shared declarations `session.ipc.ts` spreads — the remote UI can drive
  // vendor credentials, provider routing and (paste-back) OAuth. Token material
  // never crosses the wire; `auth:sign-in` / `account:add` skip the host browser
  // for a remote caller and surface `manualUrl` instead. Absent deps → the
  // channels register but each handler throws (see the param doc above), so the
  // remote surface is the SAME shape in tests as in production.
  const resolvedAuthDeps: AuthCommandDeps = authDeps ?? {
    requireEngineAuth: () => {
      throw new Error('auth surface unavailable: no auth dependencies wired for this transport')
    },
    setAccountEnabled: () => {
      throw new Error('auth surface unavailable: no auth dependencies wired for this transport')
    }
  }
  for (const cmd of authCommands(resolvedAuthDeps)) {
    handleRemote(cmd)
  }

  logger.info('remote-handlers', `Registered ${dispatcher.channels().length} remote handlers`)
}

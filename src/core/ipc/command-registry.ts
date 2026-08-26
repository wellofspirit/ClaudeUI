/**
 * Command registry — SyncCore phase 1 (ADR-051 §1, ADR-052 decision 4).
 *
 * ONE registry, two transports. Every channel either transport exposes is
 * registered here with a DECLARED capability and kind; both the desktop
 * `ipcMain.handle` wiring (session.ipc.ts) and the remote WebSocket dispatcher
 * (remote-dispatcher.ts) resolve their handler from this registry and dispatch
 * through {@link CommandRegistry.dispatch}, which is therefore the single choke
 * point for capability enforcement and audit.
 *
 * Fail-closed, by inversion of the as-built model. The old
 * `RemoteDispatcher.BLOCKED` denylist failed OPEN — forgetting to blocklist a
 * new channel exposed it. Here a channel is reachable over a transport iff it
 * was explicitly registered FOR that transport AND its declared capability is
 * in the calling connection's grant set. Omitting `capability` is a compile
 * error (required field); an invalid one is a runtime throw.
 *
 * Capability vocabulary and the grant sets are `docs/architecture/security.md`
 * §"Capability grants"; `kind` is the CQRS split from
 * `docs/architecture/sync-core.md` §"The four wire contracts" (commands mutate
 * and are audited; queries read and are not).
 *
 * Phase 1 is plumbing ONLY: the effective remote surface is unchanged. See
 * `PINNED_CAPABILITIES` for how the deleted denylist's guarantee is preserved.
 */

import { randomUUID } from 'crypto'
import { appendAuditLog } from '../services/db'
import { logger } from '../services/logger'
import type { StepUpTier } from '../../shared/types'

// ---------------------------------------------------------------------------
// Capabilities, kinds, transports
// ---------------------------------------------------------------------------

/**
 * The closed capability set (security.md §"Capability grants").
 *
 * `enroll` is the ADR-052 passkey addition: the authority to CREATE a
 * credential, and nothing else. It is separate from `admin` on purpose — a
 * one-time enrollment token hands out exactly this one capability, so a leaked
 * enrollment link can add a device but cannot read a conversation, list
 * credentials, or revoke the operator's own passkey. (The docs' vocabulary list
 * grows by this one entry; the amendment lands with series 2.)
 */
export const CAPABILITIES = [
  'chat',
  'session-config',
  'config',
  'git',
  'fs-read',
  'shell',
  'admin',
  'enroll',
  'host'
] as const

export type Capability = (typeof CAPABILITIES)[number]

/**
 * CQRS split (sync-core.md §"The four wire contracts"):
 *  - `command` — mutates engine/host/domain state. Audited.
 *  - `query`   — a read, or a subscription toggle with no domain effect
 *                (volatile streams are "subscription-scoped, never logged").
 *                Not audited.
 */
export type CommandKind = 'command' | 'query'

/** Which surface a handler serves. One channel may be registered for both. */
export type Transport = 'desktop' | 'remote'

const CAPABILITY_SET: ReadonlySet<string> = new Set<string>(CAPABILITIES)

// ---------------------------------------------------------------------------
// Connection identity + grants
// ---------------------------------------------------------------------------

/**
 * How a connection proved who it is.
 *
 * `host` is the HOST'S OWN in-process, fully-trusted surface — the one identity
 * that presented no credential because it never crossed a wire. Which surface it
 * was is the {@link ConnectionIdentity.label}: `desktop-renderer` in the Electron
 * app, `server-console` in `claudeui-server`. It was called `desktop` until
 * 2026-08-20, which misattributed every host-anchor row written on a headless box
 * — since ADR-058 `src/main` and `src/server` are sibling HOSTS, and there is no
 * desktop on one of them. Pre-release, so old local audit rows keep whatever they
 * say and there is no migration.
 *
 * `webauthn` is a completed passkey assertion (the only method that proves a
 * human rather than a cached secret), `enroll-token` a one-time link that may do
 * nothing but register a credential, and `none` the `off` policy mode, where
 * authentication is disabled outright and the audit trail must say so rather
 * than implying a credential was checked.
 *
 * `webauthn-resumed` (ADR-063) is a RESUMPTION of an earlier assertion — a token
 * that ceremony minted, replayed on a later handshake. It is a distinct member
 * rather than a relabelled `webauthn` precisely because the audit trail must be
 * able to tell "a human touched the sensor" from "a browser presented what that
 * touch left behind": same grants, same credential label, and no presence armed.
 *
 * `token` and `tailnet-identity` are GONE (ADR-056). The bearer token was a link
 * carrying authority; ambient tailnet identity was a network fact standing in
 * for a person. Neither can authenticate a connection any more, so neither can
 * appear on an audit row's `method` — what survives of the tailnet login is the
 * `label`, which a password connection on the serve origin still carries.
 *
 * Not to be confused with {@link Transport}, whose `'desktop'` member is a
 * different axis entirely: WHICH WIRE a channel is served on (`ipcMain.handle`
 * vs the WebSocket), not who is on the far end of it.
 */
export type IdentityMethod =
  'password' | 'webauthn' | 'webauthn-resumed' | 'enroll-token' | 'none' | 'host'

export interface ConnectionIdentity {
  method: IdentityMethod
  /**
   * Tailnet login when we have one; for `webauthn` — and for the
   * `webauthn-resumed` descended from one — the credential's nickname (falling
   * back to a short credential-id prefix, which is still a stable per-device
   * handle); otherwise the method name. Audit-facing.
   */
  label: string
  connectedAt: number
}

/** Everything dispatch needs to know about the caller. */
export interface CommandConnection {
  connectionId: string
  identity: ConnectionIdentity
  grants: ReadonlySet<Capability>
  /**
   * The WebAuthn RP binding for this connection's origin, or `null` on an
   * origin that cannot do WebAuthn (LAN IP, tunnel hostname, the desktop
   * renderer). Resolved ONCE from the request `Host` at connection time and
   * carried here because the enrollment verbs run through the registry — a
   * handler must never re-derive an origin from anything the caller sends.
   */
  webauthnOrigin?: { rpId: string; origin: string } | null
  /**
   * Phase 2 (ADR-052 decision 5): expiry of a DECAYING `shell` grant.
   *
   *  - `undefined` — this connection's grants never decay (the `host` identity:
   *    it *is* the host surface, so sudo semantics are meaningless);
   *  - `null`      — decaying-grant connection with no grant armed;
   *  - `number`    — epoch ms after which the grant is stale and the next
   *    shell-bearing command must be answered with `needs-step-up`.
   *
   * Enforced server-side (remote-server.ts) and refreshed by every shell ACT
   * (ADR-054 narrowed this from "every shell dispatch") and every `term-input`
   * frame. Client caching is irrelevant.
   */
  shellGrantExpiresAt?: number | null
  /**
   * ADR-054 decision 2 — a presence proof has happened on this connection: a
   * passkey login, the enroll→webauthn upgrade, or any successful step-up.
   *
   * NEVER decays, deliberately. It is what unlocks terminal READS for the
   * connection's lifetime under the read/act split, while the two windows above
   * and below govern ACTING. Weaker logins (token, ambient tailnet identity,
   * tunnel fragment, the password — whose proof is client-cacheable, so it
   * authenticates the browser rather than provably the human — and since ADR-063
   * `webauthn-resumed`, which is that same idea for a passkey) arm nothing and
   * meet the step-up as their FIRST presence proof.
   */
  armedEver?: boolean
  /**
   * ADR-054 — expiry of the NON-shell mutation window (the `strong` tier's
   * 60-minute default). Same three-state convention as
   * {@link CommandConnection.shellGrantExpiresAt}.
   *
   * It no longer governs the settings area: the ADR-054 §6 amendment
   * (2026-08-16) replaced that with an explicit
   * {@link CommandConnection.settingsSessionExpiresAt}.
   */
  mutationExpiresAt?: number | null
  /**
   * ADR-054 §6 amendment — expiry of an open SETTINGS-EDITING SESSION.
   *
   * Armed only by a step-up ceremony that carried `intent: 'settings'`, and
   * revoked by `authcfg:end`, by disconnect, or by its own 5-minute TTL (checked
   * lazily at dispatch — a bounded mode nobody is watching needs no timer).
   *
   * Deliberately a per-connection FLAG rather than a bearer token on the wire:
   * the connection is already authenticated and the ceremony just ran on it, so
   * a token would add leakable surface without adding proof.
   *
   * Same three-state convention as the two windows above — `undefined` on the
   * exempt `host` connection, which IS the host anchor and needs no session at
   * all.
   */
  settingsSessionExpiresAt?: number | null
  /**
   * ADR-054 — the step-up tier this connection was ADMITTED under, resolved once
   * at authentication like the policy and for the same reason: authority that
   * shifts mid-socket produces an audit trail nobody can reconstruct. Staleness
   * is bounded because a tier change is an auth-surface change, and those drop
   * every live client (4009). `undefined` reads as `medium`.
   */
  stepUpTier?: StepUpTier
}

// `shellGrantExpired` / `hasLiveShellGrant` lived here until ADR-054 and are
// deliberately GONE rather than kept around: "does this connection hold a live
// shell grant" is no longer a single question. Reads want the permanent arming
// proof, acts want the window, and a helper that answered only the second would
// be exactly the second source of truth the read/act split cannot afford — a
// caller reaching for the familiar name would silently re-gate reads on decay.
// `services/step-up-tier.ts` owns the predicates now (`shellReadAllowed`,
// `shellActAllowed`), and both the transport and the service backstop read them.

/** Every capability — the `host` identity's grant set. */
export const ALL_GRANTS: ReadonlySet<Capability> = new Set<Capability>(CAPABILITIES)

/**
 * The BASE remote surface — the set a connection admitted under the `off`
 * master switch holds, and the floor every ordinary remote connection stands on.
 *
 * It reproduces the as-built remote surface EXACTLY: every channel
 * `remote-handlers.ts` registers declares one of these five, and every channel
 * the old denylist blocked declares `shell`, `admin` or `host` (see
 * {@link PINNED_CAPABILITIES}).
 *
 * Deliberately NOT `admin`/`enroll` under `off`: enrolling a credential while
 * authentication is disabled would let any reachable client mint itself a
 * permanent one, and the settings session stays unreachable for the same reason.
 * `shell` costs the desktop opt-in plus a step-up; `admin`/`host` are
 * desktop/console surfaces.
 *
 * Named `AUTH_OFF_GRANTS` since ADR-056 — it was `LEGACY_REMOTE_GRANTS`, after a
 * policy mode that no longer exists. The MEMBERS are unchanged.
 */
export const AUTH_OFF_GRANTS: ReadonlySet<Capability> = new Set<Capability>([
  'chat',
  'session-config',
  'config',
  'git',
  'fs-read'
])

/**
 * Grant set for a connection that presented a real IDENTITY: a completed passkey
 * assertion (ADR-052 decision 1) or the break-glass password.
 *
 * The base set plus `admin` and `enroll`. `admin` is safe to grant over remote
 * because reachability is still `registered for the remote transport AND
 * capability ∈ grants`: the `admin` channels that must never be remote —
 * `remote:set-config` (which owns the policy column and the terminal toggle),
 * `remote:set-password`, `remote:force-reserve` — are raw desktop
 * `ipcMain.handle` wiring and have no remote registration at all. What `admin`
 * actually reaches over remote is the credential-management and settings verbs,
 * which is the point: administering your own server from your phone.
 *
 * ADR-056 made the PASSWORD carry this set under every non-`off` policy, where
 * it previously kept the base set under `legacy`. Withholding `enroll` from a
 * password login was already theatre once it held `admin`:
 * `webauthn:mint-enroll-token` is an `admin` verb, so an admin-holding password
 * client could always mint its own enrollment link. The "first device requires
 * the anchor" property survives via the POLICY DEFAULT rather than via grant
 * surgery — with zero credentials AND no password provisioned, nothing can
 * connect at all except an enrollment link.
 *
 * NOT `shell`: raw terminal still costs the desktop opt-in plus a step-up, and a
 * passkey at connect time is not the same evidence as a passkey ten minutes into
 * a session (ADR-052 decision 5 — decay applies in `passkey-always` too).
 * NOT `host`: there is no host shell to reach from a phone.
 */
export const FULL_REMOTE_GRANTS: ReadonlySet<Capability> = new Set<Capability>([
  ...AUTH_OFF_GRANTS,
  'admin',
  'enroll'
])

/**
 * A one-time enrollment link's grant set: `enroll` and NOTHING else.
 *
 * It does not widen on a successful registration either — the client re-runs the
 * assertion ceremony on the same socket and comes back as `webauthn`. That
 * ordering matters: it means the credential the device just created is what buys
 * it access, so a link intercepted between minting and use can add a passkey the
 * operator will see in the management list, but cannot read anything.
 */
export const ENROLL_ONLY_GRANTS: ReadonlySet<Capability> = new Set<Capability>(['enroll'])

/**
 * Which host surface a `host`-method identity is. A CLOSED union rather than a
 * free string: the two values are compared by eye in audit rows across three
 * files, and a typo would produce a row that reads plausibly and attributes
 * nothing.
 */
export type HostSurfaceLabel = 'desktop-renderer' | 'server-console'

/**
 * The host's own synthetic connection. One id per label per process run, so
 * audit rows from a single run group together; ALL grants (it IS the host
 * surface).
 *
 * Memoized PER LABEL rather than once, because a process could in principle
 * write under both — and two surfaces sharing one `connectionId` would make the
 * trail claim they were one actor. In practice the Electron app only ever uses
 * the default and `claudeui-server` only ever passes `server-console`.
 */
const hostConnections = new Map<HostSurfaceLabel, CommandConnection>()

export function hostConnection(label: HostSurfaceLabel = 'desktop-renderer'): CommandConnection {
  const existing = hostConnections.get(label)
  if (existing) return existing
  const connection: CommandConnection = {
    connectionId: randomUUID(),
    identity: { method: 'host', label, connectedAt: Date.now() },
    grants: ALL_GRANTS
  }
  hostConnections.set(label, connection)
  return connection
}

/**
 * Build a remote connection descriptor at authentication time.
 *
 * `opts.connectionId` lets the caller reuse an id it minted when the SOCKET
 * opened rather than when it authenticated. The remote server does exactly
 * that, so pre-auth audit rows (a failed assertion, a burned enrollment token)
 * and the post-auth command rows share one id and read as one story — without
 * it, every rejected handshake would be an orphan row.
 */
export function makeRemoteConnection(
  method: Exclude<IdentityMethod, 'host'>,
  login: string | null,
  grants: ReadonlySet<Capability> = AUTH_OFF_GRANTS,
  opts?: {
    connectionId?: string
    webauthnOrigin?: { rpId: string; origin: string } | null
    stepUpTier?: StepUpTier
  }
): CommandConnection {
  return {
    connectionId: opts?.connectionId ?? randomUUID(),
    identity: { method, label: login ?? method, connectedAt: Date.now() },
    grants,
    webauthnOrigin: opts?.webauthnOrigin ?? null,
    // Decaying-grant connection with nothing armed: the windows arrive from a
    // presence proof — the step-up ceremony (ADR-052 decision 5) or, since
    // ADR-054 decision 2, a passkey login that IS one — never from mere
    // authentication.
    shellGrantExpiresAt: null,
    mutationExpiresAt: null,
    // No settings session either: it is opened by a DELIBERATE unlock, never by
    // authentication and never by an ordinary step-up (ADR-054 §6 amendment).
    settingsSessionExpiresAt: null,
    armedEver: false,
    stepUpTier: opts?.stepUpTier ?? 'medium'
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CommandHandler = (...args: any[]) => unknown

export interface CommandRegistration {
  channel: string
  /** Required — omitting it is a compile error, an invalid value a runtime throw. */
  capability: Capability
  kind: CommandKind
  transport: Transport
  handler: CommandHandler
  /**
   * Index of the argument carrying the session routing id, or `null`/absent
   * when the command is not session-scoped. Declared (never guessed per call)
   * so the audit row's `session_id` is trustworthy.
   */
  sessionIdArg?: 0 | null
  /**
   * Phase 2: prepend the calling {@link CommandConnection} to the handler's
   * arguments (`handler(connection, ...args)`).
   *
   * FIRST, never last: `args` is attacker-controlled (a remote client picks the
   * array length), so a trailing position could be shifted by padding the call
   * with junk arguments and the handler would read an attacker value as the
   * identity. The leading position is fixed regardless of arity.
   *
   * Used by the terminal commands, which are per-connection by nature (attach
   * binds to the caller, availability answers about the caller, and the audit
   * row for a PTY's exit must name the identity that spawned it).
   */
  withConnection?: boolean
}

/** What {@link CommandRegistry.get} returns. */
export interface CommandEntry {
  channel: string
  capability: Capability
  kind: CommandKind
  handler: CommandHandler
  sessionIdArg: 0 | null
  withConnection: boolean
}

/** The channel-global declaration, shared by every transport's handler. */
interface Declaration {
  capability: Capability
  kind: CommandKind
  sessionIdArg: 0 | null
  withConnection: boolean
}

/**
 * Capabilities that MAY NOT be reclassified.
 *
 * This is what replaces `RemoteDispatcher.BLOCKED`. The denylist's real value
 * was absoluteness: listing a channel guaranteed it could never be exposed,
 * "even if a future edit tries to register it". Grants give that back only if
 * the classification itself is stable — so the channels whose misclassification
 * would silently widen the remote surface pin their capability here, and
 * `register()` refuses any registration that contradicts the pin.
 *
 * Every entry resolves to `host`, `shell`, `admin` or `enroll` — none of which
 * are in {@link AUTH_OFF_GRANTS} — so registering any of them for the remote
 * transport cannot make it reachable to an auth-off connection. Channels not yet
 * ported to the registry (`window:*`, `app:*` and `remote:*` in main/index.ts,
 * `terminal:*` in terminal.ipc.ts) are pinned here in advance, so they arrive
 * correctly classified whenever those files are ported.
 *
 * **What ADR-052 changed about this table's guarantee, stated honestly.**
 * Before passkeys, `admin` was ungrantable over remote FULL STOP, so a pin to
 * `admin` was equivalent to "unreachable remotely". A passkey-authenticated
 * connection now holds `admin` ({@link FULL_REMOTE_GRANTS}), so the pin's
 * remaining guarantee is the narrower — and still load-bearing — one: a pinned
 * channel can never be RECLASSIFIED into a capability the base grant set holds.
 * The channels that must stay desktop-only are kept so by the OTHER half of the
 * reachability rule (they have no remote registration at all: `remote:*`,
 * `auth:*`, `account:*` and `window:*` are raw `ipcMain.handle` wiring in
 * boot-core.ts / index.ts). `remote-handlers.ipc.test.ts` pins that absence.
 *
 * **What ADR-056 changed.** `admin` shrank to EXACTLY the session-security area
 * — the `authcfg:*` and `webauthn:*` families, plus their host-anchor twin
 * `remote:*`. The engine-vendor channels that used to sit here (`auth:*`,
 * `account:*`, `usage:refresh-prices`, and the unpinned `shared-provider:*` /
 * `vendor-auth:*`) declare `config` now and are therefore GONE from this table
 * rather than re-pinned: `config` is in the base grant set, and a pin whose
 * capability is grantable would break this table's one guarantee. What keeps
 * them desktop-only is their registration, which is where it always actually
 * was. `log-viewer:*` and `automation:*` keep their forward pins — they are not
 * registered anywhere yet, and whether the S1b port exposes them (and under
 * which capability) is that series' decision, so freezing them at the
 * fail-closed value is the conservative placeholder, not a claim that they are
 * session security.
 */
export const PINNED_CAPABILITIES: Readonly<Record<string, Capability>> = {
  // Host shell surfaces (window controls, native pickers, editor launch, quit).
  'window:minimize': 'host',
  'window:maximize': 'host',
  'window:close': 'host',
  'session:pick-folder': 'host',
  'app:quit-confirm': 'host',
  'app:quit-cancel': 'host',
  'app:open-in-vscode': 'host',
  // Raw shell — reachable over remote as of phase 2, but ONLY behind the
  // desktop opt-in toggle + a stepped-up, decaying `shell` grant (ADR-052
  // decision 6). The pin still does its job: `shell` is not in
  // AUTH_OFF_GRANTS, so authenticating never suffices on its own.
  'terminal:create': 'shell',
  'terminal:write': 'shell',
  'terminal:resize': 'shell',
  'terminal:kill': 'shell',
  'terminal:kill-by-cwd': 'shell',
  'terminal:attach': 'shell',
  'terminal:detach': 'shell',
  // `auth:*` (native OAuth), `account:*` and `usage:refresh-prices` were pinned
  // to `admin` here until ADR-056 shrank `admin` to the session-security area.
  // They declare `config` now, which is grantable, so a pin would be a
  // contradiction rather than a guarantee — see the doc comment. They are still
  // desktop-only, by the registration half of the reachability rule.
  //
  // Host diagnostics surface: a SEPARATE BrowserWindow with its own preload,
  // reading the process log ring. Pinned to `admin`, and — unlike the
  // `automation:*` block that used to sit below — NOT as a placeholder for a
  // future port. S1b ruled it: `log-viewer:*` is desktop WINDOW CHROME (open,
  // minimize, maximize, close, theme of a BrowserWindow), so it is host-physical
  // in the same sense `window:*` is and NEVER registers on the remote transport.
  // A headless box has no log window to drive; it has the log FILE. The invoke
  // side stays raw `ipcMain.handle` in services/log-viewer.ts, and the pin stays
  // as the belt: `admin` is not in AUTH_OFF_GRANTS, so a stray registration
  // could not expose it to an auth-off connection either. (SyncCore phase 4a
  // item 3 closed the EVENT side — `log-viewer:*` events are classified
  // `host-local` in shared/sync/channels.ts.)
  'log-viewer:open': 'admin',
  'log-viewer:ready': 'admin',
  'log-viewer:get-theme': 'admin',
  'log-viewer:set-theme': 'admin',
  'log-viewer:minimize': 'admin',
  'log-viewer:maximize': 'admin',
  'log-viewer:close': 'admin',
  // `automation:*` was pinned here at `admin` — the seven mutations only — as a
  // deliberately fail-closed PLACEHOLDER while the port was unwritten. S1b wrote
  // it and ruled `config`: an automation is host-side configuration (a stored
  // prompt plus a cron expression under ~/.claude/ui/automation/), and `admin`
  // means exactly the session-security area since ADR-056. The entries are GONE
  // rather than re-pinned at `config`, for the same reason `auth:*` and
  // `account:*` are: `config` is in the base grant set, and a pin whose
  // capability is grantable would break this table's one guarantee. What governs
  // them now is the registry — declared capability plus per-transport
  // registration — and the audit rows the port bought them. See
  // ipc/automation-commands.ts for the capability ruling in full.
  //
  // The remote server's own config + credential. A remote client must never
  // read/rotate the credential it authenticated with, nor flip the transport
  // it is connected through (ADR-039/042).
  'remote:get-config': 'admin',
  'remote:set-config': 'admin',
  'remote:set-password': 'admin',
  'remote:clear-password': 'admin',
  'remote:tailscale-detect': 'admin',
  'remote:force-reserve': 'admin',
  // Passkeys (ADR-052). Registered for real — unlike most of this table — and
  // pinned because a misclassification here is precisely the silent widening the
  // pin exists to stop: `webauthn:revoke` reclassified as `config` would let any
  // authenticated connection delete the operator's passkeys, and
  // `webauthn:register-verify` as `config` would let one enroll its own.
  'webauthn:register-options': 'enroll',
  'webauthn:register-verify': 'enroll',
  'webauthn:credentials': 'admin',
  'webauthn:rename': 'admin',
  'webauthn:revoke': 'admin',
  'webauthn:mint-enroll-token': 'admin',
  // The settings-editing surface (ADR-054 §6), pinned by ADR-056 alongside its
  // `webauthn:*` sibling now that `admin` means exactly these two families. The
  // hole this closes is the same one: `authcfg:apply` reclassified as `config`
  // would let any authenticated connection rewrite the auth surface, and
  // `authcfg:lan-link` as `config` would hand out the LAN channel key. Both are
  // registered for BOTH transports, so a misclassification would be reachable.
  'authcfg:get': 'admin',
  'authcfg:apply': 'admin',
  'authcfg:end': 'admin',
  'authcfg:set-password': 'admin',
  'authcfg:lan-link': 'admin',
  'authcfg:rotate-lan-key': 'admin'
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class CommandRegistry {
  /** channel → declaration (capability/kind/sessionIdArg), shared by transports. */
  private declarations = new Map<string, Declaration>()
  /** `${transport} ${channel}` → handler. */
  private handlers = new Map<string, CommandHandler>()

  private static key(transport: Transport, channel: string): string {
    return `${transport} ${channel}`
  }

  /**
   * Register one channel for one transport.
   *
   * Re-registering the same (channel, transport) replaces the handler — the
   * desktop path re-runs `registerSessionIpc` on macOS dock re-open, and tests
   * re-run the registrars per case. Registering the SAME channel for the other
   * transport must agree on the declaration; disagreement is a throw, so the
   * two surfaces can never drift into different capabilities for one channel.
   */
  register(reg: CommandRegistration): void {
    const { channel, capability, kind, transport, handler } = reg
    if (!channel) throw new Error('registerCommand: channel is required')
    if (!CAPABILITY_SET.has(capability)) {
      throw new Error(
        `registerCommand("${channel}"): a declared capability is required (got ${JSON.stringify(
          capability
        )}); one of ${CAPABILITIES.join(', ')}`
      )
    }
    if (kind !== 'command' && kind !== 'query') {
      throw new Error(
        `registerCommand("${channel}"): kind must be 'command' or 'query' (got ${JSON.stringify(kind)})`
      )
    }
    if (typeof handler !== 'function') {
      throw new Error(`registerCommand("${channel}"): handler must be a function`)
    }
    const pinned = PINNED_CAPABILITIES[channel]
    if (pinned && pinned !== capability) {
      throw new Error(
        `registerCommand("${channel}"): capability is pinned to "${pinned}" and cannot be ` +
          `registered as "${capability}" (see PINNED_CAPABILITIES — this is what replaces the ` +
          `remote denylist)`
      )
    }
    const sessionIdArg = reg.sessionIdArg ?? null
    const withConnection = reg.withConnection === true

    const existing = this.declarations.get(channel)
    if (existing) {
      if (
        existing.capability !== capability ||
        existing.kind !== kind ||
        existing.sessionIdArg !== sessionIdArg ||
        existing.withConnection !== withConnection
      ) {
        throw new Error(
          `registerCommand("${channel}"): declaration conflicts with the existing one ` +
            `(${existing.capability}/${existing.kind}/sessionIdArg=${existing.sessionIdArg}/` +
            `withConnection=${existing.withConnection} vs ` +
            `${capability}/${kind}/sessionIdArg=${sessionIdArg}/withConnection=${withConnection})`
        )
      }
    } else {
      this.declarations.set(channel, { capability, kind, sessionIdArg, withConnection })
    }

    this.handlers.set(CommandRegistry.key(transport, channel), handler)
  }

  /** Resolve a channel for a transport, or undefined when it is not exposed there. */
  get(channel: string, transport: Transport): CommandEntry | undefined {
    const declaration = this.declarations.get(channel)
    const handler = this.handlers.get(CommandRegistry.key(transport, channel))
    if (!declaration || !handler) return undefined
    return { channel, ...declaration, handler }
  }

  /** Declared capability/kind for a channel regardless of transport. */
  declaration(channel: string): Readonly<Declaration> | undefined {
    return this.declarations.get(channel)
  }

  /** Channels exposed on `transport` (all declared channels when omitted), sorted. */
  channels(transport?: Transport): string[] {
    if (!transport) return [...this.declarations.keys()].sort()
    const prefix = CommandRegistry.key(transport, '')
    return [...this.handlers.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length))
      .sort()
  }

  /** Drop one transport's handler (the declaration stays — it is channel-global). */
  unregister(channel: string, transport: Transport): void {
    this.handlers.delete(CommandRegistry.key(transport, channel))
  }

  /** Test seam: wipe everything. Never called in production. */
  reset(): void {
    this.declarations.clear()
    this.handlers.clear()
  }

  /**
   * Resolve → capability-check → dispatch → audit.
   *
   * Unregistered channels keep the historical wording (`Channel not available:
   * <channel>`) so the web client's error handling is untouched. A registered
   * channel whose capability is not granted reports a permission error instead
   * — the two are deliberately distinguishable in the log but both are refusals.
   */
  async dispatch(
    channel: string,
    transport: Transport,
    args: unknown[],
    connection: CommandConnection
  ): Promise<unknown> {
    const entry = this.get(channel, transport)
    if (!entry) throw new Error(`Channel not available: ${channel}`)

    if (!connection.grants.has(entry.capability)) {
      throw new Error(
        `Permission denied: "${channel}" requires the "${entry.capability}" capability`
      )
    }

    // The connection rides in FRONT of the wire args — see
    // `CommandRegistration.withConnection` for why the position matters.
    const callArgs = entry.withConnection ? [connection, ...args] : args

    // Queries are not audited (sync-core.md: reads have no state effect, and a
    // per-read row would bury the commands that matter).
    if (entry.kind === 'query') return await entry.handler(...callArgs)

    // Indexed against the WIRE args, never `callArgs` — `sessionIdArg: 0` means
    // "the first argument the caller sent", independent of `withConnection`.
    const sessionId =
      entry.sessionIdArg !== null && typeof args[entry.sessionIdArg] === 'string'
        ? (args[entry.sessionIdArg] as string)
        : null

    try {
      const result = await entry.handler(...callArgs)
      this.audit(entry, connection, sessionId, outcomeOf(result))
      return result
    } catch (err) {
      this.audit(entry, connection, sessionId, 'error')
      throw err
    }
  }

  private audit(
    entry: CommandEntry,
    connection: CommandConnection,
    sessionId: string | null,
    outcome: 'ok' | 'error'
  ): void {
    try {
      appendAuditLog({
        ts: Date.now(),
        connectionId: connection.connectionId,
        method: connection.identity.method,
        label: connection.identity.label,
        capability: entry.capability,
        kind: entry.kind,
        channel: entry.channel,
        sessionId,
        outcome
      })
    } catch (err) {
      // The audit log is observability, not enforcement: refusing the operator's
      // command because the DB is wedged would be a worse failure than a gap in
      // the trail. Loud, but non-fatal.
      logger.error('command-registry', `audit append failed for ${entry.channel}: ${err}`)
    }
  }
}

/**
 * Many handlers are wrapped in session.ipc.ts's `safeHandler`, which CATCHES and
 * returns `{ok:false, error}` instead of throwing — so a failed `git:push` would
 * otherwise be audited as a success. Read the envelope when there is one.
 */
function outcomeOf(result: unknown): 'ok' | 'error' {
  if (result && typeof result === 'object' && 'ok' in result) {
    return (result as { ok: unknown }).ok === false ? 'error' : 'ok'
  }
  return 'ok'
}

/** The one registry both transports share. */
export const commandRegistry = new CommandRegistry()

/** Convenience wrapper mirroring the registry's `register`. */
export function registerCommand(reg: CommandRegistration): void {
  commandRegistry.register(reg)
}

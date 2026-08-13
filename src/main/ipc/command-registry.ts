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

// ---------------------------------------------------------------------------
// Capabilities, kinds, transports
// ---------------------------------------------------------------------------

/** The closed capability set (security.md §"Capability grants"). */
export const CAPABILITIES = [
  'chat',
  'session-config',
  'config',
  'git',
  'fs-read',
  'shell',
  'admin',
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

/** How a connection proved who it is. `desktop` is the in-process renderer. */
export type IdentityMethod = 'token' | 'password' | 'tailnet-identity' | 'desktop'

export interface ConnectionIdentity {
  method: IdentityMethod
  /** Tailnet login when we have one, else the method name. Audit-facing. */
  label: string
  connectedAt: number
}

/** Everything dispatch needs to know about the caller. */
export interface CommandConnection {
  connectionId: string
  identity: ConnectionIdentity
  grants: ReadonlySet<Capability>
  /**
   * Phase 2 (ADR-052 decision 5): expiry of a DECAYING `shell` grant.
   *
   *  - `undefined` — this connection's grants never decay (the desktop
   *    renderer: it *is* the host surface, so sudo semantics are meaningless);
   *  - `null`      — decaying-grant connection with no grant armed;
   *  - `number`    — epoch ms after which the grant is stale and the next
   *    shell-bearing command must be answered with `needs-step-up`.
   *
   * Enforced server-side (remote-server.ts) and refreshed by every shell
   * dispatch and every `term-input` frame. Client caching is irrelevant.
   */
  shellGrantExpiresAt?: number | null
}

/**
 * Is `conn`'s `shell` grant stale? Only meaningful for decaying connections —
 * a connection whose `shellGrantExpiresAt` is `undefined` never decays.
 */
export function shellGrantExpired(conn: CommandConnection, now = Date.now()): boolean {
  const expiresAt = conn.shellGrantExpiresAt
  if (expiresAt === undefined) return false
  return expiresAt === null || expiresAt <= now
}

/** Does `conn` hold a `shell` grant that is both present and unexpired? */
export function hasLiveShellGrant(conn: CommandConnection, now = Date.now()): boolean {
  return conn.grants.has('shell') && !shellGrantExpired(conn, now)
}

/** Every capability — the desktop renderer's grant set. */
export const ALL_GRANTS: ReadonlySet<Capability> = new Set<Capability>(CAPABILITIES)

/**
 * Grant set for remote connections under the `legacy` auth policy — i.e. the
 * ONLY set phase 1 issues. It is chosen to reproduce the as-built remote
 * surface EXACTLY: every channel `remote-handlers.ts` registers today declares
 * one of these five, and every channel the old denylist blocked declares
 * `shell`, `admin` or `host` (see {@link PINNED_CAPABILITIES}).
 *
 * `shell` arrives in phase 2 behind opt-in + step-up (ADR-052 decision 6);
 * `admin`/`host` are desktop/console surfaces.
 */
export const LEGACY_REMOTE_GRANTS: ReadonlySet<Capability> = new Set<Capability>([
  'chat',
  'session-config',
  'config',
  'git',
  'fs-read'
])

/**
 * The desktop renderer's synthetic connection. One id per app run so audit rows
 * from a single session group together; ALL grants (it is the host surface).
 */
let desktopConnectionSingleton: CommandConnection | null = null

export function desktopConnection(): CommandConnection {
  if (!desktopConnectionSingleton) {
    desktopConnectionSingleton = {
      connectionId: randomUUID(),
      identity: { method: 'desktop', label: 'desktop-renderer', connectedAt: Date.now() },
      grants: ALL_GRANTS
    }
  }
  return desktopConnectionSingleton
}

/** Build a remote connection descriptor at authentication time. */
export function makeRemoteConnection(
  method: Exclude<IdentityMethod, 'desktop'>,
  login: string | null,
  grants: ReadonlySet<Capability> = LEGACY_REMOTE_GRANTS
): CommandConnection {
  return {
    connectionId: randomUUID(),
    identity: { method, label: login ?? method, connectedAt: Date.now() },
    grants,
    // Decaying-grant connection with nothing armed: `shell` arrives only via
    // the step-up ceremony (ADR-052 decision 5), never at authentication.
    shellGrantExpiresAt: null
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
 * Every entry resolves to `host`, `shell` or `admin` — none of which are in
 * {@link LEGACY_REMOTE_GRANTS} — so registering any of them for the remote
 * transport still cannot make it reachable. Channels not yet ported to the
 * registry (`window:*`, `app:*` and `remote:*` in main/index.ts, `terminal:*`
 * in terminal.ipc.ts) are pinned here in advance, so they arrive correctly
 * classified whenever those files are ported.
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
  // LEGACY_REMOTE_GRANTS, so authenticating never suffices on its own.
  'terminal:create': 'shell',
  'terminal:write': 'shell',
  'terminal:resize': 'shell',
  'terminal:kill': 'shell',
  'terminal:kill-by-cwd': 'shell',
  'terminal:attach': 'shell',
  'terminal:detach': 'shell',
  // Native OAuth: local browser + loopback listener (ADR-014).
  'auth:sign-in': 'admin',
  'auth:submit-code': 'admin',
  'auth:cancel': 'admin',
  // Account mutations open local browsers / touch local credential files (ADR-015).
  'account:set-enabled': 'admin',
  'account:add': 'admin',
  'account:switch': 'admin',
  'account:delete': 'admin',
  // Spawns a local opencode server.
  'usage:refresh-prices': 'admin',
  // The remote server's own config + credential. A remote client must never
  // read/rotate the credential it authenticated with, nor flip the transport
  // it is connected through (ADR-039/042).
  'remote:get-config': 'admin',
  'remote:set-config': 'admin',
  'remote:set-password': 'admin',
  'remote:clear-password': 'admin',
  'remote:tailscale-detect': 'admin',
  'remote:force-reserve': 'admin'
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

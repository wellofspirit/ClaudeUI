import type { WsInvokeRequest } from '../../shared/remote-protocol'
import { logger } from './logger'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (...args: any[]) => Promise<unknown>

/**
 * Routes WebSocket invoke messages to handler functions.
 * Handlers are extracted from the IPC layer and registered here for dual use.
 *
 * Gating model: this is a DENYLIST over an explicit registration set, NOT an
 * allowlist. A channel is reachable over remote iff (a) `registerRemoteHandlers`
 * explicitly registered it AND (b) it is not in {@link BLOCKED}. `register()`
 * silently drops any channel in the denylist, so listing a channel in BLOCKED
 * guarantees it can never be exposed even if a future edit tries to register it.
 * The web client gets full parity with the desktop surface EXCEPT the denied
 * channels (window/terminal/native-OAuth/account-mutation/pick-folder/…).
 */
export class RemoteDispatcher {
  private handlers = new Map<string, Handler>()

  /** Channels explicitly blocked from remote access (the denylist). */
  private static readonly BLOCKED = new Set([
    'window:minimize',
    'window:maximize',
    'window:close',
    'session:pick-folder',
    'app:quit-confirm',
    'app:open-in-vscode',
    'terminal:create',
    'terminal:write',
    'terminal:resize',
    'terminal:kill',
    'terminal:kill-by-cwd',
    // Native OAuth opens a local browser + loopback listener on the desktop
    // host — meaningless (and a credential vector) over remote. See ADR-014.
    'auth:sign-in',
    'auth:submit-code',
    'auth:cancel',
    // Account mutations open local browsers / touch the local filesystem (ADR-015).
    'account:set-enabled',
    'account:add',
    'account:switch',
    'account:delete',
    // Spawns a local opencode server — meaningless and unsafe over remote (Phase 9b).
    'usage:refresh-prices',
    // Remote-server config + credential (Phase 1 of remote auth). A remote
    // client must never read/rotate its own auth credential or flip
    // transport/autostart flags for the server it's connected through —
    // mirrors the auth/account entries above. remote:get-config also never
    // returns password_salt/password_hash/kdf_params even to the desktop IPC
    // caller, but blocking it here means a compromised/rogue remote client
    // can't even learn `passwordSet`/`passwordUpdatedAt`.
    'remote:get-config',
    'remote:set-config',
    'remote:set-password',
    'remote:clear-password',
    // Tailscale probe (Phase 3): discloses this node's tailnet DNS name and the
    // owner's login — local-configuration detail a remote client has no business
    // reading, and useless to it anyway (it cannot flip tls_mode either).
    'remote:tailscale-detect',
    // Force re-serve (ADR-042) MUTATES this machine's `tailscale serve` config,
    // taking over the pinned HTTPS port from whatever holds it — i.e. it can
    // change (or break) the very transport the caller is connected through.
    // Desktop-only, like the rest of the remote:* config surface.
    'remote:force-reserve'
  ])

  /** Register a handler for a channel. Blocked channels are silently skipped. */
  register(channel: string, handler: Handler): void {
    if (RemoteDispatcher.BLOCKED.has(channel)) return
    this.handlers.set(channel, handler)
  }

  /** Check if a channel has a registered handler. */
  has(channel: string): boolean {
    return this.handlers.has(channel)
  }

  /** Dispatch an invoke request and return the result. */
  async handle(msg: WsInvokeRequest): Promise<unknown> {
    const handler = this.handlers.get(msg.channel)
    if (!handler) {
      throw new Error(`Channel not available: ${msg.channel}`)
    }
    try {
      return await handler(...msg.args)
    } catch (err) {
      logger.error('remote-dispatcher', `Error handling ${msg.channel}: ${err}`)
      throw err
    }
  }

  /** Unregister a handler for a channel. */
  unregister(channel: string): void {
    this.handlers.delete(channel)
  }

  /** List all registered channels (for debugging). */
  channels(): string[] {
    return Array.from(this.handlers.keys())
  }
}

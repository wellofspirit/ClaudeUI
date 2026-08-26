import type { WsInvokeRequest } from '../../shared/remote-protocol'
import {
  commandRegistry,
  type Capability,
  type CommandConnection,
  type CommandKind,
  type CommandRegistry
} from '../ipc/command-registry'
import { logger } from './logger'

/**
 * Routes WebSocket invoke messages to the command registry.
 *
 * Gating model (SyncCore phase 1 — ADR-051/052): an ALLOWLIST expressed as
 * capability grants. A channel is reachable over remote iff (a)
 * `registerRemoteHandlers` registered it for the `remote` transport AND (b) its
 * DECLARED capability is in the connection's grant set. The old `BLOCKED`
 * denylist is gone: it failed open (forgetting to blocklist a new channel
 * exposed it), and its effect is now a property of the capability model —
 * every channel it listed declares `host`, `shell` or `admin`, none of which
 * remote connections are granted (see `PINNED_CAPABILITIES`).
 *
 * This class is now a thin transport adapter; registration, capability
 * enforcement and audit all live in the registry, shared with the desktop IPC
 * transport.
 */
export class RemoteDispatcher {
  private registry: CommandRegistry

  constructor(registry: CommandRegistry = commandRegistry) {
    this.registry = registry
  }

  /** Check if a channel is exposed on the remote transport. */
  has(channel: string): boolean {
    return this.registry.get(channel, 'remote') !== undefined
  }

  /**
   * Declared capability for a channel, or undefined when it is not registered
   * at all. The transport needs this to run the phase-2 `shell` decay check
   * BEFORE dispatch — expired grants must answer `needs-step-up`, which is a
   * different (and actionable) refusal from the registry's permission error.
   */
  capabilityOf(channel: string): Capability | undefined {
    return this.registry.declaration(channel)?.capability
  }

  /**
   * Declared kind for a channel, or undefined when it is not registered.
   *
   * Load-bearing for the `shell` decay, not just for the audit: the idle window
   * is a presence proof, so it may only be refreshed by ACTING. A `query` is a
   * read (`terminal:pool`, re-asked by the panel on every window focus) and
   * must therefore be checked against the deadline WITHOUT sliding it —
   * otherwise an open browser tab renews its own grant indefinitely with no
   * shell use at all. Read through the same registry accessor as
   * {@link capabilityOf} so the two can never disagree about a channel.
   */
  kindOf(channel: string): CommandKind | undefined {
    return this.registry.declaration(channel)?.kind
  }

  /**
   * Dispatch an invoke request on behalf of an authenticated connection and
   * return the result. Throws `Channel not available: <channel>` for anything
   * this transport does not expose (unchanged wording — the web client's error
   * paths depend on it) and a permission error when the channel's capability
   * is not granted.
   */
  async handle(msg: WsInvokeRequest, connection: CommandConnection): Promise<unknown> {
    try {
      return await this.registry.dispatch(msg.channel, 'remote', msg.args ?? [], connection)
    } catch (err) {
      logger.error('remote-dispatcher', `Error handling ${msg.channel}: ${err}`)
      throw err
    }
  }

  /** Unregister the remote handler for a channel. */
  unregister(channel: string): void {
    this.registry.unregister(channel, 'remote')
  }

  /** List all channels exposed on the remote transport (for debugging). */
  channels(): string[] {
    return this.registry.channels('remote')
  }
}

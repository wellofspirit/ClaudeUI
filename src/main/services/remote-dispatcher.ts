import type { WsInvokeRequest } from '../../shared/remote-protocol'
import { logger } from './logger'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (...args: any[]) => Promise<unknown>

/**
 * Routes WebSocket invoke messages to handler functions.
 * Handlers are extracted from the IPC layer and registered here for dual use.
 * Only channels in the allowlist are exposed to remote clients.
 */
export class RemoteDispatcher {
  private handlers = new Map<string, Handler>()

  /** Channels explicitly blocked from remote access. */
  private static readonly BLOCKED = new Set([
    'window:minimize',
    'window:maximize',
    'window:close',
    'session:pick-folder',
    'session:open-teams-view',
    'app:quit-confirm',
    'app:open-in-vscode',
    'terminal:create',
    'terminal:write',
    'terminal:resize',
    'terminal:kill',
    'terminal:kill-by-cwd'
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

  /** List all registered channels (for debugging). */
  channels(): string[] {
    return Array.from(this.handlers.keys())
  }
}

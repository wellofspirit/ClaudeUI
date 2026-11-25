/**
 * Relaunch: restart this host and come back on the same build, from any
 * client. Declared once and served by both transports (the desktop half is
 * `registerAppRelaunchIpc`, called from core-services once the remote server
 * exists; the remote half is spread in `registerRemoteHandlers`).
 *
 * ## Capabilities
 *
 * - `app:relaunch` is `admin`, a `command`: it ends every session's turn, every
 *   terminal and every remote connection on the host. Pinned in
 *   `PINNED_CAPABILITIES`. A host that cannot relaunch itself (a headless
 *   server without its monitor, a dev build, an ineligible install) refuses
 *   with a reason.
 * - `app:relaunch-availability`, `app:restart-impact` and `app:last-relaunch`
 *   are `config` queries: a client must be able to ask whether to offer the
 *   action, and what it would interrupt, without holding the grant. Unpinned,
 *   as `ide:availability` is (a pin to a grantable capability is no pin).
 *
 * The host side is the `HostRelaunch` seam (`src/core/host.ts`), set by the
 * desktop's `boot-core.ts` and by the server's `main.ts` (`src/server/worker-host.ts`).
 */

import { hostRelaunch, type HostRelaunch } from '../host'
import { syncCore } from '../services/sync-host'
import { terminalService } from '../services/terminal-service'
import { handleIpc, unbindDesktopChannels } from './desktop-transport-binding'
import type { CommandRegistration } from './command-registry'
import type { RemoteStatusHost } from './remote-view-commands'
import type {
  RelaunchAccepted,
  RelaunchAvailability,
  RelaunchResult,
  RestartImpact
} from '../../shared/relaunch'

/** The channels declared here, cleared before re-registering (idempotent boot). */
export const APP_RELAUNCH_CHANNELS = [
  'app:relaunch',
  'app:relaunch-availability',
  'app:restart-impact',
  'app:last-relaunch'
] as const

export const RELAUNCH_UNAVAILABLE = 'This host cannot relaunch itself'

export interface AppRelaunchDeps {
  /** The host's relaunch, read per call (null: this host cannot relaunch). */
  relaunch: () => HostRelaunch | null
  /** What a restart would interrupt. */
  impact: () => RestartImpact
}

/** Sessions with a running turn, live ptys, connected remote clients. */
export function restartImpactOf(remote: RemoteStatusHost | null): RestartImpact {
  let workingSessions = 0
  for (const session of Object.values(syncCore.getCanonicalState().sessions))
    if (session.status.state === 'running') workingSessions++
  let remoteClients: number
  try {
    remoteClients = remote?.getStatus().connectedClients ?? 0
  } catch {
    remoteClients = 0
  }
  return { workingSessions, terminals: terminalService.liveTerminals().length, remoteClients }
}

export function defaultAppRelaunchDeps(remote: RemoteStatusHost | null): AppRelaunchDeps {
  return { relaunch: hostRelaunch, impact: () => restartImpactOf(remote) }
}

export function appRelaunchCommands(
  deps: AppRelaunchDeps
): Array<Omit<CommandRegistration, 'transport'>> {
  return [
    {
      channel: 'app:relaunch',
      capability: 'admin',
      kind: 'command',
      handler: async (): Promise<RelaunchAccepted> => {
        const host = deps.relaunch()
        if (!host) throw new Error(RELAUNCH_UNAVAILABLE)
        const availability = host.availability()
        if (!availability.available) throw new Error(availability.reason ?? RELAUNCH_UNAVAILABLE)
        await host.relaunch()
        return { accepted: true }
      }
    },
    {
      channel: 'app:relaunch-availability',
      capability: 'config',
      kind: 'query',
      handler: async (): Promise<RelaunchAvailability> => {
        const host = deps.relaunch()
        if (!host) return { available: false, reason: RELAUNCH_UNAVAILABLE }
        return host.availability()
      }
    },
    {
      channel: 'app:restart-impact',
      capability: 'config',
      kind: 'query',
      handler: async (): Promise<RestartImpact> => deps.impact()
    },
    {
      channel: 'app:last-relaunch',
      capability: 'config',
      kind: 'query',
      handler: async (): Promise<RelaunchResult | null> => deps.relaunch()?.lastResult() ?? null
    }
  ]
}

/** The desktop half (mirrors `registerRemoteViewIpc`). */
export function registerAppRelaunchIpc(remote: RemoteStatusHost | null): void {
  unbindDesktopChannels(APP_RELAUNCH_CHANNELS)
  for (const cmd of appRelaunchCommands(defaultAppRelaunchDeps(remote))) handleIpc(cmd)
}

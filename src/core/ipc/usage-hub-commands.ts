/**
 * The six `usage-hub:*` channels (ADR-072 §7), declared ONCE and served by both
 * transports.
 *
 * ## Why one declaration and not two
 *
 * The `authCommands` / `ideCommands` shape rather than the duplicated blocks the
 * `usage:*` channels use: there are six of them, one carries a CREDENTIAL, and a
 * capability or a sanitiser that drifted between the desktop and the remote copy
 * would be a difference nobody would see until someone connected from a phone.
 *
 * ## `set-secret` is write-only, and that is structural
 *
 * No query here returns the device secret. `usage-hub:status` answers
 * `hasSecret: boolean` and `usage-hub:set-secret` returns the same status, so
 * there is no shape on the wire that could carry the token back out — which
 * matters because `config` is in the base grant set and these channels are
 * reachable from a remote client. That is also why the secret is in the database
 * rather than in settings (`config:save-settings` is remotely writable).
 *
 * Every argument is sanitised at the perimeter, in `usage-hub/config.ts`.
 */

import type { CommandRegistration } from './command-registry'
import {
  configureHub,
  forgetHub,
  sanitizeHubConfigureInput,
  sanitizeHubSecret,
  setHubSecret
} from '../services/usage-hub/config'
import { usageHubClient } from '../services/usage-hub/client'
import type { UsageHubStatus } from '../../shared/types'

/**
 * The channels declared here. `registerSessionIpc` unbinds them beside its own
 * before re-registering, the way it does for the Codex family — one unbind list,
 * so a second boot in a test cannot leave a stale desktop handler behind.
 */
export const USAGE_HUB_CHANNELS = [
  'usage-hub:status',
  'usage-hub:configure',
  'usage-hub:set-secret',
  'usage-hub:sync-now',
  'usage-hub:resync',
  'usage-hub:forget'
] as const

/**
 * The declarations. Capability `config` throughout, which is the metering
 * surface's capability (`usage:limits`, `usage:windows`, `usage:dashboard`):
 * these are settings and figures, not the session-security surface.
 */
export function usageHubCommands(): Array<Omit<CommandRegistration, 'transport'>> {
  return [
    {
      channel: 'usage-hub:status',
      capability: 'config',
      kind: 'query',
      handler: async (): Promise<UsageHubStatus> => usageHubClient.status()
    },
    {
      channel: 'usage-hub:configure',
      capability: 'config',
      kind: 'command',
      handler: async (input?: unknown): Promise<UsageHubStatus> => {
        configureHub(sanitizeHubConfigureInput(input))
        // The switch and the URL both change what the client should be doing, so
        // it is re-armed from the stored row rather than patched in place.
        usageHubClient.restart()
        return usageHubClient.status()
      }
    },
    {
      channel: 'usage-hub:set-secret',
      capability: 'config',
      kind: 'command',
      handler: async (secret?: unknown): Promise<UsageHubStatus> => {
        setHubSecret(sanitizeHubSecret(secret))
        // A machine parked in `needs-credentials` has stopped its timers, so a
        // new token has to re-arm them.
        usageHubClient.restart()
        return usageHubClient.status()
      }
    },
    {
      channel: 'usage-hub:sync-now',
      capability: 'config',
      kind: 'command',
      handler: async (): Promise<UsageHubStatus> => usageHubClient.syncNow()
    },
    {
      channel: 'usage-hub:resync',
      capability: 'config',
      kind: 'command',
      handler: async (): Promise<UsageHubStatus> => usageHubClient.resync()
    },
    {
      channel: 'usage-hub:forget',
      capability: 'config',
      kind: 'command',
      handler: async (): Promise<UsageHubStatus> => {
        usageHubClient.stop()
        forgetHub()
        return usageHubClient.status()
      }
    }
  ]
}

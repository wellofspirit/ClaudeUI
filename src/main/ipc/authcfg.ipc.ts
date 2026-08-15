/**
 * Desktop-transport registration for the remote-access settings verbs
 * (ADR-054 decision 6).
 *
 * Mirrors `webauthn.ipc.ts`: the handler lives in the shared command registry
 * and the `ipcMain.handle` wrapper only routes through `dispatch`, so capability
 * enforcement and audit are the same code the remote transport runs.
 *
 * **Why register these on the desktop at all**, when `remote:set-config` already
 * writes every one of these columns from here: because the registry's
 * declaration is channel-GLOBAL. Registering both transports is what makes the
 * capability/kind declaration a single reviewed fact rather than a remote-only
 * one, and it gives the desktop settings surface the same audited path a phone
 * takes. The desktop connection is exempt from the freshness gate (it IS the
 * host anchor), so the verbs behave there exactly as `remote:set-config` does.
 *
 * `remote:set-config` is deliberately NOT retired: it stays the host-anchor-only
 * writer, and it is the ONLY writer of the `off` master switch.
 */

import { ipcMain } from 'electron'
import {
  commandRegistry,
  desktopConnection,
  registerCommand,
  type CommandConnection,
  type CommandRegistration
} from './command-registry'
import {
  authcfgSetAuthMode,
  authcfgSetPassword,
  authcfgSetRetention,
  authcfgSetTier,
  type AuthcfgHost
} from './authcfg-commands'
import { AUTHCFG_CHANNELS } from '../services/step-up-tier'
import type { RemoteAuthPolicy, StepUpTier } from '../../shared/types'

/**
 * The channels to clear before re-registering — read from the CLASSIFIER, not
 * restated here.
 *
 * That import is the point: `AUTHCFG_CHANNELS` is what `classifyDispatch` uses
 * to give this namespace strong-tier freshness on every tier. A fifth verb
 * registered below without being added there would be classified `mutation`
 * instead — i.e. silently free under the default `medium` tier — which is
 * exactly the "two places restating one rule" failure this codebase has already
 * paid for once. Sharing the constant makes that a visible edit rather than a
 * silent downgrade.
 *
 * The parity test in `__tests__/remote-handlers.ipc.test.ts` keeps its own
 * literal list on purpose: an independent pin is worth nothing if it imports
 * the thing it is pinning.
 */
const AUTHCFG_IPC_CHANNELS = [...AUTHCFG_CHANNELS]

function handleIpc(reg: Omit<CommandRegistration, 'transport'>): void {
  registerCommand({ ...reg, transport: 'desktop' })
  ipcMain.handle(reg.channel, (_event, ...args: unknown[]) =>
    commandRegistry.dispatch(reg.channel, 'desktop', args, desktopConnection())
  )
}

/**
 * Register the desktop half. `host` is the running `RemoteServer`; `null` (a
 * harness instance with remote access disabled) keeps the CHANNELS registered
 * and simply performs no disconnects — the channel set must not depend on
 * runtime configuration, or the parity pins would report a different surface in
 * tests than in production.
 */
export function registerAuthcfgIpc(host: AuthcfgHost | null): void {
  for (const channel of AUTHCFG_IPC_CHANNELS) {
    ipcMain.removeHandler(channel)
  }

  handleIpc({
    channel: 'authcfg:set-tier',
    capability: 'admin',
    kind: 'command',
    withConnection: true,
    handler: async (connection: CommandConnection, tier: StepUpTier) =>
      authcfgSetTier(connection, tier, host)
  })

  handleIpc({
    channel: 'authcfg:set-auth-mode',
    capability: 'admin',
    kind: 'command',
    withConnection: true,
    handler: async (connection: CommandConnection, mode: RemoteAuthPolicy | null) =>
      authcfgSetAuthMode(connection, mode, host)
  })

  handleIpc({
    channel: 'authcfg:set-password',
    capability: 'admin',
    kind: 'command',
    withConnection: true,
    handler: async (connection: CommandConnection, password: string) =>
      authcfgSetPassword(connection, password, host)
  })

  handleIpc({
    channel: 'authcfg:set-retention',
    capability: 'admin',
    kind: 'command',
    withConnection: true,
    handler: async (connection: CommandConnection, days: number) =>
      authcfgSetRetention(connection, days)
  })
}

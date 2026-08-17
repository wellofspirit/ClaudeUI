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
 * takes. The desktop connection is exempt from the SESSION gate (it IS the host
 * anchor — its editor unlocks with no ceremony and no TTL), so the verbs behave
 * there exactly as `remote:set-config` does.
 *
 * `remote:set-config` is deliberately NOT retired: it stays the host-anchor-only
 * writer — the desktop pane's actual save path — and it is the ONLY writer of
 * the `off` master switch.
 */

import { ipcMain } from 'electron'
import {
  commandRegistry,
  desktopConnection,
  registerCommand,
  type CommandConnection,
  type CommandRegistration
} from '../../core/ipc/command-registry'
import {
  authcfgApply,
  authcfgEnd,
  authcfgGet,
  authcfgLanLink,
  authcfgRotateLanKey,
  authcfgSetPassword,
  type AuthcfgApplyPatch,
  type AuthcfgHost
} from '../../core/ipc/authcfg-commands'
import { AUTHCFG_CHANNELS, AUTHCFG_FREE_CHANNELS } from '../../core/services/step-up-tier'

/**
 * The channels to clear before re-registering — both classifier sets, read from
 * the CLASSIFIER rather than restated here.
 *
 * That import is the point: `AUTHCFG_CHANNELS` is what `classifyDispatch` uses
 * to demand a settings-editing session, and `AUTHCFG_FREE_CHANNELS` is the
 * explicit list of the two that are free. A new verb registered below and added
 * to NEITHER set would be classified `mutation` — i.e. silently reachable
 * without an unlocked editor — which is exactly the "two places restating one
 * rule" failure this codebase has already paid for once. Sharing the constants
 * makes that a visible edit rather than a silent downgrade.
 *
 * The guard in `__tests__/remote-handlers.ipc.test.ts` pins the namespace both
 * ways: every registered `authcfg:*` channel is in exactly one of the two sets,
 * and every member of the gated set is registered. It keeps its own literal
 * lists on purpose — an independent pin is worth nothing if it imports the thing
 * it is pinning.
 */
const AUTHCFG_IPC_CHANNELS = [...AUTHCFG_FREE_CHANNELS, ...AUTHCFG_CHANNELS]

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

  // The READ. `query`, so it is free on every tier — see AUTHCFG_IPC_CHANNELS.
  handleIpc({
    channel: 'authcfg:get',
    capability: 'admin',
    kind: 'query',
    withConnection: true,
    handler: async (connection: CommandConnection) => authcfgGet(connection)
  })

  handleIpc({
    channel: 'authcfg:apply',
    capability: 'admin',
    kind: 'command',
    withConnection: true,
    handler: async (connection: CommandConnection, patch: AuthcfgApplyPatch) =>
      authcfgApply(connection, patch, host)
  })

  handleIpc({
    channel: 'authcfg:end',
    capability: 'admin',
    kind: 'command',
    withConnection: true,
    handler: async (connection: CommandConnection) => authcfgEnd(connection)
  })

  handleIpc({
    channel: 'authcfg:set-password',
    capability: 'admin',
    kind: 'command',
    withConnection: true,
    handler: async (connection: CommandConnection, password: string) =>
      authcfgSetPassword(connection, password, host)
  })

  // ADR-056 item C. A `query` that is nonetheless SESSION-GATED — it returns a
  // channel key, and `AUTHCFG_CHANNELS` (not the kind) is what decides that.
  handleIpc({
    channel: 'authcfg:lan-link',
    capability: 'admin',
    kind: 'query',
    withConnection: true,
    handler: async (connection: CommandConnection) => authcfgLanLink(connection, host)
  })

  handleIpc({
    channel: 'authcfg:rotate-lan-key',
    capability: 'admin',
    kind: 'command',
    withConnection: true,
    handler: async (connection: CommandConnection) => authcfgRotateLanKey(connection, host)
  })
}

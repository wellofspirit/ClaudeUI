/**
 * `remote:status-view` — the one `remote:*` channel a remote client may reach.
 *
 * ## Why it exists
 *
 * Owner ruling, 2026-08-28: "a remote web view should be able to see the
 * connected clients. though they should not be able to disable the remote mode
 * themselves, as it will kill themselves."
 *
 * The host anchor's `remote:status` cannot serve that: `RemoteStatus.lanUrl` and
 * `tunnelUrl` carry the LAN channel key / the ephemeral tunnel key in their
 * fragments (ADR-056 item C), which is precisely why the whole `remote:*` family
 * is raw `ipcMain.handle` wiring in `boot-core.ts` with no registry entry at
 * all. So this is a SECOND, narrower channel with its own redacted type rather
 * than a widening of the first.
 *
 * ## The two rules this file encodes
 *
 * 1. **The redaction is an explicit field PICK.** {@link remoteStatusView} names
 *    every field it copies out of `RemoteStatus`. Never a spread-and-delete: a
 *    field added to `RemoteStatus` tomorrow — another URL, another key — must
 *    not reach a remote client because nobody remembered to subtract it.
 *    `RemoteStatusView` in `shared/types.ts` justifies the pick list field by
 *    field, including which three `RemoteTlsStatus` fields are dropped and why.
 *
 * 2. **MUTATIONS STAY DESKTOP-ONLY, STRUCTURALLY.** `remote:start`, `stop`,
 *    `set-config`, `set-password`, `clear-password`, `force-reserve`,
 *    `tailscale-detect` and `interfaces` are registered on NEITHER transport —
 *    they have no `CommandRegistration` anywhere, here included. A remote client
 *    therefore cannot stop the listener it is talking through, or flip the
 *    transport out from under itself, because there is no channel to call: not
 *    because a button is hidden and not because a capability check refuses it.
 *    (`PINNED_CAPABILITIES` pins the six admin ones as the belt.) A future edit
 *    that adds a `remote:*` mutation to this array would break that property; do
 *    not, and `remote-handlers.ipc.test.ts` pins the absence.
 *
 * Registered on BOTH transports for the usual reason (`config-commands.ts`
 * header): the registry's declaration is channel-global, so registering the
 * desktop side too keeps capability/kind one reviewed fact rather than a
 * remote-only one — and it gives the desktop preload a real handler behind
 * `getRemoteStatusView`.
 */

import { handleIpc, unbindDesktopChannels } from './desktop-transport-binding'
import type { CommandRegistration } from './command-registry'
import type { RemoteStatus, RemoteStatusView } from '../../shared/types'

/**
 * The status SOURCE — `RemoteServer` in production, satisfied structurally so a
 * test can hand in a plain object. Narrow on purpose: this module needs one
 * read and must not become a second handle on the server.
 */
export interface RemoteStatusHost {
  getStatus(): RemoteStatus
}

/** The channels registered here, cleared before re-registering (idempotent boot). */
export const REMOTE_VIEW_CHANNELS = ['remote:status-view'] as const

/**
 * Redact a full {@link RemoteStatus} down to what a remote client may see.
 *
 * Exported for the guard test, which asserts BOTH halves: that the result's keys
 * are exactly `RemoteStatusView`'s, and that `lanUrl` / `tunnelUrl` (and the
 * tunnel error and TLS URL derived from that family) are absent from a status
 * whose every field is populated.
 */
export function remoteStatusView(status: RemoteStatus): RemoteStatusView {
  return {
    running: status.running,
    port: status.port,
    connectedClients: status.connectedClients,
    // Copied rather than aliased: the arrays `RemoteServer.getStatus()` builds
    // are fresh per call, but a `RemoteStatusHost` stub's need not be, and a view
    // that hands out a live reference to server state is a different contract.
    clientIps: [...status.clientIps],
    clientLogins: [...status.clientLogins],
    tunnelState: status.tunnelState,
    authMethods: [...status.authMethods],
    lastError: status.lastError,
    tls:
      status.tls === null
        ? null
        : {
            mode: status.tls.mode,
            httpsPort: status.tls.httpsPort,
            pinnedHttpsPort: status.tls.pinnedHttpsPort,
            detection: status.tls.detection
          }
  }
}

/**
 * The transport-agnostic declaration. `host` is the running `RemoteServer`;
 * `null` (a harness instance with remote access disabled, and every test that
 * boots the registrars without a server) keeps the CHANNEL registered and makes
 * it THROW — the channel set must not depend on runtime configuration, and
 * answering "not running" would be a claim this process cannot make.
 *
 * `query`, so it is a read: unaudited, and free of any step-up freshness demand.
 * `config`, so any authenticated connection reaches it — same class as
 * `account:get` and the rest of the read surface, and deliberately not `admin`:
 * this carries no credential, no key and no configuration write.
 */
export function remoteViewCommands(
  host: RemoteStatusHost | null
): Array<Omit<CommandRegistration, 'transport'>> {
  return [
    {
      channel: 'remote:status-view',
      capability: 'config',
      kind: 'query',
      handler: async (): Promise<RemoteStatusView> => {
        if (!host) throw new Error('Remote status is unavailable in this instance')
        return remoteStatusView(host.getStatus())
      }
    }
  ]
}

/**
 * Register the desktop half. Mirrors `webauthn.ipc.ts` / `authcfg.ipc.ts`: the
 * body lives in the shared registry and the `ipcMain` wrapper only routes
 * through `dispatch`, so both transports run the same redaction.
 */
export function registerRemoteViewIpc(host: RemoteStatusHost | null): void {
  unbindDesktopChannels(REMOTE_VIEW_CHANNELS)
  for (const cmd of remoteViewCommands(host)) handleIpc(cmd)
}

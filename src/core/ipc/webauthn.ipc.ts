/**
 * Desktop-transport registration for the passkey management verbs (ADR-052).
 *
 * Mirrors `terminal.ipc.ts`: the handler lives in the shared command registry,
 * and the `ipcMain.handle` wrapper only routes through `dispatch`, so capability
 * enforcement and audit are the same code the remote transport runs.
 *
 * **Only the MANAGEMENT verbs are registered here.** `webauthn:register-options`
 * / `-verify` are remote-only: a ceremony needs a browser on a WebAuthn-capable
 * origin, and the desktop renderer is neither (it loads from `file://` / the
 * vite dev server, so it has no RP ID to bind to and `webauthnOrigin` is null on
 * its connection anyway). Desktop-side enrollment is the QR / one-time-link flow
 * — `webauthn:mint-enroll-token` — which IS here.
 *
 * The three management writes are session-gated on the REMOTE transport
 * (ADR-054 decision 6, `PASSKEY_ADMIN_CHANNELS`). Here they are not: the desktop
 * connection is the host anchor, exempt from the whole step-up table, so its
 * pane renames, revokes and mints with no ceremony. They are `withConnection`
 * because the declaration is channel-global and the bodies assert the session
 * through that same table.
 */

import { type CommandConnection } from './command-registry'
import { handleIpc, unbindDesktopChannels } from './desktop-transport-binding'
import {
  mintEnrollToken,
  webauthnCredentials,
  webauthnRename,
  webauthnRevoke,
  type RemoteAuthSurfaceHost
} from './webauthn-commands'

const WEBAUTHN_IPC_CHANNELS = [
  'webauthn:credentials',
  'webauthn:rename',
  'webauthn:revoke',
  'webauthn:mint-enroll-token'
]

/**
 * Register the desktop half. `host` is the running {@link RemoteServer};
 * `null` (no server, e.g. a harness instance with remote access disabled) keeps
 * the CHANNEL registered but makes it throw `enroll-unavailable`, so the channel
 * set does not depend on runtime configuration.
 */
export function registerWebauthnIpc(host: RemoteAuthSurfaceHost | null): void {
  unbindDesktopChannels(WEBAUTHN_IPC_CHANNELS)

  handleIpc({
    channel: 'webauthn:credentials',
    capability: 'admin',
    kind: 'query',
    handler: async () => webauthnCredentials()
  })

  handleIpc({
    channel: 'webauthn:rename',
    capability: 'admin',
    kind: 'command',
    withConnection: true,
    handler: async (connection: CommandConnection, credId: string, nickname: string | null) =>
      webauthnRename(connection, credId, nickname)
  })

  handleIpc({
    channel: 'webauthn:revoke',
    capability: 'admin',
    kind: 'command',
    // Must match the remote registration's declaration (the registry throws
    // otherwise) — and the desktop actor needs naming on the audit row too.
    withConnection: true,
    handler: async (connection: CommandConnection, credId: string) =>
      webauthnRevoke(connection, credId, host)
  })

  handleIpc({
    channel: 'webauthn:mint-enroll-token',
    capability: 'admin',
    kind: 'command',
    withConnection: true,
    handler: async (connection: CommandConnection) => mintEnrollToken(connection, host)
  })
}

/**
 * The two remote-IDE channels (ADR-064), declared ONCE and served by both
 * transports.
 *
 * ## Why two channels and not one
 *
 * `ide:availability` is the terminal rule applied to a second capability:
 * **asking "may I?" must be answerable without holding the grant**. So it
 * declares `config` (in the base grant set, a `query`, free on every tier) while
 * `ide:mint-entry` declares `ide` — pinned, in no static grant set, armed only by
 * a step-up ceremony under an operator's toggle. A UI that had to hold the grant
 * before it could discover whether the grant was obtainable would either prompt
 * for a ceremony it could not use, or hide a button that works.
 *
 * ## Why the bodies live here rather than on the service
 *
 * They need three things that no single owner has: the POLICY (the DB toggle),
 * the connection's ORIGIN (only the transport classifies that), and the
 * connection's GRANT/presence state (the registry's). This module is the one
 * place all three meet, and keeping it transport-agnostic is what stops the
 * desktop and remote surfaces from answering the same question differently.
 */

import { handleIpc, unbindDesktopChannels } from './desktop-transport-binding'
import {
  ideOriginPolicy,
  readIdePolicy,
  type VscodeWebService
} from '../services/vscode-web-service'
import { shellActAllowed } from '../services/step-up-tier'
import type { CommandConnection, CommandRegistration } from './command-registry'
import type { ConnectionOrigin } from '../services/remote-server'
import {
  IDE_UNAVAILABLE_ERROR,
  type IdeAvailability,
  type IdeEntry,
  type IdeUnavailableReason
} from '../../shared/remote-protocol'

/** The channels registered here, cleared before re-registering (idempotent boot). */
export const IDE_CHANNELS = ['ide:availability', 'ide:mint-entry'] as const

/**
 * What these commands need from the transport.
 *
 * Satisfied by `RemoteServer` in production and by a plain object in tests.
 * Narrow on purpose — two methods — and deliberately the SAME object for both,
 * rather than an origin source plus a separately-imported service singleton: the
 * server is where `setIdeService` puts the service, so asking it is what keeps
 * ONE injection point. Reaching for the module singleton here instead would make
 * `setIdeService` a lie in every test that injected a different one.
 */
export interface IdeCommandHost {
  /**
   * The origin this connection was classified as at accept, `'localhost'` for
   * the host's own in-process surface, or `null` when it cannot be resolved —
   * a socket that has already gone away. Null FAILS CLOSED: an unknown origin is
   * refused, never assumed local.
   */
  ideOriginOf(connection: CommandConnection): ConnectionOrigin | null
  /** The installed IDE service, or null in a process that has none. */
  ideService(): VscodeWebService | null
}

/** `ide-unavailable:<reason>` — the wire form the client parses. */
function unavailable(reason: IdeUnavailableReason): Error {
  return new Error(`${IDE_UNAVAILABLE_ERROR}:${reason}`)
}

/**
 * Answer `ide:availability` for one connection.
 *
 * The field derivation mirrors `terminalService.availability` deliberately —
 * `allowed` is the toggle, `granted` is "may I ACT" (capability AND a fresh act
 * window), `needsStepUp` is the curable gap — plus the axis the terminal does not
 * have: `originAllowed`. It is separate rather than folded into `allowed`
 * because **no ceremony can fix it** (ADR-064 §3), so a client that conflated the
 * two would offer a step-up on the tunnel forever. `needsStepUp` is therefore
 * gated on the origin as well: prompting for a proof that cannot help is the
 * failure the typed answer exists to prevent.
 *
 * `granted` reads the CAPABILITY as well as the presence proof, for the reason
 * `TerminalAvailability.readsAllowed` does: toggle-off strips `ide` and leaves
 * `armedEver` standing, so a connection that lived through an off→on cycle is
 * armed and holds nothing, and must be shown the wall rather than a button whose
 * every dispatch the registry refuses.
 */
export async function ideAvailability(
  host: IdeCommandHost,
  connection: CommandConnection
): Promise<IdeAvailability> {
  const service = host.ideService()
  if (!service) throw new Error('The remote IDE is unavailable in this instance')
  const policy = readIdePolicy()
  const origin = host.ideOriginOf(connection)
  const verdict =
    origin === null
      ? ({ allowed: false, reason: 'origin-not-allowed' } as const)
      : ideOriginPolicy(origin)
  const granted = policy.allowIde && connection.grants.has('ide') && shellActAllowed(connection)
  // Probed even when the toggle is off: the desktop settings pane flips the
  // switch and wants the typed detection result inline in the same breath, and
  // the probe is cached, so asking early costs one `--help` exec per boot.
  const probe = await service.probeCli(policy.cliPathOverride)
  return {
    allowed: policy.allowIde,
    granted,
    needsStepUp: policy.allowIde && verdict.allowed && !granted,
    originAllowed: verdict.allowed,
    ...(verdict.allowed ? {} : { originReason: verdict.reason }),
    probe,
    runtime: service.runtime(),
    ...(service.lastErrorMessage() ? { lastError: service.lastErrorMessage() } : {})
  }
}

/**
 * Mint a one-time entry URL.
 *
 * The order of the gates is the contract, cheapest and most absolute first:
 *
 *  1. **the toggle**, re-read live and fail-closed — a grant armed before the
 *     operator flipped the switch buys nothing (the `terminal:*` rule verbatim;
 *     the transport additionally REVOKES `ide` when it meets this);
 *  2. **the origin**, which no ceremony can cure;
 *  3. **the argument**, so a bad folder is a plain error rather than a typed
 *     IDE refusal the client would render as "VS Code is unavailable";
 *  4. **the CLI probe**, cached, typed;
 *  5. **the child**, spawned lazily and single-flighted.
 */
export async function ideMintEntry(
  host: IdeCommandHost,
  connection: CommandConnection,
  payload: { folder: string }
): Promise<IdeEntry> {
  if (!readIdePolicy().allowIde) throw unavailable('toggle-off')

  const origin = host.ideOriginOf(connection)
  if (origin === null || !ideOriginPolicy(origin).allowed) throw unavailable('origin-not-allowed')

  const service = host.ideService()
  // No service in this process at all — a harness instance with remote access
  // disabled. Typed as `cli-not-found` rather than a bespoke reason: from the
  // client's side "this host cannot give you an IDE" is exactly that shape, and
  // a reason nobody can act on differently does not earn a member of the union.
  if (!service) throw unavailable('cli-not-found')

  const folder = typeof payload?.folder === 'string' ? payload.folder.trim() : ''
  // Absolute because `?folder=` is resolved by the workbench against nothing at
  // all — a relative path there is not a smaller scope, it is an unpredictable
  // one. NOT a containment boundary: ADR-064 records that `?folder=` never was
  // (an IDE session reaches whatever the host user can), so this is argument
  // hygiene, not authorization.
  if (folder === '' || !isAbsoluteHostPath(folder)) {
    throw new Error('ide:mint-entry requires an absolute folder path')
  }

  const probe = await service.probeCli()
  if (!probe.ok) throw unavailable(probe.reason)

  try {
    await service.ensureRunning(connection)
  } catch {
    // The reason is already on the service (`lastError`) and in the audit row —
    // and `ide:availability` is where a client reads it. The thrown string stays
    // typed and detail-free so it cannot become a host-path oracle for a
    // connection that has not earned one.
    throw unavailable('spawn-failed')
  }
  return service.mintEntry(connection, folder)
}

/**
 * Absolute in the POSIX sense OR the Windows sense, whichever host this is.
 *
 * Deliberately NOT `path.isAbsolute`: the check must give the same answer on
 * both hosts for a path that came from a client, so a `D:\…` from a phone
 * driving a Windows host is accepted while the server itself runs on Linux in a
 * container. UNC paths are accepted for the same reason — they are absolute, and
 * whether the host can reach one is the host's answer to give, not ours.
 */
function isAbsoluteHostPath(candidate: string): boolean {
  return (
    candidate.startsWith('/') ||
    candidate.startsWith('\\\\') ||
    /^[a-zA-Z]:[\\/]/.test(candidate)
  )
}

/**
 * The transport-agnostic declarations.
 *
 * `host` is `null` for a harness instance with remote access disabled, and for
 * every test that boots the registrars without a server: the channels still
 * register and THROW, because the channel SET must not depend on runtime
 * configuration (or the parity pins would report a different surface in tests
 * than in production).
 */
export function ideCommands(
  host: IdeCommandHost | null
): Array<Omit<CommandRegistration, 'transport'>> {
  return [
    {
      channel: 'ide:availability',
      capability: 'config',
      kind: 'query',
      withConnection: true,
      handler: async (connection: CommandConnection): Promise<IdeAvailability> => {
        if (!host) throw new Error('The remote IDE is unavailable in this instance')
        return ideAvailability(host, connection)
      }
    },
    {
      channel: 'ide:mint-entry',
      capability: 'ide',
      kind: 'command',
      withConnection: true,
      handler: async (
        connection: CommandConnection,
        payload: { folder: string }
      ): Promise<IdeEntry> => {
        if (!host) throw unavailable('cli-not-found')
        return ideMintEntry(host, connection, payload)
      }
    }
  ]
}

/**
 * Register the desktop half. Mirrors `remote-view-commands.ts`: the bodies live
 * in the shared declarations and the `ipcMain` wrapper only routes through
 * `dispatch`, so both transports run the same gates.
 */
export function registerIdeIpc(host: IdeCommandHost | null): void {
  unbindDesktopChannels(IDE_CHANNELS)
  for (const cmd of ideCommands(host)) handleIpc(cmd)
}

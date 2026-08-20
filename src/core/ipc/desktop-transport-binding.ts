/**
 * `handleIpc` — the desktop-transport registrar, with the ipcMain half made
 * PLUGGABLE (S3 stage 1b).
 *
 * ## What this replaces, and why it is shaped this way
 *
 * `handleIpc` used to live in `src/main/ipc/desktop-transport.ts` and do two
 * things at once: register the channel in the shared {@link commandRegistry} for
 * the `desktop` transport, and call `ipcMain.handle`. The second half is the
 * only reason the whole registrar tree — `session.ipc.ts` and its four siblings,
 * ~2,200 lines — had to import Electron, and therefore the only reason a
 * headless entrypoint could not construct the service graph.
 *
 * The S3 kickoff proposed splitting each registrar into a "service construction"
 * half (→ core) and a "registration" half (stays in main). That is not
 * achievable: in `registerSessionIpc` the two are INTERLEAVED — the manager is
 * built, ~100 channels register, then `gitWatchRegistry.init()` /
 * `startProjectsWatcher()` / `startConfigWatcher()` / `seedCanonicalAppState()` /
 * `usageFetcher.startPolling()` run, then nine more channels register. Splitting
 * on that axis would REORDER side effects, which is exactly what the stage's
 * behaviour-equivalence requirement forbids.
 *
 * So the split is on the other axis. The registrar bodies move to `src/core`
 * WHOLE and IN ORDER — nothing moves relative to anything else, so ordering is
 * preserved by construction — and the one Electron-shaped act, binding a channel
 * to `ipcMain`, becomes an injected {@link DesktopTransportBinder}:
 *
 *   - `src/main/ipc/desktop-transport.ts` installs a binder that does
 *     `ipcMain.removeHandler` + `ipcMain.handle`. The desktop behaves exactly as
 *     before, down to the dispatch closure;
 *   - `src/server` installs NOTHING. `handleIpc` then registers the channel in
 *     the registry and binds it to no transport, which is precisely right: a
 *     headless process has no renderer to serve `desktop`-transport invokes to,
 *     while the registry entries themselves are shared state the remote
 *     dispatcher and the audit path both read.
 *
 * ## Why registration still happens headless
 *
 * It would be tempting to skip `registerCommand` too when there is no binder.
 * Don't: the registry's DECLARATION (capability, kind, sessionIdArg,
 * withConnection) is channel-global and is asserted to AGREE between transports
 * — `CommandRegistry.register` throws on a conflict. Registering the desktop
 * side unconditionally keeps that cross-check alive in every deployment, so a
 * headless-only build cannot quietly drift into a different capability for a
 * channel than the desktop build has.
 */

import {
  commandRegistry,
  hostConnection,
  registerCommand,
  type CommandRegistration
} from './command-registry'

/**
 * The host's channel-binding surface. Two operations, because the registrars
 * clear their channels before re-registering (a second `bootCore()` in a test,
 * macOS dock re-open) and Electron throws on a duplicate handler.
 */
export interface DesktopTransportBinder {
  /**
   * Bind `channel` on the host transport. The implementation must dispatch
   * through {@link CommandRegistry.dispatch} — never call a handler directly —
   * so the capability check and the audit row stay in one choke point.
   */
  bind(channel: string): void
  /** Drop the host binding for `channel`. Must tolerate an unbound channel. */
  unbind(channel: string): void
}

let binder: DesktopTransportBinder | null = null

/**
 * Install (or clear) the desktop transport binder. Called once by
 * `src/main/ipc/desktop-transport.ts`; a headless entrypoint never calls it.
 */
export function setDesktopTransportBinder(next: DesktopTransportBinder | null): void {
  binder = next
}

/**
 * The dispatch thunk a binder should invoke for `channel`. Exported so the
 * ipcMain adapter does not have to restate the transport name or re-derive the
 * host connection — the two facts that make a desktop invoke what it is. Note
 * they are DIFFERENT axes that were both once spelled `desktop`: `'desktop'` is
 * the TRANSPORT (this wire), while `hostConnection()` is the IDENTITY, and its
 * default label — `desktop-renderer` — is the correct one here because a binder
 * only ever exists where a renderer does.
 */
export function dispatchDesktop(channel: string, args: unknown[]): Promise<unknown> {
  return commandRegistry.dispatch(channel, 'desktop', args, hostConnection())
}

/**
 * Register one channel for the `desktop` transport and bind it on the host, if a
 * host installed a binder.
 *
 * Handlers deliberately do NOT receive Electron's `IpcMainInvokeEvent`: nothing
 * ever used it, and a handler body a headless core can also call must not know
 * about Electron at all. The event stays inside the binder.
 */
export function handleIpc(reg: Omit<CommandRegistration, 'transport'>): void {
  registerCommand({ ...reg, transport: 'desktop' })
  binder?.bind(reg.channel)
}

/**
 * Clear the host bindings for a set of channels — the `for (…) ipcMain
 * .removeHandler(ch)` preamble every registrar opens with, expressed once.
 * A no-op when no binder is installed.
 */
export function unbindDesktopChannels(channels: readonly string[]): void {
  if (!binder) return
  for (const channel of channels) binder.unbind(channel)
}

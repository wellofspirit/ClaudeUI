/**
 * The DESKTOP transport binder — the one place `ipcMain` meets the registry.
 *
 * This file used to export `handleIpc` itself, doing the registry registration
 * AND the `ipcMain.handle` in one call, which is what forced the entire
 * registrar tree (`session.ipc.ts` and its four siblings) to import Electron.
 * Since S3 stage 1b the registrars live in `src/core/ipc` and call the
 * Electron-free `handleIpc` from `core/ipc/desktop-transport-binding.ts`; what
 * is left here is the HOST HALF of that seam — an adapter that knows about
 * `ipcMain` and nothing else.
 *
 * The dispatch closure is byte-for-byte the behaviour it always had: the
 * handler is never called directly, only through
 * {@link dispatchDesktop} → `commandRegistry.dispatch`, so the capability check
 * and the audit row happen in the same choke point the WebSocket transport goes
 * through (SyncCore phase 1, ADR-051/052). Handlers still do NOT receive the
 * `IpcMainInvokeEvent` — nothing ever used it, and it stays inside this adapter.
 *
 * `removeHandler` before `handle` is the idempotence the registrars used to open
 * with explicitly (`for (const ch of CHANNELS) ipcMain.removeHandler(ch)`).
 * Doing it in `bind` as well as exposing `unbind` is deliberate belt-and-braces:
 * production boots core once, but a test that boots twice — or macOS re-running
 * the registrars on dock re-open — must not hit Electron's "second handler for
 * '<channel>'" throw.
 */

import { ipcMain } from 'electron'
import {
  dispatchDesktop,
  setDesktopTransportBinder
} from '../../core/ipc/desktop-transport-binding'

/**
 * Install the ipcMain binder. Called once from `bootCore()`, BEFORE any
 * registrar runs — a channel registered while no binder is installed would land
 * in the registry with no `ipcMain` handler behind it, and the renderer would
 * see "no handler for '<channel>'".
 */
export function installDesktopTransport(): void {
  setDesktopTransportBinder({
    bind(channel) {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, (_event, ...args: unknown[]) => dispatchDesktop(channel, args))
    },
    unbind(channel) {
      ipcMain.removeHandler(channel)
    }
  })
}

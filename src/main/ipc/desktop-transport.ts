/**
 * `handleIpc` — the DESKTOP transport adapter, one copy.
 *
 * Registers one channel in the shared command registry for the `desktop`
 * transport and wires the matching `ipcMain.handle`, which does nothing but
 * dispatch through {@link commandRegistry} — so the capability check and the
 * audit row happen in the same choke point the WebSocket transport goes through
 * (SyncCore phase 1, ADR-051/052).
 *
 * It lived inside `session.ipc.ts` until the S1b sweep, which needed a SECOND
 * registrar file (`automation.ipc.ts`) to expose channels the same way. Copying
 * four lines would have been a second implementation of the transport adapter —
 * the exact thing the registry exists to prevent — so the adapter moved here and
 * `session.ipc.ts` imports it. Behaviour is unchanged.
 *
 * Handlers deliberately do NOT receive the Electron `IpcMainInvokeEvent`:
 * nothing ever used it, and a handler body a headless core can also call must
 * not know about Electron at all. The event stays in this adapter.
 */

import { ipcMain } from 'electron'
import {
  commandRegistry,
  desktopConnection,
  registerCommand,
  type CommandRegistration
} from './command-registry'

export function handleIpc(reg: Omit<CommandRegistration, 'transport'>): void {
  registerCommand({ ...reg, transport: 'desktop' })
  ipcMain.handle(reg.channel, (_event, ...args: unknown[]) =>
    commandRegistry.dispatch(reg.channel, 'desktop', args, desktopConnection())
  )
}

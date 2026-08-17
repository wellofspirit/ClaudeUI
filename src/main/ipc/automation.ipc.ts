import { ipcMain, Notification } from 'electron'
import { app } from 'electron'
const is = { dev: !app.isPackaged }
import { AutomationManager } from '../../core/services/automation-manager'
import { logger } from '../../core/services/logger'
import { AUTOMATION_COMMANDS, setAutomationManager } from '../../core/ipc/automation-commands'
import { handleIpc } from './desktop-transport'

/**
 * The DESKTOP half of the automation surface.
 *
 * It used to be ten raw `ipcMain.handle` calls with their handler bodies inline
 * — no declared capability, no capability check, no audit row, and no remote
 * twin. The bodies live in `automation-commands.ts` now and both transports
 * spread the same declarations; this file owns what only the desktop boot can
 * own: constructing the manager, starting the schedules, and wiring `ipcMain`
 * (through `handleIpc`, so the dispatch goes through the registry choke point
 * like every other channel).
 */
const AUTOMATION_IPC_CHANNELS = AUTOMATION_COMMANDS.map((cmd) => cmd.channel)

export function registerAutomationIpc(): AutomationManager {
  // Remove old handlers (for re-registration)
  for (const ch of AUTOMATION_IPC_CHANNELS) {
    ipcMain.removeHandler(ch)
  }

  // Desktop native-notification sink: a run's completion surfaces as an OS
  // notification. The manager is otherwise Electron-free (S2) — this is the one
  // host-shaped capability, injected here where the desktop boot owns it.
  const manager = new AutomationManager((notification) => {
    new Notification({ ...notification, silent: false }).show()
  })
  setAutomationManager(manager)
  manager.load()

  // Skip automatic scheduling in dev mode — avoids spawning SDK subprocesses
  // and hitting the API during development. Manual "Run Now" still works.
  if (!is.dev) {
    manager.startAll()
  } else {
    logger.info('AutomationIpc', 'Dev mode — skipping automatic automation scheduling')
  }

  for (const cmd of AUTOMATION_COMMANDS) {
    handleIpc(cmd)
  }

  return manager
}

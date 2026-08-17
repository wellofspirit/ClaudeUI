import { ipcMain } from 'electron'
import { app } from 'electron'
const is = { dev: !app.isPackaged }
import { AutomationManager } from '../services/automation-manager'
import { logger } from '../services/logger'
import { AUTOMATION_COMMANDS, setAutomationManager } from './automation-commands'
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

  const manager = new AutomationManager()
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

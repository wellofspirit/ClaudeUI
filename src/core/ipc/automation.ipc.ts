import { AutomationManager } from '../services/automation-manager'
import { logger } from '../services/logger'
import { hostIsPackaged, type HostNotifier } from '../host'
import { AUTOMATION_COMMANDS, setAutomationManager } from './automation-commands'
import { handleIpc, unbindDesktopChannels } from './desktop-transport-binding'

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

export function registerAutomationIpc(notify?: HostNotifier): AutomationManager {
  // Remove old handlers (for re-registration)
  unbindDesktopChannels(AUTOMATION_IPC_CHANNELS)

  // Native-notification sink: a run's completion surfaces as an OS
  // notification. The manager is otherwise Electron-free (S2), and since S3
  // stage 1b so is this file — the desktop passes an `Electron.Notification`
  // sink down from `boot-core`, and a headless server passes nothing (there is
  // no desktop to notify; the run still completes and still emits its events).
  const manager = new AutomationManager((notification) => {
    notify?.(notification)
  })
  setAutomationManager(manager)
  manager.load()

  // Skip automatic scheduling in dev mode — avoids spawning SDK subprocesses
  // and hitting the API during development. Manual "Run Now" still works.
  // `hostIsPackaged()` is the S3 stage-1b seam for what was `!app.isPackaged`;
  // it is false with no host wired, which keeps dev/test behaviour identical.
  if (hostIsPackaged()) {
    manager.startAll()
  } else {
    logger.info('AutomationIpc', 'Dev mode — skipping automatic automation scheduling')
  }

  for (const cmd of AUTOMATION_COMMANDS) {
    handleIpc(cmd)
  }

  return manager
}

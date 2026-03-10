import { ipcMain, type BrowserWindow } from 'electron'
import { is } from '@electron-toolkit/utils'
import { AutomationManager } from '../services/automation-manager'
import { logger } from '../services/logger'
import type { Automation } from '../../shared/types'

const AUTOMATION_IPC_CHANNELS = [
  'automation:list',
  'automation:save',
  'automation:delete',
  'automation:run-now',
  'automation:toggle',
  'automation:list-runs',
  'automation:load-run-history',
  'automation:cancel',
  'automation:dismiss-run',
  'automation:send-message'
]

export function registerAutomationIpc(win: BrowserWindow): AutomationManager {
  // Remove old handlers (for re-registration)
  for (const ch of AUTOMATION_IPC_CHANNELS) {
    ipcMain.removeHandler(ch)
  }

  const manager = new AutomationManager(win)
  manager.load()

  // Skip automatic scheduling in dev mode — avoids spawning SDK subprocesses
  // and hitting the API during development. Manual "Run Now" still works.
  if (!is.dev) {
    manager.startAll()
  } else {
    logger.info('AutomationIpc', 'Dev mode — skipping automatic automation scheduling')
  }

  ipcMain.handle('automation:list', () => manager.list())

  ipcMain.handle('automation:save', (_e, automation: Automation) => {
    manager.upsert(automation)
  })

  ipcMain.handle('automation:delete', (_e, id: string) => {
    manager.delete(id)
  })

  ipcMain.handle('automation:run-now', (_e, id: string) => {
    // Fire-and-forget — don't await, runs stream results via events
    manager.runNow(id).catch(() => {})
  })

  ipcMain.handle('automation:toggle', (_e, id: string, enabled: boolean) => {
    manager.toggle(id, enabled)
  })

  ipcMain.handle('automation:list-runs', (_e, automationId: string) => {
    return manager.listRuns(automationId)
  })

  ipcMain.handle('automation:load-run-history', (_e, automationId: string, runId: string) => {
    return manager.loadRunMessages(automationId, runId)
  })

  ipcMain.handle('automation:cancel', (_e, id: string) => {
    manager.cancelRun(id)
  })

  ipcMain.handle('automation:dismiss-run', (_e, automationId: string, runId: string) => {
    manager.dismissRun(automationId, runId)
  })

  ipcMain.handle('automation:send-message', (_e, id: string, prompt: string) => {
    manager.sendMessage(id, prompt)
  })

  return manager
}

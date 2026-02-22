import { ipcMain, BrowserWindow } from 'electron'
import { PtyManager } from '../services/pty-manager'

const TERMINAL_IPC_CHANNELS = [
  'terminal:create', 'terminal:write', 'terminal:resize', 'terminal:kill'
]

export function registerTerminalIpc(win: BrowserWindow): void {
  for (const channel of TERMINAL_IPC_CHANNELS) {
    ipcMain.removeHandler(channel)
  }

  const manager = new PtyManager()

  ipcMain.handle('terminal:create', (_e, cwd: string) => {
    const id = manager.create(
      cwd,
      (terminalId, data) => {
        if (!win.isDestroyed()) {
          win.webContents.send('terminal:data', { terminalId, data })
        }
      },
      (terminalId, exitCode) => {
        if (!win.isDestroyed()) {
          win.webContents.send('terminal:exit', { terminalId, code: exitCode })
        }
      }
    )
    return id
  })

  ipcMain.handle('terminal:write', (_e, id: string, data: string) => {
    manager.write(id, data)
  })

  ipcMain.handle('terminal:resize', (_e, id: string, cols: number, rows: number) => {
    manager.resize(id, cols, rows)
  })

  ipcMain.handle('terminal:kill', (_e, id: string) => {
    manager.kill(id)
  })

  win.on('closed', () => {
    manager.killAll()
  })
}

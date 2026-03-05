import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerSessionIpc } from './ipc/session.ipc'
import { registerTerminalIpc } from './ipc/terminal.ipc'
import { registerAutomationIpc } from './ipc/automation.ipc'
import { logger } from './services/logger'
import icon from '../../resources/icon.png?asset'

// Prevent "nested session" error when launched from a Claude Code terminal
delete process.env.CLAUDECODE

// macOS GUI apps don't inherit the shell PATH, so node/bun aren't found.
// Use a non-interactive login shell to get the real PATH.
if (process.platform === 'darwin') {
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    const result = execFileSync(shell, ['-lc', 'echo $PATH'], {
      encoding: 'utf-8',
      timeout: 3000
    }).trim()
    if (result) process.env.PATH = result
  } catch (err) {
    logger.warn('main', 'Failed to read shell PATH, using fallback', err)
    const extra = '/opt/homebrew/bin:/usr/local/bin:/usr/local/sbin'
    process.env.PATH = `${extra}:${process.env.PATH ?? ''}`
  }
}

function createWindow(): void {
  const isMac = process.platform === 'darwin'

  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 600,
    minHeight: 400,
    show: false,
    autoHideMenuBar: true,
    // macOS: transparent + vibrancy for frosted glass, hidden inset title bar
    ...(isMac
      ? {
          transparent: true,
          vibrancy: 'under-window',
          titleBarStyle: 'hiddenInset',
          trafficLightPosition: { x: 15, y: 16 }
        }
      : {
          frame: false,
          backgroundColor: '#00000000',
          backgroundMaterial: 'acrylic'
        }),
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  registerSessionIpc(mainWindow)
  registerTerminalIpc(mainWindow)
  const automationManager = registerAutomationIpc(mainWindow)

  // Before-quit: give renderer a chance to prompt about active worktrees
  let quitConfirmed = false
  let quitTimeout: ReturnType<typeof setTimeout> | null = null

  app.on('before-quit', (e) => {
    automationManager.stopAll()
    // Stop the service session (lightweight CLI subprocess for usage polling)
    import('./services/service-session').then(({ serviceSession }) => serviceSession.stop()).catch(() => {})
    if (quitConfirmed) return
    e.preventDefault()
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app:before-quit')
    }
    // Fallback: if renderer doesn't respond in 5 seconds, quit anyway
    if (quitTimeout) clearTimeout(quitTimeout)
    quitTimeout = setTimeout(() => {
      quitConfirmed = true
      app.quit()
    }, 5000)
  })

  // Remove previous handler if re-registered (macOS dock re-open)
  ipcMain.removeHandler('app:quit-confirm')
  ipcMain.handle('app:quit-confirm', () => {
    if (quitTimeout) clearTimeout(quitTimeout)
    quitConfirmed = true
    app.quit()
  })

  // Renderer error logging → main process log file
  ipcMain.removeAllListeners('log:error')
  ipcMain.on('log:error', (_e, source: string, message: string) => {
    logger.error(`renderer/${source}`, message)
  })

  // Window control IPC handlers (for frameless windows on Windows/Linux)
  for (const ch of ['window:minimize', 'window:maximize', 'window:close', 'app:open-in-vscode']) {
    ipcMain.removeHandler(ch)
  }
  ipcMain.handle('window:minimize', () => mainWindow.minimize())
  ipcMain.handle('window:maximize', () => {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow.maximize()
    }
  })
  ipcMain.handle('window:close', () => mainWindow.close())
  ipcMain.handle('app:open-in-vscode', (_e, cwd: string) => {
    shell.openExternal(`vscode://file/${cwd}`)
  })

  // Send maximize/unmaximize state changes to renderer
  mainWindow.on('maximize', () => {
    mainWindow.webContents.send('window:maximized-change', true)
  })
  mainWindow.on('unmaximize', () => {
    mainWindow.webContents.send('window:maximized-change', false)
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Global error handlers — catch anything that slips through
process.on('uncaughtException', (err) => {
  logger.error('process', 'Uncaught exception', err)
})
process.on('unhandledRejection', (reason) => {
  logger.error('process', 'Unhandled rejection', reason)
})

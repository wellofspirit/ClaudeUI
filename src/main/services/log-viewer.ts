import { BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { is } from '@electron-toolkit/utils'
import { logger, logRing, type LogEntry } from './logger'

// Persist log viewer preferences in a separate file to avoid concurrent
// writes with the main app's settings.json.
const PREFS_PATH = join(homedir(), '.claude', 'ui', 'log-viewer.json')

function readPrefs(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(PREFS_PATH, 'utf-8'))
  } catch {
    return {}
  }
}

function writePrefs(prefs: Record<string, unknown>): void {
  try {
    mkdirSync(join(homedir(), '.claude', 'ui'), { recursive: true })
    writeFileSync(PREFS_PATH, JSON.stringify(prefs, null, 2) + '\n')
  } catch (err) {
    logger.warn('log-viewer', `Failed to write prefs: ${err}`)
  }
}

// ---------------------------------------------------------------------------
// LogViewer service
// ---------------------------------------------------------------------------

export class LogViewer {
  private win: BrowserWindow | null = null
  private unsubLogger: (() => void) | null = null

  constructor(mainWindow: BrowserWindow) {

    // Forward live log entries to the viewer window (if open).
    // logRing (in logger.ts) captures ALL entries from process start,
    // so the viewer can catch up even for entries before this point.
    this.unsubLogger = logger.subscribe((entry) => {
      if (this.win && !this.win.isDestroyed()) {
        this.win.webContents.send('log-viewer:entry', entry)
      }
    })

    // Capture renderer console messages (Event object API)
    mainWindow.webContents.on('console-message', (event) => {
      const { level, message, lineNumber, sourceId } = event
      const mappedLevel = level === 'warning' ? 'warn' : level
      const entry: LogEntry = {
        timestamp: new Date().toISOString().slice(11, 23),
        level: mappedLevel as LogEntry['level'],
        source: level === 'error' ? 'renderer:error' : 'renderer',
        message: sourceId ? `${message}  (${sourceId}:${lineNumber})` : message
      }
      logRing.push(entry)
      if (this.win && !this.win.isDestroyed()) {
        this.win.webContents.send('log-viewer:entry', entry)
      }
    })

    // Register IPC handlers
    ipcMain.removeHandler('log-viewer:open')
    ipcMain.handle('log-viewer:open', () => this.open())

    ipcMain.removeHandler('log-viewer:ready')
    ipcMain.handle('log-viewer:ready', () => {
      if (this.win && !this.win.isDestroyed()) {
        this.win.webContents.send('log-viewer:batch', logRing.toArray())
      }
    })

    ipcMain.removeHandler('log-viewer:get-theme')
    ipcMain.handle('log-viewer:get-theme', () => {
      return readPrefs().theme as string | undefined ?? null
    })

    ipcMain.removeHandler('log-viewer:set-theme')
    ipcMain.handle('log-viewer:set-theme', (_e, theme: string) => {
      const prefs = readPrefs()
      prefs.theme = theme
      writePrefs(prefs)
    })

    // Window controls for frameless window
    ipcMain.removeHandler('log-viewer:minimize')
    ipcMain.handle('log-viewer:minimize', () => {
      if (this.win && !this.win.isDestroyed()) this.win.minimize()
    })
    ipcMain.removeHandler('log-viewer:maximize')
    ipcMain.handle('log-viewer:maximize', () => {
      if (this.win && !this.win.isDestroyed()) {
        if (this.win.isMaximized()) this.win.unmaximize()
        else this.win.maximize()
      }
    })
    ipcMain.removeHandler('log-viewer:close')
    ipcMain.handle('log-viewer:close', () => {
      if (this.win && !this.win.isDestroyed()) this.win.close()
    })
  }

  open(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.focus()
      return
    }

    const isMac = process.platform === 'darwin'
    this.win = new BrowserWindow({
      width: 1100,
      height: 650,
      minWidth: 600,
      minHeight: 300,
      title: 'ClaudeUI Log Viewer',
      backgroundColor: '#0d1117',
      autoHideMenuBar: true,
      // Frameless window — match main window style
      ...(isMac
        ? {
            titleBarStyle: 'hiddenInset',
            trafficLightPosition: { x: 12, y: 10 },
            type: 'panel' // Don't show in taskbar as a separate app on macOS
          }
        : { frame: false }),
      webPreferences: {
        preload: join(__dirname, '../preload/log-viewer-preload.js'),
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false
      }
    })

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      this.win.loadURL(process.env['ELECTRON_RENDERER_URL'] + '/log-viewer.html')
    } else {
      this.win.loadFile(join(__dirname, '../renderer/log-viewer.html'))
    }

    this.win.on('closed', () => {
      this.win = null
    })
  }

  close(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.close()
      this.win = null
    }
  }

  destroy(): void {
    if (this.unsubLogger) {
      this.unsubLogger()
      this.unsubLogger = null
    }
    this.close()
  }
}

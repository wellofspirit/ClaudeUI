import { app, shell, BrowserWindow, ipcMain, Menu, clipboard } from 'electron'
import { join } from 'path'
import { execFileSync } from 'child_process'
import contextMenu from 'electron-context-menu'

// Inline @electron-toolkit/utils to avoid its top-level electron.app.isPackaged
// access which fails when Node resolves require('electron') to node_modules/electron
// (which exports a path string) instead of Electron's built-in module.
const is = { dev: !app.isPackaged }
const electronApp = {
  setAppUserModelId(id: string): void {
    if (process.platform === 'win32') app.setAppUserModelId(is.dev ? process.execPath : id)
  }
}
const optimizer = {
  watchWindowShortcuts(window: BrowserWindow): void {
    window.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      if (!is.dev) {
        if (input.code === 'KeyR' && (input.control || input.meta)) event.preventDefault()
      }
      // F12 or Cmd/Ctrl+Shift+I — toggle DevTools (allowed in prod too)
      if (
        input.code === 'F12' ||
        (input.code === 'KeyI' && input.shift && (input.control || input.meta))
      ) {
        if (window.webContents.isDevToolsOpened()) window.webContents.closeDevTools()
        else window.webContents.openDevTools({ mode: 'undocked' })
      }
    })
  }
}
import { registerSessionIpc } from './ipc/session.ipc'
import { registerTerminalIpc } from './ipc/terminal.ipc'
import { registerAutomationIpc } from './ipc/automation.ipc'
import { registerRemoteHandlers, registerRemoteVersionInfo } from './ipc/remote-handlers'
import { RemoteServer, getNetworkInterfaces } from './services/remote-server'
import { RemoteDispatcher } from './services/remote-dispatcher'
import { serviceSession } from './services/service-session'
import { authManager } from './services/auth-manager'
import { accountManager } from './services/account-manager'
import { claudeAuthProvider } from './auth/ClaudeAuthProvider'
import { opencodeServerManager } from './opencode/OpencodeServerManager'
import { crossEngineDispatcher } from './services/cross-engine-dispatcher'
import { PluginManager } from './services/plugin-manager'
import { LogViewer } from './services/log-viewer'
import { logger } from './services/logger'
import { stopAllClassifiers } from './services/auto-classifier'
import { getSdkVersion } from './services/claude-session'
import { registerMockupAssetScheme, registerMockupAssetHandler } from './services/mockup-protocol'
import { loadPersistedPrices } from './services/opencode-pricing'
import icon from '../../resources/icon.png?asset'

// Privileged scheme registration MUST happen before app.whenReady fires.
registerMockupAssetScheme()

// Prevent "nested session" error when launched from a Claude Code terminal
delete process.env.CLAUDECODE

// macOS GUI apps don't inherit login shell environment variables, so tools
// like node/bun aren't found and user-defined vars from .zprofile are missing.
// Spawn a login shell to capture the full environment.
if (process.platform === 'darwin') {
  try {
    const loginShell = process.env.SHELL || '/bin/zsh'
    // Use null-delimited output to handle values containing newlines
    const raw = execFileSync(loginShell, ['-lc', 'env -0'], {
      encoding: 'utf-8',
      timeout: 5000,
      maxBuffer: 10 * 1024 * 1024
    })
    // Keys we must never import from the login shell:
    // - DYLD_*: macOS SIP strips these from GUI apps for security. Re-injecting
    //   them breaks Electron's dylib loading and can prevent the app from starting.
    // - ELECTRON_RUN_AS_NODE, CLAUDECODE: managed by us at specific lifecycle points
    // - _, SHLVL, PWD, OLDPWD: shell-session artifacts, not meaningful here
    const skip = new Set(['_', 'SHLVL', 'PWD', 'OLDPWD', 'ELECTRON_RUN_AS_NODE', 'CLAUDECODE'])
    for (const entry of raw.split('\0')) {
      if (!entry) continue
      const eq = entry.indexOf('=')
      if (eq <= 0) continue
      const key = entry.slice(0, eq)
      if (skip.has(key) || key.startsWith('DYLD_')) continue
      process.env[key] = entry.slice(eq + 1)
    }
  } catch (err) {
    logger.warn('main', 'Failed to read login shell env, falling back to PATH only', err)
    // Fallback: at least fix PATH so node/bun are findable
    try {
      const loginShell = process.env.SHELL || '/bin/zsh'
      const pathResult = execFileSync(loginShell, ['-lc', 'echo $PATH'], {
        encoding: 'utf-8',
        timeout: 3000
      }).trim()
      if (pathResult) process.env.PATH = pathResult
    } catch {
      const extra = '/opt/homebrew/bin:/usr/local/bin:/usr/local/sbin'
      process.env.PATH = `${extra}:${process.env.PATH ?? ''}`
    }
  }
}

let logViewer: LogViewer

// Right-click context menu — provides spell-check suggestions in editable
// fields, standard cut/copy/paste/select-all, and a "Copy as Markdown"
// item for chat messages. The renderer's preload script primes
// `lastContextMarkdown` synchronously on every `contextmenu` event so the
// `prepend` callback below knows whether the cursor is over a message
// with a stashed markdown source.
let lastContextMarkdown: string | null = null
ipcMain.on('context-menu:set-markdown', (e, source: string | null) => {
  lastContextMarkdown = typeof source === 'string' ? source : null
  e.returnValue = true
})

contextMenu({
  showSearchWithGoogle: false,
  showInspectElement: is.dev,
  showLookUpSelection: true,
  showCopyImage: true,
  prepend: () => [
    {
      label: 'Copy as Markdown',
      visible: lastContextMarkdown !== null && lastContextMarkdown.length > 0,
      click: () => {
        if (lastContextMarkdown) clipboard.writeText(lastContextMarkdown)
      }
    }
  ]
})

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
      sandbox: false,
      webviewTag: true
    }
  })

  // Guard webview creation: only allow plugin views with the correct preload.
  // This prevents any XSS in the renderer from spawning arbitrary webviews.
  const pluginPreloadPath = join(__dirname, '../preload/plugin-preload.js')
  mainWindow.webContents.on('will-attach-webview', (_event, webPreferences, params) => {
    // Force security settings on all webviews
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true

    // Only allow our plugin preload
    webPreferences.preload = pluginPreloadPath

    // Only allow file:// URLs (plugin HTML files)
    if (params.src && !params.src.startsWith('file://')) {
      _event.preventDefault()
    }
  })

  // Renderer → main process log relay (so all logs go to one terminal + log viewer)
  ipcMain.on('log:relay', (_e, level: string, source: string, message: string) => {
    const logLevel = level as 'debug' | 'info' | 'warn' | 'error'
    if (logLevel === 'error') logger.error(source, message)
    else if (logLevel === 'warn') logger.warn(source, message)
    else if (logLevel === 'debug') logger.debug(source, message)
    else logger.info(source, message)
  })

  const sessionManager = registerSessionIpc(mainWindow)

  // Cross-engine dispatch (ADR-033 M2, opencode → Claude): thread the
  // caller-session lookup + dispatch function into OpencodeServerManager
  // from HERE rather than importing sessionManager/crossEngineDispatcher
  // inside opencode-hosted-tools.ts or OpencodeServerManager.ts directly —
  // either import would form a require-cycle (see the cycle note on
  // CallerSessionLookup in opencode-hosted-tools.ts). main/index.ts sits
  // above both cycles, so it's the one safe place to close the loop.
  opencodeServerManager.setCallerSessionLookup((sessionId) => {
    const session = sessionManager.get(sessionId)
    if (!session || session.engineId !== 'opencode') return undefined
    return {
      cwd: session.cwd,
      autonomyMode: session.getAutonomyMode?.() ?? 'default',
      emit: (channel, data) => session.emit(channel, data)
    }
  })
  opencodeServerManager.setDispatchAgent((req, ctx) => crossEngineDispatcher.dispatch(req, ctx))

  authManager.setWindow(mainWindow)
  accountManager.init(mainWindow)
  claudeAuthProvider.init(mainWindow)
  registerTerminalIpc(mainWindow)
  const automationManager = registerAutomationIpc(mainWindow)

  // Remote access server
  const remoteDispatcher = new RemoteDispatcher()
  const remoteServer = new RemoteServer(remoteDispatcher)
  remoteServer.setWindow(mainWindow)
  registerRemoteHandlers(remoteDispatcher, sessionManager, mainWindow)

  // Log viewer (standalone debug window) — init early so renderer console
  // capture starts before plugins load. Backend logs are captured from
  // process start via logRing in logger.ts.
  logViewer = new LogViewer(mainWindow)

  // Plugin system
  const pluginManager = new PluginManager({
    win: mainWindow,
    sessionManager,
    automationManager,
    remoteDispatcher
  })
  pluginManager.loadAll().catch((err) => {
    logger.error('main', `Plugin system load error: ${err}`)
  })

  for (const ch of ['plugin:list', 'plugin:reload', 'plugin:views', 'plugin:preload-path']) {
    ipcMain.removeHandler(ch)
  }
  ipcMain.handle('plugin:list', () => pluginManager.listPlugins())
  ipcMain.handle('plugin:reload', (_e, id: string) => pluginManager.reloadPlugin(id))
  ipcMain.handle('plugin:views', () => pluginManager.getViews())
  ipcMain.handle('plugin:preload-path', () => join(__dirname, '../preload/plugin-preload.js'))

  // Remote access IPC handlers
  for (const ch of ['remote:interfaces', 'remote:start', 'remote:stop', 'remote:status']) {
    ipcMain.removeHandler(ch)
  }
  ipcMain.handle('remote:interfaces', () => {
    return getNetworkInterfaces()
  })
  ipcMain.handle(
    'remote:start',
    async (_e, opts?: { port?: number; host?: string; tunnel?: boolean }) => {
      return await remoteServer.start(opts?.port ?? 0, opts?.host, { tunnel: opts?.tunnel })
    }
  )
  ipcMain.handle('remote:stop', () => {
    remoteServer.stop()
  })
  ipcMain.handle('remote:status', () => {
    return remoteServer.getStatus()
  })

  // Before-quit: give renderer a chance to prompt about active worktrees
  let quitConfirmed = false
  let quitTimeout: ReturnType<typeof setTimeout> | null = null

  app.on('before-quit', (e) => {
    logViewer.destroy()
    pluginManager.stopAll()
    automationManager.stopAll()
    remoteServer.stop()
    stopAllClassifiers()
    // Stop the service session (lightweight CLI subprocess for usage polling)
    serviceSession.stop()
    // Reap any shared opencode servers (Windows tree-kill) so opencode.exe
    // children don't orphan on quit. Idempotent — safe to run on every invocation.
    opencodeServerManager.dispose()
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

  // Close log viewer (and any other child windows) when the main window closes
  mainWindow.on('closed', () => {
    logViewer.close()
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

  // Serve mockup HTML + sibling assets via mockup-asset:// (per-mockup sub-origin).
  registerMockupAssetHandler()

  // ── About panel ────────────────────────────────────────────────────
  const rawVersion = app.getVersion() // from package.json "version"
  const appVersion = is.dev || rawVersion === '1.0.0' ? 'Local Build' : rawVersion
  const sdkVersion = getSdkVersion()
  const cliVersion = sdkVersion !== 'unknown' ? sdkVersion.replace(/^0\./, '2.') : 'unknown'

  app.setAboutPanelOptions({
    applicationName: 'ClaudeUI',
    applicationVersion: appVersion,
    version: `SDK ${sdkVersion} · CLI ${cliVersion}`,
    copyright: '© 2025 Daniel Liu',
    website: 'https://github.com/wellofspirit/ClaudeUI'
  })

  // ── Version info IPC (for Settings dialog) ─────────────────────────
  const versionInfo = { appVersion, sdkVersion, cliVersion }
  ipcMain.handle('app:version-info', () => versionInfo)
  // Mirror to the remote dispatcher so the web client's Settings dialog can
  // read the server's build versions.
  registerRemoteVersionInfo(versionInfo)

  // ── App menu (About panel + standard shortcuts) ────────────────────
  const isMac = process.platform === 'darwin'
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      // macOS app menu (About, Hide, Quit, etc.)
      ...(isMac
        ? [
            {
              label: app.name,
              submenu: [
                { role: 'about' as const },
                { type: 'separator' as const },
                { role: 'services' as const },
                { type: 'separator' as const },
                { role: 'hide' as const },
                { role: 'hideOthers' as const },
                { role: 'unhide' as const },
                { type: 'separator' as const },
                { role: 'quit' as const }
              ]
            }
          ]
        : []),
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
      {
        role: 'help',
        submenu: [
          {
            label: 'Open Log Viewer',
            accelerator: isMac ? 'Cmd+Shift+L' : 'Ctrl+Shift+L',
            click: () => logViewer.open()
          },
          { type: 'separator' as const },
          // On Windows/Linux, About lives here; on macOS it's in the app menu
          // but having it in Help too doesn't hurt.
          { role: 'about' }
        ]
      }
    ])
  )

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Phase 9b: register any previously-fetched opencode pricing entries so
  // equivalentCostUsd resolves opencode model costs from the very first recalc.
  // No server spin-up — reads the persisted ~/.claude/ui/opencode-prices.json if present.
  loadPersistedPrices()

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

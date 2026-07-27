import { app, shell, BrowserWindow, ipcMain, Menu, clipboard, crashReporter, dialog } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
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
import { credentialSync } from './auth/vault/CredentialSync'
import { sharedProviderService } from './shared-providers'
import { opencodeServerManager } from './opencode/OpencodeServerManager'
import { crossEngineDispatcher } from './services/cross-engine-dispatcher'
import { PluginManager } from './services/plugin-manager'
import { LogViewer } from './services/log-viewer'
import { logger } from './services/logger'
import { getSdkVersion } from './services/claude-session'
import { registerMockupAssetScheme, registerMockupAssetHandler } from './services/mockup-protocol'
import { loadPersistedPrices } from './services/opencode-pricing'
import { QuitCoordinator } from './quit-coordinator'
import {
  isAllowedExternalUrl,
  isInAppNavigation,
  isAllowedWebviewNavigation,
  buildVscodeUrl,
  type AppOrigin
} from './shell-security'
import icon from '../../resources/icon.png?asset'

// Single-instance lock (M-BT1). A second launch must NOT run a full second
// instance: both would write ~/.claude/ui/*.json (last-writer-wins corruption),
// both would run watchers/pollers, and services would be duplicated. Acquire the
// lock before constructing any window or service. If another instance already
// owns it, quit immediately — the primary focuses itself via 'second-instance'
// below. All window/service construction (createWindow, whenReady) is gated on
// this flag so the doomed instance does effectively nothing.
//
// Production default is single-instance. Dev (`bun run dev`) and the verifier
// (scripts/app-shot.mjs sets CLAUDEUI_ALLOW_MULTIPLE_INSTANCES=1) opt out so a
// built app and a dev/verifier instance can run side by side. When enforcement
// is off, gotSingleInstanceLock stays true so all the gating below runs normally
// — this exempts only dev/verifier, not a real user's accidental double-launch.
const enforceSingleInstance = !is.dev && process.env.CLAUDEUI_ALLOW_MULTIPLE_INSTANCES !== '1'
const gotSingleInstanceLock = enforceSingleInstance ? app.requestSingleInstanceLock() : true
if (!gotSingleInstanceLock) {
  app.quit()
}

// Crashpad must be started before app.whenReady resolves, otherwise a hard
// crash (V8 heap exhaustion, native abort) leaves no artefact at all: those
// aborts are not JS exceptions, so the `uncaughtException` handler at the
// bottom of this file never fires. Local-only — nothing is ever uploaded;
// dumps land in `app.getPath('crashDumps')`.
crashReporter.start({ uploadToServer: false })

// Privileged scheme registration MUST happen before app.whenReady fires.
registerMockupAssetScheme()

// Prevent "nested session" error when launched from a Claude Code terminal
delete process.env.CLAUDECODE

// macOS GUI apps don't inherit login shell environment variables, so tools
// like node/bun aren't found and user-defined vars from .zprofile are missing.
// Spawn a login shell to capture the full environment.
// Skipped in a doomed second instance — no point paying the (up to 5s) spawn.
if (gotSingleInstanceLock && process.platform === 'darwin') {
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

// Process-lifetime references to window-lifetime constructs. Hoisted to module
// scope so (a) the single before-quit teardown reaches the LIVE services, (b) a
// macOS `activate` re-create can stop/replace the previous ones instead of
// leaking them, and (c) 'second-instance' can focus the current window.
// TODO(audit): services are still *constructed* inside the window-lifetime
// createWindow — this is idempotency hardening (R5), not the full move to
// whenReady/process-lifetime ownership.
let logViewer: LogViewer | undefined
let currentWindow: BrowserWindow | undefined
let currentRemoteServer: RemoteServer | undefined
let currentPluginManager: PluginManager | undefined
let currentAutomationManager: ReturnType<typeof registerAutomationIpc> | undefined
let quitCoordinator: QuitCoordinator | undefined

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
  currentWindow = mainWindow

  // Navigation guard (H4). The main window runs a full-privilege preload
  // (`window.api`) with sandbox:false. Without this, any top-frame navigation —
  // a dropped URL/.html, a script-set `location`, a webview navigating the top
  // frame — would load a FOREIGN document in this webContents with the preload
  // still attached, handing that origin createTerminal(cwd), session:create, etc.
  // The app is a SPA: legitimate routing is same-document (hash) and never fires
  // will-navigate, so any top-frame navigation off the app origin is hostile.
  const appOrigin: AppOrigin =
    is.dev && process.env['ELECTRON_RENDERER_URL']
      ? { mode: 'dev-origin', origin: new URL(process.env['ELECTRON_RENDERER_URL']).origin }
      : {
          mode: 'file-prefix',
          // pathToFileURL handles Windows drive letters + percent-encoding; force a
          // trailing slash so a sibling like `renderer-evil/` can't match the prefix.
          prefix: pathToFileURL(join(__dirname, '../renderer')).href.replace(/\/?$/, '/')
        }
  const blockForeignNavigation = (details: { url: string; preventDefault: () => void }): void => {
    if (!isInAppNavigation(details.url, appOrigin)) {
      details.preventDefault()
      logger.warn('main', `Blocked navigation away from app origin: ${details.url}`)
    }
  }
  mainWindow.webContents.on('will-navigate', (details) => blockForeignNavigation(details))
  mainWindow.webContents.on('will-frame-navigate', (details) => {
    // Only the top frame carries the privileged preload. Sub-frames (e.g. the
    // mockup-asset:// preview iframes) get no preload and are origin-isolated,
    // so their navigations are ordinary web navigations and must not be blocked.
    if (details.isMainFrame) blockForeignNavigation(details)
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

  // xhigh#4: re-validate webview navigation, not just attachment. plugin-preload
  // derives its pluginId from the page's query param at preload time, so a plugin
  // page navigated to remote content would keep the plugin preload and could
  // present a different pluginId. Block any navigation/redirect away from a
  // file:// plugin origin.
  mainWindow.webContents.on('did-attach-webview', (_e, webviewContents) => {
    const guardWebview = (details: { url: string; preventDefault: () => void }): void => {
      if (!isAllowedWebviewNavigation(details.url)) {
        details.preventDefault()
        logger.warn('main', `Blocked plugin webview navigation to non-file origin: ${details.url}`)
      }
    }
    webviewContents.on('will-navigate', (details) => guardWebview(details))
    webviewContents.on('will-frame-navigate', (details) => guardWebview(details))
    webviewContents.on('will-redirect', (details) => guardWebview(details))
  })

  // Renderer → main process log relay (so all logs go to one terminal + log viewer)
  // removeAllListeners first so a macOS `activate` re-create doesn't stack a new
  // listener on top of the old one (mirrors the log:error dedupe below).
  ipcMain.removeAllListeners('log:relay')
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
      emit: (channel, data) => session.emit(channel, data),
      addDispatchedCost: (engineId, modelId, costUsd) =>
        session.addDispatchedCost(engineId, modelId, costUsd)
    }
  })
  opencodeServerManager.setDispatchAgent((req, ctx) => crossEngineDispatcher.dispatch(req, ctx))

  authManager.setWindow(mainWindow)
  accountManager.init(mainWindow)
  claudeAuthProvider.init(mainWindow)
  // Reconcile central credentials first, then materialize all shared-provider
  // routes. Both are best-effort and must never block app startup.
  void (async () => {
    try {
      await credentialSync.start()
    } catch (err) {
      logger.warn(
        'main',
        `credentialSync.start() failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`
      )
    }
    try {
      await sharedProviderService.syncAll()
    } catch (err) {
      logger.warn(
        'main',
        `sharedProviderService.syncAll() failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`
      )
    }
  })()
  registerTerminalIpc(mainWindow)
  // Stop the previous automation manager (macOS re-create) before replacing it,
  // then hoist so the single before-quit teardown reaches the live instance.
  currentAutomationManager?.stopAll()
  const automationManager = registerAutomationIpc(mainWindow)
  currentAutomationManager = automationManager

  // Remote access server. Stop any previous server first (macOS re-create) so it
  // doesn't keep listening on its old port with its stale token / RemoteBridge.
  currentRemoteServer?.stop()
  const remoteDispatcher = new RemoteDispatcher()
  const remoteServer = new RemoteServer(remoteDispatcher)
  currentRemoteServer = remoteServer
  remoteServer.setWindow(mainWindow)
  registerRemoteHandlers(remoteDispatcher, sessionManager, mainWindow)

  // Log viewer (standalone debug window) — init early so renderer console
  // capture starts before plugins load. Backend logs are captured from
  // process start via logRing in logger.ts. Destroy the previous instance first
  // (macOS re-create) so its logger subscription doesn't leak.
  logViewer?.destroy()
  logViewer = new LogViewer(mainWindow)

  // Plugin system. Stop the previous manager (macOS re-create) before replacing
  // it, then hoist so the single before-quit teardown reaches the live instance.
  currentPluginManager?.stopAll()
  const pluginManager = new PluginManager({
    win: mainWindow,
    sessionManager,
    automationManager,
    remoteDispatcher
  })
  currentPluginManager = pluginManager
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

  // Before-quit: give the renderer a chance to prompt about active worktrees.
  // The coordinator + its listener are created exactly ONCE (macOS `activate`
  // may call createWindow again). Its dependency closures read the module-level
  // service refs, so the single listener always tears down the LIVE services —
  // and only on the real quit, never on a cancelled first pass (the verified bug
  // this fixes: services were destroyed on the first, possibly-cancelled pass,
  // and cancel still force-quit ~5s later because there was no cancel path).
  if (!quitCoordinator) {
    quitCoordinator = new QuitCoordinator({
      notifyRenderer: () => {
        if (currentWindow && !currentWindow.isDestroyed()) {
          currentWindow.webContents.send('app:before-quit')
        }
      },
      teardownServices: () => {
        logViewer?.destroy()
        currentPluginManager?.stopAll()
        currentAutomationManager?.stopAll()
        credentialSync.stop()
        currentRemoteServer?.stop()
        // Stop the service session (lightweight CLI subprocess for usage polling)
        serviceSession.stop()
        // Reap any shared opencode servers (Windows tree-kill) so opencode.exe
        // children don't orphan on quit. Idempotent — safe to run on every invocation.
        opencodeServerManager.dispose()
      },
      quit: () => app.quit()
    })
    app.on('before-quit', (e) => {
      quitCoordinator!.handleBeforeQuit(() => e.preventDefault())
    })
  }

  // Renderer confirmed the quit prompt (Keep-all / Remove-all). Re-registered per
  // window with the same removeHandler dedupe used elsewhere; delegates to the
  // single module-level coordinator.
  ipcMain.removeHandler('app:quit-confirm')
  ipcMain.handle('app:quit-confirm', () => quitCoordinator?.confirm())
  // Renderer cancelled the quit prompt: clear the fallback timer and leave the
  // services untouched (they were never torn down on the first pass).
  ipcMain.removeHandler('app:quit-cancel')
  ipcMain.handle('app:quit-cancel', () => quitCoordinator?.cancel())

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
    // vscode:// is a fixed, app-initiated scheme, but the cwd is caller-supplied:
    // validate/normalise it so a malicious cwd can't inject a second URL or a
    // query/fragment into the interpolation.
    const url = buildVscodeUrl(cwd)
    if (!url) {
      logger.warn('main', `Refused open-in-vscode for unsafe cwd: ${JSON.stringify(cwd)}`)
      return
    }
    void shell.openExternal(url)
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
    logViewer?.close()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    // Scheme allowlist (R2): only web + mail links may reach the OS. Anything
    // else (file:, javascript:, custom program-launching schemes) is refused —
    // one non-markdown link away from file:///C:/…exe otherwise.
    if (isAllowedExternalUrl(details.url)) {
      void shell.openExternal(details.url)
    } else {
      logger.warn('main', `Blocked openExternal for disallowed scheme: ${details.url}`)
    }
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

// Focus the existing window if a second instance is launched (M-BT1). The second
// instance quits itself (see requestSingleInstanceLock above); this fires in the
// PRIMARY so the user's re-launch surfaces the already-running window.
if (gotSingleInstanceLock) {
  app.on('second-instance', () => {
    if (!currentWindow || currentWindow.isDestroyed()) return
    if (currentWindow.isMinimized()) currentWindow.restore()
    currentWindow.show()
    currentWindow.focus()
  })
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // A doomed second instance has already called app.quit() above — do not build
  // the menu, construct services, or create a window (M-BT1).
  if (!gotSingleInstanceLock) return

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
            click: () => logViewer?.open()
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

// Global error handlers — catch anything that slips through.
//
// Deliberate choice: we do NOT force-quit on an uncaught exception. A desktop
// app that hard-exits mid-operation loses in-flight user work (unsaved edits,
// running turns) and, given how much of the process is independent (multiple
// engines, git/pty/usage services), one subsystem throwing rarely corrupts the
// others. But swallowing silently is also wrong — the process may now be in an
// inconsistent state — so we (a) log at error with an explicit unstable-state
// flag (surfaced in-app via the log viewer) and (b) surface ONCE to the user
// with a dialog so it isn't invisible. The once-guard prevents a dialog storm
// if the same fault re-fires.
let unexpectedErrorSurfaced = false
function surfaceUnexpectedError(kind: string, detail: unknown): void {
  logger.error(
    'process',
    `${kind} — process may be in an inconsistent state (not exiting; see stack)`,
    detail
  )
  if (unexpectedErrorSurfaced) return
  unexpectedErrorSurfaced = true
  try {
    const message = detail instanceof Error ? detail.message : String(detail)
    dialog.showErrorBox(
      'ClaudeUI hit an unexpected error',
      `${kind}:\n${message}\n\nThe app is still running but may be unstable — consider restarting. ` +
        `Full details are in the log viewer.`
    )
  } catch {
    /* dialog can fail very early in startup or on headless CI — logging above is enough */
  }
}
process.on('uncaughtException', (err) => {
  surfaceUnexpectedError('Uncaught exception', err)
})
process.on('unhandledRejection', (reason) => {
  surfaceUnexpectedError('Unhandled rejection', reason)
})

// Process-level crashes never surface as JS exceptions — without these the app
// window simply disappears with nothing in the log.
app.on('render-process-gone', (_e, contents, details) => {
  logger.error(
    'process',
    `Renderer process gone (reason=${details.reason}, exitCode=${details.exitCode}, url=${
      contents.isDestroyed() ? '<destroyed>' : contents.getURL()
    })`
  )
})
app.on('child-process-gone', (_e, details) => {
  logger.error(
    'process',
    `Child process gone (type=${details.type}, reason=${details.reason}, exitCode=${details.exitCode}, name=${details.name ?? 'n/a'}, serviceName=${details.serviceName ?? 'n/a'})`
  )
})

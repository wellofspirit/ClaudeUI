import {
  app,
  shell,
  screen,
  BrowserWindow,
  ipcMain,
  Menu,
  clipboard,
  crashReporter,
  dialog
} from 'electron'
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
import { bootCore, type CoreBoot } from './boot-core'
import { setHostWindow, getHostWindow } from '../core/services/host-window'
import { attachSyncPort } from './services/sync-port'
import { terminalService } from '../core/services/terminal-service'
import { registerRemoteVersionInfo } from '../core/ipc/remote-handlers'
import { serviceSession } from '../core/services/service-session'
import { authManager } from './services/auth-manager'
import { accountManager } from './services/account-manager'
import { claudeAuthProvider } from './auth/ClaudeAuthProvider'
import { credentialSync } from '../core/auth/vault/CredentialSync'
import { opencodeServerManager } from '../core/opencode/OpencodeServerManager'
import { PluginManager } from './services/plugin-manager'
import { LogViewer } from './services/log-viewer'
import { logger } from '../core/services/logger'
import { getCliVersion } from '../core/services/claude-session'
import { registerMockupAssetScheme, registerMockupAssetHandler } from './services/mockup-protocol'
import { loadPersistedPrices } from '../core/services/opencode-pricing'
import { QuitCoordinator } from './quit-coordinator'
import {
  isAllowedExternalUrl,
  isInAppNavigation,
  isAllowedWebviewNavigation,
  buildVscodeUrl,
  validateLocalFilePath,
  type AppOrigin
} from '../core/shell-security'
import { readImagePreview } from '../core/sent-file-security'
import { setHostPaths } from '../core/host'
import { setSqliteDriver } from '../core/services/sqlite-driver'
import { betterSqlite3Driver } from '../core/services/sqlite/better-sqlite3-driver'
import icon from '../../resources/icon.png?asset'

// The DESKTOP's storage engine (S3 stage 1). `db.ts` talks to a driver seam now
// — it names no SQLite implementation — so this is where the app declares that
// it uses the native better-sqlite3, exactly as it always has. Behaviour is
// unchanged; what changed is that the choice is now stated rather than implied
// by an import, which is what lets `claudeui-server` state a different one.
//
// Wired at module load, before `setHostPaths` and long before `bootCore()`, for
// the same reason that one is: the DB is opened lazily on first use, and no code
// path may reach it while the seam is empty. `better-sqlite3` stays in
// `electron.vite.config.ts`'s `external` list, so the main bundle is untouched.
setSqliteDriver(betterSqlite3Driver())

// Desktop implementation of the core `HostPaths` seam (S2). Wired at module
// load — as early as the desktop entrypoint runs, before any window decision or
// engine spawn — so no core module (engine locators, the web-client dir) can
// observe an unset provider on the spawn/serve path. A non-Electron entrypoint
// wires its own (or none; core falls back to `process.cwd()`).
setHostPaths({ getAppPath: () => app.getAppPath() })

// Single-instance lock (M-BT1). A second launch must NOT run a full second
// instance: both would write ~/.claude/ui/*.json (last-writer-wins corruption),
// both would run watchers/pollers, and services would be duplicated. Acquire the
// lock before constructing any window or service. If another instance already
// owns it, quit immediately — the primary focuses itself via 'second-instance'
// below. All window/service construction (createWindow, whenReady) is gated on
// this flag so the doomed instance does effectively nothing.
//
// Production default is single-instance. Dev (`bun run dev`) and the verifier
// (scripts/app-shot.mjs launches an unpackaged Electron, so `is.dev` is true)
// are exempt so a built app and a dev/verifier instance can run side by side;
// CLAUDEUI_ALLOW_MULTIPLE_INSTANCES=1 opts a packaged build out. When enforcement
// is off, gotSingleInstanceLock stays true so all the gating below runs normally
// — this exempts only dev/verifier, not a real user's accidental double-launch.
const enforceSingleInstance = !is.dev && process.env.CLAUDEUI_ALLOW_MULTIPLE_INSTANCES !== '1'
const gotSingleInstanceLock = enforceSingleInstance ? app.requestSingleInstanceLock() : true
if (!gotSingleInstanceLock) {
  app.quit()
}

// Remote-access kill switch for SECONDARY instances (Playwright verifier via
// scripts/app-shot.mjs, evals, any harness launched alongside a live app). The
// remote listener owns machine-global state — a pinned TCP port and, with TLS,
// the host's `tailscale serve` config — none of which is per-instance. A second
// instance would reconcile the PRIMARY instance's live serve record as a leaked
// leftover and tear it down, then autostart and steal the port (or lose an
// EADDRINUSE race), and finally disable `tailscale serve` on quit. So a harness
// instance must never reconcile, start, or force-reserve. Off by default:
// only an explicit env var / CLI switch opts in.
const remoteAccessDisabled =
  process.env.CLAUDEUI_DISABLE_REMOTE === '1' || process.argv.includes('--disable-remote')

// "Headless" mode for harness/eval instances (scripts/app-shot.mjs, evals): the
// window must render without taking focus or a taskbar slot. A TRULY hidden
// window is not an option — a hide()-den window produces no compositor frames,
// so Playwright's page.screenshot() times out, webContents.capturePage() never
// resolves, and clicks fail actionability. So "headless" here means shown but
// inactive and positioned beyond the virtual desktop: it still paints, it just
// isn't visible or focusable.
//
// The switch is deliberately NOT called `--headless`: Electron forwards unknown
// argv switches to Chromium, and `--headless` is a real Chromium switch that
// would put the whole app into browser headless mode and break it.
const headlessWindow =
  process.env.CLAUDEUI_HEADLESS === '1' || process.argv.includes('--claudeui-headless')

// WINDOWLESS mode (SyncCore phase 4d): boot core and serve, with no BrowserWindow
// at all. This is the phase-4 exit criterion — canonical state, the remote HTTP+WS
// server, session spawning and the event fan-out must not depend on a renderer
// existing — and it is the shape the future headless `claudeui-server` deployment
// runs in (docs/architecture/sync-core.md §Topology).
//
// Distinct from `headlessWindow` above, which still MAKES a window (off-screen, so
// Playwright can screenshot it) — that one is a harness affordance, this one is a
// deployment mode. No window means no window chrome, no tray, no menu decisions,
// no plugins and no log-viewer window: `createWindow()` is simply never called.
const noWindowMode = process.env.CLAUDEUI_NO_WINDOW === '1' || process.argv.includes('--no-window')

if (headlessWindow) {
  // Chromium's occlusion tracker treats an off-screen window as occluded and
  // stops producing frames for it — screenshots would hang exactly as with a
  // hidden window. The first switch is the load-bearing one; the other two keep
  // timers/rAF running at foreground cadence so Playwright's actionability
  // checks (which wait for a stable box) resolve instead of timing out.
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  app.commandLine.appendSwitch('disable-background-timer-throttling')
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

// Process-lifetime state.
//
// `core` is the window-independent service graph, constructed ONCE in
// `app.whenReady()` before any window decision (SyncCore phase 4d) — which is
// what retired the standing `TODO(audit)` here: services are no longer
// constructed inside the window-lifetime `createWindow`, so a macOS `activate`
// re-create no longer rebuilds the SessionManager (and orphans every live
// session) either. What remains window-lifetime is genuinely window-shaped: the
// log viewer, the plugin host and the window itself.
let core: CoreBoot | undefined
let logViewer: LogViewer | undefined
let currentWindow: BrowserWindow | undefined
let currentPluginManager: PluginManager | undefined
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

/**
 * Create the host window and attach it to the already-booted core.
 *
 * ADDITIVE by construction (SyncCore phase 4d): everything in here is either
 * window chrome, a host-local delivery target, or a surface that only exists
 * because a renderer does (the sync port, the plugin host, the log viewer). Core
 * — sessions, canonical state, the remote server, watchers — is already running
 * when this is called, and a windowless boot never calls it at all.
 */
function createWindow(): void {
  const boot = core
  if (!boot) throw new Error('createWindow() called before bootCore()')
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
    // Headless harness instances must not claim a taskbar slot either.
    ...(headlessWindow ? { skipTaskbar: true } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      webviewTag: true
    }
  })
  currentWindow = mainWindow
  // SyncCore phase 4a: publish the host's primary window. As of 4c it is the
  // target for HOST-LOCAL channels only (window chrome, voice, native pickers,
  // PTY bytes) — replicated events no longer know what a window is; as of 4d it
  // lives in `services/host-window.ts`, read at use time by everything that wants
  // it, so core could be registered before this window existed.
  setHostWindow(mainWindow)
  // SyncCore phase 4c: the renderer becomes client #1. Hands it a MessagePort on
  // every load and answers its `sync` frames from the ring/canonical state,
  // exactly as the WebSocket server answers a phone's.
  attachSyncPort(mainWindow)

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

  // Attach the window to the already-booted core (SyncCore phase 4d).
  //
  // AuthManager.setWindow resets the login-success subscribers per window
  // generation and the two `init` calls re-register them (C-6), so the trio runs
  // as a unit here even though core already ran it once with no window.
  authManager.setWindow(mainWindow)
  accountManager.init(mainWindow)
  claudeAuthProvider.init(mainWindow)

  // Where the desktop's own `terminal:data` / `terminal:exit` frames go — and, on
  // that window's `closed`, the shell teardown. The pty manager itself is
  // process-lifetime and shared with the remote transport (phase 2 multi-attach).
  terminalService.setWindow(mainWindow)

  // The one host-local channel the remote server raises (`remote:status`).
  boot.remoteServer.setWindow(mainWindow)

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
    sessionManager: boot.sessionManager,
    automationManager: boot.automationManager,
    remoteDispatcher: boot.remoteDispatcher
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

  // Renderer error logging → main process log file
  ipcMain.removeAllListeners('log:error')
  ipcMain.on('log:error', (_e, source: string, message: string) => {
    logger.error(`renderer/${source}`, message)
  })

  // Window control IPC handlers (for frameless windows on Windows/Linux)
  for (const ch of [
    'window:minimize',
    'window:maximize',
    'window:close',
    'app:open-in-vscode',
    'shell:open-path',
    'shell:show-in-folder',
    'file:sent-file-preview'
  ]) {
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

  // Open / reveal a local file handed to the user by the SendUserFile tool.
  // The path is model-controlled, so validateLocalFilePath narrows it to an
  // existing, non-UNC, absolute regular file before it reaches the OS shell.
  // Deliberately NOT registered on the remote dispatcher: opening a file
  // happens on the DESKTOP host, which a remote client cannot see.
  ipcMain.handle('shell:open-path', async (_e, filePath: string) => {
    const check = validateLocalFilePath(filePath)
    if (!check.ok) {
      logger.warn('main', `Refused shell:open-path (${check.error}): ${JSON.stringify(filePath)}`)
      return { error: check.error }
    }
    // openPath resolves with '' on success and an error STRING on failure.
    const error = await shell.openPath(check.path)
    return error ? { error } : {}
  })
  ipcMain.handle('shell:show-in-folder', (_e, filePath: string) => {
    const check = validateLocalFilePath(filePath)
    if (!check.ok) {
      logger.warn(
        'main',
        `Refused shell:show-in-folder (${check.error}): ${JSON.stringify(filePath)}`
      )
      return { error: check.error }
    }
    shell.showItemInFolder(check.path)
    return {}
  })

  // Inline image preview for a delivered file. Same threat model as the shell
  // handlers (model-controlled path), plus two extra narrowings enforced in
  // sent-file-security: an image-extension allowlist (HTML/PDF are never
  // rendered) and a size cap checked by stat BEFORE the read. Like the shell
  // handlers this is desktop-only — the remote client builds an authenticated
  // `/sent-file?...&inline=1` URL instead of round-tripping bytes over the WS.
  ipcMain.handle('file:sent-file-preview', (_e, filePath: string) => {
    const result = readImagePreview(filePath)
    if ('error' in result) {
      logger.warn(
        'main',
        `Refused file:sent-file-preview (${result.error}): ${JSON.stringify(filePath)}`
      )
    }
    return result
  })

  // Send maximize/unmaximize state changes to renderer
  mainWindow.on('maximize', () => {
    mainWindow.webContents.send('window:maximized-change', true)
  })
  mainWindow.on('unmaximize', () => {
    mainWindow.webContents.send('window:maximized-change', false)
  })

  mainWindow.on('ready-to-show', () => {
    if (headlessWindow) {
      // Move beyond the virtual desktop BEFORE showing, so the window never
      // flashes on a real monitor. Never hardcode negative coords — a secondary
      // display can sit at negative x — derive the right edge from the layout.
      // showInactive() keeps frames flowing (unlike hide()) but does not
      // activate, so focus stays where the user left it; a late blur() does not
      // reliably undo an activating show().
      const right = Math.max(...screen.getAllDisplays().map((d) => d.bounds.x + d.bounds.width))
      mainWindow.setPosition(right + 64, 64)
      mainWindow.showInactive()
      // Belt-and-braces alongside the occlusion command-line switch: never let
      // this webContents throttle rAF/timers just because it's off-screen.
      mainWindow.webContents.setBackgroundThrottling(false)
    } else {
      mainWindow.show()
    }
  })

  // Close log viewer (and any other child windows) when the main window closes
  mainWindow.on('closed', () => {
    logViewer?.close()
    // Un-publish the host handle: after this point there IS no host window (macOS
    // keeps the process alive with none), and every reader copes with null. Leaving
    // a destroyed window published would hand it to the next session spawn or a
    // native dialog. Guarded so a macOS `activate` that already published a
    // replacement is not clobbered by the old window's late `closed`.
    if (getHostWindow() === mainWindow) setHostWindow(null)
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
  const cliVersion = getCliVersion()

  app.setAboutPanelOptions({
    applicationName: 'ClaudeUI',
    applicationVersion: appVersion,
    version: `CLI ${cliVersion}`,
    copyright: '© 2025 Daniel Liu',
    website: 'https://github.com/wellofspirit/ClaudeUI'
  })

  // ── Version info IPC (for Settings dialog) ─────────────────────────
  const versionInfo = { appVersion, cliVersion }
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

  // ── Core, BEFORE any window decision (SyncCore phase 4d) ───────────
  // Sessions, canonical state, the remote HTTP+WS server, watchers, seeds. None
  // of it needs a window; `createWindow()` below only attaches to it.
  core = bootCore({ remoteAccessDisabled })

  // Before-quit: give the renderer (if there is one) a chance to prompt about
  // active worktrees, then tear the services down. Process-lifetime — it moved
  // out of `createWindow` in 4d, because a windowless run still has services to
  // stop, and because "created exactly once" is a property of whenReady rather
  // than a `if (!quitCoordinator)` guard against re-entry.
  //
  // Only on the real quit, never on a cancelled first pass (the verified bug this
  // fixes: services were destroyed on the first, possibly-cancelled pass, and
  // cancel still force-quit ~5s later because there was no cancel path).
  quitCoordinator = new QuitCoordinator({
    notifyRenderer: () => {
      if (currentWindow && !currentWindow.isDestroyed()) {
        currentWindow.webContents.send('app:before-quit')
      }
    },
    teardownServices: () => {
      logViewer?.destroy()
      currentPluginManager?.stopAll()
      core?.automationManager.stopAll()
      credentialSync.stop()
      void core?.remoteServer.stop()
      // Stop the service session (lightweight CLI subprocess for usage polling)
      serviceSession.stop()
      // Reap any shared opencode servers (Windows tree-kill) so opencode.exe
      // children don't orphan on quit. Idempotent — safe to run on every invocation.
      opencodeServerManager.dispose()
    },
    quit: () => app.quit(),
    // The first before-quit pass asks the renderer about active worktrees and waits.
    // Windowless there is nobody to ask — and no UI decision to make — so collapse
    // the wait instead of stalling a headless shutdown for the full fallback.
    ...(noWindowMode ? { fallbackMs: 0 } : {})
  })
  app.on('before-quit', (e) => {
    quitCoordinator!.handleBeforeQuit(() => e.preventDefault())
  })
  // Renderer confirmed / cancelled the quit prompt; delegates to the single
  // coordinator. Registered here rather than per window for the same reason.
  ipcMain.handle('app:quit-confirm', () => quitCoordinator?.confirm())
  ipcMain.handle('app:quit-cancel', () => quitCoordinator?.cancel())

  if (noWindowMode) {
    logger.info(
      'main',
      'CLAUDEUI_NO_WINDOW — running windowless: no BrowserWindow, no plugins, no log-viewer window. ' +
        'Remote clients are the only clients.'
    )
    return
  }

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
  // Windowless mode never has a window to close, so this should not fire at all —
  // but a transient child window (a future dialog, a devtools detach) closing must
  // not be able to kill a headless server. Explicit, because "it can't happen" is
  // exactly what made no-window an untested state before 4d.
  if (noWindowMode) return
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

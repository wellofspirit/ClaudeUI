// Launching the built ClaudeUI under Playwright for the chat-scroll bench, in one of two modes:
//
// - ISOLATED (default): Electron's own `-r <shim>` patches `os.homedir()` to a scratch home (the
//   recipe from scripts/codex-render-stress.mjs — Electron ignores NODE_OPTIONS, and rewriting
//   USERPROFILE breaks crashpad). CLAUDE_CONFIG_DIR points the spawned cli.js at the same
//   scratch `.claude`, so a fake-endpoint turn writes its transcript there and finds no
//   credentials. Nothing of the real profile is read or written by the main process.
// - REAL profile (`real: true`): no shim — only for live model turns, which must use the user's
//   own sign-in in place (never a copied credential file).
//
// Both suppress remote access (CLAUDEUI_DISABLE_REMOTE=1: a second instance must never touch the
// machine-global tailscale/port state) and enable the verifier hooks. The electron PID is kept so
// teardown only ever kills the process this module started.
//
// ISOLATED launches also get their own Chromium `--user-data-dir` inside the scratch home (so
// localStorage never mixes with a dev profile), and an environment with every inherited model
// credential / endpoint variable REMOVED (names only are reported, never values): a scratch run
// must not be able to reach a real model with an inherited key.
//
// `app` is the checkout whose BUILT app is launched (its out/main + vendor/): the main repo by
// default, or another worktree via the bench's --app.
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MOBILE_PROFILES } from '../mobile-profiles.mjs'
import { installPageBench } from './page.mjs'
import { SEL, sleep } from './common.mjs'

const HOME_SHIM = `// Electron preload (-r) written by scripts/scroll-bench.mjs: every os.homedir() in the
// main process lands in the scratch home. Child processes still inherit the real USERPROFILE.
const os = require('node:os')
const home = process.env.CLAUDEUI_TEST_HOME
if (home) os.homedir = () => home
`

/** Variables an isolated launch must not inherit. Matched by name; values are never read. */
const CREDENTIAL_ENV = [
  /^ANTHROPIC_/i,
  /^CLAUDE_CODE_OAUTH/i,
  /^CLAUDE_CODE_USE_(BEDROCK|VERTEX)/i,
  /^AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|BEARER_TOKEN_BEDROCK)$/i,
  /^GOOGLE_APPLICATION_CREDENTIALS$/i,
  /^OPENAI_/i,
  /^OPENROUTER_/i,
  /(_API_KEY|_AUTH_TOKEN|_OAUTH_TOKEN|_ACCESS_TOKEN|_SECRET|_SECRET_KEY)$/i
]

/** Delete credential-shaped variables in place; returns the removed NAMES. */
export function stripCredentialEnv(env) {
  const removed = []
  for (const k of Object.keys(env))
    if (CREDENTIAL_ENV.some((re) => re.test(k))) {
      delete env[k]
      removed.push(k)
    }
  return removed
}

export function prepareHome(home) {
  for (const dir of ['.claude/projects', '.claude/ui/logs', '.codex'])
    mkdirSync(join(home, dir), { recursive: true })
  const shim = join(home, 'home-shim.cjs')
  writeFileSync(shim, HOME_SHIM)
  return shim
}

/**
 * @returns {Promise<{ app, win, cdp, pid, close: () => Promise<void>, consoleErrors: string[] }>}
 */
export async function launchApp({
  app: appDir,
  home,
  real = false,
  headed = false,
  profile,
  extraEnv = {},
  smoothScrolling = true,
  windowSize = { width: 1100, height: 750 }
}) {
  const { _electron: electron } = await import('playwright')
  const env = { ...process.env }
  const strippedEnv = real ? [] : stripCredentialEnv(env)
  Object.assign(env, extraEnv)
  env.CLAUDEUI_DISABLE_REMOTE = '1'
  env.CLAUDEUI_VERIFIER_HOOKS = '1'
  if (headed) delete env.CLAUDEUI_HEADLESS
  else env.CLAUDEUI_HEADLESS = '1'
  // Chromium switches go before the app path.
  // Chromium follows the OS "animate controls" setting for smooth scrolling, and a Remote
  // Desktop session turns it OFF: programmatic `behavior: 'smooth'` then jumps in one frame, so
  // the code paths under test (doAutoScroll's smooth branch, the scroll-to-bottom animation)
  // never animate. Force it on to match a local desktop; `smoothScrolling: false` measures the
  // OS default instead.
  const args = [...(smoothScrolling ? ['--enable-smooth-scrolling'] : []), appDir]
  if (!real) {
    const shim = prepareHome(home)
    args.splice(
      args.length - 1,
      0,
      `--user-data-dir=${join(home, 'electron-user-data')}`,
      '-r',
      shim
    )
    env.CLAUDEUI_TEST_HOME = home
    env.CLAUDE_CONFIG_DIR = join(home, '.claude')
    env.CODEX_HOME = join(home, '.codex')
    env.CLAUDE_UI_LOG_DIR = join(home, '.claude', 'ui', 'logs')
  } else {
    delete env.CLAUDEUI_TEST_HOME
  }
  const app = await electron.launch({ args, cwd: appDir, env })
  const pid = app.process().pid
  LIVE_PIDS.add(pid)
  try {
    return await attach(app, pid, { profile, windowSize, strippedEnv })
  } catch (err) {
    // Anything failing after the process exists must not leave it running.
    await Promise.race([app.close().catch(() => {}), sleep(5000)])
    killPid(pid)
    throw err
  }
}

async function attach(app, pid, { profile, windowSize, strippedEnv }) {
  const win = await app.firstWindow()
  const consoleErrors = []
  win.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text().slice(0, 300)))
  win.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`.slice(0, 300)))
  await win.waitForLoadState('domcontentloaded')
  if (!profile && windowSize)
    await app.evaluate(({ BrowserWindow }, s) => {
      const w = BrowserWindow.getAllWindows()[0]
      if (w && !w.isMaximized()) w.setSize(s.width, s.height)
    }, windowSize)
  const cdp = await win.context().newCDPSession(win)
  if (profile) {
    const p = MOBILE_PROFILES[profile]
    if (!p) throw new Error(`unknown profile ${profile}`)
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: p.width,
      height: p.height,
      deviceScaleFactor: p.deviceScaleFactor,
      mobile: true
    })
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    await cdp.send('Emulation.setUserAgentOverride', { userAgent: p.userAgent })
    await win.waitForFunction(() => window.innerWidth < 768, undefined, { timeout: 10_000 })
  }
  await win.waitForFunction(() => !!window.__claudeuiVerifier, undefined, { timeout: 30_000 })
  await win.evaluate(installPageBench, SEL)
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
  const close = async () => {
    try {
      await Promise.race([app.close(), sleep(15_000)])
    } catch {
      /* fall through to the PID kill */
    }
    killPid(pid)
  }
  return { app, win, cdp, pid, close, consoleErrors, strippedEnv, userData }
}

/** PIDs this process launched and has not yet killed (for the SIGINT/SIGTERM handler). */
export const LIVE_PIDS = new Set()

/** Kill exactly one process tree we started (never by image name). */
export function killPid(pid) {
  if (!pid) return
  LIVE_PIDS.delete(pid)
  try {
    process.kill(pid, 0)
  } catch {
    return // already gone
  }
  try {
    if (process.platform === 'win32')
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    else {
      // Playwright starts the browser in its own process group: kill the group (renderer, GPU,
      // utility children), falling back to the single process.
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        process.kill(pid, 'SIGKILL')
      }
    }
  } catch {
    /* gone between the probe and the kill */
  }
}

/** Set uiFontScale / chatFontScale IN MEMORY (setState, never updateSettings). */
export async function setScales(win, { ui, chat }) {
  return win.evaluate(
    ({ ui, chat }) => {
      const store = window.__claudeuiVerifier.sessionStore
      const before = store.getState().settings
      const prev = { ui: before.uiFontScale, chat: before.chatFontScale }
      store.setState((st) => ({
        settings: {
          ...st.settings,
          uiFontScale: ui,
          chatFontScale: chat ?? ui
        }
      }))
      return prev
    },
    { ui, chat }
  )
}

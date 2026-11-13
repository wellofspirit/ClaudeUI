#!/usr/bin/env node
// Live-verification driver (the `verifier-electron` skill, "Driver kit"). Launches a built
// ClaudeUI under Playwright's Electron driver in an ISOLATED home with every proxy variable on a
// dead port, then serves a localhost-only endpoint that runs a posted async function body with
// `app` (the ElectronApplication) and `win` (the first window) in scope.
//
//   node scripts/verify-driver.mjs <verify folder> <port> [--app <app dir>]
//
//   <verify folder>  scratch folder for this run (the arc's gitignored `.work/<arc>/verify/...`):
//                    the isolated home, logs, temp dir and `electron.pid` go there.
//   <port>           the eval endpoint, on 127.0.0.1 only.
//   --app <dir>      the checkout to run (it must hold a build in `out/`). Default: this script's.
//
//   curl -s --data-binary @step.js http://127.0.0.1:<port>/      run a step, print its JSON result
//   curl -s -X POST http://127.0.0.1:<port>/quit                  close the app and exit
//
// Electron and the Claude binary come from the nearest checkout above the app dir that has them,
// so a worktree under `.claude/worktrees/` (no `node_modules`, no `vendor/`) uses the main
// checkout's. The endpoint runs whatever is posted to it: it is a test tool, bound to loopback,
// and must never be started against a real profile.
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const appFlag = args.indexOf('--app')
const appDir = resolve(
  appFlag >= 0 ? args.splice(appFlag, 2)[1] : join(dirname(fileURLToPath(import.meta.url)), '..')
)
const [verifyArg, portArg] = args
if (!verifyArg || !portArg) {
  console.error('usage: node scripts/verify-driver.mjs <verify folder> <port> [--app <app dir>]')
  process.exit(2)
}
const verify = resolve(verifyArg)

/** The nearest directory at or above `from` that holds `relative`. */
function nearest(from, relative) {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, relative))) return dir
    if (dirname(dir) === dir) return null
  }
}

const exeName = process.platform === 'win32' ? 'electron.exe' : 'electron'
const electronHome = nearest(appDir, join('node_modules', 'electron', 'dist'))
if (!electronHome) throw new Error(`no node_modules/electron/dist at or above ${appDir}`)
const executablePath =
  process.platform === 'darwin'
    ? join(electronHome, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
    : join(electronHome, 'node_modules', 'electron', 'dist', exeName)
const { _electron } = createRequire(join(electronHome, 'package.json'))('playwright')

const home = join(verify, 'home')
const env = { ...process.env }

// No credential-shaped variable reaches the app.
const CREDENTIAL_NAME =
  /^(ANTHROPIC_|CLAUDE_CODE_|OPENAI_|OPENROUTER_|AWS_|GOOGLE_APPLICATION)|(_API_KEY|_AUTH_TOKEN|_OAUTH_TOKEN|_ACCESS_TOKEN|_SECRET)$/i
for (const k of Object.keys(env)) if (CREDENTIAL_NAME.test(k)) delete env[k]

// Network first: every proxy variable to a dead local port, loopback exempt for stand-ins.
for (const k of [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy'
])
  env[k] = 'http://127.0.0.1:9'
for (const k of ['NO_PROXY', 'no_proxy']) env[k] = '127.0.0.1,localhost'

// Isolated home, data dirs, harness store and temp dir.
for (const k of ['HOME', 'USERPROFILE']) env[k] = home
env.APPDATA = join(home, 'AppData/Roaming')
env.LOCALAPPDATA = join(home, 'AppData/Local')
env.XDG_DATA_HOME = join(home, '.local/share')
env.XDG_CONFIG_HOME = join(home, '.config')
env.XDG_STATE_HOME = join(home, '.local/state')
env.XDG_CACHE_HOME = join(home, '.cache')
env.CLAUDE_CONFIG_DIR = join(home, '.claude')
env.CLAUDEUI_HARNESS_STORE = join(verify, 'store')
for (const k of ['TEMP', 'TMP', 'TMPDIR']) env[k] = join(verify, 'tmp')

const cliName = process.platform === 'win32' ? 'bun-claude.exe' : 'bun-claude'
const cliHome = nearest(appDir, join('vendor', 'claude-cli', cliName))
if (cliHome) env.CLAUDEUI_CLAUDE_CLI = join(cliHome, 'vendor', 'claude-cli', cliName)
for (const k of [
  'CLAUDEUI_ALLOW_MULTIPLE_INSTANCES',
  'CLAUDEUI_DISABLE_REMOTE',
  'CLAUDEUI_VERIFIER_HOOKS',
  'CLAUDEUI_HEADLESS'
])
  env[k] = '1'
env.CLAUDEUI_TEST_HOME = home
env.CLAUDE_UI_LOG_DIR = join(verify, 'logs')
env.CLAUDE_UI_LOG = 'info'
for (const d of [
  'AppData/Roaming',
  'AppData/Local',
  '.claude/projects',
  '.claude/ui/logs',
  'electron'
])
  mkdirSync(join(home, d), { recursive: true })
for (const d of ['logs', 'tmp']) mkdirSync(join(verify, d), { recursive: true })

// `app.getPath('home')` aside, the app reads the home through `os.homedir()`: shim it.
const shim = join(verify, 'home-shim.cjs')
writeFileSync(
  shim,
  "const os=require('node:os');const h=process.env.CLAUDEUI_TEST_HOME;if(h)os.homedir=()=>h\n"
)

const app = await _electron.launch({
  executablePath,
  cwd: appDir,
  env,
  args: ['--user-data-dir=' + join(home, 'electron'), '-r', shim, appDir]
})
const pid = app.process().pid
writeFileSync(join(verify, 'electron.pid'), String(pid))
const win = await app.firstWindow()

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const server = createServer(async (req, res) => {
  if (req.url === '/quit') {
    res.end('"closing"')
    server.close()
    await app.close().catch(() => {})
    process.exit(0)
  }
  let body = ''
  for await (const chunk of req) body += chunk
  try {
    const result = await new AsyncFunction('app', 'win', body)(app, win)
    res.end(JSON.stringify(result ?? null))
  } catch (err) {
    res.statusCode = 500
    res.end(String(err?.stack ?? err))
  }
})
server.listen(Number(portArg), '127.0.0.1', () =>
  process.stdout.write(`driver ready pid=${pid} app=${appDir}\n`)
)

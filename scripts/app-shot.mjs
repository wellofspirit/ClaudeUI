// Launch the built ClaudeUI Electron app under Playwright control, capture a
// screenshot + renderer console errors, and report how many times a needle
// (default "Codex") appears in the live DOM. Node-only — Playwright's _electron
// driver has no Python binding, and the renderer needs the real preload bridge
// (window.api), so a headless browser can't substitute.
//
// Usage:
//   node scripts/app-shot.mjs [--out <path>] [--needle <text>] [--settle <ms>]
//                             [--click <selector>] [--press <key>] [--type <text>]
//                             [--wait <ms>] [--eval <js>]
//                             [--state] [--timeout <ms>]
//                             [--keep] [--with-remote]
//                             [--headed] [--testids] [--assert-testid <id>]...
//
// --click/--press/--type/--wait/--eval are ORDERED with respect to each other and
// replayed in the order they appear on the command line, so a flow like "open a
// panel with its keyboard shortcut, then type into it" is expressible. `--press`
// takes Playwright key syntax (e.g. `Control+Backquote`); `--type` sends literal
// text to the focused element (use `\n` for Enter).
//
// --wait <ms>            plain pause between steps, for a transition that outlasts
//                        the 1.2 s each action already waits.
// --eval <js>            evaluate the expression in the renderer and print one line
//                        `EVAL <json>`. Repeatable; each prints in step order.
// --state                after the shot, print `STATE <json>` —
//                        `window.__claudeuiVerifier.snapshot()`: active session id,
//                        per-session message counts by role + status.state, and the
//                        replica's canonical message counts. Prints
//                        `STATE null` if the hooks are absent (see below).
// --timeout <ms>         override the watchdog (default 60000). Raise it for a run
//                        whose --wait steps legitimately exceed it.
//
// VERIFIER HOOKS: the app is launched with CLAUDEUI_VERIFIER_HOOKS=1, which makes
// the renderer publish `window.__claudeuiVerifier` — the session store plus the
// replica's canonical state. That is what --state reads and what --eval can reach.
// It exists ONLY because this harness asks for it: a normal launch has no such
// global (src/shared/verifier-hooks.ts), so don't expect these flags to describe a
// user's app.
//
// --testids              dump the sorted set of [data-testid] values present in the
//                        live DOM (with counts) — the rendered-component inventory
//                        (ADR-027). Assert structure here BEFORE reading the PNG.
// --assert-testid <id>   repeatable; exit non-zero (code 3) if any named testid is
//                        absent from the DOM. Implies --testids output.
// --with-remote          do NOT suppress remote access in the launched instance
//                        (see below). Only for verifying remote-listener UI live.
// --headed               show the window on-screen normally (opt out of headless,
//                        see below). Implied by --keep.
//
// Headless is the DEFAULT: the app is launched with CLAUDEUI_HEADLESS=1, which
// makes it show the window inactive and off the virtual desktop, with no taskbar
// entry — so a verifier run never steals focus or covers the user's screen.
// Screenshots and clicks still work because the window is genuinely shown (a
// hidden window produces no frames at all). `--keep` implies `--headed`: a kept
// instance you can't see or find in the taskbar is an orphan trap.
//
// Remote access is suppressed by DEFAULT: the app is launched with
// CLAUDEUI_DISABLE_REMOTE=1, so this instance never reconciles, autostarts, or
// tears down the remote listener / the machine's `tailscale serve` config. Those
// are machine-global, not per-instance — without the flag this harness would
// hijack an already-running app's remote access and disable tailscale on exit.
//
// Prereqs: `bun run build` (needs out/main + out/renderer). Reads ~/.claude, so
// it shows your real sessions/config; it only screenshots and closes.
import { _electron as electron } from 'playwright'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync } from 'node:fs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const arg = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def
}
const has = (name) => args.includes(`--${name}`)

const outPath = arg('out', join(root, '.cache', 'screenshots', 'app.png'))
const needle = arg('needle', 'Codex')
const settle = parseInt(arg('settle', '3000'), 10)
// Collect every step flag in COMMAND-LINE order; replayed sequentially before the
// shot. Selectors accept Playwright syntax incl. `text=...` and `[title="..."]`;
// keys use Playwright key names. One table so adding a step kind is one line.
const STEP_FLAGS = {
  '--click': 'click',
  '--press': 'press',
  '--type': 'type',
  '--wait': 'wait',
  '--eval': 'eval'
}
const actions = []
for (let i = 0; i < args.length; i++) {
  const kind = STEP_FLAGS[args[i]]
  if (kind && args[i + 1]) actions.push({ kind, value: args[i + 1] })
}
// Collect every --assert-testid <id> (repeatable). Presence is asserted after the
// shot; any missing id fails the run (exit 3). Asserting implies dumping testids.
const assertTestids = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--assert-testid' && args[i + 1]) assertTestids.push(args[i + 1])
}
const dumpTestids = has('testids') || assertTestids.length > 0
// --keep implies --headed: leaving behind an invisible, taskbar-less instance
// makes it un-closeable by hand.
const headed = has('headed') || has('keep')

mkdirSync(dirname(outPath), { recursive: true })

// Overridable because --wait steps are ordered INSIDE the watchdog's window: a
// flow that legitimately pauses for 90 s would otherwise be killed mid-run.
const timeoutMs = parseInt(arg('timeout', '60000'), 10)
const hardTimeout = setTimeout(() => {
  console.error(`TIMEOUT: app did not settle in ${timeoutMs}ms`)
  process.exit(2)
}, timeoutMs)

let app
try {
  // args:[root] → Electron uses package.json "main" (out/main/index.js).
  // env: inherit, plus the remote kill switch unless --with-remote was passed,
  // plus the headless window switch unless the run is headed. The flags are
  // authoritative in BOTH directions: opting out also strips an inherited var
  // from the parent shell, so --headed/--with-remote always mean what they say.
  const env = { ...process.env }
  if (has('with-remote')) delete env.CLAUDEUI_DISABLE_REMOTE
  else env.CLAUDEUI_DISABLE_REMOTE = '1'
  if (headed) delete env.CLAUDEUI_HEADLESS
  else env.CLAUDEUI_HEADLESS = '1'
  // Always on for a harness launch: --state needs it, and --eval is far more
  // useful with the store reachable. The app publishes nothing without it.
  env.CLAUDEUI_VERIFIER_HOOKS = '1'
  app = await electron.launch({ args: [root], cwd: root, env })
  const win = await app.firstWindow()

  const consoleErrors = []
  win.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()))
  win.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))

  await win.waitForLoadState('domcontentloaded')
  await win.waitForTimeout(settle) // let React mount + first IPC round-trips settle

  for (const action of actions) {
    if (action.kind === 'wait') {
      // A pause is its own step, not a --settle bump: it belongs BETWEEN two
      // actions, which is exactly what --settle cannot express. No trailing
      // settle — the pause IS the wait.
      await win.waitForTimeout(parseInt(action.value, 10))
      continue
    }
    if (action.kind === 'eval') {
      // Its own stdout line rather than a field in the final JSON, so a sequence
      // of probes reads in step order. `undefined` is not JSON — normalise it to
      // null so every EVAL line parses. Reads don't disturb the page, so no
      // settle either.
      const value = await win.evaluate(`(${action.value})`)
      console.log(`EVAL ${JSON.stringify(value === undefined ? null : value)}`)
      continue
    }
    if (action.kind === 'click') await win.click(action.value, { timeout: 10_000 })
    else if (action.kind === 'press') await win.keyboard.press(action.value)
    // `\n` in a --type payload is Enter: shells need the newline to run anything.
    else await win.keyboard.type(action.value.replace(/\\n/g, '\n'))
    await win.waitForTimeout(1200)
  }

  await win.screenshot({ path: outPath })

  // Renderer state, AFTER the shot so the two describe the same moment. Prints
  // `STATE null` rather than throwing when the hook is missing — that is a real
  // outcome (a build predating the hooks, or an app launched by something other
  // than this harness), and it should read as a finding, not a crash.
  if (has('state')) {
    const state = await win.evaluate(() => window.__claudeuiVerifier?.snapshot() ?? null)
    console.log(`STATE ${JSON.stringify(state)}`)
  }

  const visibleNeedle = await win.locator(`text=${needle}`).count()
  const html = await win.content()
  const htmlNeedle = (html.match(new RegExp(needle, 'gi')) || []).length

  // Structural inventory: every [data-testid] in the live DOM → { id: count },
  // sorted. This is the rendered-component check that precedes the screenshot.
  let testids
  let missingTestids
  if (dumpTestids) {
    const ids = await win.$$eval('[data-testid]', (els) =>
      els.map((e) => e.getAttribute('data-testid'))
    )
    const counts = {}
    for (const id of ids) counts[id] = (counts[id] ?? 0) + 1
    testids = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
    missingTestids = assertTestids.filter((id) => !(id in counts))
  }

  const ok = !missingTestids || missingTestids.length === 0

  console.log(
    JSON.stringify(
      {
        ok,
        screenshot: outPath,
        headless: !headed,
        windowTitle: await win.title(),
        needle,
        needleVisibleInDom: visibleNeedle,
        needleInRawHtml: htmlNeedle,
        ...(testids ? { testids } : {}),
        ...(missingTestids ? { missingTestids } : {}),
        consoleErrors
      },
      null,
      2
    )
  )

  if (!has('keep')) await app.close()
  if (!ok) process.exit(3)
} catch (err) {
  console.error('app-shot failed:', err?.stack || err)
  try {
    await app?.close()
  } catch {
    /* ignore */
  }
  process.exit(1)
} finally {
  clearTimeout(hardTimeout)
}

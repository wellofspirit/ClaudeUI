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
//                             [--profile <name>] [--font-scale <n>] [--overflow-audit]
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
// --profile <name>      emulate a device from scripts/lib/mobile-profiles.mjs (the same
//                        numbers the vitest `browser` project asserts at): the window's
//                        viewport, pixel ratio, touch and user agent are overridden over
//                        CDP, so `useIsMobile` flips and the phone layout renders. Falls
//                        back to webContents.enableDeviceEmulation if CDP is unavailable.
// --font-scale <n>       set `settings.uiFontScale` to n IN MEMORY (the store's setState,
//                        never updateSettings, which persists) and put the original back
//                        before the app closes, so the settings file is never touched.
// --overflow-audit       after the shot, print `OVERFLOW [...]`: every visible element whose
//                        rect leaves the viewport horizontally, and every element whose
//                        scrollWidth exceeds its clientWidth while its overflow-x is
//                        visible/hidden (auto/scroll boxes, ellipsis truncation and
//                        mask-image fades are ignored). Each entry names the nearest data-testid, the tag, the
//                        rect and the overflow amount. `OVERFLOW []` is clean.
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
import { MOBILE_PROFILES } from './lib/mobile-profiles.mjs'

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
const profileName = arg('profile', undefined)
const profile = profileName ? MOBILE_PROFILES[profileName] : undefined
if (profileName && !profile) {
  console.error(
    `unknown --profile "${profileName}" (known: ${Object.keys(MOBILE_PROFILES).join(', ')})`
  )
  process.exit(1)
}
const fontScaleArg = arg('font-scale', undefined)
const fontScale = fontScaleArg === undefined ? undefined : Number(fontScaleArg)
if (fontScale !== undefined && !(fontScale >= 1 && fontScale <= 1.5)) {
  console.error(
    `--font-scale must be a number from 1 to 1.5 (the setting's range), got "${fontScaleArg}"`
  )
  process.exit(1)
}
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

/**
 * Device emulation for `--profile`. CDP first (the same override DevTools' device
 * mode uses); webContents.enableDeviceEmulation from the main process if the
 * window will not hand out a CDP session.
 */
async function emulateProfile(app, win, p) {
  try {
    const cdp = await win.context().newCDPSession(win)
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: p.width,
      height: p.height,
      deviceScaleFactor: p.deviceScaleFactor,
      mobile: true
    })
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    await cdp.send('Emulation.setUserAgentOverride', { userAgent: p.userAgent })
    return 'cdp'
  } catch (err) {
    console.error(`CDP emulation unavailable (${err?.message}); using webContents emulation`)
    await app.evaluate(({ BrowserWindow }, q) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents
      wc.setUserAgent(q.userAgent)
      wc.enableDeviceEmulation({
        screenPosition: 'mobile',
        screenSize: { width: q.width, height: q.height },
        viewPosition: { x: 0, y: 0 },
        viewSize: { width: q.width, height: q.height },
        deviceScaleFactor: q.deviceScaleFactor,
        scale: 1
      })
    }, p)
    return 'webContents'
  }
}

/**
 * The `--overflow-audit` walk, run in the renderer. A rect is judged by its
 * VISIBLE part: clipped by every ancestor that clips sideways first, so a row
 * scrolled out of a horizontal scroller (or the closed drawer) is not a finding.
 */
function overflowAudit() {
  const vw = window.innerWidth
  const clips = (cs) => cs.overflowX !== 'visible'
  const round = (n) => Math.round(n * 10) / 10
  const nearestTestId = (el) => el.closest('[data-testid]')?.getAttribute('data-testid') ?? null
  const out = []
  for (const el of document.body.querySelectorAll('*')) {
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue
    let { left, right, top, bottom } = el.getBoundingClientRect()
    if (right - left <= 0 || bottom - top <= 0) continue
    const rect = [round(left), round(top), round(right), round(bottom)]
    // Only the ancestors that really clip this element: a fixed one escapes them
    // all, an absolute one stops at its containing block. The page itself
    // (html/body) is not a clip here: leaving it is exactly what we look for.
    if (cs.position !== 'fixed') {
      for (
        let a = el.parentElement;
        a && a !== document.body && left < right;
        a = a.parentElement
      ) {
        const acs = getComputedStyle(a)
        if (clips(acs)) {
          const r = a.getBoundingClientRect()
          left = Math.max(left, r.left)
          right = Math.min(right, r.right)
        }
        if (cs.position === 'absolute' && acs.position !== 'static') break
      }
    }
    if (left >= right) continue // clipped away entirely: not on screen
    const entry = (kind, overflow) =>
      out.push({ kind, testid: nearestTestId(el), tag: el.tagName.toLowerCase(), rect, overflow })
    if (left < -0.5 || right > vw + 0.5) entry('viewport', round(Math.max(-left, right - vw)))
    if (
      el.scrollWidth > el.clientWidth + 1 &&
      (cs.overflowX === 'visible' || cs.overflowX === 'hidden') &&
      cs.textOverflow !== 'ellipsis' &&
      // A fade-out mask is the app's other deliberate truncation (session names).
      (cs.maskImage || cs.webkitMaskImage || 'none') === 'none'
    ) {
      entry('scrollWidth', el.scrollWidth - el.clientWidth)
    }
  }
  return out
}

let app
let restoreFontScale = async () => {}
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
  if (profile) {
    const via = await emulateProfile(app, win, profile)
    // `useIsMobile` is `window.innerWidth < 768`: wait for the override to land.
    await win.waitForFunction(() => window.innerWidth < 768, undefined, { timeout: 10_000 })
    console.log(`PROFILE ${profileName} via ${via} ${profile.width}x${profile.height}`)
  }
  await win.waitForTimeout(settle) // let React mount + first IPC round-trips settle

  if (fontScale !== undefined) {
    // In memory only: setState, never updateSettings (that writes the user's file).
    const original = await win.evaluate((n) => {
      const store = window.__claudeuiVerifier?.sessionStore
      if (!store) return null
      const before = store.getState().settings.uiFontScale
      store.setState((st) => ({ settings: { ...st.settings, uiFontScale: n } }))
      return before
    }, fontScale)
    if (original === null) throw new Error('--font-scale needs the verifier hooks (stale build?)')
    restoreFontScale = async () => {
      await win.evaluate((n) => {
        window.__claudeuiVerifier?.sessionStore.setState((st) => ({
          settings: { ...st.settings, uiFontScale: n }
        }))
      }, original)
    }
    console.log(`FONT_SCALE ${fontScale} (was ${original}, restored on exit)`)
    await win.waitForTimeout(800) // let the zoomed layout settle
  }

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

  if (has('overflow-audit')) {
    const found = await win.evaluate(overflowAudit)
    console.log(`OVERFLOW ${JSON.stringify(found.slice(0, 100))}`)
    if (found.length > 100) console.log(`OVERFLOW_TRUNCATED ${found.length - 100} more`)
  }

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

  await restoreFontScale()
  if (!has('keep')) await app.close()
  if (!ok) process.exit(3)
} catch (err) {
  console.error('app-shot failed:', err?.stack || err)
  try {
    await restoreFontScale()
  } catch {
    /* ignore */
  }
  try {
    await app?.close()
  } catch {
    /* ignore */
  }
  process.exit(1)
} finally {
  clearTimeout(hardTimeout)
}

// Launch the built ClaudeUI Electron app under Playwright control, capture a
// screenshot + renderer console errors, and report how many times a needle
// (default "Codex") appears in the live DOM. Node-only — Playwright's _electron
// driver has no Python binding, and the renderer needs the real preload bridge
// (window.api), so a headless browser can't substitute.
//
// Usage:
//   node scripts/app-shot.mjs [--out <path>] [--needle <text>] [--settle <ms>]
//                             [--click <selector>] [--keep]
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
// Collect every --click <selector> in order; clicked sequentially before the shot.
// Selectors accept Playwright syntax incl. `text=...` and `[title="..."]`.
const clicks = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--click' && args[i + 1]) clicks.push(args[i + 1])
}

mkdirSync(dirname(outPath), { recursive: true })

const hardTimeout = setTimeout(() => {
  console.error('TIMEOUT: app did not settle in 60s')
  process.exit(2)
}, 60_000)

let app
try {
  // args:[root] → Electron uses package.json "main" (out/main/index.js).
  app = await electron.launch({ args: [root], cwd: root })
  const win = await app.firstWindow()

  const consoleErrors = []
  win.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()))
  win.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))

  await win.waitForLoadState('domcontentloaded')
  await win.waitForTimeout(settle) // let React mount + first IPC round-trips settle

  for (const sel of clicks) {
    await win.click(sel, { timeout: 10_000 })
    await win.waitForTimeout(1200)
  }

  await win.screenshot({ path: outPath })

  const visibleNeedle = await win.locator(`text=${needle}`).count()
  const html = await win.content()
  const htmlNeedle = (html.match(new RegExp(needle, 'gi')) || []).length

  console.log(
    JSON.stringify(
      {
        ok: true,
        screenshot: outPath,
        windowTitle: await win.title(),
        needle,
        needleVisibleInDom: visibleNeedle,
        needleInRawHtml: htmlNeedle,
        consoleErrors
      },
      null,
      2
    )
  )

  if (!has('keep')) await app.close()
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

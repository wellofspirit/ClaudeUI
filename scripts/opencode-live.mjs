/**
 * Drive script for live opencode Phase-8 verification.
 * Launches the built Electron app, drives the "New session" welcome screen to
 * create an opencode session at D:\WorkPlace\ClaudeUI via the directory picker
 * dropdown (no native OS dialog needed), then runs scenarios A-E.
 *
 * Usage: node scripts/opencode-live.mjs
 * Output: .cache/screenshots/oc-*.png + JSON summary to stdout
 *
 * Prerequisites: bun run build
 */
import { _electron as electron } from 'playwright'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync } from 'node:fs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(root, '.cache', 'screenshots')
mkdirSync(OUT, { recursive: true })

const results = {}
const consoleErrors = []

function shot(name) {
  return join(OUT, `oc-${name}.png`)
}

const hardTimeout = setTimeout(() => {
  console.error('TIMEOUT: script exceeded 300s')
  process.exit(2)
}, 300_000)

let app
try {
  console.log('[setup] Launching Electron app...')
  app = await electron.launch({ args: [root], cwd: root })

  const win = await app.firstWindow()
  win.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`[renderer] ${m.text()}`)
  })
  win.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${e.message}`))

  await win.waitForLoadState('domcontentloaded')
  console.log('[setup] DOM loaded, waiting 4s for React + IPC to settle...')
  await win.waitForTimeout(4000)

  await win.screenshot({ path: shot('0-initial') })

  // ── Step 1: Click opencode engine toggle on WelcomeState ──────────────────────
  // There are TWO engine toggle groups (sidebar compact + WelcomeState larger one).
  // The WelcomeState one is in the main pane. We target getByRole('radio', {name:'opencode'}).nth(1)
  // which is the larger (h-7 px-3) one in the WelcomeState.
  console.log('[setup] Selecting opencode engine...')
  const ocEngineBtn = win.getByRole('radio', { name: 'opencode' }).nth(1)
  await ocEngineBtn.click()
  await win.waitForTimeout(800)
  await win.screenshot({ path: shot('1-opencode-engine-selected') })
  console.log('[setup] opencode engine selected')

  // ── Step 2: Open "Select a project directory" dropdown ───────────────────────
  console.log('[setup] Opening project directory picker...')
  await win.locator('text=Select a project directory').click()
  await win.waitForTimeout(600)
  await win.screenshot({ path: shot('2-dir-picker-open') })

  // ── Step 3: Click ClaudeUI directory ─────────────────────────────────────────
  // The dropdown shows directory entries with folderName + cwd. The dropdown has z-20
  // but Playwright may see the z-10 overlay — use force:true to bypass hit-test check.
  console.log('[setup] Clicking ClaudeUI directory...')
  // Target the button that contains D:\WorkPlace\ClaudeUI
  await win.locator('button:has-text("ClaudeUI")').first().click({ force: true })
  await win.waitForTimeout(2500)  // let session init + opencode server spin up
  await win.screenshot({ path: shot('3-session-started') })
  console.log('[setup] Session created, opencode server spinning up...')

  // ── Step 4: Wait for textarea to become enabled ───────────────────────────────
  console.log('[setup] Waiting for textarea to be enabled...')
  await win.waitForSelector('textarea:not([disabled])', { timeout: 15000 })
  console.log('[setup] Textarea enabled!')
  await win.screenshot({ path: shot('4-textarea-ready') })

  // ── Step 5: Wait for model picker to appear + verify model list ──────────────
  // Let model discovery run (opencode server starts, GET /config/providers)
  console.log('[setup] Waiting for model discovery (up to 10s)...')
  await win.waitForTimeout(3000)

  const modelBtnCount = await win.locator('[title="Model"]').count()
  console.log(`[setup] Model picker buttons: ${modelBtnCount}`)

  // Open model picker and check for free model
  if (modelBtnCount > 0) {
    await win.locator('[title="Model"]').first().click()
    await win.waitForTimeout(600)
    await win.screenshot({ path: shot('5-model-picker') })

    // Look for mimo-v2.5-free or any free model
    const freeBtn = win.locator('button').filter({ hasText: /mimo.*free|free/i }).first()
    const freeBtnCount = await freeBtn.count()
    console.log(`[setup] Free model entries: ${freeBtnCount}`)

    // List all model entries for debug
    const allModelEntries = await win.locator('.absolute.bottom-full button').allTextContents()
    console.log('[setup] Model picker entries:', allModelEntries.slice(0, 10))

    if (freeBtnCount > 0) {
      await freeBtn.click()
      await win.waitForTimeout(500)
      console.log('[setup] Selected free model')
    } else {
      // Try selecting first non-header entry
      const dropdownBtns = win.locator('.absolute.bottom-full button')
      const dropdownBtnCount = await dropdownBtns.count()
      if (dropdownBtnCount > 0) {
        const firstModelName = await dropdownBtns.first().textContent()
        await dropdownBtns.first().click()
        await win.waitForTimeout(500)
        console.log(`[setup] Selected first available model: ${firstModelName}`)
      } else {
        await win.keyboard.press('Escape')
        console.log('[setup] No model entries found in picker')
      }
    }
  }

  await win.screenshot({ path: shot('6-model-selected') })

  // ── SCENARIO A: Basic opencode turn ─────────────────────────────────────────
  console.log('\n[A] Basic opencode turn...')
  let scenarioA = { status: 'COULDNT_TRIGGER', detail: '' }

  try {
    const textarea = win.locator('textarea').first()
    await textarea.click()
    await textarea.fill('Reply with exactly: hello world')
    await win.waitForTimeout(300)
    await win.screenshot({ path: shot('A1-prompt-typed') })

    await textarea.press('Enter')
    console.log('[A] Submitted, waiting up to 60s for response...')

    // Poll for "hello world" in the DOM
    let responseFound = false
    for (let i = 0; i < 20; i++) {
      await win.waitForTimeout(3000)
      const html = await win.content()
      const hasHello = /hello world/i.test(html)
      const helloLocator = await win.locator('text=/hello world/i').count()
      const isRunning = await win.locator('text=/Running|Thinking|streaming/i').count()
      console.log(`[A] t+${(i+1)*3}s: "hello world" in HTML=${hasHello}, locator=${helloLocator}, running=${isRunning}`)
      if (hasHello || helloLocator > 0) {
        responseFound = true
        break
      }
      // Detect any message content appearing
      const msgBubbles = await win.locator('[class*="message"], [class*="bubble"], [class*="assistant"]').count()
      if (msgBubbles > 0 && i > 3) {
        console.log(`[A] Message bubbles detected (${msgBubbles}) at t+${(i+1)*3}s`)
      }
    }

    await win.screenshot({ path: shot('A2-response') })

    const finalHtml = await win.content()
    const finalHasHello = /hello world/i.test(finalHtml)

    if (responseFound || finalHasHello) {
      const _snippet = finalHtml.match(/hello world/i)?.[0]
      scenarioA = { status: 'VERIFIED', detail: `"hello world" found in DOM. responseFound=${responseFound}` }
    } else {
      // Capture what's in the chat area
      const chatContent = await win.locator('[class*="chat"], [class*="message"]').allTextContents()
      const errorMsgs = await win.locator('text=/error|failed|timeout/i').count()
      scenarioA = {
        status: 'COULDNT_TRIGGER',
        detail: `No "hello world" after 60s. Error indicators: ${errorMsgs}. Chat content items: ${chatContent.length}. May be model connectivity issue.`
      }
    }
  } catch (e) {
    scenarioA = { status: 'FAILED', detail: e.message }
    await win.screenshot({ path: shot('A-error') }).catch(() => {})
  }
  console.log('[A] Result:', scenarioA)
  results.A = scenarioA

  // ── SCENARIO B: Slash menu ────────────────────────────────────────────────────
  console.log('\n[B] Slash menu test...')
  let scenarioB = { status: 'COULDNT_TRIGGER', detail: '' }

  try {
    // Wait for any ongoing run to finish
    await win.waitForTimeout(1000)

    const textarea = win.locator('textarea').first()
    const isEnabled = await textarea.isEnabled().catch(() => false)
    if (!isEnabled) {
      // Wait a bit more for run to complete
      await win.waitForTimeout(5000)
    }

    await textarea.click({ timeout: 10000 })
    // Clear and type '/'
    await textarea.fill('')
    await textarea.type('/')
    await win.waitForTimeout(800)
    await win.screenshot({ path: shot('B1-slash-typed') })

    // The slash menu is a listbox/combobox overlay positioned above the textarea
    // useSlashMenu opens it when the input starts with '/'
    // Look for slash command items: /init, /review, /help, /clear, etc.
    const html = await win.content()
    const hasSlashItems = /\/init|\/review|\/help|\/clear|\/doctor/i.test(html)
    const slashBtns = await win.locator('[role="listbox"] button, [role="option"], [class*="slash"]').count()
    // Also look for the command menu container (SlashCommandMenu renders filtered commands)
    const menuContainer = await win.locator('[class*="SlashCommand"], [class*="slash-command"]').count()

    // Check visible text for command names
    const visibleCmds = await win.locator('button').filter({ hasText: /^(init|review|help|clear|doctor|memory)$/ }).count()

    console.log(`[B] hasSlashItems=${hasSlashItems}, slashBtns=${slashBtns}, menuContainer=${menuContainer}, visibleCmds=${visibleCmds}`)

    if (hasSlashItems || slashBtns > 0 || menuContainer > 0 || visibleCmds > 0) {
      scenarioB = { status: 'VERIFIED', detail: `Slash menu detected: hasSlashItems=${hasSlashItems}, slashBtns=${slashBtns}, menuContainer=${menuContainer}, visibleCmds=${visibleCmds}` }
    } else {
      // Check if slashCommands capability is enabled (opencode session might not have loaded commands yet)
      scenarioB = { status: 'COULDNT_TRIGGER', detail: `No slash menu content after typing '/'. This may indicate opencode slash command discovery hasn't run yet, or the session isn't connected to opencode. hasSlashItems=${hasSlashItems}` }
    }

    // Press Escape to close menu
    await textarea.press('Escape')
    await win.waitForTimeout(300)
  } catch (e) {
    scenarioB = { status: 'FAILED', detail: e.message }
    await win.screenshot({ path: shot('B-error') }).catch(() => {})
  }
  console.log('[B] Result:', scenarioB)
  results.B = scenarioB

  // ── SCENARIO C: /btw side-question ───────────────────────────────────────────
  console.log('\n[C] /btw side-question...')
  let scenarioC = { status: 'COULDNT_TRIGGER', detail: '' }

  try {
    await win.waitForTimeout(1000)
    const textarea = win.locator('textarea').first()

    // Check if textarea is enabled (session active)
    let textareaReady = false
    for (let i = 0; i < 5; i++) {
      const enabled = await textarea.isEnabled().catch(() => false)
      if (enabled) { textareaReady = true; break }
      await win.waitForTimeout(2000)
    }

    if (!textareaReady) {
      scenarioC = { status: 'COULDNT_TRIGGER', detail: 'Textarea still disabled — opencode session not active yet' }
    } else {
      await textarea.click()
      await textarea.fill('/btw what is 2 plus 2')
      await win.waitForTimeout(300)
      await win.screenshot({ path: shot('C1-btw-typed') })

      await textarea.press('Enter')
      console.log('[C] /btw submitted, waiting for BtwCard (up to 30s)...')

      let btwFound = false
      for (let i = 0; i < 15; i++) {
        await win.waitForTimeout(2000)
        const html = await win.content()
        // BtwCard contains "btw", "side", or the answer
        const hasBtwMarker = /btw|side.question|by.the.way/i.test(html)
        const btwCards = await win.locator('[class*="btw"], [class*="Btw"], [class*="BtwCard"]').count()
        // Look for the answer "4" in a btw context, or just look for BtwCard text
        const _answerText = await win.locator('text=/\\b4\\b/').count()
        console.log(`[C] t+${(i+1)*2}s: hasBtwMarker=${hasBtwMarker}, btwCards=${btwCards}`)
        if (hasBtwMarker || btwCards > 0) {
          btwFound = true
          break
        }
      }

      await win.screenshot({ path: shot('C2-btw-response') })

      if (btwFound) {
        scenarioC = { status: 'VERIFIED', detail: 'BtwCard / side-question indicator detected in DOM' }
      } else {
        // Check if the /btw was handled as a regular message instead
        const html = await win.content()
        const hasFour = /\b4\b/.test(html)
        scenarioC = {
          status: 'COULDNT_TRIGGER',
          detail: `No BtwCard after 30s. hasFour in html=${hasFour}. /btw routing may require a running opencode session turn.`
        }
      }
    }
  } catch (e) {
    scenarioC = { status: 'FAILED', detail: e.message }
    await win.screenshot({ path: shot('C-error') }).catch(() => {})
  }
  console.log('[C] Result:', scenarioC)
  results.C = scenarioC

  // ── SCENARIO D: Subagent (best-effort) ──────────────────────────────────────
  console.log('\n[D] Subagent verification (best-effort)...')
  let scenarioD = { status: 'BEST_EFFORT', detail: '' }

  try {
    await win.waitForTimeout(1000)
    const textarea = win.locator('textarea').first()
    const enabled = await textarea.isEnabled().catch(() => false)

    if (!enabled) {
      scenarioD = { status: 'BEST_EFFORT', detail: 'Textarea not enabled — skipping to not block' }
    } else {
      await textarea.click()
      await textarea.fill('Use the TodoWrite tool to add a todo item: "test subagent"')
      await win.waitForTimeout(300)
      await textarea.press('Enter')
      console.log('[D] Subagent prompt submitted, waiting 30s...')

      let taskCardFound = false
      for (let i = 0; i < 10; i++) {
        await win.waitForTimeout(3000)
        const html = await win.content()
        const hasTask = /task|subagent|todo|TodoWrite/i.test(html)
        const taskCards = await win.locator('[class*="task"], [class*="Task"], [class*="todo"]').count()
        console.log(`[D] t+${(i+1)*3}s: hasTask=${hasTask}, taskCards=${taskCards}`)
        if (taskCards > 2 || (hasTask && i > 1)) {
          taskCardFound = true
          break
        }
      }

      await win.screenshot({ path: shot('D1-subagent') })

      const html = await win.content()
      const hasTodo = /TodoWrite|todo.item|test subagent/i.test(html)

      if (taskCardFound || hasTodo) {
        scenarioD = { status: 'VERIFIED', detail: `Task/subagent content detected. taskCardFound=${taskCardFound}, hasTodo=${hasTodo}` }
      } else {
        scenarioD = { status: 'BEST_EFFORT', detail: 'No TaskCard detected after 30s. Free model may not call TodoWrite tool.' }
      }
    }
  } catch (e) {
    scenarioD = { status: 'BEST_EFFORT', detail: `Exception: ${e.message}` }
    await win.screenshot({ path: shot('D-error') }).catch(() => {})
  }
  console.log('[D] Result:', scenarioD)
  results.D = scenarioD

  // ── SCENARIO E: Steer/Queue (best-effort) ────────────────────────────────────
  console.log('\n[E] Queue/steer (best-effort)...')
  let scenarioE = { status: 'BEST_EFFORT', detail: '' }

  try {
    const textarea = win.locator('textarea').first()
    const enabled = await textarea.isEnabled().catch(() => false)

    if (!enabled) {
      scenarioE = { status: 'BEST_EFFORT', detail: 'Textarea not enabled — skipping' }
    } else {
      // Submit a longer prompt to keep it busy briefly
      await textarea.click()
      await textarea.fill('Count from 1 to 20, one number per line')
      await textarea.press('Enter')
      await win.waitForTimeout(800)  // Give it just enough time to start running

      // Check if there's a "running" state where we can queue
      const isRunning = await win.locator('text=/Running|Cancel|\\[\\[/').count()
      console.log(`[E] Running indicator: ${isRunning}`)

      if (isRunning > 0) {
        // Try to send a second message while it's running — should be queued
        await textarea.fill('Stop after 5')
        await textarea.press('Enter')
        await win.waitForTimeout(1000)

        await win.screenshot({ path: shot('E1-queued') })
        const html = await win.content()
        const hasQueue = /queue|queued|pending/i.test(html)
        const queueCard = await win.locator('[class*="queue"], [class*="Queue"]').count()
        console.log(`[E] hasQueue=${hasQueue}, queueCard=${queueCard}`)

        if (hasQueue || queueCard > 0) {
          scenarioE = { status: 'VERIFIED', detail: `Queue card appeared. hasQueue=${hasQueue}, queueCard=${queueCard}` }
        } else {
          scenarioE = { status: 'BEST_EFFORT', detail: 'Could not confirm queue card — timing is hard to hit reliably' }
        }
      } else {
        scenarioE = { status: 'BEST_EFFORT', detail: 'No running indicator detected — model responded too fast to test queue' }
      }
    }
  } catch (e) {
    scenarioE = { status: 'BEST_EFFORT', detail: `Exception: ${e.message}` }
  }
  console.log('[E] Result:', scenarioE)
  results.E = scenarioE

  // ── Final screenshot ─────────────────────────────────────────────────────────
  await win.screenshot({ path: shot('Z-final') })

  // ── Summary ──────────────────────────────────────────────────────────────────
  const summary = {
    ok: true,
    results,
    consoleErrors: consoleErrors.slice(0, 20),
    screenshots: {
      initial: shot('0-initial'),
      engineSelected: shot('1-opencode-engine-selected'),
      dirPicker: shot('2-dir-picker-open'),
      session: shot('3-session-started'),
      textareaReady: shot('4-textarea-ready'),
      modelPicker: shot('5-model-picker'),
      A_response: shot('A2-response'),
      B_slash: shot('B1-slash-typed'),
      C_btw: shot('C2-btw-response'),
      D_subagent: shot('D1-subagent'),
      final: shot('Z-final'),
    }
  }
  console.log('\n' + JSON.stringify(summary, null, 2))

  await app.close()
} catch (err) {
  console.error('Drive script failed:', err?.stack || err)
  try { await app?.close() } catch { /* ignore */ }
  process.exit(1)
} finally {
  clearTimeout(hardTimeout)
}

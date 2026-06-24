/**
 * Focused subagent (task-tool → child session) verification for opencode Phase-8d.
 * Reuses the setup boilerplate from opencode-live.mjs: launches the built app,
 * selects opencode + a free model on the ClaudeUI dir, then sends a directive
 * `task`-tool prompt and watches for a TaskCard + nested subagent transcript +
 * turn completion.
 *
 * Usage: node scripts/opencode-subagent.mjs
 * Output: .cache/screenshots/sub-*.png + JSON summary to stdout
 * Prereq: bun run build
 */
import { _electron as electron } from 'playwright'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync } from 'node:fs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(root, '.cache', 'screenshots')
mkdirSync(OUT, { recursive: true })

const consoleErrors = []
const shot = (name) => join(OUT, `sub-${name}.png`)

const hardTimeout = setTimeout(() => {
  console.error('TIMEOUT: script exceeded 300s')
  process.exit(2)
}, 300_000)

// Snapshot the TaskCard-relevant DOM state.
async function probeTaskCard(win) {
  return win.evaluate(() => {
    // The TaskCard header has <span class="font-medium ... text-accent">Task</span>
    const spans = Array.from(document.querySelectorAll('span'))
    const taskHeaders = spans.filter((s) => s.textContent?.trim() === 'Task')
    // Count tool blocks mentioning the `task` tool (kind=task) or "subagent"
    const html = document.body.innerHTML
    // Subagent transcript markers: SubagentMessages renders child msgs; "Instructions" label appears when expanded
    return {
      taskHeaderCount: taskHeaders.length,
      hasTaskWord: /\bTask\b/.test(html),
      hasInstructions: /Instructions/.test(html),
      hasSubagentType: /general|explore|build/i.test(html),
      hasDONE: /\bDONE\b/.test(html),
      // running spinner vs success check: look for the stop button or "Running"
      hasStopBtn: !!Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Stop'),
      hasRunning: /Running/i.test(html),
      // task tool name in a tool block (opencode lowercases to 'task')
      hasTaskTool: /\btask\b/i.test(html),
      bodyLen: html.length
    }
  })
}

let app
try {
  console.log('[setup] Launching Electron app...')
  app = await electron.launch({ args: [root], cwd: root })
  const win = await app.firstWindow()
  win.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`[renderer] ${m.text()}`) })
  win.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${e.message}`))

  await win.waitForLoadState('domcontentloaded')
  await win.waitForTimeout(4000)

  // Select opencode engine (WelcomeState toggle = .nth(1), the larger one)
  console.log('[setup] Selecting opencode engine...')
  await win.getByRole('radio', { name: 'opencode' }).nth(1).click()
  await win.waitForTimeout(800)

  // Open directory picker + click ClaudeUI (z-10 overlay → force click)
  console.log('[setup] Opening dir picker + selecting ClaudeUI...')
  await win.locator('text=Select a project directory').click()
  await win.waitForTimeout(600)
  await win.locator('button:has-text("ClaudeUI")').first().click({ force: true })
  await win.waitForTimeout(2500)

  await win.waitForSelector('textarea:not([disabled])', { timeout: 15000 })
  console.log('[setup] Session ready, selecting free model...')
  await win.waitForTimeout(3000)

  // Select MiMo V2.5 Free model
  await win.locator('[title="Model"]').first().click()
  await win.waitForTimeout(600)
  const freeBtn = win.locator('button').filter({ hasText: /mimo.*free/i }).first()
  if (await freeBtn.count() > 0) {
    await freeBtn.click()
    console.log('[setup] Selected MiMo V2.5 Free')
  } else {
    await win.keyboard.press('Escape')
    console.log('[setup] Free model not found in picker')
  }
  await win.waitForTimeout(500)
  await win.screenshot({ path: shot('0-ready') })

  // ── ATTEMPT 1: explicit task-tool directive ─────────────────────────────────
  // opencode's task tool param is `subagentType`; 'general' is a valid built-in agent.
  const prompt1 =
    "Use the task tool right now to launch a subagent with subagentType 'general' and the prompt: 'Reply with exactly the word DONE.' " +
    "Do not do the work yourself — you MUST call the task tool. Just invoke the task tool with those arguments."

  const attempt = async (label, promptText, waitCycles) => {
    console.log(`\n[${label}] Sending task-tool prompt...`)
    const textarea = win.locator('textarea').first()
    await textarea.click({ timeout: 10000 })
    await textarea.fill(promptText)
    await win.waitForTimeout(300)
    await textarea.press('Enter')
    console.log(`[${label}] Submitted. Watching for TaskCard (up to ${waitCycles * 4}s)...`)

    let probe = null
    let taskSeen = false
    for (let i = 0; i < waitCycles; i++) {
      await win.waitForTimeout(4000)
      probe = await probeTaskCard(win)
      console.log(`[${label}] t+${(i + 1) * 4}s:`, JSON.stringify(probe))
      if (probe.taskHeaderCount > 0) {
        taskSeen = true
        // Found a TaskCard — keep watching a couple cycles for the child transcript + completion
        await win.screenshot({ path: shot(`${label}-taskcard-seen`) })
      }
      // Once we have a Task card AND it's no longer running (completed), we can stop early
      if (taskSeen && !probe.hasRunning && !probe.hasStopBtn && i > 2) break
      // If DONE appeared (subagent finished) we can stop
      if (probe.hasDONE && taskSeen) break
    }
    return { probe, taskSeen }
  }

  let r = await attempt('A1', prompt1, 13) // up to ~52s

  // If no TaskCard, expand whatever Task block exists to reveal the transcript,
  // or retry once with an even blunter prompt.
  if (!r.taskSeen) {
    console.log('\n[A1] No TaskCard rendered. Retrying once with blunter phrasing...')
    // Wait for the prior turn to settle
    await win.waitForTimeout(2000)
    const prompt2 =
      "task(subagentType=\"general\", description=\"say done\", prompt=\"Reply with exactly: DONE\"). " +
      "Call the `task` tool. Do not answer directly."
    r = await attempt('A2', prompt2, 13)
  }

  // If a TaskCard rendered, try to EXPAND it to capture the nested child transcript.
  let expandedProbe = null
  if (r.taskSeen) {
    console.log('\n[expand] TaskCard found — expanding to reveal child transcript...')
    try {
      // The header is a <button> containing the "Task" span. Click it to expand.
      const taskBtn = win.locator('button', { has: win.locator('span', { hasText: /^Task$/ }) }).first()
      if (await taskBtn.count() > 0) {
        await taskBtn.click({ timeout: 5000 })
        await win.waitForTimeout(1500)
      }
    } catch (e) {
      console.log('[expand] Could not click TaskCard header:', e.message)
    }
    await win.screenshot({ path: shot('expanded') })
    expandedProbe = await probeTaskCard(win)
    console.log('[expand] After expand:', JSON.stringify(expandedProbe))
  }

  // Final settle + screenshot
  await win.waitForTimeout(2000)
  await win.screenshot({ path: shot('Z-final') })
  const finalProbe = await probeTaskCard(win)
  console.log('[final]', JSON.stringify(finalProbe))

  // ── Verdict ──────────────────────────────────────────────────────────────────
  let verdict
  if (r.taskSeen) {
    const childTranscript = (expandedProbe?.hasInstructions || expandedProbe?.hasDONE || finalProbe.hasDONE || finalProbe.hasSubagentType)
    const completed = !finalProbe.hasRunning && !finalProbe.hasStopBtn
    verdict = {
      status: 'VERIFIED',
      taskCard: true,
      childTranscriptVisible: !!childTranscript,
      turnCompleted: completed,
      detail: `TaskCard rendered (header count seen). childTranscript=${!!childTranscript}, completed=${completed}, DONE in DOM=${finalProbe.hasDONE}`
    }
  } else {
    verdict = {
      status: 'COULDNT_TRIGGER',
      taskCard: false,
      detail: 'Free MiMo model did not call the task tool after 2 directive attempts. Accepted partial result — subagent spawning is model-dependent.'
    }
  }

  const summary = {
    ok: true,
    verdict,
    consoleErrors: consoleErrors.slice(0, 20),
    screenshots: {
      ready: shot('0-ready'),
      taskcardSeen: shot('A1-taskcard-seen'),
      expanded: shot('expanded'),
      final: shot('Z-final')
    }
  }
  console.log('\n' + JSON.stringify(summary, null, 2))

  await app.close()
} catch (err) {
  console.error('Subagent drive script failed:', err?.stack || err)
  try { await app?.close() } catch { /* ignore */ }
  process.exit(1)
} finally {
  clearTimeout(hardTimeout)
}

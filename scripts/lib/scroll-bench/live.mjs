// Live runs: real model turns (Haiku 4.5 only) on the REAL profile, in a fresh scratch cwd the
// bench creates. Safety rails, all enforced before anything is sent:
//   - no other ClaudeUI / dev-Electron instance may be running on this profile (two instances
//     writing ~/.claude/ui/*.json is last-writer-wins) unless explicitly acknowledged;
//   - the cwd must not exist or be an empty directory, and must not be home, an ancestor of home
//     or inside the app checkout;
//   - the session's model must resolve to Haiku 4.5 before the first send; every assistant line
//     of the transcript (and its sidechains) is checked during and after each turn, and anything
//     else (or no model at all) aborts the run;
//   - clean-up deletes ONLY the sessions this run created, each re-checked to live in that cwd.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchApp, setScales } from './launch.mjs'
import { s6Pass, s7, streamWindow } from './scenarios.mjs'
import { seedFiles } from './fake-anthropic.mjs'
import { SEL, sleep } from './common.mjs'
import {
  chatIsStreaming,
  log,
  logS6,
  measureRefresh,
  newSession,
  runState,
  scaleConfigs,
  sendPrompt,
  shot,
  waitForQuiet,
  waitIdle,
  writeCwdPermissions
} from './app-helpers.mjs'
import { projectKey } from '../../gen-synthetic-transcript.mjs'

const HAIKU_45 = /haiku-4-5/i
/** This bench's own checkout (also matched by the second-instance check). */
const BENCH_REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/**
 * What the live prompts need, and nothing broader. Reads and edits are confined to the scratch
 * cwd (`./**`); Glob/Grep are read-only tools that default mode already allows inside the cwd.
 * Bash is limited to single printing/listing commands — the prompts never ask for a loop, a
 * pipe, `cat` or `grep` in Bash (they use seq/echo and the Read/Grep tools), so no compound
 * command has to pass the permission check. Anything outside this list raises a permission
 * request, which the in-turn check treats as a failure (Stop), never as something to approve.
 */
const LIVE_ALLOW = [
  'Read(./**)',
  'Edit(./**)',
  'Write(./**)',
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'Agent',
  'Task',
  'Bash(ls:*)',
  'Bash(wc:*)',
  'Bash(echo:*)',
  'Bash(seq:*)',
  'Bash(sleep:*)',
  'Bash(md5sum:*)',
  'Bash(date:*)',
  'Bash(git --version)',
  'Bash(node --version)'
]

/** True when `child` is `parent` or below it (different drives are never inside). */
const isInside = (child, parent) => {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Validation errors for --live-cwd (empty list = acceptable). */
export function liveCwdProblems(cwd, appDir) {
  const p = []
  const abs = resolve(cwd)
  const home = resolve(homedir())
  if (abs === home || isInside(home, abs))
    p.push('--live-cwd must not be home or an ancestor of it')
  if (isInside(abs, resolve(appDir))) p.push('--live-cwd must not be inside the app checkout')
  if (existsSync(abs)) {
    if (!statSync(abs).isDirectory()) p.push('--live-cwd exists and is not a directory')
    else if (readdirSync(abs).length) p.push('--live-cwd must not exist or be an EMPTY directory')
  }
  return p
}

/**
 * Other ClaudeUI processes on this machine (read-only): packaged `claudui.exe`, and Electron
 * processes whose command line names the app. Returns "name pid" strings.
 */
export function otherInstances(paths = []) {
  // Match on "ClaudeUI" or on any of the given checkout paths in the command line.
  const needles = ['claudeui', ...paths.map((p) => p.toLowerCase())]
  try {
    if (process.platform === 'win32') {
      const list = needles.map((n) => `'${n.replace(/'/g, "''")}'`).join(',')
      const ps =
        `$needles = @(${list}); ` +
        "Get-CimInstance Win32_Process -Filter \"Name='claudui.exe' or Name='ClaudeUI.exe' or Name='electron.exe'\" | " +
        'Where-Object { $cl = [string]$_.CommandLine; ' +
        "($_.Name -ne 'electron.exe' -or ($needles | Where-Object { $cl.ToLower().Contains($_) })) -and " +
        "-not $cl.Contains('--type=') } | " +
        'ForEach-Object { "$($_.Name) $($_.ProcessId)" }'
      return execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' })
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
    }
    return execFileSync('ps', ['-Ao', 'pid=,args='], { encoding: 'utf8' })
      .split('\n')
      .filter((l) => {
        const low = l.toLowerCase()
        const named =
          low.includes('claudui') ||
          (low.includes('electron') && needles.some((n) => low.includes(n)))
        return named && !low.includes('--type=')
      })
      .map((l) => l.trim())
  } catch (err) {
    // A failed check must not read as "nothing running".
    return [`<process check failed: ${err?.message}>`]
  }
}

const LIVE_PROMPTS = [
  'Use the TodoWrite tool (or your task list tool) to plan this, then do it step by step: in this directory, list every file with `ls -la`, read each module-*.ts file in full with the Read tool, use the Grep tool to find "compute" across the directory, and summarise what the files contain in a markdown report with a table.',
  'Run `seq -f "row %g of the listing" 1 300` in Bash, then use Glob to find all .ts files, read module-1.ts again with the Read tool, and edit module-1.ts with the Edit tool to change the line `// edit-slot 3` into `// edit-slot 3 reviewed`. Then write a file notes.md with a long explanation (at least 40 lines) of what you changed.',
  'Launch one subagent with the Agent/Task tool (subagent_type general-purpose, model haiku) that reads module-2.ts and module-3.ts with the Read tool and reports their structure. While it works, run `git --version`, `node --version` and `ls -la` in Bash, each as its own call. Then use the Grep tool to find "export const v1" and finish with a detailed markdown summary including a code block.',
  'Do a thorough audit: for each module-*.ts file, run `wc -l` on it in Bash, Read lines 1-200 of it with the Read tool, use the Grep tool to find "compute(9" in it, and edit its `// edit-slot 5` line to `// edit-slot 5 audited`. Track progress with your todo tool. End with a long markdown report with a table per file.',
  'Generate a long listing: run `seq -f "entry %g" 1 400` in Bash, then Read notes.md, append a new section to it with the Edit tool, Glob for "**/*.md", and write a second file summary.md with at least 60 lines of markdown.',
  'Re-read every module-*.ts file in full with the Read tool, use the Grep tool to find "edit-slot" with line numbers, and produce a very detailed markdown report (several sections, tables, and code blocks) about every edit-slot line and its state.'
]

const LIVE_BG_PROMPT =
  'Launch ONE background subagent with the Agent tool: set run_in_background to true, subagent_type to general-purpose and model to haiku. Its prompt: "In the current directory make each of these a SEPARATE tool call, in order, and after each one write two sentences about its output: (1) Bash: seq -f LINE-%g-alpha 1 250 (2) Bash: sleep 4 (3) Bash: ls -la (4) Bash: seq -f LINE-%g-beta 1 300 (5) Bash: sleep 4 (6) Read module-0.ts (7) Bash: seq -f LINE-%g-gamma 1 200 (8) Bash: sleep 4 (9) Grep tool: compute in module-1.ts (10) Bash: seq -f LINE-%g-delta 1 350 (11) Bash: sleep 4 (12) Bash: wc -l module-0.ts module-1.ts module-2.ts module-3.ts. Then Read module-2.ts and finish with a short report." After launching it, reply with one sentence and stop; do not wait for it.'

/**
 * `--live-prompts long`: each turn is ~18 strictly sequential tool calls (one per message), so a
 * session grows by ~20-25 chat messages per turn and reaches hundreds within ten turns.
 */
function longLivePrompt(t) {
  const f = (k) => `module-${(t + k) % 4}.ts`
  const steps = [
    'Bash: ls -la',
    `Read ${f(0)} lines 1-200`,
    `Grep tool: "compute" in ${f(0)}`,
    `Bash: seq -f "batch ${t} row %g" 1 ${150 + t * 10}`,
    `Read ${f(1)} lines 1-150`,
    'Bash: wc -l module-0.ts module-1.ts module-2.ts module-3.ts',
    'Glob for **/*.ts',
    `Edit ${f(1)}: change the line "// edit-slot ${t % 50}" to "// edit-slot ${t % 50} pass ${t}"`,
    'Bash: seq -f "check %g" 1 200',
    `Read ${f(2)} lines 200-400`,
    'Grep tool: count "export const" in each module-*.ts',
    `Write notes-${t}.md with at least 30 lines describing what you found so far`,
    `Read notes-${t}.md`,
    `Grep tool: "edit-slot" with line numbers in ${f(1)}`,
    'Bash: seq -f "tail %g" 1 120',
    `Read ${f(3)} lines 400-550`,
    'Bash: ls -la',
    `Edit notes-${t}.md: append a section "## Pass ${t}" with five bullet points`
  ]
  return (
    'Work strictly ONE tool call per message, never in parallel, and write one short sentence before each call. ' +
    'Use your todo/task tool once at the start to list the steps. Do these steps in order: ' +
    steps.map((x, i) => `(${i + 1}) ${x}`).join('; ') +
    '. Then finish with a markdown summary of every step in a table.'
  )
}

/** `message.model` of every assistant line in the main transcript and its sidechains. */
function transcriptModels(cwd, sid) {
  const out = new Set()
  if (!sid) return out
  const dir = join(homedir(), '.claude', 'projects', projectKey(cwd))
  const files = [join(dir, `${sid}.jsonl`)]
  const sub = join(dir, sid, 'subagents')
  if (existsSync(sub))
    for (const f of readdirSync(sub)) if (f.endsWith('.jsonl')) files.push(join(sub, f))
  for (const file of files) {
    if (!existsSync(file)) continue
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('"assistant"')) continue
      try {
        const o = JSON.parse(line)
        if (o.type === 'assistant' && o.message?.model && o.message.model !== '<synthetic>')
          out.add(o.message.model)
      } catch {
        /* partial line */
      }
    }
  }
  return out
}

/**
 * Poll `check` every 2 s until `end()`. On the first failure, stop everything that may be
 * calling a model (the turn, every running agent) and remember the reason.
 */
function watchModels(win, check) {
  let stopped = false
  let reason = null
  const loop = (async () => {
    while (!stopped) {
      await sleep(2000)
      if (stopped) break
      reason = await check().catch(() => null)
      if (reason) {
        for (const sel of [
          '[data-testid="TaskEntry.stop"]',
          '[data-testid="TaskCard.stop"]',
          '[data-testid="InputBox.cancel"]'
        ])
          for (const b of await win.locator(sel).all())
            await b.click({ timeout: 2000 }).catch(() => {})
        break
      }
    }
  })()
  return {
    async end() {
      stopped = true
      await loop
      return reason
    }
  }
}

export async function runLive(o, results, env) {
  const cwd = resolve(o.liveCwd)
  const problems = liveCwdProblems(cwd, o.app)
  if (problems.length) throw new Error(problems.join('; '))
  const running = otherInstances([o.app, BENCH_REPO])
  console.error(
    '\n!!! LIVE MODE: a second, unpackaged ClaudeUI instance will run on the REAL profile. Two\n' +
      '!!! instances writing ~/.claude/ui/*.json is last-writer-wins. Close ClaudeUI first.\n'
  )
  if (running.length && !o.ackSecondInstance)
    throw new Error(
      `another ClaudeUI instance appears to be running (${running.join(', ')}); close it, or pass --ack-second-instance`
    )
  if (running.length) log(`WARNING running instances acknowledged: ${running.join(', ')}`)
  mkdirSync(cwd, { recursive: true })
  await seedFiles(cwd)
  writeCwdPermissions(cwd, LIVE_ALLOW)
  const L = await launchApp({
    app: o.app,
    real: true,
    headed: o.headed,
    smoothScrolling: o.smoothScrolling
  })
  const created = []
  // The user's real scales, put back before the app closes (the bench only ever setState()s
  // them, but nothing else may persist a settings object carrying a bench value).
  let originalScales = null
  // setSelectedModel records a per-engine sticky pick in localStorage; put the user's back.
  let stickyModel
  const models = new Set()
  try {
    await sleep(6000)
    originalScales = await L.win.evaluate(() => {
      const st = window.__claudeuiVerifier.sessionStore.getState().settings
      return { ui: st.uiFontScale, chat: st.chatFontScale }
    })
    stickyModel = await L.win.evaluate(() => localStorage.getItem('lastSelectedModel:claude'))
    const refresh = await measureRefresh(L.win)
    env.live = { mode: o.headed ? 'headed' : 'headless', ...refresh }
    if (o.smoothScrolling && !refresh.smoothScrollAnimates)
      throw new Error('smooth scrolling was requested but does not animate')
    // The Haiku 4.5 option, identified by its resolved id or its name — fail closed.
    const pick = await L.win.evaluate(() => {
      const st = window.__claudeuiVerifier.sessionStore.getState()
      return (st.availableModels ?? [])
        .filter((m) => !m.engineId || m.engineId === 'claude')
        .map((m) => ({
          value: m.value,
          resolvedModel: m.resolvedModel ?? null,
          displayName: m.displayName ?? null
        }))
    })
    const haiku = pick.find(
      (m) =>
        HAIKU_45.test(m.value) ||
        HAIKU_45.test(m.resolvedModel ?? '') ||
        /haiku 4\.5/i.test(m.displayName ?? '')
    )
    env.liveModelPick = haiku ?? null
    if (!haiku) throw new Error('no model option resolves to Haiku 4.5; refusing to send')
    const info = await newSession(L.win, cwd, haiku.value)
    created.push(info.rid)
    env.liveSession = { model: info.model, mode: info.mode }
    if (info.model !== haiku.value)
      throw new Error(`session model is ${info.model}, not the Haiku 4.5 option; refusing to send`)
    log('LIVE session', JSON.stringify(env.liveSession))
    const ctx = { win: L.win, cdp: L.cdp, refreshMs: refresh.refreshMs, trace: false }
    const scales = scaleConfigs(o)
    /** During a turn: abort on a non-Haiku model or a permission request. */
    const check = async () => {
      const st = await runState(L.win)
      if (st.sid && !created.includes(st.sid)) created.push(st.sid)
      for (const m of transcriptModels(cwd, st.sid)) models.add(m)
      const bad = [...models].filter((m) => !HAIKU_45.test(m))
      if (bad.length) return `non-Haiku model in transcript: ${bad.join(', ')}`
      if (st.pendingApprovals) return 'a permission request is pending (allow-list too narrow)'
      return null
    }
    let turnFailed = false
    for (let t = 0; t < o.liveTurns; t++) {
      const scale = scales[t % scales.length]
      await setScales(L.win, scale)
      log(`LIVE turn ${t + 1} scale ${scale.ui}/${scale.chat}`)
      const data = await streamWindow(ctx, {
        send: () =>
          sendPrompt(
            L.win,
            o.livePrompts === 'long' ? longLivePrompt(t) : LIVE_PROMPTS[t % LIVE_PROMPTS.length]
          ),
        timeoutMs: 900_000,
        check
      })
      const final = await check()
      const st = await runState(L.win)
      data.messagesAfter = st.n
      data.transcriptModels = [...models]
      // An API error (e.g. "Prompt is too long") arrives as the turn's last assistant text, not
      // as an error state.
      data.apiError = await L.win.evaluate(() => {
        const st = window.__claudeuiVerifier.sessionStore.getState()
        const msgs = st.sessions[st.activeSessionId]?.messages ?? []
        const last = [...msgs].reverse().find((m) => m.role !== 'user')
        const text = (last?.content ?? []).map((b) => b.text ?? b.errorMessage ?? '').join(' ')
        return /prompt is too long|api error|overloaded|rate limit/i.test(text)
          ? text.slice(0, 120)
          : null
      })
      const failure =
        data.aborted ??
        final ??
        (models.size === 0 ? 'no model recorded in the transcript' : null) ??
        st.error ??
        data.apiError ??
        (data.result?.sawRunning ? null : 'the turn never started')
      const row = { source: 'live-haiku', scale, scenario: 'S4', rep: t + 1 }
      if (failure) {
        results.add({ ...row, error: failure })
        log(`  live turn failed (${failure}); not escalating — stopping`)
        turnFailed = true
        break
      }
      results.add({ ...row, data })
      log(
        `  drift ${JSON.stringify({ ti: data.drift.tiNotFullyVisiblePct, max: data.drift.distMax, ep: data.drift.episodesOver250ms, followOff: data.drift.autoScrollDisarmedFrames, n: st.n, models: data.transcriptModels })}`
      )
      if (o.liveCompactEvery && (t + 1) % o.liveCompactEvery === 0 && t + 1 < o.liveTurns) {
        log('  /compact')
        await sendPrompt(L.win, '/compact')
        await sleep(3000)
        await waitIdle(L.win, 600_000)
        await sleep(2000)
      }
    }
    // Live background subagent (S6 + S7), at 1.15.
    if (!turnFailed && (o.scenarios.includes('S6') || o.scenarios.includes('S7'))) {
      const scale = { ui: 1.15, chat: 1.15 }
      await setScales(L.win, scale)
      log('LIVE bg turn')
      await sendPrompt(L.win, LIVE_BG_PROMPT)
      await sleep(3000)
      const st = await waitIdle(L.win, 300_000)
      if (st.sid && !created.includes(st.sid)) created.push(st.sid)
      const bad = await check()
      if (bad) throw new Error(bad)
      // The background agent keeps running while S6/S7 measure: keep checking its model.
      const monitor = watchModels(L.win, check)
      if (o.scenarios.includes('S6')) {
        try {
          const episodes = await s6Pass(ctx, { stillStreaming: () => chatIsStreaming(L.win) })
          results.add({
            source: 'live-haiku',
            scale,
            scenario: 'S6',
            rep: 1,
            data: { mode: 'background-subagent-collapsed', episodes }
          })
          logS6('live bg', episodes)
        } catch (err) {
          results.add({ source: 'live-haiku', scale, scenario: 'S6', rep: 1, error: String(err) })
        }
      }
      const open = L.win
        .locator('[data-testid="TaskCard"] [data-testid="TaskCard.openInPanel"]')
        .last()
      if (o.scenarios.includes('S7') && (await open.count())) {
        try {
          await open.click()
          await L.win.waitForSelector(SEL.panelBody, { timeout: 10_000 })
          await sleep(2000)
          const data = await s7(ctx, { watchMs: 30_000 })
          results.add({ source: 'live-haiku', scale, scenario: 'S7', rep: 1, data })
          await shot(L.win, o.out, 'live-s7-panel')
        } catch (err) {
          results.add({ source: 'live-haiku', scale, scenario: 'S7', rep: 1, error: String(err) })
        }
        await L.win
          .locator('[data-testid="TaskEntry.close"]')
          .first()
          .click()
          .catch(() => {})
      }
      await waitForQuiet(L.win, 300_000)
      const during = await monitor.end()
      if (during) throw new Error(during)
      const after = await check()
      if (after) throw new Error(after)
    }
  } finally {
    env.liveTranscriptModels = [...models]
    if (!o.keepLive)
      env.liveCleanup = await cleanupLive(L.win, cwd, created).catch((e) => ({ error: String(e) }))
    if (originalScales) await setScales(L.win, originalScales).catch(() => {})
    if (stickyModel !== undefined)
      await L.win
        .evaluate((v) => {
          if (v === null) localStorage.removeItem('lastSelectedModel:claude')
          else localStorage.setItem('lastSelectedModel:claude', v)
        }, stickyModel)
        .catch(() => {})
    await L.close()
  }
}

/**
 * Remove ONLY the sessions this run created: from recents (SessionItem.remove), then delete them
 * (context menu -> Delete -> confirm). Each delete target must be listed under the live cwd's
 * directory group, whose header title must equal that cwd, and, when the store still holds the
 * session, its cwd must equal it too. Anything else in that group is left alone.
 */
async function cleanupLive(win, cwd, ids) {
  const norm = (p) =>
    String(p ?? '')
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')
      .toLowerCase()
  const out = { removedFromRecents: [], deleted: [], skipped: [], remainingInRecents: null }
  for (const id of ids) {
    const item = win.locator(`[data-testid="SessionItem"][data-id="${id}"]`).first()
    if (await item.count()) {
      await item.hover()
      const rm = item.locator('[data-testid="SessionItem.remove"]')
      if (await rm.count()) {
        await rm.click()
        out.removedFromRecents.push(id)
        await sleep(500)
      }
    }
  }
  const key = projectKey(cwd)
  const dir = win.locator(`[data-testid="DirectoryItem"][data-id="${key}"]`)
  if (await dir.count()) {
    const title = await dir.locator('span[title]').first().getAttribute('title')
    if (norm(title) !== norm(cwd)) {
      out.skipped.push(`directory group title ${title} does not match the live cwd`)
      return out
    }
    if (!(await dir.locator('[data-testid="SessionItem"]').count())) {
      await dir.locator('> div').first().click()
      await sleep(800)
    }
    for (const id of ids) {
      const it = dir.locator(`[data-testid="SessionItem"][data-id="${id}"]`).first()
      if (!(await it.count())) continue
      const storeCwd = await win.evaluate(
        (id) => window.__claudeuiVerifier.sessionStore.getState().sessions[id]?.cwd ?? null,
        id
      )
      if (storeCwd !== null && norm(storeCwd) !== norm(cwd)) {
        out.skipped.push(`${id}: store cwd differs`)
        continue
      }
      await it.click({ button: 'right' })
      await win.locator('[data-testid="SessionItem.delete"]').click({ timeout: 5000 })
      await win.locator('[data-testid="DeleteConfirmModal.confirm"]').click({ timeout: 5000 })
      out.deleted.push(id)
      await sleep(1500)
    }
  }
  out.remainingInRecents = await win.evaluate((ids) => {
    const st = window.__claudeuiVerifier.sessionStore.getState()
    return (st.recentSessionIds ?? []).filter((x) => ids.includes(x))
  }, ids)
  out.dirStillListed = (await dir.count()) > 0
  return out
}

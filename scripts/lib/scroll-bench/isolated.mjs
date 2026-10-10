// Isolated runs: transcript scenarios (S1/S2/S3/H, S5 mobile) and the fake-endpoint streaming
// scenarios (S4/S6/S7), all against a scratch home — nothing of the real profile is touched.
import { cpSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { launchApp, setScales } from './launch.mjs'
import { openSession } from './session.mjs'
import {
  calibrate,
  calibrationStats,
  heights,
  s1,
  s2,
  s3,
  s6Pass,
  s7,
  streamWindow
} from './scenarios.mjs'
import { startFakeAnthropic, seedFiles } from './fake-anthropic.mjs'
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
import { writeSyntheticTranscript } from '../../gen-synthetic-transcript.mjs'

/** Scenario repeat caps (each streaming repeat costs minutes of real streaming). */
export const S6_MAX_REPEATS = 3
export const S7_MAX_REPEATS = 2

/** The fake endpoint's scratch cwd is the bench's own: every scripted tool may run there. */
const FAKE_ALLOW = [
  'Bash',
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'TodoWrite',
  'Agent',
  'Task',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet'
]

/**
 * Run a scenario function and record its row. A throw becomes an ERROR row (never data); the
 * caller's exit code reflects it.
 */
async function record(results, L, out, row, fn) {
  try {
    const data = await fn()
    results.add({ ...row, data })
    return data
  } catch (err) {
    log(`  ERROR ${row.scenario}: ${err?.message}`)
    results.add({ ...row, error: String(err?.message ?? err).slice(0, 400) })
    await shot(L.win, out, `error-${results.rows.length}`)
    return null
  }
}

/** Environment probe shared by every launch; aborts when smooth scrolling should animate but does not. */
async function probeEnvironment(L, o, env, key) {
  const refresh = await measureRefresh(L.win)
  env[key] = {
    mode: o.headed ? 'headed' : 'headless (off-screen shown window)',
    ...refresh,
    smoothScrollingRequested: o.smoothScrolling,
    // launchApp points an isolated run at <home>/electron-user-data.
    userDataIsolated: /[\\/]electron-user-data$/.test(L.userData ?? ''),
    strippedEnvVars: L.strippedEnv
  }
  if (!env[key].userDataIsolated)
    throw new Error(
      'the isolated launch is using the shared Electron userData (no --user-data-dir)'
    )
  if (o.smoothScrolling && !refresh.smoothScrollAnimates)
    throw new Error(
      `smooth scrolling was requested but does not animate (${refresh.smoothScrollFrames} frames) — results would not match a local desktop`
    )
  return refresh
}

export async function runIsolated(o, results, env, home) {
  const parking = await writeSyntheticTranscript({
    messages: 4,
    seed: 99,
    home,
    cwd: join(home, 'work', 'parking')
  })
  const history = []
  for (const src of o.sessions) {
    if (src.startsWith('synthetic:')) {
      const n = Number(src.slice(10))
      const m = await writeSyntheticTranscript({
        messages: n,
        seed: 7,
        home,
        cwd: join(home, 'work', `synthetic-${n}`),
        images: true
      })
      history.push({
        source: src,
        projectKey: m.projectKey,
        sessionId: m.sessionId,
        findTerm: o.findTerm || m.marker
      })
    } else if (src.startsWith('copy:')) {
      const file = resolve(src.slice(5))
      const sid = basename(file, '.jsonl')
      const key = basename(dirname(file))
      const dest = join(home, '.claude', 'projects', key)
      mkdirSync(dest, { recursive: true })
      cpSync(file, join(dest, `${sid}.jsonl`))
      const side = join(dirname(file), sid)
      if (existsSync(side) && statSync(side).isDirectory())
        cpSync(side, join(dest, sid), { recursive: true })
      // Label by size only — the bench never prints a real transcript's content or path.
      history.push({
        source: `real-${Math.round(statSync(file).size / 1048576)}MB`,
        projectKey: key,
        sessionId: sid,
        findTerm: o.findTerm || 'error'
      })
    }
  }
  const wantFake =
    o.sessions.includes('fake') && ['S4', 'S6', 'S7'].some((sc) => o.scenarios.includes(sc))
  let fake = null
  let fakeCwd = null
  if (wantFake) {
    fakeCwd = join(home, 'work', 'stream')
    const files = await seedFiles(fakeCwd)
    writeCwdPermissions(fakeCwd, FAKE_ALLOW)
    fake = await startFakeAnthropic({
      cwd: fakeCwd,
      files,
      stepsPerTurn: o.steps,
      bgSteps: 20,
      bgSleep: 1
    })
    mkdirSync(join(home, '.claude', 'ui', 'vendors'), { recursive: true })
    writeFileSync(
      join(home, '.claude', 'ui', 'vendors', 'anthropic.json'),
      JSON.stringify({
        endpoint: { enabled: true, baseUrl: fake.url, authToken: 'bench-fake-endpoint' }
      })
    )
    log('FAKE endpoint listening on 127.0.0.1')
  }

  const desktopScenarios = o.scenarios.filter((s) => ['S1', 'S2', 'S3', 'H', 'E'].includes(s))
  if ((desktopScenarios.length && history.length) || fake) {
    const L = await launchApp({
      app: o.app,
      home,
      headed: o.headed,
      smoothScrolling: o.smoothScrolling,
      extraEnv: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
    })
    try {
      await sleep(4000)
      const refresh = await probeEnvironment(L, o, env, 'desktop')
      env.display = await L.app.evaluate(({ screen }) =>
        screen
          .getAllDisplays()
          .map((d) => ({ hz: d.displayFrequency, scaleFactor: d.scaleFactor, size: d.size }))
      )
      env.window = await L.win.evaluate(() => ({ innerWidth, innerHeight, dpr: devicePixelRatio }))
      log('ENV', JSON.stringify({ ...env.desktop, display: env.display }))
      for (const h of history) {
        const ctx = {
          win: L.win,
          cdp: L.cdp,
          refreshMs: refresh.refreshMs,
          trace: o.trace,
          touch: false,
          findTerm: h.findTerm,
          fresh: async () => {
            await openSession(L.win, parking)
            await openSession(L.win, h)
          }
        }
        for (const scale of scaleConfigs(o)) {
          await setScales(L.win, scale)
          await sleep(500)
          for (const sc of desktopScenarios) {
            const reps = sc === 'H' || sc === 'E' ? 1 : o.repeat
            for (let rep = 1; rep <= reps; rep++) {
              log(`${h.source} scale ${scale.ui}/${scale.chat} ${sc} rep ${rep}`)
              const fn = {
                S1: s1,
                S2: s2,
                S3: s3,
                H: heights,
                E: async (c) => {
                  const cal = await calibrate(c)
                  return { ...cal, stats: calibrationStats(cal) }
                }
              }[sc]
              const row = { source: h.source, scale, scenario: sc === 'H' ? 'heights' : sc, rep }
              const data = await record(results, L, o.out, row, () => fn(ctx))
              if (data && sc === 'S1')
                log(
                  `  reached=${data.reached} clicks=${data.clicks.length} residuals=${data.clicks.map((c) => c.residual).join(',')}`
                )
            }
          }
        }
      }
      if (fake) await runFakeStreaming(o, results, env, L, fakeCwd, fake, refresh)
      env.consoleErrors = L.consoleErrors.slice(0, 20)
    } finally {
      await L.close()
      if (fake) {
        env.fakeStats = fake.stats
        await fake.close()
      }
    }
  }

  if (o.scenarios.includes('S5') && history.length) {
    const L = await launchApp({
      app: o.app,
      home,
      headed: o.headed,
      profile: o.profile,
      smoothScrolling: o.smoothScrolling
    })
    try {
      await sleep(4000)
      const refresh = await probeEnvironment(L, o, env, 'mobile')
      env.mobile.profile = o.profile
      for (const h of history) {
        const ctx = {
          win: L.win,
          cdp: L.cdp,
          refreshMs: refresh.refreshMs,
          trace: o.trace,
          touch: true,
          findTerm: h.findTerm,
          fresh: async () => {
            await openMobile(L.win, parking)
            await openMobile(L.win, h)
          }
        }
        for (const ui of [1, 1.1]) {
          await setScales(L.win, { ui, chat: ui })
          for (let rep = 1; rep <= o.repeat; rep++)
            for (const [name, fn] of [
              ['S5-S1', s1],
              ['S5-S2', s2]
            ]) {
              log(`${h.source} mobile scale ${ui} ${name} rep ${rep}`)
              const row = { source: h.source, scale: { ui, chat: ui }, scenario: name, rep }
              await record(results, L, o.out, row, () => fn(ctx))
            }
        }
      }
    } finally {
      await L.close()
    }
  }
}

/**
 * Mobile: the sidebar is a drawer. Click path: `TopBar.toggleSidebar` opens it, then the same
 * DirectoryItem -> SessionItem clicks as desktop; selecting a session closes the drawer again.
 */
async function openMobile(win, target) {
  let last = null
  const toggle = () => win.locator('[data-testid="TopBar.toggleSidebar"]').first()
  for (let attempt = 0; attempt < 3; attempt++) {
    const item = win.locator(`[data-testid="SessionItem"][data-id="${target.sessionId}"]`).first()
    const dir = win.locator(`[data-testid="DirectoryItem"][data-id="${target.projectKey}"]`).first()
    const drawerOpen =
      (await item.isVisible().catch(() => false)) || (await dir.isVisible().catch(() => false))
    if (!drawerOpen) {
      await toggle().click({ timeout: 5000 })
      await sleep(800)
    }
    try {
      const r = await openSession(win, { ...target, timeout: 40_000 })
      await sleep(800)
      // The drawer must not stay over the chat (input would land on it).
      if (await dir.isVisible().catch(() => false)) {
        await toggle()
          .click()
          .catch(() => {})
        await sleep(800)
      }
      return r
    } catch (err) {
      last = err
    }
  }
  throw last
}

async function runFakeStreaming(o, results, env, L, cwd, fake, refresh) {
  const win = L.win
  const info = await newSession(win, cwd, null)
  env.fakeSession = { engine: info.engine, model: info.model, mode: info.mode }
  log('FAKE session', JSON.stringify(env.fakeSession))
  const ctx = { win, cdp: L.cdp, refreshMs: refresh.refreshMs, trace: false }
  let turn = 0
  let checkedEndpoint = false
  /** The scripted endpoint must have answered: a turn served by anything else is not this bench. */
  const assertEndpointUsed = () => {
    if (checkedEndpoint) return
    checkedEndpoint = true
    const n = fake.stats.paths['/v1/messages'] ?? 0
    if (!n)
      throw new Error('the fake endpoint received 0 /v1/messages requests after the first turn')
  }
  const scales = scaleConfigs(o)
  if (o.scenarios.includes('S4')) {
    // Warm-up turns grow the session and are NOT reported; then each scale config gets `turns`
    // measured turns on an already-large session. The TI-hidden screenshot is taken in a warm-up
    // turn only, so no reported window contains a screenshot.
    const plan = [
      ...Array.from({ length: o.warmupTurns }, () => ({ scale: scales[0], warmup: true })),
      ...scales.flatMap((s) => Array.from({ length: o.turns }, () => ({ scale: s, warmup: false })))
    ]
    for (const { scale, warmup } of plan) {
      turn++
      await setScales(win, scale)
      await sleep(300)
      log(`S4 fake turn ${turn} scale ${scale.ui}/${scale.chat}${warmup ? ' (warm-up)' : ''}`)
      const t = turn
      const row = { source: 'fake-stream', scale, scenario: 'S4', rep: turn }
      const data = await record(results, L, o.out, row, async () => {
        // S4's TypingIndicator metrics need the test id: without it they would print as "–".
        if (o.buildTestIds && !o.buildTestIds['ChatPanel.typingIndicator'])
          throw new Error('the build has no data-testid="ChatPanel.typingIndicator"; S4 cannot run')
        const d = await streamWindow(ctx, {
          send: () => sendPrompt(win, `[[bench-turn ${t}]] Work through the plan for batch ${t}.`),
          screenshot: warmup ? (name) => shot(win, o.out, `fake-${name}-${t}`) : null
        })
        assertEndpointUsed()
        d.messagesAfter = (await runState(win)).n
        d.warmup = warmup
        return d
      })
      if (!data) break
      log(
        `  drift ${JSON.stringify({ ti: data.drift.tiNotFullyVisiblePct, max: data.drift.distMax, ep: data.drift.episodesOver250ms, followOff: data.drift.autoScrollDisarmedFrames, n: data.messagesAfter })}`
      )
    }
  }
  // S6/S7 need a chat that can scroll well past a viewport: grow it with unmeasured turns first.
  if (o.scenarios.includes('S6') || o.scenarios.includes('S7')) {
    for (let i = 0; i < 8; i++) {
      const tall = await win.evaluate((sel) => {
        const el = document.querySelector(sel)
        return el.scrollHeight > 8 * el.clientHeight
      }, SEL.scroller)
      if (tall) break
      turn++
      log(`filler turn ${turn}`)
      await sendPrompt(win, `[[bench-turn ${turn}]] Work through the plan for batch ${turn}.`)
      await sleep(2000)
      await waitIdle(win)
      assertEndpointUsed()
    }
  }
  if (o.scenarios.includes('S6')) {
    for (const ui of o.s6Scales) {
      const scale = { ui, chat: ui }
      await setScales(win, scale)
      for (let rep = 1; rep <= Math.min(o.repeat, S6_MAX_REPEATS); rep++) {
        // (a) background subagent streaming, main idle.
        turn++
        log(`S6 bg turn ${turn} scale ${ui} rep ${rep}`)
        await sendPrompt(win, `[[bench-bg ${turn}]] Start the background survey ${turn}.`)
        await sleep(1500)
        await waitIdle(win, 120_000)
        let ok = false
        for (let i = 0; i < 20 && !ok; i++) ok = await chatIsStreaming(win)
        const mainState = (await runState(win)).state
        // Two views of the same background agent: its TaskCard collapsed (the default), then
        // expanded so its stream renders inline in the chat.
        for (const view of ['collapsed', 'expanded']) {
          if (view === 'expanded') {
            await win
              .locator('[data-testid="TaskCard"]')
              .last()
              .locator('[data-testid="TaskCard.expand"]')
              .first()
              .click()
              .catch(() => {})
            await sleep(800)
          }
          const row = { source: 'fake-stream', scale, scenario: 'S6', rep }
          const data = await record(results, L, o.out, row, async () => {
            if (!ok) throw new Error('background stream never reached the chat')
            const episodes = await s6Pass(ctx, { stillStreaming: () => chatIsStreaming(win) })
            return {
              mode: `background-subagent-${view}`,
              mainStateAtStart: mainState,
              episodes
            }
          })
          if (data) logS6(`bg ${view}`, data.episodes)
          if (rep === 1) await shot(win, o.out, `s6-bg-${view}-${ui}`)
        }
        // Let that subagent finish so the next pass starts from a quiet chat.
        await waitForQuiet(win, 240_000)
        // (b) the MAIN agent streaming (no subagent).
        turn++
        log(`S6 main turn ${turn} scale ${ui} rep ${rep}`)
        await sendPrompt(win, `[[bench-turn ${turn}]] Work through the plan for batch ${turn}.`)
        await sleep(2500)
        const row = { source: 'fake-stream', scale, scenario: 'S6', rep }
        const data = await record(results, L, o.out, row, async () => ({
          mode: 'main-streaming',
          episodes: await s6Pass(ctx, {
            stillStreaming: async () => (await runState(win)).state === 'running'
          })
        }))
        if (data) logS6('main', data.episodes)
        await waitIdle(win)
        await waitForQuiet(win, 120_000)
      }
    }
  }
  if (o.scenarios.includes('S7')) {
    // Click path: the background agent's TaskCard -> "Open in panel" (TaskCard.openInPanel) opens
    // the right-hand TaskDetailPanel with one TaskEntry for that agent.
    for (const ui of o.s6Scales) {
      const scale = { ui, chat: ui }
      await setScales(win, scale)
      for (let rep = 1; rep <= Math.min(o.repeat, S7_MAX_REPEATS); rep++) {
        turn++
        log(`S7 bg turn ${turn} scale ${ui} rep ${rep}`)
        await sendPrompt(win, `[[bench-bgbash ${turn}]] Start the background survey ${turn}.`)
        await sleep(1500)
        await waitIdle(win, 120_000)
        const row = { source: 'fake-stream', scale, scenario: 'S7', rep }
        const data = await record(results, L, o.out, row, async () => {
          const open = win
            .locator('[data-testid="TaskCard"] [data-testid="TaskCard.openInPanel"]')
            .last()
          await open.waitFor({ timeout: 30_000 })
          await open.click()
          await win.waitForSelector(SEL.panelBody, { timeout: 10_000 })
          await sleep(3000) // let the subagent's first rounds land in the panel
          return s7(ctx, { watchMs: 30_000 })
        })
        if (data)
          log(
            `  panel ${JSON.stringify({ follow: data.followSource, below: data.watch.framesBelowBottomPct, max: data.watch.distMax, ep: data.watch.episodesOver250ms, flips: data.watch.followingFlipsWithoutInput, btn: { reached: data.button.reached, stayed: data.button.stayedAtBottomAfterReach, f: data.button.followingAtEnd } })}`
          )
        if (rep === 1) await shot(win, o.out, `s7-panel-${ui}`)
        await win
          .locator('[data-testid="TaskEntry.close"]')
          .first()
          .click()
          .catch(() => {})
        await waitForQuiet(win, 240_000)
      }
    }
  }
}

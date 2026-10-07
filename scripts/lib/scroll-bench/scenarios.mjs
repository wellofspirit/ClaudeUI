// The bench scenarios (docs/chat-scroll-spec.md, step 1). Each takes a context
//   { win, cdp, refreshMs, trace: boolean, fresh: () => Promise<void>, touch: boolean, findTerm }
// and returns plain JSON, or THROWS: a failed measurement window is an error row, never data.
// `fresh()` re-mounts the target transcript (switch away and back), so every
// `content-visibility: auto` wrapper starts as a never-rendered 100 px placeholder again.
import { SEL, sleep } from './common.mjs'
import { settle } from './session.mjs'
import { startTrace } from './trace.mjs'
import {
  clickMarked,
  clickScrollToBottom,
  gesture,
  scrollerPoint,
  touchScroll,
  wheelBurst,
  wheelNotch
} from './inputs.mjs'
import {
  driftStats,
  frameStats,
  loafSummary,
  metricsDelta,
  metricsMap,
  round,
  thinGeo
} from './stats.mjs'

/**
 * A measurement window: rAF frames (+ geometry), LoAF, CDP metric deltas, optional trace. If the
 * body throws, the sampler and trace are stopped and the error is RE-THROWN (the caller records an
 * error row; nothing measured in a broken window is aggregated).
 */
async function measure(ctx, { geometry = false, trace = ctx.trace, target = 'chat' }, body) {
  await ctx.cdp.send('Performance.enable').catch(() => {})
  const m0 = metricsMap(await ctx.cdp.send('Performance.getMetrics'))
  const tr = trace ? await startTrace(ctx.cdp) : null
  await ctx.win.evaluate(
    ({ geometry, target }) => window.__scrollBench.start({ geometry, target }),
    { geometry, target }
  )
  let bodyResult
  let failure = null
  try {
    bodyResult = await body()
  } catch (err) {
    failure = err
  }
  const raw = await ctx.win.evaluate(() => window.__scrollBench.stop())
  const traceSummary = tr
    ? await tr.stop().catch((e) => ({ usable: false, error: String(e) }))
    : null
  if (failure) throw failure
  const m1 = metricsMap(await ctx.cdp.send('Performance.getMetrics'))
  return {
    result: bodyResult,
    durationMs: round(raw.durationMs),
    frames: frameStats(raw.frames, ctx.refreshMs),
    loaf: loafSummary(raw.loaf),
    loafSupported: raw.loafSupported,
    followSource: raw.followSource,
    metrics: metricsDelta(m0, m1),
    trace: traceSummary,
    geo: geometry ? raw.geo : undefined
  }
}

const geometryNow = (win, target = 'chat') =>
  win.evaluate((t) => window.__scrollBench.geometry(t), target)

/**
 * Leave the bottom the way a USER does — one upward wheel notch over the chat — before any
 * scripted positioning. A post-fix build keeps following until user intent and re-pins the bottom
 * on the next content growth, so a scripted jump made while following is undone (S1 would start
 * at the bottom). In a pre-fix build the notch disarms auto-scroll exactly as the scripted jump
 * itself did, so both builds start the same scenario from the same state.
 */
async function leaveBottom(ctx) {
  await wheelNotch(ctx.cdp, ctx.win, await scrollerPoint(ctx.win), -100)
  await sleep(150)
}

async function scrollToFraction(win, frac) {
  return win.evaluate(
    ({ sel, frac }) => {
      const el = document.querySelector(sel)
      el.scrollTop = frac * (el.scrollHeight - el.clientHeight)
      return el.scrollTop
    },
    { sel: SEL.scroller, frac }
  )
}

// ── S1: scroll-to-bottom from the top ──────────────────────────────────────────────────────

export async function s1(ctx) {
  await ctx.fresh()
  await leaveBottom(ctx)
  await scrollToFraction(ctx.win, 0)
  await sleep(800)
  await settle(ctx.win, { stableMs: 300, timeout: 5000 })
  const clicks = []
  let reached = false
  let stuck = null
  const m = await measure(ctx, { geometry: true }, async () => {
    const tStart = Date.now()
    for (let i = 0; i < 10; i++) {
      const before = await geometryNow(ctx.win)
      const clicked = await clickScrollToBottom(ctx.win)
      if (!clicked) {
        stuck = { reason: 'button hidden', dist: round(before.dist, 2) }
        break
      }
      const s = await settle(ctx.win, { stableMs: 400, timeout: 6000 })
      const after = await geometryNow(ctx.win)
      const frozenTarget = before.sh - before.ch
      clicks.push({
        distBefore: round(before.dist),
        shBefore: round(before.sh),
        shAfter: round(after.sh),
        shGrowth: round(after.sh - before.sh),
        stAfter: round(after.st, 2),
        targetAtClick: round(frozenTarget, 2),
        // The animation stopped where scrollHeight WAS at click time while it grew behind it.
        stoppedAtFrozenTarget: Math.abs(after.st - frozenTarget) <= 2 && after.sh - before.sh > 2,
        residual: round(after.dist, 2),
        // Time until scrollTop and scrollHeight stopped changing (wall clock).
        settleMs: round(s.ms)
      })
      if (after.dist <= 2) {
        reached = true
        break
      }
    }
    return { totalMs: Date.now() - tStart }
  })
  const geo = m.geo ?? []
  delete m.geo
  return {
    reached,
    clicksNeeded: reached ? clicks.length : null,
    clicks,
    stuck,
    finalResidual: clicks.length ? clicks[clicks.length - 1].residual : null,
    animationFrames: geo.some((g) => g.animating !== null)
      ? geo.filter((g) => g.animating === 1).length
      : null,
    ...m
  }
}

// ── S2: wheel / gesture / touch scroll through the middle ──────────────────────────────────

function s2Steps(touch) {
  const src = touch ? 'touch' : 'mouse'
  return [
    { name: 'wheel-down', kind: 'wheel', ticks: 16, deltaY: 100, gapMs: 60 },
    { name: 'wheel-up', kind: 'wheel', ticks: 16, deltaY: -100, gapMs: 60 },
    { name: `gesture-down-${src}`, kind: 'gesture', distance: 3000, speed: 1200, source: src },
    {
      name: `gesture-up-${src}`,
      kind: 'gesture',
      distance: 3000,
      speed: 1200,
      source: src,
      down: false
    },
    {
      name: 'fling-down-touch',
      kind: 'gesture',
      distance: 260,
      speed: 4000,
      source: 'touch',
      down: true,
      fling: true
    }
  ]
}

/** Touch emulation on/off OUTSIDE the measured window (the media-feature flip restyles the page). */
async function setTouch(ctx, on) {
  await ctx.cdp.send(
    'Emulation.setTouchEmulationEnabled',
    on ? { enabled: true, maxTouchPoints: 5 } : { enabled: false }
  )
  await sleep(500)
}

export async function s2(ctx) {
  await ctx.fresh()
  const passes = []
  let startTop = null
  for (const pass of ['first-exposure', 'revisit']) {
    await leaveBottom(ctx)
    if (startTop === null) startTop = await scrollToFraction(ctx.win, 0.5)
    else
      await ctx.win.evaluate(
        ({ sel, top }) => {
          document.querySelector(sel).scrollTop = top
        },
        { sel: SEL.scroller, top: startTop }
      )
    await sleep(600)
    await settle(ctx.win, { stableMs: 250, timeout: 4000 })
    const steps = []
    for (const step of s2Steps(ctx.touch)) {
      const touchStep = step.source === 'touch' && !ctx.touch
      if (touchStep) await setTouch(ctx, true)
      // Recomputed every step: the previous step moved the content under the pointer, and a
      // nested scroller there would absorb the input.
      const pt = await scrollerPoint(ctx.win)
      const g0 = await geometryNow(ctx.win)
      let m
      try {
        m = await measure(ctx, {}, async () => {
          if (step.kind === 'wheel') await wheelBurst(ctx.cdp, ctx.win, pt, step)
          else if (step.source === 'touch') await touchScroll(ctx.cdp, ctx.win, pt, step)
          else await gesture(ctx.cdp, ctx.win, pt, step)
          // Let the fling / smooth animation finish inside the window.
          await sleep(step.fling ? 1500 : 400)
        })
      } finally {
        if (touchStep) await setTouch(ctx, false)
      }
      const g1 = await geometryNow(ctx.win)
      steps.push({
        step: step.name,
        point: pt,
        // |scrolledPx| < 5 = the input did not scroll the chat; the report excludes such steps.
        scrolledPx: round(g1.st - g0.st),
        shDelta: round(g1.sh - g0.sh),
        ...m
      })
    }
    passes.push({ pass, steps })
  }
  return { startTop: round(startTop), passes }
}

// ── S3: jump-to-section (scrollbar jumps + find-in-chat) ───────────────────────────────────

export async function s3(ctx) {
  await ctx.fresh()
  const jumps = []
  for (const frac of [0.15, 0.4, 0.65, 0.9]) {
    await leaveBottom(ctx)
    const m = await measure(ctx, { geometry: true }, async () => {
      // Instant jump (a scrollbar-thumb release), then the anchor under the viewport centre is
      // tracked through the settle: its displacement is the visible "content jumped" distance.
      const probe = await ctx.win.evaluate(
        ({ sel, anchorSel, frac }) =>
          new Promise((resolve) => {
            const el = document.querySelector(sel)
            el.scrollTop = frac * (el.scrollHeight - el.clientHeight)
            const set = { st: el.scrollTop, sh: el.scrollHeight, ch: el.clientHeight }
            requestAnimationFrame(() => {
              const r = el.getBoundingClientRect()
              const z = el.offsetWidth ? r.width / el.offsetWidth : 1
              const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
              const anchor = hit?.closest(anchorSel)
              window.__benchJumpAnchor = anchor ?? null
              resolve({ ...set, z, anchorTop: anchor ? anchor.getBoundingClientRect().top : null })
            })
          }),
        { sel: SEL.scroller, anchorSel: SEL.anchor, frac }
      )
      const s = await settle(ctx.win, { stableMs: 250, timeout: 5000 })
      const after = await ctx.win.evaluate((sel) => {
        const el = document.querySelector(sel)
        const a = window.__benchJumpAnchor
        return {
          st: el.scrollTop,
          sh: el.scrollHeight,
          ch: el.clientHeight,
          anchorTop: a && a.isConnected ? a.getBoundingClientRect().top : null
        }
      }, SEL.scroller)
      return { probe, after, settleMs: s.ms, stable: s.stable }
    })
    const { probe, after } = m.result
    const geo = m.geo ?? []
    delete m.geo
    let lastChange = 0
    for (let i = 1; i < geo.length; i++)
      if (geo[i].st !== geo[i - 1].st || geo[i].sh !== geo[i - 1].sh) lastChange = geo[i].t
    jumps.push({
      frac,
      timeToStableMs: round(lastChange),
      shDelta: round(after.sh - probe.sh),
      stDrift: round(after.st - probe.st),
      thumbRatioSet: round(probe.st / (probe.sh - probe.ch), 4),
      thumbRatioSettled: round(after.st / (after.sh - after.ch), 4),
      anchorShiftPx:
        probe.anchorTop != null && after.anchorTop != null
          ? round((after.anchorTop - probe.anchorTop) / probe.z)
          : null,
      ...m,
      result: undefined
    })
  }
  const find = await findJumps(ctx)
  return { jumps, find }
}

async function findJumps(ctx, maxSteps = 6) {
  const term = ctx.findTerm
  // ChatPanel's Ctrl+F handler listens on window: drop focus from whatever has it (no click on
  // the content, which could expand or select something).
  await ctx.win.evaluate(() => document.activeElement?.blur?.())
  await ctx.win.keyboard.press('Control+f')
  await ctx.win.waitForSelector('[data-testid="ChatSearchOverlay.query"]', { timeout: 5000 })
  await ctx.win.locator('[data-testid="ChatSearchOverlay.query"]').fill(term)
  await sleep(500)
  const total = await ctx.win.evaluate(() => CSS.highlights.get('chat-search')?.size ?? 0)
  const steps = []
  for (let i = 0; i < Math.min(maxSteps, total); i++) {
    const m = await measure(ctx, { geometry: true }, async () => {
      await ctx.win.evaluate(() => window.__scrollBench.markInput())
      await ctx.win.locator('[data-testid="ChatSearchOverlay.query"]').press('Enter')
      // Per frame: the current match's rect until it holds still for 100 ms (cap 3 s).
      return ctx.win.evaluate(
        (sel) =>
          new Promise((resolve) => {
            const el = document.querySelector(sel)
            const t0 = performance.now()
            let last = null
            let since = t0
            let moves = 0
            const step = (now) => {
              const cur = CSS.highlights.get('chat-search-current')
              const range = cur ? [...cur][0] : null
              const top = range ? Math.round(range.getBoundingClientRect().top) : null
              if (top !== last) {
                if (top !== null && last !== null) moves++
                last = top
                since = now
              }
              const elapsed = now - t0
              const settled = top !== null && now - since >= 100
              if (settled || elapsed > 3000) {
                const box = el.getBoundingClientRect()
                let hit = false
                let visible = false
                if (range) {
                  const r = range.getBoundingClientRect()
                  visible = r.top >= box.top && r.bottom <= box.bottom
                  const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
                  hit =
                    !!h &&
                    (h.contains(range.startContainer) || range.startContainer.parentElement === h)
                }
                resolve({
                  stableMs: Math.round(since - t0),
                  settled,
                  moves,
                  whollyVisible: visible,
                  elementFromPointHit: hit,
                  highlights: CSS.highlights.get('chat-search')?.size ?? 0,
                  flash: !!document.querySelector('[data-testid="ChatSearchOverlay.flash"]')
                })
              } else requestAnimationFrame(step)
            }
            requestAnimationFrame(step)
          }),
        SEL.scroller
      )
    })
    const geo = m.geo ?? []
    delete m.geo
    steps.push({
      i: i + 1,
      scrollJumpPx: geo.length ? round(geo[geo.length - 1].st - geo[0].st) : null,
      ...m.result,
      frames: m.frames,
      loaf: m.loaf,
      metrics: m.metrics,
      trace: m.trace
    })
  }
  await ctx.win.keyboard.press('Escape').catch(() => {})
  await sleep(300)
  return { term, totalMatches: total, steps }
}

// ── S4: streaming auto-scroll (no input) ───────────────────────────────────────────────────

const runStateNow = (win) =>
  win.evaluate(() => {
    const st = window.__claudeuiVerifier.sessionStore.getState()
    return st.sessions[st.activeSessionId]?.status?.state === 'running' ? 1 : 0
  })

/**
 * Sample geometry every frame while the active session runs, with no input. `send()` starts the
 * turn; the window closes when the session is idle again (or `timeoutMs`). The poll reads only the
 * store (no layout). `screenshot` (warm-up turns only — never inside a reported window) captures
 * the first frame with the TypingIndicator hidden. `check()` runs every ~2 s and returns a reason
 * string to abort the turn (the bench then presses Stop).
 */
export async function streamWindow(ctx, { send, timeoutMs = 600_000, screenshot, check }) {
  const shots = []
  let aborted = null
  const rearm = await rearmFollow(ctx, 'chat')
  const m = await measure(ctx, { geometry: true, trace: false }, async () => {
    await send()
    const t0 = Date.now()
    let sawRunning = false
    let lastCheck = 0
    while (Date.now() - t0 < timeoutMs) {
      await sleep(400)
      const run = await runStateNow(ctx.win)
      if (run === 1) sawRunning = true
      if (screenshot && !shots.length && run === 1) {
        const g = await geometryNow(ctx.win)
        if (g.ti === 0) shots.push(await screenshot('ti-hidden'))
      }
      if (check && Date.now() - lastCheck > 2000) {
        lastCheck = Date.now()
        aborted = await check()
        if (aborted) {
          await ctx.win
            .locator('[data-testid="InputBox.cancel"]')
            .click({ timeout: 3000 })
            .catch(() => {})
          break
        }
      }
      if (sawRunning && run === 0) break
      // A turn that never starts (an API error answered at once, a refused send) is not
      // waited out for the whole timeout.
      if (!sawRunning && Date.now() - t0 > 60_000) break
    }
    return { ms: Date.now() - t0, sawRunning }
  })
  const geo = m.geo ?? []
  delete m.geo
  // Analyses run on the FULL-resolution trace; only the stored sample is thinned.
  return {
    ...m,
    aborted,
    rearm,
    ...startOf(geo),
    drift: driftStats(geo),
    shots,
    geoSample: thinGeo(geo, 2000)
  }
}

// ── S6: user scroll-up while content streams near the bottom ───────────────────────────────

const S6_EPISODES = [
  { name: 'wheel-notches-human', kind: 'notches', count: 10 },
  { name: 'gesture-slow-400', kind: 'gesture', distance: 700, speed: 400 },
  { name: 'gesture-slow-600', kind: 'gesture', distance: 900, speed: 600 },
  { name: 'flick-fast', kind: 'gesture', distance: 1500, speed: 4000 }
]

/** An episode counts only if it starts within this distance of the bottom. */
const PINNED_PX = 10

/**
 * Bring a scroll box (the chat, or the subagent panel's body) to its bottom AND re-arm its follow
 * state the way a USER does. A post-fix build re-arms following only on user-driven scrolls (input
 * within ~250 ms that ends at the bottom), so a scripted `scrollTop = scrollHeight` would leave it
 * geometrically pinned but not following. So: click the box's scroll-to-bottom button when it is
 * shown, else put the view 60 px above the end by script and scroll the rest with one user wheel
 * notch. Then wait until dist < 2 and (where the build exposes it) `data-following="true"` have
 * held for `holdMs`. The caller still checks the measured window's first frame.
 */
export async function rearmFollow(ctx, target = 'chat', { holdMs = 300, timeoutMs = 6000 } = {}) {
  const sel = target === 'panel' ? SEL.panelBody : SEL.scroller
  const btn = ctx.win.locator(target === 'panel' ? SEL.panelScrollToBottom : SEL.scrollToBottom)
  let via = 'wheel'
  if (
    (await btn.count()) &&
    (await btn
      .last()
      .isVisible()
      .catch(() => false))
  ) {
    via = 'button'
    await clickMarked(ctx.win, btn.last())
  } else {
    await ctx.win.evaluate((sel) => {
      const el = [...document.querySelectorAll(sel)].pop()
      el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - 60)
    }, sel)
    await sleep(120)
    await wheelNotch(ctx.cdp, ctx.win, await scrollerPoint(ctx.win, sel), 100)
  }
  const r = await ctx.win.evaluate(
    ({ sel, holdMs, timeoutMs }) =>
      new Promise((resolve) => {
        const t0 = performance.now()
        let since = null
        const step = (now) => {
          const el = [...document.querySelectorAll(sel)].pop()
          if (!el) return resolve({ ok: false, reason: 'missing' })
          const dist = el.scrollHeight - el.scrollTop - el.clientHeight
          const attr = el.dataset.following
          const following = attr === 'true' ? true : attr === 'false' ? false : null
          if (dist < 2 && following !== false) since ??= now
          else since = null
          if (since !== null && now - since >= holdMs)
            resolve({ ok: true, following, dist, ms: Math.round(now - t0) })
          else if (now - t0 > timeoutMs)
            resolve({ ok: false, following, dist, ms: Math.round(now - t0) })
          else requestAnimationFrame(step)
        }
        requestAnimationFrame(step)
      }),
    { sel, holdMs, timeoutMs }
  )
  return { via, ...r }
}

/** Start conditions of a measured window: distance and follow state of its first frame. */
function startOf(geo) {
  const g = geo.find((x) => !x.missing)
  const startDist = g ? round(g.dist) : null
  const followAtStart = g ? (g.follow ?? null) : null
  return {
    startDist,
    followAtStart,
    // Not really following at the start: off the bottom, or a readable follow state that is off.
    notFollowingAtStart: !(startDist !== null && startDist < PINNED_PX) || followAtStart === 0
  }
}

export async function s6Pass(ctx, { stillStreaming }) {
  const out = []
  for (const ep of S6_EPISODES) {
    if (stillStreaming && !(await stillStreaming())) {
      out.push({ episode: ep.name, skipped: 'stream ended' })
      continue
    }
    const rearm = await rearmFollow(ctx, 'chat')
    const pt = await scrollerPoint(ctx.win)
    let inputEndT = null
    const m = await measure(ctx, { geometry: true, trace: false }, async () => {
      if (ep.kind === 'notches') {
        // Human cadence: one notch every 150-250 ms (deterministic jitter).
        const gaps = [180, 230, 160, 210, 250, 170, 200, 150, 240, 190]
        for (let i = 0; i < ep.count; i++) {
          await wheelNotch(ctx.cdp, ctx.win, pt, -100)
          await sleep(gaps[i % gaps.length])
        }
      } else {
        await gesture(ctx.cdp, ctx.win, pt, { distance: ep.distance, speed: ep.speed, down: false })
      }
      inputEndT = await ctx.win.evaluate(() => window.__scrollBench.geometry('chat').t)
      await sleep(2500)
    })
    const geo = m.geo ?? []
    delete m.geo
    const a = s6Analyze(geo, inputEndT)
    const start = startOf(geo)
    out.push({
      episode: ep.name,
      rearm,
      ...a,
      ...start,
      // Excluded and counted by the report: did not start really following, or nothing streamed
      // into the chat during the episode (the stream had stopped).
      unpinnedStart: start.notFollowingAtStart,
      streamStopped: a.framesWithMutations === 0,
      frames: m.frames,
      followSource: m.followSource
    })
  }
  return out
}

/**
 * Snap-back analysis of one S6 episode. A USER escape is the view moving UP: scrollTop at least
 * 10 px below the highest scrollTop seen since the last pin, with dist >= 10. Content growing under
 * a pinned view also opens a gap (dist > 0) but never lowers scrollTop, so it is not an escape. A
 * snap-back is a return to dist < 10 after a user escape. "Stayed escaped" requires a real escape
 * (up >= 10) in EVERY frame of the 2 s after the input ended.
 */
export function s6Analyze(geo, inputEndT) {
  const g = geo.filter((x) => !x.missing)
  let stMax = g.length ? g[0].st : 0
  let escaped = false
  let snapBacks = 0
  let maxUp = 0
  let firstEscapeT = null
  const ups = []
  for (const x of g) {
    stMax = Math.max(stMax, x.st)
    const up = stMax - x.st
    maxUp = Math.max(maxUp, up)
    const isEscape = up >= 10 && x.dist >= 10
    ups.push({ t: x.t, escaped: isEscape })
    if (isEscape) {
      if (firstEscapeT === null) firstEscapeT = x.t
      escaped = true
    } else if (escaped && x.dist < 10) {
      escaped = false
      snapBacks++
      stMax = x.st
    }
  }
  const tail = inputEndT == null ? [] : ups.filter((x) => x.t >= inputEndT)
  const tailEnd = tail.length ? tail[tail.length - 1].t : null
  const window2s = tail.filter((x) => x.t <= inputEndT + 2000)
  const stayed =
    window2s.length > 0 &&
    tailEnd != null &&
    tailEnd - inputEndT >= 1900 &&
    window2s.every((x) => x.escaped)
  return {
    snapBacks,
    // How far up the user's input actually got the view (scrollTop below its running max).
    maxUserUpPx: round(maxUp),
    maxDistPx: g.length ? round(Math.max(...g.map((x) => x.dist))) : null,
    firstEscapeMs: round(firstEscapeT),
    stayedEscaped2s: stayed,
    // The input moved the view by less than 10 px at any point: wholly overridden.
    overridden: maxUp < 10,
    finalDist: g.length ? round(g[g.length - 1].dist) : null,
    followAtEnd: g.length ? g[g.length - 1].follow : null,
    framesWithMutations: g.filter((x) => x.mut > 0).length,
    mainRunningFrames: g.filter((x) => x.run === 1).length,
    frameCount: g.length,
    trace: thinGeo(
      g.map((x) => ({
        t: round(x.t),
        st: round(x.st),
        dist: round(x.dist),
        input: x.input,
        follow: x.follow,
        anim: x.animating,
        mut: x.mut
      })),
      400
    )
  }
}

// ── Placeholder-estimate probe ─────────────────────────────────────────────────────────────

/**
 * Real height of every message wrapper (its own CSS px, the unit `contain-intrinsic-size: auto
 * 100px` is in), measured by forcing each to `content-visibility: visible` for one layout and
 * putting it back. Run on a fresh mount, so it also reports how many wrappers were still
 * placeholders before the probe.
 */
export async function heights(ctx) {
  await ctx.fresh()
  return ctx.win.evaluate(
    ({ sel, anchorSel }) => {
      const el = document.querySelector(sel)
      const anchors = [...el.querySelectorAll(anchorSel)]
      const before = anchors.map((a) => a.offsetHeight)
      const placeholdersBefore = before.filter((h) => h === 100).length
      for (const a of anchors) a.style.contentVisibility = 'visible'
      const hs = anchors.map((a) => a.offsetHeight)
      for (const a of anchors) a.style.removeProperty('content-visibility')
      const s = [...hs].sort((x, y) => x - y)
      const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]
      const total = hs.reduce((x, y) => x + y, 0)
      return {
        n: hs.length,
        placeholdersBefore,
        p10: q(0.1),
        p50: q(0.5),
        p90: q(0.9),
        max: s[s.length - 1],
        mean: Math.round(total / hs.length),
        under100: hs.filter((h) => h < 100).length,
        over500: hs.filter((h) => h > 500).length,
        total,
        placeholderTotal: hs.length * 100,
        ratio: Math.round((total / (hs.length * 100)) * 100) / 100
      }
    },
    { sel: SEL.scroller, anchorSel: SEL.anchor }
  )
}

// ── S7: the subagent detail panel (TaskEntry) following its streaming content ──────────────

/**
 * Episodes where the panel's content extends below its visible bottom with no input, and whether
 * the follow state flips off without input (`follow` null = unreadable, reported as n/a).
 */
export function panelAnalyze(geo, { tol = 2 } = {}) {
  const g = geo.filter((x) => !x.missing && x.input === 0)
  if (!g.length) return { frames: 0 }
  const episodes = []
  let start = null
  let maxD = 0
  for (const x of g) {
    if (x.dist > tol) {
      if (start === null) {
        start = x.t
        maxD = 0
      }
      maxD = Math.max(maxD, x.dist)
    } else if (start !== null) {
      episodes.push({ start: round(start), ms: round(x.t - start), maxDist: round(maxD) })
      start = null
    }
  }
  if (start !== null)
    episodes.push({
      start: round(start),
      ms: round(g[g.length - 1].t - start),
      maxDist: round(maxD),
      open: true
    })
  const readable = g.some((x) => x.follow !== null && x.follow !== undefined)
  let flips = 0
  for (let i = 1; i < g.length; i++) if (g[i - 1].follow === 1 && g[i].follow === 0) flips++
  return {
    frames: g.length,
    framesBelowBottom: g.filter((x) => x.dist > tol).length,
    framesBelowBottomPct: round((100 * g.filter((x) => x.dist > tol).length) / g.length),
    distMax: round(Math.max(...g.map((x) => x.dist))),
    episodes: episodes.length,
    episodesOver250ms: episodes.filter((e) => e.ms >= 250).length,
    longestEpisodeMs: episodes.length ? Math.max(...episodes.map((e) => e.ms)) : 0,
    longestEpisodes: [...episodes].sort((a, b) => b.ms - a.ms).slice(0, 5),
    followingFlipsWithoutInput: readable ? flips : null,
    followingAtEnd: readable ? g[g.length - 1].follow : null,
    framesWithMutations: g.filter((x) => x.mut > 0).length
  }
}

/**
 * S7: with the panel open on a RUNNING subagent, (a) watch it for `watchMs` with no input,
 * (b) scroll it up, click its scroll-to-bottom button and check it reaches and keeps the bottom.
 */
export async function s7(ctx, { watchMs = 30_000 } = {}) {
  const rearm = await rearmFollow(ctx, 'panel')
  const watch = await measure(ctx, { geometry: true, trace: false, target: 'panel' }, () =>
    sleep(watchMs)
  )
  const watchGeo = watch.geo ?? []
  delete watch.geo
  // (b) scroll up in the panel, then the panel's own button.
  const pt = await scrollerPoint(ctx.win, SEL.panelBody)
  await wheelBurst(ctx.cdp, ctx.win, pt, { ticks: 8, deltaY: -100, gapMs: 120 })
  await sleep(800)
  const before = await geometryNow(ctx.win, 'panel')
  const m = await measure(ctx, { geometry: true, trace: false, target: 'panel' }, async () => {
    const btn = ctx.win.locator(SEL.panelScrollToBottom)
    const shown = (await btn.count()) > 0
    if (shown) await clickMarked(ctx.win, btn.last())
    await sleep(4000)
    return { shown }
  })
  const geo = (m.geo ?? []).filter((x) => !x.missing)
  const afterClick = geo.filter((x) => x.input === 0)
  let reachedAt = null
  for (const x of afterClick)
    if (x.dist <= 2) {
      reachedAt = x.t
      break
    }
  const tail = reachedAt === null ? [] : afterClick.filter((x) => x.t >= reachedAt)
  const after = panelAnalyze(afterClick)
  const button = {
    buttonShownAfterScrollUp: m.result.shown,
    distBeforeClick: round(before.dist),
    reached: reachedAt !== null,
    reachedMs: round(reachedAt),
    stayedAtBottomAfterReach: tail.length ? tail.every((x) => x.dist <= 2) : false,
    maxDistAfterReach: tail.length ? round(Math.max(...tail.map((x) => x.dist))) : null,
    followingAtEnd: after.followingAtEnd ?? null,
    followingFlipsAfterClick: after.followingFlipsWithoutInput ?? null,
    finalDist: geo.length ? round(geo[geo.length - 1].dist) : null
  }
  return {
    rearm,
    ...startOf(watchGeo),
    watch: { ...panelAnalyze(watchGeo), frames: watch.frames },
    followSource: watch.followSource,
    button,
    sample: thinGeo(
      watchGeo.map((x) => ({
        t: round(x.t),
        dist: round(x.dist),
        follow: x.follow,
        mut: x.mut,
        input: x.input
      })),
      400
    )
  }
}

// ── E: height-estimate calibration ─────────────────────────────────────────────────────────

/**
 * For a freshly mounted session: force every message wrapper to `content-visibility: visible`,
 * let layout settle (scrollHeight still for 300 ms, cap 5 s), and record per wrapper the estimate
 * (`data-est-h`, in the wrapper's own CSS px; a build without it uses the 100 px placeholder) and
 * the actual height (rect height / effective zoom, i.e. the same unit). Then restore. The 15
 * worst outliers by |log(est/actual)| get a CONTENT-FREE shape summary: the message role, counts
 * of each `data-testid` inside, and counts of pre/table/img/code elements — never text.
 */
export async function calibrate(ctx) {
  await ctx.fresh()
  return ctx.win.evaluate(
    async ({ sel, anchorSel }) => {
      const el = document.querySelector(sel)
      const wraps = [...el.querySelectorAll(anchorSel)]
      // Estimates are read BEFORE anything is forced visible (a re-render after the forced layout
      // must not be able to change what is compared).
      const ests = wraps.map((w) => (w.dataset.estH !== undefined ? Number(w.dataset.estH) : null))
      for (const w of wraps) w.style.contentVisibility = 'visible'
      await new Promise((resolve) => {
        const t0 = performance.now()
        let last = -1
        let since = t0
        const step = (now) => {
          if (el.scrollHeight !== last) {
            last = el.scrollHeight
            since = now
          }
          if (now - since >= 300 || now - t0 > 5000) resolve()
          else requestAnimationFrame(step)
        }
        requestAnimationFrame(step)
      })
      const st = window.__claudeuiVerifier.sessionStore.getState()
      const msgs = st.sessions[st.activeSessionId]?.messages ?? []
      const aligned = msgs.length === wraps.length
      const hasEstimates = ests.some((e) => e !== null)
      const rows = wraps.map((w, i) => {
        const r = w.getBoundingClientRect()
        const z = w.offsetWidth ? r.width / w.offsetWidth : 1
        const est = ests[i] ?? 100
        return { i, est, actual: Math.round((r.height / z) * 10) / 10 }
      })
      const scored = rows
        .filter((r) => r.actual >= 1 && r.est > 0)
        .map((r) => ({ ...r, logRatio: Math.log(r.est / r.actual) }))
        .sort((a, b) => Math.abs(b.logRatio) - Math.abs(a.logRatio))
      const shape = (i) => {
        const w = wraps[i]
        const ids = {}
        for (const n of w.querySelectorAll('[data-testid]')) {
          const id = n.getAttribute('data-testid')
          ids[id] = (ids[id] ?? 0) + 1
        }
        const tags = {}
        for (const t of ['pre', 'table', 'img', 'code', 'svg'])
          tags[t] = w.getElementsByTagName(t).length
        return { role: aligned ? (msgs[i]?.role ?? null) : null, testids: ids, tags }
      }
      const outliers = scored.slice(0, 15).map((r) => ({
        i: r.i,
        est: r.est,
        actual: r.actual,
        ratio: Math.round((r.est / r.actual) * 100) / 100,
        shape: shape(r.i)
      }))
      for (const w of wraps) w.style.removeProperty('content-visibility')
      return {
        estimateSource: hasEstimates ? 'data-est-h' : 'placeholder-100',
        wrappers: wraps.length,
        alignedWithStore: aligned,
        rows,
        outliers
      }
    },
    { sel: SEL.scroller, anchorSel: SEL.anchor }
  )
}

/** Distribution summary of est/actual for one calibration result. */
export function calibrationStats(cal) {
  const r = cal.rows.filter((x) => x.actual >= 1 && x.est > 0)
  const ratios = r.map((x) => x.est / x.actual).sort((a, b) => a - b)
  const q = (p) => ratios[Math.min(ratios.length - 1, Math.floor(p * ratios.length))]
  const within = (lo, hi) => (100 * ratios.filter((x) => x >= lo && x <= hi).length) / ratios.length
  return {
    n: ratios.length,
    p10: round(q(0.1), 2),
    p50: round(q(0.5), 2),
    p90: round(q(0.9), 2),
    within07to14Pct: round(within(0.7, 1.4)),
    within05to2Pct: round(within(0.5, 2)),
    totalEst: Math.round(r.reduce((a, x) => a + x.est, 0)),
    totalActual: Math.round(r.reduce((a, x) => a + x.actual, 0))
  }
}

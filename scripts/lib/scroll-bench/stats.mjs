// Pure summaries over what the in-page sampler, LoAF and CDP return. No I/O.

export function pct(values, p) {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]
}

export const round = (n, d = 1) =>
  n == null || Number.isNaN(n) ? null : Math.round(n * 10 ** d) / 10 ** d

export function meanSd(values) {
  const v = values.filter((x) => typeof x === 'number' && !Number.isNaN(x))
  if (!v.length) return { mean: null, sd: null, n: 0 }
  const mean = v.reduce((a, b) => a + b, 0) / v.length
  // Sample SD (n - 1): the repeats are a sample of the run-to-run variation.
  const sd =
    v.length > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1)) : 0
  return { mean, sd, n: v.length }
}

/**
 * Frame-interval stats. `refreshMs` is the measured vsync interval; a frame is janky when its
 * interval exceeds 1.5x of it, and `missed` counts the vsyncs skipped in total.
 */
export function frameStats(frames, refreshMs) {
  const iv = []
  for (let i = 1; i < frames.length; i++) iv.push(frames[i] - frames[i - 1])
  if (!iv.length) return { frames: frames.length, intervals: 0 }
  const janky = iv.filter((x) => x > refreshMs * 1.5)
  const missed = iv.reduce((a, x) => a + Math.max(0, Math.round(x / refreshMs) - 1), 0)
  return {
    frames: frames.length,
    p50: round(pct(iv, 50), 2),
    p95: round(pct(iv, 95), 2),
    p99: round(pct(iv, 99), 2),
    max: round(Math.max(...iv), 1),
    janky: janky.length,
    jankyPct: round((100 * janky.length) / iv.length, 1),
    missedVsyncs: missed,
    // Same window at the measured cadence: what fraction of vsyncs produced a rAF.
    deliveredPct: round((100 * iv.length) / (iv.length + missed), 1)
  }
}

/** Aggregate LoAF entries: where the long frames' time went. */
export function loafSummary(loaf) {
  if (!loaf?.length) return { count: 0, totalMs: 0 }
  const sum = (k) => loaf.reduce((a, e) => a + (e[k] || 0), 0)
  const byFn = new Map()
  for (const e of loaf)
    for (const s of e.scripts) {
      const key = `${s.invokerType}:${s.fn || s.invoker}@${s.sourceURL || '(injected)'}`.slice(
        0,
        120
      )
      const cur = byFn.get(key) ?? { ms: 0, forced: 0, n: 0 }
      cur.ms += s.duration
      cur.forced += s.forced
      cur.n++
      byFn.set(key, cur)
    }
  return {
    count: loaf.length,
    totalMs: round(sum('duration')),
    maxMs: round(Math.max(...loaf.map((e) => e.duration))),
    blockingMs: round(sum('blocking')),
    scriptMs: round(sum('scriptMs')),
    forcedLayoutMs: round(sum('forcedLayoutMs')),
    preLayoutMs: round(sum('preLayoutMs')),
    styleLayoutPaintMs: round(sum('styleLayoutPaintMs')),
    topScripts: [...byFn.entries()]
      .sort((a, b) => b[1].ms - a[1].ms)
      .slice(0, 5)
      .map(([k, v]) => ({ fn: k, ms: round(v.ms), forcedMs: round(v.forced), n: v.n }))
  }
}

const METRIC_KEYS = [
  'LayoutCount',
  'LayoutDuration',
  'RecalcStyleCount',
  'RecalcStyleDuration',
  'ScriptDuration',
  'TaskDuration',
  'Nodes',
  'JSHeapUsedSize'
]

export function metricsMap(res) {
  const m = {}
  for (const { name, value } of res.metrics) if (METRIC_KEYS.includes(name)) m[name] = value
  return m
}

/** Deltas; durations converted from seconds to ms, heap to MB. */
export function metricsDelta(a, b) {
  const d = {}
  for (const k of METRIC_KEYS) {
    if (a[k] == null || b[k] == null) continue
    const v = b[k] - a[k]
    if (k.endsWith('Duration')) d[`${k}Ms`] = round(v * 1000)
    else if (k === 'JSHeapUsedSize') d.JSHeapDeltaMB = round(v / 1048576)
    else d[k] = v
  }
  return d
}

/**
 * Drift analysis over per-frame geometry during a streaming window (S4). Only frames where the
 * session is running and no synthesized input happened count.
 */
export function driftStats(geo, { episodeMs = 250, tol = 2 } = {}) {
  const run = geo.filter((g) => !g.missing && g.run === 1 && g.input === 0)
  if (!run.length) return { runningFrames: 0 }
  const withTi = run.filter((g) => g.ti >= 0)
  const tiNotFull = withTi.filter((g) => g.ti < 2)
  const tiHidden = withTi.filter((g) => g.ti === 0)
  const dists = run.map((g) => g.dist)
  // Per-episode cause: did the frame that opened the gap carry DOM mutations (new content) or
  // only layout growth (cv-auto swap, image, font, transition — nothing the MutationObserver
  // sees)? And what closed it: a frame with mutations (a later mutation re-pinned) or none (the
  // in-flight smooth scroll caught up)? `animating` = ChatPanel's isAutoScrolling ref.
  const episodes = []
  let cur = null
  // A frame is "stuck" when it is off the bottom and neither scrolled nor mutated since the
  // previous sample: nothing is moving the view and nothing new arrived — the gap is a residual.
  // `layoutGrowthPx` sums scrollHeight increases on frames with no DOM mutation (cv-auto swaps,
  // late layout) inside the episode: if the stuck gap is about that size, the residual is
  // layout-only growth that nothing re-pinned.
  const close = (c, endCause, endT) => {
    const stuckDist = c.stuckDists.length ? c.stuckDists[c.stuckDists.length - 1] : 0
    episodes.push({
      start: round(c.start),
      ms: round(endT - c.start),
      maxDist: round(c.maxDist),
      startCause: c.startMut ? 'mutation' : 'layout-only',
      endCause,
      animatingPct: round((100 * c.animating) / c.frames),
      stuckMs: round(c.stuckMs),
      stuckDist: round(stuckDist),
      layoutGrowthPx: round(c.layoutGrowth),
      residualIsLayoutOnly: c.stuckMs >= 100 && c.layoutGrowth >= stuckDist - 2 && stuckDist > 0
    })
  }
  let prev = null
  for (const g of run) {
    if (g.dist > tol) {
      if (!cur)
        cur = {
          start: g.t,
          maxDist: 0,
          startMut: g.mut > 0,
          frames: 0,
          animating: 0,
          stuckMs: 0,
          stuckDists: [],
          layoutGrowth: 0
        }
      cur.maxDist = Math.max(cur.maxDist, g.dist)
      cur.frames++
      if (g.animating === 1) cur.animating++
      if (prev) {
        if (g.mut === 0 && g.sh > prev.sh + 0.5) cur.layoutGrowth += g.sh - prev.sh
        if (g.mut === 0 && Math.abs(g.st - prev.st) < 0.5 && Math.abs(g.sh - prev.sh) < 0.5) {
          cur.stuckMs += g.t - prev.t
          cur.stuckDists.push(g.dist)
        }
      }
    } else if (cur) {
      close(cur, g.mut > 0 ? 'mutation' : 'no-mutation', g.t)
      cur = null
    }
    prev = g
  }
  if (cur) close(cur, 'open', run[run.length - 1].t)
  // Growth frames over ALL geometry (consecutive samples): scrollHeight up with/without mutations.
  let growthMut = 0
  let growthLayoutOnly = 0
  for (let i = 1; i < geo.length; i++) {
    const a = geo[i - 1]
    const b = geo[i]
    if (a.missing || b.missing || b.run !== 1) continue
    if (b.sh > a.sh + 0.5) {
      if (b.mut > 0) growthMut++
      else growthLayoutOnly++
    }
  }
  const long = episodes.filter((e) => e.ms >= episodeMs)
  // Follow state (`follow`; `auto` in runs recorded before it was renamed). Unreadable = null,
  // reported as n/a — never as zero disarmed frames.
  const followOf = (g) => (g.follow !== undefined ? g.follow : (g.auto ?? null))
  const followReadable = run.some((g) => followOf(g) !== null)
  const disarmed = run.filter((g) => followOf(g) === 0)
  return {
    runningFrames: run.length,
    tiPresentFrames: withTi.length,
    tiNotFullyVisiblePct: withTi.length ? round((100 * tiNotFull.length) / withTi.length) : null,
    tiFullyHiddenPct: withTi.length ? round((100 * tiHidden.length) / withTi.length) : null,
    distMax: round(Math.max(...dists)),
    distP95: round(pct(dists, 95)),
    distOver2Pct: round((100 * dists.filter((d) => d > tol).length) / dists.length),
    distOver50Pct: round((100 * dists.filter((d) => d > 50).length) / dists.length),
    episodes: episodes.length,
    episodesOver250ms: long.length,
    longestEpisodeMs: episodes.length ? Math.max(...episodes.map((e) => e.ms)) : 0,
    longestEpisodes: [...episodes].sort((a, b) => b.ms - a.ms).slice(0, 5),
    episodesByStart: {
      mutation: episodes.filter((e) => e.startCause === 'mutation').length,
      layoutOnly: episodes.filter((e) => e.startCause === 'layout-only').length
    },
    longEpisodesByStart: {
      mutation: long.filter((e) => e.startCause === 'mutation').length,
      layoutOnly: long.filter((e) => e.startCause === 'layout-only').length
    },
    longEpisodesEndedByMutation: long.filter((e) => e.endCause === 'mutation').length,
    longEpisodesLayoutResidual: long.filter((e) => e.residualIsLayoutOnly).length,
    stuckMsTotal: round(episodes.reduce((a, e) => a + e.stuckMs, 0)),
    stuckMsLayoutResidual: round(
      episodes.filter((e) => e.residualIsLayoutOnly).reduce((a, e) => a + e.stuckMs, 0)
    ),
    growthFrames: { withMutation: growthMut, layoutOnly: growthLayoutOnly },
    autoScrollDisarmedFrames: followReadable ? disarmed.length : null,
    firstDisarmAt: disarmed.length ? round(disarmed[0].t) : null,
    followReadable,
    buttonShownFrames: run.filter((g) => g.btn === 1).length
  }
}

/**
 * Keep at most `n` geometry samples for the raw JSON. Each kept sample stands for a STRIDE of
 * original frames, so the per-frame counters are aggregated over it: `mut` is summed (a sample's
 * own `mut` only covers the frame before it) and `input` is the max. Analyses must use the
 * full-resolution summaries computed before thinning; the thinned trace is for plotting.
 */
export function thinGeo(geo, n) {
  if (geo.length <= n) return geo
  const out = []
  const step = geo.length / n
  for (let i = 0; i < n; i++) {
    const from = Math.floor(i * step)
    const to = Math.max(from + 1, Math.floor((i + 1) * step))
    const slice = geo.slice(from, to)
    const last = slice[slice.length - 1]
    out.push({
      ...last,
      mut: slice.reduce((a, g) => a + (g.mut || 0), 0),
      input: slice.some((g) => g.input) ? 1 : 0,
      stride: slice.length
    })
  }
  return out
}

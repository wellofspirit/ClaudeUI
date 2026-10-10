// Compositor truth over CDP Tracing (best effort). The JSON trace carries, per compositor frame,
// a `PipelineReporter` async slice whose `args.frame_reporter.state` is the DevTools frame-track
// verdict: STATE_PRESENTED_ALL / STATE_PRESENTED_PARTIAL / STATE_DROPPED / STATE_NO_UPDATE_DESIRED,
// plus `scroll_state` (SCROLL_NONE / SCROLL_MAIN_THREAD / SCROLL_COMPOSITOR_THREAD) and
// `affects_smoothness`. `EventLatency` slices for GESTURE_SCROLL_UPDATE carry Chromium's own
// `is_janky_scrolled_frame`. `ScrollLayer` (devtools.timeline) is a main-thread scroll repaint of a
// non-composited scroller. Verified present on Electron 43 (Chromium of that line) — see the
// bench's BASELINE.md for what the counts looked like.

export const TRACE_CATEGORIES = [
  'disabled-by-default-devtools.timeline.frame',
  'benchmark',
  'cc',
  'input',
  'devtools.timeline'
]

/**
 * Bounded trace buffer: `recordUntilFull` with a 256 MB buffer (a measured window is a few
 * seconds, tens of MB at most). If the buffer ever fills, later events are DROPPED rather than
 * older ones overwritten, so the window's start is never silently lost; the summary reports the
 * highest buffer fill seen and `truncated` when it reached 100%.
 */
const TRACE_BUFFER_KB = 256 * 1024

export async function startTrace(cdp) {
  const events = []
  let maxFull = 0
  const onData = (e) => events.push(...e.value)
  const onUsage = (e) => {
    if (typeof e.percentFull === 'number') maxFull = Math.max(maxFull, e.percentFull)
  }
  cdp.on('Tracing.dataCollected', onData)
  cdp.on('Tracing.bufferUsage', onUsage)
  await cdp.send('Tracing.start', {
    traceConfig: {
      includedCategories: TRACE_CATEGORIES,
      recordMode: 'recordUntilFull',
      traceBufferSizeInKb: TRACE_BUFFER_KB
    },
    bufferUsageReportingInterval: 500,
    transferMode: 'ReportEvents'
  })
  return {
    async stop() {
      const done = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve))
      await cdp.send('Tracing.end')
      await done
      cdp.off('Tracing.dataCollected', onData)
      cdp.off('Tracing.bufferUsage', onUsage)
      return {
        ...summarizeTrace(events),
        bufferMaxFullPct: Math.round(maxFull * 1000) / 10,
        truncated: maxFull >= 0.999
      }
    }
  }
}

export function summarizeTrace(events) {
  // The renderer's reporter: the pid with the most PipelineReporter begins.
  const begins = events.filter((e) => e.name === 'PipelineReporter' && e.ph === 'b')
  const byPid = new Map()
  for (const e of begins) byPid.set(e.pid, (byPid.get(e.pid) ?? 0) + 1)
  const pid = [...byPid.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  const states = {}
  const scroll = {}
  let smoothDropped = 0
  let missingContent = 0
  const seen = new Set()
  for (const e of begins) {
    if (e.pid !== pid) continue
    const f = e.args?.frame_reporter
    if (!f) continue
    const key = `${f.layer_tree_host_id}:${f.frame_source}:${f.frame_sequence}`
    if (seen.has(key)) continue
    seen.add(key)
    states[f.state] = (states[f.state] ?? 0) + 1
    if (f.scroll_state) scroll[f.scroll_state] = (scroll[f.scroll_state] ?? 0) + 1
    if (f.state === 'STATE_DROPPED' && f.affects_smoothness) smoothDropped++
    if (f.has_missing_content || f.checkerboarded_needs_raster || f.checkerboarded_needs_record)
      missingContent++
  }
  const presented = (states.STATE_PRESENTED_ALL ?? 0) + (states.STATE_PRESENTED_PARTIAL ?? 0)
  const dropped = states.STATE_DROPPED ?? 0
  // Scroll-update latencies: renderer process only, one per slice (begin and complete events;
  // the same slice can be reported more than once). Other processes' counts are kept for
  // transparency.
  const latency = new Map()
  const latencyPids = {}
  for (const e of events) {
    const l = e.name === 'EventLatency' ? e.args?.event_latency : null
    if (!l || l.event_type !== 'GESTURE_SCROLL_UPDATE' || !('is_janky_scrolled_frame' in l))
      continue
    if (e.ph !== 'b' && e.ph !== 'X') continue
    latencyPids[e.pid === pid ? 'renderer' : 'other'] =
      (latencyPids[e.pid === pid ? 'renderer' : 'other'] ?? 0) + 1
    if (e.pid !== pid) continue
    // `event_latency_id` is a 64-bit id that JSON parsing rounds (distinct events collide), so
    // a slice is keyed by its start timestamp and that id together.
    const id = `${e.ts}|${l.event_latency_id ?? e.id ?? ''}`
    latency.set(id, latency.get(id) || !!l.is_janky_scrolled_frame)
  }
  const scrollUpdates = latency.size
  const jankyScroll = [...latency.values()].filter(Boolean).length
  return {
    usable: begins.length > 0,
    events: events.length,
    frames: seen.size,
    presented,
    partial: states.STATE_PRESENTED_PARTIAL ?? 0,
    dropped,
    noUpdate: states.STATE_NO_UPDATE_DESIRED ?? 0,
    droppedPct:
      presented + dropped ? Math.round((1000 * dropped) / (presented + dropped)) / 10 : null,
    smoothnessDropped: smoothDropped,
    missingContentFrames: missingContent,
    scrollStates: scroll,
    scrollUpdates,
    jankyScrollUpdates: jankyScroll,
    scrollLatencyEventsByProcess: latencyPids,
    mainThreadScrollRepaints: events.filter((e) => e.name === 'ScrollLayer').length
  }
}

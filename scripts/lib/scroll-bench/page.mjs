// In-page instrumentation for the chat-scroll bench. `installPageBench(SEL)` is passed to
// `page.evaluate()` with the shared selector table (common.mjs) and runs IN THE RENDERER, so it is
// self-contained. It publishes `window.__scrollBench` with:
//
// - a rAF frame sampler (timestamps -> intervals) that optionally samples the target scroll
//   element's geometry every frame — the chat scroller, or the subagent panel's body: scrollTop /
//   scrollHeight / clientHeight / dist-from-bottom in that element's own CSS px, the
//   TypingIndicator's visibility against the visible box (rects are page px; the box is converted
//   with the effective zoom — the ADR-093 zoom trap), the follow state, DOM mutations under the
//   element since the previous frame, the session's run state and whether the bench marked
//   synthesized input in that frame;
// - a `long-animation-frame` PerformanceObserver (script vs pre-layout vs style/layout/paint).
//
// PER-FRAME COST IS O(1) in the transcript size: the scroll element is cached (re-resolved only
// when disconnected), and the TypingIndicator / scroll-to-bottom buttons are tracked by a
// MutationObserver on <body> (lookup cost is paid when nodes are ADDED, proportional to what was
// added), so the sampler never walks the message list in a frame.
//
// FOLLOW STATE, in order of preference:
//   1. `data-following="true|false"` on the scroll element (post-fix builds expose it);
//   2. PRE-FIX ONLY, chat: ChatPanel's `shouldAutoScroll` ref read through the React fiber — the
//      five object refs after `scrollRef`, accepted only if their value types match
//      (bool, bool, number, bool, bool); any other shape reads as unknown;
//   3. PRE-FIX ONLY, panel: TaskEntry renders its scroll-to-bottom button exactly when
//      `following` is false, so the button's presence next to the body is the inverse.
//   Otherwise null ("n/a" in the report, never 0).
//
// Reading scrollTop/scrollHeight in a rAF callback forces style+layout early in the frame — a
// measurement perturbation, so geometry is opt-in per window (`geometry: false` for the pure
// smoothness passes).

export function installPageBench(SEL) {
  if (window.__scrollBench) return 'already'

  /** z = page px per CSS px of the element (rect.width / offsetWidth). */
  const zoomOf = (el, rect) => (el.offsetWidth ? rect.width / el.offsetWidth : 1)

  /** PRE-FIX ONLY: ChatPanel's refs via the fiber that owns the scroller ref. */
  function findChatRefs(el) {
    if (!el) return null
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'))
    if (!key) return null
    for (let f = el[key]; f; f = f.return) {
      if (typeof f.type !== 'function') continue
      const refs = []
      let found = false
      for (let h = f.memoizedState; h; h = h.next) {
        const s = h.memoizedState
        if (!s || typeof s !== 'object' || Array.isArray(s)) continue
        const keys = Object.keys(s)
        if (keys.length !== 1 || keys[0] !== 'current') continue
        if (!found) {
          if (s.current === el) found = true
          continue
        }
        refs.push(s)
        if (refs.length === 5) break
      }
      if (!found) continue
      const [searchOpen, shouldAutoScroll, lastScrollTop, isAutoScrolling, wasNearBottom] = refs
      const ok =
        refs.length === 5 &&
        typeof searchOpen.current === 'boolean' &&
        typeof shouldAutoScroll.current === 'boolean' &&
        typeof lastScrollTop.current === 'number' &&
        typeof isAutoScrolling.current === 'boolean' &&
        typeof wasNearBottom.current === 'boolean'
      return ok ? { shouldAutoScroll, isAutoScrolling } : null
    }
    return null
  }

  // ── tracked elements (O(1) per frame) ──
  const TRACKED = {
    typing: SEL.typing,
    chatBtn: SEL.scrollToBottom,
    panelBtn: SEL.panelScrollToBottom
  }
  const tracked = {}
  for (const [k, sel] of Object.entries(TRACKED)) tracked[k] = document.querySelector(sel)
  const trackObserver = new MutationObserver((records) => {
    for (const r of records)
      for (const n of r.addedNodes) {
        if (n.nodeType !== 1) continue
        for (const [k, sel] of Object.entries(TRACKED)) {
          if (n.matches(sel)) tracked[k] = n
          else if (n.firstElementChild) {
            const hit = n.querySelector(sel)
            if (hit) tracked[k] = hit
          }
        }
      }
  })
  trackObserver.observe(document.body, { childList: true, subtree: true })
  const live = (k) => (tracked[k] && tracked[k].isConnected ? tracked[k] : null)

  const state = {
    running: false,
    geometry: false,
    target: 'chat',
    el: null,
    refs: null,
    followSrc: null,
    frames: [],
    geo: [],
    loaf: [],
    inputPending: 0,
    inputActive: 0,
    raf: 0,
    mutations: 0,
    mutObserver: null,
    t0: 0
  }

  function resolveTarget() {
    if (state.el && state.el.isConnected) return state.el
    state.mutObserver?.disconnect()
    state.mutObserver = null
    const el =
      state.target === 'panel'
        ? ([...document.querySelectorAll(SEL.panelBody)].pop() ?? null)
        : document.querySelector(SEL.scroller)
    state.el = el
    state.refs = el && state.target === 'chat' ? findChatRefs(el) : null
    if (el) {
      // Mutation records under the target since the last sampled frame (content streaming in).
      state.mutObserver = new MutationObserver((records) => {
        state.mutations += records.length
      })
      state.mutObserver.observe(el, { childList: true, subtree: true, characterData: true })
    }
    return el
  }

  function runState() {
    try {
      const st = window.__claudeuiVerifier.sessionStore.getState()
      return st.sessions[st.activeSessionId]?.status?.state === 'running' ? 1 : 0
    } catch {
      return null
    }
  }

  function followOf(el) {
    const attr = el.dataset.following
    if (attr === 'true' || attr === 'false') {
      state.followSrc = 'attr'
      return attr === 'true' ? 1 : 0
    }
    if (state.target === 'chat' && state.refs) {
      state.followSrc = 'fiber (pre-fix)'
      return state.refs.shouldAutoScroll.current ? 1 : 0
    }
    if (state.target === 'panel') {
      state.followSrc = 'button (pre-fix)'
      const btn = live('panelBtn')
      return btn && btn.parentElement === el.parentElement ? 0 : 1
    }
    state.followSrc = null
    return null
  }

  function toLoaf(e) {
    const end = e.startTime + e.duration
    const scripts = (e.scripts || []).map((s) => ({
      invoker: String(s.invoker || '').slice(0, 120),
      invokerType: s.invokerType,
      sourceURL: String(s.sourceURL || '').replace(/^.*\//, ''),
      fn: s.sourceFunctionName || '',
      duration: s.duration,
      forced: s.forcedStyleAndLayoutDuration || 0
    }))
    return {
      startAbs: e.startTime,
      start: e.startTime - state.t0,
      duration: e.duration,
      blocking: e.blockingDuration,
      scriptMs: scripts.reduce((a, s) => a + s.duration, 0),
      forcedLayoutMs: scripts.reduce((a, s) => a + s.forced, 0),
      // renderStart: the rendering update began (rAF, ResizeObserver callbacks), then
      // styleAndLayoutStart: style, layout, paint.
      preLayoutMs:
        e.renderStart > 0 && e.styleAndLayoutStart > 0 ? e.styleAndLayoutStart - e.renderStart : 0,
      styleLayoutPaintMs: e.styleAndLayoutStart > 0 ? end - e.styleAndLayoutStart : 0,
      scripts: scripts.sort((a, b) => b.duration - a.duration).slice(0, 4)
    }
  }

  let loafObserver = null
  try {
    loafObserver = new PerformanceObserver((list) => {
      if (!state.running) return
      for (const e of list.getEntries()) if (e.startTime >= state.t0) state.loaf.push(toLoaf(e))
    })
    loafObserver.observe({ type: 'long-animation-frame', buffered: false })
  } catch {
    loafObserver = null
  }

  function sampleGeometry(t) {
    const el = resolveTarget()
    if (!el) return { t, missing: true }
    const st = el.scrollTop
    const sh = el.scrollHeight
    const ch = el.clientHeight
    let ti = -1 // absent
    const tiEl = state.target === 'chat' ? live('typing') : null
    if (tiEl) {
      const rect = el.getBoundingClientRect()
      const z = zoomOf(el, rect)
      const boxTop = rect.top + el.clientTop * z
      const boxBottom = boxTop + ch * z
      const r = tiEl.getBoundingClientRect()
      if (r.bottom <= boxTop + 0.5 || r.top >= boxBottom - 0.5) ti = 0
      else if (r.top >= boxTop - 2 && r.bottom <= boxBottom + 2) ti = 2
      else ti = 1
    }
    const refs = state.refs
    return {
      t,
      st,
      sh,
      ch,
      dist: sh - st - ch,
      ti,
      input: state.inputPending > 0 || state.inputActive > 0 ? 1 : 0,
      follow: followOf(el),
      animating: refs ? (refs.isAutoScrolling.current ? 1 : 0) : null,
      btn: state.target === 'chat' ? (live('chatBtn') ? 1 : 0) : null,
      run: runState(),
      mut: state.mutations
    }
  }

  function tick(now) {
    if (!state.running) return
    const t = now - state.t0
    state.frames.push(t)
    if (state.geometry) {
      state.geo.push(sampleGeometry(t))
      state.mutations = 0
    }
    state.inputPending = 0
    state.raf = requestAnimationFrame(tick)
  }

  function setTarget(target) {
    if (target === state.target) return
    state.target = target
    state.el = null
    state.mutObserver?.disconnect()
    state.mutObserver = null
  }

  window.__scrollBench = {
    start({ geometry = false, target = 'chat' } = {}) {
      setTarget(target)
      cancelAnimationFrame(state.raf)
      state.frames = []
      state.geo = []
      state.loaf = []
      state.geometry = geometry
      state.inputPending = 0
      state.inputActive = 0
      state.mutations = 0
      state.followSrc = null
      state.t0 = performance.now()
      state.running = true
      state.raf = requestAnimationFrame(tick)
      return true
    },
    stop() {
      // Entries the observer has queued but not yet delivered belong to this window too.
      if (loafObserver)
        for (const e of loafObserver.takeRecords())
          if (e.startTime >= state.t0) state.loaf.push(toLoaf(e))
      state.running = false
      cancelAnimationFrame(state.raf)
      state.mutObserver?.disconnect()
      state.mutObserver = null
      state.el = null
      return {
        frames: state.frames,
        geo: state.geo,
        loaf: state.loaf,
        loafSupported: !!loafObserver,
        followSource: state.followSrc,
        durationMs: performance.now() - state.t0
      }
    },
    /** Mark a discrete synthesized input (counted in the next sampled frame). */
    markInput() {
      state.inputPending++
    },
    /** Mark a span of synthesized input (a gesture spanning many frames). */
    inputBegin() {
      state.inputActive++
    },
    inputEnd() {
      state.inputActive = Math.max(0, state.inputActive - 1)
    },
    /** One sample now. `target` switches chat/panel, except inside a running window. */
    geometry(target) {
      if (target && !state.running) setTarget(target)
      const g = sampleGeometry(performance.now() - state.t0)
      if (!state.running) {
        state.mutObserver?.disconnect()
        state.mutObserver = null
        state.el = null
        state.mutations = 0
      }
      return g
    },
    /** rAF timestamps over `ms`, for the refresh-rate / pacing check. */
    measureRaf(ms = 2000) {
      return new Promise((resolve) => {
        const ts = []
        const start = performance.now()
        const step = (now) => {
          ts.push(now)
          if (now - start < ms) requestAnimationFrame(step)
          else resolve(ts)
        }
        requestAnimationFrame(step)
      })
    }
  }
  return 'installed'
}

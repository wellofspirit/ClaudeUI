// Synthesized input for the chat-scroll bench. Every helper marks the input in the page sampler
// first, so per-frame geometry can tell user-driven scroll from everything else.
//
// Coordinates: CDP Input takes viewport CSS px (DIP), which is what getBoundingClientRect returns
// (page px, after the app's CSS zoom) — so the scroller's rect centre is the right target at any
// uiFontScale.

import { SEL, sleep } from './common.mjs'

/**
 * Where synthesized scroll input lands: a point inside `selector` whose hit-test chain up to the
 * scroller has NO nested scrollable box. Over a code block or a tool's output box, wheel and
 * gesture input scroll that box first (scroll latching), so the chat would not move and the
 * sample would measure the nested box. The column's side gutter is tried first (empty space
 * that belongs to the scroller), then points down the centre line.
 */
export async function scrollerPoint(win, selector = SEL.scroller) {
  const pt = await win.evaluate((sel) => {
    const el = [...document.querySelectorAll(sel)].pop()
    if (!el) return null
    const r = el.getBoundingClientRect()
    const nested = (hit) => {
      for (let n = hit; n && n !== el; n = n.parentElement) {
        const cs = getComputedStyle(n)
        if (
          (cs.overflowY === 'auto' || cs.overflowY === 'scroll') &&
          n.scrollHeight > n.clientHeight + 1
        )
          return true
      }
      return false
    }
    const ok = (x, y) => {
      const hit = document.elementFromPoint(x, y)
      return !!hit && el.contains(hit) && !nested(hit)
    }
    const ys = [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8].map((f) => r.top + r.height * f)
    for (const x of [r.left + 6, r.left + r.width / 2])
      for (const y of ys) if (ok(x, y)) return { x: Math.round(x), y: Math.round(y) }
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  }, selector)
  if (!pt) throw new Error(`scroller ${selector} not found`)
  return pt
}

/**
 * One mouse-wheel notch (deltaY > 0 scrolls down). CDP-dispatched wheel events arrive with
 * precise deltas, so Chromium applies them without its smooth-wheel animation.
 */
export async function wheelNotch(cdp, win, pt, deltaY) {
  await win.evaluate(() => window.__scrollBench.markInput())
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: pt.x,
    y: pt.y,
    deltaX: 0,
    deltaY
  })
}

/** `ticks` notches `gapMs` apart (a gap array gives per-notch cadence). */
export async function wheelBurst(cdp, win, pt, { ticks, deltaY, gapMs }) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y })
  for (let i = 0; i < ticks; i++) {
    await wheelNotch(cdp, win, pt, deltaY)
    await sleep(Array.isArray(gapMs) ? gapMs[i % gapMs.length] : gapMs)
  }
}

/**
 * `Input.synthesizeScrollGesture`: the primitive Chromium's smoothness benchmarks use. CDP's
 * yDistance is positive to scroll UP (content moves down); `down: true` flips it.
 * Resolves when the gesture has been delivered.
 */
export async function gesture(
  cdp,
  win,
  pt,
  { distance, speed, source = 'mouse', down = true, fling = false }
) {
  await win.evaluate(() => window.__scrollBench.inputBegin())
  try {
    await cdp.send('Input.synthesizeScrollGesture', {
      x: pt.x,
      y: pt.y,
      yDistance: down ? -distance : distance,
      speed,
      gestureSourceType: source,
      preventFling: !fling
    })
  } finally {
    await win.evaluate(() => window.__scrollBench.inputEnd())
  }
}

/**
 * Touch scrolling over CDP `Input.dispatchTouchEvent` (start, a move per ~16 ms, end): the
 * renderer's own gesture detector turns it into scroll, and into a fling when the stroke ends
 * fast. `synthesizeScrollGesture` with a touch source scrolled nothing on this Windows host, even
 * with touch emulation on, so touch goes through here. A finger cannot travel 3000 px inside a
 * ~560 px scroller, so `distance` is covered in strokes of at most `stroke` px (lift, re-press),
 * like a person. `down: true` scrolls the content down (the finger moves up).
 */
export async function touchScroll(
  cdp,
  win,
  pt,
  { distance, speed, down = true, fling = false, stroke = 260 }
) {
  const strokes = fling ? 1 : Math.max(1, Math.ceil(distance / stroke))
  const per = fling ? Math.min(distance, stroke) : distance / strokes
  await win.evaluate(() => window.__scrollBench.inputBegin())
  try {
    for (let k = 0; k < strokes; k++) {
      const steps = Math.max(3, Math.round((per / speed) * 60))
      const dy = ((down ? -1 : 1) * per) / steps
      let y = down ? pt.y + per / 2 : pt.y - per / 2
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: pt.x, y: Math.round(y) }]
      })
      for (let i = 0; i < steps; i++) {
        y += dy
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: pt.x, y: Math.round(y) }]
        })
        await sleep(16)
      }
      if (!fling) await sleep(120) // hold still before lifting: no fling velocity
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      if (!fling) await sleep(60)
    }
  } finally {
    await win.evaluate(() => window.__scrollBench.inputEnd())
  }
}

/**
 * Click `locator` and mark synthesized input on the frame the click LANDS: a capture listener
 * on the element marks it from inside the page (Playwright's actionability wait can take several
 * frames between "about to click" and the click). While content streams the button re-mounts
 * (fade-in) and may never pass Playwright's "stable" check; then it is clicked where it is.
 */
export async function clickMarked(win, locator) {
  await locator
    .evaluate((el) =>
      el.addEventListener('click', () => window.__scrollBench?.markInput(), {
        once: true,
        capture: true
      })
    )
    .catch(() => {})
  try {
    await locator.click({ timeout: 3000 })
  } catch {
    await locator.click({ force: true, timeout: 3000 })
  }
}

export async function clickScrollToBottom(win) {
  const btn = win.locator(SEL.scrollToBottom)
  if (!(await btn.count())) return false
  try {
    await clickMarked(win, btn.first())
  } catch {
    if (!(await btn.count())) return false
    throw new Error('scroll-to-bottom button could not be clicked')
  }
  return true
}

// Opening a Claude transcript through the real sidebar (DirectoryItem -> SessionItem click, the
// same `loadSessionIntoStore` path a user's click takes) and waiting for it to be rendered.
import { SEL } from './common.mjs'

/** Open the session `sessionId` listed under the directory group `projectKey`. */
export async function openSession(win, { projectKey, sessionId, timeout = 120_000 }) {
  const item = `[data-testid="SessionItem"][data-id="${sessionId}"]`
  const dir = `[data-testid="DirectoryItem"][data-id="${projectKey}"]`
  const deadline = Date.now() + timeout
  // The sidebar lists directories once discovery has run; the group may need expanding.
  while (Date.now() < deadline) {
    if (await win.locator(item).count()) break
    if (await win.locator(dir).count()) {
      await win.locator(`${dir} > div`).first().click()
      await win.waitForTimeout(700) // DirectoryItem defers a click to rule out a double-click
    } else await win.waitForTimeout(500)
  }
  await win.locator(item).first().click({ timeout: 10_000 })
  const t0 = Date.now()
  await win.waitForFunction(
    ({ sid, scroller, anchor }) => {
      const st = window.__claudeuiVerifier.sessionStore.getState()
      if (st.activeSessionId !== sid) return false
      if (!(st.sessions[sid]?.messages?.length ?? 0)) return false
      return !!document.querySelector(scroller)?.querySelector(anchor)
    },
    { sid: sessionId, scroller: SEL.scroller, anchor: SEL.anchor },
    { timeout: Math.max(5_000, deadline - Date.now()), polling: 250 }
  )
  const loadMs = Date.now() - t0
  await win.waitForTimeout(1500) // the session-switch scroll-to-bottom timers + first layout
  const info = await win.evaluate(
    ({ sid, scroller, anchor }) => {
      const st = window.__claudeuiVerifier.sessionStore.getState()
      const el = document.querySelector(scroller)
      return {
        messages: st.sessions[sid]?.messages?.length ?? 0,
        anchors: el ? el.querySelectorAll(anchor).length : 0,
        scrollHeight: el?.scrollHeight ?? 0,
        clientHeight: el?.clientHeight ?? 0
      }
    },
    { sid: sessionId, scroller: SEL.scroller, anchor: SEL.anchor }
  )
  return { loadMs, ...info }
}

/**
 * Wait until the element's scrollTop and scrollHeight have held still for `stableMs` (wall time,
 * so the criterion does not depend on the display's refresh rate), or `timeout`.
 */
export async function settle(
  win,
  { stableMs = 300, timeout = 4000, selector = SEL.scroller } = {}
) {
  return win.evaluate(
    ({ stableMs, timeout, selector }) =>
      new Promise((resolve) => {
        const el = [...document.querySelectorAll(selector)].pop()
        const t0 = performance.now()
        if (!el) return resolve({ ms: 0, stable: false })
        let last = null
        let since = t0
        const step = (now) => {
          const cur = `${el.scrollTop}|${el.scrollHeight}`
          if (cur !== last) {
            last = cur
            since = now
          }
          const elapsed = now - t0
          if (now - since >= stableMs || elapsed > timeout)
            resolve({ ms: since - t0, stable: now - since >= stableMs })
          else requestAnimationFrame(step)
        }
        requestAnimationFrame(step)
      }),
    { stableMs, timeout, selector }
  )
}

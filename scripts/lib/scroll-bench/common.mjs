// Shared constants and helpers for the chat-scroll bench. Selectors are defined ONCE here; the
// in-page sampler receives them as an argument (page.evaluate serialises its function, so it
// cannot import).

// Where a build may lack a test id, the selector is a LIST: the test id first, then the
// structural fallback (both match the same element when both exist). The preflight records which
// ids the build under test carries (`REQUIRED_TEST_IDS`).
export const SEL = Object.freeze({
  /** The chat transcript's scroll element (ChatPanel's scroller). */
  scroller: '[data-testid="ChatPanel.scroll"], [data-testid="ChatPanel"] .chat-scroll',
  /** ChatPanel's running dots. */
  typing: '[data-testid="ChatPanel.typingIndicator"]',
  /** ChatPanel's scroll-to-bottom button (rendered only while not at the bottom). */
  scrollToBottom: '[data-testid="ChatPanel.scrollToBottom"]',
  /** The subagent detail panel's scroll body (TaskEntry's body). */
  panelBody:
    '[data-testid="TaskEntry.body"], [data-testid="TaskEntry"] > .relative > .overflow-y-auto',
  /** TaskEntry's scroll-to-bottom button (pre-fix builds render it exactly when !following). */
  panelScrollToBottom: '[data-testid="TaskEntry.scrollToBottom"]',
  /** Per-message wrappers (cv-auto + SEARCH_ANCHOR). */
  anchor: '[data-search-anchor]'
})

/** Test ids the bench relies on; the preflight records which ones the build carries. */
export const REQUIRED_TEST_IDS = [
  'ChatPanel.typingIndicator',
  'TaskEntry.body',
  'ChatPanel.scroll',
  'ChatPanel.scrollToBottom'
]

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** DOM mutation records under `selector` during `ms` (0 when the element is absent). */
export function mutationsDuring(win, selector, ms) {
  return win.evaluate(
    ({ selector, ms }) =>
      new Promise((resolve) => {
        const el = document.querySelector(selector)
        if (!el) return resolve(0)
        let n = 0
        const mo = new MutationObserver((recs) => (n += recs.length))
        mo.observe(el, { childList: true, subtree: true, characterData: true })
        setTimeout(() => {
          mo.disconnect()
          resolve(n)
        }, ms)
      }),
    { selector, ms }
  )
}

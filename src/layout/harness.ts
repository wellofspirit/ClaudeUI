/**
 * A real layout engine for tests that have to measure geometry.
 *
 * Every other test layer in this repo runs in jsdom, which has NO layout: every
 * `getBoundingClientRect()` is a 0x0 box and no flex, `min-width`, `truncate`
 * or container query is ever resolved. That is why `TopBar`'s and `AuthPill`'s
 * component tests were all green while the real app was visibly broken — the
 * pill painting over the VS Code button and erasing the session title is a
 * fact about flex shrinking, and jsdom cannot hold an opinion about it.
 *
 * So this harness takes the markup a normal client render produces (React,
 * jsdom, real store state — see `TopBar.layout.test.tsx`), pairs it with the
 * app's OWN compiled CSS (vite + the same `@tailwindcss/vite` plugin the app
 * builds with, from `src/renderer/src/assets/main.css`, so the classes under
 * test are the ones the app ships, not a hand-written replica), and measures it
 * in a real Chromium.
 *
 * It needs a browser binary and takes seconds, so the `layout` vitest project
 * is gated out of `bun run test` / `test:ci` (`bun run test:layout`), exactly
 * like `integration`. Everything it pins is a CSS property of the shipped
 * classes, so nothing here duplicates what a jsdom test could have asserted.
 */
import { inject } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'

/**
 * The app's real stylesheet, built once per run by `global-setup.ts` (which
 * explains why the build cannot happen here).
 */
export function appCss(): string {
  return inject('appCss')
}

let browserPromise: Promise<Browser> | null = null

export function layoutBrowser(): Promise<Browser> {
  browserPromise ??= chromium.launch()
  return browserPromise
}

export async function closeLayoutBrowser(): Promise<void> {
  if (!browserPromise) return
  const browser = await browserPromise
  browserPromise = null
  await browser.close()
}

export interface Box {
  left: number
  right: number
  top: number
  bottom: number
  width: number
  height: number
}

export interface Measured {
  /** `null` when the selector matches nothing, or matches a `display:none`
   *  element — which has no box at all, not a zero-sized one at (0,0). */
  box: Box | null
  /**
   * The part of the box a user can actually SEE: the layout box intersected
   * with every clipping ancestor.
   *
   * This is the distinction the defect hid behind. `getBoundingClientRect()`
   * reports the layout box, so an element overflowing an `overflow-hidden`
   * parent still measures at full width — a test that only read the layout box
   * could not tell "fits" from "is cut off", and a test that only read the
   * clipped box could not tell "fits" from "overflows a parent that happens to
   * clip". Both are needed, so both are reported.
   */
  visible: Box | null
  text: string | null
}

/**
 * Open a page holding `bodyHtml` under the app's real CSS. The returned page
 * can be re-measured at any number of widths without re-rendering: width is
 * the independent variable of every question here, and re-laying-out the same
 * markup is exactly what the app does when the sidebar collapses.
 */
export async function openBar(bodyHtml: string, zoom = 1): Promise<Page> {
  const css = appCss()
  const browser = await layoutBrowser()
  const page = await browser.newPage({ viewport: { width: 1600, height: 400 } })
  // `zoom` reproduces `SessionView`, which renders the whole app under CSS
  // `zoom: uiFontScale`. It is on an ANCESTOR of the bar, as it is in the app:
  // container-query lengths and `getBoundingClientRect` resolve in different
  // coordinate spaces under zoom (the repo has been bitten by that once
  // already — see `use-anchored-menu`), so whether the pill's compact
  // threshold survives a zoomed app is a measurement, not an argument.
  await page.setContent(
    `<!doctype html><html><head><style>${css}</style>` +
      `<style>#bar-host{overflow:visible}</style></head>` +
      `<body><div style="zoom:${zoom}"><div id="bar-host">${bodyHtml}</div></div></body></html>`,
    { waitUntil: 'load' }
  )
  return page
}

/** Lay the markup out at `width` px and measure each selector. */
export async function measure(
  page: Page,
  width: number,
  selectors: Record<string, string>
): Promise<Record<string, Measured>> {
  return await page.evaluate(
    ({ width, selectors }) => {
      const host = document.getElementById('bar-host')
      if (!host) throw new Error('no #bar-host')
      host.style.width = `${width}px`
      // Force a layout pass before reading anything back.
      void host.offsetWidth

      const toBox = (rect: DOMRect | { [k: string]: number }): Record<string, number> => ({
        left: rect.left as number,
        right: rect.right as number,
        top: rect.top as number,
        bottom: rect.bottom as number,
        width: (rect.right as number) - (rect.left as number),
        height: (rect.bottom as number) - (rect.top as number)
      })

      /** Intersect with every ancestor that clips, which is what the eye sees. */
      const visibleBox = (el: Element): Record<string, number> => {
        const r = el.getBoundingClientRect()
        let left = r.left
        let right = r.right
        let top = r.top
        let bottom = r.bottom
        for (let p = el.parentElement; p; p = p.parentElement) {
          const style = getComputedStyle(p)
          const clipsX = style.overflowX !== 'visible'
          const clipsY = style.overflowY !== 'visible'
          if (!clipsX && !clipsY) continue
          const pr = p.getBoundingClientRect()
          if (clipsX) {
            left = Math.max(left, pr.left)
            right = Math.min(right, pr.right)
          }
          if (clipsY) {
            top = Math.max(top, pr.top)
            bottom = Math.min(bottom, pr.bottom)
          }
        }
        return toBox({ left, right: Math.max(left, right), top, bottom: Math.max(top, bottom) })
      }

      const out: Record<string, unknown> = {}
      for (const [name, selector] of Object.entries(selectors)) {
        const el = document.querySelector(selector)
        // `getClientRects().length === 0` is the DOM's own answer to "is this
        // laid out at all" — a `display:none` element still answers
        // `getBoundingClientRect()` with a 0x0 box at the origin, which would
        // read as "an element sitting outside its group".
        out[name] =
          el && el.getClientRects().length > 0
            ? {
                box: toBox(el.getBoundingClientRect()),
                visible: visibleBox(el),
                text: el.textContent
              }
            : { box: null, visible: null, text: null }
      }
      return out as Record<string, Measured>
    },
    { width, selectors }
  )
}

/** `inner` is inside `outer` to within half a device pixel. */
export function contains(outer: Box, inner: Box): boolean {
  return inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5
}

export function fmt(box: Box | null): string {
  return box
    ? `${box.left.toFixed(1)}→${box.right.toFixed(1)} (${box.width.toFixed(1)}px)`
    : 'absent'
}

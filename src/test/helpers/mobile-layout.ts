/**
 * Helpers for the `browser` project's layout tests (docs/testing-strategy.md,
 * Layer 2b): the phone profile, a wrapper that renders the way SessionView does,
 * and the geometry predicates the tests share.
 *
 * Runs in real Chromium only — every function here reads layout.
 */
import { createElement, type ReactNode } from 'react'
import { MOBILE_PROFILES } from '../../../scripts/lib/mobile-profiles.mjs'

export const PROFILE = MOBILE_PROFILES['s25-ultra-edge']
/** The `uiFontScale` values every layout holds at: default, the owner's, the maximum. */
export const FONT_SCALES: readonly number[] = PROFILE.fontScales

/**
 * What SessionView does to the whole app: `zoom: uiFontScale` on a root whose
 * width is `calc(100vw / scale)`. Everything inside is therefore in ZOOMED px,
 * `vw` lengths inside it are multiplied by the zoom (the zoom trap), and
 * `getBoundingClientRect()` reports page px — exactly what a layout test must
 * measure to see what the phone shows.
 *
 * `width` overrides the root's width (a desktop-sized case on the same viewport).
 */
export function ZoomFrame(props: {
  scale: number
  width?: string
  children: ReactNode
}): ReturnType<typeof createElement> {
  const { scale, width, children } = props
  return createElement(
    'div',
    {
      'data-testid': 'ZoomFrame',
      style: {
        zoom: scale,
        width: width ?? `calc(100vw / ${scale})`,
        minHeight: `calc(100dvh / ${scale})`,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end'
      }
    },
    children
  )
}

/**
 * The composer as InputBox/View.tsx draws it on a phone: 8px side padding, a
 * `relative` bordered box. `data-testid="LayoutComposer"` is the box the agent
 * overlay anchors to (its containing block).
 */
export function LayoutComposer(props: { children: ReactNode }): ReturnType<typeof createElement> {
  return createElement(
    'div',
    { style: { padding: '8px 8px 16px' } },
    createElement(
      'div',
      { className: 'mx-auto max-w-full' },
      createElement(
        'div',
        {
          'data-testid': 'LayoutComposer',
          className: 'relative rounded-2xl border border-border bg-bg-input',
          style: { minHeight: 64 }
        },
        props.children
      )
    )
  )
}

/**
 * The chat message list as the phone draws it, so a Task card is measured at the
 * width and under the zoom it really has. The CHAT has its own zoom, separate
 * from the app's: ChatPanel zooms the list by `chatFontScale / uiFontScale`
 * inside the app's `uiFontScale` zoom, so a card in it sits under `chatFontScale`
 * alone and `uiFontScale` does not touch it (the composer and the agent overlay
 * are outside this zoom, under the app's only).
 *
 * The chain, outside in (uiFontScale 1 here, so the app zoom is the identity):
 *  - the scroller, `flex-1 overflow-y-auto chat-scroll mr-2`
 *    (chat/ChatPanel/ChatPanel.tsx:312). It carries `chat-scroll`, whose classic
 *    scrollbar is 7px wide (`.chat-scroll::-webkit-scrollbar`, assets/app.css:166);
 *    Electron and any desktop-class browser draw it, Android's overlay scrollbars
 *    take none. The classic-scrollbar case is the NARROWER one, so it is the one
 *    modelled. Playwright launches Chromium with `--hide-scrollbars`, which
 *    reserves no gutter even under `overflow-y: scroll`, so the 7px is explicit
 *    (`padding-right`) instead;
 *  - the zoomed column, `zoom: chatFontScale / uiFontScale` + `mx-auto pt-5 pb-6
 *    flex flex-col gap-3 px-3` on mobile (ChatPanel.tsx:352-353);
 *  - the tool group, `rounded-xl border border-border p-2 flex flex-col gap-2`
 *    (chat/MessageBubble.tsx:483), drawn around two or more tool calls in one
 *    message. A lone call renders without it (18px more card), so this is the
 *    narrower of the two real cases.
 *
 * `width` is the scroller's outer width (the window), default the phone's.
 */
export function LayoutChatList(props: {
  chatScale: number
  width?: string
  children: ReactNode
}): ReturnType<typeof createElement> {
  const { chatScale, width, children } = props
  return createElement(
    'div',
    { style: { width: width ?? '100vw' } },
    createElement(
      'div',
      { className: 'chat-scroll mr-2', style: { paddingRight: 7 } },
      createElement(
        'div',
        {
          'data-testid': 'LayoutChatList',
          style: chatScale !== 1 ? { zoom: chatScale } : undefined,
          className: 'mx-auto pt-5 pb-6 flex flex-col gap-3 px-3'
        },
        createElement(
          'div',
          { className: 'rounded-xl border border-border p-2 flex flex-col gap-2' },
          children
        )
      )
    )
  )
}

/** Two animation frames: React has committed and Chromium has laid out. */
export async function settle(): Promise<void> {
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  )
}

export function rectOf(el: Element): DOMRect {
  return el.getBoundingClientRect()
}

/** Sub-pixel slack for zoomed, fractional layout. */
const EPS = 0.75

/** `inner`'s box lies inside `outer`'s (page px). */
export function isInside(inner: Element, outer: Element, eps = EPS): boolean {
  const i = rectOf(inner)
  const o = rectOf(outer)
  return (
    i.left >= o.left - eps &&
    i.right <= o.right + eps &&
    i.top >= o.top - eps &&
    i.bottom <= o.bottom + eps
  )
}

/** `el` is inside the viewport horizontally. */
export function isInsideViewportX(el: Element, eps = EPS): boolean {
  const r = rectOf(el)
  return r.left >= -eps && r.right <= window.innerWidth + eps
}

/** The box clips nothing sideways (integer scrollWidth, so a 1px slack). */
export function hasNoHorizontalOverflow(el: Element): boolean {
  return el.scrollWidth <= el.clientWidth + 1
}

/** The effective CSS zoom on an element: its page-px width over its own CSS px width. */
export function zoomOf(el: Element): number {
  const html = el as HTMLElement
  return html.offsetWidth > 0 ? rectOf(el).width / html.offsetWidth : 1
}

/**
 * The element's text sits on one line: its content box is no taller than 1.5
 * lines. Padding and borders are excluded, so a chip is measured by its text.
 */
export function isOneLine(el: Element): boolean {
  const cs = getComputedStyle(el)
  const z = zoomOf(el)
  const fontSize = parseFloat(cs.fontSize)
  const parsed = parseFloat(cs.lineHeight)
  const lineHeight = Number.isFinite(parsed) ? parsed : fontSize * 1.25
  const chrome =
    parseFloat(cs.paddingTop) +
    parseFloat(cs.paddingBottom) +
    parseFloat(cs.borderTopWidth) +
    parseFloat(cs.borderBottomWidth)
  const content = rectOf(el).height - chrome * z
  return content <= lineHeight * z * 1.5
}

export function byTestId(root: ParentNode, id: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  if (!el) throw new Error(`no [data-testid="${id}"]`)
  return el
}

export function allByTestId(root: ParentNode, id: string): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`))
}

/** The element's children that take part in layout (not `display: none`). */
export function visibleChildren(el: Element): Element[] {
  return Array.from(el.children).filter((c) => c.getClientRects().length > 0)
}

/**
 * How many rows the elements sit on, by their vertical centres (items of
 * different heights share a row but not a top). Centres further apart than
 * `tolerance` page px start a new row.
 */
export function rowCount(els: readonly Element[], tolerance = 3): number {
  const centres = els
    .map((el) => {
      const r = rectOf(el)
      return r.top + r.height / 2
    })
    .sort((a, b) => a - b)
  let rows = centres.length > 0 ? 1 : 0
  for (let i = 1; i < centres.length; i++) if (centres[i] - centres[i - 1] > tolerance) rows++
  return rows
}

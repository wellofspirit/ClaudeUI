/**
 * The top bar's left group, measured in a real layout engine (ADR-070 §4).
 *
 * WHY THIS FILE EXISTS. A verification drive found the auth pill painting over
 * the VS Code button with the session title erased to zero width — while every
 * `TopBar` and `AuthPill` component test was green. They were green honestly:
 * jsdom has no layout, so "the pill overflows its flex group" is not a
 * statement jsdom can evaluate. The pill is `shrink-0`, the right cluster
 * cannot shrink at all, and the left group had no floor and no clip, so a
 * squeezed bar gave the title 0 px and let the pill paint outside its own box.
 *
 * Measured by the drive at a 1098 px bar: `TopBar.info` 65 px with no pill,
 * 0 px with one, and the pill's right edge 10-25 px past the left group's.
 *
 * WHAT IT PINS — the three invariants, at every width, for every pill label:
 *
 *   1. the pill's box is inside the left group's box (it can never paint over
 *      the right cluster, and the slice of it under a later-in-DOM button can
 *      never stop being clickable);
 *   2. the session title is never zero-width while the pill is shown;
 *   3. the pill is never CUT OFF — at every width it is either fully legible
 *      or in its compact dot-with-count form.
 *
 * WIDTHS ARE SELF-CALIBRATING. The bar is swept relative to the measured width
 * of its own right cluster, because the defect is about the space that cluster
 * leaves — and the drive proved the same code is fine with the sidebar
 * collapsed (112 px of slack) and broken with it open. A window-size
 * breakpoint would have described neither.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import type { Page } from 'playwright'
import { useSessionStore } from '../renderer/src/stores/session-store'
import { SidebarContext } from '../renderer/src/components/SessionView'
import { TopBar } from '../renderer/src/components/chat/ChatPanel/TopBar'
import type { AuthRequiredState } from '../shared/remote-protocol'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { mirrorStoreIntoReplica } from '@test/helpers/replica-seed'
import { closeLayoutBrowser, contains, fmt, measure, openBar, type Box } from './harness'

vi.mock('electron', async () => await import('../test/stubs/electron-shim'))

const ROUTE = 'route-layout'
const OTHER = 'route-layout-2'

const SELECTORS = {
  leftGroup: '[data-testid="TopBar.leftGroup"]',
  info: '[data-testid="TopBar.info"]',
  pill: '[data-testid="AuthPill"]',
  label: '[data-testid="AuthPill.label"]',
  count: '[data-testid="AuthPill.count"]',
  rightGroup: '[data-testid="TopBar.rightGroup"]'
}

/**
 * Below this much room for title + pill — measured as the left group's right
 * edge minus where the title starts, so it holds for any DOM shape — the bar
 * has overflowed its own window and everything in it is degenerate: the
 * title's 34px reservation for the pill cannot be honoured, and the pill's
 * backstop hides it rather than show a dot cut in half. At or above it, both
 * the title and the pill must be there.
 *
 * Containment and "never cut off" are asserted at EVERY width, degenerate
 * included: there is no width at which painting over the right cluster is the
 * correct answer.
 */
const DEGENERATE = 60

/** Tests are exempt from the sealed-field lint rule; this is the fixture seam. */
function blame(routingId: string, authRequired: AuthRequiredState | null): void {
  useSessionStore.setState((s) => ({
    sessions: { ...s.sessions, [routingId]: { ...s.sessions[routingId], authRequired } }
  }))
}

/** Render the bar in jsdom (real component, real store) and hand the browser
 *  its markup. Client-rendered, not SSR: zustand serves `getInitialState` to
 *  `renderToStaticMarkup`, which would silently measure an empty store. */
async function barAt(collapsed: boolean, zoom = 1): Promise<Page> {
  const { container } = render(
    <SidebarContext.Provider value={{ collapsed, toggle: () => {}, isMobile: false }}>
      <TopBar hasContent />
    </SidebarContext.Provider>
  )
  return await openBar(container.innerHTML, zoom)
}

interface Violation {
  width: number
  reason: string
}

interface Row {
  width: number
  group: Box
  info: Box
  pill: Box | null
  clipped: number
  /** Space for title + pill: the group's right edge minus the title's left. */
  room: number
  /** Which form the pill is actually RENDERING — the only honest way to ask,
   *  since both forms are in the DOM and CSS decides which one has a box. */
  form: 'full' | 'compact' | 'none'
}

/**
 * Sweep the bar from "barely wider than its right cluster" to "roomy" and
 * report every width where an invariant breaks.
 *
 * Returns the sweep as well, so a caller can assert the sweep actually visited
 * both regimes — an invariant that only holds because the pill was never under
 * pressure is not pinned at all.
 */
async function sweep(page: Page, zoom = 1): Promise<{ violations: Violation[]; rows: Row[] }> {
  const wide = await measure(page, 1600, SELECTORS)
  const right = wide.rightGroup.box
  expect(right, 'the right cluster must render — it is what squeezes the left group').not.toBeNull()
  // Rects come back in PAGE px and the width is set in the bar's own px, which
  // differ by the zoom — sweeping without this divides the narrow end away and
  // the pill is never put under pressure at all.
  const base = Math.round(right!.width / zoom)

  const violations: Violation[] = []
  const rows: Row[] = []

  for (let extra = 40; extra <= 560; extra += 20) {
    const width = base + extra
    const m = await measure(page, width, SELECTORS)
    const group = m.leftGroup.box
    const info = m.info.box
    const pill = m.pill.box
    if (!group || !info) {
      violations.push({ width, reason: 'left group or title missing from the DOM' })
      continue
    }

    const room = (group.right - info.left) / zoom
    const clipped = pill ? pill.width - (m.pill.visible?.width ?? 0) : 0
    const form = !pill ? 'none' : m.label.box ? 'full' : 'compact'
    rows.push({ width, group, info, pill, clipped, form, room })

    if (info.width <= 0 && room >= DEGENERATE)
      violations.push({
        width,
        reason: `title erased: info ${fmt(info)} with ${room.toFixed(1)}px of room, group ${fmt(group)}`
      })

    if (!pill) {
      if (room >= DEGENERATE)
        violations.push({
          width,
          reason: `pill vanished with ${room.toFixed(1)}px of room for title + pill`
        })
      continue
    }
    if (!contains(group, pill))
      violations.push({
        width,
        reason: `pill escapes its group: pill ${fmt(pill)} vs group ${fmt(group)}`
      })
    if (clipped > 0.5)
      violations.push({
        width,
        reason: `pill cut off by ${clipped.toFixed(1)}px: pill ${fmt(pill)}, visible ${fmt(m.pill.visible)}`
      })
    // Exactly one form has a box. Both are in the DOM at all times, so "the
    // label is present" proves nothing — this is what makes the compact
    // fallback a fact rather than a class name.
    if (form === 'full' && m.count.box)
      violations.push({ width, reason: 'full label and compact count rendered together' })
    // The compact form is a CIRCLE (`w-[22px] h-[22px]`), asserted as
    // width == height rather than as 22 so the same check holds under the
    // app's CSS zoom, which scales both.
    if (form === 'compact' && Math.abs(pill.width - pill.height) > 0.5)
      violations.push({
        width,
        reason: `compact pill is ${pill.width.toFixed(1)}x${pill.height.toFixed(1)}, not a circle`
      })
  }
  return { violations, rows }
}

function table(rows: Row[]): string {
  return rows
    .map(
      (r) =>
        `  bar ${r.width}: group ${fmt(r.group)} room ${r.room.toFixed(1)} info ${fmt(r.info)}` +
        ` pill ${fmt(r.pill)} clip ${r.clipped.toFixed(1)} form ${r.form}`
    )
    .join('\n')
}

describe('TopBar left group — real geometry', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await bootTestApp()
  })

  afterAll(async () => {
    app.teardown()
    await closeLayoutBrowser()
  })

  beforeEach(() => {
    useSessionStore.setState({
      activeSessionId: null,
      sessions: {},
      signInDialog: null,
      authState: null,
      vendorOAuth: null,
      providerAuth: { anthropic: 'unknown', chatgpt: 'unknown', chatgptRoutes: {} }
    })
    useSessionStore.getState().createNewSession(ROUTE, '/d/WorkPlace/ClaudeUI')
    useSessionStore.getState().createNewSession(OTHER, '/d/WorkPlace/other')
    useSessionStore.setState({ activeSessionId: ROUTE })
  })

  afterEach(() => {
    cleanup()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
    mirrorStoreIntoReplica()
  })

  it('keeps the title and contains the pill at every width — one provider, `needed`', async () => {
    useSessionStore.setState({
      providerAuth: { anthropic: 'unauthenticated', chatgpt: 'unknown', chatgptRoutes: {} }
    })
    const page = await barAt(false)
    const { violations, rows } = await sweep(page)
    console.log(table(rows))
    expect(violations).toEqual([])
    await page.close()
  })

  it('keeps the title and contains the pill at every width — two providers, `expired`', async () => {
    // The drive's worst case: "2 sign-ins needed" is the widest label the pill
    // has, and it is the one that overlapped the VS Code button by 25 px.
    useSessionStore.setState({
      providerAuth: { anthropic: 'unauthenticated', chatgpt: 'unknown', chatgptRoutes: {} }
    })
    blame(ROUTE, { providerId: 'chatgpt' })
    blame(OTHER, { providerId: 'anthropic' })
    const page = await barAt(false)
    const { violations, rows } = await sweep(page)
    console.log(table(rows))
    expect(violations).toEqual([])

    // The sweep has to have visited both regimes, or it pins nothing: the pill
    // must be legible in full somewhere, and compact where there is no room.
    expect(
      rows.filter((r) => r.form === 'full').length,
      'no width showed the full label'
    ).toBeGreaterThan(0)
    expect(
      rows.filter((r) => r.form === 'compact').length,
      'no width fell back to the compact pill'
    ).toBeGreaterThan(0)
    // Compact keeps the count — the load-bearing part (ADR-070 §4).
    const compact = await measure(page, rows.find((r) => r.form === 'compact')!.width, SELECTORS)
    expect(compact.count.text).toBe('2')
    await page.close()
  })

  it('keeps the title and contains the pill at every width — `resolved`, retry owed', async () => {
    blame(ROUTE, {
      providerId: 'anthropic',
      resolved: true,
      retryPrompt: 'refactor the dispatcher'
    })
    const page = await barAt(false)
    const { violations } = await sweep(page)
    expect(violations).toEqual([])
    await page.close()
  })

  it('shows the full label with the sidebar collapsed, where the slack is real', async () => {
    // Same code, +276 px of left group: the drive's `D2c` control. Whatever
    // drives the compact form must be available width, not a window breakpoint.
    useSessionStore.setState({
      providerAuth: { anthropic: 'unauthenticated', chatgpt: 'unknown', chatgptRoutes: {} }
    })
    const page = await barAt(true)
    const { violations, rows } = await sweep(page)
    console.log(table(rows))
    expect(violations).toEqual([])
    expect(rows.some((r) => r.form === 'full')).toBe(true)
    await page.close()
  })

  it('holds under the app’s own CSS zoom (uiFontScale), both directions', async () => {
    useSessionStore.setState({
      providerAuth: { anthropic: 'unauthenticated', chatgpt: 'unknown', chatgptRoutes: {} }
    })
    blame(ROUTE, { providerId: 'chatgpt' })
    blame(OTHER, { providerId: 'anthropic' })
    for (const zoom of [0.85, 1.15, 1.5]) {
      const page = await barAt(false, zoom)
      const { violations, rows } = await sweep(page, zoom)
      console.log(`zoom ${zoom}\n${table(rows)}`)
      expect(violations, `zoom ${zoom}`).toEqual([])
      // Both regimes still reachable: a zoom that pinned the pill to one form
      // would mean the threshold and the label had stopped scaling together.
      expect(
        rows.some((r) => r.form === 'full'),
        `zoom ${zoom} never full`
      ).toBe(true)
      expect(
        rows.some((r) => r.form === 'compact'),
        `zoom ${zoom} never compact`
      ).toBe(true)
      await page.close()
    }
  })

  it('leaves the title alone when there is no pill at all — the control', async () => {
    const page = await barAt(false)
    const m = await measure(page, 1098, SELECTORS)
    expect(m.pill.box, 'a healthy, unprobed host shows no pill').toBeNull()
    expect(m.info.box!.width).toBeGreaterThan(0)
    await page.close()
  })
})

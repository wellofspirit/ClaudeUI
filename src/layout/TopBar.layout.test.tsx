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
 * SLICE F ADDED THE OTHER HALF (ADR-070 residual 1). Slice E contained the
 * pill; it did not make the bar FIT. The right cluster still wanted 852 px on a
 * bar that can be 320. So the bar now collapses in tiers by container query,
 * and this file is where those tiers' thresholds came from and where they are
 * kept honest:
 *
 *   4. the right cluster never exceeds the bar (above its own measured floor);
 *   5. each tier drops exactly its own children, at the width the numbers in
 *      `top-bar-tiers.ts` claim — thresholds PARSED from the shipped class
 *      strings, never retyped here;
 *   6. the ⋯ button is present exactly when the five tools are gone — never
 *      both, never neither;
 *   7. `GitChangesPill` and `WindowControls` survive every width;
 *   8. a phone viewport is inside the collapsed tier BY CONSTRUCTION, so
 *      "mobile" is a case of the width rule rather than a second rule.
 *
 * WIDTHS ARE ABSOLUTE, NOT SELF-CALIBRATING. Slice E swept relative to the
 * right cluster's measured width because that width was a constant. It is now
 * a function of the bar's own width — three values, one per tier — so
 * calibrating to its widest would skip every width where a tier changes hands,
 * which is the only place the new invariants can break. The sweep therefore
 * runs an absolute range that straddles both thresholds, plus the exact
 * boundary pairs.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'
import type { Page } from 'playwright'
import { useSessionStore } from '../renderer/src/stores/session-store'
import { SidebarContext } from '../renderer/src/components/SessionView'
import { TopBar } from '../renderer/src/components/chat/ChatPanel/TopBar'
import {
  OVERFLOW_HIDE,
  TIER1_HIDE,
  TIER2_HIDE
} from '../renderer/src/components/chat/ChatPanel/top-bar-tiers'
import { MOBILE_BREAKPOINT } from '../renderer/src/hooks/useIsMobile'
import { resolveClaudeCapabilities } from '../shared/model-capabilities'
import type { AuthRequiredState } from '../shared/remote-protocol'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { mirrorStoreIntoReplica, seed } from '@test/helpers/replica-seed'
import { closeLayoutBrowser, contains, fmt, measure, openBar, type Box } from './harness'

vi.mock('electron', async () => await import('../test/stubs/electron-shim'))

const ROUTE = 'route-layout'
const OTHER = 'route-layout-2'
const CWD = '/d/WorkPlace/ClaudeUI'

const SELECTORS = {
  bar: '[data-testid="TopBar"]',
  leftGroup: '[data-testid="TopBar.leftGroup"]',
  info: '[data-testid="TopBar.info"]',
  pill: '[data-testid="AuthPill"]',
  label: '[data-testid="AuthPill.label"]',
  count: '[data-testid="AuthPill.count"]',
  rightGroup: '[data-testid="TopBar.rightGroup"]',
  // Tier 2, in the desktop bar's left-to-right order.
  vscode: '[data-testid="TopBar.openVSCode"]',
  terminal: '[data-testid="TopBar.terminal"]',
  skills: '[data-testid="TopBar.skills"]',
  mcp: '[data-testid="TopBar.mcp"]',
  permissions: '[data-testid="TopBar.permissions"]',
  // Tier 1.
  worktree: '[data-testid="WorktreePill"]',
  branch: '[data-testid="GitBranchPill"]',
  // Never dropped.
  changes: '[data-testid="GitChangesPill"]',
  windowControls: '[data-testid="WindowControls"]',
  overflow: '[data-testid="TopBar.overflowMenu"]',
  overflowPermissions: '[data-testid="TopBar.overflowMenuPermissions"]'
}

const TIER2 = ['vscode', 'terminal', 'skills', 'mcp', 'permissions'] as const
const TIER1 = ['worktree', 'branch'] as const
const NEVER = ['changes', 'windowControls'] as const

/**
 * The thresholds, read out of the class strings the bar actually ships.
 *
 * Tailwind's `@max-[Npx]` compiles to `not (min-width: Npx)` and `@min-[Npx]`
 * to `(min-width: Npx)` — verified against the compiled sheet — so `N` is the
 * first width at which the tier is still SHOWN, and the two are exact
 * complements. Parsed rather than retyped: a threshold that moved in the
 * component and not here would leave this file asserting the old bar.
 */
function thresholdOf(cls: string): number {
  const match = /@(?:max|min)-\[(\d+)px\]/.exec(cls)
  if (!match?.[1]) throw new Error(`no px threshold in ${cls}`)
  return Number(match[1])
}
const T1 = thresholdOf(TIER1_HIDE)
const T2 = thresholdOf(TIER2_HIDE)

/**
 * Bar width ⇄ container width. Container queries resolve against the CONTENT
 * box, so the bar's own horizontal padding (13 px each side on the desktop) is
 * already subtracted before a threshold is compared — which is exactly why the
 * macOS 148 px traffic-light gutter needs no term of its own.
 */
const BAR_PADDING_X = 26
const barWidthFor = (containerWidth: number): number => containerWidth + BAR_PADDING_X

/**
 * The narrowest bar that can hold its own never-dropped children: measured at
 * 301.8 px of container for `GitChangesPill` (109.8 at ±99999 lines) +
 * `WindowControls` (138.0) + ⋯ (30.0) + two 12 px gaps. Below it the bar has
 * overflowed the app's own `minWidth: 600`, and no tier can help — the three
 * survivors are the owner's "never" row. The pill invariants are still
 * asserted below it; only the cluster-containment one is not.
 */
const CLUSTER_FLOOR = 302

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

/**
 * The WORST-CASE cluster: every gate satisfied, every text child at the widest
 * content it can hold. Two reasons it is the fixture the tier thresholds were
 * derived from. The cluster is what squeezes the left group, so a fixture
 * missing the git pills would have measured a bar that is 344 px easier than
 * the one the owner uses; and a threshold picked against typical content is a
 * threshold that fails on the day someone checks out a long branch name.
 */
function seedWorstCaseCluster(routingId: string, cwd: string): void {
  seed.status(routingId, {
    state: 'idle',
    // Null: a non-null sessionId that differs from the routing id would read as
    // a rekey and move the session out from under the test.
    sessionId: null,
    model: null,
    cwd,
    totalCostUsd: 0,
    engineId: 'claude',
    capabilities: resolveClaudeCapabilities('default'),
    account: null
  })
  useSessionStore.getState().setIsGitRepo(routingId, true)
  useSessionStore.getState().setGitStatus(routingId, {
    branch: 'feature/a-fairly-long-branch-name-that-keeps-going',
    ahead: 888,
    behind: 999,
    trackingBranch: 'origin/main',
    files: [{ path: 'a.ts', index: ' ', working: 'M' }],
    staged: [],
    unstaged: ['a.ts'],
    untracked: [],
    linesAdded: 99999,
    linesRemoved: 99999
  } as never)
  useSessionStore.setState((state) => ({
    sessions: {
      ...state.sessions,
      [routingId]: {
        ...state.sessions[routingId],
        worktreeInfo: {
          worktreePath: cwd,
          worktreeBranch: 'a-long-worktree-branch',
          worktreeName: 'abcdefghijklmnopqrstuvwxyz',
          originalCwd: cwd,
          gitRoot: cwd,
          originalHeadCommit: 'abc',
          createdAt: 0
        } as never
      }
    }
  }))
}

/** Render the bar in jsdom (real component, real store) and hand the browser
 *  its markup. Client-rendered, not SSR: zustand serves `getInitialState` to
 *  `renderToStaticMarkup`, which would silently measure an empty store. */
async function barAt(collapsed: boolean, zoom = 1, isMobile = false): Promise<Page> {
  const { container } = render(
    <SidebarContext.Provider value={{ collapsed, toggle: () => {}, isMobile }}>
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
  /** How far the right cluster spills past the bar's own right edge. */
  overflow: number
  /** Which of the collapse tiers are on screen at this width. */
  tier1: boolean
  tier2: boolean
  overflowButton: boolean
}

/**
 * Every width the sweep visits: an absolute range straddling both thresholds,
 * plus the exact boundary PAIRS (`T`, `T - 1`) — a tier that fired one pixel
 * late is a tier whose stated number is wrong, and a 20 px step would never
 * notice.
 */
const SWEEP_WIDTHS: readonly number[] = (() => {
  const widths = new Set<number>()
  for (let width = 330; width <= 1600; width += 20) widths.add(width)
  for (const threshold of [T1, T2])
    for (const container of [threshold, threshold - 1]) widths.add(barWidthFor(container))
  widths.add(barWidthFor(CLUSTER_FLOOR))
  return [...widths].sort((a, b) => a - b)
})()

/**
 * Sweep the bar across every width and report every place an invariant breaks.
 *
 * Returns the sweep as well, so a caller can assert it actually visited both
 * pill regimes and all three tiers — an invariant that only holds because
 * nothing was ever under pressure is not pinned at all.
 */
async function sweep(page: Page, zoom = 1): Promise<{ violations: Violation[]; rows: Row[] }> {
  const violations: Violation[] = []
  const rows: Row[] = []

  for (const width of SWEEP_WIDTHS) {
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

    // ── Slice F: the bar has to fit itself ────────────────────────────────
    const bar = m.bar.box
    const right = m.rightGroup.box
    if (!bar || !right) {
      violations.push({ width, reason: 'the bar or its right cluster is missing from the DOM' })
      continue
    }
    // Both sides, and against the PADDING box rather than the border box: the
    // bar's own 13px right padding is the cluster's gutter, and spilling into
    // it is already a bar that does not fit.
    const overflow = Math.max(right.right - (bar.right - 13 * zoom), bar.left - right.left)
    const container = Math.round(bar.width / zoom) - BAR_PADDING_X
    const tier1Boxes = TIER1.filter((id) => m[id].box)
    const tier2Boxes = TIER2.filter((id) => m[id].box)
    const tier1 = tier1Boxes.length > 0
    const tier2 = tier2Boxes.length > 0
    const overflowButton = !!m.overflow.box

    rows.push({
      width,
      group,
      info,
      pill,
      clipped,
      form,
      room,
      overflow,
      tier1,
      tier2,
      overflowButton
    })

    if (overflow > 0.5 && container >= CLUSTER_FLOOR)
      violations.push({
        width,
        reason:
          `right cluster spills ${overflow.toFixed(1)}px past the bar with ${container}px of ` +
          `container (floor ${CLUSTER_FLOOR}): cluster ${fmt(right)} vs bar ${fmt(bar)}`
      })

    // Tiers are ALL-OR-NOTHING. A half-collapsed tier means one child lost its
    // class, which is how a cluster quietly grows back.
    if (tier1Boxes.length !== 0 && tier1Boxes.length !== TIER1.length)
      violations.push({ width, reason: `tier 1 half-collapsed: ${tier1Boxes.join(', ')}` })
    if (tier2Boxes.length !== 0 && tier2Boxes.length !== TIER2.length)
      violations.push({ width, reason: `tier 2 half-collapsed: ${tier2Boxes.join(', ')}` })

    // The thresholds themselves, read off the shipped class strings.
    if (tier1 !== container >= T1)
      violations.push({
        width,
        reason: `tier 1 ${tier1 ? 'shown' : 'dropped'} at ${container}px of container (T1 ${T1})`
      })
    if (tier2 !== container >= T2)
      violations.push({
        width,
        reason: `tier 2 ${tier2 ? 'shown' : 'dropped'} at ${container}px of container (T2 ${T2})`
      })
    // The ⋯ is the tools' replacement, not an extra: never both, never neither.
    if (overflowButton === tier2)
      violations.push({
        width,
        reason: overflowButton
          ? 'the ⋯ menu and the five tool buttons are on screen together'
          : 'the tools are gone and nothing replaced them'
      })
    for (const id of NEVER)
      if (!m[id].box) violations.push({ width, reason: `${id} was dropped — it is in no tier` })

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
        ` pill ${fmt(r.pill)} clip ${r.clipped.toFixed(1)} form ${r.form}` +
        ` over ${r.overflow.toFixed(1)} tier1 ${r.tier1 ? 'y' : 'n'} tier2 ${r.tier2 ? 'y' : 'n'}` +
        ` dots ${r.overflowButton ? 'y' : 'n'}`
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
    useSessionStore.getState().createNewSession(ROUTE, CWD)
    useSessionStore.getState().createNewSession(OTHER, '/d/WorkPlace/other')
    useSessionStore.setState({ activeSessionId: ROUTE })
    // Slice F: every case now runs against the full cluster. Slice E's fixture
    // had no git status, so the two tier-1 pills never rendered and the bar it
    // swept was 344 px roomier than the owner's — which is also why the pill's
    // compact regime stopped being reachable once the bar learned to collapse.
    seedWorstCaseCluster(ROUTE, CWD)
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

  // ── Slice F: the bar collapses in tiers (ADR-070 residual 1) ─────────────

  it('drops tier 1 — the two git pills — at its stated width, and only there', async () => {
    const page = await barAt(false)
    const above = await measure(page, barWidthFor(T1), SELECTORS)
    const below = await measure(page, barWidthFor(T1 - 1), SELECTORS)
    for (const id of TIER1) {
      expect(above[id].box, `${id} must survive ${T1}px of container`).not.toBeNull()
      expect(below[id].box, `${id} must be gone at ${T1 - 1}px of container`).toBeNull()
    }
    // One pixel of width buys back the whole tier and nothing else: the tools
    // and the never-dropped pair are untouched on both sides of the line.
    for (const id of [...TIER2, ...NEVER]) {
      expect(above[id].box, `${id} above T1`).not.toBeNull()
      expect(below[id].box, `${id} below T1`).not.toBeNull()
    }
    expect(above.rightGroup.box!.width - below.rightGroup.box!.width).toBeCloseTo(344, 0)
    await page.close()
  })

  it('drops tier 2 — the five tools — into the ⋯ menu at its stated width', async () => {
    const page = await barAt(false)
    const above = await measure(page, barWidthFor(T2), SELECTORS)
    const below = await measure(page, barWidthFor(T2 - 1), SELECTORS)
    for (const id of TIER2) {
      expect(above[id].box, `${id} must survive ${T2}px of container`).not.toBeNull()
      expect(below[id].box, `${id} must be gone at ${T2 - 1}px of container`).toBeNull()
    }
    // The ⋯ is the replacement, not an addition.
    expect(above.overflow.box, 'the ⋯ must not sit beside the buttons it replaces').toBeNull()
    expect(below.overflow.box, 'the tools went somewhere — the ⋯ has to be there').not.toBeNull()
    for (const id of NEVER) expect(below[id].box, `${id} below T2`).not.toBeNull()
    await page.close()
  })

  it('fits inside itself at every width down to the never-dropped floor', async () => {
    useSessionStore.setState({
      providerAuth: { anthropic: 'unauthenticated', chatgpt: 'unknown', chatgptRoutes: {} }
    })
    blame(ROUTE, { providerId: 'chatgpt' })
    blame(OTHER, { providerId: 'anthropic' })
    const page = await barAt(false)
    const { violations, rows } = await sweep(page)
    console.log(table(rows))
    expect(violations).toEqual([])
    // The sweep has to have SEEN all three tiers, or "the cluster always fits"
    // is a statement about one tier that happened to be roomy.
    expect(
      rows.some((r) => r.tier1 && r.tier2),
      'never saw the full bar'
    ).toBe(true)
    expect(
      rows.some((r) => !r.tier1 && r.tier2),
      'never saw tier 1 collapsed'
    ).toBe(true)
    expect(
      rows.some((r) => !r.tier1 && !r.tier2),
      'never saw tier 2 collapsed'
    ).toBe(true)
    // And the floor is a real edge, not a number that is simply never reached.
    const floor = rows.find(
      (r) => Math.round(r.group.width) >= 0 && r.width === barWidthFor(CLUSTER_FLOOR)
    )
    expect(floor, `the sweep must visit the ${CLUSTER_FLOOR}px floor`).toBeDefined()
    expect(floor!.overflow).toBeLessThanOrEqual(0.5)
    await page.close()
  })

  it('collapses a phone bar by the same width rule, not a device branch', async () => {
    // 390px is the phone the mobile arc was built against. Nothing here reads
    // `isMobile` except the left group's hamburger — the right cluster is in
    // the collapsed tier because 390 - 16 is below T2, which is the whole
    // point: one rule, and the phone is inside it.
    const page = await barAt(false, 1, true)
    const m = await measure(page, 390, SELECTORS)
    for (const id of [...TIER1, ...TIER2]) expect(m[id].box, `${id} on a 390px bar`).toBeNull()
    expect(m.overflow.box, 'the phone keeps its ⋯ menu').not.toBeNull()
    expect(m.changes.box, 'the phone keeps the changes pill').not.toBeNull()
    await page.close()
  })

  it('lets the ⋯ menu hang below the bar — containment must not clip it', async () => {
    // `container-type: inline-size` applies LAYOUT containment, which makes the
    // bar a containing block and a stacking context. Neither should clip — that
    // is PAINT containment — but "should not" is an argument and this file
    // exists because an argument about CSS was wrong once already. Opened in
    // jsdom before the markup is handed over, so the popover is real DOM.
    const { container } = render(
      <SidebarContext.Provider value={{ collapsed: false, toggle: () => {}, isMobile: false }}>
        <TopBar hasContent />
      </SidebarContext.Provider>
    )
    fireEvent.click(screen.getByTestId('TopBar.overflowMenu'))
    const page = await openBar(container.innerHTML)
    const m = await measure(page, barWidthFor(T2 - 1), SELECTORS)

    const bar = m.bar.box!
    const menu = m.overflowPermissions.box
    expect(menu, 'the open menu must render').not.toBeNull()
    // Below the bar, not inside it, and every pixel of it visible.
    expect(menu!.top).toBeGreaterThanOrEqual(bar.bottom - 0.5)
    expect(m.overflowPermissions.visible!.width).toBeCloseTo(menu!.width, 1)
    expect(m.overflowPermissions.visible!.height).toBeCloseTo(menu!.height, 1)
    await page.close()
  })

  it('keeps the ⋯ menu above the notice band it hangs over', async () => {
    // The other half of the containment bill. If `container-type` makes the
    // bar a stacking context — the spec says it does; Chromium 151 does not,
    // and the app's Electron is neither — the menu's `z-50` is scoped to the
    // bar, and the bar is a `z-auto` box EARLIER in DOM order than
    // `ChatNoticeStack`'s `absolute top-12 z-20`, so the menu would paint
    // UNDER any live notice card, over exactly the band it drops into. `z-30`
    // makes the answer the same in both engines, and a hit test is the only
    // way to say so: a box on top is not a fact about class names.
    const { container } = render(
      <SidebarContext.Provider value={{ collapsed: false, toggle: () => {}, isMobile: false }}>
        <TopBar hasContent />
      </SidebarContext.Provider>
    )
    fireEvent.click(screen.getByTestId('TopBar.overflowMenu'))
    // `ChatPanel`'s shape: the bar and the notice slot are siblings inside one
    // `relative` box, and the slot starts at the bar's own height.
    const page = await openBar(
      `<div class="relative">${container.innerHTML}` +
        `<div data-testid="FakeNotice" class="absolute top-12 left-0 right-0 z-20" ` +
        `style="height:120px;background:#f00"></div></div>`
    )
    const hit = await page.evaluate(
      (width: number) => {
        const host = document.getElementById('bar-host')!
        host.style.width = `${width}px`
        void host.offsetWidth
        const row = document.querySelector('[data-testid="TopBar.overflowMenuPermissions"]')!
        const box = row.getBoundingClientRect()
        const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
        return at?.closest('[data-testid]')?.getAttribute('data-testid') ?? null
      },
      barWidthFor(T2 - 1)
    )
    expect(hit).toBe('TopBar.overflowMenuPermissions')
    await page.close()
  })

  it('cannot let a phone out of the collapsed tier — the thresholds say so', () => {
    // The relation the comment in `top-bar-tiers.ts` claims, asserted rather
    // than trusted. A phone's bar spans its window, `uiFontScale` only ever
    // divides that width (1–1.5), and the bar's own padding subtracts another
    // 16px — so `T2 >= MOBILE_BREAKPOINT` is what makes every mobile viewport
    // a member of tier 2 by construction. Drop T2 below 768 and the phone
    // needs its device branch back.
    expect(T2).toBeGreaterThanOrEqual(MOBILE_BREAKPOINT)
    // The ⋯ trigger's threshold must be tier 2's, or there is a band with both
    // surfaces or neither. (The sweep proves the behaviour; this names the
    // reason a reader would otherwise have to rediscover.)
    expect(thresholdOf(OVERFLOW_HIDE)).toBe(T2)
  })
})

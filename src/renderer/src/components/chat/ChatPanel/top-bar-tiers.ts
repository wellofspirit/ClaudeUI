/**
 * WHERE THE BAR COLLAPSES, AND WHY THESE NUMBERS (ADR-070 residual 1).
 *
 * The right cluster cannot shrink — every child is an icon, a fixed-width
 * control or a `whitespace-nowrap` pill — so a bar narrower than the cluster
 * does not truncate, it OVERFLOWS. With `minWidth: 600` and a 280px sidebar the
 * bar can be 320px while the cluster wants 852px. The fix is to drop children
 * in tiers rather than to hope they fit.
 *
 * MEASURED, not chosen. A one-off Chromium harness (since removed) rendered this
 * bar under the app's own compiled CSS; at `uiFontScale` 1, on
 * win32, with EVERY GATE SATISFIED and deliberately worst-case content (a
 * 26-char worktree name, a branch that truncates at its 100px cap with
 * ↑888↓999, ±99999 lines):
 *
 *   VSCode 74.6 · Terminal 29.0 · Skills 28.0 · MCP 29.0 · Permissions 28.0
 *   WorktreePill 133.0 · GitBranchPill 187.0 · GitChangesPill 109.8
 *   WindowControls 138.0 · ⋯ 30.0 · gap-3 12.0
 *
 *   full cluster            852.4
 *   after tier 1            550.4   (−344.0 for the two git pills, +42.0 for ⋯)
 *   after tier 2            301.8   (−248.6 for the five tools)
 *
 * The left group's floor is 96px: `TopBar.info` measures 56.9px at the default
 * "Session" label, and the title group reserves 34px for one compact `AuthPill`
 * plus its gutter while a pill is actually shown (Slice E). So the cluster stops
 * fitting beside a usable title at 852.4 + 96 = 948.4, and the tier-1 cluster at
 * 550.4 + 96 = 646.4.
 *
 * ALL GATES SATISFIED IS THE WORST CASE, NOT THE TYPICAL ONE. Every number
 * above assumes all five tools, both git pills, and win32's `WindowControls` —
 * so a session outside a repo, an engine without MCP, a mac, or a client the
 * host gives no terminal collapses EARLIER than it strictly has to. That is the
 * accepted cost of a static container query: the bar takes no measurement of
 * its own (and must not grow one), so one threshold has to serve the widest
 * cluster the app can produce. The alternative — a resize observer picking the
 * tier per session — trades a class string for a measurement loop and a frame
 * of layout thrash on every session switch.
 *
 * A container query on the bar, so the trigger is AVAILABLE width — the
 * sidebar moves it by ~276px at a constant window size, which is precisely
 * what a window breakpoint cannot see. Container queries resolve against the
 * CONTENT box, so the bar's own padding (13px, or 148px for the macOS traffic
 * lights) is already subtracted from these numbers.
 *
 * They live in their own module, not on `TopBar`, so a measuring harness can read
 * the SHIPPED strings and parse the thresholds out of them. A test that
 * re-typed 1000 and 768 would pass a bar that had quietly moved to 900.
 *
 * Written out as whole class names because Tailwind extracts class names from
 * source TEXT — a composed string generates no CSS at all.
 */
/**
 * Tier 1 — 948.4px measured, rounded up for headroom against the system fonts
 * of the platforms this was not measured on.
 *
 * The ⋯ button now appears here rather than at tier 2 (the branch pill is the
 * only fetch/pull/push/switch surface, so 768–1000 had no way to reach it), and
 * that does NOT move this number: the threshold is where the FULL cluster stops
 * fitting, and the ⋯ only ever exists below it, where tier 1 has already handed
 * back 344.0 against the button's 42.0.
 */
export const TIER1_HIDE = '@max-[1000px]/bar:hidden'
/**
 * Tier 2 — 646.4px measured, raised to `MOBILE_BREAKPOINT`.
 *
 * That is the one number that makes the phone a CASE of this rule instead of a
 * second rule beside it: `useIsMobile` is `window.innerWidth < 768`, the bar
 * spans the window on a phone, and `uiFontScale` only ever divides that width
 * (its range is 1–1.5), so every mobile viewport is inside this tier by
 * construction; the constant below states that equality rather than a comment
 * asserting it.
 */
export const TIER2_HIDE = '@max-[768px]/bar:hidden'
/**
 * A menu row is the exact complement of the bar form it stands in for:
 * Tailwind's `@max-` is `width < N` and `@min-` is `width >= N`, so no width
 * shows both and none shows neither. One row per control, never two.
 */
export const TIER1_ROW_HIDE = '@min-[1000px]/bar:hidden'
export const TIER2_ROW_HIDE = '@min-[768px]/bar:hidden'
/**
 * The ⋯ trigger, which appears as soon as ANY tier has taken something away —
 * so which threshold it uses depends on what this session actually has to
 * offer. A session outside a repo has no tier-1 rows at all, and showing the
 * button at 1000px would open an empty popover.
 */
export const OVERFLOW_FROM_TIER1 = TIER1_ROW_HIDE
export const OVERFLOW_FROM_TIER2 = TIER2_ROW_HIDE

/**
 * WHERE THE BAR COLLAPSES, AND WHY THESE NUMBERS (ADR-070 residual 1).
 *
 * The right cluster cannot shrink — every child is an icon, a fixed-width
 * control or a `whitespace-nowrap` pill — so a bar narrower than the cluster
 * does not truncate, it OVERFLOWS. With `minWidth: 600` and a 280px sidebar the
 * bar can be 320px while the cluster wants 852px. The fix is to drop children
 * in tiers rather than to hope they fit.
 *
 * MEASURED, not chosen. `src/layout/TopBar.layout.test.tsx` renders this bar in
 * real Chromium under the app's own compiled CSS; at `uiFontScale` 1, on
 * win32, with every gate satisfied and deliberately worst-case content (a
 * 26-char worktree name, a branch that truncates at its 100px cap with
 * ↑888↓999, ±99999 lines):
 *
 *   VSCode 74.6 · Terminal 29.0 · Skills 28.0 · MCP 29.0 · Permissions 28.0
 *   WorktreePill 133.0 · GitBranchPill 187.0 · GitChangesPill 109.8
 *   WindowControls 138.0 · ⋯ 30.0 · gap-3 12.0
 *
 *   full cluster            852.4
 *   after tier 1            508.4   (−344.0: the two git pills and their gaps)
 *   after tier 2            301.8   (−248.6 for the five tools, +42.0 for ⋯)
 *
 * The left group's floor is 96px: `TopBar.info` measures 56.9px at the default
 * "Session" label, and the title group already reserves 34px for one compact
 * `AuthPill` plus its gutter (Slice E). So the cluster stops fitting beside a
 * usable title at 852.4 + 96 = 948.4, and the tier-1 cluster at 508.4 + 96 =
 * 604.4.
 *
 * A container query on the bar, so the trigger is AVAILABLE width — the
 * sidebar moves it by ~276px at a constant window size, which is precisely
 * what a window breakpoint cannot see. Container queries resolve against the
 * CONTENT box, so the bar's own padding (13px, or 148px for the macOS traffic
 * lights) is already subtracted from these numbers.
 *
 * They live in their own module, not on `TopBar`, so the layout test can read
 * the SHIPPED strings and parse its thresholds out of them. A test that
 * re-typed 1000 and 768 would pass a bar that had quietly moved to 900.
 *
 * Written out as whole class names because Tailwind extracts class names from
 * source TEXT — a composed string generates no CSS at all.
 */
/** Tier 1 — 948.4px measured, rounded up for headroom against the system fonts
 *  of the platforms this was not measured on. */
export const TIER1_HIDE = '@max-[1000px]/bar:hidden'
/**
 * Tier 2 — 604.4px measured, raised to `MOBILE_BREAKPOINT`.
 *
 * That is the one number that makes the phone a CASE of this rule instead of a
 * second rule beside it: `useIsMobile` is `window.innerWidth < 768`, the bar
 * spans the window on a phone, and `uiFontScale` only ever divides that width
 * (its range is 1–1.5), so every mobile viewport is inside this tier by
 * construction. `TopBar.layout.test.tsx` pins the relation rather than
 * trusting the comment.
 */
export const TIER2_HIDE = '@max-[768px]/bar:hidden'
/** The ⋯ trigger is the exact complement of tier 2: Tailwind's `@max-` is
 *  `width < N` and `@min-` is `width >= N`, so no width shows both and none
 *  shows neither. */
export const OVERFLOW_HIDE = '@min-[768px]/bar:hidden'

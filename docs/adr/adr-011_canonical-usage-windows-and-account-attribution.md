# ADR-011: Canonical 5h-window identity from `resets_at` + time-based account attribution for usage analytics

**Status:** Accepted
**Date:** 2026-06-10

## Context

The usage dashboard (block analytics, burn rate, window-capacity projection)
groups JSONL transcript entries into 5-hour billing blocks anchored to the
rate-limit window reported by `/api/oauth/usage`. Two field problems surfaced:

1. **Window boundary drift.** The original code assumed window ends are
   hour-aligned and `Math.round`ed `resets_at` to the nearest hour. Real data
   disproves both halves of that: poll cycles return sub-second jitter
   (`09:00:00.578Z` / `09:00:00.432Z` / `09:00:00.000Z` for one window), and
   genuinely non-hour ends occur (`03:40:00Z` observed). Hour-rounding mapped
   `03:40Z` to `04:00Z`, splitting one real window into two block alignments
   that flapped against each other. Each flap reset the WLS projection buffer
   (keyed on block ID), degrading the projection to a single-point estimate
   that spiked 3–5× on percent lag ($84 → $421 within two hours, same window).
   Worse, during the `resets_at = null` gap after a window expires, grouping
   fell back to `floorToHour`, manufacturing phantom blocks that were persisted
   as "completed" with cross-contaminated metadata (a $21 block stored with a
   $328 projection) via the time-overlap backfill matcher.

2. **Multi-account blindness.** `~/.claude/projects` transcripts carry no
   account identifier. When the user switches accounts (typically at 100%
   utilization), local token counts keep accumulating across both accounts
   while the API percent denominator belongs to one — inflating the projection
   ($261 projected at 4% utilization) — and daily cost totals silently blend
   both accounts.

## Decision

**1. Window identity is the canonical `resets_at`, not an hour grid.**
`canonicalizeWindowEnd()` (pure, in `src/main/services/usage-windows.ts`)
rounds an observed `resets_at` to the minute, then snaps to an already-known
window end within ±2 minutes (first observation wins). `BlockUsageService`
keeps a registry of known windows (`end − 5h` = start), seeded at startup from
`apiResetAt` values persisted in the last two daily files so block IDs are
stable across app restarts. Grouping consults the whole registry; `floorToHour`
remains only as the fallback for entries outside every known window, and such
provisional blocks:

- never force a split on their own (only window-aligned starts do),
- are not persisted as completed while recent (< 6h) — they regroup once the
  next window is observed,
- carry `windowAligned: false` so downstream code can tell them apart.

Entries in the dead zone between two windows attach to the next window within
a 30-minute grace (the API starts a window at/before the first request, so
`resets_at − 5h` can slightly postdate the first entries). Daily cost totals
were always entry-derived and independent of block membership — block grouping
affects only the 5h-window view.

**2. The expired-window gap is a first-class state.** While no unexpired
window is known: no snapshots are persisted (a 0%/null-reset snapshot carries
no signal and poisons the time-series), the projection returns null, and no
recent block is finalized. The gap is actively shortened by proactive fetches
(below).

**3. Projection state is keyed on window identity.** The WLS sample buffer
resets when the canonical window end changes (covers both window rolls and
account switches — each arrives as a new `resets_at`), and defensively when
the API percent drops more than 5 points below the buffered maximum. Restored
metadata on completed blocks is matched by exact block ID only — the
time-overlap matcher and retroactive-WLS backfill are removed — and a restored
projection is discarded if it exceeds 1.5× the capacity implied by the block's
own `finalApiPercent`.

**4. Account attribution is time-based via an append-only log.** Credentials
are global (`~/.claude.json` / keychain), so an account switch is a global
point-in-time event — timestamp attribution is exact, not approximate.
`UsageFetcher` reads `oauthAccount {accountUuid, emailAddress}` on every fetch
and appends `{ts, accountUuid, email}` to
`~/.claude/ui/usage/account-log.jsonl` only on change. `accountForTimestamp()`
resolves each entry by binary-search semantics over the log; entries predating
the log are "unknown" and age out of the 7-day scan window. Windows are tagged
with the account active when observed, disambiguating overlapping windows from
two accounts. The Usage view exposes an account selector (All / per email,
shown only when >1 account is known); persisted daily summaries remain
all-account aggregates, so beyond-window fallback days are hidden under a
filter rather than shown unfiltered.

**5. Proactive usage fetches close the blind spots.** One-shot fetch at
`resets_at + 10s` (rescheduled on every usage update, including rate-limit
header events); an immediate launch fetch when the disk-cached usage carries
no unexpired window; and a 30s-throttled fetch when the JSONL watcher sees new
entries while no window is known (new activity implies a new window just
started).

## Consequences

- Block IDs are stable across poll jitter and app restarts; the projection
  keeps its sample history for the lifetime of a real window instead of
  resetting on alignment flaps.
- Phantom completed blocks and cross-window metadata contamination are gone;
  Recent Blocks rows derive their projected column from `finalApiPercent`,
  which is now only ever filled from same-ID persisted data.
- Account attribution only works forward from deployment — historical
  two-account days stay blended (the transcripts simply don't record the
  account). The "unknown" bucket disappears within one scan window.
- The dual-account projection error self-corrects going forward: the account
  switch changes `resets_at`, which resets the sample buffer, and the
  account-filtered view scopes the token numerator to the account that owns
  the percent denominator.
- Slightly more API traffic: at most one extra usage call per window roll,
  launch-without-window, and throttled unknown-window activity burst.
- The ±2min snap tolerance and 30min start grace are heuristics. Two real
  windows closer than 2 minutes apart would merge (impossible for one account
  — windows are 5h — and implausible across two), and an entry more than 30min
  before its window's derived start falls back to a provisional block.

## Alternatives considered

- **Keep hour-rounding but widen to nearest 30min.** Rejected: still an
  alignment assumption the API demonstrably doesn't honor; minute-rounding +
  clustering needs no assumption at all.
- **Persist a dedicated window registry file.** Rejected: `apiResetAt` is
  already persisted per snapshot in the daily files; re-deriving the registry
  from them at startup avoids a new artifact and a migration.
- **Per-session account tagging at spawn time.** Rejected as the primary
  mechanism: it only covers app-spawned sessions (external CLI sessions appear
  in the same JSONL tree) and adds plumbing through session-manager. The
  time-based log covers every producer because credentials are global. Spawn
  tagging can be layered on later if sub-minute switch precision ever matters.
- **Parsing account identity out of the transcripts.** Rejected: current
  cli.js writes no account field on assistant lines (verified against live
  transcripts).
- **Stacked per-account segments in the daily chart.** Deferred in favor of a
  simple selector filter (user preference); the data model (account log +
  per-entry attribution) supports adding stacked display later without
  storage changes.

# ADR-034 — Session time & per-model cost accounting in the session status line

**Status:** Accepted
**Relates to:** ADR-011 (usage analytics identity), ADR-020 (persistence/config plane), ADR-033 (cross-engine dispatch — amends its M4 claude-target usage capture)

## Context

The chat-header info tooltip showed a `Duration` and a single scalar `Cost`, and both were engine-
inconsistent and lossy:

- **Duration meant different things per engine.** opencode reported wall-clock since first prompt
  (`Date.now() - startTimeMs`, emitted continuously); Claude accumulated the SDK's per-turn
  `duration_ms` and emitted it only around results — so a Claude session's duration was often 0 and,
  when present, measured something else entirely.
- **Cost had no model dimension.** A session can span multiple models (model switch, fallback,
  dispatched cross-engine calls), but every renderer-facing surface (`SessionStatus`,
  `StatusLineData`, `MeteringSnapshot`) carried a single collapsed number. The richest live source —
  the `result` message's per-model `modelUsage` map — was typed but never read.
- **Nothing survived a reload.** Cost and duration lived only in in-memory accumulators.

Probing the pinned bun-claude binary surfaced the load-bearing wire facts (now recorded in
docs/protocol-cc/03-inbound-messages.md §3.7):

1. `result.total_cost_usd` and `result.modelUsage` (per-model `costUSD`) are **cumulative within one
   cli.js process** and **reset to zero on `--resume`**; only `usage`/`duration_ms`/`duration_api_ms`
   are per-turn. The existing `totalCostUsd += total_cost_usd` in `claude-session.ts` was therefore a
   real double-count bug (every multi-turn session displayed inflated cost), and ADR-033 M4's
   claude-target dispatch path repeated the same mistake for the cost cap and recorded usage rows.
2. **Transcript JSONL never persists `result` records** (verified across 46 real transcripts) — cost
   and duration are not recoverable from a transcript directly; only per-message
   `model`/`usage`/`timestamp` are.

## Decision

### Session time = accumulated ACTIVE turn time, one semantic for every engine

`StatusLineData.totalDurationMs` is the summed wall-clock of turn processing (prompt sent → turn
complete). Idle time waiting on the user never counts. A companion `turnStartedAtMs` lets the
renderer tick the in-flight turn live (`total + (now - startedAt)`), so emission cadence doesn't
matter. Reload durability is reconstruction from each engine's own transcript, not our DB:

- Claude: live per-turn `duration_ms` accumulation + turn-span reconstruction from transcript line
  timestamps (a turn = a real user-prompt line — `type:'user'`, no `toolUseResult`, not `isMeta` —
  through the last line before the next one), seeded at spawn for resumes and reconciled post-result
  with a `Math.max` ratchet so displayed duration never moves backward. Forks are excluded from
  seeding (the source transcript still contains post-anchor turns the fork truncates).
- opencode: per-turn accumulation from `session.idle`, base reconstructed on replay from stored-
  message `time.created`/`time.completed`.

### Cost = base + live overlay, forced by the cumulative wire semantics

Because Claude's cost fields are cumulative-per-process, both engines track cost as:

- **base** — everything before the current engine process: Claude seeds once at construction from a
  transcript recompute (per-message tokens × block-usage's pricing tables — the same math as the
  usage dashboard, message-id-deduplicated); opencode seeds on replay from stored-message
  `cost`/`modelID`. The recurring post-result reconciliation never touches cost (it would clobber the
  authoritative live values with a pricing estimate).
- **live overlay** — the latest `result`'s cumulative values, **replaced never added**, folded into
  the base at process boundaries (a `ClaudeSession` object can respawn cli.js after idle teardown).

`StatusLineData.modelCosts` (`ModelCostEntry { engineId, modelId, costUsd, dispatched? }`) carries
the merged per-model map; the TopBar shows the breakdown when it has ≥2 rows or any dispatched row.
Accepted imprecision: historical cost is pricing-table math while live cost is authoritative
`costUSD` — the seam is documented at both call sites.

### Dispatched spend is breakdown-visible but never in the headline

Cross-engine dispatch cost (ADR-033) appears as `dispatched: true` rows (engine-tagged, e.g.
`gpt-5.6-sol · dispatched`) plus a **"Total incl. dispatched"** line. The headline `totalCostUsd`
stays own-engine-only — folding dispatched spend in would silently change what the InputBox status
line and usage attribution mean. Plumbing: `BaseSession.addDispatchedCost()` (engine-neutral, per-
turn `+=`, re-emits the status line via a per-engine hook), fed by the dispatcher at usage-capture
points; durability via `dispatched_usage` grouped by `from_routing_id`, with
`renameDispatchedUsage()` wired into `SessionManager.rekey()` so rows follow the session-id chain,
and merged into the history-load status line so reopened sessions show dispatched spend before any
engine session object exists.

### ADR-033 M4 amendment

The claude-target dispatch path converts the cumulative `result.total_cost_usd` into a per-turn
delta against a per-entry baseline (`lastReportedTotalCostUsd`; entries are strictly one-process, so
one zero-init suffices). This fixes the cost cap, the recorded `dispatched_usage` rows, and the new
fold-in for multi-turn dispatch sessions. Failed-subtype turns' spend now also counts toward the
dispatch cost cap — the cap is a spend limit, not a success limit (pre-existing M4-C behavior only
counted successful turns, so a dispatch session whose turns kept erroring could spend past the cap
without tripping it). The cap-crossing note is still only appended to successful turns' output; a
failed turn that crosses simply causes the next turn to be rejected.

## Consequences

- Both engines report the same session-time semantic; the tooltip shows Session time (live-ticking),
  API time (Claude), and a per-model cost breakdown that survives app restarts.
- Two double-count bugs rooted in the undocumented cumulative semantics are fixed (session headline
  cost; dispatch cost cap/rows). The wire facts are now pinned in docs/protocol-cc §3.7 so future
  consumers can't repeat the mistake.
- Own-engine durability reads engine-native transcripts, not our DB (consistent with ADR-020's
  "no private copies" stance); the DB is used only where no transcript carries the data
  (`dispatched_usage`). The `usage_event` backfill now writes real session ids (was `NULL`),
  unblocking future DB-side per-session aggregation without adding a query today.
- Breakdown rows may disagree with a dashboard recomputation by pricing-table drift for historical
  turns; the headline remains authoritative for own-engine spend.

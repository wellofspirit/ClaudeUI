# ADR-023: opencode auto-mode — LLM permission gatekeeper (parity with Claude)

**Status:** Accepted
**Date:** 2026-06-22
**Relates to:** [ADR-022](adr-022_opencode-permission-mapping.md) (opencode permission mapping), [ADR-019](adr-019_opencode-engine-backend.md), [ADR-018](adr-018_v2-engine-vendor-account-model.md) (autonomy modes)

## Context

ClaudeUI's `full` autonomy maps to Claude's `auto` permission mode, which in cli.js is an **LLM
"security monitor"** that judges each would-be-`ask` tool call instead of prompting the human. For
opencode we currently gate `full` exactly like `default` (interim — ADR-022) because a raw `{*:allow}`
would make opencode `full` strictly less safe than Claude `full`. This ADR specifies an opencode-native
gatekeeper so `full` means the same AI-gated autonomy on both engines.

The chief risk is **runaway token cost**. The cli.js classifier was reverse-engineered in depth
(payload, two-stage flow, fast-paths, caching, throttles). Two findings shape this design:
- **The classifier prompt does not share a cache prefix with the main conversation** (it omits the main
  system prompt and re-serializes a slimmed transcript), so — verified — **judge-model choice buys no
  cache reuse from the live session on any model**. Model choice is therefore pure per-token price.
- cli.js has **no per-turn cap on *allowed* classifier calls** (only a denial cap) — the single
  most likely source of token burn in long autonomous runs.

## Decision

Build an **independent security-monitor judge** (parity with Claude's battle-tested design — *not* a
self-judging / cache-piggyback approach), for **opencode `full`/auto only** (Claude keeps cli.js's own
classifier). Architecture and cost-guards:

### Hook
opencode `full` patches an ask-heavy ruleset (write-class tools → `ask`). When a `permission.asked`
arrives, `OpencodeSession` routes it to the **AutoModeClassifier** instead of the UI:
`classify(transcript, action, environment)` → `replyPermission('once')` on allow, `'reject'` on block.
Fall back to a normal human approval prompt on: uncertain/unavailable judge, cap exceeded, transcript
overflow, or a configured non-classifiable tool. Reuses the existing `permission.asked → replyPermission`
plumbing.

### Judge prompt (parity with cli.js)
- **System** = our own security-monitor policy (threat model: prompt-injection / scope-creep /
  accidental-damage; HARD vs SOFT block; user-intent rules) — authored fresh, modeled on cli.js's. Does
  **not** include the main agent prompt.
- **Context** = environment block (trusted repo / remotes / internal domains) + project context
  (AGENTS.md/CLAUDE.md, with the "generic 'I trust you' is not authorization" caveat) + a **slimmed,
  re-serialized transcript**: user text + assistant **tool calls** only; drop assistant prose, thinking,
  **tool results**, images. + the proposed action last.
- **Output** = `<block>yes/no</block>` (+ optional `<reason>`/`<thinking>`). **Fail-closed**: unparseable
  / error / unavailable → block → human approval.

### Two-stage + fast-paths (parity)
- **Fast-paths (zero-token, local) — skip the LLM**: (1) safety/ask-rule/plan floors → human; (2)
  `acceptEdits`-equivalence (would `acceptEdits` allow it? → allow); (3) a static **read-only/safe-tool
  allowlist**. Most calls never reach the model.
- **Two-stage**: Stage 1 cheap (`≤256` tok, stop `</block>`, "err toward block"); Stage 2 "thinking"
  (`≤8192`) only on borderline/blocked. Configurable `both` (default) / `fast` (single cheap call) /
  `thinking`.

### Judge model — **configurable** (this ADR's key addition vs cli.js)
- **Default judge model = the session's own current model** (parity with cli.js, which judges on the
  main session model). Overridable via a new opencode engine setting `autoMode.judgeModel` (a
  `providerID/modelID`), leveraging opencode's multi-vendor support — point it at a cheaper model if
  cost bites, or a stronger one for safety-critical work. (We fail-closed on judge errors, so a
  weak/over-blocking judge degrades to human approval, not silent allow.) Note: using the session model
  does **not** reuse the conversation's cache (verified — the judge prompt has a divergent prefix);
  it simply avoids a separate model/auth and follows whatever the user already runs.
- The judge call runs **via opencode** (a reused, hidden, parent-less judge session per cwd, model =
  `judgeModel`) so it uses opencode's configured providers/auth and any provider-side prompt caching.
- **1h-TTL cache** on the stable prefix (system policy + environment + earlier transcript) → successive
  same-turn checks are mostly cache-reads. Cache is classifier-to-classifier only and per-judge-model
  (the verified finding); choosing the session model buys nothing extra.

### Cost guards (explicit policy — the burn-prevention contract)
We follow Claude's parity governors — **no per-turn/per-session cap on *allowed* calls** (user
decision: strict parity; cli.js has none either). Cost is bounded by:
1. **Fast-path allowlist + acceptEdits-equivalence** — most calls never hit the model (the dominant
   governor).
2. **Transcript slimming** (user text + tool *calls* only) — the dominant per-call token saver — plus
   1h prefix caching across same-turn classifier calls.
3. **Single-stage `fast` mode** available for cheaper runs (default `both`).
4. **Consecutive/total denial caps** (3/20, parity) → fall back to human.
5. **Transcript-too-long** → human approval (reactive fallback; no proactive windowing).
6. **No `(tool,input)` verdict memoization.** Deliberately omitted: a memoized verdict would override
   the user's later choice to personally approve/deny that same call. Each evaluation is fresh.
   *(User decision.)*
7. **Configurable `judgeModel`** is the cost lever in lieu of a cap — set it to a cheaper model if a
   long autonomous run on an expensive session model accrues cost.
8. **Observability**: per-call decision log (tokens / cost / stage / verdict) so spend is auditable;
   surface running cost in the UI. *(This is the primary guard now that there is no hard cap.)*

## Consequences

- `full` autonomy is consistent across engines (both AI-gated); opencode `full` stops being a raw
  allow-all. The ADR-022 interim (gate `full` like `default`) is replaced by this once built.
- Cost has the **same profile as Claude** (no allowed-call cap): bounded by fast-paths + transcript
  slimming + denial caps. A long autonomous `full` run on an expensive session model can accrue real
  cost — the mitigations are the fast-paths/slimming and the **configurable `judgeModel`** (point it at
  a cheaper model), with the decision log + UI cost surfacing as the visibility valve.
- **Known parity gap (accepted):** the judge sees tool *calls*, not tool *results* (matches cli.js) —
  it cannot reason about command output. Documented, not fixed.
- The judge runs through opencode, so it inherits opencode's provider auth/availability; if the judge
  model is unauthenticated/unavailable, we fail-closed to human approval (never silently allow).

## Implementation notes (as built)

- **Judge transport**: the judge runs via a **fresh, stateless opencode session per call**
  (`createSession` → `prompt` → `deleteSession`) so it never accumulates prior Q&As. This sacrifices
  cross-call prompt caching for correctness/simplicity; revisit if cost matters.
- **Two-stage adapted**: opencode's `prompt` API has no `max_tokens`/`stop_sequences`, so we can't run
  cli.js's token-capped stages. We instruct a **terse** `<block>` answer (Stage 1) and only add a
  **reasoning** pass (Stage 2, mode `both`) when Stage 1 blocks. Output length depends on the judge
  obeying the terseness instruction.
- **Ruleset**: full + enabled uses the **acceptEdits base** (reads/edits auto-allowed; only
  bash/webfetch raise `permission.asked` → judged). full + disabled falls back to the gated `default`
  ruleset (human prompts).
- **Defaults in production**: with no `engines/opencode.json` autoMode block, auto-mode is **enabled**
  and the judge is the **session model** (`twoStageMode: both`).
- **Settings UI**: Settings → **Engines › opencode › Auto mode** — enable toggle, judge-model picker
  (default "same as session model" + opencode's discovered models), two-stage selector. A
  self-contained FC (`OpencodeAutoModeSection`) that loads/saves `engines/opencode.json` directly
  (SettingsDialog only wires the `claude` engine config). Self-gates on opencode being installed.
- **Files**: `auto-mode-classifier.ts` (pure core), wiring + judge runner in `OpencodeSession.ts`.

## Alternatives considered

- **Option B — piggyback the session model + its cached context** (run the check as a continuation of
  the live session). Rejected: the cache benefit is illusory for a separate request (prefix divergence —
  verified), it requires byte-replicating opencode's exact prefix, it only helps Anthropic-backed
  sessions, and it makes the model **judge its own action** (weaker, prompt-injection-prone). Claude's
  independent-monitor design is battle-tested and model-agnostic — we follow it.
- **Verdict memoization** — rejected per user decision (overrides later human control; see guard #7).

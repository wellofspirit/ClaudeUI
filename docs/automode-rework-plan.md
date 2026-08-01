# Auto mode rework — analysis and handover

**Status:** plan, not yet implemented. Written 2026-07-31.
**Reference:** [`docs/protocol/14-auto-mode-classifier.md`](protocol/14-auto-mode-classifier.md) — the
reverse-engineered spec of Claude Code's auto mode, which is the behavioural target.
**Amends when built:** [ADR-023](adr/adr-023_opencode-automode-classifier.md).

Goal: a classifier-based auto mode for opencode and pi that genuinely works — not a
generic "is this dangerous?" judge. Phase 1 is specified below in enough detail to
hand straight to an implementing sub-agent.

---

## 0 Reference map — where everything lives

Read this first if you are picking the work up cold. Throughout this plan, **"ref §N"**
means a section of the protocol doc below.

### 0.1 The research

**[`docs/protocol/14-auto-mode-classifier.md`](protocol/14-auto-mode-classifier.md)** —
the full reverse-engineered spec of Claude Code's auto mode, verified against **cli.js
2.1.220** (`vendor/claude-cli/cli.js`, pinned by `package.json#claudeCliVersion`).
Section guide, with the ones this plan leans on marked ★:

| § | Contents |
|---|---|
| 1 | Mode enum, decision-source enum, availability gating + circuit breaker |
| ★2 | **The two-stage engine** — stage suffixes verbatim, both output grammars, severity scale (0–100, thresholds t1=15/t2=20), request params, parsers, fail-closed matrix, model probing/demotion |
| ★3 | **Pipeline position** — escalate-to-human conditions, the two fast paths, queue + mode recheck; §3.1 enumerates the safe allowlist (`X6s`) |
| 4 | Prompt structure — role, threat model, default-allow rule, out-of-scope list |
| ★5 | **Transcript construction** — `{"meta":…}` ground truth (`gitStatus`, `repoVisibility`), `{"outcome":…}` annotations and their prescribed meanings, caching |
| ★6 | **The consent model** — `[named+specifics]`, Path A/B, must-name slots, post-block inheritance, boundaries, adversarial-pattern inversion |
| 7 | The 18 evaluation rules (scope computation) |
| 8 | The 7-step classification algorithm |
| ★9 | **The rules document** — Environment slots, three protected classes, the 1 HARD rule, 65 SOFT rules, 17 ALLOW exceptions; §9.6 the 66-slug category allowlist |
| 10–11 | Block surfacing; the separate (fail-**open**) subagent handoff classifier |
| 12 | Porting notes — the ranked "what actually makes this work" list |
| 13 | String landmarks for re-locating everything after a cli.js version bump |

### 0.2 The verbatim source text — regenerate, do not look for it in git

```bash
node scripts/extract-automode-prompts.mjs          # defaults to vendor/claude-cli/cli.js
# → out/automode-rules.md         ~73 KB  Environment / Definitions / HARD / SOFT / ALLOW
# → out/automode-prompt-stage2.md ~35 KB  the classifier system prompt
```

**`out/` is gitignored** (`.gitignore` line 3), so these files are deliberately *not*
committed — see §2 on corpus provenance for why we keep Anthropic-authored prose out of
the repo. Re-run the script whenever you need them. It locates both templates by content
landmark rather than char offset, so it survives version bumps; if it fails, ref §13 has
the landmark table.

### 0.3 Our current implementation

| Path | What |
|---|---|
| `src/main/opencode/auto-mode-classifier.ts` | the classifier (pure, injectable) |
| `src/main/opencode/__tests__/auto-mode-classifier.test.ts` | its tests |
| `src/main/opencode/OpencodeSession.ts` ~1315–1440 | wiring: `autoModeConfig`, `makeJudgeFn`, `handleAutoModeApproval` |
| `src/main/pi/permission-engine.ts` | pi's pure rule engine (`decide()`); the `gateToolCall` hook itself lives in `PiSession.ts` (~151, ~528) — the phase-4 seam |
| `src/shared/permission-modes.ts` | mode cycle + `autoModeAvailableForEngine` |
| `src/shared/types.ts:567` | `AutoModeConfig` (opencode-scoped today — see §7) |
| `src/main/auth/vault/AuthVault.ts` | the vault, for the phase-5 transport question |

### 0.4 Governing ADRs

- **[ADR-023](adr/adr-023_opencode-automode-classifier.md)** — the existing auto mode
  design. **This plan amends it** when built.
- **[ADR-036](adr/adr-036_unified-auth-vault.md)** — the auth vault, and the recorded
  position that constrains the judge transport (§2).
- **[ADR-026](adr/adr-026_development-workflow.md)** — the implement/review/commit
  workflow this work must follow.

---

## 1 Where we actually stand

Current implementation: `src/main/opencode/auto-mode-classifier.ts` (pure, injectable)
plus wiring in `OpencodeSession.ts` (`autoModeConfig`, `makeJudgeFn`,
`handleAutoModeApproval`, ~lines 1315–1440). opencode only; pi has none.

### Already correct — keep

- Two-stage with an allow short-circuit on stage 1.
- Fail-closed on parse failure and on judge error (`unavailable: true`).
- Fresh **stateless** judge session per call — the judge never accumulates prior Q&As.
- **The judge session is patched tool-denied before it is prompted**, and a patch
  failure *propagates* so the caller falls back to the human. cli.js gets this free
  by using a raw API call; we had to engineer it because our judge is an engine
  session. This is a real security property — do not lose it in the refactor.
- Transcript slimming drops tool **results** (the dominant token saver) — matches
  cli.js, where the judge sees calls, not their outputs.
- Denial caps (3 consecutive / 20 total → hand to human). cli.js only telemeters
  `consecutiveDenials`; acting on them is our addition and is reasonable.
- `unavailable` → **ask the human**, where cli.js blocks. Better for an interactive
  desktop app. Keep.

### Gaps, ranked by impact

**G1 — the two stages ask the same question twice.** *(structural; highest leverage)*

Ours: terse call → if BLOCK, re-ask with thinking as a second opinion. Because we
only escalate on block, **a false ALLOW in stage 1 is final**. And stage 1 must be
nearly as smart as stage 2 to avoid that, which defeats the cost saving.

cli.js gives each stage a different job (ref §2): stage 1 grades **harm only**, told
explicitly not to weigh intent or exceptions; stage 2 applies intent and exceptions.
So stage 1 can be a 64-token scorer, and in 2-stage mode **stage 1 can only allow or
escalate — never block**. Fixing this is a prompt + control-flow change and buys both
accuracy and cost.

**G2 — `slimTranscript` drops the consent referent.** It drops all assistant prose.
But Path B (ref §6) needs the agent's proposal immediately before the user's reply —
that proposal is what makes a bare "yes" mean anything. Today a user approving a
proposal is invisible to the judge; it sees only `User: yes`. **This blocks G3**: the
consent model cannot be added until the slimmer preserves its input.

**G3 — no consent model.** One line ("generic encouragement is NOT authorization")
gestures at it. Missing: `[named+specifics]` bars, per-rule must-name slots, Path A/B,
"naming the enclosing task is not naming the destructive step", "the bar binds at the
step that ships", post-block consent inheritance, boundaries, questions-aren't-consent,
cross-session exclusion.

**G4 — no HARD/SOFT split.** Everything is equally blockable and equally clearable.
cli.js has exactly one HARD rule (Data Exfiltration) and 65 SOFT; that asymmetry is
what lets it be permissive by default without being useless.

**G5 — no ALLOW exceptions and no out-of-scope list.** No Transient Retry, Declared
Dependencies, Local Operations, Read-Only Operations — the top false-positive sources.
And with no out-of-scope list we will block bad code, unrequested-but-harmless actions,
and wasted-token loops, which is how users learn to switch the mode off.

**G6 — `environment` is `` `cwd: ${this.cwd}` ``.** No trust lists, no repo
visibility, no prod heuristic.

**G7 — no harness ground truth.** No `gitStatus`, no `repoVisibility`, no outcome
annotations. Per ref §5 this is most of what makes destructive-git verdicts accurate,
and it is host work rather than prompt work — the part we are best placed to do well,
and it is engine-neutral.

**G8 — fast path is four tools** (`read`, `glob`, `grep`, `list`) vs. cli.js's 24 plus
browser sets, and we have no fast-path-A equivalent ("would acceptEdits allow this?").
The ADR-023 comment argues opencode's base ruleset already auto-allows these so they
never raise `permission.asked`. That argument is plausible for opencode but **unverified
for pi** — check before relying on it.

**G9 — no ask-rule precedence.** Ref §3 step 1 / porting note #1: an explicit user
**ask rule must outrank the classifier** — otherwise auto mode is a permission
downgrade for exactly the actions the user singled out. Our user permission rules are
compiled into opencode's ruleset (`OpencodeSession.ts` ~1300), so a user-configured
`ask` surfaces as the same `permission.asked` event as a default ask, and
`handleAutoModeApproval` classifies (and can auto-approve) it. Fix: before invoking
the judge, re-match the pending action against the *user-authored* ask rules host-side;
on a match, go straight to the human.

**G10 — no mode recheck after the judge returns.** Ref §3 step 5 / porting note #5:
`handleAutoModeApproval` auto-replies unconditionally after `classify()` resolves. If
the user switched out of `full` while the judge was thinking, we still auto-approve.
Fix: re-read the session's current permission mode before `autoReply`; if auto mode is
no longer active, fall back to the human.

---

## 2 Decisions taken

**Rule corpus — write our own, informed by theirs.** The extracted text
(§0.2) is a reference checklist only. We author a condensed corpus (~20–25 rules) covering the
same harm classes with our own must-name slots and ALLOW exceptions.

Rationale: the architecture, taxonomy and mechanics are reverse-engineered behaviour
and fair game — we already document cli.js extensively. The 73 KB rules document is
Anthropic-authored prose extracted from a licensed binary, and shipping it verbatim as
ClaudeUI's policy for driving *competing* engines is a materially different act. Our
own corpus also lets us tune to the engines and workflows we actually support.

**Phase 1 — engine-neutral core + transport seam.** See §4. Fixes G1 and G2 and
unblocks everything else. No new rules yet.

**Judge transport — seam, with the engine-session judge as the default.**

This walks back an earlier suggestion of "make the judge a direct vault-backed
provider call by default". Two findings changed it:

- [ADR-036](adr/adr-036_unified-auth-vault.md) records the position that Anthropic
  subscription tokens vend to Claude Code **only** — *"never to pi/opencode"* — as a
  ToS matter. (Note: `validateSharedProviderId` in `src/shared/shared-provider.ts` is
  only a **format** check; the per-provider vend allowlist is ADR-036's documented
  intent, not enforced code today.)
- Today's judge runs as an opencode session on the user's own configured provider, so
  **opencode's client id owns the token**. Making the HTTP call ourselves changes who
  the client is — for subscription OAuth that is a real difference, not cosmetic.

So: `JudgeTransport` is an interface. Default implementation is the existing
engine-session judge (no new auth surface). A direct-API implementation is available
only when the user supplies a **dedicated classifier API key**, which is what buys
`max_tokens`, `stop_sequences` and prompt caching — resolving the ADR-023 deviation for
those who opt in. The G1 fix does not depend on it.

**~~Do not fork opencode; do not vendor a pi plugin.~~ SUPERSEDED 2026-08-01 by
[ADR-037](adr/adr-037_engine-fork-patch-policy.md)**: fork+patch opencode (no
upstreaming; tool-less judge endpoint as P1, reshaping phase 5), extend pi via its
extension API. The original interception-point analysis below remains true and is
why phases 1–4 needed no fork:

- opencode — the `permission.asked` event → `handleAutoModeApproval` → reply.
- pi — `PiSession.gateToolCall`, which runs the pure `PiPermissionEngine`
  (`src/main/pi/permission-engine.ts`) and whose `ask` branch already raises
  `session:approval-request`.

The only thing a fork would have bought is control over the judge call, and that is
solved by the transport seam. Carrying forks against two moving upstreams for a
benefit that evaporates is not worth the maintenance.

---

## 3 Target architecture

```
src/main/automode/
  classifier.ts        pure policy: prompts, staging, parsing. No engine imports.
  transport.ts         JudgeTransport interface (+ later: direct-API impl)
  ground-truth.ts      (phase 3) gitStatus / repoVisibility / outcome annotations
  rules/               (phase 2) our corpus: HARD, SOFT, ALLOW, environment slots
```

Three seams:

| Seam | Engine-specific? | opencode | pi |
|---|---|---|---|
| **PermissionIntercept** | yes | `permission.asked` | `gateToolCall` ask branch |
| **JudgeTransport** | yes (default) | hidden tool-denied session | TBD (phase 4) |
| **GroundTruth** | **no** | shared | shared |

---

## 4 Phase 1 — implementation spec

Hand this section to an implementing sub-agent (ADR-026: Opus implements, main model
reviews line-by-line, runs gates independently, and commits).

### 4.1 Lift to an engine-neutral home

Create `src/main/automode/`. Move `src/main/opencode/auto-mode-classifier.ts` →
`src/main/automode/classifier.ts`; move
`src/main/opencode/__tests__/auto-mode-classifier.test.ts` →
`src/main/automode/__tests__/classifier.test.ts`. Update importers (only
`OpencodeSession.ts` today). The module must have **no** opencode-specific imports —
pure policy plus a transport interface, dependency-injected and unit-testable exactly
as today.

### 4.2 Restructure the two stages *(fixes G1)*

Rewrite the stage instructions so each asks a different question (ref §2 "Stage suffix
text"):

- **Stage 1** — grade harm only. Explicitly instruct: does not apply user intent or
  ALLOW exceptions, stage 2 handles those; judge by full effect (what it runs, sends,
  publishes or enables), not surface form; escalate if any rule could apply. Terse
  output.
- **Stage 2** — applies user intent and ALLOW exceptions; reasoning allowed; final
  verdict.

Control flow for `both`:

- stage 1 clearly-safe → **ALLOW, done** (preserve this cheap common path)
- stage 1 anything else — block, ambiguous, **or unparseable** → **escalate to stage 2**
- stage 1 must **not** be able to emit a final block in `both` mode
- stage 2 verdict is final; unparseable stage 2 → block (fail-closed), `unavailable` unset
- transport throws at either stage → `{ block: true, unavailable: true }` (unchanged)

`fast` (stage 1 only — there it *can* block; unparseable → block) and `thinking`
(stage 2 only) keep working as today.

**Recorded deviation (amend into ADR-023 when built):** cli.js sets `unavailable`
only when stage 1 never produced usage; a stage-2 *error* after stage 1 ran becomes
a hard **block** "based on stage 1 assessment" (ref §2 failure matrix). We instead
mark any transport error at either stage `unavailable`, and our wiring maps
`unavailable` → ask the human. Net effect: a stage-2 transport hiccup after stage 1
flagged something becomes a human prompt, not a denial. Deliberate — consistent
with our existing `unavailable → human` stance for an interactive desktop app,
where cli.js must assume headless.

**Stage-1 prompt fidelity:** keep cli.js's `Ei_` framing — stage 1 is told to
*block* ("Err on the side of blocking … Block if ANY rule could apply"), and the
*control flow* treats its block as an escalation. Do **not** tell stage 1 that its
"yes" merely escalates: disclosing non-finality invites laxer flagging thresholds
and erodes the calibrated cheap path.

### 4.3 Fix `slimTranscript` *(fixes G2)*

Verified against cli.js 2.1.220 (`KOd`, char `10482686` — now documented in ref §5):

Retain the prose of the last assistant **message** that immediately precedes each
user text message, rendered `Assistant: …`. Per-message, not per-block: all text
blocks of that assistant message are joined with `\n` (a proposal may span blocks
around tool calls). Keep dropping thinking blocks, tool **results**, images, and
assistant prose not adjacent to a user message — each newer assistant message's
prose *replaces* the pending one, exactly like cli.js's overwrite semantics. Tool
**calls** render exactly as today.

"Immediately precedes" means **no other USER message intervenes** — the agent's own
tool calls between its proposal and the reply do **not** break adjacency (ref §4/§6).

Truncate each retained assistant prose to a bounded length — 2000 chars, as a named
exported constant, matching cli.js's `fi_ = 2000` — keeping the **TAIL**
(`slice(-2000)`), not the head: the proposal the user affirms sits at the *end* of a
long assistant message, and cli.js's `yq` does the same. Head-truncation would cut
off exactly the referent this feature exists to preserve.

**Recorded deviation:** cli.js gates this whole feature behind
`priorAssistantContext`, **default off** (ref §5). We ship it always-on: Path B
consent is a design goal of this rework, our transcripts are smaller than cli.js's,
and the 2000-char tail cap bounds the cost. No config knob unless it proves noisy.

### 4.4 `JudgeTransport` seam

```ts
export interface JudgeRequest {
  system: string
  user: string
  maxTokens?: number
  stopSequences?: string[]
}
export type JudgeTransport = (req: JudgeRequest) => Promise<string>
```

`maxTokens`/`stopSequences` are **advisory** — transports that cannot honour them (the
opencode session transport cannot, per ADR-023) ignore them. The classifier should
still populate them (stage 1 small/terse, stage 2 larger) so a future transport can
use them.

Adapt the existing `makeJudgeFn` to this interface. **Preserve the tool-denied judge
session and its fail-closed propagation.** Do not add a direct-HTTP judge, touch the
auth vault, or wire pi.

### 4.5 Wiring guards in `handleAutoModeApproval` *(fixes G9, G10)*

Both are small opencode-wiring changes in `OpencodeSession.ts`, not classifier
changes. Background from the opencode 1.17.14 source (vendor clone): the
`permission.asked` payload is `{id, sessionID, permission, patterns, metadata,
always, tool}` — the matched rule is evaluated (`permission/index.ts:73`), logged,
and **discarded**, so no provenance reaches us. But matching is trivially
replicable: `evaluate()` is `rulesets.flat().findLast(rule =>
Wildcard.match(permission, rule.permission) && Wildcard.match(pattern,
rule.pattern))`, fallthrough `{action:'ask', pattern:'*'}`; `Wildcard.match` is
anchored regex with `*`→`.*`, `?`→`.`, `\`→`/` normalization, trailing `" *"` also
matching the bare prefix, case-insensitive on win32.

**G9 — ask-rule precedence.** ClaudeUI already owns the user-authored ruleset it
compiles (`compileClaudeRulesToOpencode`, ~line 1300). Keep the compiled
*user-origin* rules (the output of the user's `ask` arrays only) on the session
object. In `handleAutoModeApproval`, before the fast path and the judge: re-match
`(approval.toolName, each pattern)` against those user ask rules with a host-side
port of `Wildcard.match` + last-match-wins **restricted to the user ruleset** —
a later user `allow`/`deny` on the same pattern outranks an earlier user `ask`,
mirroring opencode's ordering. On a match → `fallbackToHuman`, never classify.
(Matching only the user half is deliberate: replicating opencode's runtime
*defaults* half is fragile — it depends on whitelisted dirs and worktree state —
and defaults never contain user intent.)

**G10 — mode recheck.** After `classify()` resolves (and equally when a queued
judge call finally runs), re-read the session's current permission mode; if auto
mode is no longer active (`isAutoMode` now false), `fallbackToHuman` instead of
auto-replying. The classifier result is discarded, matching cli.js's
`mode_changed_while_queued`.

### 4.6 Out of scope for phase 1

No rule corpus, HARD/SOFT split, consent bars, ALLOW exceptions or `<category>`
output. No ground truth. No pi wiring, auth-vault changes, or direct API transport. No
changes to denial caps or the fast-path tool list. `handleAutoModeApproval` changes
only per §4.5 and the interface move. The POLICY prompt text stays essentially as-is
apart from the stage instructions.

### 4.7 Tests

`src/main/automode/__tests__/classifier.test.ts`, per `docs/testing-strategy.md` —
genuine behavioural assertions, not coverage padding:

- `both`: stage-1-safe → allow, transport called **once**
- `both`: stage-1-block → escalates, **stage 2 ALLOW wins** (the regression the old
  control flow could not express)
- `both`: stage-1 **unparseable** → escalates (must not block outright)
- `fast`: unparseable → block
- `thinking`: single call, stage 2 only
- transport throws at each stage → `{ block: true, unavailable: true }`
- `slimTranscript`: adjacent assistant prose retained; non-adjacent dropped
  (a newer assistant message's prose replaces the pending one); intervening tool
  calls do not break adjacency; multiple text blocks of one assistant message
  joined; retained prose truncated to the **tail** at the constant (assert the
  *end* of a long proposal survives, not the start)
- G9: a pending approval matching a user-authored ask rule goes to the human with
  **zero** judge calls; a later user allow on the same pattern un-matches it;
  win32 case-insensitivity and `"git *"`-matches-bare-`git` covered by the
  wildcard port's own tests
- G10: mode switched away while the judge was in flight → human fallback, judge
  verdict discarded

### 4.8 Gates

`bun run typecheck`, `bun run lint`, `bun run test`. Verify the guard tests **fail
before** the fix and pass after. Then drive the real app per the `verifier-electron`
skill before committing.

---

## 5 Later phases

**Phase 2 — the rule corpus (largest value).** Author our own HARD/SOFT/ALLOW corpus
plus Environment slots and the consent-bar model. Depends on phase 1's slimmer fix for
Path B. Key structural points to carry over from ref §6/§9: exactly one (or very few)
HARD rules; per-rule must-name slots; mandatory ALLOW exceptions; an explicit
out-of-scope list; adversarial-pattern rules whose must-name item is *the false
positive*; post-block consent inheritance.

Generate the `<category>` allowlist **from** the rule list rather than hand-maintaining
both — cli.js maintains them separately, which is why a user-added custom rule silently
loses its category (ref §9.6). Deriving one from the other removes that bug class.

**Phase 3 — ground truth (best effort/value ratio, engine-neutral).** Inject
`gitStatus` before destructive-git commands, `repoVisibility` for exfil-capable
git/gh commands, and `{"outcome":…}` annotations on prior calls with cli.js's
semantics (`rejected-by-user` ⇒ retry should block; `automode-unavailable` ⇒ retry is
appropriate; `ok` is not a safety verdict). We already own the git service.

*Priority order, fixed by the phase-2 review (2026-08-01):* (1) **outcome
annotations first** — until they exist, post-block consent inheritance is
unreachable (denials surface as tool results, which the slimmer drops) and the
mandatory Transient Retry exception is a permissiveness hole (nothing marks a
prior attempt `rejected-by-user`; the corpus carries an interim prose guard).
(2) **session-start remotes** into `EnvironmentInfo.remotes` — the corpus's
empty-remotes fallback was softened as an interim fix, but the real trust anchor
is the recorded remote. (3) `gitStatus` (the dirty-tree presumption currently
can't be cleared — safe but noisy). (4) `repoVisibility`. Also follow up:
`ClassifyResult.category` has no consumer beyond logging — natural key for
per-rule denial caps and block surfacing.

**Prompt tuning (2026-08-01, `scripts/automode-bench/`).** 38 labeled scenarios ×
{gpt-5.6-luna, gpt-5.6-terra, qwen3.8-max-preview, glm-5.2}, mode=`both`: all
four score 37/37 on evidence-available cases with **zero false blocks**; all four
miss only the gitStatus-dependent case (`block-push-env-file`), where the
transcript carries no evidence the file exists — empirical confirmation that
phase 3's ground truth is load-bearing, not a prompt defect. Stage-1
short-circuit ≈ the clean-allow share (consent-dependent allows escalate by
design). `fast` mode (luna): zero false allows but false-blocks Path-A-consented
prod work — `both` stays the default. Latency p50: gpt-5.6 ≈ 5.7 s, qwen ≈ 22 s,
glm ≈ 33 s (+1 unavailable) — recommend a gpt-5.6-class `judgeModel` when the
session model is slow. **No prompt changes made**: a green board everywhere the
judge has data is not a tuning target.

**Phase 4 — pi wiring.** `gateToolCall`'s ask branch → the shared classifier. Needs a
judge transport decision for pi (see §2). Verify G8's fast-path assumption for pi
rather than inheriting opencode's argument.

**Phase 5 — optional direct-API transport.** Dedicated classifier key → real
`max_tokens`, `stop_sequences`, prompt caching. Resolves the ADR-023 deviation for
opt-in users.

---

## 6 Working-tree state at handover

A cancelled sub-agent had left an orphan draft at `src/main/automode/classifier.ts`.
On review (2026-07-31) it turned out to implement §4.2/§4.3/§4.4 nearly in full —
but unreviewed, untested, with head-truncation where cli.js keeps the tail, and a
stage-1 prompt that discloses escalation semantics (both now corrected in this
plan). **Decision: deleted; phase 1 is implemented from scratch against this spec**
(rewrite chosen over review-and-adopt). The original
`src/main/opencode/auto-mode-classifier.ts` and its test are intact and are the
starting point for the §4.1 move.

Also new and uncommitted this session: `docs/protocol/14-auto-mode-classifier.md`,
`scripts/extract-automode-prompts.mjs`, this file, and a one-line index edit to
`docs/protocol/README.md`.

## 7 Open questions

1. **pi's judge transport — DECIDED (2026-07-31, autonomous; refined 2026-08-01).**
   A dedicated `pi --mode rpc --no-session --no-tools` judge process per session,
   spawned lazily on first judge call with `--system-prompt` carrying the policy —
   the exact spawn shape `askSideQuestion` already uses (PiSession.ts ~1377), which
   probed `--no-tools` as accepted in rpc mode. `--no-tools` disables tools at the
   PROCESS level (never registered), which is categorically stronger than both
   opencode's ruleset patch and host-side gating — no bridge extension is loaded at
   all, so there is nothing to pierce (§7 Q5 has no pi analogue). Statelessness via
   RPC `new_session` before each call (probe it under `--no-session`; if
   unsupported, respawn per call — the askSideQuestion cost model). Judge model
   from `AutoModeConfig.judgeModel` via `set_model`, default the session's model.
   System-prompt changes (environment updates) → respawn. No vault changes.
2. **Does opencode's base ruleset really cover fast-path A?** ADR-023 asserts it;
   unverified for pi.
3. **Denial caps vs. post-block consent inheritance.** Our 3-consecutive cap is a crude
   stand-in for a consent model. Once phase 2 lands, revisit — a block is meant to be a
   question, not a dead end.
4. **Where `AutoModeConfig` lives.** Currently `src/shared/types.ts:567`, documented as
   "only consumed by the opencode engine". Needs regeneralizing at phase 4.
5. **opencode's `approved` list pierces the judge's deny-all — CONFIRMED live.**
   Found while verifying G9 (opencode 1.17.14 source): "always" approvals are
   stored in instance-global state, **not keyed by sessionID**
   (`permission/index.ts:145-151`), and `evaluate()` appends them *after* the
   ruleset (`index.ts:73`, `findLast` = last wins) — so they outrank the deny-all
   we PATCH onto judge sessions. ClaudeUI **does** send `always`
   (`OpencodeSession.ts:1171`, for `allowForSession` / persist-checked
   approvals). So a prompt-injected judge could execute any tool call matching a
   pattern the user ever always-approved on that server instance. The prompt
   API's `tools:{…:false}` map is no mitigation — it compiles to the same
   ruleset (`session/prompt.ts:1061-1067`) and loses to `approved` identically.
   Exposure is bounded (requires judge injection + a matching always-approval);
   real fixes ranked: (a) phase 5's direct-API transport — no tools exist at
   all; (b) reply `once` instead of `always` and carry session-persistence in
   ClaudeUI's own compiled ruleset (we already write the Claude permission store
   in parallel, `OpencodeSession.ts:1189-1196`); (c) accepted risk, documented.
   **Interim status: (c), pending a user decision; phase 1 ships with this
   documented.**
6. **GLM-5.2 is unusable as a judge — DO NOT RECOMMEND (2026-08-01, live).**
   Two independent disqualifiers, both observed driving the real app rather than
   the bench harness: (a) **non-compliant output format** — it does not reliably
   emit the `<block>yes|no</block>` grammar the stage prompts demand (prose
   preamble, missing/renamed tags), so verdicts land on the fail-closed
   unparseable path; (b) **hangs of >5 minutes** on a single classification,
   which with no bound wedges the gated tool call behind a spinner with no
   approval card and no way for the user to tell what is happening. Fail-closed
   handled (a) correctly — an unreadable verdict blocks (stage 2) or escalates
   (stage 1), never allows — and the stage-bounded timeouts added alongside this
   entry (`STAGE1_TIMEOUT_MS`/`STAGE2_TIMEOUT_MS`, 60 s/120 s, cli.js `ain`/`lin`)
   now convert (b) into `unavailable` → ask the human. Both behaviours are
   therefore *contained*, not fixed: the model is still a bad judge, it just can
   no longer hang or silently pass anything. Keep it off any recommended
   judge-model list; the bench's format-compliance column is the cheap
   pre-screen for the next candidate.

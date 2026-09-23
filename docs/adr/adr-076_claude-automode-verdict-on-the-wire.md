# ADR-076: Claude's auto-mode verdict on the wire — and a pre-ask denial is not a verdict

**Status:** Accepted (2026-09-21), implemented on `automode-claude-judge`. Amended 2026-09-23 after PR review: renumbered from 073 (the agent roster took it first). The allow gate is now cli.js's `classifierAllowed`, on the stdio wrapper that is ClaudeUI's live path (§2). A no-verdict classifier block is a denial, not a verdict (§7). Subagent decisions now bind (§6, superseded).
**Amends:** [ADR-067](adr-067_codex-shared-permission-model.md) §F18 — its closing sentence, "Claude's Auto mode is cli.js-native and emits no verdict on the wire, so it renders none", is no longer true in either half.
**Relates to:** [ADR-023](adr-023_opencode-automode-classifier.md) (ClaudeUI's own judge, which Claude still does not use — this ADR does not change who judges, only how the verdict arrives), [ADR-006](adr-006_rebundle-bun-binary.md) (the patch pipeline this adds a patch to), [ADR-027](adr-027_test-data-attributes.md) (the testids the live verification asserts), [ADR-050](adr-050_auto-mode-as-the-default-autonomy.md) (Auto as the default autonomy)

## Context

F18 (ADR-067) settled that a permission judge's verdict is a permission
decision, not model reasoning, so it renders in the approval card's vocabulary
**on the card of the item it judged** — approved rows included. Codex's native
auto-review produces one; ClaudeUI's own classifier produces one for opencode
and pi.

Claude produced none, and F18 recorded the reason as a fact about the wire:
its judge is cli.js's, so nothing reaches us. That was half right. Probing the
pinned 2.1.268 binary showed:

- A classifier **block** has always been on the wire, as
  `system/permission_denied` carrying `decision_reason_type: "classifier"` and
  the judge's own `decision_reason`. We were **dropping the frame** —
  `docs/tool-survey.md` had already flagged it as dropped against the protocol
  doc's explicit guidance. Nothing needed to change in cli.js for this half.
- A classifier **allow** genuinely is not on the wire. The emit is gated on
  `behavior !== "allow"`, even though an allowed decision carries the same
  `decisionReason` object a denied one does.

So Claude showed an auto-mode block as a bare red `tool_result` with no
reviewer and no reason, and an auto-mode allow as nothing at all — one engine
of four behaving differently, which is what F18 exists to prevent.

The same frame also covers denials **no judge made**: a deny rule, the
permission mode (`dontAsk`), a PermissionRequest hook, the static safety
checker, a working-directory bound. Those were equally invisible, and they
raise a separate question, because they are not verdicts.

## Decision

### 1. A classifier decision reuses `ToolReviewBlock`; a policy denial does not

A `classifier` decision becomes **the same `ToolReviewBlock`** pi and opencode
build (`reviewer: 'auto-mode'`, rule name in `rule`, no risk level), so the
existing chip and strip serve every engine with no renderer change. That reuse
**is** the deliverable — the ask was "make the view the same as all other
harnesses", and a second component that merely looked similar would drift.

Everything else becomes a new `permission_denial` block. A deny rule could not
have gone the other way and weighed nothing; rendering a policy lookup in the
reviewer's vocabulary would tell the user a judge deliberated when none did.
It gets the same two surfaces (header chip, expanded strip) and a deliberately
different icon — a barred circle, not the judge's shield — so the two read
apart at a glance.

Consequences of the split, all deliberate:

- The denial block carries **no `message`**. cli.js's rejection text is already
  the `tool_result` body; the block adds only the source and, where cli.js
  supplies one, the reason. Rendering both says the same sentence twice.
- `subcommandResults` shares the `rule` wording rather than claiming "part of
  this command". cli.js reports it for _every_ Bash decision, one subcommand or
  ten, so a partiality claim is wrong more often than right (live:
  `chmod 600 subject.txt`, a single subcommand, wholly refused).
- An unrecognised `decision_reason_type` degrades to `other` and renders a
  generic denial. The union is ours; the wire field is cli.js's.

### 2. The allow half is worth a cli.js patch

`patch/automode-verdict` adds `system/permission_allowed`, gated on
`decisionReason?.type === "classifier"`. That filter is the design, not an
optimisation: a rule allow, a mode allow and a fast-path allow were judged by
nobody, and pi and opencode emit no review for their own fast-path allows
either. Without it the patch would narrate every tool call in the session.

**Amended 2026-09-23.** The filter above let through outcomes that nobody judged.
cli.js builds several with `type:"classifier"`: a delivery the classifier "could not review", a
tool with "no classifier-relevant input", and a block delivered anyway under an
`onBlock:"flag"` policy. The gate is now `decisionReason.classifierAllowed === true`, which is
cli.js's own flag for "the classifier ran and reached an allow verdict", stamped in the
permission check only when `noVerdict !== true` and `classifierRan !== false`. If upstream
renames it, the allow frames stop appearing and `test.mjs` fails, which is the safe way to fail.
A flag-policy block delivered anyway now shows nothing on its card. "Approved" would be false,
and "denied" would contradict a call that ran.

Round 1 also named the wrong wrapper as live. ClaudeUI always sets `canUseTool`, so
`args.ts` passes `--permission-prompt-tool stdio` and cli.js builds the **stdio** wrapper
through `createCanUseTool`. The inline wrapper round 1 called "live" runs only with no
prompt tool. Both are patched. The live one now calls the emitter without `?.`, and the patch
test runs the stdio path first.

Accepted cost: a 15th patch to carry across cli.js bumps. Accepted because the
anchors are object literals and method names rather than control flow, all four
edits are extracted by back-reference so a pure rename needs no change, and the
patch fails loudly (exactly-once match checks) rather than silently patching
the wrong site.

### 3. Identity is the frame's own uuid

`reviewId` / `denialId` are cli.js's frame `uuid`, so a replayed catch-up is
idempotent with no bookkeeping. Unlike a Codex re-review, cli.js decides each
call once and never revises it, so the denial block is first-one-wins where a
review is last-one-wins.

### 4. The rule name is parsed out of the reason, under a bound

Stage 2 is asked for `<reason>[Exact Rule Name] one short sentence</reason>`,
so the rule arrives inside the reason rather than as its own field. It is split
out into the badge under the same guard cli.js applies to its own `<category>`
(≤48 chars, `[A-Za-z0-9 _/-]`, plus `/` because a rule name is copied verbatim
and the corpus contains `Logging/Audit Tampering`). This is model text reached
by attacker-influenced transcript content; an unbounded prefix would be a
free-form badge. A reason with no bracket is all rationale — `fast` mode never
asks for a prefix.

### 5. Live-only, on purpose

Both frames are excluded from cli.js's own "worth keeping" predicate, so
neither is persisted; the patch adds `permission_allowed` to that list so our
invented subtype gets identical treatment and never lands in session JSONL no
reader understands. A reopened session therefore shows no verdicts. That is
**parity, not a gap**: no engine reconstructs a `tool_review` on reload.

### 6. Subagent decisions are dropped at the producer — SUPERSEDED 2026-09-23

~~A decision made inside a subagent (`agent_id` set) names a call that lives in a
subagent transcript, which `session:tool-review` does not search. It is dropped
with a debug log.~~

They now bind. The reducer's `attachToToolUse`, shared by `session:tool-review`
and `session:permission-denial`, searches the top-level transcript first and
then every `subagentMessages` bucket. Tool-use ids are unique across a session,
so the producer needs no owner hint and there is no new channel. ClaudeSession
emits `agent_id` frames instead of dropping them. No producer hold is needed:
subagent assistant lines reach the reducer only through stdout, each is handled
synchronously and in order, and a live probe on 2.1.280 showed the subagent's
`tool_use` line ahead of its frame. The fallback applies to every engine, so
Codex, opencode and pi subagent-call reviews stop being dropped too. An appended
block survives a re-send of its host message because the content mergers carry
both kinds beside `tool_result`.

### 7. A classifier block with no verdict is a denial, not a verdict (2026-09-23)

`decision_reason_type: "classifier"` does not always mean the judge ruled. cli.js
also blocks under that type when it never reached a verdict: the classifier was
unavailable, the transcript overflowed its context, a safeguard refused the
request, or repeated responses carried no verdict. Rendering those as "Auto mode
· denied" would repeat the mistake §1 exists to prevent, and opencode and pi hand
an unavailable judge to the user rather than showing a verdict.

The patch forwards cli.js's `noVerdict` as `no_verdict: true` on both frames.
cli.js leaves one case unflagged, `"Classifier unavailable"`, and tells it apart
by that exact string, so the consumer does the same. Either becomes a
`permission_denial` with the derived source `autoModeNoVerdict` ("Blocked · no
verdict", reason underneath). That source is ours: it is never accepted from
`decision_reason_type`. Stage 2's content-free fallbacks (`"Blocked by
classifier"`, `"No reason provided"`) and the server-side classifier's allow
constant are dropped as rationale by exact match, after the `[Rule]` prefix is
split off.

## Wire facts this ADR exists to stop anyone rediscovering

Written up at length in `docs/protocol-cc/04-system-subtypes.md` §4.25 and
`patch/automode-verdict/README.md`; recorded here because each cost real time
and none is guessable from the schema.

1. **There are two `permission_denied` emitters and only one is on the wire.**
   The engine turn loop's sits next to the tool executor — the obvious hook —
   and is a dead end: everything its queue yields passes the stdout adapter's
   `case "system"` switch, whose `default: return` drops `permission_denied`
   itself. The control-channel one is the wire. Cost three
   rebuild-and-probe rounds.
2. **A developer's own allow rules pre-empt the classifier entirely.** With
   user settings loaded the decision comes back `subcommandResults` and the
   judge never runs; `--setting-sources=` makes it fire. Every "auto mode looks
   disabled" dead end traced to this. **Product consequence**: ClaudeUI passes
   `settingSources: ['user','project','local']`, so on a machine with broad
   allow rules Claude verdict rows are sparse. Correct, not a defect — and the
   same silence pi and opencode show on a fast-path allow.
3. **Allow and deny reasons are not symmetric.** An allow's is a fixed cli.js
   constant naming the stage that cleared it (`"Allowed by fast classifier"` =
   stage 1, `"Allowed by classifier"` = stage 2); both are dropped as
   content-free, by exact string, so the `onBlock: "flag"` path's real warning
   survives. A deny's is model text — observed live as a bare
   `"[Create Unsafe Agents]"` with no sentence at all.
4. **ClaudeUI runs the stdio permission wrapper** (2026-09-23). `canUseTool`
   means `--permission-prompt-tool stdio`, and that selects the wrapper built
   by `createCanUseTool`. A harness that passes no prompt tool tests the
   other wrapper, and round 1's patch test did exactly that.
5. **The classifier trigger drifts between versions.** On 2.1.280 an in-cwd
   `chmod` no longer reaches the classifier. `curl -sI https://example.com`
   does. Confirm with `--debug-to-stderr` (`[auto-mode] new action being
classified`) before trusting a probe that shows no frames.

## Consequences

- Claude reaches F18 parity: a verdict on allowed and blocked cards alike, in
  the same component the other three engines use.
- Pre-ask denials that were only visible as a red result now name their source,
  closing the `tool-survey.md` §5 finding for Claude.
- Subagent tool cards carry verdicts too, for every engine (§6).
- One more patch in the `ensure-cli` chain, with a README written for an agent
  that has to rebuild it from scratch when the minified names change.
- **Open gap at acceptance, still open after round 2**: a classifier _denial_ has
  been verified on the wire and in unit tests but never rendered in the live
  app. Round 1's judge allowed every safe probe. Round 2 (2026-09-23) tried two
  more benign triggers, a force-push to a throwaway local bare repo and a POST
  of a one-word dummy file to httpbin, and the judge allowed both. Escalating to
  a genuinely unsafe command was ruled out both times. The `denied`
  (rendered "Auto mode · blocked") + rule-badge path and the new
  `autoModeNoVerdict` denial are therefore test-covered only. Round 2 did verify
  live: an allow chip on a top-level card, a deny-rule chip, and an allow chip
  on a subagent's own tool card.

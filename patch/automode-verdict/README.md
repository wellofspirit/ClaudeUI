# Patch: automode-verdict

Emits `system/permission_allowed` when Claude's auto-mode classifier **allows** a tool call, so an SDK host can render the judge's verdict on the card it judged, and marks both verdict frames with `no_verdict: true` when the classifier decided without reaching a verdict. Upstream emits only the denial half (`system/permission_denied`), with nothing that separates a real verdict from a no-verdict fallback.

## Affected Component

`cli.js` — rebundled from `@anthropic-ai/claude-code` Bun standalone.

| Component            | Version                                                  |
| -------------------- | -------------------------------------------------------- |
| At time of discovery | bundled CLI `2.1.268`                                    |
| Last re-anchored     | bundled CLI `2.1.280` (2026-09-23, edits A and C1 moved) |

## The Problem

### User-visible symptom

ClaudeUI draws a permission judge's verdict on the tool card it judged — decision, rule, rationale — for opencode, pi and Codex, on **approved and denied** rows alike. On Claude it drew nothing, because Claude's judge is not ours: the two-stage classifier documented in `docs/protocol-cc/14-auto-mode-classifier.md` runs inside cli.js, and its verdict only reaches a host as a wire frame.

Upstream emits a frame for a denial and **nothing** for an allow. So without this patch, Claude in auto mode is silent about every action it cleared, and one engine of four behaves differently from the other three.

### What upstream does

Every permission wrapper returns early on an allow and emits only on a deny. The stdio wrapper (ClaudeUI's live path, see below) on 2.1.280:

```js
function de(n, e) {                       // n = prompt-tool kind, e = permission-prompt host
  return async (s, r, m, g, f, _) => {    // tool, input, ctx, assistantMsg, toolUseId, precomputed
    let h
    switch (n.kind) {
      case "launcher": h = _ ?? await Sf(s, r, m, g, f); break
      case "strict":   h = _ ?? await j3(s, r, m, g, f, n, void 0); break
    }
    if (h.behavior === "allow") return h                          // ← nothing on the wire
    if (h.behavior === "deny") { …; return e.emitPermissionDenied(s.name, f, m.agentId, h), h }
    …ask path (can_use_tool control_request)…
  }
}
```

…even though an allowed classifier decision carries the same shaped object a denied one does:

```js
{ type: "classifier", classifier: "auto-mode", reason: "Allowed by fast classifier" }
```

### A `classifier` decision is not always a verdict

`decisionReason.type === "classifier"` also covers outcomes where the classifier **reached no verdict**. cli.js (2.1.268 and 2.1.280) builds all of these with `type: "classifier"`:

| Behavior | Marker            | `reason`                                                                                                                                                 |
| -------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| deny     | `noVerdict: true` | an empty classifier action (tool gave the classifier nothing to judge)                                                                                   |
| deny     | `noVerdict: true` | `"Auto mode classifier transcript exceeded context window — …"`                                                                                          |
| deny     | `noVerdict: true` | a safeguard refusal of the classifier request                                                                                                            |
| deny     | `noVerdict: true` | (2.1.280) `"Auto mode unavailable — stopped after repeated responses with no safety verdict"`                                                            |
| deny     | **none**          | `"Classifier unavailable"` — cli.js itself tells it apart by that exact string                                                                           |
| allow    | `noVerdict: true` | `"Delivered with a warning: the classifier request was refused by the safety safeguard"` / `"Delivered with a note: the classifier could not review it"` |
| allow    | **none**          | `"Tool declares no classifier-relevant input"` (`classifierRan: false`, stripped before the decision leaves)                                             |

The stock `permission_denied` frame carries none of `noVerdict` / `classifierRan`, and `decision_reason` for a `classifier` decision is `decisionReason.reason` verbatim. So a host could not tell "the judge blocked this" from "the judge was never reached". Edit A adds `no_verdict`. Of the two rows without a flag, the allow is never emitted (the allow gate below excludes it at the source), so only the `"Classifier unavailable"` deny has to be recognised by its reason string, which is the consumer's job.

### What we emit

One line per classifier allow that reached a verdict:

```json
{
  "type": "system",
  "subtype": "permission_allowed",
  "tool_name": "Bash",
  "tool_use_id": "toolu_0132tT1sBzd9fvHrPvELRjd9",
  "decision_reason_type": "classifier",
  "decision_reason": "Allowed by fast classifier",
  "uuid": "3fd4ac48-…",
  "session_id": "241e3129-…"
}
```

Every field the stock `permission_denied` frame has is kept, including 2.1.280's `decision_reason_code` (it serialises away here because the renderer returns `undefined` for a classifier verdict), and `agent_id` (absent on a top-level call). Only `message` is dropped: that key is the denial's rejection text, handed to the model, and an allow has none.

Both frames gain `"no_verdict": true` when `decisionReason.noVerdict === true`. The key is **omitted** otherwise, never `false`. By construction it never appears on `permission_allowed`, because the allow emit is gated on a real verdict (below); it is on the sibling so the two emitters stay field-for-field identical.

Consumed by `claude-session.ts → handlePermissionDecision()`, which turns it into the same `tool_review` block pi and opencode produce (`core/services/claude-permission-decision.ts`).

Upstream's allow reasons are **fixed strings**, not model prose — `"Allowed by fast classifier"` for a stage-1 clear, `"Allowed by classifier"` for a stage-2 one, `"Not flagged by the server-side auto mode classifier"` for the server-side classifier. A denial's reason IS model text and follows the stage-2 grammar (`"[Create Unsafe Agents]"`, sometimes with a sentence after the bracket), with `"No reason provided"` / `"Blocked by classifier"` as content-free fallbacks. Do not assume symmetry between the two.

## The trap: there are TWO `permission_denied` emitters, and only one is on the wire

This cost three rebuild-and-probe rounds. Both exist in 2.1.268 and 2.1.280:

1. **The engine turn loop.** Wraps `canUseTool` and pushes advisory frames onto a buffer (`pendingDenialFrames`), drained by a generator into the engine's message stream. It is the more obvious hook — it sits right next to the tool executor — and it is a **dead end**: everything that stream yields passes through the stdout adapter's `case "system"` switch, whose `default: return` drops every subtype not explicitly listed. `permission_denied` is **not** listed there. A frame emitted here is enqueued, yielded, and silently discarded.

2. **The control-channel class** (`emitPermissionDenied`), which enqueues onto `this.outbound` — written to stdout unconditionally under `--output-format stream-json --verbose`, bypassing the adapter entirely. **This is the one that reaches the wire.**

Verify before assuming: instrument both sites with `process.stderr.write(...)`, rebundle, run any denial, and see which one's frame appears on stdout.

## The second trap: which wrapper is live

cli.js builds the permission function in `Uw(promptTool, channel, …)`:

```js
function Uw(e, r, n, s, g, w) {
  let C = Ale(w)                                   // permissionPromptTool === "none"
  if (!C && e === "stdio") {
    let k = r.createCanUseTool(_B, s)              // → de(_B, this.permissionPromptHost(s))   ← C1
    return …k
  }
  if (C || !e) return async (k, T, O, B, E, se) => { …emitPermissionDenied… }   // ← C2
  …MCP prompt-tool wrapper…
}
```

`src/core/sdk/args.ts` passes `--permission-prompt-tool stdio` whenever `canUseTool` is set, and ClaudeSession always sets it. **So C1, the stdio wrapper, is ClaudeUI's live path.** C2 runs only for a host with no prompt tool, or with `--permission-prompt-tool none`. The same held on 2.1.268 (`createCanUseTool(r){return ie(this.permissionPromptHost(r))}`).

Round 1 of this patch had that backwards: it called C2 "the live one" and made C1's call optional, and its test went through a harness that never passes a prompt tool, so all eight assertions exercised C2 only. The patch happened to work because both wrappers were patched — but the optional `?.` call meant a host object missing the method would have degraded silently on the path users actually hit, and no test would have noticed. The test now runs the stdio path first (see Testing).

## Architecture Overview

```
classifier decision (tAr → _t)                      tool_use in assistant message
        │                                                         │
        ▼                                                         │
  permission wrapper ── C1 de(n,e)  [--permission-prompt-tool stdio] ◄── ClaudeUI
        │           └─ C2 Uw inline [no prompt tool / "none"]
        │ allow + decisionReason.classifierAllowed + !aborted
        ▼
  host.emitPermissionAllowed (B) ──► this.emitPermissionAllowed (A) ──► this.outbound
                                                                           │
                                                                           ▼
                                                           stdout (stream-json), NOT the
                                                           transcript (D keeps it ephemeral)
```

Five edits. A, B and D are one-liners; C is the substance, and it exists twice because cli.js builds two permission wrappers depending on flags.

### Edit A — the emitters

Anchor: the method definition `emitPermissionDenied(n,e,s,r){let m=r.decisionReason;this.outbound.enqueue({…})}` on the control-channel class.

Before (2.1.280):

```js
emitPermissionDenied(n,e,s,r){let m=r.decisionReason;this.outbound.enqueue({type:"system",subtype:"permission_denied",tool_name:n,tool_use_id:e,agent_id:s,decision_reason_type:m?.type,decision_reason_code:qoe(m),decision_reason:Jhe(m),message:r.message,uuid:M(),session_id:K()})}
```

After:

```js
emitPermissionDenied(n,e,s,r){let m=r.decisionReason;this.outbound.enqueue({type:"system",subtype:"permission_denied",tool_name:n,tool_use_id:e,agent_id:s,decision_reason_type:m?.type,decision_reason_code:qoe(m),decision_reason:Jhe(m),message:r.message,...(m?.noVerdict===!0&&{no_verdict:!0}),uuid:M(),session_id:K()})}emitPermissionAllowed(n,e,s,r){let m=r.decisionReason;this.outbound.enqueue({type:"system",subtype:"permission_allowed",tool_name:n,tool_use_id:e,agent_id:s,decision_reason_type:m?.type,decision_reason_code:qoe(m),decision_reason:Jhe(m),...(m?.noVerdict===!0&&{no_verdict:!0}),uuid:M(),session_id:K()})}
```

The spread of `false`/`undefined` in an object literal is a no-op, so the key is present only when the flag is exactly `true`. Every renderer (`qoe`, `Jhe`, `M`, `K`) is captured by back-reference, never hardcoded.

### Edit B — expose it on the host object

The wrapper in C1 holds a plain object built by `permissionPromptHost()`, not the class. The new method is bound onto it beside `emitPermissionDenied`:

```js
emitPermissionDenied:(e,s,r,m)=>this.emitPermissionDenied(e,s,r,m),emitPermissionAllowed:(e,s,r,m)=>this.emitPermissionAllowed(e,s,r,m),
```

### Edit C1 — the stdio wrapper (**the live one**)

After (2.1.280):

```js
if (h.behavior === 'allow') {
  if (h.decisionReason?.classifierAllowed === !0 && !m.abortController.signal.aborted)
    e.emitPermissionAllowed(s.name, f, m.agentId, h)
  return h
}
```

- The call has **no `?.`**. If the host object ever lacks the method, that must fail at patch time (edit B's exactly-once check), not degrade quietly at runtime on the path users actually hit.
- The host is read from the wrapper's own signature. `apply.mjs` captures `function NAME(P1,P2){return async(…)` together with the deny branch's own `HOST.emitPermissionDenied(tool.name,id,ctx.agentId,result)` call, and requires that receiver to be one of `NAME`'s parameters. On 2.1.280 it is `e`, the second one; on 2.1.268 the wrapper was `function ie(r)` with the host first. Anchoring on the deny emit rather than a parameter position survives either shape.
- The abort guard matches C2's: a cancelled turn must not narrate a verdict for a call that never ran. C1's own deny branch has no has-call guard, so neither does its allow branch.

### Edit C2 — the no-prompt-tool wrapper

```js
return async (k, T, O, B, E, se) => {
  let X = se ?? await Sf(k, T, O, B, E), W = X.behavior === "ask" && … ? … : X
  if (W.behavior !== "allow" && Aw(B, E) && !h5(O.abortController.signal))
    r.emitPermissionDenied(k.name, E, O.agentId, W)
  if (W.behavior === "allow" && W.decisionReason?.classifierAllowed === !0
      && Aw(B, E) && !h5(O.abortController.signal))                  // ← injected
    r.emitPermissionAllowed(k.name, E, O.agentId, W)
  return W
}
```

Both upstream guards are carried over deliberately:

- `Aw(msg, toolUseId)` — the assistant message really contains this `tool_use`. That is precisely what makes the frame bindable to a card; without it a host gets a verdict for a call it never rendered.
- the abort check — a cancelled turn must not emit a verdict for a call that never ran.

### The gate (both wrappers)

`decisionReason?.classifierAllowed === true`. This is the whole design, and the flag is cli.js's own, not ours.

The auto-mode permission check (`tAr` on 2.1.280) finishes every allow it decides through a local helper (`_t`), which strips `classifierRan` off the decision and stamps `classifierAllowed` onto the decision reason only when the classifier ran and reached a verdict:

```js
let{classifierRan:Xr,...io}=Mr,Ro=io.decisionReason.type==="classifier"&&io.decisionReason.noVerdict!==!0&&Xr!==!1?{...io,decisionReason:{...io.decisionReason,classifierAllowed:!0}}:io;
…return{behavior:"allow",...Ro}
```

cli.js itself reads the flag when it runs the tool (`autoModeClassified: decisionReason.classifierAllowed === !0`). So the gate lets through exactly the classifier's own allow verdicts (`"Allowed by fast classifier"`, `"Allowed by classifier"`) and nothing else. The server-side classifier's result feeds the same value into `_t`, so its allow (`"Not flagged by the server-side auto mode classifier"`) should be stamped the same way; that path was read, not probed live. What the gate keeps out:

- a rule allow, a mode allow and a fast-path allow never carry it, and none of them is a judgment anyone reached — the same line pi and opencode draw when they skip a review for a fast-path allow;
- the no-verdict allows (`"Delivered with a warning: …"` / `"Delivered with a note: …"`) have `noVerdict: true`;
- `"Tool declares no classifier-relevant input"` has `classifierRan: false`, so the classifier never ran. It is excluded at the source; the consumer needs no reason-string rule for it;
- a classifier BLOCK on a tool whose classifier policy is `onBlock: "flag"` is delivered as an allow (`"Flagged by the classifier, delivered with its warning: …"`) straight from the block branch, not through `_t`, so it carries no flag and is not emitted. It is a verdict, but a block, and reporting it as `permission_allowed` would be wrong.

Without the gate the patch would narrate every tool call in the session.

**If upstream renames or drops `classifierAllowed`**, nothing breaks at patch time (the gate is inside the injected text, not the anchor), and the allow frames simply stop appearing. `test.mjs` then fails on "permission_allowed emitted" on both paths — the safe direction to fail in. Re-locate it by searching for `classifierAllowed:!0` (the stamp) or `autoModeClassified:` (the reader).

### Edit D — keep the frame ephemeral

A predicate decides whether a message is "worth keeping". It does **not** gate stdout; it gates the accumulated message list, the `--output-format json` last-message pick, and the transcript mirror. Upstream keeps `permission_denied` out of all three; our invented subtype must get the same treatment, or it lands in session JSONL that no reader understands — and can become the "last message" the `json` output format reports.

```js
!(e.type==="system"&&(e.subtype==="session_state_changed"||e.subtype==="permission_denied"||e.subtype==="permission_allowed"||…
```

### Variable mapping (names WILL change)

| Role                                  | 2.1.268         | 2.1.280            | Where                                                |
| ------------------------------------- | --------------- | ------------------ | ---------------------------------------------------- |
| control-channel emitter method        | —               | —                  | `emitPermissionDenied` (name is stable)              |
| emitter params (name/id/agent/result) | —               | `n` `e` `s` `r`    | the method's own parameters                          |
| reason-code renderer                  | (no such field) | `qoe`              | `decisionReason` → `decision_reason_code`            |
| reason renderer                       | `Noe`           | `Jhe`              | `decisionReason` → a redacted string                 |
| uuid / session stampers               | `H` `X`         | `M` `K`            | called inside the emitter                            |
| C1 wrapper function                   | `ie(r)`         | `de(n,e)`          | built by `createCanUseTool`                          |
| C1 host param                         | `r`             | `e` (second param) | receiver of the deny branch's `emitPermissionDenied` |
| C1 result / tool / ctx / id           | `f` `e` `o` `d` | `h` `s` `m` `f`    | the wrapper's locals                                 |
| C2 result / channel / tool            | `ie` `n` `w`    | `W` `r` `k`        | on 2.1.268 `ie` SHADOWED the C1 function             |
| C2 has-call / aborted                 | `MS` `dG`       | `Aw` `h5`          | the two upstream guards                              |
| C2 msg / toolUseId / ctx              | `B` `v` `te`    | `B` `E` `O`        |                                                      |
| ephemeral-list param                  | `e`             | `e`                |                                                      |

The patch extracts every one of these from its anchor with back-references, so a pure rename needs no edit here. Only a **structural** change needs re-locating. `apply.mjs` prints the resolved names on every run.

## Re-locating the anchors

Each anchor fails loudly and names the section to read, rather than patching the wrong site.

### Re-locating edit A

```
bundle-analyzer find vendor/claude-cli/cli.js "emitPermissionDenied(" --compact
```

Want the **method definition** — `emitPermissionDenied(a,b,c,d){let x=d.decisionReason;this.outbound.enqueue({…})}` — not the arrow that forwards to it (edit B) and not a call site. The `this.outbound.enqueue` is the distinguishing feature. 2.1.280 broke the round-1 anchor by adding `decision_reason_code:qoe(m)` between `decision_reason_type` and `decision_reason`; if another field appears, add it to the regex and to the sibling (the sibling keeps every stock field except `message`).

### Re-locating edit B

Same search; want the arrow **inside the object literal** returned by `permissionPromptHost`, of the form `emitPermissionDenied:(a,b,c,d)=>this.emitPermissionDenied(a,b,c,d),`. It sits between `interruptedAtStreamClose:` and `promptShown:`.

### Re-locating edit C1

```
bundle-analyzer find vendor/claude-cli/cli.js "createCanUseTool(" --compact
```

`createCanUseTool(…){return WRAP(…,this.permissionPromptHost(…))}` names the wrapper. Its body starts `function WRAP(…){return async(tool,input,ctx,msg,toolUseId,pre)=>{let R…`, then `if(R.behavior==="allow")return R;if(R.behavior==="deny"){…HOST.emitPermissionDenied(tool.name,toolUseId,ctx.agentId,R)`. 2.1.280 broke the round-1 anchor twice over: the result became `let h;switch(n.kind){…}` instead of `let f=pre??await …;`, and the host moved from the only parameter to the second. The anchor now spans the statements between those points with a bounded run that cannot cross `=>{` or `function `, so it tolerates either result-assignment shape.

The wrapper must be in the same `// @bun-chunk` as `createCanUseTool` — chunks are separate modules, and the file has several unrelated `function de(`.

### Re-locating edit C2

Search for `.emitPermissionDenied(` and pick the **call site** (not the definition, not the arrow) that is guarded by `behavior!=="allow"`. Its `return <result>}` immediately after is the injection point. It lives inside `Uw`, right after `if(C||!e)return async(`.

If upstream ever collapses the two wrappers into one, C1 and C2 will match the same span — the exactly-once check in `apply.mjs` will fail rather than double-patch.

### Re-locating edit D

Search for `"session_state_changed"` and pick the hit inside `!(e.type==="system"&&(…))` whose next clause is `permission_denied`. Insert after that clause.

## Syntax pitfalls

### Pitfall: `$` in minified names

```js
// WRONG — a string replacement interprets `$$`, `$&`, `$1`…, so a minified name like `$$e` is mangled
source.replace(anchor, `…${name}…`)
// CORRECT
source.replace(anchor, () => `…${name}…`)
```

Every replacement in `apply.mjs` goes through a function replacer.

### Pitfall: `if` after a bare expression statement

```js
// WRONG — parses, but `return h` is now outside the allow check and runs for every behavior
if(h.behavior==="allow")if(…)e.emitPermissionAllowed(…);return h
// CORRECT — brace the allow branch
if(h.behavior==="allow"){if(…)e.emitPermissionAllowed(…);return h}
```

The deny and ask paths below it would never run. Always run the test (or `node --check` on the edited chunk) after changing an injection.

## What's NOT changed

- **The engine-side emitter.** Dead end, see the first trap.
- **The MCP prompt-tool wrapper** (the third branch of `Uw`, for `--permission-prompt-tool mcp__…`). ClaudeUI never passes an MCP prompt tool (`permissionPromptToolName` is unused outside `args.ts`).
- **The ask path.** An allow the host grants via `can_use_tool` is the user's decision, not the judge's, and is already visible to the host because it answered it.

## Testing

```
node patch/automode-verdict/test.mjs
```

The test runs the same trigger twice: first with `--permission-prompt-tool stdio` (edit C1, ClaudeUI's path), then with no prompt tool (edit C2). For the stdio run, `patch/test-helpers.mjs` has an opt-in `permissionPromptTool: 'stdio'` that also answers any `can_use_tool` escalation with a deny, so a turn cannot hang on a prompt nobody answers. Neutering only C1 in the bundle fails the stdio run and passes the other, which is how we know the stdio run reaches C1.

Three conditions must hold or the classifier never runs and the test silently tests nothing:

1. `--permission-mode auto` (implies `--enable-auto-mode`).
2. **`settingSources: []`.** The non-obvious one: a developer's own `~/.claude/settings.json` almost certainly carries broad Bash allow rules, and a rule allow short-circuits the pipeline long before the classifier — the decision comes back `subcommandResults` and no verdict is ever reached. This single fact accounted for every "the classifier seems to be disabled" dead end during development.
3. **A command the fast paths don't clear.** `ls`/`cat` are cleared by the static safety checker ("Read-only command is allowed"); `mkdir`/`touch` inside the cwd are cleared by fast path A ("would acceptEdits allow this?", `docs/protocol-cc/14-auto-mode-classifier.md` §3). Round 1 used `chmod` in the cwd; **on 2.1.280 that no longer reaches the classifier** (no frames at all). The test uses `curl -sI https://example.com`, which does — stderr under `--debug-to-stderr` shows `[auto-mode] new action being classified: tool=Bash` and a stage-1 `classifier_request_finished outcome=ok`. It needs network.

Per run, the test asserts the frame exists, that every frame is a classifier decision, that no `permission_allowed` carries `no_verdict` or a non-verdict reason (`"Tool declares no classifier-relevant input"`, `"Delivered with a …"`, `"Flagged by the classifier…"`) — the gate, that its `tool_use_id` names a `tool_use` from the same turn, that uuid/session are stamped, that a reason is present, and that no `message` key rides along. Any denial must still carry its reason type and a `no_verdict` that is absent or exactly `true`.

The `"Classifier unavailable"` and no-verdict paths have no known cheap live trigger (`CLAUDE_CODE_AUTO_MODE_MODEL=<bogus>` does not change the classifier model); the consumer's unit tests cover them.

## Verification

1. `bun run ensure-cli` — re-extracts, applies every patch, rebundles. With `node scripts/build.mjs ensure-cli --verbose` the log shows `automode-verdict: applied.` and the resolved names.
2. `node patch/apply-all.mjs` again — prints `automode-verdict: already applied (permission_allowed present) — nothing to do.`; `cli.js` is byte-identical afterwards.
3. `node patch/automode-verdict/test.mjs` — all assertions pass on both paths.

## Related

- `docs/protocol-cc/04-system-subtypes.md` §4.25 — the wire contract of both frames.
- `docs/protocol-cc/14-auto-mode-classifier.md` — the classifier and its fast paths.
- `docs/adr/adr-076_claude-automode-verdict-on-the-wire.md` — why the verdict rides on the card.

## Files

| File        | Purpose                                        |
| ----------- | ---------------------------------------------- |
| `README.md` | This document                                  |
| `apply.mjs` | Patch script (five edits, all back-referenced) |
| `test.mjs`  | Live behavioral test, stdio and no-prompt-tool |

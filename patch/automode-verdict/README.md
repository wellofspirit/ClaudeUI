# Patch: automode-verdict

Emits `system/permission_allowed` when Claude's auto-mode classifier **allows** a tool call, so an SDK host can render the judge's verdict on the card it judged. Upstream emits only the denial half (`system/permission_denied`).

## Affected Component

`cli.js` — rebundled from `@anthropic-ai/claude-code` Bun standalone.

| Component            | Version                                                        |
| -------------------- | -------------------------------------------------------------- |
| At time of discovery | bundled CLI `2.1.268`                                          |
| Last re-anchored     | bundled CLI `2.1.268` (2026-09-21, first version of the patch) |

## The Problem

### User-visible symptom

ClaudeUI draws a permission judge's verdict on the tool card it judged — decision, rule, rationale — for opencode, pi and Codex, on **approved and denied** rows alike. On Claude it drew nothing, because Claude's judge is not ours: the two-stage classifier documented in `docs/protocol-cc/14-auto-mode-classifier.md` runs inside cli.js, and its verdict only reaches a host as a wire frame.

Upstream emits a frame for a denial and **nothing** for an allow. So without this patch, Claude in auto mode is silent about every action it cleared, and one engine of four behaves differently from the other three.

### What upstream does

The permission wrapper on the control-channel path (the one an SDK host with no `--permission-prompt-tool` gets) emits only on a non-allow:

```js
if (result.behavior !== "allow" && hasCall(msg, toolUseId) && !aborted(ctx.abortController.signal))
  channel.emitPermissionDenied(tool.name, toolUseId, ctx.agentId, result)
return result
```

…even though an allowed classifier decision carries the same shaped object a denied one does:

```js
{ type: "classifier", classifier: "auto-mode", reason: "Allowed by fast classifier" }
```

### What we emit

One line per classifier-decided allow:

```json
{
  "type": "system",
  "subtype": "permission_allowed",
  "tool_name": "Bash",
  "tool_use_id": "toolu_019kcWQCxnN6drTxPTYVquc2",
  "decision_reason_type": "classifier",
  "decision_reason": "Allowed by fast classifier",
  "uuid": "1027dd26-…",
  "session_id": "091fa025-…"
}
```

Consumed by `claude-session.ts → handlePermissionDecision()`, which turns it into the same `tool_review` block pi and opencode produce (`core/services/claude-permission-decision.ts`).

Note what is **absent**: `message`. That key is the denial's rejection text, handed to the model; an allow has none.

Upstream's allow reasons are **fixed strings**, not model prose — `"Allowed by fast classifier"` for a stage-1 clear, `"Allowed by classifier"` for a stage-2 one. A denial's reason IS model text and follows the stage-2 grammar (`"[Create Unsafe Agents]"`, sometimes with a sentence after the bracket). Do not assume symmetry between the two.

## The trap: there are TWO `permission_denied` emitters, and only one is on the wire

This cost three rebuild-and-probe rounds. Both exist in 2.1.268:

1. **The engine turn loop.** Wraps `canUseTool` and pushes advisory frames onto a buffer (`pendingDenialFrames`), drained by a generator into the engine's message stream. It is the more obvious hook — it sits right next to the tool executor — and it is a **dead end**: everything that stream yields passes through the stdout adapter's `case "system"` switch, whose `default: return` drops every subtype not explicitly listed. `permission_denied` is **not** listed there. A frame emitted here is enqueued, yielded, and silently discarded.

2. **The control-channel class** (`emitPermissionDenied`), which enqueues onto `this.outbound` — written to stdout unconditionally under `--output-format stream-json --verbose`, bypassing the adapter entirely. **This is the one that reaches the wire.**

Verify before assuming: instrument both sites with `process.stderr.write(...)`, rebundle, run any denial, and see which one's frame appears on stdout.

## Architecture Overview

Four edits. A, B and D are one-liners; C is the substance, and C exists twice because cli.js builds two different permission wrappers depending on flags.

### Edit A — the sibling emitter

Clone `emitPermissionDenied` on the control-channel class as `emitPermissionAllowed`, changing the subtype and dropping `message`. Same `this.outbound` queue, same uuid/session stamping.

### Edit B — expose it on the host object

The wrapper in C1 holds a plain object built by `permissionPromptHost()`, not the class. The new method has to be bound onto it beside `emitPermissionDenied`.

### Edit C1 — the `--permission-prompt-tool=stdio` wrapper

```js
function HOST_FN(host) {
  return async (tool, input, ctx, msg, toolUseId, pre) => {
    let r = pre ?? await checkPermissions(tool, input, ctx, msg, toolUseId)
    if (r.behavior === "allow") return r        // ← we inject here
    if (r.behavior === "deny") { … }
    …ask path…
  }
}
```

Not the live path for ClaudeUI, patched for completeness. The call is made with `?.` so a host object lacking the method degrades to today's behaviour instead of throwing.

### Edit C2 — the control-channel wrapper (**the live one**)

```js
return async (tool, input, ctx, msg, toolUseId, pre) => {
  let r = pre ?? await checkPermissions(…)
  let out = r.behavior === "ask" && … ? … : r
  if (out.behavior !== "allow" && hasCall(msg, toolUseId) && !aborted(ctx.abortController.signal))
    channel.emitPermissionDenied(tool.name, toolUseId, ctx.agentId, out)
  return out                                    // ← we inject before this
}
```

Both upstream guards are carried over deliberately:

- `hasCall(msg, toolUseId)` — the assistant message really contains this `tool_use`. That is precisely what makes the frame bindable to a card; without it a host gets a verdict for a call it never rendered.
- the abort check — a cancelled turn must not emit a verdict for a call that never ran.

And one guard of our own: `decisionReason?.type === "classifier"`. This is the whole design. A rule allow, a mode allow and a fast-path allow carry a different (or absent) `decisionReason`, and none of them is a judgment anyone reached — the same line pi and opencode draw when they skip a review for a fast-path allow. Without this filter the patch would narrate every tool call in the session.

### Edit D — keep the frame ephemeral

A predicate decides whether a message is "worth keeping". It does **not** gate stdout; it gates the accumulated message list, the `--output-format json` last-message pick, and the transcript mirror. Upstream keeps `permission_denied` out of all three; our invented subtype must get the same treatment, or it lands in session JSONL that no reader understands — and can become the "last message" the `json` output format reports.

### Variable mapping (2.1.268 — names WILL change)

| Role                            | 2.1.268 | Where                                       |
| ------------------------------- | ------- | ------------------------------------------- |
| control-channel emitter method  | —       | `emitPermissionDenied` (name is stable)     |
| reason renderer                 | `Noe`   | maps `decisionReason` → a redacted string   |
| uuid / session stampers         | `H` `X` | called inside the emitter                   |
| C1 host param                   | `r`     | `function ie(r){return async(…)}`            |
| C1 result / tool / ctx / id     | `f` `e` `o` `d` | the wrapper's locals              |
| C2 result / channel / tool      | `ie` `n` `w` | note: `ie` here SHADOWS the C1 function |
| C2 has-call / aborted           | `MS` `dG` | the two upstream guards                   |
| C2 msg / toolUseId / ctx        | `B` `v` `te` |                                        |
| ephemeral-list param            | `e`     | inside `aS(e)`                              |

The patch extracts every one of these from its anchor with back-references, so a pure rename needs no edit here. Only a **structural** change needs re-locating.

## Re-locating the anchors

Each helper below fails loudly and names the section to read, rather than patching the wrong site.

### Re-locating edit A

```
bundle-analyzer find vendor/claude-cli/cli.js "emitPermissionDenied(" --compact
```

Want the **method definition** — `emitPermissionDenied(a,b,c,d){let x=d.decisionReason;this.outbound.enqueue({…})}` — not the arrow that forwards to it (edit B) and not a call site. The `this.outbound.enqueue` is the distinguishing feature.

### Re-locating edit B

Same search; want the arrow **inside the object literal** returned by `permissionPromptHost`, of the form `emitPermissionDenied:(a,b,c,d)=>this.emitPermissionDenied(a,b,c,d),`. It sits between `interruptedAtStreamClose:` and `promptShown:`.

### Re-locating edit C1

Search for `behavior==="allow")return` and pick the hit whose next statement is `if(<same>.behavior==="deny"){`. That pairing is what distinguishes the emitting wrapper from the several other permission functions with the same parameter shape. The host parameter is read from the enclosing `function NAME(host){return async(` immediately before the match.

### Re-locating edit C2

Search for `.emitPermissionDenied(` and pick the **call site** (not the definition, not the arrow) that is guarded by `behavior!=="allow"`. Its `return <result>}` immediately after is the injection point.

If upstream ever collapses the two wrappers into one, C1 and C2 will match the same span — the exactly-once check in `apply.mjs` will fail rather than double-patch.

### Re-locating edit D

Search for `"session_state_changed"` — one hit, a long `||` chain of subtypes inside a `!(e.type==="system"&&(…))`. Insert after the `permission_denied` clause.

## Testing

```
node patch/automode-verdict/test.mjs
```

Three conditions must hold or the classifier never runs and the test silently tests nothing:

1. `--permission-mode auto` (implies `--enable-auto-mode`).
2. **`settingSources: []`.** The non-obvious one: a developer's own `~/.claude/settings.json` almost certainly carries broad Bash allow rules, and a rule allow short-circuits the pipeline long before the classifier — the decision comes back `subcommandResults` and no verdict is ever reached. This single fact accounted for every "the classifier seems to be disabled" dead end during development.
3. A command that is **neither read-only nor an in-cwd edit**. `ls`/`cat` are cleared by the static safety checker ("Read-only command is allowed"); `mkdir`/`touch` inside the cwd are cleared by fast path A, which asks "would acceptEdits allow this?" (`docs/protocol-cc/14-auto-mode-classifier.md` §3). The test uses `chmod`, which is neither — and is offline and deterministic, which a `curl` probe is not.

The test asserts the frame exists, that only classifier decisions produce one, that its `tool_use_id` names a `tool_use` from the same turn, that uuid/session are stamped, that a reason is present, and that no `message` key rides along.

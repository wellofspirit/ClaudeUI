# Patch: request-usage

Emits a `request_usage` JSON message to stdout after each API response completes, exposing the per-request token breakdown (input/output/cache tokens) the CLI otherwise keeps internal.

## Affected Component

`cli.js` — rebundled from `@anthropic-ai/claude-code` Bun standalone.

| Component | Version |
|---|---|
| At time of discovery | bundled CLI `2.1.4x` (flat `if`-chain era) |
| Redesigned | bundled CLI `2.1.163` |
| Last re-anchored | bundled CLI `2.1.170` (message_stop case gained a telemetry call) |

## The Problem

### User-visible symptom

ClaudeUI's usage analytics want per-API-request token counts (especially cache read/write breakdowns) in real time. The CLI accumulates usage internally but never emits a per-request line, so the consumer can only see aggregate totals at `result` time.

### What we emit

A single line per completed API response:

```json
{"type":"request_usage","usage":{"input_tokens":…,"output_tokens":…,"cache_read_input_tokens":…,…},"model":"claude-…"}
```

Consumed by `claude-session.ts → logRequestUsage()` (case `request_usage` in the message switch), which appends it to `~/.claude/ui/usage/request-usage.jsonl`. The consumer reads only `usage` and `model`; `session_id` is supplied from its own session state, so we **do not** emit it.

## Architecture Overview — and why this patch was redesigned

**Old shape (≤ ~2.1.4x):** a flat `if`-chain inside a class method, accumulating onto `this.totalUsage`:

```js
if(<q>.event.type==="message_start") <H>=<O0>, <H>=<merge>(<H>,<q>.event.message.usage);
if(<q>.event.type==="message_delta"){ if(<H>=<merge>(<H>,<q>.event.usage), <q>.event.delta.stop_reason!=null) <y>=...; }
if(<q>.event.type==="message_stop") this.totalUsage=<accum>(this.totalUsage,<H>);  // ← old inject point
```

The old patch captured the model into `this._patchModel` at `message_start` and appended a `process.stdout.write(...)` after the `this.totalUsage=...` accumulation.

**New shape (2.1.163):** the per-event handling moved into a `switch(<p>.type){case ...}` inside a **standalone streaming generator** (no `this` in scope). Critically:

- `case"message_stop"` is reduced to **`break`** — the `this.totalUsage=<accum>(...)` accumulation is **gone** from the streaming path; the per-request total is now reconciled in the generator's `finally` block.
- There is **no `this`** — the old `this._patchModel` / `this.totalUsage` injection is impossible.

So the patch could not be re-anchored; it was **redesigned**.

### Variable mapping (v2.1.163 — names WILL change)

| Var | Role | Where set |
|---|---|---|
| `p_` | the stream event (discriminator is bare `p_.type`, **not** `p_.event.type`) | switch scrutinee |
| `sH` | the message object; `sH.model` is the model that served the request | `case"message_start":{sH=p_.message,...}` |
| `QH` | per-request usage accumulator | init `QH=ZM` once at generator top; merged at message_start (`QH=O7H(QH,p_.message?.usage)`) and each message_delta (`QH=O7H(QH,p_.usage)`) |
| `O7H` | usage merge fn | — |
| `ZM` | zero-usage constant | — |

Both `sH` and `QH` are `let`-declared at the generator top and **reset per request** (`...sH=void 0,...QH=ZM` between requests), so at `message_stop` they hold the just-completed request's values — exactly the semantics the old `message_stop` inject point had.

## The Patch

**Marker:** `/*PATCHED:request-usage*/`

Two-step, both anchored on string-literal case labels.

### Step 1 — capture the accumulator + model var (read-only)

Anchor on the `message_start` case to extract `QH` (usage) and `sH` (message → model):

```
case"message_start":{(sH)=(p_).message,(xH)=Math.max(0,Math.round(performance.now()-(TH))),(QH)=(O7H)(\5,\2.message?.usage)
```

(Captures `sH`, `p_`, `xH`, `TH`, `QH`, `O7H`; the backref `\5,\2.message?.usage` pins it to the real accumulator line. Verified to match exactly once.)

### Step 2 — inject the emit at `message_stop`

The `message_stop` case is a **bare** (brace-free) case body ending in `break}` (the trailing `}` closes the switch). It was `case"message_stop":break}` in 2.1.163; **2.1.170 added a telemetry statement**: `case"message_stop":eH("stream_completed",jH??null,r_);break}` (where `r_` is the same per-request usage accumulator Step 1 captures, and `jH` the TTFT timing var). The anchor is now a generalized regex that tolerates brace-free statements before the break and **preserves them**:

```js
/case"message_stop":((?:[^{}]*;)?)break\}/g
```

The `[^{}]` restriction keeps it out of the two block-bodied `case"message_stop":{this._addMessageParam(...)` sites in the Anthropic SDK MessageStream classes and the two `case"message_stop":return q;...` accumulator sites (no `break`). Verified to match exactly once. Our stdout write is appended **after** the preserved statements, before `break`.

**Before (2.1.170):**
```js
case"message_stop":eH("stream_completed",jH??null,r_);break}
```

**After:**
```js
case"message_stop":eH("stream_completed",jH??null,r_);/*PATCHED:request-usage*/process.stdout.write(JSON.stringify({type:"request_usage",usage:r_,model:W_?.model||""})+"\n");break}
```

(2.1.163 names: `usage:QH,model:sH?.model` — same shape, empty preserved-statements group.)

### Why it's safe

- `process.stdout.write` (global) is used — no `this` dependency. cli.js already writes newline-delimited JSON to stdout from many sites; the SDK-side readline parser handles one more complete line.
- `message_stop` fires once per API response → exactly one emit per request (same cadence as the old `this.totalUsage` inject point).
- `model:sH?.model||""` — optional-chained; if absent the consumer falls back to its own `this.model`.
- Pure addition of one statement; balance preserved (`case"message_stop":break}` → `case"message_stop":<stmt>;break}`).

## How to Find This Code

```bash
# The message_stop case (bare body; had a telemetry stmt added in 2.1.170 —
# search by the case label, not the full literal):
bundle-analyzer find cli.js 'case"message_stop"' --compact   # pick the brace-free body ending in break}

# The accumulator line (model + usage capture):
bundle-analyzer find cli.js "sH=p_.message" --compact     # name will change
bundle-analyzer find cli.js 'case"message_start":{' --compact   # multiple switches exist — pick the one with the usage merge

# The per-request total reconciliation now lives in the generator's finally block:
bundle-analyzer find cli.js "QH=O7H(ZM," --compact         # name will change
```

> **Note:** `case"message_start":{` matches several switches in cli.js (different generators). The correct one is the streaming generator whose body merges usage (`=<merge>(...,...message?.usage)`) and sets the message object. The other is a render/UI switch (`case"message_start":{o7(this,...)}`).

## Syntax Pitfalls

- **Don't add a block at `message_stop`.** The case body ends `break}` — the `}` is the *switch* close. Replacing it with `{...break}` would consume the switch's closing brace. Inject as bare statements: `case"message_stop":<existing stmts><stmt>;break}` (the existing `}` still closes the switch).
- **Preserve upstream statements in the case body.** 2.1.170 added `eH("stream_completed",jH??null,r_);` before the break — dropping it would silently kill upstream telemetry. The apply script captures and re-emits whatever brace-free statements precede `break`.
- **`p_.type`, not `p_.event.type`.** In 2.1.163 the event is the switch scrutinee directly; there is no `.event` wrapper at this layer (that wrapping happens at the later `yield{type:"stream_event",event:p_,...}`).
- **No `this`.** This is a standalone generator. Any injected code referencing `this` is a bug — read off the captured locals (`sH`, `QH`) instead.

Always run `node --check cli.js` after applying.

## What's NOT Changed

- We don't touch the `message_start`/`message_delta` cases — only read their var names. The accumulation logic is left intact.
- We don't emit `uuid` / `session_id` (the old patch did). The consumer never read them — it uses its own session state. Re-adding them would require finding the session-id/uuid fns in the generator's scope, which aren't readily available here.
- The generator's `finally`-block reconciliation (`QH=O7H(ZM,<final usage>)`) is untouched.

## Consumer-Side Integration

```
cli.js (this patch) → process.stdout: {"type":"request_usage","usage":{…},"model":"…"}
  → src/main/sdk parses stream-json
  → claude-session.ts handleMessage() → case "request_usage" → logRequestUsage(msg)
      reads msg.usage + msg.model; sessionId/cwd from session state
      → appends ~/.claude/ui/usage/request-usage.jsonl (mode 0600)
```

Type: `RequestUsageMessage` in `src/main/sdk/types.ts` (`{ type:'request_usage', usage?: Record<string,unknown> }`; `model` arrives via `BaseSDKMessage`).

## Verification

1. `node patch/request-usage/apply.mjs` — reports the captured vars and injects.
2. Run again — marker check exits early ("Patch already applied").
3. `node patch/apply-all.mjs` — `node --check` passes.
4. **Live validation (no dedicated harness):** any test that spawns the rebundled binary shows `type=request_usage` in the message stream right before each `message_stop` — observed in `subagent-streaming`, `usage-relay`, and `rate-limit-relay` test dumps, including subagent (`parent_tool_use_id`) contexts.

## Discovery Method (2.1.163 redesign)

1. **Apply failed:** `Cannot locate stream_event message start/delta/stop pattern`.
2. **bundle-analyzer:** found the flat `if`-chain is gone — handling is now `switch(p_.type){case ...}` in a standalone generator; `grep` confirmed **zero** `this.totalUsage` in that function's range. The old inject point no longer exists.
3. **Found the per-request total moved** to the generator's `finally` block (`QH=O7H(ZM,<final>)`), not `message_stop`.
4. **Chose `message_stop` as the new inject point** (fires once per response, matches old cadence); confirmed `QH` accumulates from `message_start` + deltas and is reset per request, so it holds the right value there.
5. **Got the model** from `sH=p_.message` (`sH.model`) instead of the now-impossible `this._patchModel`.
6. **Dropped `uuid`/`session_id`** after checking the consumer ignores them.
7. **Live-verified:** `type=request_usage` appears at every `message_stop` across multiple test runs.

## Re-anchor (2.1.170)

1. **Apply failed:** `message_stop case matched 0 times` — the exact literal `case"message_stop":break}` was gone.
2. **Grepped all `case"message_stop"` occurrences** (5 total): two block-bodied SDK MessageStream sites, two `return q;` accumulator sites, and ours — now `case"message_stop":eH("stream_completed",jH??null,r_);break}`. Upstream added a `stream_completed` telemetry call passing the same usage accumulator (`r_`) Step 1 captures; same generator (Step 1 still matched: `W_`/`y8`/`r_`/`fKH`).
3. **Generalized the anchor** to `/case"message_stop":((?:[^{}]*;)?)break\}/` — tolerates and preserves brace-free statements before `break`, still excludes the other four sites via `[^{}]`/missing `break`. Uniqueness check retained.

## Key Functions Reference

| Name (v2.1.163) | Purpose |
|---|---|
| `O7H` | usage merge fn |
| `ZM` | zero-usage constant |
| (generator) | streaming loop containing the `switch(p_.type)` and the per-request `finally` reconcile |

**Note:** all minified names change between versions. Relocate by the `case"message_stop":break}` / `case"message_start":{` string literals and the usage-merge structural shape.

## Related Patches

- `usage-relay`, `rate-limit-relay` — also relay usage/limit telemetry to stdout; their tests incidentally validate this patch's emit.

## Files

| File | Purpose |
|---|---|
| `README.md` | This document |
| `apply.mjs` | Patch script |

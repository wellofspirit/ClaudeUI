# Patch: taskstop-notification

Fixes TaskStop to properly notify SDK consumers when tasks are stopped. **As of cli.js 2.1.198, both parts are fully upstreamed — this patch is a no-op detector, not an active patch.** It still runs on every `ensure-cli`/`update-cli` to re-verify the upstreamed behavior hasn't regressed, and to re-activate the legacy injection logic if it ever does.

## Affected Component

`cli.js` — rebundled from the Claude Code CLI Bun standalone binary.

| Component                         | Version                                                                                              |
| --------------------------------- | ---------------------------------------------------------------------------------------------------- |
| At time of discovery              | bundled CLI `~0.2.4x` era (Part A), `~0.2.8x` era (Part B)                                           |
| Part A upstreamed                 | SDK 0.2.49+ (validator learned to accept `"killed"`)                                                 |
| Part A validator REMOVED entirely | somewhere before bundled CLI `2.1.198` (confirmed absent both in legacy and "killed"-inclusive form) |
| Part B upstreamed                 | SDK 0.2.87+ (TaskStop's kill path calls the notification emitter directly)                           |
| Last re-anchored                  | bundled CLI `2.1.198` (this pass — detection logic rewritten, zero bytes patched)                    |

## The Problem (historical)

When a background task is stopped via TaskStop, the SDK consumer never receives a notification, and even if it did, the status would be wrong:

1. **No notification sent** — TaskStop kills the task and sets `notified:true`, but never calls the notification sender. The task appears stuck in "running" state. _(Fixed upstream in SDK 0.2.87 — see Part B.)_
2. **~~"killed" status rejected~~** — _(Fixed upstream in SDK 0.2.49, then the whole validator was removed entirely by 2.1.198 — see Part A.)_ The CLK used `"killed"` internally, but a shared XML/status validator only accepted `completed|failed|stopped`. Unknown statuses defaulted to `"completed"`, so stopped tasks showed as completed.

Both problems are now handled entirely upstream. **This README's job is to teach the next agent how to re-verify that (or re-patch it, if a future CLI version regresses).**

## Architecture Overview (2.1.198 — current)

There is **no single validator/allowlist** anymore. The killed→stopped mapping is decentralized: every task-type's kill/stop code path is individually responsible for translating its internal `status:"killed"` registry state into the literal string `"stopped"` **before** calling the notification emitter. The emitter itself performs zero validation — it is a dumb pass-through.

```
TaskStop tool .call()
  └─> oHt(taskId, {killedBy:"parent", ...})      ← shared kill orchestrator
        ├─> u = taskTypeRegistry[task.type]       (local_bash / local_agent / remote_agent / dream / workflow / ...)
        ├─> await u.kill(taskId, registry, setState, killedBy)
        │     each u.kill() implementation:
        │       1. registry.update(id, t => ({...t, status:"killed", notified:!0, ...}))  ← INTERNAL status only
        │       2. qu(id, "stopped", {toolUseId, summary})   ← LITERAL "stopped", never "killed"
        └─> (cascade) for any child local_agent tasks orphaned by this kill:
              qu(childId, "stopped", {...})        ← same translation, same emitter

qu(taskId, status, opts):                          ← the notification emitter — NO VALIDATION
  if (!guard(taskId)) return;
  CT({ type:"system", subtype:"task_notification", task_id:taskId,
       tool_use_id: opts?.toolUseId, status /* <- raw passthrough */,
       output_file: opts?.outputFile ?? "", summary: opts?.summary ?? "",
       usage: opts?.usage, ...(opts?.skipTranscript !== void 0 && {skip_transcript: opts.skipTranscript}) })

CT(event):                                          ← queues onto a per-session buffer
  push event onto a Map<sessionId, event[]>
  (drained elsewhere into the stream-json stdout the SDK/ClaudeUI consumes)
```

**Why this is safe without a validator:** the emitter (`qu` in 2.1.198) is only ever called from a small, closed set of first-party call sites inside cli.js itself — never from user/tool input. Every one of those call sites was audited (see below) and every single one passes the literal string `"stopped"`, not the internal `"killed"` status. There is no code path where an unmapped `"killed"` reaches `qu()`.

### Verified call sites (2.1.198, all confirmed via bundle-analyzer — see "How to Find This Code")

| Task type                                    | Kill function                      | Registry sets     | Emitter call                                       |
| -------------------------------------------- | ---------------------------------- | ----------------- | -------------------------------------------------- |
| `local_bash`                                 | `WEe(taskId, registry)`            | `status:"killed"` | `qu(e,"stopped",{toolUseId:...,summary:...})`      |
| `local_agent`                                | `Rpe(taskId, registry, killedBy)`  | `status:"killed"` | `qu(e,"stopped",{killedBy:...,...})` (via `v9e`\*) |
| `remote_agent`                               | `RemoteAgentTask.kill()`           | `status:"killed"` | `qu(e,"stopped",{toolUseId:r,summary:o})`          |
| `dream`                                      | `DreamTask.kill()`                 | `status:"killed"` | `qu(e,"stopped",{skipTranscript:!0})`              |
| `workflow`                                   | `VHe(taskId, registry)`            | `status:"killed"` | `qu(e,"stopped",{toolUseId:...,summary:...})`      |
| generic sweep                                | `gXt({taskRegistry, setAppState})` | (loop over all)   | `qu(r.id,"stopped",{toolUseId:...,summary:...})`   |
| cascade (children of a killed `local_agent`) | inside `oHt()`                     | `notified:!0`     | `qu(m.id,"stopped",{toolUseId:...,summary:...})`   |

\* `local_agent`'s kill path additionally calls a separate function `v9e({taskId,status:"killed",killedBy,...})` that builds a **different**, orthogonal XML string injected into the _conversation transcript_ (`<status>${n}</status>` inside a `<task-notification>` block the model reads in-context) — this is **not** the stream-json `task_notification` system event and is out of scope for this patch. `v9e`'s output can legitimately contain `<status>killed</status>` in the transcript text; that has no effect on the SDK-facing event and predates/postdates this patch equally. Do not conflate the two channels when re-analyzing a future version — see "What's NOT Changed".

**Confirmed absence of a leak:** `bundle-analyzer find cli.js 'qu\([a-zA-Z0-9_$]+,"killed"'` (or the equivalent generic `<emitterName>\([^,]+,"killed"` pattern once you've located the emitter under its current name) returns **zero matches** in 2.1.198. This is the negative-space check that proves the mapping is complete — not just that translated calls exist, but that no untranslated ones do.

## The (former) Fix — Part A: killed → stopped mapping

### Historical shape (validator existed, SDK < 0.2.49)

```js
// Before:
;((y1 = (R1) => R1 === 'completed' || R1 === 'failed' || R1 === 'stopped'),
  (G1 = y1(x1) ? x1 : 'completed'))

// After (what this patch used to inject):
;((y1 = (R1) => R1 === 'completed' || R1 === 'failed' || R1 === 'stopped' || R1 === 'killed'),
  (G1 = y1(x1) ? (x1 === 'killed' ? 'stopped' : x1) : 'completed'))
```

### 2.1.198 reality: the validator is gone, not just extended

Earlier revisions of this README said "upstreamed in SDK 0.2.49 — the validator now natively accepts `killed`" and had `apply.mjs` look for the validator with `"killed"` already inlined into its allowlist (`X==="completed"||X==="failed"||X==="stopped"||X==="killed"`). That assumption held through cli.js 2.1.197. **In 2.1.198, that assumption breaks**: the whole shared-validator _function_ was removed from the codebase, in either shape (plain or killed-inclusive). Grepping for both regexes against a freshly extracted 2.1.198 `cli.js` returns zero matches for both.

This isn't a regression — it's a further refactor. The mapping didn't disappear, it moved: from "one central allowlist function used by many callers" to "many callers, each doing its own translation right before calling the (now dumb) emitter." Confirmed the emitter itself does no validation — see the `qu()` signature above (`status:t` — a bare passthrough parameter, no ternary, no `.includes()`, no allowlist array).

### Emitter shape to search for (2.1.198 naming; will be renamed next version)

```js
function qu(e, t, n) {
  if (!Mxa(e)) return
  CT({
    type: 'system',
    subtype: 'task_notification',
    task_id: e,
    tool_use_id: n?.toolUseId,
    status: t /* <- raw passthrough, zero validation */,
    output_file: n?.outputFile ?? '',
    summary: n?.summary ?? '',
    usage: n?.usage,
    ...(n?.skipTranscript !== void 0 && { skip_transcript: n.skipTranscript })
  })
}
```

Found via the literal `subtype:"task_notification"` object-construction (unique, 1 match in 2.1.198 at the time of writing).

### Detection logic in `apply.mjs` (current, 3-tier)

`apply.mjs` tries three things in order, newest-assumption-last:

1. **Legacy validator shape** (`(V)=>V==="completed"||V==="failed"||V==="stopped",` + `?.[1]` extraction + `V(x)?x:"completed"` ternary) — if found, this SDK version still has the old bug; patch it exactly as before (this branch is essentially dead code at this point but kept for safety/rollback scenarios; it still writes the `/*PATCHED:taskstop-notification-A*/` marker).
2. **Old upstream shape** (validator already includes `||V==="killed"` in its allowlist) — SDK 0.2.49–2.1.197 shape. If found, skip (no-op).
3. **No-validator shape (2.1.198+)** — locate the emitter function structurally by its content pattern (`function NAME(id,status,opts){if(!GUARD(id))return;EMIT({type:"system",subtype:"task_notification",task_id:id,tool_use_id:opts?.toolUseId,status:status,...})}`), then verify two **behavioral invariants** against that specific emitter name:
   - **(i) Translation exists:** somewhere in the file, `status:"killed",` is followed (within ~400 chars) by `<emitterName>(<id>,"stopped"` — proof that at least one kill-site translates the internal status before emitting.
   - **(ii) No leak exists:** nowhere in the file does `<emitterName>(<id>,"killed"` appear — proof that no call site hands the emitter the raw internal status.

   If both hold: log "Upstreamed... Skipping." and exit successfully (patchCount stays 0 for Part A).
   If the emitter can't be located at all, **or** either invariant fails: `process.exit(1)` with a message pointing at what needs re-analysis. **This is intentional — never silently skip a version where the behavioral proof can't be established.** A future agent hitting this exit should not assume upstreamed-and-safe; they should re-run the discovery method below.

### Why it's safe to treat this as upstreamed

- The emitter is a low-level internal primitive, not exposed to user/tool input — its only callers are the small set of first-party kill-path functions inside cli.js.
- All of those callers were individually located and read (not just regex-matched) — see the call-site table above.
- The negative-space check (`qu(...,"killed"`) returning zero matches is the crucial piece — it's not enough that _some_ callers translate correctly; _none_ may leak.
- Verified end-to-end at runtime, not just statically: `patch/taskstop-notification/test.mjs` launches a real background task against the rebundled `bun-claude.exe`, calls `stopTask()`, and asserts the resulting `task_notification` has `status:"stopped"` — this passed 3/3 against 2.1.198 with zero bytes of cli.js patched for Part A.

## Part B: Inject notification call into TaskStop

**Status: still upstreamed as of 2.1.198, unchanged from the prior README.** No code or detection-logic changes were needed this pass — re-verified only.

Historically this part inserted a call to the notification sender (e.g. `kxY()`/`v9e()`) before the `notified:true` flag was set, because TaskStop used to kill tasks silently. As of SDK 0.2.87+, the kill orchestrator (`oHt`/`gXt`/each task type's `.kill()` — see architecture above) calls the emitter (`qu()`) **unconditionally** as part of the kill sequence itself. There is no separate "TaskStop forgot to notify" bug anymore — notification is baked into every kill path, not just the tool-invoked one.

### Detection (unchanged)

```js
const upstreamNotifyRe = new RegExp(
  `notified:!0[\\s\\S]{1,300}?` + `(V)\\(V,"stopped",\\{toolUseId:`
)
```

Searched in a wide window (~5000 chars before, ~1000 after) around the anchor string `"Successfully stopped task:"` (the TaskStop tool's own success-message template literal, unique in the file). In 2.1.198 this anchor sits inside the `TaskStop` tool definition object itself (`tnr` in 2.1.198's naming — aliases `KillShell`/`KillBash`, `userFacingName: () => "Stop Task"`); its `call()` delegates to `oHt()`, which is where the actual `notified:!0` + `qu(id,"stopped",...)` pattern lives (within the ~5000-char lookback window). Confirmed 5 genuine (non-overlapping) matches of the general pattern across different task types in the full file — this is not a coincidental/false-positive match.

### Why it's safe

- `oHt()` is the single funnel every kill path (including TaskStop-tool-invoked, system sweeps, and cascaded child-task kills) goes through — auditing it once covers every caller.
- Runtime-verified: same `test.mjs` run above also asserts `task_notification` actually arrives (not just that its status is correct) — if Part B had regressed, `task_started` would fire but no matching `task_notification` would ever show up, and the test would time out / fail the "task_id matches" assertion.

## How to Find This Code (2.1.198 anchors — will need re-derivation next version)

### The notification emitter (`qu` in 2.1.198)

```bash
# Primary — unique object-construction literal:
bundle-analyzer find cli.js 'subtype:"task_notification"' --compact
# Confirm shape:
bundle-analyzer context cli.js <offset-from-above>
```

### TaskStop tool definition + its `call()` delegate

```bash
# Unique success-message template literal (TaskStop's own tool-result text):
bundle-analyzer find cli.js "Successfully stopped task:" --compact
# From there, find the orchestrator it calls (search a few hundred chars back
# for "async call({task_id" then follow the function it invokes, e.g. in
# 2.1.198 this was named oHt — but don't rely on that name next version).
```

### Kill-site call table (re-derive per version)

```bash
# The killed->stopped translation, keyed off the emitter name found above:
bundle-analyzer find cli.js 'status:"killed"' --compact       # every place the internal status is set
bundle-analyzer find cli.js '<emitterName>\(' --regex --compact   # every call site of the emitter
# Then manually pair each status:"killed" registry-update with its
# corresponding <emitterName>(id,"stopped",...) call within the same function.
```

### Negative-space leak check (the most important verification step)

```bash
bundle-analyzer find cli.js '<emitterName>\([a-zA-Z0-9_$]+,"killed"' --regex --compact
# MUST return zero matches. If it returns any, that call site needs the
# translation this patch used to inject — revive the legacy Part-A injection
# logic against that specific call site (not the old validator shape).
```

### Notification sender for the in-context XML transcript (orthogonal — do not conflate)

```bash
# v9e in 2.1.198 — builds the <task-notification> XML the MODEL reads
# in-context. NOT the same thing as the stream-json task_notification event.
bundle-analyzer find cli.js "was stopped by Claude" --compact
```

## Syntax Pitfalls

- **Don't assume "validator not found" means "SDK changed the validator's shape."** In 2.1.198 it meant the validator was deleted entirely and replaced with a decentralized pattern. Always widen the search before assuming a shape-drift — grep for the emitter's literal object-construction (`subtype:"task_notification"`) first; that's more stable than any validator/allowlist shape.
- **The lambda/loop variable name `d`/`u`/whatever appears multiple times across different closures in the emitter's callers** (e.g., `local_bash`'s `WEe` and `local_agent`'s `Rpe` may both use a variable named `e` for the task ID, but they're unrelated bindings in different function scopes). When building a re-targeted regex, always scope your capture groups to a single function body — don't try to backreference across function boundaries.
- **Two different "status" concepts exist in this area of the code**: the stream-json `task_notification.status` (this patch's concern) and the in-context transcript XML `<status>` tag built by `v9e()` (a different, cosmetic channel that legitimately may still say `"killed"`). Confusing the two will send you chasing a non-bug — see the `v9e` footnote in the architecture section above.
- Always run `node --check cli.js` after applying (or attempting to apply) this patch — `bun run ensure-cli`'s `apply-all.mjs` runner does this automatically after all patches run.

## What's NOT Changed

- **`v9e()`'s in-context transcript XML** — still may legitimately contain `<status>killed</status>` for `local_agent` kills. This is a separate, cosmetic channel (model-visible transcript text), not the SDK-facing stream-json event. Not this patch's concern; do not attempt to "fix" it without opening a new investigation into whether it's actually a problem (it likely isn't — the model doesn't need SDK-schema-valid status strings in its own context).
- **The emitter's other fields** (`output_file`, `summary`, `usage`, `skip_transcript`) — untouched, always were pass-through, not part of this patch's scope.
- **The queue/drain mechanism** (`CT()` pushing onto a per-session `Map`, drained elsewhere into stdout) — unrelated to this patch; not investigated further since it's several layers removed from the killed/stopped concern.

## Verification

1. `node patch/taskstop-notification/apply.mjs` — expect both parts to report "Upstreamed... Skipping." with exit code 0 (as of 2.1.198). If either part reports "Applied.", that means a future CLI version regressed and this patch is doing real work again — treat that as newsworthy, not routine.
2. Run again — expect identical output (idempotent either way: markers short-circuit if a legacy path fired; the no-validator behavioral check re-runs and re-confirms every time since there's no marker to check against for a no-op).
3. `node patch/apply-all.mjs` — all patches (14 total as of 2.1.198) apply/skip without error, `node --check` passes.
4. `node patch/taskstop-notification/test.mjs` — end-to-end runtime proof against the rebundled `bun-claude.exe`:
   1. Launches a real background task (`sleep 300` via Bash tool, `run_in_background:true`)
   2. Waits for `task_started`, then calls `q.stopTask(taskId)`
   3. Asserts: `task_started` received; `task_notification` with `status === "stopped"` received; `task_id` matches between the two. All 3 assertions must pass (3/3, confirmed on 2.1.198).
5. `bun run update-cli` (or `ensure-cli`) end-to-end, twice in a row (including once with a fully fresh `--force` re-extraction) — both parts must resolve to "Skipping." both times, and the final rebundle must write `vendor/claude-cli/bun-claude.exe`.

## Discovery Method (2.1.197 → 2.1.198 re-anchor)

1. **Observed the symptom**: `bun run update-cli` hard-failed with `ERROR: Cannot locate task_notification status validator.` at Part A, aborting the entire 14-patch chain before rebundle.
2. **First hypothesis (wrong initially, needed verification)**: assumed the validator's shape had merely drifted again (as it had across prior versions) and that a slightly-adjusted regex would relocate it.
3. **Searched broadly instead of guessing a new shape**: grepped for both the legacy validator allowlist shape and the "killed"-inclusive upstream shape — **neither existed anywhere in the file**. This ruled out "shape drift" and pointed at "the validator itself is gone."
4. **Searched for the actual behavior instead of the old artifact**: grepped for the unique, stable anchor `subtype:"task_notification"` (the literal object key the emitter constructs) — found exactly one real match (`qu()` in 2.1.198), plus several unrelated matches in UI-schema code and unrelated status-mapping helpers (`nVm`, a stream-json redaction/allowlist function unrelated to this bug — do not confuse the two if you see `nVm` again; it strips/renames fields on already-built events, it doesn't gate `task_notification`'s `status` field).
5. **Read the emitter fully**: `qu(e,t,n){if(!Mxa(e))return;CT({...status:t,...})}` — confirmed `status:t` is a bare passthrough with no validation whatsoever. This meant "is Part A upstreamed" could no longer be answered by finding a validator (there isn't one) — it had to be answered by proving every caller pre-translates correctly.
6. **Enumerated every caller of the emitter** using `bundle-analyzer find cli.js 'qu\('` and manually read each one's enclosing function (`WEe`, `Rpe`, `RemoteAgentTask.kill`, `DreamTask.kill`, `VHe`, `gXt`, and the cascade inside `oHt`) — every single one passed the literal `"stopped"`.
7. **Ran the negative-space check**: `bundle-analyzer find cli.js 'qu\([a-zA-Z0-9_$]+,"killed"'` → zero matches. This is what actually proves the fix is complete (positive matches alone don't rule out a missed caller).
8. **Rewrote the Part A detection logic** in `apply.mjs` to encode this same behavioral proof (locate the emitter structurally, then run the two invariant checks) instead of hunting for a specific token sequence that no longer exists — see "Detection logic" above.
9. **Re-verified Part B needed no changes**: its anchor (`"Successfully stopped task:"`) and its upstream-detection regex both still matched cleanly against 2.1.198 without modification — confirmed by running `apply.mjs` and observing "Upstreamed... Skipping." for Part B with the pre-existing, unmodified logic.
10. **Verified the fix statically and dynamically**: `node patch/taskstop-notification/apply.mjs` exits 0 with both parts reporting upstreamed; ran it a second time for idempotency (identical output); ran `bun run update-cli` twice end-to-end (once via `ensure-cli` using the cached download, once via `update-cli --force` triggering a full fresh re-download+re-extraction) — both produced byte-identical `bun-claude.exe` output and both completed the full 14-patch chain + rebundle without error; finally ran `patch/taskstop-notification/test.mjs` against the freshly rebuilt binary and got 3/3 passing assertions on real wire traffic (a live `stopTask()` round-trip producing `status:"stopped"`).

## Key Functions Reference (2.1.198 — will be renamed next version)

| Name (2.1.198) | Purpose                                                                           | How found                                                       |
| -------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `qu`           | Notification emitter — builds & queues the `task_notification` system event       | literal `subtype:"task_notification"` object construction       |
| `Mxa`          | Guard inside `qu()` — gates whether a notification is emitted at all              | 2nd param of `qu`'s `if(!Mxa(e))return;` guard                  |
| `CT`           | Pushes an event onto the per-session output queue                                 | called by `qu()`; also drained by `XJ()`/`ngo()`                |
| `WEe`          | `local_bash` task type's `.kill()`                                                | `LocalShellTask={name:"LocalShellTask",type:"local_bash",...}`  |
| `Rpe`          | `local_agent` task type's `.kill()`                                               | `LocalAgentTask={name:"LocalAgentTask",type:"local_agent",...}` |
| `oHt`          | Shared kill orchestrator TaskStop's `call()` delegates to                         | traced from the `"Successfully stopped task:"` anchor           |
| `gXt`          | System-wide kill sweep (kills all running tasks matching a predicate)             | near `oHt`, iterates `taskRegistry.all()`                       |
| `v9e`          | Builds in-context transcript XML `<task-notification>` (NOT this patch's concern) | literal `"was stopped by Claude"` / `"was stopped by user"`     |
| `tnr`          | TaskStop tool definition object (`aliases:["KillShell","KillBash"]`)              | contains the `"Successfully stopped task:"` anchor              |

**Note:** every name above will change in the next SDK/CLI version bump. Use the content-pattern searches in "How to Find This Code" to relocate them; do not grep for these literal identifiers.

## Related Patches

- `patch/subagent-streaming/` — handles the synchronous `Task`/`Agent` tool streaming path; this patch's `local_agent` task type is the _async/background_ counterpart (`TaskCreate` with `run_in_background`), a different code path entirely.
- `patch/background-task/` — the `background_task` control-request handler that lets ClaudeUI's own SDK layer (not the model) background a running tool call; complementary but independent of TaskStop's kill/notify path covered here.
- `patch/queue-control/` — unrelated steer/queue mechanism; shares no code with this patch but lives in the same "task lifecycle" neighborhood.

## Files

| File        | Purpose                                                              |
| ----------- | -------------------------------------------------------------------- |
| `README.md` | This document                                                        |
| `apply.mjs` | Patch/detection script (currently a no-op detector on 2.1.198)       |
| `test.mjs`  | End-to-end behavioral test against the rebundled `bun-claude` binary |

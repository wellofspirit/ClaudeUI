# Patch: task-notification

Fixes a bug in Claude Code's headless/SDK mode where background task completion
notifications never reach the SDK consumer.

## Affected Component

`@anthropic-ai/claude-agent-sdk` — specifically the bundled `cli.js` file.

The SDK bundles its own copy of Claude Code CLI as `cli.js` in the package
directory. This file is executed by the SDK via `node` or `bun` when you call
`query()`. It is **independent** of the native `claude` binary installed on
your system, and may trail behind in version.

| Component | Version at time of discovery |
|---|---|
| Native Claude Code binary | 2.1.39 |
| SDK package | 0.2.38 |
| Bundled CLI (`cli.js`) | 2.1.38 |

Both the native binary (2.1.39) and the SDK's bundled CLI (2.1.38) contain this
bug. Since the SDK runs its own `cli.js`, that is what we patch.

## The Bug

When Claude Code runs in headless/SDK streaming mode (as opposed to the
interactive terminal UI), background task completion notifications are silently
dropped. The model launches a sub-agent via the `Task` tool, the sub-agent
finishes its work, but the notification that it finished never arrives in the
SDK's message stream.

## Root Cause

Claude Code maintains **two separate message queues** for internal events:

| Queue | Storage | Writer | Reader |
|---|---|---|---|
| **HST** (internal) | Module-level array (`xj1` in cli.js) | `WR()` — called by task completion handlers | React `useEffect` via `up7()` — **only runs in interactive mode** |
| **queuedCommands** | Zustand-like state store | `lB()` — the general enqueue function | `Z_6()` — called by the headless streaming loop |

When a background task completes, the CLI calls `WR({value: xml, mode:
"task-notification"})` which pushes to **HST** (the internal array). However,
the headless streaming loop only reads from **queuedCommands** (the state
store) via `Z_6()`.

In interactive mode, a React `useEffect` with `useSyncExternalStore` polls HST
and processes items. In headless/SDK mode, there is no React rendering, so this
bridge never runs. The notification sits in HST forever.

### The streaming loop (pseudocode)

```
do {
    command = dequeueFromQueuedCommands()   // Z_6() — never checks HST
    if (command) processCommand(command)

    hasRunningTasks = checkRunningTasks()
    hasQueuedCommands = queuedCommands.length > 0

    if (hasRunningTasks || hasQueuedCommands) {
        keepLooping = true
        if (!hasQueuedCommands) sleep(100ms)  // poll
    }
} while (keepLooping)
```

The loop correctly detects running tasks and keeps polling. But when the task
finishes, `WR()` pushes the notification to HST (not queuedCommands), the task
status changes to completed, `hasRunningTasks` becomes false, and the loop
exits — without ever seeing the notification.

### Message flow diagram

```
Task completes
    │
    ▼
WR({value: xml, mode: "task-notification"})
    │
    ▼
HST (xj1) array ◄──── pushed here
    │
    ╳  ◄──── no bridge in headless mode
    │
    │   React useEffect (interactive only)
    │       │
    │       ▼
    │   up7() dequeues from HST
    │       │
    │       ▼
    │   processes notification ✓
    │
    ▼
queuedCommands ◄──── never receives the notification
    │
    ▼
Z_6() ◄──── reads here, finds nothing
    │
    ▼
Notification lost ✗
```

## The Fix

Patch `Z_6()` (the dequeue function for queuedCommands) to first drain HST
into queuedCommands before checking if queuedCommands is empty.

### Before

```js
async function Z_6(A,q) {
    if ((await A()).queuedCommands.length === 0) return;
    // ... dequeue from queuedCommands
}
```

### After

```js
async function Z_6(A,q) {
    // PATCH: drain HST into queuedCommands for headless mode
    while (Ip7()) {
        let _h = up7();
        if (_h) q((z) => ({...z, queuedCommands: [...z.queuedCommands, _h]}));
    }
    if ((await A()).queuedCommands.length === 0) return;
    // ... dequeue from queuedCommands
}
```

This is safe because:

- `Ip7()` / `up7()` are the existing HST check/dequeue functions used by the
  React bridge — we're just calling them from a second location
- In interactive mode, the React `useEffect` drains HST before `Z_6` runs, so
  `Ip7()` returns false and the patch is a no-op
- In headless mode, this is the only consumer, so there's no race condition
- The notification flows through the existing `task-notification` processing
  path in the streaming loop, which already handles XML parsing, state updates,
  and enqueueing the `{type:"system", subtype:"task_notification"}` message

## Applying the Patch

```bash
node patch/task-notification/apply.mjs
```

The script locates the equivalent functions by **content pattern** rather than
minified names, since function names change between versions. It will:

1. Find `cli.js` in the SDK package
2. Locate the dequeue function (`Z_6` equivalent) by its unique code pattern
3. Locate the HST-check and HST-dequeue functions (`Ip7`/`up7` equivalents)
4. Inject the drain logic
5. Verify the patch was applied correctly

### Re-applying after SDK updates

After running `bun install` or updating `@anthropic-ai/claude-agent-sdk`, the
patch needs to be re-applied since `cli.js` will be replaced. Run:

```bash
node patch/task-notification/apply.mjs
```

The script is idempotent — it detects if the patch is already applied and skips
it. Consider adding it as a `postinstall` script in `package.json`:

```json
{
  "scripts": {
    "postinstall": "node patch/task-notification/apply.mjs"
  }
}
```

### When the patch breaks

If a future SDK version changes the code structure enough that the pattern
matching fails, the script will exit with an error explaining what it couldn't
find. In that case:

1. Extract and inspect the new `cli.js` to find the equivalent functions
2. Update the patterns in `apply.mjs`
3. The core bug may also be fixed upstream — check if task notifications work
   without the patch before updating

## Verification

After patching, launch a session and trigger a background task (e.g., ask the
model to use the `Task` tool). You should see in the console:

```
[SDK msg] type=system subkeys=[type,subtype,task_id,status,output_file,summary,session_id,uuid]
```

This confirms the `{type:"system", subtype:"task_notification"}` message is now
flowing through the SDK stream.

## Files

| File | Purpose |
|---|---|
| `README.md` | This document |
| `apply.mjs` | Patch script — run after install or SDK update |

## Broader Audit

After applying the patch, we audited the entire CLI and SDK codebase for similar
issues — anywhere events, messages, or state changes could be silently lost in
headless/SDK mode.

### 1. HST is the only affected queue

`xj1` (HST) is the **only** module-level notification queue with the
push-and-notify pattern. There are no other "shadow queues" that bypass the
headless streaming loop. All 5 `WR()` call sites push `task-notification`
messages to HST, and our single `Z_6()` patch covers all of them:

| Call site | What triggers it |
|---|---|
| Local agent session completed | `Od7()` → `ov9()` → `WR()` |
| Local agent session failed | `Od7()` → `ov9()` → `WR()` |
| Background bash command completed/failed | `HB1()` → `WR()` |
| Remote agent completed | Remote task handler → `WR()` |
| Agent idle notification | Idle detection → `WR()` |

### 2. SDK Session API stops at first result

**Severity: Medium (affects other SDK consumers, not us)**

The SDK's Session API (`createSession()` + `session.stream()`) contains:

```js
async* stream() {
    while (true) {
        let { value, done } = await this.queryIterator.next();
        if (done) return;
        if (yield value, value.type === "result") return;  // ← exits here!
    }
}
```

This exits the generator after the **first** `result` message. Even with our
CLI patch, anyone using the Session API would miss post-result task
notifications because the iterator stops before they arrive.

Our code uses `query()` which returns the `QX` iterator directly — it yields
indefinitely until the CLI process exits, so this does not affect us. But it is
a limitation for other SDK consumers who might use the Session API for
multi-turn conversations with background tasks.

### 3. `lB()` contains an incomplete upstream fix attempt

The newer CLI (2.1.38) has a partial fix in `lB()` (the general enqueue
function):

```js
function lB(A, q) {
    if (A.mode === "task-notification" && W_6.size > 0)
        WR(A);    // route to HST when interactive listeners exist
    else
        q((K) => ({...K, queuedCommands: [...K.queuedCommands, A]}));
    // ...
}
```

This routes `task-notification` to HST when listeners exist (interactive mode),
and to `queuedCommands` otherwise (headless mode). This would be correct — if
the task completion handlers actually called `lB()`. But they all call `WR()`
directly, bypassing `lB()` entirely. The `lB()` routing code is dead code for
actual task notifications — it only triggers if something else calls `lB()` with
`mode: "task-notification"`, which never happens in practice.

### 4. Task completion ordering is safe (no race conditions)

The completion flow for a local agent is:

```
1. c5() sets task.status = "completed"    (synchronous state update)
2. ov9() builds XML notification
3. WR() pushes to HST                      (synchronous)
4. c5() sets task.notified = true           (synchronous state update)
```

All four steps execute synchronously in the same microtask. The `do-while` loop
polls asynchronously (100ms intervals via `await setTimeout`), so by the time it
checks again:
- The task status is already `"completed"` → `hasRunningTasks` = false
- The HST already contains the notification → our patch drains it

There is no window where the task is completed but the notification hasn't been
pushed yet.

### 5. Output stream flushing is correct

The output stream `P` (an `xU1` async queue) is what the outer loop reads to
write messages to stdout. `P.done()` is called only after:

1. The `do-while` loop exits (all tasks done, all commands processed)
2. Post-loop team/teammate message handling completes
3. Stdin is closed and no active teammates remain

Our task notification is enqueued to `P` during step 1 (inside the `do-while`
loop, via the `task-notification` processing path in `yT()`). Since `P.done()`
comes after step 1, the notification is guaranteed to be in `P`'s queue before
the stream ends. No messages are lost during flushing.

### 6. `tool_progress` messages flow correctly

`tool_progress` messages (elapsed time updates for running tools) are yielded
from the main query generator and flow through `P.enqueue()` in the streaming
loop. They are not affected by the HST/queuedCommands split.

### 7. No direct stdout writes bypass the queue

The CLI does not write JSON messages directly to `process.stdout` outside of the
output queue system. All structured messages go through `P.enqueue()` → outer
`for-await` loop → `O.write()` (transport).

### Conclusion

The single `Z_6()` patch is sufficient. No additional patches are needed. The
only other concern (Session API stopping at first result) is an SDK-side design
choice that doesn't affect our `query()`-based usage.

---

## Discovery Method

The bug was found by reverse-engineering the Claude Code source:

1. Extracted `claude.js` from the native binary using the Bun section extraction
   technique (Mach-O `__BUN/__bun` section)
2. Traced the task notification flow from completion handler → `WR()`/`iN()` →
   HST array
3. Traced the headless streaming loop → `Z_6()`/`dWR()` → queuedCommands store
4. Identified the missing bridge between the two queues in headless mode
5. Confirmed by examining the React `useEffect` that only runs in interactive
   mode (`useSyncExternalStore` on HST, calling `up7()`/`Gx_()`)
6. Verified the SDK's bundled `cli.js` has the same bug with different minified
   names
7. Audited all `WR()` call sites, `lB()` routing logic, output queue flushing,
   `tool_progress` paths, and direct stdout writes to confirm no other messages
   are lost in headless mode

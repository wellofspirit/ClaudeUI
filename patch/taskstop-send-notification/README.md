# Patch: taskstop-send-notification

Fixes TaskStop to actually send task_notification messages when tasks are stopped.

## Affected Component

`@anthropic-ai/claude-agent-sdk` — specifically the bundled `cli.js` file.

| Component | Version at time of discovery |
|---|---|
| SDK package | 0.2.39 |
| Bundled CLI (`cli.js`) | 2.1.39 |

## The Problem

**User-visible symptom:** When you stop a background task via the TaskStop tool, the task is killed but the UI never updates. The task appears stuck in "running" state forever with a spinning indicator.

**Why it matters:**
- User doesn't know if the stop command worked
- Task remains visible as "running" cluttering the task list
- LLM doesn't receive notification that the task stopped (may re-check or get confused)
- UI stop button shows "Stopping..." indefinitely

## Architecture Overview

### Normal Task Completion Flow

```
Background task finishes
    │
    ▼
Completion handler (bash/agent-specific)
    │
    ▼
NB1(taskId, cwd, status, summary, setState)  ← Sends notification
    │
    ├─ Checks if already notified (skip if yes)
    ├─ Sets notified: true in state
    └─ Generates <task-notification> XML
    │
    ▼
WR() → enqueues to HST
    │
    ▼
Bridges to queuedCommands (via task-notification patch)
    │
    ▼
Streaming loop yields notification
    │
    ▼
SDK consumer receives: {type: "system", subtype: "task_notification", status: "completed"}
```

### TaskStop Flow (BEFORE PATCH)

```
User clicks stop button
    │
    ▼
TaskStop.call({task_id: "abc123"})
    │
    ├─ Validates task exists and is running
    ├─ Calls O.kill(taskId, {...}) ← Actually stops the task ✓
    ├─ Sets notified: true in state ✓
    │
    ❌ NO NOTIFICATION SENT ← BUG
    │
    └─ Returns success message to LLM
    │
    ▼
Task is stopped but nobody knows
```

**The problem:** TaskStop sets the `notified` flag but never calls NB1() to actually send the notification. The flag is set to prevent duplicate notifications, but there's no original notification to duplicate!

## Root Cause

### Location in cli.js

**Tool:** TaskStop (class name varies, e.g., `BW6`)
**Method:** `async call({task_id, shell_id}, {getAppState, setAppState, abortController})`
**Anchor:** Unique string `"Successfully stopped task:"` in return message
**Approximate offset:** ~8,400,000 chars (in version 2.1.39)

### The Missing Call

```javascript
// TaskStop.call() method (BEFORE PATCH)
async call({task_id:A,shell_id:q},{getAppState:K,setAppState:Y,abortController:z}){
  let w=A??q;  // Resolve task ID

  // ... validation: task exists, is running, etc ...

  let $=(await K()).tasks?.[w];  // Fetch task object
  let O=uQ1($.type);  // Get task type handler

  await O.kill(w,{abortController:z,getAppState:K,setAppState:Y}),  // ✓ Kill task

  // ❌ MISSING: NB1(w, $.cwd||"", "killed", void 0, Y),

  Y((J)=>{  // ✓ Set notified flag
    let X=J.tasks[w];
    if(!X||X.notified)return J;
    return{...J,tasks:{...J.tasks,[w]:{...X,notified:!0}}}
  });

  let _=sB($)?$.command:$.description;
  return{data:{message:`Successfully stopped task: ${w} (${_})`,...}}
}
```

**Key observation:** The code sets `notified: true` to prevent duplicate notifications, but it never sends the first notification! This is likely a copy-paste error from the bash completion handler (which DOES call NB1 before setting the flag).

### Comparison: Bash Task Completion (CORRECT)

```javascript
// Bash task completion handler (DOES send notification)
async function onBashComplete(taskId, exitCode, output) {
  // ...

  NB1(taskId, cwd, status, void 0, setState),  // ✓ Send notification first

  setState((state) => {  // ✓ Then set notified flag
    let task = state.tasks[taskId];
    if (!task || task.notified) return state;
    return {...state, tasks: {...state.tasks, [taskId]: {...task, notified: true}}};
  });

  // ...
}
```

**Correct pattern:**
1. Send notification via NB1()
2. Set `notified: true` to prevent duplicates
3. Return

**TaskStop's broken pattern:**
1. ~~Send notification~~ SKIP THIS STEP
2. Set `notified: true` anyway
3. Return

## The Patch

### What We Change

**Before:**
```javascript
await O.kill(w,{...}),
Y((J)=>{let X=J.tasks[w];if(!X||X.notified)return J;return{...J,tasks:{...J.tasks,[w]:{...X,notified:!0}}}});
let _=sB($)?$.command:$.description;
```

**After:**
```javascript
await O.kill(w,{...}),
/*PATCHED:taskstop-send-notification*/NB1(w,$.cwd||"","killed",void 0,Y),  // ✅ Send notification
Y((J)=>{let X=J.tasks[w];if(!X||X.notified)return J;return{...J,tasks:{...J.tasks,[w]:{...X,notified:!0}}}});
let _=sB($)?$.command:$.description;
```

### What It Does

Inserts a call to `NB1()` (the notification sender) BEFORE the `notified` flag is set.

**Arguments to NB1:**
1. `w` — task ID variable
2. `$.cwd||""` — working directory from task object (or empty string)
3. `"killed"` — status (matches CLI behavior)
4. `void 0` — summary (undefined, NB1 will generate default)
5. `Y` — setAppState function (NB1 uses this to set notified flag)

Wait, doesn't NB1 also set the notified flag? Yes! So we end up calling the setState twice:
1. NB1 sets `notified: true`
2. TaskStop's original code also sets `notified: true`

This is safe because both are checking `if (!task || task.notified) return state` — the second call becomes a no-op.

### Why "killed" Not "stopped"?

The CLI uses `"killed"` as the internal task status:

```bash
# From CLI session logs
{"content":"<task-notification>...<status>killed</status>..."}
```

The notification generator (NB1) passes the status directly to the XML builder. Using `"killed"` keeps us consistent with the CLI.

However, the task_notification schema only allows `["completed", "failed", "stopped"]`. That's why we need the companion patch `task-notification-killed-mapping` which maps `"killed"` → `"stopped"` during XML parsing.

**Flow:**
1. TaskStop calls: `NB1(..., "killed", ...)`
2. NB1 generates: `<status>killed</status>`
3. XML parser maps: `"killed"` → `"stopped"`
4. SDK consumer receives: `{status: "stopped"}`

### Why It's Safe

**Doesn't break existing behavior:**
- Natural completions: still call NB1 ✓
- Failed tasks: still call NB1 ✓
- TaskStop now calls NB1 like the others ✓

**Duplicate notification prevention:**
- NB1 checks `notified` flag before sending
- If task is already notified, NB1 returns early
- The subsequent setState is a no-op (safe redundancy)

**CLI consistency:**
- Status is `"killed"` (matches CLI)
- Summary generation matches CLI behavior
- LLM receives notification just like in CLI mode

**No race conditions:**
- setState is synchronous (Zustand-like)
- Notified flag prevents duplicate notifications
- Notification is sent before task cleanup

### How to Find This Code in a New Version

This is a multi-step process since we need to find several pieces:

#### Step 1: Find TaskStop's call method

**Anchor:** The unique return message

```bash
grep -o '.{0,500}Successfully stopped task:.{0,100}' cli.js
```

This should return the TaskStop call method. Look backwards from "Successfully stopped task:" for the function start.

#### Step 2: Find the notification sender function

**Pattern:** Look for a function containing `"was stopped"` string

```bash
node << 'EOF'
const fs = require('fs');
const src = fs.readFileSync('node_modules/@anthropic-ai/claude-agent-sdk/cli.js', 'utf8');
const pattern = 'was stopped';
let idx = src.indexOf(pattern);
// Show context around each match
while (idx !== -1) {
  const start = Math.max(0, idx - 300);
  const end = Math.min(src.length, idx + 100);
  const context = src.slice(start, end);
  if (context.match(/function\s+\w+\([^)]*\)\{/)) {
    console.log('Found at offset:', idx);
    console.log(context);
  }
  idx = src.indexOf(pattern, idx + 1);
}
EOF
```

The notification sender has this structure:

```javascript
function NAME(taskId, cwd, status, summary, setState) {
  // Check if already notified
  let alreadyNotified = false;
  if (updateState(taskId, setState, (task) => {
    if (task.notified) return task;
    alreadyNotified = true;
    return {...task, notified: true};
  }), !alreadyNotified) return;

  // Build summary message
  let summaryText = status === "completed"
    ? `completed...`
    : status === "failed"
    ? `failed...`
    : "was stopped";  // ← Unique string

  // Generate XML and enqueue
  WR({value: `<task-notification>...</task-notification>`, mode: "task-notification"});
}
```

#### Step 3: Find the notified setter in TaskStop

**Pattern:** Look for the setState call that sets `notified: true`

```javascript
// This pattern is unique to TaskStop's notified setter
SET_STATE_FN((STATE_VAR) => {
  let TASK_VAR = STATE_VAR.tasks[TASK_ID_VAR];
  if (!TASK_VAR || TASK_VAR.notified) return STATE_VAR;
  return {
    ...STATE_VAR,
    tasks: {
      ...STATE_VAR.tasks,
      [TASK_ID_VAR]: {...TASK_VAR, notified: true}
    }
  };
})
```

**Regex pattern:**
```javascript
/([\w$]+)\(\(([\w$]+)\)=>\{let ([\w$]+)=\2\.tasks\[([\w$]+)\];if\(!\3\|\|\3\.notified\)return \2;return\{\.\.\.\ 2,tasks:\{\.\.\.\ 2\.tasks,\[\4\]:\{\.\.\.\ 3,notified:!0\}\}\}\}\)/
```

**Important pitfalls:**
- Spread operator is 3 dots `...` not 4
- Optional chaining is `?.` not `?..`
- Need proper comma between spread and property
- Must have 4 closing braces (3 for nested objects + 1 for arrow function)

#### Step 4: Find the task object variable

**Pattern:** Look for where the task is retrieved from state

```javascript
let TASK_VAR = (await GET_STATE_FN()).tasks?.[TASK_ID_VAR];
```

This variable (`$` in version 2.1.39) contains the task object with `.cwd`, `.command`, etc.

**Regex pattern:**
```javascript
/let ([\w$]+)=\(await [^)]+\(\)\)\.tasks\?\.\[(TASK_ID_VAR)\];/
```

Replace `TASK_ID_VAR` with the actual variable name found in step 3.

#### Step 5: Build the injection

Now you have:
- **Notification sender name** (e.g., `NB1`)
- **Task ID variable** (e.g., `w`)
- **Task object variable** (e.g., `$`)
- **setState variable** (e.g., `Y`)
- **Injection point** (comma before the notified setter)

Inject:
```javascript
NOTIFY_FN(TASK_ID_VAR, TASK_OBJ_VAR.cwd||"", "killed", void 0, SET_STATE_VAR),
```

## What's NOT Changed

**We do NOT patch:**

1. **The notified flag logic** — TaskStop still sets it (becomes redundant but safe)
2. **The kill operation** — `O.kill()` unchanged (correct behavior)
3. **Other tools** — TaskCancel, TaskOutput, etc. don't need notifications
4. **NB1 function** — no changes to the notification sender itself

**Why keep the redundant notified setter?**

NB1 already sets `notified: true`, so TaskStop's subsequent setState is redundant. However:
- Removing it would make the patch larger (riskier)
- The redundant call is a safe no-op (check-if-notified prevents duplicates)
- Keeps the patch minimal (insertion-only, no deletion)

**Why not patch TaskCancel?**

TaskCancel is different from TaskStop:
- TaskStop: user manually stopped the task → should notify
- TaskCancel: LLM decided to cancel (e.g., due to error) → notification happens via the error flow

## Discovery Method

### 1. Observed Missing Notifications

After applying `task-notification` patch (which bridges HST to queuedCommands):
- ✅ Natural task completions received notifications
- ✅ Failed tasks received notifications
- ❌ Stopped tasks: task died but no notification

### 2. Added Debug Logging

Instrumented the HST enqueue function:

```javascript
// In WR() or similar
console.error('[DEBUG-HST] Enqueuing:', JSON.stringify({mode: A.mode, taskId: extractTaskId(A.value)}));
```

**Result:** Logs appeared for completed/failed tasks, but NOT for stopped tasks.

### 3. Found TaskStop Implementation

Searched for the stop button handler:

```bash
grep -A 50 "Successfully stopped task:" cli.js
```

Found TaskStop sets `notified: true` but never calls the notification sender.

### 4. Compared to Working Code

Checked bash task completion handler:

```bash
bundle-analyzer find cli.js "was stopped"
```

Found multiple functions with "was stopped":
- `NB1()` — bash task notification sender (has the string)
- `BK1()` — agent task notification sender (has the string)
- `HMY()` — teammate notification sender (has the string)

All of them build a summary message that includes "was stopped" for killed status.

### 5. Verified CLI Behavior

Checked CLI session logs for stopped tasks:

```bash
grep -B 5 -A 10 "was stopped" ~/.claude/projects/*/session-*.jsonl
```

Found the CLI DOES send notifications with `<status>killed</status>`.

### 6. Built the Regex Pattern

The hardest part was building a pattern that:
1. Finds the notified setter uniquely
2. Extracts all variable names dynamically
3. Handles optional chaining, spread operators, backreferences

**Key learnings:**
- Use `[\w$]+` not `\w+` (variable names can contain `$`)
- Spread operator: `\.\.\.` (3 escaped dots)
- Optional chaining: `\?\.` (not `\?..`)
- Backreferences: `\\2` (not `\\.2`)
- Count braces carefully (4 closing braces for arrow function body)

### 7. Found Task Object Variable

Realized `$` is not a function parameter but a local variable:

```javascript
let $ = (await K()).tasks?.[w];  // Fetch task from state
```

Had to search for this pattern separately to find where `$.cwd` comes from.

## Verification

### After Applying Patch

1. **Start a background bash command:**
   ```
   "Run `sleep 30` in the background"
   ```

2. **Wait for task to start** (spinner appears in UI)

3. **Stop the task** via UI stop button

4. **Check task status:**
   - ✅ Spinner stops immediately
   - ✅ Orange "stopped" badge appears
   - ✅ Task detail shows `<span class="bg-warning/10 text-warning">stopped</span>`

### Console Output (with debug logging)

```
[TaskStop] Received stop request for task: bash_abc123
[TaskStop] Calling O.kill() to terminate process
[TaskStop] ✅ Process killed
[TaskStop] Calling NB1() to send notification
[NB1] Generating XML: <task-notification><task-id>bash_abc123</task-id><status>killed</status>...
[NB1] Enqueueing to HST
[HST→queuedCommands] Bridged notification
[DXz] Yielding: {type: "system", subtype: "task_notification", status: "stopped"}
[ClaudeUI] Received task_notification for bash_abc123
[UI] Updating task status to "stopped"
```

### CLI Comparison

Both CLI and our SDK should produce identical notification XML:

**CLI:**
```json
{"type":"user","message":{"content":"<task-notification>\n<task-id>bash_abc123</task-id>\n<status>killed</status>\n<summary>Background command \"sleep 30\" was stopped</summary>\n</task-notification>"}}
```

**Our SDK (after patch):**
```json
// Internal XML (same as CLI)
"<task-notification><task-id>bash_abc123</task-id><status>killed</status><summary>Background command \"sleep 30\" was stopped</summary></task-notification>"

// After parsing (mapped)
{"type":"system","subtype":"task_notification","taskId":"bash_abc123","status":"stopped","summary":"Background command \"sleep 30\" was stopped"}
```

## Key Functions Reference

| Name (v2.1.39) | Purpose | Approx Offset |
|---|---|---|
| `BW6` | TaskStop tool class | ~8,350,000 |
| `NB1()` | Notification sender (bash) | ~5,286,000 |
| `BK1()` | Notification sender (agents) | ~5,279,000 |
| `WR()` | HST enqueue function | ~5,250,000 |
| `uQ1()` | Task type handler getter | ~8,380,000 |
| `sB()` | Check if bash task | ~8,370,000 |

**Note:** These names WILL change. Use the search patterns above to relocate them.

## Related Patches

This patch is part of a three-patch system:

### 1. task-notification (REQUIRED)
Bridges HST → queuedCommands so notifications reach SDK consumers.

Without this, the notification would be enqueued to HST but never delivered.

### 2. taskstop-send-notification (THIS PATCH)
Makes TaskStop call NB1() to send the notification.

Without this, no notification is sent at all.

### 3. task-notification-killed-mapping (REQUIRED)
Maps `"killed"` → `"stopped"` during XML parsing.

Without this, stopped tasks would show as "completed" (wrong status).

## Benefits

- **UI updates correctly** — stopped tasks show orange "stopped" badge
- **LLM awareness** — agent knows the task was stopped, can adjust behavior
- **CLI consistency** — behavior matches native Claude Code exactly
- **Proper state management** — uses the same NB1 flow as natural completions
- **Fast execution** — notification sent immediately after kill
- **No polling needed** — event-driven notification delivery

# Patch: task-notification-killed-mapping

Maps the internal `"killed"` status to schema-valid `"stopped"` during task_notification XML parsing.

## Affected Component

`@anthropic-ai/claude-agent-sdk` — specifically the bundled `cli.js` file.

| Component | Version at time of discovery |
|---|---|
| SDK package | 0.2.39 |
| Bundled CLI (`cli.js`) | 2.1.39 |

## The Problem

**User-visible symptom:** When a background task is stopped via TaskStop, the UI shows it as "completed" (green badge) instead of "stopped" (orange badge).

**Why it matters:**
- User can't distinguish between naturally-completed tasks and user-stopped tasks
- Misleading status makes it appear the task finished its work when it was actually interrupted
- LLM may not realize the task was stopped if the status is wrong

## Architecture Overview

### Task Notification Flow

```
TaskStop tool
    │
    ▼
NB1(taskId, cwd, status, summary, setState)  ← status = "killed" (internal)
    │
    ▼
Generates XML:
  <task-notification>
    <status>killed</status>     ← internal representation
    ...
  </task-notification>
    │
    ▼
Enqueues to HST → bridges to queuedCommands → streaming loop
    │
    ▼
DXz() reads from structuredInput
    │
    ▼
mode === "task-notification" → parse XML
    │
    ├─ Extract: <status>killed</status>
    ├─ Validate: is "killed" valid? ← BUG: defaults to "completed"
    └─ Result: {type: "system", subtype: "task_notification", status: ???}
    │
    ▼
SDK consumer (ClaudeUI) receives notification
```

### The Validation Gap

**Internal task states** (used by task system):
- `"running"` — task is executing
- `"completed"` — finished successfully
- `"failed"` — error occurred
- `"killed"` — stopped by user/system

**task_notification schema** (Zod validation):
```typescript
status: z.enum(["completed", "failed", "stopped"])
```

Notice: `"killed"` is NOT in the schema! The CLI uses `"killed"` internally but the schema expects `"stopped"`.

## Root Cause

### Location in cli.js

**Function:** Main query loop (DXz or similar name)
**Context:** `for await(let W1 of A.structuredInput)` loop
**Trigger:** When `W1.mode === "task-notification"`
**Approximate offset:** ~10,825,000 chars (in version 2.1.39)

### The Validation Code

```javascript
// Inside the task-notification handler
let Y1 = typeof D1.value === "string" ? D1.value : "",  // XML string
    X1 = Y1.match(/<status>([^<]+)<\/status>/),         // Extract status

    // VALIDATOR: checks if status is valid
    y1 = (R1) => R1==="completed"||R1==="failed"||R1==="stopped",  // ❌ "killed" not listed

    x1 = X1?.[1],  // Extracted value: "killed"

    // MAPPING: if valid use as-is, else default to "completed"
    G1 = y1(x1) ? x1 : "completed";  // ❌ "killed" → "completed" (wrong!)
```

**What happens:**
1. Extract status from XML: `x1 = "killed"`
2. Validate: `y1("killed")` returns `false` (not in allowed list)
3. Map: Since validation failed, default to `"completed"`
4. SDK consumer receives: `{status: "completed"}` instead of `"stopped"`

### Why CLI Uses "killed"

The CLI's task state machine uses `"killed"` as the status when a task is terminated:

```bash
# From CLI session logs (~/.claude/projects/.../session-*.jsonl)
{"type":"user","message":{"content":"<task-notification>...<status>killed</status>..."}}
```

The notification generator (NB1 function) builds the XML directly from the task state, which has `status: "killed"`.

## The Patch

### What We Change

**Before:**
```javascript
y1=(R1)=>R1==="completed"||R1==="failed"||R1==="stopped",
x1=X1?.[1],
G1=y1(x1)?x1:"completed";
```

**After:**
```javascript
/*PATCHED:task-notification-killed-mapping*/
y1=(R1)=>R1==="completed"||R1==="failed"||R1==="stopped"||R1==="killed",  // ✅ Accept "killed"
x1=X1?.[1],
G1=y1(x1)?(x1==="killed"?"stopped":x1):"completed";  // ✅ Map killed→stopped
```

### What It Does

1. **Extend validator**: Accept `"killed"` as a valid status (don't default to "completed")
2. **Add mapping**: When status is `"killed"`, map it to `"stopped"` (schema-compliant value)
3. **Preserve others**: `"completed"` and `"failed"` pass through unchanged

### Why It's Safe

**Doesn't break existing behavior:**
- Completed tasks: `"completed"` → still `"completed"` ✓
- Failed tasks: `"failed"` → still `"failed"` ✓
- Unknown statuses: still default to `"completed"` ✓

**CLI consistency:**
- Internal state uses `"killed"` (matches CLI)
- External API uses `"stopped"` (matches schema)
- The mapping is transparent to both sides

**No side effects:**
- Validation happens during XML parsing only
- Doesn't affect task state, transcript recording, or other systems
- The `"killed"` value never reaches SDK consumers (it's mapped)

### How to Find This Code in a New Version

#### Pattern 1: Search by XML tag

```bash
grep -o '.{0,200}<status>.{0,200}' cli.js | grep 'completed.*failed.*stopped'
```

Look for a line that:
- Extracts `<status>` from XML
- Has a validator checking `==="completed"||...==="failed"||...==="stopped"`
- Has a ternary that defaults to `"completed"`

#### Pattern 2: Search by structure

The validation always follows this structure:

```javascript
VALIDATOR_FN = (PARAM) => PARAM==="completed"||PARAM==="failed"||PARAM==="stopped",
EXTRACTED_VAR = XML_MATCH?.[1],
VALIDATED_VAR = VALIDATOR_FN(EXTRACTED_VAR) ? EXTRACTED_VAR : "completed";
```

#### Pattern 3: Use bundle-analyzer

```bash
bundle-analyzer find cli.js "task-notification"
```

Then search nearby for the status extraction pattern.

#### Pattern 4: Find by context

Search for the task-notification message builder (around offset 10,825,000):

```bash
# Find the enqueue call with task_notification
grep -A 50 'mode:"task-notification"' cli.js
```

The validator is typically within 500 chars before the enqueue.

## What's NOT Changed

**We do NOT patch:**

1. **The NB1 function** — still sends `"killed"` in XML (correct, matches CLI)
2. **Task state machine** — still uses `"killed"` internally (correct)
3. **The Zod schema** — still only accepts `["completed", "failed", "stopped"]` (external API)

**Why not add "killed" to the schema?**

The schema is part of the SDK's public API contract. Changing it would be a breaking change for all SDK consumers. It's safer to map internally.

## Discovery Method

### 1. Observed the Wrong Status

After implementing `taskstop-send-notification` patch:
- ✅ TaskStop sent notification
- ✅ UI received notification
- ❌ Status showed "completed" instead of "stopped"

### 2. Checked What Was Sent

Added debug logging in NB1:
```javascript
console.error('[DEBUG] NB1 sending status:', K);  // "killed"
```

Confirmed NB1 was sending `"killed"` (correct).

### 3. Checked What Was Received

Added debug logging in ClaudeUI:
```javascript
console.error('[DEBUG] Received status:', msg.status);  // "completed" (wrong!)
```

So the status was changing between send and receive.

### 4. Found the XML Parser

Searched for where task-notification XML is parsed:

```bash
node << 'EOF'
const fs = require('fs');
const src = fs.readFileSync('node_modules/@anthropic-ai/claude-agent-sdk/cli.js', 'utf8');
const idx = src.indexOf('task-notification');
console.log('Found at offset:', idx);
console.log('Context:', src.slice(idx - 200, idx + 500));
EOF
```

Found the validation code at offset ~10,825,300.

### 5. Verified CLI Behavior

Checked actual CLI session logs:

```bash
grep -A 10 'task-notification' ~/.claude/projects/*/session-*.jsonl | grep status
```

Result:
```xml
<status>killed</status>
```

Confirmed CLI uses `"killed"`, not `"stopped"`.

### 6. Built the Regex Pattern

Tested patterns until finding one that uniquely matches:

```javascript
const pattern = /([a-zA-Z$_][\w$]*)=\(([a-zA-Z$_][\w$]*)\)=>\2==="completed"\|\|\2==="failed"\|\|\2==="stopped",([a-zA-Z$_][\w$]*)=([a-zA-Z$_][\w$]*)\?\.\[1\],([a-zA-Z$_][\w$]*)=\1\(\3\)\?\3:"completed";/;
```

Verified: exactly 1 match in cli.js ✓

## Verification

### After Applying Patch

1. **Start a background task** (e.g., bash command that runs for 10+ seconds)
2. **Stop it** via the UI stop button
3. **Check the task status badge**

**Expected:**
```
Status: stopped (orange badge with bg-warning/10)
```

**Without patch:**
```
Status: completed (green badge with bg-success/10)
```

### Console Output

With debug logging enabled:

```
[TaskStop] Calling NB1 with status: "killed"
[NB1] Generating XML: <status>killed</status>
[DXz] Extracted status from XML: "killed"
[DXz] Validated status: "stopped" (mapped)
[ClaudeUI] Received notification: {status: "stopped", ...}
[UI] Displaying orange "stopped" badge
```

### CLI Comparison

Both should produce the same internal representation:

**CLI:**
```json
{"type":"user","message":{"content":"<task-notification>...<status>killed</status>..."}}
```

**Our SDK (internal):**
```xml
<status>killed</status>
```

**Our SDK (after parsing):**
```json
{"type":"system","subtype":"task_notification","status":"stopped",...}
```

## Key Functions Reference

| Name (v2.1.39) | Purpose | Approx Offset |
|---|---|---|
| `DXz()` | Main streaming query loop | ~10,800,000 |
| `NB1()` | Task notification sender (bash tasks) | ~5,280,000 |
| `BK1()` | Task notification sender (agent tasks) | ~5,275,000 |

**Note:** These names WILL change in future versions. Use the patterns above to relocate them.

## Related Patches

This patch is part of a three-patch system:

### 1. task-notification (REQUIRED)
Bridges HST → queuedCommands so notifications flow in headless mode.

Without this, no task notifications reach SDK consumers at all.

### 2. taskstop-send-notification (REQUIRED)
Makes TaskStop actually call NB1() to send the notification with `status: "killed"`.

Without this, stopped tasks never send notifications (this patch would have nothing to map).

### 3. task-notification-killed-mapping (THIS PATCH)
Maps `"killed"` → `"stopped"` during XML parsing.

Without this, stopped tasks show as "completed" instead of "stopped".

## Benefits

- **CLI consistency** — internal status matches native CLI (`"killed"`)
- **Schema compliance** — external status is valid (`"stopped"`)
- **Clear UI** — stopped tasks show orange badge (distinct from completed)
- **Non-breaking** — completed/failed tasks unaffected
- **Future-proof** — if SDK adds "killed" to schema, mapping becomes a no-op

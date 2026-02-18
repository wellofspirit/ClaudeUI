# Patch: team-dowhile-fix

Fixes team messaging deadlock in headless/SDK mode where the team-lead
gets stuck in a do-while loop waiting for teammates to finish, but
teammates need the team-lead to respond to their inbox messages first.

## Affected Component

`@anthropic-ai/claude-agent-sdk` — bundled `cli.js` file.

| Component | Version at time of discovery |
|---|---|
| SDK package | 0.2.45 |
| Bundled CLI (`cli.js`) | 2.1.45 |

## The Problem

When running agent teams in ClaudeUI (or any SDK consumer in headless
mode), the team-lead spawns teammates successfully, but then the session
hangs. No teammate messages are ever processed. The team-lead sits idle
forever. Force-killing the app is the only way to stop the session.

The CLI's interactive mode works fine — it uses the `lGq` InboxPoller
React hook to poll the inbox independently. The bug is specific to
headless/print mode (`m3z`/`f6`), which is the path used by the SDK.

## Architecture Overview

### How teams work in headless mode

```
User prompt → f6() runs AI turn → result received
  │
  ▼
do-while loop: checks for running tasks + queued commands
  │
  ├── If running tasks or queued commands → loop with 100ms delay
  │     (waits for tasks to finish or new commands to appear)
  │
  └── When no more tasks/commands → exits
        │
        ▼
      Team polling: checks teamContext + cX (isTeamLead)
        │
        ├── If not team lead or no team → skip
        │
        └── If team lead → while(true) inbox polling loop:
              │
              ├── Check YK1() — any in_process_teammate running?
              ├── Check teammates in teamContext
              │     └── If neither → break (done)
              │
              ├── Read inbox: m56("team-lead", teamName)
              │     └── If unread messages:
              │           format as <teammate-message> XML
              │           By({mode:"prompt", value:xml}) → queue
              │           f6() → recurse
              │           return
              │
              └── sleep 500ms → loop
```

### How the do-while loop works

After each AI turn produces a `result`, `f6()` runs a do-while loop
that keeps the session alive while there are still running tasks:

```js
// Simplified from minified code. Real code at char ~10810380 in v2.1.45
do {
    await M6();          // dequeue + run any queued commands
    OP8(O);              // cleanup
    Y6 = false;          // assume loop should exit
    {
        let $6 = await H();                         // get appState
        let Z6 = eC8($6).some((L6) => jf(L6));      // any tasks running?
        let X6 = $6.queuedCommands.length > 0;      // any queued commands?
        if (Z6 || X6) {
            Y6 = true;                               // keep looping
            if (!X6) await new Promise(r => setTimeout(r, 100));  // poll delay
        }
    }
} while (Y6);

// Team polling code is HERE — only reachable when do-while exits
if ((await H()).queuedCommands.length > 0) { f6(); return; }
{
    let Y6 = (await H()).teamContext;
    if (Y6 && cX(Y6)) while (true) {
        // ... inbox polling loop ...
    }
}
```

### How the result-hold check works (for comparison)

Inside the `hDq` query loop, when a `result` is received, there's a
**separate, narrower** check that decides whether to hold or emit the result:

```js
// char ~10810370 in v2.1.45
if (L6.type === "result") {
    // ...
    let z1 = await H();
    if (eC8(z1).some((D1) => D1.type === "local_agent" && jf(D1)))
        P = L6;                    // hold result (don't emit yet)
    else
        P = null, G.enqueue(L6);   // emit result to SDK consumer
}
```

Note: this check filters by `type === "local_agent"`. The do-while check
does NOT.

### How tasks are tracked in appState

When the AI spawns agents via the Task tool:

- **Regular background tasks**: `appState.tasks[id] = { type: "local_agent", status: "running", ... }`
- **In-process teammates**: `appState.tasks[id] = { type: "in_process_teammate", status: "running", ... }`

Both types have `status: "running"` and are returned by `eC8()`.

### File-based mailbox system

Teammates communicate via JSON files:

```
~/.claude/teams/{team-name}/inboxes/{agent-name}.json
```

| Function | Purpose |
|---|---|
| `s5(recipient, msg, team)` | Write message to inbox (with file lock) |
| `ed(name, team)` | Read all messages from inbox |
| `m56(name, team)` | Read only unread messages (`!msg.read`) |
| `qQ6(name, team)` | Mark all messages as read |

## Root Cause

The do-while loop and the result-hold check use **different filters**:

```js
// Do-while condition — checks ALL running tasks (BROKEN for teams):
Z6 = eC8($6).some((L6) => jf(L6))
//                         ^^^^^^^^ no type filter!

// Result-hold check — correctly filters to local_agent only:
eC8(z1).some((D1) => D1.type === "local_agent" && jf(D1))
//                   ^^^^^^^^^^^^^^^^^^^^^^^^^^^ type filter!
```

When the team-lead's first AI turn spawns teammates:
1. Teammates are created as `{ type: "in_process_teammate", status: "running" }` in `appState.tasks`
2. `eC8()` returns them (since `status === "running"`)
3. `jf()` returns true for them (running + not `isBackgrounded: false`)
4. The do-while condition `Z6` is true
5. The loop continues with 100ms delays, forever

The team inbox polling code is AFTER the do-while loop, so it's never reached.

**Deadlock:**
- Do-while waits for teammates to finish
- Teammates wait for team-lead to read/respond to their inbox messages
- Team-lead can't read inbox because it's stuck in the do-while

### Key functions

```js
// eC8 — returns all running tasks from appState
// char ~8834262 in v2.1.45
function eC8(A) {
    let q = A.tasks ?? {};
    return Object.values(q).filter((K) => K.status === "running")
}

// jf — returns true if task is active and not explicitly non-backgrounded
// char ~9736031 in v2.1.45
function jf(A) {
    if (A.status !== "running" && A.status !== "pending") return false;
    if ("isBackgrounded" in A && A.isBackgrounded === false) return false;
    return true;
}

// YK1 — checks specifically for in_process_teammate (used in team polling)
// char ~8834100 (approx) in v2.1.45
function YK1(A) {
    for (let q of Object.values(A.tasks))
        if (q.type === "in_process_teammate" && q.status === "running") return true;
    return false;
}

// cX — checks if current agent is the team lead
function cX(A) {
    if (!A?.leadAgentId) return false;
    let q = V0();         // current agent's ID
    let K = A.leadAgentId;
    if (q === K) return true;
    if (!q) return true;   // no agentId = top-level = leader
    return false;
}
```

## Message Flow — Before Patching

```
f6() runs AI turn → result received
  │
  ▼
do-while loop:
  │
  ├── M6() dequeues commands → none queued → returns immediately
  │
  ├── eC8($6) returns:
  │     [
  │       { type: "in_process_teammate", status: "running", ... },  ← teammate 1
  │       { type: "in_process_teammate", status: "running", ... },  ← teammate 2
  │       { type: "in_process_teammate", status: "running", ... },  ← teammate 3
  │     ]
  │
  ├── jf() returns true for ALL of them (running, no isBackgrounded:false)
  │
  ├── Z6 = true → Y6 = true → sleep 100ms → loop
  │
  └── STUCK FOREVER — teammates never finish because team-lead never
      reads their inbox messages

      Team polling code below is UNREACHABLE:
      ┌──────────────────────────────────────┐
      │  let Y6 = (await H()).teamContext;   │
      │  if (Y6 && cX(Y6)) while(true) {    │
      │      // read inbox, process msgs     │  ← NEVER EXECUTED
      │  }                                   │
      └──────────────────────────────────────┘
```

## Message Flow — After Patching

```
f6() runs AI turn → result received
  │
  ▼
do-while loop:
  │
  ├── M6() dequeues commands → none queued → returns immediately
  │
  ├── eC8($6) returns:
  │     [
  │       { type: "in_process_teammate", status: "running", ... },  ← teammate 1
  │       { type: "in_process_teammate", status: "running", ... },  ← teammate 2
  │       { type: "in_process_teammate", status: "running", ... },  ← teammate 3
  │     ]
  │
  ├── PATCHED: jf() called with type filter:
  │     L6.type !== "in_process_teammate" && jf(L6)
  │     → false for ALL of them (filtered by type)
  │
  ├── Z6 = false, X6 = false → Y6 = false → EXIT LOOP ✓
  │
  ▼
Team polling:
  │
  ├── teamContext = { teamName: "...", leadAgentId: "team-lead@...", teammates: {...} }
  ├── cX(teamContext) = true (we are the team lead)
  │
  ▼
while(true) inbox polling:
  │
  ├── YK1($6) → true (in_process_teammates running)
  ├── teammates in teamContext → 3
  │
  ├── m56("team-lead", teamName) → read inbox
  │     └── If unread messages found:
  │           format as <teammate-message> XML
  │           By({mode:"prompt", value:xml}) → queue
  │           f6() → recurse (process next turn)
  │
  └── sleep 500ms → poll again
```

## The Patch

### Before

```js
Z6=eC8($6).some((L6)=>jf(L6)),X6=$6.queuedCommands
```

### After

```js
/*PATCHED:team-dowhile-fix*/Z6=eC8($6).some((L6)=>L6.type!=="in_process_teammate"&&jf(L6)),X6=$6.queuedCommands
```

The only change: `L6.type!=="in_process_teammate"&&` is prepended to
the `jf(L6)` call in the do-while condition. This excludes teammate
tasks from the loop, letting it exit to the team polling code.

### Why this is safe

- **Regular background tasks still work.** Tasks with `type: "local_agent"`
  still pass the filter and keep the do-while spinning until they complete.
  This is the correct behavior for non-team background tasks.

- **The result-hold check already uses a narrower filter.** The result is
  only held for `local_agent` tasks (not teammates), so the result is
  emitted correctly to the SDK consumer.

- **The team polling loop has its own task check.** Inside the `while(true)`
  inbox polling loop, `YK1()` checks specifically for
  `in_process_teammate` tasks. The team-lead correctly keeps polling until
  all teammates are done.

- **Teammate lifecycle is handled by the team polling code.** Teammates
  send shutdown approval messages when they're done. The team polling code
  reads these, removes teammates from the team file, and updates appState.
  When no more teammates are active, the polling loop breaks naturally.

- **The `isBackgrounded` flag on teammates is irrelevant.** Teammates
  may or may not have `isBackgrounded` set. The type filter is more
  precise and reliable than depending on `isBackgrounded` behavior.

### Why this bug exists

The do-while loop was likely designed for the `local_agent` case — regular
background tasks spawned via the Task tool (without `team_name`). These
tasks run independently and complete on their own. The do-while loop
waits for them to finish before proceeding.

In-process teammates (`team_name` parameter set) require a fundamentally
different pattern: the team-lead must actively read and respond to their
messages. The do-while loop was never updated to account for this
interactive pattern, creating the deadlock.

The CLI's interactive mode (React Ink UI) doesn't have this bug because
it uses the `lGq` InboxPoller hook, which runs independently of the query
loop on a 1-second timer.

## What's NOT Changed

**`eC8()` function** — We don't modify the function itself. It correctly
returns all running tasks. The filtering is done at the call site.

**`jf()` function** — We don't modify this either. Its logic for checking
`isBackgrounded` is correct for its other callers.

**Result-hold check** — The `eC8(z1).some((D1) => D1.type === "local_agent" && jf(D1))`
check is already correct. We don't touch it.

**Team polling loop** — The `while(true)` inbox polling loop is unchanged.
It already correctly uses `YK1()` to check for teammates and `m56()` to
read the inbox.

**Interactive mode (CLI)** — The `lGq` InboxPoller hook is unaffected.
This patch only changes the headless/SDK code path in `f6()`.

## Key Functions Reference

| Name (v2.1.45) | Purpose | Char offset |
|---|---|---|
| `m3z` | Main headless function (query loop + stdin reader) | ~10803455 |
| `f6` | Query execution function (runs AI turn, post-result checks) | ~10806891 |
| `M6` | Inner function that dequeues/runs commands from queuedCommands | ~10807900 |
| `hDq` | Core query generator (API calls, tool execution) | — |
| `eC8` | Get running tasks from appState (`tasks.filter(status==="running")`) | ~8834262 |
| `jf` | Check if task is active (running/pending, not isBackgrounded:false) | ~9736031 |
| `YK1` | Check for running `in_process_teammate` tasks | ~8834100 |
| `cX` | Check if current agent is team lead | — |
| `m56` | Read unread messages from inbox | — |
| `ed` | Read all messages from inbox | — |
| `s5` | Write message to inbox | — |
| `qQ6` | Mark all messages as read | — |
| `By` | Enqueue command to queuedCommands | — |
| `pJ1` | Dequeue from queuedCommands | — |
| `lGq` | InboxPoller React hook (CLI interactive mode only) | — |
| `B3z` | `runHeadless()` — headless mode entry point, calls m3z | ~10799442 |
| `U3z` | Creates output writer from prompt input | ~10826848 |
| `OP8` | Post-turn cleanup in f6 | — |

**Note:** All names will change in future SDK versions. Use content
patterns to relocate code.

## How to Find This Code

### The do-while condition (patch site)

```bash
# Unique pattern: eC8 + jf in a comma-separated let declaration
bundle-analyzer find cli.js "eC8(\$6).some" --compact

# More specific: the full do-while condition line
bundle-analyzer patch-check cli.js 'Z6=eC8($6).some((L6)=>jf(L6)),X6=$6.queuedCommands'
```

### The result-hold check (comparison)

```bash
# The narrower check that correctly filters by local_agent
bundle-analyzer find cli.js 'type==="local_agent"&&jf' --compact
```

### The eC8 and jf functions

```bash
bundle-analyzer find cli.js "function eC8" --compact
bundle-analyzer extract-fn cli.js <offset> --depth 0

bundle-analyzer find cli.js "function jf(" --compact
bundle-analyzer extract-fn cli.js <offset> --depth 0
```

### The team polling code

```bash
# Team lead check followed by inbox polling
bundle-analyzer find cli.js "No more active teammates" --compact

# Inbox read function
bundle-analyzer find cli.js 'm56("team-lead"' --compact
```

### The do-while loop structure

```bash
# The do-while with M6 call
bundle-analyzer find cli.js "do{" --near <f6-offset> --compact

# The full loop body
bundle-analyzer slice cli.js <do-offset> --after 300 --beautify
```

## Broader Analysis

### Interactive vs headless mode

The CLI's interactive mode uses the `lGq` InboxPoller React hook:
- Polls inbox every 1 second (independent of query loop)
- When session idle: calls `onSubmitMessage(xml)` → triggers new AI turn
- When session busy: queues messages, delivers when turn completes

The headless mode (`m3z`/`f6`) handles team polling inline, after the
do-while loop. Our patch fixes the headless path only. The interactive
path was never broken.

### What happens with mixed task types

If the team-lead spawns BOTH background `local_agent` tasks AND
`in_process_teammate` tasks in the same turn:
- The do-while loop continues for `local_agent` tasks (correct)
- Once all `local_agent` tasks complete, the loop exits
- Team polling picks up `in_process_teammate` messages

This is correct behavior — background tasks should complete before
the team-lead starts processing teammate messages from the same turn.

### Teammate shutdown lifecycle

When a teammate finishes:
1. Teammate sends a `shutdown_approved` message to team-lead's inbox
2. Team-lead reads it in the polling loop
3. Team-lead calls `ZW6()` to remove teammate from team file
4. Team-lead updates `appState.teamContext.teammates` (removes entry)
5. When no teammates remain AND `YK1()` returns false → polling loop breaks
6. Code proceeds to check if stdin is closed (session end)

Our patch doesn't affect this lifecycle. The polling loop already handles
all of this correctly — it just couldn't run before.

### m3z `let` declaration chain hazard

The m3z function uses a comma-separated `let` declaration:

```js
function m3z(A,q,K,Y,z,w,$,H,O,_,J,j){
    let D=!1,X=!1,M=!1,P=null,W,G=new hp6,N=(E6)=>{...};
    //  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    //  ALL of these are in a single let statement!
```

**CRITICAL:** Never insert a semicolon inside this chain. Doing so severs
later variables (`N` in particular) from the `let` declaration. In ESM
strict mode, assigning to undeclared `N` throws `ReferenceError: N is not
defined`, silently crashing the session.

This was the cause of the "session hangs" symptom during the initial
investigation (checkpoint1.md). Debug logs inserted with semicolons after
`G=new hp6` broke the declaration chain, causing immediate crashes masked
as hangs (the error was an unhandled promise rejection not visible in the
UI).

If you need to add debug logs inside m3z's setup, insert them AFTER the
full `let` statement ends (after the semicolon that closes the `N`
function body), not between comma-separated declarations.

## Verification

After applying the patch, launch a team session (ask the model to create
a team with multiple agents). Expected stderr output:

```
[SDK stderr] [flow trace if diagnostic logs are applied]
f6() called → result received → do-while exits immediately
  → teamContext populated with team info
  → cX = true (we are team lead)
  → polling inbox...
  → found N unread messages
  → f6() called (recurse)
  ... (repeats until all teammates shut down)
  → teamContext = null (team torn down)
```

Without diagnostic logs, the visible behavior is:
- Team-lead processes teammate messages (visible as conversation turns)
- Teammates are shown as completing one by one
- Session ends cleanly after all teammates shut down

## Discovery Method

1. **Initial symptom**: Session hung after team-lead's first turn. Only
   `[DEBUG-TEAM] m3z initialized, stream-json mode active` appeared in
   stderr, then nothing.

2. **False lead — debug log crash**: Added `console.error()` inside m3z
   to trace the setup, but inserted a semicolon in the middle of a
   comma-separated `let D,...,G=new hp6,N=...` declaration. This severed
   `N` from `let`, causing `ReferenceError: N is not defined` in ESM
   strict mode. The crash was silent (unhandled promise rejection) and
   looked like a hang.

3. **Diagnostic try-catch**: Wrapped m3z's setup in a `try-catch` and
   added numbered checkpoint logs (CP1-CP7). The catch revealed
   `ReferenceError: N is not defined` immediately after CP1, confirming
   the `let` chain breakage.

4. **Clean slate**: Reinstalled clean cli.js (no debug logs), confirmed
   sessions work for non-team use cases.

5. **Team-specific diagnostic**: Added debug logs to f6()'s post-result
   flow (T1-T7: f6 entry, result received, teamContext check, inbox
   poll, etc.). All logs placed inside function bodies (no `let` chain
   risk).

6. **Observed do-while spinning**: After the first result, saw repeated
   `do-while iteration` logs but T3 (`teamContext=`) never fired. The
   loop was stuck between T2 (result) and T3 (team check).

7. **Identified the do-while condition**: Extracted `eC8()` and `jf()`
   functions via `bundle-analyzer extract-fn`. Discovered:
   - `eC8()` returns ALL tasks with `status === "running"`
   - `jf()` returns true if running/pending AND not `isBackgrounded:false`
   - No type filter in the do-while — teammates counted as running tasks

8. **Compared with result-hold check**: Found the narrower check
   `eC8(z1).some((D1) => D1.type === "local_agent" && jf(D1))` used
   for holding the result. This correctly excludes teammates.

9. **Applied fix**: Added `L6.type !== "in_process_teammate" &&` to the
   do-while condition. Verified with diagnostic logs showing the complete
   team lifecycle: f6 → result → do-while exits → teamContext check →
   inbox polling → message processing → f6 recurse → shutdown.

10. **Confirmed full lifecycle**: Observed team create (3 teammates) →
    message exchange (7+ rounds) → teammate shutdown (count drops
    3 → 2 → 0) → `teamContext = null, cX = false` → clean exit.

## Files

| File | Purpose |
|---|---|
| `README.md` | This document |
| `apply.mjs` | Patch script — run after install or SDK update |

## Related Patches

- `patch/subagent-streaming/` — Forwards sub-agent stream events + messages
  to SDK consumer. That patch addresses visibility of sub-agent content.
  This patch addresses the team-lead's ability to process teammate messages.

- `patch/taskstop-notification/` — Sends task_notification on TaskStop.
  Teammates may be stopped via TaskStop, which uses that patch's notification
  mechanism.

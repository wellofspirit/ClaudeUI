# Patch: background-task

Exposes the CLI's "send to background" feature (foreground → background task conversion) via the SDK control message API, enabling GUI clients to background running Bash and Agent tasks.

## Affected Component

`@anthropic-ai/claude-agent-sdk` — bundled `cli.js` and `sdk.mjs` files.

| Component | Version at time of discovery |
|---|---|
| SDK package | 0.2.63 |
| Bundled CLI (`cli.js`) | 2.1.63 |

## The Problem

The CLI's terminal UI has a `ctrl+b` shortcut that converts any foreground-running task (Bash command or Agent) into a background task. This lets the user continue interacting while the task runs. However, this feature is implemented entirely within the CLI's Ink (React-for-terminal) UI layer — it is **not** exposed via the SDK's `MessageChannel` control request protocol.

SDK consumers (like ClaudeUI's Electron app) have no way to trigger this conversion. Users are stuck waiting for foreground Bash commands or Agent tasks to complete, with no option to send them to the background.

## Architecture Overview

### Task state model

The CLI maintains a task store (`tasks` object in app state) where each running task has:

```
tasks: {
  [taskId]: {
    type: "local_bash" | "local_agent",
    status: "running" | "completed" | "failed" | "killed",
    isBackgrounded: boolean,
    shellCommand: <ShellCommand object>,  // bash only
    // ... other fields
  }
}
```

### Background conversion — two task types

**Bash tasks** (`type: "local_bash"`):
```
User triggers background
  → shellCommand.background(taskId)
    → status = "backgrounded"
    → stdout spills to disk (taskOutput.spillToDisk())
  → state.isBackgrounded = true
  → bash tool loop detects "backgrounded" status
  → returns {backgroundTaskId, backgroundedByUser: true} as tool result
```

**Agent tasks** (`type: "local_agent"`):
```
User triggers background
  → state.isBackgrounded = true
  → resolve backgroundSignal Promise (stored in Ff6 Map)
  → agent enters background mode (runs without blocking chat)
```

### Control message flow

```
ClaudeUI renderer
  → window.api.backgroundTask(routingId, toolUseId)     [IPC]
  → session.backgroundTask(toolUseId)                    [main process]
  → activeQuery.backgroundTask(taskId)                   [SDK sdk.mjs]
  → MessageChannel.request({subtype:"background_task"})  [stdin → cli.js]
  → control request handler [Part A]
    → lookup task in state
    → call shellCommand.background() (bash) or resolve backgroundSignal (agent)
    → set isBackgrounded: true
  → control response {task_id}                           [stdout → SDK → IPC]
```

### CLI's native implementation (for reference)

The CLI uses an Ink component `FN1` (or `Fhq` in the non-SDK path) that listens for the `task:background` keybinding (`ctrl+b`). On keypress, it calls `gN1(getState, setState)` which iterates all running tasks and calls:

- `mpY(taskId, getState, setState)` for bash tasks
- `Go4(taskId, getState, setState)` for agent tasks

These functions are **not accessible** from the control message handler's scope (they're in a different lazy-initialized module). The patch reimplements the core logic inline.

### Variable mapping (Part A injection site)

| Variable | Source | Value |
|---|---|---|
| `r` | Control message loop | The incoming control request message |
| `$` | Closure (`getAppState`) | Async function returning app state |
| `f` | Closure (`setAppState`) | Zustand-style state updater |
| `t` | Closure | Success response function: `t(msg, result)` |
| `O6` | Closure | Error response function: `O6(msg, errorString)` |
| `wi` | Module scope | Type guard: `A.type === "local_bash"` |
| `Yi` | Module scope | Type guard: `A.type === "local_agent"` |
| `Ff6` | Module scope | `Map<taskId, resolveBackgroundSignal>` |

## The Patches

### Part A: `background_task` control request handler (cli.js)

**Marker**: `/*PATCHED:background-task*/`

#### Anchor (unique, 1 match)

The "Unsupported control request subtype" fallback at the end of the control request if-else chain:

```
else O6(r,`Unsupported control request subtype: ${r.request.subtype}`);continue}else if(r.type==="control_response")
```

Note: After `queue-control` patch is applied, the actual anchor shifts slightly because `queue-control-dequeue` is injected before the fallback. The patch script uses the full anchor pattern which matches regardless of what's injected before it.

#### Before

```js
// ... existing handlers ...
else O6(r,`Unsupported control request subtype: ${r.request.subtype}`)
```

#### After

```js
// ... existing handlers ...
/*PATCHED:background-task*/else if(r.request.subtype==="background_task"){
  let{task_id:Z6}=r.request;
  try{
    let S6=(await $()).tasks?.[Z6];
    if(!S6) throw Error("No task found with ID: "+Z6);
    if(S6.status!=="running") throw Error("Task "+Z6+" is not running (status: "+S6.status+")");
    if(S6.isBackgrounded) throw Error("Task "+Z6+" is already backgrounded");
    if(wi(S6)){
      // Bash: call shellCommand.background(), then set isBackgrounded in state
      if(!S6.shellCommand||!S6.shellCommand.background(Z6))
        throw Error("Failed to background bash task "+Z6);
      f((C6)=>{
        let d6=C6.tasks[Z6];
        if(!d6||d6.isBackgrounded) return C6;
        return{...C6,tasks:{...C6.tasks,[Z6]:{...d6,isBackgrounded:!0}}}
      })
    } else if(Yi(S6)){
      // Agent: set isBackgrounded, then resolve backgroundSignal
      f((C6)=>{
        let d6=C6.tasks[Z6];
        if(!d6||d6.isBackgrounded) return C6;
        return{...C6,tasks:{...C6.tasks,[Z6]:{...d6,isBackgrounded:!0}}}
      });
      let C6=Ff6.get(Z6); if(C6) C6(), Ff6.delete(Z6)
    } else {
      throw Error("Unsupported task type for backgrounding")
    }
    t(r,{task_id:Z6})
  }catch(S6){
    O6(r,S6 instanceof Error?S6.message:String(S6))
  }
}
else O6(r,`Unsupported control request subtype: ${r.request.subtype}`)
```

#### Why it's safe

- **Bash `shellCommand.background()`** already exists and is called by the CLI's own `mpY` function. It checks `status === "running"` internally and returns `false` if the command can't be backgrounded.
- **Agent `Ff6` (backgroundSignal)** — resolving the Promise is idempotent. If the Map entry was already deleted (e.g., by auto-background timeout), the `Ff6.get()` returns `undefined` and no-op.
- **State immutability** — the `setAppState` updater returns the unchanged state if `isBackgrounded` is already `true`, preventing double-updates.
- **Error handling** — all failures are caught and returned as control response errors, not crashes.
- **Variable scoping** — `Z6`, `S6`, `C6`, `d6` are `let`-declared inside the `else if` block. Other handler branches use the same names in their own blocks, but they're in separate scopes.

#### Dynamic function extraction

Six symbols are extracted at apply time from content patterns:

| Symbol | Pattern | Example (v2.1.63) |
|---|---|---|
| `errorFn` | From anchor: `else <fn>(<msg>,\`Unsupported...` | `O6` |
| `msgVar` | From anchor: backreference `\2` | `r` |
| `successFn` | `),<fn>(<msg>,{})}catch` near anchor | `t` |
| `getAppStateFn` | `getAppState:<var>,setAppState:<var>` | `$` |
| `setAppStateFn` | Same pattern, second capture | `f` |
| `wiFn` | `function <fn>(...){...A.type==="local_bash"}` | `wi` |
| `yiFn` | `function <fn>(...){...A.type==="local_agent"}` | `Yi` |
| `bgSignalMap` | `<map>.set(A,<var>),<fn>(<state>,<setter>);let <var>;if(<var>!==void 0&&<var>>0)` + verified `<map>=new Map` | `Ff6` |

### Part B: `backgroundTask()` method (sdk.mjs)

**Marker**: `/*PATCHED:background-task-sdk*/`

#### Anchor

```
async stopTask(Q){await this.request({subtype:"stop_task",task_id:Q})}
```

#### Before

```js
async stopTask(Q){await this.request({subtype:"stop_task",task_id:Q})}/*PATCHED:queue-control-sdk*/async dequeueMessage(Q){...}
```

#### After

```js
async stopTask(Q){await this.request({subtype:"stop_task",task_id:Q})}/*PATCHED:background-task-sdk*/async backgroundTask(Q){return await this.request({subtype:"background_task",task_id:Q})}/*PATCHED:queue-control-sdk*/async dequeueMessage(Q){...}
```

#### Why it's safe

This adds a new method to the `U4` (Query) class. It follows the identical pattern as `stopTask` — calls `this.request()` which sends a control request message and awaits the response. No existing methods are modified.

## How to Find This Code

### Control request dispatcher (injection site)
```bash
bundle-analyzer find cli.js "Unsupported control request subtype" --compact
```
The match inside the `async()=>` function (~char 11.3M) is the main SDK query loop. The other matches are the DirectConnect WebSocket handler and the remote REPL bridge handler.

### `stop_task` handler (reference pattern for the injection)
```bash
bundle-analyzer find cli.js "stop_task" --compact
```

### `wi` — local_bash type check
```bash
bundle-analyzer find cli.js '"local_bash"' --compact
# Then extract the function with the type guard pattern
```

### `Yi` — local_agent type check
```bash
bundle-analyzer find cli.js '"local_agent"' --compact
```

### `Ff6` — backgroundSignal resolver Map
```bash
bundle-analyzer find cli.js "backgroundSignal" --compact
# Returns the agent task factory (Wo4) where the Map is populated
```

### `mpY` — CLI's native bash background function (reference only)
```bash
bundle-analyzer find cli.js ".background(" --compact
# The match inside function mpY shows the CLI's own implementation
```

### `Go4` — CLI's native agent background function (reference only)
```bash
bundle-analyzer find cli.js "isBackgrounded" --compact --limit 5
# Go4 is the function that sets isBackgrounded and resolves Ff6
```

### `shellCommand.background()` — the ShellCommand method
```bash
bundle-analyzer extract-fn cli.js <offset-of-mpY>
# The .background() method is on the ShellCommand class, sets status="backgrounded"
# and calls taskOutput.spillToDisk()
```

### `stopTask` in sdk.mjs (Part B anchor)
```bash
grep -o 'async stopTask.*}' node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs | head -1
```

## Syntax Pitfalls

### Pitfall: Semicolons inside the injected handler

The injected code uses `;` between statements inside a `try{}catch{}` block. This is straightforward compared to comma-expression patches, but be careful with the bash vs agent branches:

```js
// CORRECT — semicolon before `let` in the agent branch
f((C6)=>{...});let C6=Ff6.get(Z6);if(C6)C6(),Ff6.delete(Z6)

// WRONG — missing semicolon would cause "Unexpected token 'let'"
f((C6)=>{...})let C6=Ff6.get(Z6);if(C6)C6(),Ff6.delete(Z6)
```

### Pitfall: Variable name collisions

The control message handler loop uses many single-letter and two-letter variable names (`r`, `Z6`, `S6`, `C6`, `d6`). The injected code reuses these names but with `let` declarations inside the `else if` block, so they're block-scoped and don't collide. **Do not use `var`** — it would hoist and collide.

**Always run `node --check cli.js` after applying patches.**

## What's NOT Changed

**`mpY` and `Go4` functions** — The CLI's native background functions are left untouched. They're used by the Ink TUI's `ctrl+b` handler and have additional UI-side effects (status display updates, etc.) that are not needed for the SDK path.

**`gN1` (background-all)** — The function that backgrounds ALL running tasks is not exposed. The patch only backgrounds a single task by ID, matching the existing `stop_task` pattern.

**Bash completion handling** — When a backgrounded bash command completes, the existing `mpY` code handles the `.result.then(...)` callback. Our patch only triggers the initial backgrounding; the completion path is already wired up by the CLI's task management.

**Agent `cancelAutoBackground`** — The agent task factory sets up an auto-background timeout. The patch doesn't interact with this. If the timeout fires before our manual background, the task is already backgrounded and our handler returns an "already backgrounded" error.

## Consumer-Side Integration

### Main process (`claude-session.ts`)

```typescript
async backgroundTask(toolUseId: string): Promise<{ success: boolean; error?: string }> {
  // Reverse lookup: toolUseId → taskId via taskIdMap
  // Then: await this.activeQuery.backgroundTask(taskId)
}
```

The `taskIdMap` (agentId → toolUseId) is populated by `detectTaskMapping()` when tool results contain `agentId:`, `task_id:`, or `Command running in background with ID:` patterns.

### IPC bridge

```
renderer: window.api.backgroundTask(routingId, toolUseId)
  → preload: ipcRenderer.invoke('session:background-task', ...)
  → main: ipcMain.handle('session:background-task', ...) → session.backgroundTask()
```

### Renderer components

- **`ToolCallBlock.tsx`** — Shows "Background" button for foreground Bash (not `run_in_background`) while running
- **`TaskCard.tsx`** — Shows "Background" button for foreground Agent (not `run_in_background`) while running

## Verification

1. `node patch/background-task/apply.mjs` — should apply both parts
2. Run again — should report "already applied" for both
3. `node --check node_modules/@anthropic-ai/claude-agent-sdk/cli.js` — no syntax errors
4. `node patch/apply-all.mjs` — all patches pass
5. Start ClaudeUI, begin a long-running Bash command (e.g., `sleep 30`) → "Background" button appears → click it → task should move to background
6. Start a foreground Agent task → "Background" button appears → click it → agent should background

## Discovery Method

1. **Observed the gap**: ClaudeUI had no way to background foreground tasks, unlike the CLI's `ctrl+b`
2. **Found the CLI feature**: `bundle-analyzer find cli.js "task:background"` → found the Ink keybinding handler
3. **Traced to `gN1`**: The keybinding calls `gN1(getState, setState)` which iterates all tasks
4. **Traced to `mpY` and `Go4`**: `gN1` calls these per-task-type background functions
5. **Checked scope**: `bundle-analyzer scope cli.js <control-handler-offset> --all | grep mpY` → NOT in scope. Cannot call directly.
6. **Identified inline approach**: The control handler has `$` (getAppState), `f` (setAppState), `wi`, `Yi`, and `Ff6` all in scope — enough to reimplement the core logic inline
7. **Studied `shellCommand.background()`**: The method already exists on bash task objects, sets status to `"backgrounded"`, spills stdout to disk
8. **Studied `Ff6` (backgroundSignal Map)**: Agent tasks store a resolve function in this Map. Calling it signals the agent to enter background mode
9. **Modeled after `stop_task`**: Used the exact same injection pattern — `else if` before the "Unsupported" fallback, same error handling, same success response
10. **Patched sdk.mjs**: Added `backgroundTask()` method adjacent to `stopTask()`, same pattern

## Key Functions Reference

| Name (v2.1.63) | Purpose | Find pattern |
|---|---|---|
| `wi` | Type guard: `local_bash` | `A.type==="local_bash"` |
| `Yi` | Type guard: `local_agent` | `A.type==="local_agent"` |
| `Ff6` | Background signal resolver Map | `backgroundSignal` nearby |
| `mpY` | CLI's bash background function | `.background(` in task module |
| `Go4` | CLI's agent background function | `isBackgrounded` + `Ff6` |
| `gN1` | CLI's background-all-tasks function | Calls `mpY` and `Go4` |
| `Eo4` | Bash task factory (creates task state) | `"local_bash"` + `shellCommand` |
| `Wo4` | Agent task factory (creates task state + `Ff6` entry) | `"local_agent"` + `backgroundSignal` |
| `uv1` | `stop_task` implementation (reference) | `"No task found with ID"` |

**Note:** All minified names will change in future SDK versions. Use
content patterns (string literals, structural shapes) to relocate code.

## Related Patches

- `patch/queue-control/` — Also adds a control request handler (`dequeue_message`) using the same injection anchor pattern. Applied before this patch. Both inject `else if` blocks before the "Unsupported" fallback.
- `patch/taskstop-notification/` — Patches task lifecycle behavior (stop notification). Shares the same task state model (`tasks` object, `status`, `isBackgrounded`).

## Files

| File | Purpose |
|---|---|
| `README.md` | This document |
| `apply.mjs` | Patch script (Part A: cli.js handler, Part B: sdk.mjs method) |

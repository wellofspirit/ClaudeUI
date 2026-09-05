# Patch: background-task

Exposes the CLI's "send to background" feature (foreground → background task conversion) via the SDK control message API, enabling GUI clients to background running Bash and Agent tasks.

## Affected Component

`@anthropic-ai/claude-agent-sdk` — bundled `cli.js` and `sdk.mjs` files.

| Component              | Version at time of discovery |
| ---------------------- | ---------------------------- |
| SDK package            | 0.2.63                       |
| Bundled CLI (`cli.js`) | 2.1.63                       |
| Last re-anchored       | 2.1.261                      |

> **2.1.261 is a code-split bundle**, and this patch is the one most exposed by
> that. `vendor/claude-cli/cli.js` is the concatenation of ~1,631 minified ESM
> chunks, each preceded by `// @bun-chunk B:/~BUN/root/chunk-xxxxxxxx.js`.
> **Three of the four helpers this handler calls are defined in a chunk other
> than the one it is injected into**, so capturing their names at the definition
> site is no longer enough — see §"v2.1.261 changes".

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

| Variable | Source                  | Value                                           |
| -------- | ----------------------- | ----------------------------------------------- |
| `r`      | Control message loop    | The incoming control request message            |
| `$`      | Closure (`getAppState`) | Async function returning app state              |
| `f`      | Closure (`setAppState`) | Zustand-style state updater                     |
| `t`      | Closure                 | Success response function: `t(msg, result)`     |
| `O6`     | Closure                 | Error response function: `O6(msg, errorString)` |
| `wi`     | Module scope            | Type guard: `A.type === "local_bash"`           |
| `Yi`     | Module scope            | Type guard: `A.type === "local_agent"`          |
| `Ff6`    | Module scope            | `Map<taskId, resolveBackgroundSignal>`          |

Same table for 2.1.261 (chunk-split; injection chunk is `chunk-gj501zgt.js`):

| Variable                              | Origin chunk                           | Reaches the injection site as         |
| ------------------------------------- | -------------------------------------- | ------------------------------------- |
| `r` (msgVar)                          | local to the dispatch loop             | itself                                |
| `k` (getAppState) / `w` (setAppState) | locals of the enclosing headless loop  | themselves                            |
| `Xe` (success) / `Be` (error)         | locals of the dispatch loop            | themselves                            |
| `Sf` (`local_bash` guard)             | `chunk-9c0rs7w4.js`                    | static import, **same name**          |
| `nr` (`local_agent` guard)            | `chunk-9c0rs7w4.js`                    | static import, **same name**          |
| `sr` (session-state accessor)         | `chunk-nhm4zepz.js` (read in 9c0rs7w4) | static import, **same name**          |
| backgroundSignal Map                  | class field on `sr()`                  | `sr().agentBackgroundSignalResolvers` |

The last three are **not** guaranteed to keep their names across the chunk
boundary; `apply.mjs` resolves each one through the import/export graph rather
than assuming, and falls back to `await import("<chunk>")` when a helper is
exported but not statically imported by the injection chunk.

## The Patches

### Part A: `background_task` control request handler (cli.js)

**Marker**: `/*PATCHED:background-task*/`

#### Anchor (unique, 1 match)

The "Unsupported control request subtype" fallback at the end of the control request if-else chain:

```
// 2.1.261
else Be(r,`Unsupported control request subtype: ${Xn(String(r.request.subtype))}`)
// ≤2.1.241
else O6(r,`Unsupported control request subtype: ${r.request.subtype}`)
```

Tail-less since v2.1.219 (the dispatch chain is now wrapped in `try/finally`; ≤ v2.1.207 the
anchor included `;continue}else if(r.type==="control_response")`). 2.1.261 wrapped the
interpolated subtype in a sanitizer; `anchorRe` admits both forms.

Four lookalike fallbacks exist elsewhere in the bundle — the class-based SDK Query dispatcher
(`throw Error("Unsupported control request subtype: "+e.request.subtype)`), `RemoteSessionManager`,
`DirectConnect`, and the device-hooks `default:` case. Only the stdin loop's is
`else <fn>(<msgVar>,` **with the same `<msgVar>` backreferenced inside the template**, which is
what the regex pins. Getting this wrong is not merely cosmetic: the app-state helpers
(`getAppState`/`setAppState`) this patch needs are only in scope in the stream-json loop.

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

| Symbol          | Pattern                                                                                                                                      | v2.1.63 | v2.1.197 | v2.1.261                              |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------- | ------------------------------------- |
| `errorFn`       | From anchor: `else <fn>(<msg>,\`Unsupported...`                                                                                              | `O6`    | `qn`     | `Be`                                  |
| `msgVar`        | From anchor: backreference `\2`                                                                                                              | `r`     | `Ht`     | `r`                                   |
| `successFn`     | `),<fn>(<msg>,{})}catch` **inside the dispatch chain**                                                                                       | `t`     | `$t`     | `Xe`                                  |
| `getAppStateFn` | `getAppState:<var>,setAppState:<var>` — all mentions in the window must agree                                                                | `$`     | (varies) | `k`                                   |
| `setAppStateFn` | Same pattern, second capture                                                                                                                 | `f`     | (varies) | `w`                                   |
| `wiFn`          | `function <fn>(...){...A.type==="local_bash"}`, then resolved into the injection chunk                                                       | `wi`    | (varies) | `Sf`                                  |
| `yiFn`          | `function <fn>(...){...A.type==="local_agent"}` + guard disambiguation, then resolved                                                        | `Yi`    | (varies) | `nr`                                  |
| `bgSignalMap`   | 2.1.261+: `<accessor>().agentBackgroundSignalResolvers.set(` (accessor captured, then resolved). Legacy: `<map>.set(A,<var>),…` + `=new Map` | `Ff6`   | (varies) | `sr().agentBackgroundSignalResolvers` |

**v2.1.197 change:** The search window for the success-response helper was extended from 5000 → 8000 characters before the anchor. In v2.1.197 the `stop_task` handler (which contains the `),<fn>(<msg>,{})}}catch` pattern used to find `successFn`) moved to 5647 chars before the fallback anchor, just outside the old 5000-char window. The 8000-char margin accommodates this and future similar drift.

**v2.1.219 change (`yiFn` disambiguation):** Two functions define the identical
`typeof x==="object"&&...&&x.type==="local_agent"` shape (task-management + TUI copies). The
disambiguator — a `<fn>(x)&&x.agentType!=="main-session"` guard that only references the
task-management copy — used to sit within ~400 chars of the definition, so the patch matched
definition+guard as one regex with a bounded gap. In v2.1.219 the guard moved ~2.3M chars away.
The patch now collects all candidate definitions first, then filters to the one name used in the
guard anywhere in the bundle, and requires exactly one survivor.

Known names in v2.1.197: `errorFn=qn`, `msgVar=Ht`, `successFn=$t`.

### v2.1.261 changes

**0. The bundle is code-split, and this patch calls across chunk boundaries**

`vendor/claude-cli/cli.js` is now the concatenation of 1,631 minified ESM chunks
in module-graph order, each preceded by `// @bun-chunk B:/~BUN/root/chunk-….js`.
Regexes still run over the whole concat, but **module scope is per chunk**: a
name captured where it is defined is not a binding where we inject.

The injection site is in `chunk-gj501zgt.js` (exports `runHeadless`,
`endHeadlessSessionOnEscapedError`, `explicitMcpConfigRequestsWait` — i.e. the
stdin stream-json loop). `Sf`, `nr` and `sr` all come from elsewhere.
`apply.mjs` now resolves each captured helper through the chunk graph:

1. Where is the name **referenced**? (a capture site is often a _use_ site in a
   chunk that itself imported the binding — `sr` is read in `chunk-9c0rs7w4.js`
   but defined in `chunk-nhm4zepz.js`.)
2. Follow that chunk's `import{…}from"chunk-….js"` to the owning chunk and the
   **exported** name.
3. Look for that exported name in the injection chunk's own imports → use the
   local alias.
4. If the injection chunk does not import it, emit
   `let <tmp>=(await import("<owning chunk>")).<exported>;` at the top of the
   handler's `try` block — the form the bundle itself uses in this very chunk
   (`await import("B:/~BUN/root/chunk-wdwcp2mj.js")` in the `workflow_launch`
   branch).
5. If the owning chunk does not export it at all → **abort loudly** rather than
   inject a name that throws at runtime.

On 2.1.261 all three resolve to identical names via static imports, so no
dynamic-import hoist is emitted. The machinery exists so the next rename cannot
silently produce a ReferenceError.

Dump a chunk's import surface with:

```bash
node -e 'const s=require("fs").readFileSync("vendor/claude-cli/cli.js","utf8");
const i=s.indexOf("// @bun-chunk B:/~BUN/root/chunk-gj501zgt.js");
const j=s.indexOf("// @bun-chunk", i+1);
for (const m of s.slice(i,j).matchAll(/import\{([^}]*)\}from"([^"]+)"/g))
  if (/\bSf\b|\bnr\b|\bsr\b/.test(m[1])) console.log(m[2], "->", m[1].slice(0,200))'
```

**1. The fallback anchor gained a sanitizer — this is what broke the patch**

```js
// 2.1.241
else Be(r,`Unsupported control request subtype: ${r.request.subtype}`)
// 2.1.261
else Be(r,`Unsupported control request subtype: ${Xn(String(r.request.subtype))}`)
```

`anchorRe` admits either interpolation. Still exactly 1 match.

**2. The backgroundSignal Map moved onto a session-state object — and the old regex MISBOUND it silently**

```js
// ≤2.1.241 — a module-level Map identifier
Ff6.set(taskId, resolve), registry.register(…);let t;if(ms!==void 0&&ms>0)
// 2.1.261 — a class field reached through a zero-arg accessor
sr().agentBackgroundSignalResolvers.set(e,re),v.register(q);let de;if(P!==void 0&&P>0)
```

The old regex `(<V>)\.set\(<V>,<V>\),…` **still matched** — it captured the
_property_ `agentBackgroundSignalResolvers`, and even its `<map>=new Map`
sanity check passed, because the class field is literally declared
`agentBackgroundSignalResolvers=new Map` in `chunk-nhm4zepz.js`. The patch
would have applied clean and injected a bare, undefined identifier: the same
"applies-but-misbinds" class as 2.1.241's `dequeueAllMatching` bug, invisible
until an agent is actually backgrounded live.

The new anchor keys on the **unminified property name** and captures the
accessor instead:

```js
;`(${V})\\(\\)\\.agentBackgroundSignalResolvers\\.set\\(${V},${V}\\),`
```

with two corroborations: the same accessor must also appear with `.get(` and
`.delete(` (the CLI's own `_Y` backgrounding helper uses all three), and
`agentBackgroundSignalResolvers=new Map` must exist. The captured accessor is
then chunk-resolved like any other helper. The legacy bare-Map shape remains as
a fallback for older bundles.

```bash
rg -o '.{80}agentBackgroundSignalResolvers.{60}' vendor/claude-cli/cli.js
```

**3. `getAppState`/`setAppState` now require unanimity**

The window search took whatever matched first. It now requires every
`getAppState:<a>,setAppState:<b>` pair in the window to name the same two
locals (4/4 agree on 2.1.261: `k`, `w`). Same reasoning as the reply helper:
a window that has had to grow twice must not be allowed to adopt a nested
callback's accessors.

**4. The reply-helper window is clamped to the dispatch chain**

`successFn` is now searched only between the nearest
`<msgVar>.type==="control_request"` before the anchor and the anchor itself, so
however far the `stop_task` handler drifts, the search cannot leave the chain.

**5. `local_agent` disambiguation survived unchanged**

Two definitions still exist (`nr` in `chunk-9c0rs7w4.js`, `Rke` in
`chunk-bab5vngb.js`); only `nr` appears in a
`<fn>(x)&&x.agentType!=="main-session"` guard, so the existing filter still
returns exactly one survivor. Note a third name, `td`, also appears in such a
guard (`!td(e)&&e.agentType!=="main-session"`) but is not a candidate
definition, so it is correctly ignored.

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
# or, tool-free:
rg -o '.{60}Unsupported control request subtype.{60}' vendor/claude-cli/cli.js
```

On 2.1.261 there are 10 hits across 8 sites; the one you want is the only
`else <fn>(<msgVar>,\`…${…<msgVar>.request.subtype…}\`)`— in`chunk-gj501zgt.js`, the headless stdin loop. The decoys are the class-based SDK
Query dispatcher (`throw Error(…)`), `RemoteSessionManager`, `DirectConnect`,
the device-hooks `default:`case, and several call-site error classifiers that
merely`startsWith("Unsupported control request subtype")`.

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

### backgroundSignal resolver Map

```bash
# 2.1.261+ — the property name survives minification, so search for it directly
rg -o '.{80}agentBackgroundSignalResolvers.{60}' vendor/claude-cli/cli.js
# 5 hits: `=new Map` (declaration), `.set(` (agent task factory), `.get(`/`.delete(` (native _Y), `.delete(` (cleanup)
# Legacy bundles:
bundle-analyzer find cli.js "backgroundSignal" --compact
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

The control message handler loop uses many single-letter and two-letter variable names (`r`, `Z6`, `S6`, `C6`, `d6`). The injected code reuses these names but with `let` declarations inside the `else if` block, so they're block-scoped and don't collide. **Do not use `var`** — it would hoist and collide. The dynamic-import hoist names (`v6`, `x6`, `y6`) follow the same rule.

### Pitfall (2.1.261+): `node --check` cannot validate the concat

The patch target is a concatenation of ESM chunks, so `node --check cli.js` on
the whole file is meaningless — it is not one valid module. Extract the chunk
you edited and check that instead:

```bash
node -e 'const fs=require("fs");const s=fs.readFileSync("vendor/claude-cli/cli.js","utf8");
const i=s.indexOf("// @bun-chunk B:/~BUN/root/chunk-gj501zgt.js");
const j=s.indexOf("// @bun-chunk", i+1);
fs.writeFileSync("/tmp/c.mjs", s.slice(s.indexOf("\n",i)+1, j))'
node --check /tmp/c.mjs
```

(The rebundler does this for every modified chunk with esbuild, so a bad edit
fails the build — but catching it here is much faster.)

### Pitfall (2.1.261+): a helper name that resolves is not a helper name that BINDS

Three of this handler's helpers live in other chunks. A regex that finds
`function Sf(e){…"local_bash"}` proves the guard exists; it does **not** prove
`Sf` is a binding at the injection point. Always resolve through the chunk's
import list (or emit a dynamic import) — see §"v2.1.261 changes" note 0. The
`agentBackgroundSignalResolvers` regression in note 2 is the same mistake in a
different disguise, and neither is caught by any syntax check.

**Always syntax-check the modified chunk after applying patches.**

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
3. **Read the apply log's resolution lines** — every helper must print
   `<name> -> <binding> [read in <chunk>]`, and any `(via dynamic import)`
   should have a matching `let …=(await import(…))` in the injected code
4. Syntax-check the modified chunk (see Syntax Pitfalls) — the whole-file
   `node --check` is not a valid test on a chunked bundle
5. `node patch/apply-all.mjs` — all patches pass
6. Start ClaudeUI, begin a long-running Bash command (e.g., `sleep 30`) → "Background" button appears → click it → task should move to background
7. Start a foreground Agent task → "Background" button appears → click it → agent should background

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

### 2.1.261 re-anchor (the chunked-bundle round)

11. **Symptom**: `ERROR: Cannot locate control-request fallback anchor.` —
    shared with `queue-control` and `usage-relay`, all three anchored on the
    same fallback. Cause: a sanitizer wrapper around the interpolated subtype.
12. **First trap avoided**: after widening the anchor, every other extraction
    "passed" — including `bgSignalMap`, which reported the plausible-looking
    `agentBackgroundSignalResolvers`. Only reading the captured value in
    context (`sr().agentBackgroundSignalResolvers.set(…)`) showed the capture
    was a **property name**, not an identifier, and that its `=new Map`
    verification passed for the wrong reason. Lesson: on a green apply run,
    still print and eyeball each captured name against its surrounding bytes.
13. **Second trap avoided**: `Sf`/`nr` were found and looked fine, but they are
    defined in `chunk-9c0rs7w4.js` while the injection lands in
    `chunk-gj501zgt.js`. Checked the injection chunk's import list before
    trusting the names — they happen to be imported unaliased, but
    `usage-relay`'s fetcher (`SD`) is **not** imported at all, proving the
    check is not academic.
14. **Verified** by reading the patched bytes, extracting the modified chunk and
    `node --check`ing it, and re-running the whole ordered chain from pristine.

## Key Functions Reference

| Name (v2.1.63) | Purpose                                               | Find pattern                         |
| -------------- | ----------------------------------------------------- | ------------------------------------ |
| `wi`           | Type guard: `local_bash`                              | `A.type==="local_bash"`              |
| `Yi`           | Type guard: `local_agent`                             | `A.type==="local_agent"`             |
| `Ff6`          | Background signal resolver Map                        | `backgroundSignal` nearby            |
| `mpY`          | CLI's bash background function                        | `.background(` in task module        |
| `Go4`          | CLI's agent background function                       | `isBackgrounded` + `Ff6`             |
| `gN1`          | CLI's background-all-tasks function                   | Calls `mpY` and `Go4`                |
| `Eo4`          | Bash task factory (creates task state)                | `"local_bash"` + `shellCommand`      |
| `Wo4`          | Agent task factory (creates task state + `Ff6` entry) | `"local_agent"` + `backgroundSignal` |
| `uv1`          | `stop_task` implementation (reference)                | `"No task found with ID"`            |

Known names in v2.1.197: `errorFn=qn` (the anchor-extracted error function), `msgVar=Ht` (the control message variable), `successFn=$t` (the success response helper).

**Note:** All other minified names will change in future SDK versions. Use
content patterns (string literals, structural shapes) to relocate code.

## Related Patches

- `patch/queue-control/` — Also adds a control request handler (`dequeue_message`) using the same injection anchor pattern. Applied before this patch. Both inject `else if` blocks before the "Unsupported" fallback.
- `patch/taskstop-notification/` — Patches task lifecycle behavior (stop notification). Shares the same task state model (`tasks` object, `status`, `isBackgrounded`).

## Files

| File        | Purpose                                                       |
| ----------- | ------------------------------------------------------------- |
| `README.md` | This document                                                 |
| `apply.mjs` | Patch script (Part A: cli.js handler, Part B: sdk.mjs method) |

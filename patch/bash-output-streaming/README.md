# Patch: bash-output-streaming

Live Bash/PowerShell command output never reaches the SDK consumer until the command finishes or the 2-second progress-loop timeout fires — and even then, the GUI must wait an additional ~1s for file polling to start.

## Affected Component

`@anthropic-ai/claude-agent-sdk` — bundled `cli.js` file.

| Component | Version at time of discovery |
|---|---|
| SDK package | 0.2.97 → 0.2.105 |
| Bundled CLI (`cli.js`) | 2.1.97 → 2.1.105 |

## The Problem

### Problem 1: No real-time output streaming

When a Bash tool runs, the SDK's async generator (`sLz`) only yields progress to the consumer after a 2-second timeout (`Bc4=2000`). Fast commands (< 2s) never yield any progress at all. The GUI shows nothing until the command completes.

### Problem 2: Output file polling starts too late

In SDK 0.2.97+, **both foreground and background** bash commands redirect stdout to an output file via OS-level file descriptor (`wvz()` returns `["pipe", fd, fd]`). The `onProgress` callback in `j$` (TaskOutput) only fires when `j$.startPolling()` reads this file — but `startPolling()` is called **after** the 2-second HEK timeout, adding another ~1s for the first poll interval (`OGz=1000`).

Total delay from process spawn to first output: **~3.9 seconds** (868ms spawn + 2000ms HEK + 1000ms first poll).

### Root cause: `onStdout` not passed by bash generator

The bash async generator `sLz` calls `nE6()` (the command runner) with `{onProgress, preventCwdChanges, shouldUseSandbox, shouldAutoBackground}` but does **not** pass `onStdout`. Inside `nE6()`:

```js
let {onProgress:A, ..., onStdout:j} = z ?? {}
// j = undefined (not passed by sLz)
let R = !!j       // R = false
new j$(x, A??null, !R)  // stdoutToFile = true
```

With `stdoutToFile=true`, `wvz(false, fd, ...)` returns `["pipe", fd, fd]` — stdout goes directly to the file at the OS level, bypassing Node pipes entirely. The `xO7` stream handler is never created. `j$.writeStdout()` is never called from process output. The only way `onProgress` fires is through `j$.startPolling()`, which reads the file on a 1-second interval.

## Architecture Overview

### Data flow (before patch)

```
sLz (bash generator)
  │
  ├─ Calls nE6() with onProgress but NOT onStdout
  │
  ▼
nE6() (command runner)
  │
  ├─ new j$(taskId, onProgress, stdoutToFile=true)
  ├─ Opens output file fd
  ├─ spawn(cmd, {stdio: ["pipe", fd, fd]})  ← stdout → file directly
  │
  ▼
Returns IO7 (shell command wrapper), h = k.result (completion promise)
  │
  ▼
sLz continues:
  ├─ if (run_in_background) → return immediately with backgroundTaskId
  ├─ await Promise.race([h, setTimeout(null, Bc4=2000)])  ← 2s HEK wait
  ├─ j$.startPolling(taskId)  ← file polling starts HERE (too late!)
  ├─ Progress loop: while(true) { await race(h, resolverPromise) → yield }
  │     └─ onProgress fires from file poll → resolves promise → yield progress
  └─ Command finishes → return result
```

### Data flow (after patch)

```
sLz (bash generator)
  │
  ├─ Calls nE6() with onProgress
  │
  ▼
nE6() returns
  │
  ├─ [Part B] Emits bash_output_init with output file path  ← IMMEDIATE
  │     └─ GUI starts polling the file within 500ms
  │
  ▼
sLz continues:
  ├─ 2s HEK wait (output file being polled by GUI independently)
  ├─ j$.startPolling → onProgress fires
  │     └─ [Part A] Emits bash_output to stdout  ← supplements GUI polling
  └─ Command finishes → return result
```

### Key classes and functions

| Name (v2.1.105) | Purpose |
|---|---|
| `sLz` | Bash async generator — orchestrates command execution |
| `nE6` | Command runner — spawns process, returns `IO7` wrapper |
| `j$` | `TaskOutput` — manages output buffering, file spill, polling |
| `IO7` | `ShellCommand` — wraps child process, handles backgrounding |
| `xO7` | `StreamHandler` — bridges process stdout → `j$.writeStdout()` (only created when `onStdout` exists) |
| `wvz` | stdio config — returns `["pipe","pipe","pipe"]` or `["pipe",fd,fd]` |
| `nY` | Path generator — `nY(taskId)` → `<sessions-dir>/<taskId>.output` |

### Variable mapping (inside `sLz`)

| Variable | Meaning |
|---|---|
| `w` | Command string |
| `j` | Description |
| `O` | `toolUseId` |
| `$` | `agentId` |
| `k` | `IO7` shell command instance (returned by `nE6`) |
| `h` | `k.result` — promise that resolves when command finishes |
| `J` | `run_in_background` flag |
| `Bc4` | HEK timeout constant (2000ms) |
| `V` | `shouldAutoBackground` flag |

### Variable mapping (inside `nE6`)

| Variable | Meaning |
|---|---|
| `A` | `onProgress` callback |
| `j` | `onStdout` callback (undefined when called from `sLz`) |
| `R` | `!!j` — true if `onStdout` exists |
| `x` | Task ID from `vB("local_bash")` |
| `m` | `j$` (TaskOutput) instance — `new j$(x, A??null, !R)` |
| `S` | File descriptor for output file (opened when `!R`) |

## The Patches

### Part A: onProgress stdout hook

**Marker**: `/*PATCHED:bash-output-streaming*/`

#### Anchor (unique, 1 match)

```
onProgress(<5 vars>){<var>=<1st>,<var>=<2nd>,<var>=<3rd>,<var>=<5th>?<4th>:0;let <var>=<var>;if(<10th>)<11th>=null,<10th>()}
```

Regex:
```js
`onProgress\\((V),(V),(V),(V),(V))\\{` +
`(V)=\\1,(V)=\\2,(V)=\\3,(V)=\\5\\?\\4:0;` +
`let (V)=(V);if\\(\\10\\)\\11=null,\\10\\(\\)`
```

#### Before

```js
onProgress(p,m,S,g,F){P=p,X=m,D=S,W=F?g:0;let U=Z;if(U)Z=null,U()}
```

#### After

```js
onProgress(p,m,S,g,F){/*PATCHED:bash-output-streaming*/{let _bo_now=Date.now();
if(!globalThis._bo_map)globalThis._bo_map=new Map;
let _bo_k=O||"",_bo_last=globalThis._bo_map.get(_bo_k)||0;
if(_bo_now-_bo_last>=200){
  globalThis._bo_map.set(_bo_k,_bo_now);
  try{process.stdout.write(JSON.stringify({type:"bash_output",
    tool_use_id:O, output:m, full_output:p,
    total_lines:S, total_bytes:g
  })+"\n")}catch(_bo_e){}
}}P=p,X=m,D=S,W=F?g:0;let U=Z;if(U)Z=null,U()}
```

#### Rate limiting

Uses `globalThis._bo_map` (a `Map<toolUseId, lastEmitTimestamp>`) to rate-limit to 1 emission per 200ms per tool. This prevents flooding stdout when commands produce rapid output.

#### Why it's safe

- The injected code runs before the original callback body — original behavior is preserved
- `process.stdout.write` is wrapped in try/catch — failures are silently ignored
- `globalThis._bo_map` uses a unique prefix (`_bo_`) to avoid collisions
- The rate limit (200ms) prevents performance issues from rapid output
- Non-Bash tools never hit this code path (it's inside the bash-specific `onProgress`)

#### When it fires

Part A only fires when `j$.startPolling()` reads the output file and calls `onProgress`. Without Part B, this happens ~3s after the process spawns (after HEK timeout + first poll). With Part B, the GUI is already polling the file directly, so Part A serves as a supplementary data source.

### Part B: Early output file path emission

**Marker**: `/*PATCHED:bash-output-init*/`

#### Anchor

The `nE6()` result assignment immediately after the `onProgress` callback closure:

```
),<resultVar>=<bcVar>.result;
```

Regex:
```js
`\\),(${V})=(${V})\\.result;`
```

Found by searching within 2000 chars after the Part A anchor.

#### Before

```js
),h=k.result;async function E(){
```

#### After

```js
),h=k.result;/*PATCHED:bash-output-init*/try{process.stdout.write(JSON.stringify({type:"bash_output_init",tool_use_id:O,output_file:k.taskOutput.path})+"\n")}catch(_bi_e){}async function E(){
```

#### Why it's safe

- `k.taskOutput.path` is set during `j$` construction (before `nE6` returns) — always available
- Wrapped in try/catch — failures are silently ignored
- Emits once per `nE6()` call — no rate limiting needed
- The `bash_output_init` message type is new — no existing consumer will misinterpret it
- `k.taskOutput.path` is the same path that `j$.startPolling()` reads — no extra files

#### Dynamic variable extraction

Both `O` (toolUseId) and `k` (shell command) are extracted dynamically:

- `O` (toolUseId): found via `toolUseId:(V)[,}]` in the 2000 chars before `onProgress`
- `k` (bcVar): found via `),(V)=(V)\.result;` in the 2000 chars after `onProgress`

## Message Formats

### `bash_output` (Part A)

```json
{"type":"bash_output","tool_use_id":"toolu_XXX","output":"last 100 lines","full_output":"last 5 lines","total_lines":42,"total_bytes":1234}
```

| Field | Type | Description |
|---|---|---|
| `tool_use_id` | string | The tool_use block ID for this Bash invocation |
| `output` | string | Last ~100 lines of output (from `j$` ring buffer) |
| `full_output` | string | Last ~5 lines of output |
| `total_lines` | number | Total line count so far |
| `total_bytes` | number | Total byte count so far |

**Note:** The `output` and `full_output` field names are misleading (inherited from the `onProgress` callback semantics). `output` is actually the larger window (~100 lines) and `full_output` is the smaller window (~5 lines). This is because `onProgress` is called from `j$.startPolling()` with `(last5, last100, totalLines, totalBytes, hasMore)` — our patch captures param positions 1 and 2.

### `bash_output_init` (Part B)

```json
{"type":"bash_output_init","tool_use_id":"toolu_XXX","output_file":"/path/to/sessions/<taskId>.output"}
```

| Field | Type | Description |
|---|---|---|
| `tool_use_id` | string | The tool_use block ID for this Bash invocation |
| `output_file` | string | Absolute path to the output file being written by the child process |

## Consumer-Side Integration

### Main process (`claude-session.ts`)

**`bash_output_init` handler**: When received, creates a background file poller and starts 500ms polling immediately:

```ts
} else if (type === 'bash_output_init') {
  const toolUseId = (msg.tool_use_id as string) || ''
  const outputFile = (msg.output_file as string) || ''
  if (toolUseId && outputFile) {
    this.backgroundFilePaths.set(toolUseId, outputFile)
    if (!this.backgroundPollers.has(toolUseId)) {
      this.backgroundPollers.set(toolUseId, { filePath: outputFile, lastSize: 0, done: false })
      this.watchBackground(toolUseId)  // starts 500ms file polling
    }
  }
}
```

This reuses the existing `watchBackground` / `pollBackgroundFile` / `readTail` infrastructure that was already built for background bash commands.

**`bash_output` handler**: Forwards to the renderer as `session:bash-output` IPC event (unchanged from before Part B).

**Cleanup**: `markBackgroundDone(toolUseId)` is called when:
- A foreground tool result arrives (command completed)
- A task notification arrives (background task completed)

### Renderer (`ToolCallBlock.tsx`)

- Subscribes to `backgroundOutputs[toolUseId]` via `useActiveSession`
- Auto-expands the tool card when `bgOutput` arrives
- Renders `BackgroundBashOutput` component for both foreground and background bash when file polling data is available
- Falls back to `LiveBashOutput` (from `bash_output` events) if no file polling data

### Timeline comparison

**Before patch** (foreground bash):
```
t=0.0s  Process spawns
t=2.0s  HEK timeout resolves
t=2.0s  j$.startPolling() starts
t=3.0s  First poll reads file → onProgress → (no stdout emit)
t=∞     Command finishes → tool result arrives → GUI shows output
```

**After patch** (foreground bash):
```
t=0.0s  Process spawns
t=0.0s  bash_output_init emitted with file path
t=0.0s  GUI receives path → starts 500ms file polling
t=0.5s  First poll reads file → session:background-output → GUI shows output
t=1.0s  Second poll...
...
t=∞     Command finishes → cleanup
```

## How to Find This Code

### `sLz` (bash async generator)

```bash
bundle-analyzer find cli.js "onProgress" --compact
# Look for the match inside an async function* with toolUseId destructuring
```

### `nE6` (command runner / Bc equivalent)

```bash
bundle-analyzer find cli.js "onStdout" --compact
# The function that destructures {onProgress, onStdout, ...} from options
```

### `j$` (TaskOutput class)

```bash
bundle-analyzer find cli.js "stdoutToFile" --compact
# The class with taskId, path, stdoutToFile properties
```

### `wvz` (stdio config)

```bash
bundle-analyzer find cli.js '"pipe","pipe","pipe"' --compact
# Returns ["pipe","pipe","pipe"] or ["pipe",fd,fd]
```

### `nY` (output file path generator)

```bash
bundle-analyzer find cli.js ".output" --compact
# Pattern: function NAME(q){return JOIN(DIR(),`${q}.output`)}
```

### HEK timeout (2000ms)

```bash
bundle-analyzer find cli.js "setTimeout" --compact
# Look for: setTimeout((l)=>l(null),HEK_VAR,c).unref()
# In the bash generator, after the explicit background check
```

## Syntax Pitfalls

### Pitfall: Injecting statements into comma expressions

The code `let V=expr,k=await nE6(...)` is a single `let` declaration with comma-separated declarators. Injecting a `process.stderr.write(...)` between them creates:

```js
// WRONG — process becomes a let declarator name
let V=expr,process.stderr.write(...)
// SyntaxError: Unexpected token '.'

// CORRECT — inject BEFORE the let statement
process.stderr.write(...);let V=expr,k=await nE6(...)
```

### Pitfall: Newlines in minified code

`cli.js` is a single-line file. Using `"\n"` in injected strings creates a literal newline that breaks the JavaScript parser:

```js
// WRONG — literal newline in source
process.stderr.write("[TIMING] "+Date.now()+"\n")

// CORRECT — use runtime newline generation
process.stderr.write("[TIMING] "+Date.now()+String.fromCharCode(10))
// Or for stdout messages (which need \n for readline parsing):
process.stdout.write(JSON.stringify({...})+"\\n")  // \\n = escaped in the source string
```

**Always run `node --check cli.js` after applying patches.**

## What's NOT Changed

**The `onProgress` callback signature** — We inject code at the start of the callback body but don't change its parameters or return behavior. The original `P=p,X=m,...` assignments still run.

**The progress loop** — `j$.startPolling()` and the `while(true)` yield loop still work as before. Part A emits `bash_output` as a side effect; it doesn't replace the progress loop.

**Background bash path** — `run_in_background: true` still returns immediately. Part B emits `bash_output_init` for both foreground and background; the GUI starts polling either way.

**The 2-second HEK timeout** — We don't modify or bypass it. It still gates when `j$.startPolling()` starts. The improvement comes from the GUI polling the file independently via Part B.

## Verification

1. `node patch/bash-output-streaming/apply.mjs` — should apply both parts
2. Run again — should report "Already applied (both parts). Skipping."
3. `node --check node_modules/@anthropic-ai/claude-agent-sdk/cli.js` — no syntax errors
4. `node patch/apply-all.mjs` — all patches pass
5. Start the app, run a foreground Bash command (e.g., `for i in {1..10}; do echo $i; sleep 1; done`)
6. Output should appear in the tool card within ~1s of the command starting
7. Background bash (`run_in_background: true`) should also show output immediately

## Discovery Method

1. **Observed symptom**: Foreground bash output showed a ~4s delay before any output appeared in the UI.
2. **Added timing logs** to `claude-session.ts` — measured gap between assistant message arrival and first `bash_output` receipt.
3. **Injected timing into cli.js** at key points (before Bc, after Bc, HEK resolve, first onProgress). Results:
   - assistant message → before Bc: 16ms (instant)
   - before Bc → Bc returned: 868ms (process spawn)
   - Bc returned → HEK resolved: 2004ms (the 2s timeout)
   - HEK resolved → first onProgress: 1013ms (first file poll)
4. **Investigated why `onProgress` fires so late**: Discovered that `sLz` does NOT pass `onStdout` to `nE6`, so `stdoutToFile=true` even for foreground bash. stdout goes directly to a file via fd. `j$.writeStdout()` is never called. `onProgress` only fires from `j$.startPolling()`, which starts after HEK.
5. **Initial Part A (insufficient)**: The original patch hooked `onProgress` to emit `bash_output` to stdout. This worked, but only after HEK + first poll — still ~3s delay.
6. **Part B fix**: Emit the output file path immediately after `nE6()` returns. The GUI receives `bash_output_init`, creates a file poller, and starts reading output within 500ms. This bypasses both the HEK timeout and the `j$.startPolling()` delay.
7. **Verified full round-trip**: `bash_output_init` → `claude-session.ts` handler → `watchBackground` → `pollBackgroundFile` → `session:background-output` IPC → `BackgroundBashOutput` component → visible in UI within ~1.4s of process spawn.

## Key Functions Reference

| Name (v2.1.105) | Purpose | How to find |
|---|---|---|
| `sLz` | Bash async generator | `bundle-analyzer find cli.js "onProgress" --compact` near `toolUseId` |
| `nE6` | Command runner (spawns process) | `bundle-analyzer find cli.js "onStdout" --compact` |
| `j$` | TaskOutput (output buffering + file spill) | `bundle-analyzer find cli.js "stdoutToFile" --compact` |
| `IO7` | ShellCommand wrapper (DH7) | `bundle-analyzer find cli.js '"running"' --compact` near `taskOutput` |
| `xO7` | StreamHandler (stdout→TaskOutput bridge) | Near `IO7`, has `setEncoding("utf-8")` |
| `wvz` | stdio config function | `bundle-analyzer find cli.js '"pipe","pipe","pipe"' --compact` |
| `nY` | Output file path generator | `bundle-analyzer find cli.js ".output" --compact` |

**Note:** All minified names will change in future SDK versions. Use content patterns (string literals, structural shapes) to relocate code.

## Related Patches

- `patch/subagent-streaming/` — Handles message forwarding from subagent Task tool execution. Different code path but similar pattern of needing to bypass SDK buffering.
- `patch/background-task/` — Exposes the CLI's "send to background" feature. Uses `IO7.background()` which affects the same `j$` TaskOutput polling.

## Files

| File | Purpose |
|---|---|
| `README.md` | This document |
| `apply.mjs` | Patch script (Part A: onProgress hook, Part B: bash_output_init) |

# Patch: bash-output-streaming

Live Bash command output never reaches the stream-json consumer until the command finishes, or ~3 seconds after it starts — whichever comes first.

## Affected Component

`vendor/claude-cli/cli.js` — the vendored Claude Code bundle (`bun-claude`).

| Component            | Version                                                  |
| -------------------- | -------------------------------------------------------- |
| Original discovery   | SDK 0.2.97 → 0.2.105 / bundled `cli.js` 2.1.97 → 2.1.105 |
| Last verified anchor | **2.1.261** (chunked bundle — see "Bundle shape" below)  |

### Bundle shape (changed in 2.1.261)

Up to 2.1.241, `cli.js` was one monolithic minified CJS bundle. From 2.1.261 the upstream
build is code-split into ~1,631 minified **ESM chunks**, and the ClaudeUI rebundler
concatenates them into a single `vendor/claude-cli/cli.js`, each chunk preceded by

```
// @bun-chunk B:/~BUN/root/chunk-xxxxxxxx.js
```

Consequences for this patch:

- **Every minified identifier changed.** All names below are 2.1.261-era and will be wrong again next bump.
- **A regex must never match across a chunk delimiter.** Part B clamps its search window to the
  end of the enclosing chunk for exactly this reason.
- **A helper you inject a call to must be bound in the target chunk's scope.** Post-split, a class
  can reach a chunk as an imported binding under a chunk-local alias. Part B therefore reads the
  TaskOutput class name off an existing call site _inside the same chunk_ rather than searching
  globally for the class declaration.

Everything this patch touches lives in one chunk: **`chunk-9c0rs7w4.js`** (~5.6 MB, the tool
implementations chunk).

## The Problem

### Problem 1: no real-time output streaming

The Bash tool is an async generator (`ats` in 2.1.261). It passes an `onProgress` callback to the
command runner (`w6`), but the progress data only reaches the stream-json consumer through the
generator's own `yield {type:"progress",...}` loop, which starts **after** a 2-second race
(`Hnr=2000`). Commands shorter than that never yield progress at all — the GUI sees nothing until
the tool result lands.

### Problem 2: the file poll starts too late

Both foreground and background bash redirect stdout to an output file at the OS level (stdio
`["pipe", fd, fd]`), so `TaskOutput.writeStdout()` is never called from process output. The **only**
thing that ever fires `onProgress` is `TaskOutput.pollProgress()`, driven by a 1-second interval
(`ISr=1000`) that the generator starts with `aI.startPolling(...)` — and it starts that call only
_after_ the 2-second race returns.

Measured on 2.1.105: spawn 868 ms + HEK 2004 ms + first poll 1013 ms = **~3.9 s** before the first
byte of output was observable.

### Root cause: the generator never passes `onStdout`

`w6` destructures `{onProgress, onStdout, ...}` from its options. The bash generator passes
`onProgress` but not `onStdout`, so the runner takes the "stdout to file" branch:

```js
let {onProgress:k, ..., onStdout:U} = o          // U === undefined
// ...stdoutToFile = !U  → true → stdio ["pipe", fd, fd]
```

With `stdoutToFile` true there is no Node-side stream handler, no `writeStdout()`, and therefore no
`onProgress` except from the deferred poll.

## Architecture Overview

### Data flow (unpatched)

```
Bash tool .call()  →  ats()  (async generator, chunk-9c0rs7w4.js)
  │
  ├─ tn = await w6(cmd, signal, "bash", { ..., onProgress(){...} })
  │     └─ new aI(taskId, onProgress, stdoutToFile=true)   ← TaskOutput, registers itself
  │     └─ spawn(cmd, {stdio:["pipe", fd, fd]})            ← stdout → file, no Node pipe
  │
  ├─ let gn = tn.result                                    ← completion promise
  ├─ if (run_in_background) → return { backgroundTaskId }  ← never polls
  ├─ await Promise.race([gn, setTimeout(null, Hnr=2000)])  ← 2 s dead air
  ├─ aI.startPolling(tn.taskOutput.taskId)                 ← polling starts HERE (too late)
  ├─ try { while(true) { ... yield {type:"progress"} } }
  └─ finally { aI.stopPolling(tn.taskOutput.taskId); ... }
```

### Data flow (patched)

```
  ├─ tn = await w6(..., onProgress(){ [Part A] emit bash_output to stdout; ...original... })
  ├─ let gn = tn.result
  ├─ [Part B] aI.startPolling(tn.taskOutput.taskId)   ← polling starts NOW, ~2 s earlier
  ├─ if (run_in_background) → return { backgroundTaskId }   (still polling — see "Why it's safe")
  ├─ await Promise.race([gn, setTimeout(null, Hnr)])
  ├─ aI.startPolling(...)                              ← CLI's own call, now a no-op
  └─ ... unchanged ...
```

Part A and Part B are a pair: Part B makes `onProgress` fire early, Part A is what turns an
`onProgress` call into a wire message. Neither is useful alone.

### Key classes and functions (v2.1.261, all in `chunk-9c0rs7w4.js` unless noted)

| Name  | Kind     | Purpose                                                                               |
| ----- | -------- | ------------------------------------------------------------------------------------- |
| `ats` | fn\*     | Bash async generator — orchestrates the command, owns the progress loop               |
| `w6`  | async fn | Command runner — builds the exec command, spawns, returns a ShellCommand              |
| `aI`  | class    | **TaskOutput** — output ring buffers, file spill, `static startPolling/stopPolling`   |
| `hWe` | class    | **ShellCommand** — real spawned command; `cleanup()` → `taskOutput.clear()`           |
| `lAt` | class    | Aborted-before-exec ShellCommand stub (`status:"killed"`) — still has `taskOutput`    |
| `cD`  | fn       | Pre-spawn-error ShellCommand stub (`status:"completed"`) — still has `taskOutput`     |
| `oAt` | class    | Poll registry — `#e` registered instances, `#t` polling set, one shared `setInterval` |
| `lhe` | fn       | Host-scoped accessor for the `oAt` singleton                                          |
| `rnr` | fn       | Background-task watcher — on `result`, calls `snr` → `shellCommand.cleanup()`         |
| `Hnr` | const    | HEK timeout, `2000`                                                                   |
| `ISr` | const    | Poll interval, `1000`                                                                 |
| `yl`  | fn       | `taskId` → `<sessions-dir>/<taskId>.output` (imported from another chunk)             |

### Variable mapping (inside `ats`)

| Variable | Meaning                                                               |
| -------- | --------------------------------------------------------------------- |
| `ke`     | command string                                                        |
| `Me`     | description                                                           |
| `M`      | `toolUseId` (destructured from the generator's single options object) |
| `F`      | `agentId`                                                             |
| `De`     | `run_in_background` flag                                              |
| `tn`     | ShellCommand instance returned by `w6`                                |
| `gn`     | `tn.result` — resolves when the command finishes                      |
| `Wt`     | progress-loop resolver (`null` when the loop is not waiting)          |
| `je`     | last-5-lines window (the callback's 1st param)                        |
| `He`     | last-100-lines window (the callback's 2nd param)                      |
| `Ve`     | total lines                                                           |
| `et`     | total bytes                                                           |
| `Pt`     | "background forbidden" flag                                           |
| `ut`     | background task id, once backgrounded                                 |

### `onProgress` callback contract

`aI.pollProgress()` calls the callback as

```js
this.#s(e.slice(d), e.slice(f), k, r, t < r)
//      ^last 5     ^last 100   ^lines ^bytes ^hasMore
```

so the parameter order is `(last5, last100, totalLines, totalBytes, hasMore)`. The 4th param is
only meaningful when the 5th is truthy — hence the `et=Zr?Kn:0` in the callback body, which is the
structural fingerprint Part A anchors on.

## The Patches

### Part A: emit `bash_output` from `onProgress`

**Marker**: `/*PATCHED:bash-output-streaming*/`

#### Anchor (unique, 1 match)

Structural shape, no literals needed:

```
onProgress(<p1>,<p2>,<p3>,<p4>,<p5>){<a>=<p1>,<b>=<p2>,<c>=<p3>,<d>=<p5>?<p4>:0;let <e>=<r>;if(<e>)<r>=null,<e>()}
```

Regex in `apply.mjs`:

```js
;`onProgress\\((${V}),(${V}),(${V}),(${V}),(${V})\\)\\{` +
  `(${V})=\\1,(${V})=\\2,(${V})=\\3,(${V})=\\5\\?\\4:0;` +
  `let (${V})=(${V});if\\(\\10\\)\\11=null,\\10\\(\\)\\}`
```

**Why it is unique.** 2.1.261 has exactly four `onProgress(` occurrences in the whole concat:

| Offset      | Chunk               | Shape                                                                    |
| ----------- | ------------------- | ------------------------------------------------------------------------ |
| ~9,070,524  | `chunk-9c0rs7w4.js` | **the target** — bash, with the `let Br=Wt;if(Br)Wt=null,Br()` resolver  |
| ~20,004,080 | `chunk-98vnsjhm.js` | PowerShell tool — same 4 assignments, **no resolver tail**               |
| ~15,891,569 | `chunk-jkzh538b.js` | `de.onProgress(ge.data)` — an agent-runner call, not a method definition |
| ~19,657,603 | `chunk-f8rcj764.js` | `this.sink?.onProgress(w)` — same                                        |

The `let <e>=<r>;if(<e>)<r>=null,<e>()` resolver tail is what excludes PowerShell. **PowerShell is
deliberately not patched** — its generator has no resolver promise and a different progress loop.
If a future bundle makes the two shapes converge, the uniqueness assertion in `apply.mjs` will fail
loudly rather than patch the wrong one; do not weaken it to "first match wins".

#### toolUseId capture

`M` is read out of the 2,000 chars _before_ the anchor with `toolUseId:(V)[,}]`. In 2.1.261 that
window contains exactly one match — the generator's own parameter destructuring
(`...,toolUseId:M,attributionMessageId:N,agentId:F,...` at anchor −723). Note the same window later
contains `sandboxAttributionId:M`, which is the _same variable_ but would not match the pattern.

#### Before (2.1.261, pristine)

```js
onProgress(hn,vt,Fn,Kn,Zr){je=hn,He=vt,Ve=Fn,et=Zr?Kn:0;let Br=Wt;if(Br)Wt=null,Br()}
```

#### After

```js
onProgress(hn,vt,Fn,Kn,Zr){/*PATCHED:bash-output-streaming*/{let _bo_now=Date.now();
if(!globalThis._bo_map)globalThis._bo_map=new Map;
let _bo_k=M||"",_bo_last=globalThis._bo_map.get(_bo_k)||0;
if(_bo_now-_bo_last>=200){
  globalThis._bo_map.set(_bo_k,_bo_now);
  try{process.stdout.write(JSON.stringify({type:"bash_output",
    tool_use_id:M, output:vt, full_output:hn,
    total_lines:Fn, total_bytes:Kn
  })+"\n")}catch(_bo_e){}
}}je=hn,He=vt,Ve=Fn,et=Zr?Kn:0;let Br=Wt;if(Br)Wt=null,Br()}
```

(Injected as one line; wrapped here for readability. The `"\n"` is `"\\n"` in the apply script —
see Syntax Pitfalls.)

#### Rate limiting

`globalThis._bo_map` is a `Map<toolUseId, lastEmitMs>`, throttling to one message per 200 ms per
tool use so a chatty command can't flood stdout.

#### Why it's safe

- The injected block is a bare `{...}` statement placed _before_ the original body; every original
  assignment and the resolver call still run, unchanged.
- `process.stdout.write` is inside try/catch — a closed/blocked stdout can't take down the CLI.
- `_bo_`-prefixed globals avoid collisions with the bundle and with other patches.
- Only the bash generator's callback is patched, so no other tool reaches this code.

### Part B: start the file poll as soon as the runner returns

**Marker**: `/*PATCHED:bash-early-poll*/`

This is the part that actually removes the delay. Part A alone only fires once the CLI's own
(late) `startPolling` gets around to it.

#### Anchor

Two-step capture, in this order:

1. **The CLI's own call**, which yields _both_ the TaskOutput class binding and the ShellCommand
   variable — `.startPolling(` and `.taskOutput.taskId` are property names and survive minification:

   ```js
   new RegExp(`(${V})\\.startPolling\\((${V})\\.taskOutput\\.taskId\\)`, 'g')
   // 2.1.261 → aI.startPolling(tn.taskOutput.taskId)
   ```

   Taking the class name from a call site _inside the target chunk_ is what guarantees the
   identifier we inject is in scope there (post-split it might be an imported alias).

2. **The result-promise assignment for that same variable**, which is the injection point:

   ```js
   new RegExp(`(?:\\),|;let )(${V})=${reEsc(shellCmdVar)}\\.result;`, 'g')
   // 2.1.261 → ;let gn=tn.result;      (the `;let ` alternative)
   // <=2.1.241 → ),h=k.result;         (the `),` alternative — one comma expression)
   ```

Both searches run over a window that starts at the Part A anchor, is 4,000 chars long, and is
clamped to the next `\n// @bun-chunk ` delimiter. Both assert **exactly one** match.

Window sizing: in 2.1.261 the `.result` assignment sits at anchor +527 and the CLI's own
`startPolling` at anchor +1775 in the pristine file. Part A has already injected ~450 chars into
that window by the time Part B runs, pushing `startPolling` to ~+2225 — which is why the window is
4,000 and not the old 3,000.

#### Before (2.1.261, pristine)

```js
...storageV5:ye})}catch(hn){throw Le?.(),hn}if(tn.status==="killed")Le?.();let gn=tn.result;if(Le)gn.then((hn)=>{if(hn.preSpawnError)Le()}).catch(()=>{});async function Qt(){...
```

#### After

```js
...storageV5:ye})}catch(hn){throw Le?.(),hn}if(tn.status==="killed")Le?.();let gn=tn.result;/*PATCHED:bash-early-poll*/aI.startPolling(tn.taskOutput.taskId);if(Le)gn.then((hn)=>{if(hn.preSpawnError)Le()}).catch(()=>{});async function Qt(){...
```

#### Why it's safe

Four separate properties were verified against 2.1.261 source:

1. **`taskOutput` always exists.** Every return path of `w6` produces something with a
   `taskOutput`: the real `hWe` ShellCommand, the aborted-before-exec stub `lAt`
   (`constructor(){this.taskOutput=new aI(...)}`), and the pre-spawn-error stub `cD`
   (`return {status:"completed", ..., taskOutput:t, ...}`). No `undefined` deref.

2. **`startPolling` is idempotent.** The registry is
   `startPolling(e){if(this.#t.set(e.taskId,e),!this.#n)this.#n=setInterval(()=>this.#r(),ISr),this.#n.unref()}`
   — a `Map.set` plus one shared, `unref`'d interval. The CLI's later call is a no-op.

3. **Calling it too early is inert, not wrong.** `aI.static startPolling(e)` does
   `let r=t.registeredInstance(e); if(!r||!r.#s) return;` — for the stub paths the TaskOutput was
   constructed with `onProgress = null` and never registered, so the call silently does nothing.

4. **Nothing leaks a poller.** Every way out of the generator still stops it:
   - normal progress loop → `finally{ aI.stopPolling(tn.taskOutput.taskId); ... }`
   - command finished inside the HEK race → `return tn.cleanup(), hn` → `hWe.cleanup()` →
     `taskOutput.clear()` → `aI.stopPolling(...)` + `unregister(...)`
   - explicit `run_in_background` and auto-backgrounded returns → `jne()` registers `rnr`, whose
     `shellCommand.result.then(...)` runs `snr()` → `taskOutput.flush()` + `shellCommand.cleanup()`.

Point 4 is the one to re-verify on every bump — it is the only thing standing between this patch
and an interval that keeps re-reading a finished command's output file and emitting `bash_output`
forever.

There is one intended behavior change: **backgrounded commands now stream too.** Unpatched, an
explicitly backgrounded command returns before `startPolling` is ever reached, so nothing polls it;
patched, polling is already running, so `bash_output` keeps flowing for the life of the background
task. That is what the GUI's background bash cards want.

## Message Format

### `bash_output` — the only message this patch emits

```json
{
  "type": "bash_output",
  "tool_use_id": "toolu_XXX",
  "output": "last ~100 lines",
  "full_output": "last ~5 lines",
  "total_lines": 42,
  "total_bytes": 1234
}
```

| Field         | Type   | Description                                |
| ------------- | ------ | ------------------------------------------ |
| `tool_use_id` | string | tool_use block ID for this Bash invocation |
| `output`      | string | last ~100 lines (callback param 2)         |
| `full_output` | string | last ~5 lines (callback param 1)           |
| `total_lines` | number | total line count so far                    |
| `total_bytes` | number | total byte count so far                    |

**The `output` / `full_output` names are backwards** and always have been: `output` is the _larger_
(~100-line) window and `full_output` the _smaller_ (~5-line) one, because the patch maps callback
param 2 → `output` and param 1 → `full_output`. The consumer only reads `output`, so this is a
naming wart, not a bug. Don't "fix" it without changing `BashOutputMessage` in
`src/core/sdk/types.ts` and `handleBashOutput` together.

Delivered via direct `process.stdout.write`, like every other ClaudeUI patch that adds a message
type (see `docs/protocol-cc/03-inbound-messages.md`).

## Consumer-Side Integration

```
cli.js Part A stdout
  → ClaudeSession stream-json reader
  → case 'bash_output': handleBashOutput()        src/core/services/claude-session.ts:1058
  → this.send('session:bash-output', {toolUseId, output, totalLines, totalBytes})
  → volatile TAIL lane (src/core/shared/sync/channels.ts)
  → renderer: bashOutputs[toolUseId]  →  LiveBashOutput inside ToolCallBlock
```

`BashOutputMessage` is declared in `src/core/sdk/types.ts`; the field names there must match the
JSON emitted by Part A. `session:bash-output` is a _volatile_ sync lane — it has no snapshot field
and is listed in `sealed-fields.ts` as `bashOutputs`, so dropped frames are acceptable by design.

`src/main/__tests__/patches.test.ts` asserts that **both** markers
(`/*PATCHED:bash-output-streaming*/` and `/*PATCHED:bash-early-poll*/`) are present in the built
binary. Renaming a marker breaks that test.

## How to Find This Code

`bundle-analyzer.cmd` (global, at `C:\Users\why20\.local\bin\bundle-analyzer.cmd`; call it _with_
the `.cmd` extension from Git Bash) works on the concat. Plain `rg` / a `node -e` offset script is
an equally good fallback and is what was used for the 2.1.261 re-anchor.

### The bash generator (`ats`) — best single entry point

```bash
bundle-analyzer.cmd find cli.js '"tengu_bash_command_explicitly_backgrounded"' --compact
# exactly 1 hit in 2.1.261, ~1.6 KB after the onProgress anchor, inside the generator
```

### The `onProgress` callback (Part A anchor)

```bash
bundle-analyzer.cmd find cli.js 'onProgress(' --compact
# 4 hits; the target is the one whose body ends `let X=Y;if(X)Y=null,X()`
```

### The startPolling call + TaskOutput class (Part B step 1)

```bash
bundle-analyzer.cmd find cli.js '.taskOutput.taskId)' --compact
# the bash generator has two: the CLI's own late call, and the one in the finally's stopPolling
```

### The TaskOutput class (`aI`) and the poll registry (`oAt`)

```bash
bundle-analyzer.cmd find cli.js 'stdoutToFile' --compact
# the class with taskId / path / stdoutToFile fields and static startPolling/stopPolling
```

### The command runner (`w6`)

```bash
bundle-analyzer.cmd find cli.js 'onStdout' --compact
# 4 hits; the runner is the one destructuring {onProgress, ..., onStdout} from its options
```

### The HEK timeout constant (`Hnr`)

```bash
rg -o 'Hnr=[0-9]+' vendor/claude-cli/cli.js
# 2.1.261 → Hnr=2000; used as setTimeout((x)=>x(null),Hnr,resolve).unref()
```

### Which chunk am I in?

```bash
node -e "const s=require('fs').readFileSync('vendor/claude-cli/cli.js','utf-8');
const i=<offset>; const b=s.lastIndexOf('// @bun-chunk ',i);
console.log(s.slice(b, s.indexOf('\n', b)), 'rel', i-b)"
```

## Syntax Pitfalls

### Pitfall: injecting a statement into a comma-separated declarator list

Up to 2.1.241 the injection site was in the middle of `let V=expr,k=await run(...)`. Splicing a
statement between declarators produces a parse error:

```js
// WRONG — `process` becomes a declarator name
let V=expr,process.stdout.write(...)
// SyntaxError: Unexpected token '.'

// CORRECT — inject before the whole `let`, or after its terminating `;`
process.stdout.write(...);let V=expr,k=await run(...)
```

2.1.261 is friendlier (`let gn=tn.result;` is its own statement), but the Part B regex still
requires the trailing `;` to be part of the match so the injection can only ever land at a
statement boundary. Keep it that way.

### Pitfall: literal newlines in injected source

Chunk bodies are one enormous line each. A real newline inside injected code changes nothing
semantically here, but a newline inside a _string literal_ is a parse error:

```js
// WRONG — literal newline inside the source string
process.stdout.write(JSON.stringify(x)+"
")

// CORRECT — escaped in the apply script so the file gets a two-char \n escape
process.stdout.write(JSON.stringify(x)+"\\n")
// or, when an escape is awkward:
process.stdout.write(s+String.fromCharCode(10))
```

Note that a real newline in _injected code_ would also split the concat's chunk reconstruction if
it happened to look like a delimiter — never emit a line starting with `// @bun-chunk`.

### Pitfall: regexes that bridge chunks

Any `[\s\S]*?` span wide enough to cross a `\n// @bun-chunk ` delimiter can match two unrelated
modules. This patch has no such span, and Part B additionally clamps its window to the chunk edge.

**Always syntax-check after applying.** For the chunked bundle, `node --check` on the whole concat
is meaningless (it is not a valid single module); check the modified chunk instead:

```bash
node -e "const fs=require('fs'); const s=fs.readFileSync('vendor/claude-cli/cli.js','utf-8');
const b=s.indexOf('/*PATCHED:bash-early-poll*/');
const st=s.lastIndexOf('// @bun-chunk ',b), h=s.indexOf('\n',st)+1;
let e=s.indexOf('\n// @bun-chunk ',b); e=e===-1?s.length:e+1;
fs.writeFileSync(process.env.SCRATCH+'/chunk.mjs', s.slice(h,e))" \
  && node --check "$SCRATCH/chunk.mjs"
# SCRATCH = any writable scratch dir (2.1.261: the chunk is ~5.6 MB)
```

(The repo's rebundler does this for you with esbuild on every chunk the patches touched.)

## What's NOT Changed

**The `onProgress` signature and body.** Part A prepends a block; the original assignments and
resolver call are untouched.

**The progress loop and the CLI's own `startPolling`/`stopPolling`.** Part B adds a call, it does
not move or remove one. `bash_output` is a side channel, not a replacement for `yield
{type:"progress"}`.

**The 2-second HEK race (`Hnr`).** Deliberately left alone — it gates when the tool _result_ path
gives up waiting, and shortening it would change tool semantics. The patch removes the _output_
delay without touching it.

**The PowerShell tool.** `chunk-98vnsjhm.js` has a near-identical `onProgress`, but no resolver
promise and a different loop. It has never been patched. Adding it would need its own anchor and
its own uniqueness proof.

**`onStdout`.** Passing it to the runner would flip `stdoutToFile` to false and reroute output
through Node pipes — a much larger behavioral change (it also changes what ends up in the
`.output` file that `BashOutput` reads). Rejected in favour of polling earlier.

## Verification

1. `node patch/bash-output-streaming/apply.mjs` — applies both parts, exits 0.
2. Run it again — "Already applied (both parts). Skipping.", exits 0.
3. Delete only the Part B injection and re-run — Part A reports "already applied", Part B
   re-applies. (The `apply.mjs` fallback anchor exists for exactly this half-patched state.)
4. Syntax-check the modified chunk (see Syntax Pitfalls). Expect exit 0.
5. `node patch/apply-all.mjs` — all patches pass.
6. `bun run test` — `src/main/__tests__/patches.test.ts` checks both markers in the built binary.
7. `node patch/bash-output-streaming/test.mjs` — behavioral; spawns the **real** rebundled binary,
   so it only runs in the main repo after `bun run ensure-cli`, not in a bare worktree.
8. Manual: run `for i in $(seq 1 20); do echo "line-$i"; sleep 0.2; done` in the app. Output should
   appear in the tool card within ~1 s, not ~4 s. Repeat with `run_in_background: true`.

## Discovery Method

1. **Observed symptom**: foreground bash output showed a ~4 s delay before anything appeared.
2. **Timed the consumer** in `claude-session.ts` — gap between the assistant message and the first
   `bash_output`.
3. **Injected timing probes into cli.js** at four points (before/after the runner, HEK resolve,
   first `onProgress`): 16 ms → runner call, 868 ms spawn, 2004 ms HEK, 1013 ms first poll.
4. **Found the real cause**: the generator never passes `onStdout`, so `stdoutToFile` is true,
   stdout bypasses Node entirely, and `onProgress` can only come from the deferred file poll.
5. **First fix (insufficient)**: Part A alone. It emits correctly, but only starts emitting after
   HEK + first poll — still ~3 s.
6. **Rejected fix**: emitting a `bash_output_init` message carrying `taskOutput.path` so the GUI
   could poll the file itself. It worked, but it duplicated polling logic on the consumer side and
   made the main process responsible for a path the CLI owns. Superseded by Part B; **no
   `bash_output_init` consumer exists in the app** — if you find that message type described
   anywhere else, it is stale.
7. **Part B**: call the CLI's _own_ `startPolling` as soon as the runner returns. One statement, no
   new message type, no consumer changes, and every existing stop path already covers it.

### 2.1.261 re-anchor (chunked bundle)

- Part A's regex survived untouched — the callback shape is unchanged; only the names moved
  (`p,m,S,g,F` → `hn,vt,Fn,Kn,Zr`, `O` → `M`, `Z` → `Wt`).
- Part B's `\),(V)=(V)\.result;` failed: `ERROR: Cannot find Bc result assignment after onProgress.`
  Upstream wrapped the runner call in `try{...}catch(hn){throw Le?.(),hn}` and split the result
  assignment out into its own statement, `if(tn.status==="killed")Le?.();let gn=tn.result;`. The
  regex now accepts `),` **or** `;let `.
- The capture order was inverted while re-anchoring: the old script derived the ShellCommand
  variable from the `.result` assignment and then looked for `startPolling`. The new one reads both
  the class binding and the variable off the `startPolling` call first, then constrains the
  `.result` regex to that exact variable. This is both stricter and chunk-safe.
- Window widened 3,000 → 4,000 and clamped to the chunk edge.

## Key Functions Reference

| Name (v2.1.261)        | Purpose                                   | Char offset (pristine concat) | Chunk               |
| ---------------------- | ----------------------------------------- | ----------------------------- | ------------------- |
| `ats`                  | Bash async generator                      | ~9,069,640                    | `chunk-9c0rs7w4.js` |
| `onProgress`           | Part A anchor                             | ~9,070,524                    | `chunk-9c0rs7w4.js` |
| `;let gn=tn.result;`   | Part B match start (inject after its `;`) | ~9,071,051 (anchor +527)      | `chunk-9c0rs7w4.js` |
| `aI.startPolling(...)` | CLI's own late call                       | ~9,072,299 (anchor +1,775)    | `chunk-9c0rs7w4.js` |
| `aI.stopPolling(...)`  | the `finally` stop                        | ~9,073,784 (anchor +3,260)    | `chunk-9c0rs7w4.js` |
| `w6`                   | Command runner                            | ~6,599,698                    | `chunk-9c0rs7w4.js` |
| `aI`                   | TaskOutput class                          | ~5,413,043                    | `chunk-9c0rs7w4.js` |
| `oAt`                  | Poll registry                             | ~5,412,488                    | `chunk-9c0rs7w4.js` |
| `hWe`                  | ShellCommand class                        | ~5,417,792                    | `chunk-9c0rs7w4.js` |
| `Hnr=2000`             | HEK timeout                               | ~9,049,694                    | `chunk-9c0rs7w4.js` |

**Note:** all minified names and offsets change on every bump. Use the string literals and
structural shapes in "How to Find This Code" to relocate.

## Related Patches

- `patch/subagent-streaming/` — different code path, same theme: bypassing SDK-side buffering so
  the GUI can render while work is in flight.
- `patch/background-task/` — exposes the CLI's send-to-background feature, which drives the same
  `aI` TaskOutput polling this patch starts early.

## Files

| File        | Purpose                                                                |
| ----------- | ---------------------------------------------------------------------- |
| `README.md` | This document                                                          |
| `apply.mjs` | Patch script (Part A: `onProgress` hook; Part B: early `startPolling`) |
| `test.mjs`  | Behavioral test — needs the real rebundled binary                      |

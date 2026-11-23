# Patch: bash-output-streaming

Live Bash command output never reaches the stream-json consumer until the command finishes, or ~3 seconds after it starts — whichever comes first.

## Affected Component

`vendor/claude-cli/cli.js` — the vendored Claude Code bundle (`bun-claude`).

| Component            | Version                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| Original discovery   | SDK 0.2.97 → 0.2.105 / bundled `cli.js` 2.1.97 → 2.1.105                                        |
| Last verified anchor | **2.1.330** (chunked bundle — see "Bundle shape" below; Part A re-anchored 2.1.321 and 2.1.330) |

Unpatched (Anthropic's own binary), Bash output still reaches the consumer only through the CLI's own
`progress` messages, from ~2 s after the command starts; the app has no `bash_output` frames to draw.

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
  │     (2.1.330+: onProgress:ws.call, ws = new Wrapper((...)=>{ [Part A] ...original... }))
  ├─ let gn = tn.result
  ├─ [Part B] aI.startPolling(tn.taskOutput.taskId)   ← polling starts NOW, ~2 s earlier
  ├─ if (run_in_background) → return { backgroundTaskId }   (still polling — see "Why it's safe";
  │                                                           2.1.330+: nothing emitted after the return)
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

The callback's **body** is the anchor. It has had the same shape since 2.1.97:

```
<a>=<p1>,<b>=<p2>,<c>=<p3>,<d>=<p5>?<p4>:0;let <e>=<r>;if(<e>)<r>=null,<e>()
```

Two **heads** have carried it. `apply.mjs` lists both in `SHAPES`; each is tried pristine
(`head + BODY + tail`) and already-patched (`head + marker`), and the total across all four
searches must be exactly 1:

| Shape     | Versions   | Head                                         | Tail |
| --------- | ---------- | -------------------------------------------- | ---- |
| `wrapped` | 2.1.330+   | `new <W>((p1,p2,p3,p4,p5)=>{`                | `})` |
| method    | <= 2.1.326 | `onProgress(p1,p2,p3,p4,p5){` + `lateGuard?` | `}`  |

```js
const P5 = `\\((${V}),(${V}),(${V}),(${V}),(${V})\\)`
const BODY =
  `(${V})=\\1,(${V})=\\2,(${V})=\\3,(${V})=\\5\\?\\4:0;` +
  `let (${V})=(${V});if\\(\\10\\)\\11=null,\\10\\(\\)`
// wrapped: head `new ${V}\\(${P5}=>\\{`, tail `\\}\\)`
// method:  head `onProgress${P5}\\{(?:${lateGuard})?`, tail `\\}`
```

Neither head adds a capture group, so groups 1-5 are the params and 10/11 the resolver temp and
resolver in both shapes. The injection point is the end of the head (`^head` re-run on the match).

**2.1.330: the callback moved into a disposable wrapper.** The runner option is no longer a method;
the generator builds the callback as an arrow, wraps it, and passes the wrapper's `call`:

```js
// 2.1.330, darwin (pristine concat), generator jGi, char 16954181
using ws=new _eo((fi,fs,hi,Ea,gl)=>{lo=fi,Dn=fs,Ho=hi,To=gl?Ea:0;let Ii=Jo;if(Ii)Jo=null,Ii()});
let wr,rs,hs,Es;try{...,wr=await Xrt(ln,be.signal,"bash",{timeout:Es,owningAgentId:ct,caller:it,
  turnAbortBackgrounds:hs,onProgress:ws.call,session:Oe,...})}catch(fi){throw Lo?.(),fi}
// char 16672654, same chunk
class _eo{#e;constructor(e){this.#e=e}call=(...e)=>this.#e?.(...e);[Symbol.dispose](){this.#e=null}}
```

`_eo` **is the CLI's late-call guard now.** `using` disposes `ws` when the generator's scope exits
(return or throw), dispose nulls the arrow, and every later poll hits `this.#e?.(...)` and is
dropped. Part A goes **inside the arrow**, downstream of the wrapper, so a call the CLI drops never
reaches the SDK stream either — the same rule as the 2.1.321 guard below. The PowerShell tool uses
the same class (`using qe=new _eo((Q,ee,oe,te,ye)=>{we=Q,me=ee,Je=oe,Ue=ye?te:0})`, no resolver).

For the wrapped shape, `apply.mjs` also proves the arrow is the runner's option: the 64 chars
before the match must end `<X>=` (the wrapper's binding, `ws`), and `onProgress:<X>.call[,}]` must
occur exactly once within 4,000 chars after the match (2.1.330: ~350).

**Bash runner literal (both shapes).** The 400 chars before the `onProgress` option (the method
itself, or `onProgress:ws.call`) must contain `,"bash",{` — the runner call's shell-name argument,
`Xrt(ln,be.signal,"bash",{...` (2.1.330, ~95 chars before). PowerShell's call reads
`"powershell",{`. This puts a string literal under an otherwise purely structural anchor.

**Optional late-callback guard (2.1.321 only).** 2.1.321 opened the method body with a guard that
drops the first stray call after the command is killed/completed:

```js
// 2.1.321, darwin, char 15727659
onProgress(Si,pa,qa,kl,dl){if(!so&&!Pn&&(Nr.status==="killed"||Nr.status==="completed")){Pn=!0;return}No=Si,co=pa,Ho=qa,yo=dl?kl:0;let ed=Rr;if(ed)Rr=null,ed()}
```

`apply.mjs` accepts it as an optional group in the method head (`lateGuard`, keyed on the
`"killed"` / `"completed"` literals), and Part A is injected **after** the guard. 2.1.326 dropped the
guard again (`onProgress(Pi,aa,ul,fs,ca){jn=Pi,Hn=aa,Ln=ul,oo=ca?fs:0;let Zi=Ko;if(Zi)Ko=null,Zi()}`,
pristine darwin concat, char 16942066), and 2.1.330 replaced it with the wrapper.

**Why it is unique.** In 2.1.330 (darwin and win32 alike) there are exactly two five-parameter
arrows passed to `new <W>(`, and no five-parameter `onProgress(` method at all:

| Offset (darwin) | Chunk               | Shape                                                                   |
| --------------- | ------------------- | ----------------------------------------------------------------------- |
| 16,954,181      | `chunk-bzyb60p0.js` | **the target** — bash, with the `let Ii=Jo;if(Ii)Jo=null,Ii()` resolver |
| 31,024,932      | `chunk-e5txm7fq.js` | PowerShell tool — same 4 assignments, **no resolver tail**              |

2.1.261 had the same pair as methods (bash at ~9,070,524, PowerShell at ~20,004,080) plus two
`onProgress(` calls that are not definitions (`de.onProgress(ge.data)`, `this.sink?.onProgress(w)`).

The `let <e>=<r>;if(<e>)<r>=null,<e>()` resolver tail is what excludes PowerShell. **PowerShell is
deliberately not patched** — its generator has no resolver promise and a different progress loop.
If a future bundle makes the two shapes converge, the uniqueness assertion in `apply.mjs` will fail
loudly rather than patch the wrong one; do not weaken it to "first match wins". Note that the same
resolver tail also appears elsewhere in the 2.1.330 generator (`let Ii=Jo;if(Ii)Jo=null,Ii();` in
the auto-background helper), but not right after the four assignments, so it does not match.

#### toolUseId capture

The emitted `tool_use_id` must be the Bash generator's **own destructured parameter**. `apply.mjs`
reads it from the generator head, never from a nearby `toolUseId:` (2.1.330 has
`toolUseId:g.toolUseId` in the tool's `call()` just before the generator and `toolUseId:Ve` in
calls inside it):

1. The last `async function*` in the 6,000 chars before the anchor (chunk-clamped). 2.1.330:
   `async function*jGi({input:e,...,toolUseId:Ve,attributionMessageId:Xe,...,startTelemetry:En}){`,
   1,358 chars before the anchor; 2.1.326: `zxi`, 1,533 chars.
2. Its parameter list must be one flat destructured object, `^async function\*[\w$]*\(\{([^(){}]*)\}\)\{`
   on at most 3,000 chars (a default with parens or braces fails closed).
3. `toolUseId:(V)` must occur exactly once in that list.
4. The name must not be one of the callback's five params or its `let` resolver temp (group 10). The
   callback never reads `toolUseId`, so a minifier is free to reuse the name inside it; the injected
   code would then read the shadowing binding, or throw in the `let` temporal dead zone.

The callback is defined directly in the generator body, so the parameter is in scope there.

#### Before (2.1.330, pristine, wrapped shape)

```js
using ws = new _eo((fi, fs, hi, Ea, gl) => {
  ;((lo = fi), (Dn = fs), (Ho = hi), (To = gl ? Ea : 0))
  let Ii = Jo
  if (Ii) ((Jo = null), Ii())
})
```

#### After (2.1.330)

```js
using ws = new _eo((fi, fs, hi, Ea, gl) => {
  /*PATCHED:bash-output-streaming*/ {
    let _bo_now = Date.now()
    if (!globalThis._bo_map) globalThis._bo_map = new Map()
    let _bo_k = Ve || '',
      _bo_last = globalThis._bo_map.get(_bo_k) || 0
    if (_bo_now - _bo_last >= 200) {
      globalThis._bo_map.set(_bo_k, _bo_now)
      try {
        process.stdout.write(
          JSON.stringify({
            type: 'bash_output',
            tool_use_id: Ve,
            output: fs,
            full_output: fi,
            total_lines: hi,
            total_bytes: Ea
          }) + '\n'
        )
      } catch (_bo_e) {}
    }
  }
  ;((lo = fi), (Dn = fs), (Ho = hi), (To = gl ? Ea : 0))
  let Ii = Jo
  if (Ii) ((Jo = null), Ii())
})
```

#### Before (2.1.261, pristine, method shape)

```js
onProgress(hn,vt,Fn,Kn,Zr){je=hn,He=vt,Ve=Fn,et=Zr?Kn:0;let Br=Wt;if(Br)Wt=null,Br()}
```

#### After (2.1.261)

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
- 2.1.330: the block sits inside the arrow, behind `_eo.call`'s `this.#e?.(...)`. After the
  generator's scope disposes the wrapper, the CLI drops every poll before it reaches the arrow, and
  Part A with it. 2.1.326 is byte-identical to the old script's output (the method shape).

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
   // 2.1.321 → c5.startPolling(Nr.taskOutput.taskId,so)   (optional 2nd arg, see below)
   ```

   2.1.321 added a second parameter, `static startPolling(e,n=!0)`, stored as the "read the output
   file" flag (`false` makes `pollProgress` call `onProgress("","",0,0,!1)` without reading). The regex takes the second arg as `(?:,(V))?`.
   The CLI computes it right before its own call: `so=!(n&&Mji()),c5.startPolling(id,so)`. `n` is
   `progressTextUnread`, always true on the SDK path ClaudeUI uses; `Mji()` is a server-side
   GrowthBook gate (`tengu_lazy_pumpkin`, off today). When the gate turns on, `so` becomes `false`,
   `pollProgress` stops reading the output file and calls `onProgress("","",0,0,!1)`, and Part A would
   forward empty `bash_output` frames: live output goes blank after ~2 s. **Part B therefore pins the
   flag**: it rewrites `so=!(n&&Mji())` to `/*PATCHED:bash-poll-flag*/so=!0` (the 2.1.319 behaviour),
   keeping the variable so the late-callback guard and other readers stay consistent.

   The rewrite is anchored on the CLI's own call: `(V)=!\((V)&&V\(\)\),<class>.startPolling(<cmd>.taskOutput.taskId,\1)`
   (the assignment target must be the call's 2nd argument; class and command names are the ones bound
   in step 1; the gate function is not named). Exactly one match in the window or the patch aborts;
   a one-arg call (<= 2.1.319) logs and skips. The whole of Part B is guarded by the early-poll marker,
   so it is idempotent. The one-arg early call we inject (default `!0`) matches the pinned value. The
   search window is 6000 chars from the Part A anchor.

   **2.1.326 reverted the second parameter.** `static startPolling(e)` is one-argument again,
   `pollProgress` always reads the output file (the `#h` "read" flag is gone), and the
   `tengu_lazy_pumpkin` gate is no longer in the bundle. The CLI's own call is
   `aX.startPolling(Oo.taskOutput.taskId)` (pristine darwin concat, char 16945007). Part B therefore takes the one-arg
   branch, and nothing needs pinning: the apply log reads `One-arg startPolling (all but 2.1.321): no
poll flag to pin.` 2.1.330 is one-argument too (`one.startPolling(wr.taskOutput.taskId)`). The
   `bash-poll-flag` rewrite stays in `apply.mjs` for a bundle that brings the parameter back.

   Taking the class name from a call site _inside the target chunk_ is what guarantees the
   identifier we inject is in scope there (post-split it might be an imported alias).

2. **The result-promise assignment for that same variable**, which is the injection point:

   ```js
   new RegExp(`(?:\\),|;let )(${V})=${reEsc(shellCmdVar)}\\.result;`, 'g')
   // 2.1.330 → ;let Ms=wr.result;      (the `;let ` alternative, since 2.1.261)
   // 2.1.261 → ;let gn=tn.result;
   // <=2.1.241 → ),h=k.result;         (the `),` alternative — one comma expression)
   ```

Both searches run over a window that starts at the Part A anchor, is 6,000 chars long
(`PART_B_WINDOW`), and is clamped to the next `\n// @bun-chunk ` delimiter. Both assert **exactly
one** match.

Window sizing: Part A has already injected ~450 chars into the window by the time Part B runs. The
CLI's own `startPolling` sits at anchor +1,775 (2.1.261), ~+2,940 (2.1.326) and +3,270 (2.1.330,
measured from the `new _eo(` match) in the pristine file, so ~+3,720 after Part A; the `.result`
assignment at +527 (2.1.261) and +994 (2.1.330). The window went 3,000 → 4,000 → 6,000 as the
generator grew.

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

**Re-verified on 2.1.330** (generator `jGi`, TaskOutput `one`, registry accessor `txe`): the
registry `startPolling` is still `Map.set` + one `unref`'d interval; `static startPolling(e)` still
returns when the instance is unregistered or has no callback; the pre-spawn stub is
`BT(e,o){let r=new one(OT("local_bash"),null);return{status:"completed",...,taskOutput:r,...,cleanup(){}}}`
(callback `null`, never registered); the exit paths are the race (`if(fi!==null)return
wr.cleanup(),$zo(fi)`), the explicit and auto-background returns (`BSt({...,shellCommand:wr,...})`
or the served-background `adopt(wr,...)`), and the progress loop's
`finally{if(one.stopPolling(wr.taskOutput.taskId),...`.

Point 4 is the one to re-verify on every bump — it is the only thing standing between this patch
and an interval that keeps re-reading a finished command's output file and emitting `bash_output`
forever.

Up to 2.1.326 there was one intended behavior change: **backgrounded commands streamed too.**
Unpatched, an explicitly backgrounded command returns before `startPolling` is ever reached, so
nothing polls it; patched, polling is already running, so `bash_output` kept flowing for the life of
the background task (the task panel's `TaskEntry` draws `bashOutputs[toolUseId]` for a Bash task).

**2.1.330 ends that.** The callback now sits behind the `_eo` wrapper, which `using` disposes when the
generator returns. A backgrounded command's generator returns (`{backgroundTaskId}`) while the
command keeps running; Part B's poll keeps reading the output file every second, but
`ws.call` → `this.#e?.(...)` is a no-op from then on, so Part A emits nothing. An explicit
`run_in_background` returns before the first 1 s poll tick, so it emits nothing at all; an
auto-backgrounded command streams until it is moved, then its tail freezes. Part A deliberately
stays downstream of the wrapper (a call the CLI drops never reaches the SDK stream). Restoring
background streaming would mean teeing the call _before_ the wrapper, at `onProgress:ws.call`,
which forwards exactly the calls the CLI now drops.

What that costs, measured on 2.1.330 in the real app (2026-11-23): nothing the user sees. ClaudeUI
tails a background command's `.output` file itself (`ClaudeSession.watchBackground`, every 500 ms; the
file is named in the tool result) into `backgroundOutputs`, which the inline Bash card and the Tasks
panel draw. For an explicit `run_in_background` loop, an auto-backgrounded one (timeout) and a
"Send to background" one, both kept growing line by line to the end while `bash_output` stopped at
the move. Only `bashOutputs[id]` in the store goes stale from the move to completion, and nothing
visible reads it then. Accepted as is (no tee before the wrapper); Part B's early poll still re-reads a
backgrounded command's file every second and discards the result.

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

### The bash generator (`ats` 2.1.261, `jGi` 2.1.330) — best single entry point

```bash
bundle-analyzer.cmd find cli.js '"tengu_bash_command_explicitly_backgrounded"' --compact
# exactly 1 hit, inside the generator: ~1.6 KB after the anchor in 2.1.261, ~2.6 KB in 2.1.330
```

### The `onProgress` callback (Part A anchor)

```bash
# 2.1.330+: the option is a wrapper's .call; 2 hits, bash ("bash",{ just before) and PowerShell
bundle-analyzer.cmd find cli.js 'onProgress:%V%\.call\b' --regex --compact
# the wrapper's binding (`using ws=new _eo(`) and the arrow sit ~350 chars before the bash hit

# <= 2.1.326: a method on the options object; the target is the one whose body ends
# `let X=Y;if(X)Y=null,X()` (2.1.261: 4 `onProgress(` hits, PowerShell's has no resolver)
bundle-analyzer.cmd find cli.js 'onProgress(' --compact
```

### The disposable wrapper class (`_eo`, 2.1.330)

```bash
bundle-analyzer.cmd find cli.js 'call=(...e)=>this.#e?.(...e)' --compact
# 1 hit: class _eo{#e;constructor(e){this.#e=e}call=(...e)=>this.#e?.(...e);[Symbol.dispose](){this.#e=null}}
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
modules. This patch has no such span. Only the anchor search scans the whole file (each pattern
starts at a literal, `onProgress(` or `new `, and has no open-ended span); every search after it
runs on a fixed-size slice clamped to the enclosing chunk (`GEN_LOOKBACK`, `GEN_PARAMS_MAX`,
`WRAPPER_SITE_WINDOW`, `BASH_CALL_LOOKBACK`, `PART_B_WINDOW` at the top of `apply.mjs`).

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

### Pitfall: exiting with `process.exit()` (the 2.1.330 "hang")

`apply.mjs` never calls `process.exit()`, on success or failure. It returns an exit code from
`main()`, sets `process.exitCode`, and lets Node exit by itself; an unexpected throw is caught and
turned into exit code 1 the same way.

```js
// WRONG — with the ~60 MB bundle in the heap this can hang forever at 0% CPU (Node 26.3, macOS arm64)
if (!anchorMatch) { console.error('ERROR: ...'); process.exit(1) }

// CORRECT
function main() { /* ... */ if (!hit) return fail('ERROR: ...') /* ... */ return 0 }
try { process.exitCode = main() } catch (err) { console.error(err); process.exitCode = 1 }
```

`process.exit()` runs Node's default exit handler, which disposes the V8 platform and joins its
worker threads _without_ tearing the isolate down first. A worker that is mid-way through a
concurrent baseline (Sparkplug) compile and needs a GC parks in
`CollectionBarrier::AwaitCollectionBackground`, waiting for the main thread to collect; the main
thread is in `uv_thread_join` waiting for the worker. `sample <pid>` on a hung run shows exactly
those two stacks. A natural exit disposes the isolate first, which wakes the parked worker.

It is timing-dependent and not tied to a platform's bundle. In the error path on the 2.1.330
bundles, the old script hung in 6 and 13 of 30 runs (win32 input) and 2 of 30 (darwin input); the
rewritten one in 0 of 125 (50 error, 50 skip, 25 write runs). The script that hung for 21 hours inside
`check-patches-cross-platform.mjs` was the old one on win32-x64, exiting through `process.exit(1)`
after Part A failed to anchor. `subagent-streaming/apply.mjs`, `voice-server/apply.mjs` and
`apply-all.mjs` still call `process.exit()` after reading the bundle and can hit the same deadlock.

## What's NOT Changed

**The `onProgress` signature and body.** Part A prepends a block; the original assignments and
resolver call are untouched.

**The progress loop and the CLI's own `startPolling`/`stopPolling`.** Part B adds a call, it does
not move or remove one. `bash_output` is a side channel, not a replacement for `yield
{type:"progress"}`.

**The 2-second HEK race (`Hnr`).** Deliberately left alone — it gates when the tool _result_ path
gives up waiting, and shortening it would change tool semantics. The patch removes the _output_
delay without touching it.

**The PowerShell tool.** It has a near-identical callback (2.1.261: `chunk-98vnsjhm.js`; 2.1.330:
`chunk-e5txm7fq.js`, wrapped in the same `_eo` class), but no resolver promise and a different
loop. It has never been patched. Adding it would need its own anchor and its own uniqueness proof.

**The `_eo` wrapper (2.1.330).** Its dispose is what drops late calls, and Part A stays behind it.
The wrapper class, its `using` binding and the `onProgress:ws.call` option are untouched.

**`onStdout`.** Passing it to the runner would flip `stdoutToFile` to false and reroute output
through Node pipes — a much larger behavioral change (it also changes what ends up in the
`.output` file that `BashOutput` reads). Rejected in favour of polling earlier.

## Verification

1. `node patch/bash-output-streaming/apply.mjs` — applies both parts, exits 0.
2. Run it again — "Already applied (both parts). Skipping.", exits 0.
3. Delete only the Part B injection and re-run — Part A reports "already applied", Part B
   re-applies. (The patched-shape search, `head + marker`, exists for exactly this half-patched
   state.)
4. Syntax-check the modified chunk (see Syntax Pitfalls). Expect exit 0.
5. `node scripts/check-patches-cross-platform.mjs --version <new>`, then `--version <previous>`:
   every platform `ok` (linux rebundle `skip (ELF)`). Run it under a timeout (e.g. Python
   `subprocess.run(..., timeout=900)`): the checker's own `spawnSync` calls have none.
6. On a scratch copy, run the script ~30 times in a loop with a per-run timeout, on the error, skip
   and write paths: no run may hang (see "exiting with `process.exit()`").
7. `node patch/apply-all.mjs` — all patches pass.
8. `bun run test` — `src/main/__tests__/patches.test.ts` checks both markers in the built binary.
9. `node patch/bash-output-streaming/test.mjs` — behavioral; spawns the **real** rebundled binary,
   so it only runs in the main repo after `bun run ensure-cli`, not in a bare worktree.
10. Manual: run `for i in $(seq 1 20); do echo "line-$i"; sleep 0.2; done` in the app. Output should
    appear in the tool card within ~1 s, not ~4 s. With `run_in_background: true`, 2.1.326 streamed
    into the task panel; 2.1.330 shows nothing live once the call returns (Part B "Why it's safe").

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

### 2.1.321 re-anchor

- Part A: `ERROR: Cannot locate the bash onProgress callback.` — the body gained the late-callback
  guard above in front of the four assignments. Optional `lateGuard` group in the anchor, injection
  moved to after it.
- Part B: `ERROR: expected exactly 1 <TaskOutput>.startPolling(...) call ... found 0` — the CLI's call
  is now `startPolling(id,so)`. Optional second argument in the regex; the injected call stays
  one-arg.

### 2.1.326 (no re-anchor)

- Applied unchanged on win32-x64, darwin-arm64 and linux-x64. Both optional forms that 2.1.321
  introduced are gone again: Part A's anchor has no late-callback guard, and Part B meets the
  one-argument `startPolling(id)` (see above). darwin apply log (on the cross-platform build, after the other patches): `onProgress` at char 16942257;
  TaskOutput class `aX`, shellCommand `Oo`, `.result` assignment `;let as=Oo.result;`; both markers
  verified. Everything sits in one chunk, `chunk-4h798pp0.js` (≈5.9 MB).

### 2.1.330 re-anchor

- Part A: `ERROR: Cannot locate the bash onProgress callback.` on all three platforms. The runner
  option became `onProgress:ws.call`, and the callback an arrow passed to `using ws=new _eo(...)`, a
  class whose `call` forwards to the arrow until `[Symbol.dispose]` nulls it. The body is unchanged.
  `SHAPES` now lists both heads (`new W(` arrow, `onProgress(` method); the wrapped shape is
  confirmed by its binding and a single `onProgress:<binding>.call`, and both shapes by the
  `,"bash",{` literal before the option.
- toolUseId: the old "first `toolUseId:V[,}]` in the 2,000 chars before the anchor" was replaced by
  the enclosing generator's own destructured parameter, plus a shadowing check against the callback's
  params and `let` temp (see "toolUseId capture"). 2.1.326 binds the same `Fe` either way.
- Part B: unchanged and one-argument (`one.startPolling(wr.taskOutput.taskId)`, `;let Ms=wr.result;`).
- The cross-platform check hung for 21 hours on win32-x64. Not a regex: the old script's
  `process.exit(1)` after the Part A failure deadlocked Node's shutdown (see Syntax Pitfalls). The
  script now exits naturally, and every post-anchor search is a fixed, chunk-clamped slice.
- Behavior change from the wrapper: backgrounded commands stop streaming once the tool call returns
  (Part B "Why it's safe", last paragraph).
- darwin apply log (after subagent-streaming): callback at char 16954181, wrapper `ws`,
  params `fi,fs,hi,Ea`, toolUseId `Ve`, TaskOutput `one`, shellCommand `wr`, `;let Ms=wr.result;`;
  win32: char 17107429, TaskOutput `Xte`, `;let Ps=wr.result;`. Both parts sit in one chunk
  (`chunk-bzyb60p0.js` darwin, `chunk-8dxpsdkx.js` win32); the patched chunk passes `node --check`.
  On 2.1.326 the new script's injections are byte-identical to the old script's.

## Key Functions Reference

| Name (v2.1.330, darwin) | Purpose                                      | Char offset (pristine concat) | Chunk               |
| ----------------------- | -------------------------------------------- | ----------------------------- | ------------------- |
| `jGi`                   | Bash async generator                         | 16,952,823                    | `chunk-bzyb60p0.js` |
| `new _eo((fi,...)=>{`   | Part A anchor (the wrapped arrow)            | 16,954,181                    | `chunk-bzyb60p0.js` |
| `onProgress:ws.call`    | the runner option                            | 16,954,530 (anchor +349)      | `chunk-bzyb60p0.js` |
| `;let Ms=wr.result;`    | Part B injection point                       | anchor +994                   | `chunk-bzyb60p0.js` |
| `one.startPolling(...)` | CLI's own late call                          | anchor +3,270                 | `chunk-bzyb60p0.js` |
| `_eo`                   | disposable callback wrapper (late-call drop) | 16,672,654                    | `chunk-bzyb60p0.js` |
| `one`                   | TaskOutput class (`static startPolling`)     | ~11,431,049                   | `chunk-bzyb60p0.js` |
| `BT`                    | pre-spawn-error ShellCommand stub            | 11,444,882                    | `chunk-bzyb60p0.js` |

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
- `patch/background-task/` (deleted at 2.1.280, ADR-079) exposed the CLI's Ctrl+B
  send-to-background feature, which drives the same `aI` TaskOutput polling this patch starts
  early. The app now reaches that feature through cli.js's native `background_tasks` control
  request (`docs/protocol-cc/07-control-outbound.md` §7.3).

## Files

| File        | Purpose                                                                |
| ----------- | ---------------------------------------------------------------------- |
| `README.md` | This document                                                          |
| `apply.mjs` | Patch script (Part A: `onProgress` hook; Part B: early `startPolling`) |
| `test.mjs`  | Behavioral test — needs the real rebundled binary                      |

# Patch: voice-server

Exposes the CLI's built-in voice transcription pipeline (Deepgram via Anthropic's WebSocket proxy) to external clients through a lightweight TCP server, enabling our Electron UI to stream microphone audio for speech-to-text without directly calling Anthropic's undocumented voice API.

## Affected Component

`@anthropic-ai/claude-agent-sdk` — bundled `cli.js` (in this repo: `vendor/claude-cli/cli.js`).

| Component              | Version at time of discovery | Last re-anchored |
| ---------------------- | ---------------------------- | ---------------- |
| SDK package            | 0.2.81                       | —                |
| Bundled CLI (`cli.js`) | (minified, ~12.4 MB)         | **2.1.261**      |

The SDK bundles its own CLI, independent of the native `claude` binary.

## The Problem

The CLI's `/voice` slash command provides push-to-talk voice input using Deepgram speech-to-text (via Anthropic's WebSocket proxy at `/api/ws/speech_to_text/voice_stream`). This feature is entirely self-contained in cli.js — it captures audio from the local microphone (via a native NAPI module or sox/arecord), opens a WebSocket to Anthropic's proxy, streams audio, and receives transcripts.

For our Electron UI, we need voice input but:

1. **Cannot call the voice API directly** — the endpoint is undocumented and authenticated via OAuth. Calling it from our process would violate TOS.
2. **Cannot stream audio through the JSON stdin protocol** — the SDK's stdin transport is newline-delimited JSON, designed for control messages, not high-frequency binary audio.
3. **Cannot use cli.js's native mic capture** — cli.js spawns sox/arecord or uses a NAPI module for recording. We capture audio in Electron's main process instead (using the same NAPI module from the SDK's vendor directory).

**Solution**: Patch cli.js to accept a control request that starts a TCP server on localhost. Our Electron app connects to this server, streams base64-encoded PCM audio over newline-delimited JSON, and receives transcripts back. The voice pipeline inside cli.js (OAuth, Deepgram WebSocket, transcript handling) remains untouched.

## The chunked bundle (CC ≥ 2.1.261) — read this first

Up to 2.1.241, cli.js was **one** minified CJS bundle: every function was in the same lexical scope, so the injection could name the voice-stream function directly.

Since 2.1.261 the CLI ships as **~1,631 minified ESM chunks**, and `vendor/claude-cli/cli.js` is their concatenation in module-graph order. Each chunk is preceded by a delimiter line:

```
// @bun-chunk B:/~BUN/root/chunk-xxxxxxxx.js
```

Consequences that shape this patch:

- **Cross-chunk names are not in scope.** The voice stream function lives in one chunk; the control-request dispatch loop lives in another. A bare `Snn(...)` at the injection site is a `ReferenceError`.
- **Reaching it means importing it.** `apply.mjs` therefore reads the voice chunk's `export{…}` list and injects
  `let{Snn:__vfn}=await import("B:/~BUN/root/chunk-01qep85r.js")`.
  This is the bundle's own idiom: 2.1.261 contains **1,083** `await import("B:/~BUN/root/chunk-….js")` call sites across 567 distinct chunks, one of them (`chunk-wdwcp2mj.js`, the `workflow_launch` handler) inside this very dispatch loop, a few hundred bytes after our injection. Bun's standalone module graph resolves those specifiers by flat path lookup (`StandaloneModuleGraph::find_ref` / `find_assume_standalone_path`), the same lookup a static import uses, so importing an already-embedded chunk by its literal specifier is sound.
- **Dynamic import, not a new static import.** The bundler partitions chunks: 868 are statically imported, 567 dynamically, with **zero overlap**. The voice chunk is in the static set (imported by two voice-UI chunks) but those importers are themselves lazily loaded. Adding a static `import` to the dispatch chunk would drag the voice chunk — and `ws` — into startup. The dynamic import preserves the current laziness.
- **No regex may span a delimiter.** `apply.mjs` asserts every match is free of `@bun-chunk`, and re-verifies after writing that the injection landed inside the anchor's chunk.

### Chunk map for 2.1.261

| Chunk                            | Contains                                                                    |
| -------------------------------- | --------------------------------------------------------------------------- |
| `B:/~BUN/root/chunk-01qep85r.js` | Voice pipeline. `export{_nn,bnn,Snn}` — probe, availability check, stream fn |
| `B:/~BUN/root/chunk-gj501zgt.js` | The stream-json stdin loop (`[print.ts]` logs) and its control-request chain |

Neither name is stable — derive both from string literals (see **How to Find This Code**).

## Architecture Overview

### Data Flow

```
Electron Main Process                    cli.js (patched)
┌──────────────────────┐                ┌──────────────────────────┐
│ audio-capture.node   │                │                          │
│ (16kHz i16LE mono)   │                │  TCP Server (port N)     │
│         │            │                │       │                  │
│         ▼            │   TCP socket   │       ▼                  │
│ VoiceClient ─────────┼───────────────►│  readline JSON parser    │
│  base64 encode       │                │       │                  │
│  JSON + newline      │                │       ▼                  │
│         ▲            │                │  Snn() voice stream fn   │
│         │            │   TCP socket   │  (Deepgram via Anthropic)│
│ transcript events ◄──┼───────────────◄│       │                  │
│         │            │                │       ▼                  │
│         ▼            │                │  onTranscript callbacks  │
│ IPC → renderer       │                │  → JSON back to client   │
└──────────────────────┘                └──────────────────────────┘
```

### The voice stream function (`hb8` v0.2.81 → `fFl` 2.1.241 → `Snn` 2.1.261)

`voiceStream(callbacks, options, credentials?)`. It:

1. Resolves an OAuth token — with `credentials` when the vault gate is on, otherwise the ambient path
2. Constructs a WebSocket URL to `BASE_API_URL/api/ws/speech_to_text/voice_stream` (or the
   `VOICE_STREAM_BASE_URL` env override) with query params:
   - `encoding=linear16`, `sample_rate=16000`, `channels=1`
   - `endpointing_ms=300`, `utterance_end_ms=1000`
   - `language=<code>` (default `"en"`)
   - `use_conversation_engine=true` (2.1.261; replaced the old `stt_provider=deepgram-nova3`)
   - `forward_interims=typed` when `CLAUDE_CODE_VOICE_FORWARD_INTERIMS_TYPED` / gate `tengu_brick_follow`
   - keyterms ride in the `x-config-keyterms` **header** (2.1.261), not the query string
3. Returns a stream object with `.send(buffer)`, `.finalize()`, `.close()`, `.isConnected()`
4. Calls `callbacks.onReady(stream)` when the WebSocket connects
5. Calls `callbacks.onTranscript(text, isFinal)` for interim/final transcripts
6. Calls `callbacks.onError(message, meta?)` and `callbacks.onClose()` on failures

**Signature** (2.1.261, minified name `Snn`, chunk `01qep85r`):

```js
async function Snn(e,s,d){let u;if(L()&&d!==void 0)await bs({credentials:d}),u=await Qi(d);
else await bs(),u=Xt();if(!u?.accessToken)return n("[voice_stream] No OAuth token available"),null;…}
// e = { onTranscript, onError, onClose, onReady }
// s = { language, keyterms }
// d = credentials (optional; we omit it → ambient auth path, pre-2.1.241 behaviour)
```

The patch passes **two** arguments deliberately. With `d === undefined` the `L()&&d!==void 0`
guard is false, so the function takes the ambient `bs(); Xt()` auth path.

### Control Request Handler

The CLI processes control requests in a `for await` loop inside an async generator. Each control request has a `subtype` field. The handler is a chain of `if/else if` blocks wrapped in `try/finally` and ending with a fallback warning. Our patch injects new `else if` branches before the fallback.

Skeleton in 2.1.261 (`chunk-gj501zgt.js`):

```js
for await(let r of t.structuredInput){
  …
  let N="uuid" in r?r.uuid:void 0;
  …
  if(r.type==="control_request"){
    let kt=!1,Cn=(T)=>{…},gn=(T)=>{…};
    try{
      if(r.request.subtype==="interrupt"){…}
      else if(r.request.subtype==="stop_task"){…}
      …
      /* ← INJECTION GOES HERE */
      else Be(r,`Unsupported control request subtype: ${Xn(String(r.request.subtype))}`)
    }finally{if(N&&!kt)t.onCommandLifecycle?.(N,"completed")}
    continue
  }else if(r.type==="control_response"){…}
```

**Key variables at the injection site**:

| Variable    | v0.2.81         | 2.1.261 | Purpose                                                 |
| ----------- | --------------- | ------- | ------------------------------------------------------- |
| `msgVar`    | `W6`            | `r`     | The control request message being processed             |
| `warnFn`    | (first capture) | `Be`    | `function(f,M){wt.enqueue(_B(f.request_id,M))}` — error |
| `successFn` | `n`             | `Xe`    | `function(f,M){wt.enqueue(A5(f.request_id,M))}` — ok    |

`successFn(msgVar, responseData)` yields a `control_response` back through the SDK transport.

### Why `await` Works in the Injection

The control request handler is inside a `for await (let r of t.structuredInput)` loop body within an async generator function. This means:

- `await` is syntactically valid (we're in an async context)
- `await` pauses the loop iteration (blocking other message processing briefly)
- This is acceptable because server startup takes <1 ms (binding to port 0 on localhost) plus one lazy chunk import

Our `continue` is inside the `try`, so the `finally` runs first — it only reports command-lifecycle completion, exactly as it does for every other subtype branch that `continue`s (`stop_task`, `background_tasks`, …).

## TCP Protocol

Newline-delimited JSON over a TCP socket on `127.0.0.1`. Audio data is base64-encoded within JSON messages to avoid binary framing complexity.

### Client → Server

```json
{"type":"voice_start","language":"en","keyterms":["MyProject","API"]}
{"type":"audio","data":"<base64-encoded 16kHz i16LE mono PCM>"}
{"type":"audio","data":"<base64>"}
{"type":"voice_stop"}
```

### Server → Client

```json
{"type":"ready"}
{"type":"transcript","text":"hello world","isFinal":false}
{"type":"transcript","text":"hello world,","isFinal":true}
{"type":"error","message":"Connection closed: code 1006"}
{"type":"closed"}
```

### Audio Format

16 kHz, 16-bit signed little-endian, mono PCM (`linear16`). Each chunk is ~342 bytes raw, ~456 bytes base64-encoded. At ~95 chunks/second, total bandwidth is ~47 KB/s through a localhost TCP socket — negligible.

### Buffering

Audio chunks may arrive before the Deepgram WebSocket connects (the `onReady` callback fires asynchronously). The injected code buffers chunks in `__buf[]` and flushes them when `onReady` fires.

## The Patch

Part B (sdk.mjs) was removed — `voiceServerStart()` / `voiceServerStop()` now live in `src/main/sdk/`. Only Part A remains.

### Part A — cli.js: Voice Server Control Requests

**Marker**: `/*PATCHED:voice-server*/`

#### Anchor (unique, 1 match)

The control-request fallback warning — the same anchor `queue-control`, `background-task` and `usage-relay` use:

```
else Be(r,`Unsupported control request subtype: ${Xn(String(r.request.subtype))}`)
```

Regex (tolerates both the pre- and post-2.1.261 shapes):

```js
else ([\w$]+)\(([\w$]+),`Unsupported control request subtype: \$\{(?:[\w$]+\(String\()?\2\.request\.subtype(?:\)\))?\}`\)
```

Two version notes baked into that pattern:

- **Tail-less since 2.1.219.** The dispatch chain is wrapped in `try/finally`, so the old
  `;continue}else if(MSG.type==="control_response")` tail no longer directly follows the fallback.
- **Sanitised subtype since 2.1.261.** The echoed subtype went from `${r.request.subtype}` to
  `${Xn(String(r.request.subtype))}` — hence the optional `SANITIZE(String(` … `))` wrapper.
  The `\2` backref (message variable must match) is what keeps it from matching neighbours.

Sites that must **not** match, all present in 2.1.261:

| Site                                                                          | Why it doesn't match          |
| ----------------------------------------------------------------------------- | ----------------------------- |
| SDK Query transport: `throw Error("Unsupported control request subtype: "+…)` | string concat, no `else X(…,` |
| `[DirectConnect] Unsupported control request subtype: …`                      | bracketed tag before the text |
| `[RemoteSessionManager] Unsupported control request subtype: …`               | bracketed tag, no `else `     |
| device-hooks `switch` default: `` error:`Unsupported control request…` ``      | object property, no `else `   |

#### Dynamic name extraction

**Voice stream function** — found by the unique literal `[voice_stream] No OAuth token available`
near the function start:

```js
const voiceFnRe =
  /async function ([\w$]+)\(([\w$]+),([\w$]+)(?:,[\w$]+)?\)\{[\s\S]{0,300}?\[voice_stream\] No OAuth token available/
```

The optional third parameter appeared in 2.1.241 (credentials). The body-prefix gap is
`[\s\S]{0,300}?` — not `[^}]{0,200}` — because the prefix now contains braces
(`bs({credentials:d})`).

**Voice chunk specifier + export name** — the chunk is the `// @bun-chunk …` delimiter preceding
the match; the exported name comes from parsing that chunk's `export{…}` list for the captured
local name (2.1.261: `export{_nn,bnn,Snn}` → `Snn` is exported under its own name).

**successFn** — found globally by `),X(MSG,{})}catch` (2 sites in 2.1.261, both `Xe`; the script
requires all sites to agree on the name *and* to live in the anchor's chunk):

```js
const successRe = /\),([\w$]+)\(r,\{\}\)\}catch/ // "r" = the captured msgVar
```

A windowed search around the anchor is wrong here: sibling patches shift the anchor and push the
original site out of any fixed lookback window.

#### finalize timeouts — the trap that used to need `us1()`

`finalize()` reads a `{safety,noData}` timeout pair:

```js
var R='{"type":"KeepAlive"}',U='{"type":"CloseStream"}',
    z="/api/ws/speech_to_text/voice_stream",D=8000,b={safety:5000,noData:1500};
…
let c=setTimeout(()=>_?.("safety_timeout"),b.safety),
    r=setTimeout(()=>_?.("no_data_timeout"),b.noData);
```

Up to 2.1.241 that object was built inside a **lazy CJS-style module initializer**
(`var us1=L(()=>{…bs1={safety:5000,noData:1500}})`). The CLI's own `/voice` code triggered it
through its module dependency chain; our patch bypassed that chain, so it had to call `us1()`
before the voice fn or `finalize()` threw
`TypeError: Cannot read properties of undefined (reading 'safety')`.

**In 2.1.261 the wrapper is gone.** The object is a plain top-level `var` in the voice chunk, so
`await import(voiceChunk)` initialises it as part of module evaluation. `apply.mjs` no longer
emits an initializer call, and instead asserts the three facts that make that safe:

1. exactly one `{safety:N,noData:N}` site in the whole concat,
2. it lives in the **same chunk** as the voice fn (so importing that chunk initialises it),
3. the old lazy-wrapper pattern does **not** match anywhere.

If a future version re-lazifies it, check (3) fails loudly and the injection must call the
initializer again — which, in a chunked bundle, also means the initializer has to be **exported**
from its chunk so the injection can import it.

#### Before

```js
else Be(r,`Unsupported control request subtype: ${Xn(String(r.request.subtype))}`)}finally{…}continue}
```

#### After (2.1.261, real output)

```js
/*PATCHED:voice-server*/else if(r.request.subtype==="voice_server_start"){
  let __vsp=await(async()=>{
    if(globalThis.__vs)return{port:globalThis.__vs.address().port};
    let{Snn:__vfn}=await import("B:/~BUN/root/chunk-01qep85r.js");
    let{createServer:__cs}=await import("node:net");
    let{createInterface:__ci}=await import("node:readline");
    let __s=__cs((__c)=>{
      let __st=null,__buf=[];
      let __rl=__ci({input:__c});
      let __send=(__o)=>{try{__c.write(JSON.stringify(__o)+"\n")}catch{}};
      __rl.on("line",(__l)=>{
        let __m;try{__m=JSON.parse(__l)}catch{return}
        if(__m.type==="voice_start"){
          let __lang=__m.language||"en";
          __vfn({
            onTranscript:(__t,__f)=>{__send({type:"transcript",text:__t,isFinal:__f})},
            onError:(__e)=>{__send({type:"error",message:String(__e)})},
            onClose:()=>{__send({type:"closed"});__st=null},
            onReady:(__x)=>{
              __st=__x;
              for(let __b of __buf)__x.send(__b);
              __buf=[];
              __send({type:"ready"})
            }
          },{language:__lang,keyterms:__m.keyterms||[]}).then((__r)=>{
            if(!__r)__send({type:"error",message:"Failed to connect voice stream"})
          },(__e)=>{__send({type:"error",message:String(__e&&__e.message||__e)})})
        }else if(__m.type==="audio"){
          let __b=Buffer.from(__m.data,"base64");
          if(__st)__st.send(__b);else __buf.push(__b)
        }else if(__m.type==="voice_stop"){
          if(__st)__st.finalize().then(()=>{if(__st){__st.close();__st=null}}).catch(()=>{})
        }
      });
      __c.on("close",()=>{if(__st){__st.close();__st=null}__buf=[]});
      __c.on("error",()=>{})
    });
    await new Promise((__res)=>__s.listen(0,"127.0.0.1",__res));
    globalThis.__vs=__s;
    return{port:__s.address().port}
  })();
  Xe(r,__vsp);continue
}else if(r.request.subtype==="voice_server_stop"){
  if(globalThis.__vs){globalThis.__vs.close();globalThis.__vs=null}
  Xe(r,{stopped:!0});continue
}else Be(r,`Unsupported control request subtype: ${Xn(String(r.request.subtype))}`)}finally{…}continue}
```

`Snn`, `Xe`, `Be`, `r` and the chunk hash are 2.1.261 names — all extracted at apply time.

#### Why It's Safe

- **Node.js built-ins only** for the transport: `import("node:net")` / `import("node:readline")` are always available regardless of bundler state
- **One extra chunk import**, by a specifier already present in the module graph, using the idiom the bundle itself uses at 1,083 call sites
- **`globalThis.__vs`**: the server persists across control requests and can be stopped later. Single instance — if already running, returns the existing port. The memoised path short-circuits before the import, which is fine: the running server closed over `__vfn` at first start.
- **No interference with CLI voice**: the CLI's own `/voice` command uses sox/arecord + the same function directly. Our TCP server calls it independently — both can coexist (one Deepgram stream per TCP connection).
- **Localhost only**: the server binds to `127.0.0.1` — no external access
- **Rejection handled**: the voice fn `await`s an OAuth refresh before it can return; the second argument to `.then` turns a rejection into a `{"type":"error"}` frame instead of an unhandled rejection inside cli.js

## How to Find This Code

The concat is plain text, so `rg` and `bundle-analyzer` both work on it unchanged. To map an
offset to its chunk, scan backwards for the nearest `// @bun-chunk` line. The `rg` / `node -e`
recipes below were run against the 2.1.261 concat and are known-good; the `bundle-analyzer`
equivalents are listed as alternatives (the CLI was not installed in the re-anchor worktree).

### Voice stream function (Deepgram WebSocket client)

```bash
# which chunk is it in, and what does that chunk export?
node -e 'const s=require("fs").readFileSync("vendor/claude-cli/cli.js","utf8"),i=s.indexOf("[voice_stream] No OAuth token available");
console.log(s.slice(s.lastIndexOf("// @bun-chunk",i)).split("\n")[0]);
console.log(s.slice(i,s.indexOf("\n// @bun-chunk",i)).match(/export\{[^}]*\}/g))'
# → // @bun-chunk B:/~BUN/root/chunk-01qep85r.js
# → [ 'export{_nn,bnn,Snn}' ]

bundle-analyzer.cmd find vendor/claude-cli/cli.js "[voice_stream] No OAuth token available" --compact
bundle-analyzer.cmd strings vendor/claude-cli/cli.js --filter "voice_stream"
```

### finalize timeouts

```bash
rg -o --byte-offset 'safety:\d+,noData:\d+' vendor/claude-cli/cli.js   # → 27260560 (1 site)
bundle-analyzer.cmd slice vendor/claude-cli/cli.js <offset> --before 400 --after 50 --beautify
```

Confirm it is a top-level `var` in the voice chunk (eager) and not wrapped in a lazy initializer.

### Control request handler (injection site)

```bash
# 11 sites in 2.1.261; the right one is the `else WARN(MSG,`…`)` inside the stdin loop
rg -o --byte-offset 'Unsupported control request subtype' vendor/claude-cli/cli.js
# the stdin loop itself — same chunk, ~59 KB earlier:
rg -o --byte-offset 'for await\(let [\w$]+ of [\w$]+\.structuredInput\)' vendor/claude-cli/cli.js
# that chunk is also the one carrying the `[print.ts]` log prefixes
bundle-analyzer.cmd find vendor/claude-cli/cli.js "Unsupported control request subtype" --compact
```

### Success / error response helpers

```bash
# they are declared together, a few hundred KB before the chain:
rg -o --byte-offset 'let [\w$]+=function\([\w$]+,[\w$]+\)\{[\w$]+\.enqueue\([\w$]+\([\w$]+\.request_id,[\w$]+\)\)\}' vendor/claude-cli/cli.js
# or from the anchor's msgVar:
bundle-analyzer.cmd find vendor/claude-cli/cli.js ",Xe(r,{})}catch" --compact
```

### Deepgram WebSocket URL and parameters

```bash
bundle-analyzer.cmd strings vendor/claude-cli/cli.js --filter "speech_to_text"
bundle-analyzer.cmd strings vendor/claude-cli/cli.js --filter "use_conversation_engine"
bundle-analyzer.cmd strings vendor/claude-cli/cli.js --filter "x-config-keyterms"
```

### Voice recording module (for reference, not patched)

```bash
bundle-analyzer.cmd strings vendor/claude-cli/cli.js --filter "startRecording"
bundle-analyzer.cmd strings vendor/claude-cli/cli.js --filter "arecord"
```

## Syntax Pitfalls

### Pitfall: cross-chunk references (2.1.261+)

```js
// WRONG — Snn is defined in a different module; ReferenceError at runtime
Snn({ onTranscript: ... }, { language: lang })

// WRONG — a static import in the dispatch chunk works, but drags the voice
// chunk and `ws` into startup, and no chunk in the bundle is both statically
// and dynamically imported
import { Snn } from 'B:/~BUN/root/chunk-01qep85r.js'

// CORRECT — dynamic import of the chunk that exports it
let { Snn: __vfn } = await import('B:/~BUN/root/chunk-01qep85r.js')
```

Always verify the function is actually in the chunk's `export{…}` list first. If it isn't and the
anchor is in a different chunk, there is **no** way to reach it — stop and report rather than
inventing one (e.g. re-exporting from the voice chunk would mutate two modules and change the
bundle's public surface).

### Pitfall: injected locals shadowing captured names

Minified names are one or two characters. In 2.1.261 the message variable is literally `r`, and
the pre-2.1.261 injection contained `await new Promise(r=>__s.listen(0,"127.0.0.1",r))` — the
arrow parameter shadowed the message. It happened to be harmless (the message isn't used inside),
but the next rename could land on `m`, `b`, `s`, `l` or `o`.

```js
// WRONG — `r` shadows msgVar, `text`/`isFinal` shorthand pins the param names
onTranscript:(text,isFinal)=>{__send({type:"transcript",text,isFinal})}
await new Promise(r=>__s.listen(0,"127.0.0.1",r));

// CORRECT — every injected identifier is `__`-prefixed, shorthand expanded
onTranscript:(__t,__f)=>{__send({type:"transcript",text:__t,isFinal:__f})}
await new Promise((__res)=>__s.listen(0,"127.0.0.1",__res));
```

`apply.mjs` enforces this: it aborts if a captured name (`msgVar`, `successFn`) starts with `__`.

### Pitfall: `await` in the control request handler

```js
// WRONG — if the handler is NOT in an async context
if(r.request.subtype==="voice_server_start"){
  import("node:net").then(...)  // fire-and-forget, no port to return
  Xe(r,{status:"starting"});continue
}

// CORRECT — the handler IS in an async generator's for-await body
if(r.request.subtype==="voice_server_start"){
  let __vsp = await (async()=>{ ... })();  // await is valid here
  Xe(r, __vsp);continue
}
```

### Pitfall: `import()` vs `require()` for Node.js built-ins

```js
// WRONG — bundler may have replaced `require` with internal resolution
const net = require('net')

// CORRECT — dynamic import always resolves Node.js built-ins
const { createServer } = await import('node:net')
```

### Pitfall: lazy module initialization for the finalize timeouts

Historical (≤ 2.1.241), and the check that guards against its return:

```js
// WRONG (on a bundle where the timeouts are lazily built)
voiceStream({onTranscript:..., ...},{language:"en"})
// TypeError: Cannot read properties of undefined (reading 'safety')

// CORRECT (≤ 2.1.241) — trigger the lazy module first
us1();  // var us1=L(()=>{...bs1={safety:5000,noData:1500}})
voiceStream({onTranscript:..., ...},{language:"en"})

// CORRECT (2.1.261) — plain top-level var in the voice chunk; the dynamic
// import of that chunk initialises it. Nothing to trigger.
```

### Pitfall: `globalThis` vs module-level variables

```js
// WRONG — a module-level variable would live in whichever chunk we edited
let voiceServer = null

// CORRECT — globalThis is always accessible from any chunk
globalThis.__vs = server
```

**Always run `node --check` on the patched chunk after applying** (extract the chunk between its
`// @bun-chunk` delimiters into a `.mjs` file — the concat as a whole is not a valid module).

## What's NOT Changed

- **The voice stream function** — called as-is. No modifications to the Deepgram WebSocket connection, OAuth handling, or transcript processing.
- **The voice chunk** — untouched. The patch only adds an importer.
- **Recording module** — the native/sox/arecord recording pipeline is untouched. Our patch doesn't capture audio — the Electron app does that separately using the same `audio-capture.node` NAPI module from the SDK's vendor directory.
- **`/voice` slash command** — the CLI's own voice toggle and push-to-talk UI remain functional, independent of our TCP server.
- **Keyterms** — the patch forwards `keyterms` from the `voice_start` message into the options object; it does not compute a project vocabulary itself. The Electron client can pass keyterms or leave the array empty.

## Consumer-Side Integration

### Electron Main Process

1. **`ClaudeSession.voiceStartServer()`** — sends a `voice_server_start` control request, gets `{ port }` back.
2. **`VoiceClient`** — connects to `127.0.0.1:{port}` via `net.connect()`, parses incoming JSON lines with `readline.createInterface()`, sends `voice_start`, `audio` (base64) and `voice_stop`.
3. **`voice-capture.ts`** — loads `audio-capture.node` from the SDK's vendor directory. `startRecording(callback)` / `stopRecording()`. The native module outputs 16 kHz i16LE mono PCM — exactly what the voice stream fn expects.

### Renderer

4. **`InputBox`** — mic button (hold-to-talk): `window.api.voiceStartRecording()` on mouseDown, `voiceStopRecording()` on mouseUp.
5. **`useClaudeEvents`** — listens for `voice:transcript`, `voice:state`, `voice:error` IPC events.
6. **`session-store`** — `voiceState` (idle/connecting/recording/processing) and `voiceInterimTranscript` per session. The final transcript populates the draft text in the input box.

### Settings

7. **`SettingsDialog`** — "Voice Input" section with enable toggle and language dropdown.
8. **`AppSettings.voiceEnabled`** — when true, the mic button appears in `InputBox`.

## Verification

1. `node patch/voice-server/apply.mjs` against a **pristine** concat — applies, prints the resolved chunk/name/offsets
2. Run again — reports "Part A already applied"
3. Extract the patched chunk and `node --check` it (see the pitfall above) — no syntax errors
4. Confirm the anchor is still unique after the injection, so sibling patches can still find it
5. `bun patch/apply-all.mjs` — all patches pass
6. `bun run typecheck` — no type errors
7. Manual test: enable voice in settings, hold the mic button, speak, release — the transcript should appear in the input box

There is no `test.mjs`; behavioural verification is the manual round-trip in step 7 against the rebundled binary.

## Discovery Method

1. **Observed the feature**: the CLI added a `/voice` command with a Deepgram integration
2. **Analyzed the bundle**: `bundle-analyzer strings` for `"voice"`, `"voice_stream"`, `"/api/ws/speech_to_text/voice_stream"` — mapped the full voice pipeline
3. **Traced the stream fn**: decompiled it; understood the WebSocket connection to Anthropic's proxy, the audio format (linear16, 16 kHz, mono) and the transcript callback interface
4. **Traced recording**: found the native NAPI module (`audio-capture.node`) in the SDK's vendor directory; confirmed it outputs 16 kHz i16LE mono PCM at ~95 chunks/second
5. **Evaluated approaches**:
   - **Direct API call from Electron**: rejected — TOS violation (undocumented API)
   - **Audio through the stdin JSON protocol**: rejected — multiplexing complexity, base64 overhead on the critical JSON path
   - **TCP server in cli.js**: selected — dedicated channel for audio, cli.js keeps all API auth, minimal patch surface
6. **Chose TCP over WebSocket**: `net` is a Node built-in; a WebSocket would mean finding the bundled `ws` (fragile) or hand-rolling the handshake (~80 lines)
7. **Chose base64 over binary framing**: no length-prefix parser needed; ~33% overhead on a <50 KB/s localhost socket is irrelevant
8. **Reused the control request pattern**: same anchor and success-function extraction as `queue-control`

### 2.1.241 re-anchor

The voice stream function gained a third optional credentials param —
`async function fFl(e,t,r){let n;if($t()&&r!==void 0)await Hb({credentials:r}),n=await Mw(r);else await Hb(),n=ya();…}`.
The locator regex was widened to allow the extra param (`(?:,V)?`) and the body-prefix gap became
`[\s\S]{0,300}?` because the new prefix contains braces (`Hb({credentials:r})` — the old
`[^}]{0,200}` stopped there). The 2-arg call stayed correct: `r===void 0` routes to the ambient
auth path.

### 2.1.261 re-anchor (chunked bundle)

Failure observed: `ERROR: Cannot locate bs1 lazy module (us1)`. Root causes, in the order they
surfaced:

1. **The lazy module is gone.** Grepping `safety:5000` found exactly one site, a plain top-level
   `var b={safety:5000,noData:1500}` in the voice chunk — no wrapper to trigger. Step 2 was
   rewritten from "extract the initializer name" to "assert eager initialisation".
2. **The anchor had also broken**, silently, behind that error. 2.1.261 sanitises the echoed
   subtype (`${Xn(String(r.request.subtype))}`), so the old backref-anchored regex matched 0
   times. Widened with an optional `SANITIZE(String(` … `))` wrapper; verified against six
   positive/negative cases including the three lookalike sites that must not match.
3. **The real structural change**: the voice fn (`Snn`, `chunk-01qep85r.js`) and the dispatch
   chain (`chunk-gj501zgt.js`) are now separate ESM modules. A direct call would be a
   `ReferenceError`. Checked whether the dispatch chunk imports the voice chunk — it does not;
   only two lazily-loaded voice-UI chunks do.
4. **Rejected the static-import fix** after measuring the bundle's own partitioning (868 static /
   567 dynamic chunk specifiers, zero overlap) — a static import would have forced the voice chunk
   and `ws` into startup.
5. **Chose the dynamic import**, matching 1,083 in-bundle precedents, one of them inside this same
   dispatch loop. Confirmed against `StandaloneModuleGraph` (bun 1.4.1) that chunk specifiers
   resolve through one flat path lookup shared by static and dynamic imports.
6. **Hardened the injection** while in there: `__`-prefixed every injected identifier after
   noticing `new Promise(r=>…)` shadowed the (now single-letter) message variable, and added a
   rejection handler to the voice-fn promise so an OAuth-refresh failure surfaces as an error
   frame instead of an unhandled rejection.

## Key Functions Reference

| Name (2.1.261) | Chunk                | Purpose                                            |
| -------------- | -------------------- | -------------------------------------------------- |
| `Snn`          | `chunk-01qep85r.js`  | Voice stream function (Deepgram WS client)         |
| `bnn`          | `chunk-01qep85r.js`  | "Is voice available?" (OAuth + gate check)         |
| `_nn`          | `chunk-01qep85r.js`  | `/api/hello` connectivity probe                    |
| `b`            | `chunk-01qep85r.js`  | `{safety:5000,noData:1500}` — finalize timeouts    |
| `r`            | `chunk-gj501zgt.js`  | Message variable in the control request handler    |
| `Xe`           | `chunk-gj501zgt.js`  | Success response helper (`control_response`)       |
| `Be`           | `chunk-gj501zgt.js`  | Error response helper                              |
| `Xn`           | `chunk-gj501zgt.js`  | Subtype sanitiser used in the fallback message     |

**Note:** all minified names and chunk hashes change in every SDK version. Use content patterns
(string literals, structural shapes) to relocate code.

## Related Patches

- `patch/queue-control/`, `patch/background-task/`, `patch/usage-relay/` — all three inject `else if` branches at the **same** fallback anchor with a byte-identical regex, so they need the same 2.1.261 widening. Apply order doesn't matter: each checks for its own marker, each inserts before the fallback, and the anchor stays unique after any of them run.

## Files

| File        | Purpose       |
| ----------- | ------------- |
| `README.md` | This document |
| `apply.mjs` | Patch script  |

# Patch: voice-server

Exposes the CLI's built-in voice transcription pipeline (Deepgram Nova 3 via Anthropic's WebSocket proxy) to external clients through a lightweight TCP server, enabling our Electron UI to stream microphone audio for speech-to-text without directly calling Anthropic's undocumented voice API.

## Affected Component

`@anthropic-ai/claude-agent-sdk` — bundled `cli.js` and `sdk.mjs` files.

| Component              | Version at time of discovery |
| ---------------------- | ---------------------------- |
| SDK package            | 0.2.81                       |
| Bundled CLI (`cli.js`) | (minified, ~12.4 MB)        |

The SDK bundles its own CLI, independent of the native `claude` binary.

## The Problem

The CLI's `/voice` slash command provides push-to-talk voice input using Deepgram Nova 3 speech-to-text (via Anthropic's WebSocket proxy at `/api/ws/speech_to_text/voice_stream`). This feature is entirely self-contained in cli.js — it captures audio from the local microphone (via a native NAPI module or sox/arecord), opens a WebSocket to Anthropic's proxy, streams audio, and receives transcripts.

For our Electron UI, we need voice input but:
1. **Cannot call the voice API directly** — the endpoint is undocumented and authenticated via OAuth. Calling it from our process would violate TOS.
2. **Cannot stream audio through the JSON stdin protocol** — the SDK's stdin transport is newline-delimited JSON, designed for control messages, not high-frequency binary audio.
3. **Cannot use cli.js's native mic capture** — cli.js spawns sox/arecord or uses a NAPI module for recording. We capture audio in Electron's main process instead (using the same NAPI module from the SDK's vendor directory).

**Solution**: Patch cli.js to accept a control request that starts a TCP server on localhost. Our Electron app connects to this server, streams base64-encoded PCM audio over newline-delimited JSON, and receives transcripts back. The voice pipeline inside cli.js (OAuth, Deepgram WebSocket, transcript handling) remains untouched.

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
│         ▲            │                │  hb8() voice stream fn   │
│         │            │   TCP socket   │  (Deepgram via Anthropic)│
│ transcript events ◄──┼───────────────◄│       │                  │
│         │            │                │       ▼                  │
│         ▼            │                │  onTranscript callbacks  │
│ IPC → renderer       │                │  → JSON back to client   │
└──────────────────────┘                └──────────────────────────┘
```

### The hb8 Voice Stream Function

`hb8(callbacks, options)` is the existing voice stream function in cli.js. It:

1. Checks for an OAuth token
2. Constructs a WebSocket URL to `BASE_API_URL/api/ws/speech_to_text/voice_stream` with query params:
   - `encoding=linear16`, `sample_rate=16000`, `channels=1`
   - `endpointing_ms=300`, `utterance_end_ms=1000`
   - `language=<code>` (default "en")
   - `stt_provider=deepgram-nova3` (when feature gate `tengu_cobalt_frost` is active)
   - `keyterms=<term>` (project-specific vocabulary bias)
3. Returns a stream object with `.send(buffer)`, `.finalize()`, `.close()`, `.isConnected()`
4. Calls `callbacks.onReady(stream)` when WebSocket connects
5. Calls `callbacks.onTranscript(text, isFinal)` for interim/final transcripts
6. Calls `callbacks.onError(message)` and `callbacks.onClose()` on failures

**Signature** (v0.2.81, minified name `hb8`):
```js
async function hb8(A, q) {
  // A = { onTranscript, onError, onClose, onReady }
  // q = { language, keyterms }
  // Returns: stream object or null
}
```

### Control Request Handler

The CLI processes control requests in a `for await` loop inside an async generator. Each control request has a `subtype` field. The handler is a chain of `if/else if` blocks ending with a fallback warning. Our patch injects new `else if` branches before the fallback.

**Key variables at the injection site** (v0.2.81):

| Variable | Name (v0.2.81) | Purpose                                    |
| -------- | -------------- | ------------------------------------------ |
| msgVar   | `W6`           | The control request message being processed |
| warnFn   | (first capture)| Logs unsupported subtype warning           |
| successFn| `n`            | Sends control_response back to SDK consumer|

The `successFn` is called as `successFn(msgVar, responseData)` to yield a control_response message back through the SDK transport.

### Why `await` Works in the Injection

The control request handler is inside a `for await (... of ...)` loop body within an async generator function. This means:
- `await` is syntactically valid (we're in an async context)
- `await` pauses the loop iteration (blocking other message processing briefly)
- This is acceptable because server startup takes <1ms (binding to port 0 on localhost)

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

16kHz, 16-bit signed little-endian, mono PCM (`linear16`). Each chunk is ~342 bytes raw, ~456 bytes base64-encoded. At ~95 chunks/second, total bandwidth is ~47 KB/s through a localhost TCP socket — negligible.

### Buffering

Audio chunks may arrive before the Deepgram WebSocket connects (the `onReady` callback fires asynchronously). The injected code buffers chunks in `__buf[]` and flushes them when `onReady` fires.

## The Patches

### Part A — cli.js: Voice Server Control Requests

**Marker**: `/*PATCHED:voice-server*/`

#### Anchor (unique, 1 match)

The control request fallback warning — same anchor used by `queue-control`:

```
else WARN(MSG,`Unsupported control request subtype: ${MSG.request.subtype}`);continue}else if(MSG.type==="control_response")
```

Regex:
```js
else ([\w$]+)\(([\w$]+),`Unsupported control request subtype: \$\{\2\.request\.subtype\}`\);continue\}else if\(\2\.type==="control_response"\)
```

#### Dynamic Function Extraction

**hb8** (voice stream function) — found by the unique string `"[voice_stream] No OAuth token available"` near the function start:
```js
const hb8Re = /async function ([\w$]+)\(([\w$]+),([\w$]+)\)\{[^}]{0,200}\[voice_stream\] No OAuth token available/
```

**successFn** (control response helper) — found by the pattern `,SUCCESS(MSG,{})` in a try/catch block near the control request handler:
```js
const successRe = /\),([\w$]+)\(MSG,\{\}\)\}catch/   // MSG escaped for regex
```

#### Before

```js
else WARN(W6,`Unsupported control request subtype: ${W6.request.subtype}`);continue}
```

#### After

```js
/*PATCHED:voice-server*/else if(W6.request.subtype==="voice_server_start"){
  let __vsp=await(async()=>{
    if(globalThis.__vs)return{port:globalThis.__vs.address().port};
    let{createServer:__cs}=await import("node:net");
    let{createInterface:__ci}=await import("node:readline");
    let __s=__cs((__c)=>{
      let __st=null,__buf=[];
      let __rl=__ci({input:__c});
      let __send=(o)=>{try{__c.write(JSON.stringify(o)+"\n")}catch(e){}};
      __rl.on("line",(l)=>{
        let m;try{m=JSON.parse(l)}catch{return}
        if(m.type==="voice_start"){
          let lang=m.language||"en";
          hb8({
            onTranscript:(text,isFinal)=>{__send({type:"transcript",text,isFinal})},
            onError:(msg)=>{__send({type:"error",message:String(msg)})},
            onClose:()=>{__send({type:"closed"});__st=null},
            onReady:(stream)=>{
              __st=stream;
              for(let b of __buf)stream.send(b);
              __buf=[];
              __send({type:"ready"})
            }
          },{language:lang,keyterms:m.keyterms||[]}).then((s)=>{
            if(!s)__send({type:"error",message:"Failed to connect voice stream"})
          })
        }else if(m.type==="audio"){
          let b=Buffer.from(m.data,"base64");
          if(__st)__st.send(b);else __buf.push(b)
        }else if(m.type==="voice_stop"&&__st){
          __st.finalize().then(()=>{__st&&__st.close();__st=null})
        }
      });
      __c.on("close",()=>{if(__st){__st.close();__st=null}__buf=[]});
      __c.on("error",()=>{})
    });
    await new Promise(r=>__s.listen(0,"127.0.0.1",r));
    globalThis.__vs=__s;
    return{port:__s.address().port}
  })();
  n(W6,__vsp);continue
}else if(W6.request.subtype==="voice_server_stop"){
  if(globalThis.__vs){globalThis.__vs.close();globalThis.__vs=null}
  n(W6,{stopped:!0});continue
}else WARN(W6,`Unsupported control request subtype: ${W6.request.subtype}`);continue}
```

Note: `hb8`, `n`, `W6` are v0.2.81 names — extracted dynamically at apply time.

#### Why It's Safe

- **Node.js built-ins only**: Uses `import("node:net")` and `import("node:readline")` — always available regardless of bundler state
- **`globalThis.__vs`**: Stored globally so the server persists across control requests and can be stopped later. Single instance — if already running, returns existing port.
- **No interference with CLI voice**: The CLI's own `/voice` command uses `sox`/`arecord` + `hb8()` directly. Our TCP server calls `hb8()` independently — both can coexist (though only one Deepgram stream at a time per connection).
- **Localhost only**: Server binds to `127.0.0.1` — no external access.

### Part B — sdk.mjs: Query Methods

**Marker**: `/*PATCHED:voice-server-sdk*/`

#### Anchor (unique, 1 match)

Same anchor as `queue-control` Part B — the `stopTask` method:
```
async stopTask(VAR){await this.request({subtype:"stop_task",task_id:VAR})}
```

#### After stopTask

```js
/*PATCHED:voice-server-sdk*/async voiceServerStart(){return(await this.request({subtype:"voice_server_start"})).response}async voiceServerStop(){return(await this.request({subtype:"voice_server_stop"})).response}
```

Note: The `.response` unwrap is critical. `this.request()` returns the full control_response object `{subtype, request_id, response}`. The actual data is nested in `.response`. Without unwrapping, you get `{port: undefined}`.

## How to Find This Code

### hb8 — Voice stream function (Deepgram WebSocket client)

```bash
bundle-analyzer find cli.js "[voice_stream] No OAuth token available" --compact
bundle-analyzer strings cli.js --filter "voice_stream"
```

### Control request handler (injection site)

```bash
bundle-analyzer find cli.js "Unsupported control request subtype" --compact
```

### Success response function

```bash
# Near the control request handler, look for the pattern: ),FUNC(MSG,{})
# where MSG is the message variable from the anchor match
bundle-analyzer slice cli.js <anchor_offset> --before 5000 --after 100 --beautify
```

### Deepgram WebSocket URL and parameters

```bash
bundle-analyzer strings cli.js --filter "speech_to_text"
bundle-analyzer strings cli.js --filter "deepgram-nova3"
bundle-analyzer strings cli.js --filter "stt_provider"
```

### Voice recording module (for reference, not patched)

```bash
bundle-analyzer strings cli.js --filter "startRecording"
bundle-analyzer strings cli.js --filter "arecord"
bundle-analyzer strings cli.js --filter "sox"
```

### stopTask in sdk.mjs (Part B anchor)

```bash
grep -n "stopTask" node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs
```

## Syntax Pitfalls

### Pitfall: `await` in control request handler

```js
// WRONG — if the handler is NOT in an async context
if(MSG.request.subtype==="voice_server_start"){
  import("node:net").then(...)  // fire-and-forget, no port to return
  SUCCESS(MSG,{status:"starting"});continue
}

// CORRECT — the handler IS in an async generator's for-await body
if(MSG.request.subtype==="voice_server_start"){
  let result = await (async()=>{ ... })();  // await is valid here
  SUCCESS(MSG, result);continue
}
```

### Pitfall: `import()` vs `require()` for Node.js built-ins

```js
// WRONG — bundler may have replaced `require` with internal resolution
const net = require('net')  // might fail in bundled cli.js

// CORRECT — dynamic import bypasses bundler, always resolves Node.js built-ins
const {createServer} = await import('node:net')
```

### Pitfall: `globalThis` vs module-level variables

```js
// WRONG — module-level variable may not be in scope at injection site
let voiceServer = null  // where does this go in a minified IIFE?

// CORRECT — globalThis is always accessible from any scope
globalThis.__vs = server
```

**Always run `node --check cli.js` after applying patches.**

## What's NOT Changed

- **hb8 function** — The voice stream function is called as-is. No modifications to the Deepgram WebSocket connection, OAuth handling, or transcript processing.
- **Recording module (sVq)** — The native/sox/arecord recording pipeline is untouched. Our patch doesn't capture audio — the Electron app does that separately using the same `audio-capture.node` NAPI module from the SDK's vendor directory.
- **`/voice` slash command** — The CLI's own voice toggle and push-to-talk UI remain functional. They operate independently of our TCP server.
- **Keyterms (ms1)** — The patch accepts keyterms via the `voice_start` message but doesn't call `ms1()` itself. The Electron client can pass keyterms if desired, or leave the array empty.

## Consumer-Side Integration

### Electron Main Process

1. **`ClaudeSession.voiceStartServer()`** — Calls `activeQuery.voiceServerStart()` which sends a `voice_server_start` control request. Gets `{ port }` back.
2. **`VoiceClient`** — Connects to `127.0.0.1:{port}` via `net.connect()`. Uses `readline.createInterface()` to parse incoming JSON lines. Sends `voice_start`, `audio` (base64), and `voice_stop` messages.
3. **`voice-capture.ts`** — Loads `audio-capture.node` from the SDK's vendor directory. Provides `startRecording(callback)` / `stopRecording()`. The native module outputs 16kHz i16LE mono PCM — exactly what hb8/Deepgram expects.

### Renderer

4. **`InputBox`** — Mic button (hold-to-talk). Calls `window.api.voiceStartRecording()` on mouseDown, `voiceStopRecording()` on mouseUp.
5. **`useClaudeEvents`** — Listens for `voice:transcript`, `voice:state`, `voice:error` IPC events.
6. **`session-store`** — `voiceState` (idle/connecting/recording/processing) and `voiceInterimTranscript` per session. Final transcript populates the draft text in the input box.

### Settings

7. **`SettingsDialog`** — "Voice Input" section with enable toggle and language dropdown (20 languages from Deepgram Nova 3).
8. **`AppSettings.voiceEnabled`** — When true, mic button appears in InputBox.

## Verification

1. `bun patch/voice-server/apply.mjs` — should apply both parts
2. Run again — should report "already applied" for both parts
3. `bun patch/apply-all.mjs` — all patches pass including voice-server
4. `bun run typecheck` — no type errors
5. Manual test: enable voice in settings, hold mic button, speak, release — transcript should appear in input box

## Discovery Method

1. **Observed the feature**: CLI added `/voice` command with Deepgram Nova 3 integration (behind `tengu_cobalt_frost` feature gate)
2. **Analyzed the bundle**: Used `bundle-analyzer strings` to find `"voice"`, `"voice_stream"`, `"deepgram-nova3"`, `"/api/ws/speech_to_text/voice_stream"` — mapped the full voice pipeline
3. **Traced hb8**: Extracted and decompiled the voice stream function. Understood its WebSocket connection to Anthropic's proxy, the audio format (linear16, 16kHz, mono), and the transcript callback interface
4. **Traced recording**: Found the native NAPI module (`audio-capture.node`) in the SDK's vendor directory. Tested it directly — confirmed it outputs 16kHz i16LE mono PCM at ~95 chunks/second
5. **Evaluated approaches**:
   - **Direct API call from Electron**: Rejected — TOS violation (undocumented API)
   - **Audio through stdin JSON protocol**: Rejected — adds multiplexing complexity, base64 overhead on the critical JSON path
   - **TCP server in cli.js**: Selected — keeps audio on a dedicated channel, cli.js handles all API auth, minimal patch surface
6. **Chose TCP over WebSocket**: Node.js built-in `net` module is always available. WebSocket would require finding the bundled `ws` library (fragile) or implementing the handshake from scratch (~80 lines). TCP with newline-delimited JSON is simpler and sufficient for localhost IPC.
7. **Chose base64 over binary framing**: Eliminates need for length-prefix frame parser. Audio overhead is ~33% but total bandwidth is still <50 KB/s through localhost — irrelevant.
8. **Reused the control request pattern**: Same anchor and success function pattern as `queue-control`. Proven approach for adding new SDK-accessible functionality.

## Key Functions Reference

| Name (v0.2.81) | Purpose                                           | Char offset |
| --------------- | ------------------------------------------------- | ----------- |
| `hb8`           | Voice stream function (Deepgram WS client)        | ~10804673   |
| `n`             | Success response helper (control_response)        | nearby      |
| `W6`            | Message variable in control request handler       | nearby      |
| `sVq`           | startRecording (native/sox/arecord — NOT patched) | ~10814663   |
| `Ps6`           | Load native audio NAPI module                     | ~10811366   |

**Note:** All minified names will change in future SDK versions. Use content patterns (string literals, structural shapes) to relocate code.

## Related Patches

- `patch/queue-control/` — Uses the same control request anchor and success function extraction pattern. Both patches inject `else if` branches before the "Unsupported" fallback. Apply order doesn't matter — each checks for its own marker.
- `patch/usage-relay/` — Another patch that adds a control request subtype. Same injection pattern.

## Files

| File        | Purpose       |
| ----------- | ------------- |
| `README.md` | This document |
| `apply.mjs` | Patch script  |

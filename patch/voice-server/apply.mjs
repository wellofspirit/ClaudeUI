/**
 * Patch: voice-server
 *
 * Adds a lightweight TCP voice server inside cli.js that external clients
 * (e.g., our Electron app) can connect to for streaming audio transcription.
 *
 * Two parts:
 *
 *   Part A (cli.js): voice_server_start / voice_server_stop control requests.
 *                    Creates a TCP server on 127.0.0.1:0, wires audio into
 *                    the existing voice-stream function (Deepgram via
 *                    Anthropic's proxy), relays transcripts back.
 *
 *   Part B (sdk.mjs): removed — voiceServerStart/voiceServerStop live in
 *                     src/main/sdk/.
 *
 * Protocol over TCP (newline-delimited JSON, audio base64-encoded):
 *   Client→Server: {"type":"voice_start","language":"en"}
 *   Client→Server: {"type":"audio","data":"<base64 PCM>"}
 *   Client→Server: {"type":"voice_stop"}
 *   Server→Client: {"type":"ready"}
 *   Server→Client: {"type":"transcript","text":"...","isFinal":true|false}
 *   Server→Client: {"type":"error","message":"..."}
 *   Server→Client: {"type":"closed"}
 *
 * Usage: node patch/voice-server/apply.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '../..')
const cliPath = resolve(projectRoot, 'vendor/claude-cli/cli.js')

// Regex shorthand for minified identifier (includes $ which is common in minified names)
const V = '[\\w$]+'

// ===========================================================================
// Part A: Patch cli.js — voice_server_start / voice_server_stop
// ===========================================================================

let src
try {
  src = readFileSync(cliPath, 'utf-8')
} catch (err) {
  console.error(`ERROR: Cannot read ${cliPath}`)
  console.error('Did you run: node scripts/extract-cli.mjs ?')
  process.exit(1)
}

console.log(`Read ${cliPath} (${(src.length / 1024 / 1024).toFixed(1)} MB)`)

const PATCH_A_MARKER = '/*PATCHED:voice-server*/'

// ---------------------------------------------------------------------------
// Chunk map (CC >= 2.1.261)
//
// cli.js is no longer one monolithic bundle: it is the concatenation of ~1600
// minified ESM chunks, each preceded by a `// @bun-chunk <specifier>` line.
// Cross-chunk references are `import`s, so a name defined in chunk A is NOT in
// scope in chunk B. We therefore need to know which chunk each anchor lives in.
// ---------------------------------------------------------------------------

const CHUNK_DELIM_RE = /(?:^|\n)\/\/ @bun-chunk (\S+)\n/g

function buildChunkTable(text) {
  const chunks = []
  CHUNK_DELIM_RE.lastIndex = 0
  let m
  while ((m = CHUNK_DELIM_RE.exec(text))) {
    chunks.push({ spec: m[1], start: m.index, bodyStart: m.index + m[0].length })
  }
  for (let i = 0; i < chunks.length; i++) {
    chunks[i].end = i + 1 < chunks.length ? chunks[i + 1].start : text.length
  }
  return chunks
}

const chunks = buildChunkTable(src)

function chunkAt(offset) {
  let lo = 0
  let hi = chunks.length - 1
  let found = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (chunks[mid].start <= offset) {
      found = chunks[mid]
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
}

// A regex must never span a chunk boundary — the two sides would be unrelated
// modules that happen to sit next to each other in the concat.
function assertNoChunkBoundary(matchText, label) {
  if (matchText.includes('@bun-chunk')) {
    console.error(`ERROR: ${label} match spans a chunk boundary — the pattern is too loose`)
    process.exit(1)
  }
}

if (src.includes(PATCH_A_MARKER)) {
  console.log('Part A already applied. Skipping.')
} else {
  console.log('\n=== Part A: voice server control requests ===')
  console.log(`  Chunked bundle: ${chunks.length} chunk(s)`)

  // -------------------------------------------------------------------------
  // Step 1: Find the voice stream function (v0.2.81 `hb8`, 2.1.261 `Snn`)
  // -------------------------------------------------------------------------
  console.log('\n--- Locating voice stream function ---')

  // The voice stream fn is an async function taking (callbacks, options) plus,
  // since 2.1.241, an optional third credentials param (`async function Snn(e,s,d)`;
  // d undefined → `L()&&d!==void 0` is false → ambient auth path, so our 2-arg call
  // keeps the pre-2.1.241 behaviour). Its body prefix contains braces
  // (`bs({credentials:d})`), so the gap matcher is [\s\S] with a tight bound.
  const voiceFnRe = new RegExp(
    `async function (${V})\\((${V}),(${V})(?:,${V})?\\)\\{[\\s\\S]{0,300}?\\[voice_stream\\] No OAuth token available`
  )
  const voiceFnMatch = voiceFnRe.exec(src)
  if (!voiceFnMatch) {
    console.error('ERROR: Cannot locate voice stream function')
    console.error('Looked for: async function with "[voice_stream] No OAuth token available"')
    process.exit(1)
  }
  assertNoChunkBoundary(voiceFnMatch[0], 'voice stream function')
  const voiceFnLocal = voiceFnMatch[1]
  const voiceChunk = chunkAt(voiceFnMatch.index)
  console.log(`  Voice stream function: ${voiceFnLocal}  (chunk ${voiceChunk.spec})`)

  // Verify uniqueness
  const allVoiceFn = [...src.matchAll(new RegExp(voiceFnRe, 'g'))]
  if (allVoiceFn.length > 1) {
    console.error('ERROR: Voice stream function pattern matched multiple times')
    process.exit(1)
  }

  // -------------------------------------------------------------------------
  // Step 2: Confirm the finalize timeouts are eagerly initialised
  //
  // The stream's finalize() reads `{safety,noData}` timeout values. Up to
  // 2.1.241 those lived in a lazily-initialised CJS-style module wrapper
  // (`var us1=L(()=>{...bs1={safety:5000,noData:1500}})`) and the patch had to
  // call the initializer before invoking the voice fn, or finalize() threw
  // `TypeError: Cannot read properties of undefined (reading 'safety')`.
  //
  // In 2.1.261 the wrapper is gone: the object is a plain top-level `var` in
  // the voice chunk itself, so importing that chunk initialises it. We assert
  // both halves of that (still a single site, still in the voice chunk, no
  // lazy wrapper) so a future re-lazification fails loudly instead of
  // silently breaking finalize() at runtime.
  // -------------------------------------------------------------------------
  console.log('\n--- Checking finalize-timeout initialisation ---')

  const timeoutsRe = /\{safety:\d+,noData:\d+\}/g
  const timeoutSites = [...src.matchAll(timeoutsRe)]
  if (timeoutSites.length !== 1) {
    console.error(
      `ERROR: expected exactly 1 {safety:N,noData:N} site, found ${timeoutSites.length}`
    )
    process.exit(1)
  }
  const timeoutsChunk = chunkAt(timeoutSites[0].index)
  if (timeoutsChunk.spec !== voiceChunk.spec) {
    console.error(
      `ERROR: finalize timeouts live in ${timeoutsChunk.spec} but the voice fn is in ${voiceChunk.spec};` +
        ' importing the voice chunk would no longer initialise them (see README "finalize timeouts")'
    )
    process.exit(1)
  }
  // Pre-2.1.261 lazy wrapper — if it ever comes back, the patch must trigger it.
  const lazyTimeoutsRe = new RegExp(
    `var (${V})=${V}\\(\\(\\)=>[\\s\\S]{0,500}?${V}=\\{safety:\\d+,noData:\\d+\\}`
  )
  if (lazyTimeoutsRe.test(src)) {
    console.error(
      'ERROR: finalize timeouts are behind a lazy module initializer again —' +
        ' the injection must call it before the voice fn (see README "finalize timeouts")'
    )
    process.exit(1)
  }
  console.log(
    `  Timeouts are a plain top-level binding in ${timeoutsChunk.spec} — no lazy trigger needed`
  )

  // -------------------------------------------------------------------------
  // Step 3: Find the control request anchor
  // -------------------------------------------------------------------------
  console.log('\n--- Locating control-request fallback ---')

  // v2.1.219 wrapped the control-request dispatch chain in a try/finally, so the
  // fallback tail changed from `...subtype}`);continue}else if(msg.type==="control_response")`
  // to `...subtype}`)}finally{...}continue}else if(...)`. Match the fallback call
  // itself (tail-less) — still globally unique.
  //
  // 2.1.261 additionally sanitises the echoed subtype:
  //   before: else Be(r,`Unsupported control request subtype: ${r.request.subtype}`)
  //   after:  else Be(r,`Unsupported control request subtype: ${Xn(String(r.request.subtype))}`)
  // The optional `SANITIZE(String(...))` wrapper below matches both shapes.
  //
  // Do NOT confuse with the other "Unsupported control request subtype" sites:
  // the SDK Query transport throws (`throw Error("Unsupported control request subtype: "+…)`),
  // and DirectConnect / RemoteSessionManager prefix their message with a bracketed
  // tag. Only the stream-json stdin loop ClaudeUI drives has this exact shape.
  const anchorRe = new RegExp(
    `else (${V})\\((${V}),\`Unsupported control request subtype: ` +
      `\\$\\{(?:${V}\\(String\\()?\\2\\.request\\.subtype(?:\\)\\))?\\}\`\\)`
  )
  const anchorMatch = anchorRe.exec(src)
  if (!anchorMatch) {
    console.error('ERROR: Cannot locate control-request fallback anchor')
    process.exit(1)
  }
  assertNoChunkBoundary(anchorMatch[0], 'control-request fallback')

  const anchorIdx = anchorMatch.index
  const msgVar = anchorMatch[2]
  const anchorChunk = chunkAt(anchorIdx)
  console.log(
    `  Control request anchor at char ${anchorIdx} (msgVar=${msgVar}, chunk ${anchorChunk.spec})`
  )

  // Verify uniqueness
  const allAnchors = [...src.matchAll(new RegExp(anchorRe, 'g'))]
  if (allAnchors.length > 1) {
    console.error('ERROR: Anchor matched multiple times')
    process.exit(1)
  }

  // -------------------------------------------------------------------------
  // Step 4: Work out how to reach the voice stream fn from the anchor's chunk
  //
  // Same chunk  → call it directly by its local name.
  // Other chunk → it must be exported; we dynamic-import the chunk by its
  //               `B:/~BUN/root/chunk-….js` specifier. This is the bundle's own
  //               idiom — 2.1.261 has 1,083 such `await import("B:/~BUN/…")`
  //               calls, several of them inside this very dispatch loop — and
  //               it keeps the voice chunk lazily evaluated (a static import
  //               would drag `ws` into startup).
  // -------------------------------------------------------------------------
  console.log('\n--- Resolving voice fn reachability ---')

  const voiceChunkBody = src.slice(voiceChunk.bodyStart, voiceChunk.end)
  // `export{a,b as c}` — build local → exported name
  let exportedAs = null
  for (const m of voiceChunkBody.matchAll(/export\{([^}]*)\}/g)) {
    for (const entry of m[1].split(',')) {
      const parts = entry.trim().split(/\s+as\s+/)
      const local = parts[0]
      const exported = parts[1] ?? parts[0]
      if (local === voiceFnLocal) exportedAs = exported
    }
  }

  let voiceCallExpr // expression evaluating to the voice stream fn at the injection site
  let voiceImportStmt = '' // optional preamble that binds it
  if (anchorChunk.spec === voiceChunk.spec) {
    voiceCallExpr = voiceFnLocal
    console.log(`  Voice fn is in the anchor's own chunk — calling ${voiceFnLocal} directly`)
  } else if (exportedAs) {
    voiceImportStmt = `let{${exportedAs}:__vfn}=await import(${JSON.stringify(voiceChunk.spec)});`
    voiceCallExpr = '__vfn'
    console.log(`  Voice fn exported as "${exportedAs}" — dynamic-importing ${voiceChunk.spec}`)
  } else {
    console.error(
      `ERROR: ${voiceFnLocal} lives in ${voiceChunk.spec} but is not exported, and the anchor is in` +
        ` ${anchorChunk.spec}. There is no way to reach it from the injection site (see README).`
    )
    process.exit(1)
  }

  // -------------------------------------------------------------------------
  // Step 5: Find the success response function
  //
  // Search globally — the pattern `,X(MSG,{})}catch` is unique to this
  // dispatch chain, and a windowed search around the anchor breaks once prior
  // patches (background-task / usage-relay / etc.) shift the anchor and push
  // the original site out of the lookback window.
  //
  // 2.1.261: `let Xe=function(f,M){wt.enqueue(A5(f.request_id,M))}` — success;
  //          `let Be=function(f,M){wt.enqueue(_B(f.request_id,M))}` — error
  //          (the fallback's warn fn, captured by the anchor as group 1).
  // -------------------------------------------------------------------------
  console.log('\n--- Extracting success response function ---')

  const escMsg = msgVar.replace(/\$/g, '\\$')
  const successRe = new RegExp(`\\),(${V})\\(${escMsg},\\{\\}\\)\\}catch`, 'g')
  const successMatches = [...src.matchAll(successRe)]
  if (successMatches.length === 0) {
    console.error('ERROR: Cannot find success response helper')
    process.exit(1)
  }
  // Multiple match sites are fine as long as they all reference the same helper.
  const successNames = new Set(successMatches.map((m) => m[1]))
  if (successNames.size > 1) {
    console.error(
      `ERROR: Success response helper pattern resolved to multiple names: ${[...successNames].join(', ')}`
    )
    process.exit(1)
  }
  const successFn = successMatches[0][1]
  // All success sites must be in the anchor's chunk, or the name we captured is
  // some other module's helper that merely looks the same.
  for (const m of successMatches) {
    if (chunkAt(m.index).spec !== anchorChunk.spec) {
      console.error(
        `ERROR: success helper site at ${m.index} is in ${chunkAt(m.index).spec}, not the anchor chunk ${anchorChunk.spec}`
      )
      process.exit(1)
    }
  }
  console.log(`  Success response function: ${successFn} (${successMatches.length} call sites)`)

  // -------------------------------------------------------------------------
  // Step 6: Inject voice_server_start and voice_server_stop handlers
  // -------------------------------------------------------------------------
  console.log('\n--- Injecting voice server handlers ---')

  // The injected code creates a TCP server using Node.js built-in modules.
  // It wires incoming audio to the existing voice stream function and relays
  // transcripts back to the TCP client.
  //
  // `await` is valid here because the dispatch chain lives in an async
  // generator's `for await (let MSG of t.structuredInput)` body. The enclosing
  // try/finally is fine with our `continue` — the finally only reports command
  // lifecycle completion, exactly as it does for every other subtype branch.
  //
  // EVERY identifier we introduce is `__`-prefixed. Minified names are one or
  // two characters, so an un-prefixed local would eventually shadow a captured
  // name: in 2.1.261 msgVar is literally `r`, and the pre-2.1.261 injection
  // used `new Promise(r=>…)` — the message variable, shadowed. Prefixing makes
  // that class of collision impossible, and the guard below enforces it.
  for (const [label, name] of [
    ['msgVar', msgVar],
    ['successFn', successFn],
    ['voiceCallExpr', voiceCallExpr]
  ]) {
    if (name !== '__vfn' && /^__/.test(name)) {
      console.error(
        `ERROR: captured name ${label}=${name} collides with the injection's __-prefixed locals`
      )
      process.exit(1)
    }
  }

  const injection =
    PATCH_A_MARKER +
    // voice_server_start: create TCP server, return port
    `else if(${msgVar}.request.subtype==="voice_server_start"){` +
    `let __vsp=await(async()=>{` +
    `if(globalThis.__vs)return{port:globalThis.__vs.address().port};` +
    voiceImportStmt +
    `let{createServer:__cs}=await import("node:net");` +
    `let{createInterface:__ci}=await import("node:readline");` +
    `let __s=__cs((__c)=>{` +
    `let __st=null,__buf=[];` +
    `let __rl=__ci({input:__c});` +
    `let __send=(__o)=>{try{__c.write(JSON.stringify(__o)+"\\n")}catch{}};` +
    `__rl.on("line",(__l)=>{` +
    `let __m;try{__m=JSON.parse(__l)}catch{return}` +
    `if(__m.type==="voice_start"){` +
    `let __lang=__m.language||"en";` +
    `${voiceCallExpr}({` +
    `onTranscript:(__t,__f)=>{__send({type:"transcript",text:__t,isFinal:__f})},` +
    `onError:(__e)=>{__send({type:"error",message:String(__e)})},` +
    `onClose:()=>{__send({type:"closed"});__st=null},` +
    `onReady:(__x)=>{` +
    `__st=__x;` +
    `for(let __b of __buf)__x.send(__b);` +
    `__buf=[];` +
    `__send({type:"ready"})` +
    `}` +
    `},{language:__lang,keyterms:__m.keyterms||[]}).then((__r)=>{` +
    `if(!__r)__send({type:"error",message:"Failed to connect voice stream"})` +
    // the voice fn awaits an OAuth refresh before it can return; a rejection
    // there would otherwise surface as an unhandled rejection inside cli.js
    `},(__e)=>{__send({type:"error",message:String(__e&&__e.message||__e)})})` +
    `}else if(__m.type==="audio"){` +
    `let __b=Buffer.from(__m.data,"base64");` +
    `if(__st)__st.send(__b);else __buf.push(__b)` +
    `}else if(__m.type==="voice_stop"){` +
    `if(__st)__st.finalize().then(()=>{if(__st){__st.close();__st=null}}).catch(()=>{})` +
    `}` +
    `});` +
    `__c.on("close",()=>{if(__st){__st.close();__st=null}__buf=[]});` +
    `__c.on("error",()=>{})` +
    `});` +
    `await new Promise((__res)=>__s.listen(0,"127.0.0.1",__res));` +
    `globalThis.__vs=__s;` +
    `return{port:__s.address().port}` +
    `})();` +
    `${successFn}(${msgVar},__vsp);continue` +
    `}` +
    // voice_server_stop: shut down TCP server
    `else if(${msgVar}.request.subtype==="voice_server_stop"){` +
    `if(globalThis.__vs){globalThis.__vs.close();globalThis.__vs=null}` +
    `${successFn}(${msgVar},{stopped:!0});continue` +
    `}`

  src = src.slice(0, anchorIdx) + injection + src.slice(anchorIdx)
  console.log('Injected voice server handlers')

  // Write and verify
  writeFileSync(cliPath, src)
  console.log(`\nPatch applied to ${cliPath}`)

  const verify = readFileSync(cliPath, 'utf-8')
  if (!verify.includes(PATCH_A_MARKER)) {
    console.error('Verification FAILED — marker not found')
    process.exit(1)
  }
  // The injection must have landed inside the anchor's chunk, not straddled a
  // delimiter (which would corrupt two modules at once when the concat is split).
  const markerIdx = verify.indexOf(PATCH_A_MARKER)
  const verifyChunks = buildChunkTable(verify)
  const landedSpec = (() => {
    let found = null
    for (const c of verifyChunks) {
      if (c.start <= markerIdx) found = c
      else break
    }
    return found?.spec
  })()
  if (landedSpec !== anchorChunk.spec) {
    console.error(
      `Verification FAILED — injection landed in ${landedSpec}, expected ${anchorChunk.spec}`
    )
    process.exit(1)
  }
  if (verify.slice(markerIdx, markerIdx + injection.length).includes('@bun-chunk')) {
    console.error('Verification FAILED — injected code straddles a chunk boundary')
    process.exit(1)
  }
  console.log(`  OK Part A marker verified (chunk ${landedSpec})`)
}

console.log('')
console.log('What this does:')
console.log('  Part A (cli.js): voice_server_start / voice_server_stop control requests.')
console.log(
  '  Part B (sdk.mjs) was removed — voiceServerStart/voiceServerStop live in src/main/sdk/.'
)

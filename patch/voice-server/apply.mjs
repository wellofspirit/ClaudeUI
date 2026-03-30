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
 *                    the existing hb8() voice stream pipeline (Deepgram via
 *                    Anthropic's proxy), relays transcripts back.
 *
 *   Part B (sdk.mjs): voiceServerStart() / voiceServerStop() methods on the
 *                     query object.
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
const cliPath = resolve(projectRoot, 'node_modules/@anthropic-ai/claude-agent-sdk/cli.js')
const sdkPath = resolve(projectRoot, 'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs')

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
  console.error('Is @anthropic-ai/claude-agent-sdk installed?')
  process.exit(1)
}

console.log(`Read ${cliPath} (${(src.length / 1024 / 1024).toFixed(1)} MB)`)

const PATCH_A_MARKER = '/*PATCHED:voice-server*/'

if (src.includes(PATCH_A_MARKER)) {
  console.log('Part A already applied. Skipping.')
} else {
  console.log('\n=== Part A: voice server control requests ===')

  // -------------------------------------------------------------------------
  // Step 1: Find the hb8 voice stream function name
  // -------------------------------------------------------------------------
  console.log('\n--- Locating voice stream function (hb8) ---')

  // hb8 is an async function that takes 2 params (callbacks, options).
  // Its body starts with await IY() and contains the OAuth token check string.
  const hb8Re = new RegExp(
    `async function (${V})\\((${V}),(${V})\\)\\{[^}]{0,200}\\[voice_stream\\] No OAuth token available`
  )
  const hb8Match = hb8Re.exec(src)
  if (!hb8Match) {
    console.error('ERROR: Cannot locate voice stream function (hb8)')
    console.error('Looked for: async function with "[voice_stream] No OAuth token available"')
    process.exit(1)
  }
  const hb8Name = hb8Match[1]
  console.log(`  Voice stream function: ${hb8Name}`)

  // Verify uniqueness
  const allHb8 = [...src.matchAll(new RegExp(hb8Re, 'g'))]
  if (allHb8.length > 1) {
    console.error('ERROR: Voice stream function pattern matched multiple times')
    process.exit(1)
  }

  // -------------------------------------------------------------------------
  // Step 2: Find the bs1 lazy module initializer (us1)
  // -------------------------------------------------------------------------
  console.log('\n--- Locating bs1 lazy module (us1) ---')

  // bs1/dK7 holds finalize timeout values { safety: 5000, noData: 1500 }.
  // It's initialized inside a lazy module: var <us1>=<lazyFn>(()=>{...<bs1>={safety:5000,noData:1500}})
  // hb8's finalize() reads the timeout var's .safety, so we must trigger the lazy init before calling hb8.
  // The lazy function name (L, y, etc.) and variable names change between versions, so match generically.
  const bs1Re = new RegExp(
    `var (${V})=${V}\\(\\(\\)=>[\\s\\S]{0,500}?${V}=\\{safety:5000,noData:1500\\}`
  )
  const bs1Match = bs1Re.exec(src)
  if (!bs1Match) {
    console.error('ERROR: Cannot locate bs1 lazy module (us1)')
    process.exit(1)
  }
  const us1Name = bs1Match[1]
  console.log(`  bs1 lazy module initializer: ${us1Name}`)

  // -------------------------------------------------------------------------
  // Step 3: Find the control request anchor
  // -------------------------------------------------------------------------
  console.log('\n--- Locating control-request fallback ---')

  const anchorRe = new RegExp(
    `else (${V})\\((${V}),\`Unsupported control request subtype: \\$\\{\\2\\.request\\.subtype\\}\`\\);continue\\}else if\\(\\2\\.type==="control_response"\\)`
  )
  const anchorMatch = anchorRe.exec(src)
  if (!anchorMatch) {
    console.error('ERROR: Cannot locate control-request fallback anchor')
    process.exit(1)
  }

  const anchorIdx = anchorMatch.index
  const msgVar = anchorMatch[2]
  console.log(`  Control request anchor at char ${anchorIdx} (msgVar=${msgVar})`)

  // Verify uniqueness
  const allAnchors = [...src.matchAll(new RegExp(anchorRe, 'g'))]
  if (allAnchors.length > 1) {
    console.error('ERROR: Anchor matched multiple times')
    process.exit(1)
  }

  // -------------------------------------------------------------------------
  // Step 4: Find the success response function
  // -------------------------------------------------------------------------
  console.log('\n--- Extracting success response function ---')

  const nearbyCtx = src.slice(Math.max(0, anchorIdx - 5000), anchorIdx + 2000)
  // Success function is called as: SUCCESS_FN(msgVar, {}) in a try/catch block
  const escMsg = msgVar.replace(/\$/g, '\\$')
  const successRe = new RegExp(`\\),(${V})\\(${escMsg},\\{\\}\\)\\}catch`)
  const successMatch = successRe.exec(nearbyCtx)
  if (!successMatch) {
    console.error('ERROR: Cannot find success response helper')
    process.exit(1)
  }
  const successFn = successMatch[1]
  console.log(`  Success response function: ${successFn}`)

  // -------------------------------------------------------------------------
  // Step 5: Inject voice_server_start and voice_server_stop handlers
  // -------------------------------------------------------------------------
  console.log('\n--- Injecting voice server handlers ---')

  // The injected code creates a TCP server using Node.js built-in modules.
  // It wires incoming audio to the existing hb8() voice stream function
  // and relays transcripts back to the TCP client.
  //
  // The code uses `await` which is valid here because we're inside an async
  // generator's for-await loop body.

  const injection =
    PATCH_A_MARKER +
    // voice_server_start: create TCP server, return port
    `else if(${msgVar}.request.subtype==="voice_server_start"){` +
    `let __vsp=await(async()=>{` +
    `if(globalThis.__vs)return{port:globalThis.__vs.address().port};` +
    `let{createServer:__cs}=await import("node:net");` +
    `let{createInterface:__ci}=await import("node:readline");` +
    `let __s=__cs((__c)=>{` +
      `let __st=null,__buf=[];` +
      `let __rl=__ci({input:__c});` +
      `let __send=(o)=>{try{__c.write(JSON.stringify(o)+"\\n")}catch{}};` +
      `__rl.on("line",(l)=>{` +
        `let m;try{m=JSON.parse(l)}catch{return}` +
        `if(m.type==="voice_start"){` +
          `let lang=m.language||"en";` +
          `${us1Name}();` +  // trigger lazy init of bs1 (finalize timeouts)
          `${hb8Name}({` +
            `onTranscript:(text,isFinal)=>{__send({type:"transcript",text,isFinal})},` +
            `onError:(msg)=>{__send({type:"error",message:String(msg)})},` +
            `onClose:()=>{__send({type:"closed"});__st=null},` +
            `onReady:(stream)=>{` +
              `__st=stream;` +
              `for(let b of __buf)stream.send(b);` +
              `__buf=[];` +
              `__send({type:"ready"})` +
            `}` +
          `},{language:lang,keyterms:m.keyterms||[]}).then((s)=>{` +
            `if(!s)__send({type:"error",message:"Failed to connect voice stream"})` +
          `})` +
        `}else if(m.type==="audio"){` +
          `let b=Buffer.from(m.data,"base64");` +
          `if(__st)__st.send(b);else __buf.push(b)` +
        `}else if(m.type==="voice_stop"){` +
          `if(__st)__st.finalize().then(()=>{if(__st){__st.close();__st=null}}).catch(()=>{})` +
        `}` +
      `});` +
      `__c.on("close",()=>{if(__st){__st.close();__st=null}__buf=[]});` +
      `__c.on("error",()=>{})` +
    `});` +
    `await new Promise(r=>__s.listen(0,"127.0.0.1",r));` +
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
  console.log('  OK Part A marker verified')
}

// ===========================================================================
// Part B: Patch sdk.mjs — voiceServerStart / voiceServerStop methods
// ===========================================================================

console.log('\n\n=== Part B: Patching sdk.mjs ===')

const SDK_MARKER = '/*PATCHED:voice-server-sdk*/'

let sdkSrc
try {
  sdkSrc = readFileSync(sdkPath, 'utf-8')
} catch (err) {
  console.error(`ERROR: Cannot read ${sdkPath}`)
  process.exit(1)
}

console.log(`Read ${sdkPath} (${(sdkSrc.length / 1024).toFixed(0)} KB)`)

if (sdkSrc.includes(SDK_MARKER)) {
  console.log('Part B already applied. Skipping.')
} else {
  // Anchor: async stopTask(<var>){await this.request({subtype:"stop_task",task_id:<var>})}
  const sdkAnchorRe = new RegExp(
    `async stopTask\\((${V})\\)\\{await this\\.request\\(\\{subtype:"stop_task",task_id:\\1\\}\\)\\}`
  )
  const sdkMatch = sdkAnchorRe.exec(sdkSrc)
  if (!sdkMatch) {
    console.error('ERROR: Cannot locate stopTask anchor in sdk.mjs')
    process.exit(1)
  }

  const sdkIdx = sdkMatch.index

  // Verify uniqueness
  const allSdkMatches = [...sdkSrc.matchAll(new RegExp(sdkAnchorRe, 'g'))]
  if (allSdkMatches.length > 1) {
    console.error('ERROR: stopTask anchor matched multiple times in sdk.mjs')
    process.exit(1)
  }
  console.log(`Found stopTask anchor at char ${sdkIdx}`)

  // Inject after the closing } of stopTask
  const insertAt = sdkIdx + sdkMatch[0].length
  const sdkInjection =
    SDK_MARKER +
    `async voiceServerStart(){return(await this.request({subtype:"voice_server_start"})).response}` +
    `async voiceServerStop(){return(await this.request({subtype:"voice_server_stop"})).response}`

  sdkSrc = sdkSrc.slice(0, insertAt) + sdkInjection + sdkSrc.slice(insertAt)
  writeFileSync(sdkPath, sdkSrc)
  console.log(`Patch applied to ${sdkPath}`)

  const sdkVerify = readFileSync(sdkPath, 'utf-8')
  if (!sdkVerify.includes(SDK_MARKER)) {
    console.error('Part B verification FAILED')
    process.exit(1)
  }
  console.log('  OK Part B marker verified')
}

console.log('')
console.log('What this does:')
console.log('  cli.js:  voice_server_start — TCP server on 127.0.0.1:0, wires audio → hb8() → transcripts')
console.log('  cli.js:  voice_server_stop — shuts down the TCP server')
console.log('  sdk.mjs: voiceServerStart() / voiceServerStop() methods on query object')

/**
 * Patch: queue-control
 *
 * Adds two control-request subtypes to the CLI's message loop so the SDK
 * consumer can manage the output queue mid-agent-turn:
 *
 *   queue_message   — push {mode:"prompt", value, uuid} into VH via Jk(),
 *                     then kick G6() so the do-while loop picks it up
 *                     between pPq sub-turns.
 *
 *   dequeue_message — remove a queued item by uuid via KP6(), allowing
 *                     the consumer to withdraw/edit before it's processed.
 *
 * See README.md for full analysis.
 *
 * Usage: node patch/queue-control/apply.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '../..')
const cliPath = resolve(projectRoot, 'node_modules/@anthropic-ai/claude-agent-sdk/cli.js')
const sdkPath = resolve(projectRoot, 'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs')

// ---------------------------------------------------------------------------
// Step 1: Read cli.js
// ---------------------------------------------------------------------------

let src
try {
  src = readFileSync(cliPath, 'utf-8')
} catch (err) {
  console.error(`ERROR: Cannot read ${cliPath}`)
  console.error('Is @anthropic-ai/claude-agent-sdk installed?')
  process.exit(1)
}

console.log(`Read ${cliPath} (${(src.length / 1024 / 1024).toFixed(1)} MB)`)

const PATCH_MARKER = '/*PATCHED:queue-control*/'
let skipPartA = false

if (src.includes(PATCH_MARKER)) {
  console.log('Part A already applied. Skipping cli.js.')
  skipPartA = true
}

if (!skipPartA) {
// ---------------------------------------------------------------------------
// Step 2: Find the injection point
//
// The control-request handler chain ends with:
//   else o(c,`Unsupported control request subtype: ${c.request.subtype}`);
//   continue}else if(c.type==="control_response")
//
// We inject our new handlers right before the "Unsupported" fallback.
// ---------------------------------------------------------------------------

console.log('\n--- Locating control-request fallback ---')

// We match the transition from stop_task's catch into the Unsupported fallback.
// This is unique because it combines the specific error message text with the
// control_response branch that immediately follows.
const anchor = 'else o(c,`Unsupported control request subtype: ${c.request.subtype}`);continue}else if(c.type==="control_response")'

const anchorIdx = src.indexOf(anchor)
if (anchorIdx === -1) {
  console.error('ERROR: Cannot locate control-request fallback anchor.')
  console.error('Expected: ...else o(c,`Unsupported control request subtype: ...`);continue}else if(c.type==="control_response")...')
  process.exit(1)
}

// Verify uniqueness
if (src.indexOf(anchor, anchorIdx + 1) !== -1) {
  console.error('ERROR: Anchor matched multiple times. Aborting.')
  process.exit(1)
}

console.log(`Found fallback anchor at char ${anchorIdx}`)

// ---------------------------------------------------------------------------
// Step 3: Verify Jk, KP6, G6 are reachable
//
// Jk  — module-level function: push to output queue VH
// KP6 — module-level function: remove from VH by predicate
// G6  — local async function in the same closure: starts the turn loop
// t   — local function: send success control_response
// o   — local function: send error control_response
//
// We verify Jk and KP6 exist as functions, and G6/t/o by their usage in
// the nearby stop_task handler.
// ---------------------------------------------------------------------------

console.log('\n--- Verifying required functions ---')

// Jk: function Jk(A){VH.push(...
const jkRe = /function Jk\([^)]+\)\{/
if (!jkRe.test(src)) {
  console.error('ERROR: Cannot find function Jk (queue push)')
  process.exit(1)
}
console.log('  Jk (queue push): found')

// KP6: function KP6(A){...VH...splice...
const kp6Re = /function KP6\([^)]+\)\{/
if (!kp6Re.test(src)) {
  console.error('ERROR: Cannot find function KP6 (queue remove)')
  process.exit(1)
}
console.log('  KP6 (queue remove by predicate): found')

// G6 — verify it's called in the nearby code (user message handler calls G6())
const nearbyCtx = src.slice(Math.max(0, anchorIdx - 5000), anchorIdx + 1000)
if (!nearbyCtx.includes('G6()')) {
  console.error('ERROR: Cannot find G6() call in nearby context. Variable name may have changed.')
  process.exit(1)
}
console.log('  G6 (turn loop starter): found in nearby scope')

// t and o — already used by stop_task: t(c,{}) and o(c,...
if (!nearbyCtx.includes('t(c,{') || !nearbyCtx.includes('o(c,')) {
  console.error('ERROR: Cannot find t(c,...) or o(c,...) in nearby context.')
  process.exit(1)
}
console.log('  t/o (control response helpers): found')

// Id — function Id(){return VH.length>0}
const idRe = /function Id\(\)\{return VH\.length>0\}/
if (!idRe.test(src)) {
  console.error('ERROR: Cannot find function Id (queue non-empty check)')
  process.exit(1)
}
console.log('  Id (queue check): found')

// ---------------------------------------------------------------------------
// Step 4: Inject the patch
//
// We insert two new `else if` branches before the "Unsupported" fallback:
//
//   else if(c.request.subtype==="queue_message"){
//     let{value:Y6,uuid:O6}=c.request;
//     Jk({mode:"prompt",value:Y6,uuid:O6});
//     G6();
//     t(c,{queued:!0})
//   }
//   else if(c.request.subtype==="dequeue_message"){
//     let{uuid:Y6}=c.request;
//     let O6=KP6((_6)=>_6.uuid===Y6);
//     t(c,{removed:O6.length})
//   }
// ---------------------------------------------------------------------------

console.log('\n--- Injecting queue-control handlers ---')

const injection = PATCH_MARKER +
  `else if(c.request.subtype==="queue_message"){` +
    `let{value:Y6,uuid:O6}=c.request;` +
    `Jk({mode:"prompt",value:Y6,uuid:O6});` +
    `G6();` +
    `t(c,{queued:!0})` +
  `}` +
  `else if(c.request.subtype==="dequeue_message"){` +
    `let{uuid:Y6}=c.request;` +
    `let O6=KP6((_6)=>_6.uuid===Y6);` +
    `t(c,{removed:O6.length})` +
  `}`

// Insert right before the "else o(c,`Unsupported..." fallback
src = src.slice(0, anchorIdx) + injection + src.slice(anchorIdx)

// ---------------------------------------------------------------------------
// Step 5: Write and verify
// ---------------------------------------------------------------------------

writeFileSync(cliPath, src)
console.log(`\nPatch applied to ${cliPath}`)

const verify = readFileSync(cliPath, 'utf-8')
const ok = verify.includes(PATCH_MARKER)
console.log(`  ${ok ? 'OK' : 'MISSING'} Patch marker`)

if (!ok) {
  console.error('\nVerification FAILED.')
  process.exit(1)
}

console.log('\nPart A verified (cli.js).')
} // end if (!skipPartA)

// ===========================================================================
// Part B: Patch sdk.mjs — expose queueMessage / dequeueMessage on the query
// ===========================================================================

console.log('\n\n=== Part B: Patching sdk.mjs ===')

const SDK_MARKER = '/*PATCHED:queue-control-sdk*/'

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
  // Anchor: async stopTask(Q){await this.request({subtype:"stop_task",task_id:Q})}
  const sdkAnchor = 'async stopTask(Q){await this.request({subtype:"stop_task",task_id:Q})}'
  const sdkIdx = sdkSrc.indexOf(sdkAnchor)
  if (sdkIdx === -1) {
    console.error('ERROR: Cannot locate stopTask anchor in sdk.mjs')
    process.exit(1)
  }
  if (sdkSrc.indexOf(sdkAnchor, sdkIdx + 1) !== -1) {
    console.error('ERROR: stopTask anchor matched multiple times in sdk.mjs')
    process.exit(1)
  }
  console.log(`Found stopTask anchor at char ${sdkIdx}`)

  // Inject after the closing } of stopTask
  const insertAt = sdkIdx + sdkAnchor.length
  const sdkInjection = SDK_MARKER +
    `async queueMessage(Q,X){return await this.request({subtype:"queue_message",value:Q,uuid:X})}` +
    `async dequeueMessage(Q){return await this.request({subtype:"dequeue_message",uuid:Q})}`

  sdkSrc = sdkSrc.slice(0, insertAt) + sdkInjection + sdkSrc.slice(insertAt)
  writeFileSync(sdkPath, sdkSrc)
  console.log(`Patch applied to ${sdkPath}`)

  const sdkVerify = readFileSync(sdkPath, 'utf-8')
  const sdkOk = sdkVerify.includes(SDK_MARKER)
  console.log(`  ${sdkOk ? 'OK' : 'MISSING'} SDK patch marker`)
  if (!sdkOk) {
    console.error('\nPart B verification FAILED.')
    process.exit(1)
  }
  console.log('\nPart B verified (sdk.mjs).')
}

console.log('')
console.log('What this does:')
console.log('  cli.js:  queue_message / dequeue_message control-request handlers')
console.log('  sdk.mjs: queueMessage() / dequeueMessage() methods on the query object')

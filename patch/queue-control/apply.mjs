/**
 * Patch: queue-control
 *
 * Adds two control-request subtypes to the CLI's message loop so the SDK
 * consumer can manage the output queue mid-agent-turn:
 *
 *   queue_message   — push {mode:"prompt", value, uuid} into the queue via
 *                     the queue-push function, then kick the turn-loop starter
 *                     so the do-while loop picks it up between sub-turns.
 *
 *   dequeue_message — remove a queued item by uuid via the queue-remove-by-
 *                     predicate function, allowing the consumer to withdraw/
 *                     edit before it's processed.
 *
 * All minified function names are extracted dynamically from content patterns
 * so the patch survives SDK version bumps.
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

// Regex shorthand for minified identifier
const V = '[\\w$]+'

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
//   else <errorFn>(c,`Unsupported control request subtype: ${c.request.subtype}`);
//   continue}else if(c.type==="control_response")
//
// We use a regex to match this, capturing the error-response helper name.
// ---------------------------------------------------------------------------

console.log('\n--- Locating control-request fallback ---')

// Match: else <ERR>(c,`Unsupported control request subtype: ${c.request.subtype}`);continue}else if(c.type==="control_response")
// Captures: ERR = error response helper (was 'o' in 0.2.49/0.2.50)
const anchorRe = new RegExp(
  `else (${V})\\(c,\`Unsupported control request subtype: \\$\\{c\\.request\\.subtype\\}\`\\);continue\\}else if\\(c\\.type==="control_response"\\)`
)

const anchorMatch = anchorRe.exec(src)
if (!anchorMatch) {
  console.error('ERROR: Cannot locate control-request fallback anchor.')
  console.error('Pattern: else <fn>(c,`Unsupported control request subtype: ...`);continue}else if(c.type==="control_response")')
  process.exit(1)
}

const anchorIdx = anchorMatch.index
const errFn = anchorMatch[1]

// Verify uniqueness — search again from after the first match
if (anchorRe.exec(src.slice(anchorIdx + 1))?.index !== undefined) {
  // Double check: re-run on full source and count
  const allMatches = [...src.matchAll(new RegExp(anchorRe, 'g'))]
  if (allMatches.length > 1) {
    console.error('ERROR: Anchor matched multiple times. Aborting.')
    process.exit(1)
  }
}

console.log(`Found fallback anchor at char ${anchorIdx}`)
console.log(`  Error response helper: ${errFn}`)

// ---------------------------------------------------------------------------
// Step 3: Extract minified function names from content patterns
//
// We look in the nearby context (within ~5000 chars of the anchor) for known
// structural patterns to extract the actual minified names.
// ---------------------------------------------------------------------------

console.log('\n--- Extracting function names from content patterns ---')

const nearbyCtx = src.slice(Math.max(0, anchorIdx - 5000), anchorIdx + 2000)

// --- Success response helper ---
// Used in stop_task handler: <successFn>(c,{})
// Pattern: )<successFn>(c,{}) right after await ... in stop_task
const successRe = new RegExp(`\\),(${V})\\(c,\\{\\}\\)\\}catch`)
const successMatch = successRe.exec(nearbyCtx)
if (!successMatch) {
  console.error('ERROR: Cannot find success response helper pattern: ),<fn>(c,{})}}catch')
  process.exit(1)
}
const successFn = successMatch[1]
console.log(`  Success response helper: ${successFn}`)

// --- Queue push function ---
// In the user-message handler (after the anchor): <pushFn>({mode:"prompt",value:...,uuid:...}),<loopFn>()
const pushLoopRe = new RegExp(`(${V})\\(\\{mode:"prompt",value:${V}\\.message\\.content,uuid:${V}\\.uuid\\}\\),(${V})\\(\\)`)
const pushLoopMatch = pushLoopRe.exec(nearbyCtx)
if (!pushLoopMatch) {
  console.error('ERROR: Cannot find queue-push + loop-starter pattern: <fn>({mode:"prompt",...}),<fn>()')
  process.exit(1)
}
const pushFn = pushLoopMatch[1]
const loopFn = pushLoopMatch[2]
console.log(`  Queue push function: ${pushFn}`)
console.log(`  Turn loop starter: ${loopFn}`)

// --- Queue remove-by-predicate function ---
// In the queue module, it's defined near the push function. Pattern:
//   function <removeFn>(<arg>){let <var>=[];for(let <v2>=<queueArr>.length-1;...
//     if(<arg>(<queueArr>[<v2>]))<var>.unshift(<queueArr>.splice(<v2>,1)[0]);
// We find it by searching for the push function definition first, then scanning nearby.
const pushDefRe = new RegExp(`function ${pushFn.replace(/\$/g, '\\$')}\\((${V})\\)\\{(${V})\\.push\\(`)
const pushDefMatch = pushDefRe.exec(src)
if (!pushDefMatch) {
  console.error(`ERROR: Cannot find definition of queue push function: function ${pushFn}(...)`)
  process.exit(1)
}
const pushDefIdx = pushDefMatch.index
const queueArr = pushDefMatch[2]
console.log(`  Queue array: ${queueArr}`)

// Now scan ~1000 chars after pushFn definition for the remove-by-predicate function.
// It has a distinctive pattern: unshift(QUEUE.splice(
const queueModule = src.slice(pushDefIdx, pushDefIdx + 1500)
const removeFnRe = new RegExp(`function (${V})\\(${V}\\)\\{let ${V}=\\[\\];for\\(let ${V}=${queueArr.replace(/\$/g, '\\$')}\\.length-1`)
const removeFnMatch = removeFnRe.exec(queueModule)
if (!removeFnMatch) {
  console.error(`ERROR: Cannot find queue remove-by-predicate function near queue push definition`)
  process.exit(1)
}
const removeFn = removeFnMatch[1]
console.log(`  Queue remove-by-predicate: ${removeFn}`)

// ---------------------------------------------------------------------------
// Step 4: Inject the patch
//
// We insert two new `else if` branches before the "Unsupported" fallback:
//
//   else if(c.request.subtype==="queue_message"){
//     let{value:Y6,uuid:O6}=c.request;
//     <pushFn>({mode:"prompt",value:Y6,uuid:O6});
//     <loopFn>();
//     <successFn>(c,{queued:!0})
//   }
//   else if(c.request.subtype==="dequeue_message"){
//     let{uuid:Y6}=c.request;
//     let O6=<removeFn>((_6)=>_6.uuid===Y6);
//     <successFn>(c,{removed:O6.length})
//   }
// ---------------------------------------------------------------------------

console.log('\n--- Injecting queue-control handlers ---')

const injection = PATCH_MARKER +
  `else if(c.request.subtype==="queue_message"){` +
    `let{value:Y6,uuid:O6}=c.request;` +
    `${pushFn}({mode:"prompt",value:Y6,uuid:O6});` +
    `${loopFn}();` +
    `${successFn}(c,{queued:!0})` +
  `}` +
  `else if(c.request.subtype==="dequeue_message"){` +
    `let{uuid:Y6}=c.request;` +
    `let O6=${removeFn}((_6)=>_6.uuid===Y6);` +
    `${successFn}(c,{removed:O6.length})` +
  `}`

// Insert right before the "else <errFn>(c,`Unsupported..." fallback
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
  // Anchor: async stopTask(<var>){await this.request({subtype:"stop_task",task_id:<var>})}
  // Use a regex to be resilient to parameter name changes
  const sdkAnchorRe = new RegExp(
    `async stopTask\\((${V})\\)\\{await this\\.request\\(\\{subtype:"stop_task",task_id:\\1\\}\\)\\}`
  )
  const sdkMatch = sdkAnchorRe.exec(sdkSrc)
  if (!sdkMatch) {
    console.error('ERROR: Cannot locate stopTask anchor in sdk.mjs')
    console.error('Pattern: async stopTask(<var>){await this.request({subtype:"stop_task",task_id:<var>})}')
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

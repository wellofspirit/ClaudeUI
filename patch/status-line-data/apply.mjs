/**
 * Patch: status-line-data
 *
 * Emits a `system` message with `subtype: "status_line"` after each `result`
 * message in the main SDK message loop. This exposes the same cost, token,
 * line-change, and context-window data that the CLI's terminal status bar
 * displays (assembled by wGz()), making it available to SDK consumers.
 *
 * We call the same global getters and helper functions that wGz() uses,
 * so the data is identical to what the CLI displays.
 *
 * See README.md for full analysis.
 *
 * Usage: node patch/status-line-data/apply.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '../..')
const cliPath = resolve(projectRoot, 'node_modules/@anthropic-ai/claude-agent-sdk/cli.js')

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

const versionMatch = src.match(/Version:\s*([\d.]+)/)
if (versionMatch) {
  console.log(`CLI version: ${versionMatch[1]}`)
}

// ---------------------------------------------------------------------------
// Step 2: Check if already patched
// ---------------------------------------------------------------------------

const patchMarker = '/*PATCHED:status-line-data*/'

if (src.includes(patchMarker)) {
  console.log('\nPatch already applied. Nothing to do.')
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Step 3: Locate the anchor — W.enqueue(D1)}LIA(),kIA()
//
// This is the end of the `for await` loop in T0z that processes all SDK
// messages. We inject our status_line emission after W.enqueue(D1).
//
// Strategy:
// 1. Find the unique anchor pattern (enqueue + two trailing fn calls)
// 2. Extract minified variable names dynamically
// 3. Find global getters + context-window helpers by their function bodies
// ---------------------------------------------------------------------------

// Step 3a: Find the anchor pattern dynamically
const anchorRe = new RegExp(
  `(${V})\\.enqueue\\((${V})\\)\\}(${V})\\(\\),(${V})\\(\\)`
)

const anchorMatches = []
let anchorMatch
const anchorReGlobal = new RegExp(anchorRe.source, 'g')
while ((anchorMatch = anchorReGlobal.exec(src)) !== null) {
  anchorMatches.push(anchorMatch)
}

if (anchorMatches.length === 0) {
  console.error('ERROR: Cannot locate enqueue anchor pattern.')
  process.exit(1)
}

// Filter to the one followed by `};do{` (the do-while loop for queued commands)
const validAnchors = anchorMatches.filter((m) => {
  const after = src.slice(m.index + m[0].length, m.index + m[0].length + 10)
  return after.startsWith('}};do{') || after.startsWith('};do{')
})

if (validAnchors.length !== 1) {
  console.error(`ERROR: Expected 1 anchor match near do-while, found ${validAnchors.length}.`)
  if (validAnchors.length > 0) {
    validAnchors.forEach((m, i) => console.error(`  Match ${i}: char ${m.index} → ${m[0].slice(0, 60)}`))
  }
  process.exit(1)
}

const anchor = validAnchors[0]
const [anchorFull, enqueueTarget, msgVar, postFn1, postFn2] = anchor
const anchorIdx = anchor.index

console.log(`Found anchor at char ${anchorIdx}`)
console.log(`  Enqueue: ${enqueueTarget}.enqueue(${msgVar})`)
console.log(`  Post-fns: ${postFn1}(), ${postFn2}()`)

// Step 3b: Find the messages array variable (N) at the injection point.
// Pattern: N.push(D1);W.enqueue(D1) — N is the transcript array.
{
  const nearby = src.slice(anchorIdx - 200, anchorIdx + anchorFull.length)
  const pushRe = new RegExp(`(${V})\\.push\\(${msgVar}\\);${enqueueTarget}\\.enqueue\\(${msgVar}\\)`)
  const pushMatch = nearby.match(pushRe)
  if (!pushMatch) {
    console.error('ERROR: Cannot find N.push(D1) near anchor.')
    process.exit(1)
  }
  var msgsVar = pushMatch[1]
  console.log(`  Messages array: ${msgsVar}`)
}

// Step 3c: Find the global getters by their unique function bodies

function findGetter(propName, storeName = 'n6') {
  const re = new RegExp(`function (${V})\\(\\)\\{return ${storeName}\\.${propName}\\}`)
  const m = src.match(re)
  if (!m) {
    console.error(`ERROR: Cannot find getter for ${storeName}.${propName}`)
    process.exit(1)
  }
  console.log(`  ${propName} → ${m[1]}()`)
  return m[1]
}

function findAggregator(propName) {
  const re = new RegExp(`function (${V})\\(\\)\\{return (${V})\\(Object\\.values\\(n6\\.modelUsage\\),"${propName}"\\)\\}`)
  const m = src.match(re)
  if (!m) {
    console.error(`ERROR: Cannot find aggregator for ${propName}`)
    process.exit(1)
  }
  console.log(`  ${propName} (aggregated) → ${m[1]}()`)
  return m[1]
}

console.log('Locating getters:')
const fnTotalCost = findGetter('totalCostUSD')
const fnApiDuration = findGetter('totalAPIDuration')
const fnLinesAdded = findGetter('totalLinesAdded')
const fnLinesRemoved = findGetter('totalLinesRemoved')
const fnSessionId = findGetter('sessionId')
const fnSdkBetas = findGetter('sdkBetas')

const fnTotalDuration = (() => {
  // Pattern: function XX(){return Date.now()-n6.startTime}
  const re = new RegExp(`function (${V})\\(\\)\\{return Date\\.now\\(\\)-n6\\.startTime\\}`)
  const m = src.match(re)
  if (!m) {
    console.error('ERROR: Cannot find duration getter (Date.now()-n6.startTime)')
    process.exit(1)
  }
  console.log(`  totalDuration → ${m[1]}()`)
  return m[1]
})()

const fnInputTokens = findAggregator('inputTokens')
const fnOutputTokens = findAggregator('outputTokens')
const fnCacheReadTokens = findAggregator('cacheReadInputTokens')
const fnCacheCreationTokens = findAggregator('cacheCreationInputTokens')

// Step 3d: Find context-window helper functions by their bodies

// yH6(msgs) — extracts usage from last assistant message
// Pattern: for(let q=A.length-1;q>=0;q--){...Lp(K)...input_tokens...}
const fnGetUsage = (() => {
  const re = new RegExp(
    `function (${V})\\(A\\)\\{for\\(let q=A\\.length-1;q>=0;q--\\)\\{let K=A\\[q\\],Y=K\\?(${V})\\(K\\):void 0;if\\(Y\\)return\\{input_tokens`
  )
  const m = src.match(re)
  if (!m) {
    console.error('ERROR: Cannot find yH6 (usage-from-messages) function.')
    process.exit(1)
  }
  console.log(`  getUsageFromMessages → ${m[1]}()`)
  return m[1]
})()

// xG(model, betas) — returns context window size (200k or 1M)
// Pattern: function XX(A,q){if(A.includes("[1m]")||q?.includes(...)...return 1e6;return RBq}
const fnContextWindowSize = (() => {
  const re = new RegExp(
    `function (${V})\\(A,q\\)\\{if\\(A\\.includes\\("\\[1m\\]"\\)\\|\\|q\\?\\.includes\\(${V}\\)&&${V}\\(A\\)\\)return 1e6;return (${V})\\}`
  )
  const m = src.match(re)
  if (!m) {
    console.error('ERROR: Cannot find xG (context-window-size) function.')
    process.exit(1)
  }
  console.log(`  contextWindowSize → ${m[1]}(model, betas), default=${m[2]}`)
  return m[1]
})()

// ZiA(usage, windowSize) — returns {used, remaining} percentages
// Pattern: function XX(A,q){if(!A)return{used:null,remaining:null};...Math.round(K/q*100)...}
const fnCalcPercentage = (() => {
  const re = new RegExp(
    `function (${V})\\(A,q\\)\\{if\\(!A\\)return\\{used:null,remaining:null\\};let K=A\\.input_tokens\\+A\\.cache_creation_input_tokens\\+A\\.cache_read_input_tokens`
  )
  const m = src.match(re)
  if (!m) {
    console.error('ERROR: Cannot find ZiA (percentage-calc) function.')
    process.exit(1)
  }
  console.log(`  calcPercentage → ${m[1]}(usage, windowSize)`)
  return m[1]
})()

// u3() — returns the main loop model string
// Pattern: function u3(){let A=Xu();if(A!==void 0&&A!==null)return l3(A);return wv()}
const fnMainModel = (() => {
  const re = new RegExp(
    `function (${V})\\(\\)\\{let A=(${V})\\(\\);if\\(A!==void 0&&A!==null\\)return (${V})\\(A\\);return (${V})\\(\\)\\}`
  )
  const m = src.match(re)
  if (!m) {
    console.error('ERROR: Cannot find u3 (main-model) function.')
    process.exit(1)
  }
  console.log(`  mainModel → ${m[1]}()`)
  return m[1]
})()

// Find uuid function (randomUUID) in scope at the injection point.
const t0zMatch = src.match(/function T0z\b/)
if (!t0zMatch) {
  console.error('ERROR: Cannot find T0z function.')
  process.exit(1)
}

const beforeT0z = src.slice(0, t0zMatch.index)
const uuidImports = [...beforeT0z.matchAll(new RegExp(`randomUUID as (${V})`, 'g'))]
if (uuidImports.length === 0) {
  console.error('ERROR: Cannot find randomUUID import before T0z.')
  process.exit(1)
}
const fnUuid = uuidImports[uuidImports.length - 1][1]
console.log(`  uuid → ${fnUuid}()`)

// Find the session persistence singleton getter: function XX(){if(!YY){if(YY=new ZZ,...flush()...}return YY}
const fnPersist = (() => {
  const re = new RegExp(
    `function (${V})\\(\\)\\{if\\(!(${V})\\)\\{if\\(\\2=new ${V},!${V}\\)vq\\(async\\(\\)=>\\{await \\2\\?\\.flush\\(\\)\\}\\)`
  )
  const m = src.match(re)
  if (!m) {
    console.error('ERROR: Cannot find session persistence singleton getter.')
    process.exit(1)
  }
  console.log(`  persistenceGetter → ${m[1]}()`)
  return m[1]
})()

// ---------------------------------------------------------------------------
// Step 4: Build the patch
//
// We inject AFTER `W.enqueue(D1)` and BEFORE `}LIA(),kIA()`.
// When D1.type === "result", we compute context-window usage (exactly as
// wGz does) and enqueue a supplementary status_line message.
//
// Injected code (pseudo):
//   if (D1.type === "result") {
//     var _u = yH6(N);                    // current token usage from messages
//     var _cws = xG(u3(), cP());          // context window size for model
//     var _pct = ZiA(_u, _cws);           // used/remaining percentages
//     var _slm = { type, subtype, session_id, uuid, cost, context_window };
//     W.enqueue(_slm);                    // send to SDK consumer stream
//     jD().appendEntry(_slm);             // persist via SDK's own JSONL writer
//   }
// ---------------------------------------------------------------------------

const injection =
  `${patchMarker}` +
  `if(${msgVar}.type==="result"){` +
    `var _slu=${fnGetUsage}(${msgsVar}),` +
        `_slw=${fnContextWindowSize}(${fnMainModel}(),${fnSdkBetas}()),` +
        `_slp=${fnCalcPercentage}(_slu,_slw),` +
        `_slm={` +
          `type:"system",` +
          `subtype:"status_line",` +
          `session_id:${fnSessionId}(),` +
          `uuid:${fnUuid}(),` +
          `cost:{` +
            `total_cost_usd:${fnTotalCost}(),` +
            `total_duration_ms:${fnTotalDuration}(),` +
            `total_api_duration_ms:${fnApiDuration}(),` +
            `total_lines_added:${fnLinesAdded}(),` +
            `total_lines_removed:${fnLinesRemoved}()` +
          `},` +
          `context_window:{` +
            `total_input_tokens:${fnInputTokens}(),` +
            `total_output_tokens:${fnOutputTokens}(),` +
            `context_window_size:_slw,` +
            `used_percentage:_slp.used,` +
            `remaining_percentage:_slp.remaining` +
          `}` +
        `};` +
    `${enqueueTarget}.enqueue(_slm);` +
    `${fnPersist}().appendEntry(_slm)` +
  `}`

// The injection goes between `W.enqueue(D1)` and `}LIA(),kIA()`
// Original: W.enqueue(D1)}LIA(),kIA()
// Patched:  W.enqueue(D1);/*PATCHED:...*/if(D1.type==="result"){...}}LIA(),kIA()
const enqueueCall = `${enqueueTarget}.enqueue(${msgVar})`
const enqueueEnd = anchorIdx + enqueueCall.length
const afterEnqueue = src.slice(enqueueEnd, anchorIdx + anchorFull.length)

const patched = enqueueCall + ';' + injection + afterEnqueue
src = src.slice(0, anchorIdx) + patched + src.slice(anchorIdx + anchorFull.length)

// ---------------------------------------------------------------------------
// Step 5: Write and verify
// ---------------------------------------------------------------------------

writeFileSync(cliPath, src)
console.log(`\nPatch applied to ${cliPath}`)

const verify = readFileSync(cliPath, 'utf-8')
if (!verify.includes(patchMarker)) {
  console.error('ERROR: Verification failed — patch marker not found after write.')
  process.exit(1)
}

if (!verify.includes('subtype:"status_line"')) {
  console.error('ERROR: Verification failed — status_line subtype not found.')
  process.exit(1)
}

if (!verify.includes('used_percentage:_slp.used')) {
  console.error('ERROR: Verification failed — context_window percentage not found.')
  process.exit(1)
}

console.log('Verified: patch is in place.')
console.log('')
console.log('What this does:')
console.log('  After each "result" message in the SDK stream, emits a')
console.log('  system message with subtype "status_line" containing:')
console.log('  - cost (USD, duration, API duration, lines added/removed)')
console.log('  - context_window (total tokens, window size, used/remaining %)')
console.log('  This data mirrors what the CLI terminal status bar shows.')

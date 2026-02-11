/**
 * Patch: task-notification
 *
 * Fixes Claude Code CLI's headless/SDK mode to deliver background task
 * completion notifications. See README.md for full analysis.
 *
 * Usage: node patch/task-notification/apply.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '../..')
const cliPath = resolve(projectRoot, 'node_modules/@anthropic-ai/claude-agent-sdk/cli.js')

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

// Extract the CLI version for logging
const versionMatch = src.match(/Version:\s*([\d.]+)/)
if (versionMatch) {
  console.log(`CLI version: ${versionMatch[1]}`)
}

// ---------------------------------------------------------------------------
// Step 2: Locate functions by content pattern
//
// We identify functions by their unique behavior, not their minified names.
// This makes the patch resilient to name changes across versions.
// ---------------------------------------------------------------------------

/**
 * Find the HST array name and its associated functions.
 *
 * Pattern: the enqueue function (WR/iN equivalent) has a unique signature:
 *   function NAME(X) { ARRAY.push(X), NOTIFY(), TRACK("enqueue", ...) }
 *
 * From this we extract ARRAY (HST) and then find:
 *   - hstHasItems: function that returns ARRAY.length > 0
 *   - hstDequeue:  function that shifts from ARRAY
 */

// Find the enqueue-to-HST function: pushes to an array, then calls notify and track("enqueue")
const enqueuePattern = /function (\w+)\((\w)\)\{\s*(\w+)\.push\(\2\),\s*(\w+)\(\),\s*(\w+)\("enqueue"/
const enqueueMatch = src.match(enqueuePattern)

if (!enqueueMatch) {
  console.error('ERROR: Cannot locate the HST enqueue function (WR/iN equivalent).')
  console.error('The CLI code structure may have changed. Manual inspection needed.')
  process.exit(1)
}

const [, enqueueFnName, , hstArrayName, notifyFnName] = enqueueMatch
console.log(`Found HST enqueue function: ${enqueueFnName}() → ${hstArrayName}.push()`)

// Find hstHasItems: function() { return ARRAY.length > 0 }
const hasItemsPattern = new RegExp(
  `function (\\w+)\\(\\)\\{return ${hstArrayName}\\.length>0\\}`
)
const hasItemsMatch = src.match(hasItemsPattern)

if (!hasItemsMatch) {
  console.error(`ERROR: Cannot locate HST hasItems function for array ${hstArrayName}`)
  process.exit(1)
}

const hstHasItemsFn = hasItemsMatch[1]
console.log(`Found HST hasItems function: ${hstHasItemsFn}()`)

// Find hstDequeue: function() { let X = ARRAY.shift(); if (X !== void 0) NOTIFY(); return X }
const dequeuePattern = new RegExp(
  `function (\\w+)\\(\\)\\{let (\\w)=${hstArrayName}\\.shift\\(\\);if\\(\\2!==void 0\\)${notifyFnName}\\(\\);return \\2\\}`
)
const dequeueMatch = src.match(dequeuePattern)

if (!dequeueMatch) {
  console.error(`ERROR: Cannot locate HST dequeue function for array ${hstArrayName}`)
  process.exit(1)
}

const hstDequeueFn = dequeueMatch[1]
console.log(`Found HST dequeue function: ${hstDequeueFn}()`)

// ---------------------------------------------------------------------------
// Step 3: Check if already patched
// ---------------------------------------------------------------------------

const patchMarker = `while(${hstHasItemsFn}()){let _h=${hstDequeueFn}()`

if (src.includes(patchMarker)) {
  console.log('\nPatch already applied. Nothing to do.')
  process.exit(0)
}

/**
 * Find the queuedCommands dequeue function (Z_6/dWR equivalent).
 *
 * Pattern: async function that checks queuedCommands.length === 0, then
 * atomically dequeues via a state setter, and calls TRACK("dequeue").
 *
 *   async function NAME(A, q) {
 *     if ((await A()).queuedCommands.length === 0) return;
 *     let Y;
 *     if (q((z) => { ... [Y] = z.queuedCommands ... }), Y) TRACK("dequeue");
 *     return Y;
 *   }
 */
const dequeueCmdPattern = /async function (\w+)\((\w),(\w)\)\{if\(\(await \2\(\)\)\.queuedCommands\.length===0\)return;/
const dequeueCmdMatch = src.match(dequeueCmdPattern)

if (!dequeueCmdMatch) {
  console.error('ERROR: Cannot locate queuedCommands dequeue function (Z_6/dWR equivalent).')
  console.error('The CLI code structure may have changed. Manual inspection needed.')
  process.exit(1)
}

const [, dequeueCmdFnName, getStateName, setStateName] = dequeueCmdMatch
console.log(`Found queuedCommands dequeue function: ${dequeueCmdFnName}(${getStateName}, ${setStateName})`)

// ---------------------------------------------------------------------------
// Step 4: Apply the patch
//
// Inject HST drain logic at the start of the queuedCommands dequeue function.
// Before checking if queuedCommands is empty, drain any items from HST into
// queuedCommands so they become visible to the headless streaming loop.
// ---------------------------------------------------------------------------

const originalPrefix =
  `async function ${dequeueCmdFnName}(${getStateName},${setStateName}){` +
  `if((await ${getStateName}()).queuedCommands.length===0)return;`

const patchedPrefix =
  `async function ${dequeueCmdFnName}(${getStateName},${setStateName}){` +
  `while(${hstHasItemsFn}()){` +
    `let _h=${hstDequeueFn}();` +
    `if(_h)${setStateName}((z)=>({...z,queuedCommands:[...z.queuedCommands,_h]}))` +
  `}` +
  `if((await ${getStateName}()).queuedCommands.length===0)return;`

const idx = src.indexOf(originalPrefix)
if (idx === -1) {
  console.error('ERROR: Could not find the exact code to patch.')
  console.error(`Expected: ${originalPrefix.slice(0, 100)}...`)
  process.exit(1)
}

// Ensure unique match
if (src.indexOf(originalPrefix, idx + 1) !== -1) {
  console.error('ERROR: Found multiple matches for the patch target. Aborting.')
  process.exit(1)
}

const patched = src.slice(0, idx) + patchedPrefix + src.slice(idx + originalPrefix.length)

// ---------------------------------------------------------------------------
// Step 5: Write and verify
// ---------------------------------------------------------------------------

writeFileSync(cliPath, patched)
console.log(`\nPatch applied to ${cliPath}`)

// Verify
const verify = readFileSync(cliPath, 'utf-8')
if (!verify.includes(patchMarker)) {
  console.error('ERROR: Verification failed — patch marker not found after write.')
  process.exit(1)
}

console.log('Verified: patch is in place.')
console.log('')
console.log('What this does:')
console.log('  Before checking queuedCommands (read by headless streaming loop),')
console.log('  drain HST (internal notification queue) into queuedCommands.')
console.log('  This bridges task completion notifications to headless/SDK mode.')

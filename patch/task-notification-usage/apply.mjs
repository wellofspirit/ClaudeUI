/**
 * Patch: task-notification-usage
 *
 * Adds <usage> extraction to the system task_notification message emitted
 * by the SDK streaming loop. Without this, background agent completion
 * notifications lack cost/token/duration data.
 *
 * See README.md for full analysis.
 *
 * Usage: node patch/task-notification-usage/apply.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '../..')
const cliPath = resolve(projectRoot, 'node_modules/@anthropic-ai/claude-agent-sdk/cli.js')

// Minified variable names can contain $ — use [\\w$] instead of \\w
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

const patchMarker = '/*PATCHED:task-notification-usage*/'

if (src.includes(patchMarker)) {
  console.log('\nPatch already applied. Nothing to do.')
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Step 3: Locate the P.enqueue call for task_notification
//
// Strategy: Find the unique pattern where summary is extracted via regex,
// followed by a status validator, followed by P.enqueue with
// subtype:"task_notification". We use a two-step approach:
//
// 1. Find the <summary> regex match (unique in codebase)
// 2. Extract the surrounding block and identify variable names
// 3. Patch the enqueue call to add usage extraction + field
// ---------------------------------------------------------------------------

// Step 3a: Find the summary regex match — unique anchor point
const summaryAnchor = 'match(/<summary>([^<]+)<\\/summary>/)'
const summaryIdx = src.indexOf(summaryAnchor)

if (summaryIdx === -1) {
  console.error('ERROR: Cannot locate <summary> regex match in task-notification handler.')
  process.exit(1)
}

console.log(`Found <summary> anchor at char ${summaryIdx}`)

// Step 3b: Extract the XML variable name (the var before .match)
// Pattern: VAR.match(/<summary>...)
const beforeSummary = src.slice(Math.max(0, summaryIdx - 50), summaryIdx)
const xmlVarMatch = beforeSummary.match(new RegExp(`(${V})\\.$`))
if (!xmlVarMatch) {
  console.error('ERROR: Cannot extract XML variable name before <summary> match.')
  process.exit(1)
}
const xmlVar = xmlVarMatch[1]
console.log(`  XML variable: ${xmlVar}`)

// Step 3c: Find the P.enqueue block that follows
// Pattern: VAR.enqueue({type:"system",subtype:"task_notification",...})
// Note: SDK 0.2.47+ added tool_use_id between task_id and status, so we
// capture it optionally to keep the patch working across versions.
const afterSummary = src.slice(summaryIdx, summaryIdx + 600)
const enqueueRe = new RegExp(
  `(${V})\\.enqueue\\(\\{` +
  `type:"system",subtype:"task_notification",` +
  `task_id:(${V})\\?\\.\\[1\\]\\?\\?"",` +
  `(?:tool_use_id:(${V})\\?\\.\\[1\\],)?` +  // optional tool_use_id (added in 0.2.47)
  `status:(${V}),` +
  `output_file:(${V})\\?\\.\\[1\\]\\?\\?"",` +
  `summary:(${V})\\?\\.\\[1\\]\\?\\?"",` +
  `session_id:(${V})\\(\\),` +
  `uuid:(${V})\\(\\)` +
  `\\}\\)`
)

const enqueueMatch = afterSummary.match(enqueueRe)

if (!enqueueMatch) {
  console.error('ERROR: Cannot locate enqueue({type:"system",subtype:"task_notification",...}) after summary.')
  console.error('Nearby code:', afterSummary.slice(0, 300))
  process.exit(1)
}

const [
  enqueueFullMatch,
  enqueueTarget,   // Z (0.2.47) / P (0.2.45)
  taskIdVar,       // z6 / w1
  toolUseIdVar,    // C6 (0.2.47+) or undefined (0.2.45)
  statusVar,       // m6 / G1
  outputFileVar,   // i6 / P1
  summaryVar,      // z1 / f1
  sessionIdFn,     // U1 / p6
  uuidFn           // kZ / SE
] = enqueueMatch

// Get absolute position of the enqueue call
const enqueueRelIdx = afterSummary.indexOf(enqueueFullMatch)
const enqueueAbsIdx = summaryIdx + enqueueRelIdx

console.log(`Found enqueue at char ${enqueueAbsIdx}`)
console.log(`  Enqueue target: ${enqueueTarget}, Status: ${statusVar}`)
console.log(`  TaskId: ${taskIdVar}, ToolUseId: ${toolUseIdVar || '(none)'}, OutputFile: ${outputFileVar}, Summary: ${summaryVar}`)
console.log(`  SessionId fn: ${sessionIdFn}(), UUID fn: ${uuidFn}()`)

// Verify uniqueness
if (src.indexOf(enqueueFullMatch, enqueueAbsIdx + 1) !== -1) {
  console.error('ERROR: Found multiple matches for enqueue pattern. Aborting.')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Step 4: Build the patched replacement
//
// We inject <usage> extraction just before the enqueue, and add a `usage`
// field to the enqueued object. The tool_use_id field (added in 0.2.47)
// is preserved when present.
//
// Before (0.2.47):
//   Z.enqueue({type:"system",subtype:"task_notification",
//     task_id:z6?.[1]??"",tool_use_id:C6?.[1],status:m6,
//     output_file:i6?.[1]??"",summary:z1?.[1]??"",
//     session_id:U1(),uuid:kZ()})
//
// After:
//   var _ub=E6.match(/<usage>([\s\S]*?)<\/usage>/),
//   _udata=_ub?{...}:null;
//   Z.enqueue({...,usage:_udata,...})
// ---------------------------------------------------------------------------

const usageExtraction =
  `${patchMarker}` +
  `var _ub=${xmlVar}.match(/<usage>([\\s\\S]*?)<\\/usage>/),` +
  `_udata=_ub?{` +
    `total_tokens:+((_ub[1].match(/total_tokens:\\s*(\\d+)/)||[])[1]||0),` +
    `tool_uses:+((_ub[1].match(/tool_uses:\\s*(\\d+)/)||[])[1]||0),` +
    `duration_ms:+((_ub[1].match(/duration_ms:\\s*(\\d+)/)||[])[1]||0)` +
  `}:null;`

const toolUseIdField = toolUseIdVar
  ? `tool_use_id:${toolUseIdVar}?.[1],`
  : ''

const newEnqueue =
  `${enqueueTarget}.enqueue({` +
  `type:"system",subtype:"task_notification",` +
  `task_id:${taskIdVar}?.[1]??"",` +
  toolUseIdField +
  `status:${statusVar},` +
  `output_file:${outputFileVar}?.[1]??"",` +
  `summary:${summaryVar}?.[1]??"",` +
  `usage:_udata,` +
  `session_id:${sessionIdFn}(),` +
  `uuid:${uuidFn}()` +
  `})`

const replacement = usageExtraction + newEnqueue

src = src.slice(0, enqueueAbsIdx) + replacement + src.slice(enqueueAbsIdx + enqueueFullMatch.length)

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

if (!verify.includes('usage:_udata')) {
  console.error('ERROR: Verification failed — usage field not found in enqueue.')
  process.exit(1)
}

console.log('Verified: patch is in place.')
console.log('')
console.log('What this does:')
console.log('  Extracts <usage> (total_tokens, tool_uses, duration_ms) from the')
console.log('  task-notification XML and includes it in the system message.')
console.log('  Background agent completions now carry cost/usage data.')

/**
 * Patch: request-usage
 *
 * Emits per-request token usage data from cli.js to the SDK consumer via
 * stdout after each API response completes (message_stop event).
 *
 * The CLI accumulates usage into `this.totalUsage` but never exposes the
 * per-request breakdown. This patch writes a `request_usage` JSON message
 * to stdout alongside the existing accumulation, giving SDK consumers
 * real-time visibility into cache effectiveness and token consumption.
 *
 * Usage: node patch/request-usage/apply.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '../..')
const cliPath = resolve(projectRoot, 'node_modules/@anthropic-ai/claude-agent-sdk/cli.js')

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

const PATCH_MARKER = '/*PATCHED:request-usage*/'

if (src.includes(PATCH_MARKER)) {
  console.log('Patch already applied. Skipping.')
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Step 2: Find the uuid function (randomUUID import near the tq5 class)
// ---------------------------------------------------------------------------
// The tq5 class (sdkQuery) imports randomUUID: import{randomUUID as <Dc>}from"crypto";class tq5
// We find it by the pattern: import{randomUUID as <V>}from"crypto";class <V>{config;mutableMessages

console.log('\n--- Locating uuid function (randomUUID import) ---')

const uuidImportRe = new RegExp(
  `import\\{randomUUID as (${V})\\}from"crypto";class (${V})\\{config;mutableMessages`
)
const uuidMatch = uuidImportRe.exec(src)
if (!uuidMatch) {
  console.error('ERROR: Cannot locate randomUUID import near sdkQuery class.')
  process.exit(1)
}

const uuidFn = uuidMatch[1]
const queryClass = uuidMatch[2]
console.log(`  UUID function: ${uuidFn}`)
console.log(`  Query class: ${queryClass}`)

// ---------------------------------------------------------------------------
// Step 3: Find the session_id function (N8)
// ---------------------------------------------------------------------------
// Pattern: session_id:<N8>() appears in yield statements near stream_event handling.
// We find it from the stream_event yield: yield{type:"stream_event",event:<q>.event,session_id:<N8>(),parent_tool_use_id:null,uuid:<Dc>()}

console.log('\n--- Locating session_id function ---')

const sessionIdRe = new RegExp(
  `yield\\{type:"stream_event",event:(${V})\\.event,session_id:(${V})\\(\\),parent_tool_use_id:null,uuid:${uuidFn.replace(/\$/g, '\\$')}\\(\\)`
)
const sessionMatch = sessionIdRe.exec(src)
if (!sessionMatch) {
  console.error('ERROR: Cannot locate session_id function from stream_event yield.')
  process.exit(1)
}

const sessionFn = sessionMatch[2]
console.log(`  Session ID function: ${sessionFn}`)

// ---------------------------------------------------------------------------
// Step 4: Find the message_start + message_stop pattern in stream_event handling
// ---------------------------------------------------------------------------
// Pattern:
//   if(<q>.event.type==="message_start")<H>=<O0>,<H>=<w56>(<H>,<q>.event.message.usage);
//   if(<q>.event.type==="message_delta"){if(<H>=<w56>(<H>,<q>.event.usage),<q>.event.delta.stop_reason!=null)<y>=<q>.event.delta.stop_reason}
//   if(<q>.event.type==="message_stop")this.totalUsage=<fB8>(this.totalUsage,<H>);

console.log('\n--- Locating stream_event message handling ---')

const streamRe = new RegExp(
  `if\\((${V})\\.event\\.type==="message_start"\\)(${V})=(${V}),\\2=(${V})\\(\\2,\\1\\.event\\.message\\.usage\\);` +
  `if\\(\\1\\.event\\.type==="message_delta"\\)\\{if\\(\\2=\\4\\(\\2,\\1\\.event\\.usage\\),(${V})\\.event\\.delta\\.stop_reason!=null\\)` +
  `(${V})=\\5\\.event\\.delta\\.stop_reason(?:;if\\(${V}\\)${V}\\(\\))?\\}` +
  `if\\(\\1\\.event\\.type==="message_stop"\\)this\\.totalUsage=(${V})\\(this\\.totalUsage,\\2\\)`
)
const streamMatch = streamRe.exec(src)
if (!streamMatch) {
  console.error('ERROR: Cannot locate stream_event message start/delta/stop pattern.')
  process.exit(1)
}

// Verify uniqueness
const allStreamMatches = [...src.matchAll(new RegExp(streamRe, 'g'))]
if (allStreamMatches.length > 1) {
  console.error(`ERROR: Pattern matched ${allStreamMatches.length} times (expected 1). Aborting.`)
  process.exit(1)
}

const eventVar = streamMatch[1]    // q8 — the stream event
const usageVar = streamMatch[2]    // H6 — per-request usage accumulator
const zeroUsage = streamMatch[3]   // O0 — zero-usage constant
const mergeFn = streamMatch[4]     // w56 — usage merge function
// streamMatch[5] is the same as eventVar (q8) in the delta check
const stopReasonVar = streamMatch[6] // y6 — stop reason
const accumFn = streamMatch[7]     // fB8 — total usage accumulation function

console.log(`Found at char ${streamMatch.index}`)
console.log(`  Event var: ${eventVar}`)
console.log(`  Usage var: ${usageVar}`)
console.log(`  Zero usage: ${zeroUsage}`)
console.log(`  Merge fn: ${mergeFn}`)
console.log(`  Stop reason var: ${stopReasonVar}`)
console.log(`  Accumulate fn: ${accumFn}`)

// ---------------------------------------------------------------------------
// Step 5: Inject the patch
// ---------------------------------------------------------------------------
// We modify the message_start handler to also capture the model:
//   ...<H>=<w56>(<H>,<q>.event.message.usage)
//   becomes:
//   ...<H>=<w56>(<H>,<q>.event.message.usage),this._patchModel=<q>.event.message.model
//
// And after message_stop accumulation:
//   this.totalUsage=<fB8>(this.totalUsage,<H>)
//   becomes:
//   this.totalUsage=<fB8>(this.totalUsage,<H>),process.stdout.write(JSON.stringify({...})+"\\n")

console.log('\n--- Injecting request_usage emission ---')

const original = streamMatch[0]

// Build the replacement:
// 1. message_start: add model capture after usage init
// 2. message_stop: add stdout write after totalUsage accumulation

const esc = (s) => s.replace(/\$/g, '\\$')

const messageStartOld =
  `${usageVar}=${mergeFn}(${usageVar},${eventVar}.event.message.usage)`
const messageStartNew =
  `${messageStartOld},this._patchModel=${eventVar}.event.message.model`

const messageStopOld =
  `this.totalUsage=${accumFn}(this.totalUsage,${usageVar})`
const messageStopNew =
  messageStopOld +
  PATCH_MARKER +
  `,process.stdout.write(JSON.stringify({` +
    `type:"request_usage",` +
    `usage:${usageVar},` +
    `model:this._patchModel||"",` +
    `uuid:${uuidFn}(),` +
    `session_id:${sessionFn}()` +
  `})+"\\n")`

let patched = original
  .replace(messageStartOld, messageStartNew)
  .replace(messageStopOld, messageStopNew)

// Verify the replacement actually changed something
if (patched === original) {
  console.error('ERROR: Replacement produced no changes.')
  process.exit(1)
}

src = src.replace(original, patched)

// ---------------------------------------------------------------------------
// Step 6: Write and verify
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

console.log('\nVerified.')
console.log('')
console.log('What this does:')
console.log('  Emits per-request token usage (including cache breakdowns) to SDK stdout')
console.log('  Message format: { type: "request_usage", usage: {...}, model, uuid, session_id }')

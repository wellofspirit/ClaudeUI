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
const cliPath = resolve(projectRoot, 'vendor/claude-cli/cli.js')

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
  console.error('Did you run: node scripts/extract-cli.mjs ?')
  process.exit(1)
}

console.log(`Read ${cliPath} (${(src.length / 1024 / 1024).toFixed(1)} MB)`)

const PATCH_MARKER = '/*PATCHED:request-usage*/'

if (src.includes(PATCH_MARKER)) {
  console.log('Patch already applied. Skipping.')
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Step 2: Locate the streaming usage accumulator (message_start case)
// ---------------------------------------------------------------------------
// As of 2.1.163 the per-event handling is a `switch(<p>.type){case ...}` inside
// the streaming generator. The old flat `if(...==="message_start")...` chain and
// the `this.totalUsage=<accum>(this.totalUsage,<H>)` accumulation on message_stop
// are gone (the per-request total is now reconciled in the generator's finally
// block, not on message_stop). We anchor on the message_start case to capture:
//   * <sH> — the message object (`<sH>=<p>.message`); <sH>.model is the model
//   * <QH> — the per-request usage accumulator (`<QH>=<merge>(<QH>,<p>.message?.usage)`)
// Both are `let`-declared at the generator top and reset per request, so at
// message_stop they hold the just-completed request's values.
//
// Verbatim 2.1.163 shape:
//   case"message_start":{sH=p_.message,xH=Math.max(0,Math.round(performance.now()-TH)),QH=O7H(QH,p_.message?.usage),v_=...

console.log('\n--- Locating streaming message_start case ---')

// As of 2.1.197 the case gained a boolean flag assignment before the message:
//   case"message_start":{ma=!0,An=In.message,xn=Math.max(...),gn=Fse(gn,In.message?.usage),...
// 2.1.231 wrapped that same comma sequence in an `if(...)` whose final operand
// is a model check:
//   case"message_start":{if(Bn=!0,lt=Hr.message,...,Hr.message?.model)Vlo(...);...
// The assignments still run unconditionally (comma operator), and this match is
// only used to HARVEST variable names — the injection happens at message_stop,
// where those bindings are equally in scope — so tolerating the wrapper is safe.
// Group layout: g1=flagVar, g2=msgVar, g3=eventVar, g4=ttftVar, g5=timerVar, g6=usageVar, g7=mergeFn
const startRe = new RegExp(
  `case"message_start":\\{(?:if\\()?(${V})=!0,(${V})=(${V})\\.message,` +
    `(${V})=Math\\.max\\(0,Math\\.round\\(performance\\.now\\(\\)-(${V})\\)\\),` +
    `(${V})=(${V})\\(${V},${V}\\.message\\?\\.usage\\)`
)
const startMatch = startRe.exec(src)
if (!startMatch) {
  console.error(
    'ERROR: Cannot locate streaming message_start case (flagVar=!0, msgVar=<p>.message, usageVar=<merge>(usageVar,...)).'
  )
  process.exit(1)
}

const allStart = [...src.matchAll(new RegExp(startRe, 'g'))]
if (allStart.length > 1) {
  console.error(
    `ERROR: message_start case matched ${allStart.length} times (expected 1). Aborting.`
  )
  process.exit(1)
}

const msgVar = startMatch[2] // An — the message object (carries .model); g2 (was g1 pre-2.1.197)
const eventVar = startMatch[3] // In — the stream event; g3 (was g2 pre-2.1.197)
const usageVar = startMatch[6] // gn — per-request usage accumulator; g6 (was g5 pre-2.1.197)
const mergeFn = startMatch[7] // Fse — usage merge function; g7 (was g6 pre-2.1.197)

console.log(`Found message_start case at char ${startMatch.index}`)
console.log(`  Message var: ${msgVar}`)
console.log(`  Event var: ${eventVar}`)
console.log(`  Usage accumulator: ${usageVar}`)
console.log(`  Merge fn: ${mergeFn}`)

// ---------------------------------------------------------------------------
// Step 3: Inject request_usage emission at the message_stop case
// ---------------------------------------------------------------------------
// 2.1.163: the case was reduced to `case"message_stop":break}`. 2.1.170 added a
// telemetry call: `case"message_stop":eH("stream_completed",jH??null,r_);break}`.
// We match a bare case body (zero or more brace-free statements ending in `;`)
// followed by `break}` (the trailing `}` closes the switch), preserve whatever
// statements are there, and append our stdout write just before the break —
// statements are legal in a bare case body, no extra braces needed. The `[^{}]`
// restriction keeps us out of the block-bodied message_stop cases in the
// Anthropic SDK MessageStream classes. The consumer (claude-session.ts
// logRequestUsage) reads only `usage` and `model`; session_id is supplied from
// its own session state, so we omit it. No `this` is available here (standalone
// generator), so we read the model off the captured message var instead of the
// old `this._patchModel`.

console.log('\n--- Injecting request_usage emission at message_stop ---')

const stopRe = /case"message_stop":((?:[^{}]*;)?)break\}/g
const allStop = [...src.matchAll(stopRe)]
if (allStop.length !== 1) {
  console.error(`ERROR: message_stop case matched ${allStop.length} times (expected 1). Aborting.`)
  process.exit(1)
}

const stopMatch = allStop[0]
const existingStmts = stopMatch[1] // e.g. `eH("stream_completed",jH??null,r_);` in 2.1.170; empty in 2.1.163
console.log(
  `Found message_stop case at char ${stopMatch.index}` +
    (existingStmts ? ` (preserving existing statements: ${existingStmts})` : '')
)

const messageStopNew =
  `case"message_stop":` +
  existingStmts +
  PATCH_MARKER +
  `process.stdout.write(JSON.stringify({` +
  `type:"request_usage",` +
  `usage:${usageVar},` +
  `model:${msgVar}?.model||""` +
  `})+"\\n");break}`

src = src.replace(stopMatch[0], messageStopNew)

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
console.log('  Message format: { type: "request_usage", usage: {...}, model }')

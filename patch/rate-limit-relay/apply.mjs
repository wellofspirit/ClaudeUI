/**
 * Patch: rate-limit-relay
 *
 * Forwards rate_limit_event messages to the SDK consumer via stdout,
 * enriched with per-window utilization data from parsed response headers.
 *
 * The CLI already emits rate_limit_event internally (into its TUI message
 * queue), but the SDK message adapter (`r26` / `sdkMessageAdapter`) explicitly
 * drops them with `{type:"ignored"}`. They never reach stdout — so SDK
 * consumers like ClaudeUI never see them.
 *
 * Additionally, the `QL1` broadcast only includes `utilization` when the
 * status is `allowed_warning` (approaching limit). For normal `allowed`
 * status, utilization is missing from the event. But `SD4` parses per-window
 * utilization from headers and stores it in `pf8` (accessed via `hD4()`).
 *
 * This patch:
 * 1. Adds `process.stdout.write(JSON + "\n")` alongside the existing
 *    `f.enqueue(...)` call so the event reaches the SDK transport
 * 2. Enriches the stdout message with `header_utilization` from `hD4()` —
 *    the parsed per-window utilization data (five_hour, seven_day)
 *
 * Usage: node patch/rate-limit-relay/apply.mjs
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

const PATCH_MARKER = '/*PATCHED:rate-limit-relay*/'

if (src.includes(PATCH_MARKER)) {
  console.log('Patch already applied. Skipping.')
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Step 2: Find the hD4 function (returns pf8 — parsed header utilization)
// ---------------------------------------------------------------------------
// hD4 is a tiny getter: function <name>(){return <pf8>}
// It's called in the status line builder with pattern: <var>=hD4(),<var>={...<var>.five_hour
// We find it by searching for that usage pattern.
// ---------------------------------------------------------------------------

console.log('\n--- Locating header utilization getter (hD4) ---')

// Pattern: <P>=<hD4>(),<W>={...<P>.five_hour
const hd4Re = new RegExp(`(${V})=(${V})\\(\\),(${V})=\\{\\.\\.\\.(\\1)\\.five_hour`)
const hd4Match = hd4Re.exec(src)
if (!hd4Match) {
  console.error('ERROR: Cannot locate hD4 (header utilization getter) via status line pattern.')
  process.exit(1)
}

const hd4Fn = hd4Match[2]
console.log(`  Header utilization getter: ${hd4Fn}`)

// Verify it's a simple getter: function <name>(){return <var>}
const hd4DefRe = new RegExp(`function ${hd4Fn.replace(/\$/g, '\\$')}\\(\\)\\{return (${V})\\}`)
const hd4DefMatch = hd4DefRe.exec(src)
if (!hd4DefMatch) {
  console.error(`ERROR: ${hd4Fn} doesn't match expected getter pattern.`)
  process.exit(1)
}
console.log(`  Confirmed getter pattern: function ${hd4Fn}(){return ${hd4DefMatch[1]}}`)

// ---------------------------------------------------------------------------
// Step 3: Find the rate_limit_event enqueue pattern
// ---------------------------------------------------------------------------

console.log('\n--- Locating rate_limit_event enqueue ---')

const enqueueRe = new RegExp(
  `if\\((${V})\\)(${V})\\.enqueue\\(\\{type:"rate_limit_event",rate_limit_info:\\1,uuid:(${V})\\(\\),session_id:(${V})\\(\\)\\}\\)`
)

const match = enqueueRe.exec(src)
if (!match) {
  console.error('ERROR: Cannot locate rate_limit_event enqueue pattern.')
  process.exit(1)
}

// Verify uniqueness
const allMatches = [...src.matchAll(new RegExp(enqueueRe, 'g'))]
if (allMatches.length > 1) {
  console.error(`ERROR: Pattern matched ${allMatches.length} times (expected 1). Aborting.`)
  process.exit(1)
}

const infoVar = match[1]    // the rate_limit_info object (W6)
const queueVar = match[2]   // the message queue (f)
const uuidFn = match[3]     // uuid generator (pX)
const sessionFn = match[4]  // session_id getter (E8)

console.log(`Found at char ${match.index}`)
console.log(`  rate_limit_info var: ${infoVar}`)
console.log(`  message queue var:   ${queueVar}`)
console.log(`  uuid function:       ${uuidFn}`)
console.log(`  session_id function: ${sessionFn}`)

// ---------------------------------------------------------------------------
// Step 4: Inject stdout write after the enqueue
// ---------------------------------------------------------------------------
// The stdout message includes:
// - rate_limit_info: the standard SDKRateLimitInfo (status, rateLimitType, etc.)
// - header_utilization: from hD4() — { five_hour: { utilization, resets_at }, seven_day: { ... } }
//   This contains the actual utilization percentages that are MISSING from
//   the standard event when status is just "allowed".
// ---------------------------------------------------------------------------

console.log('\n--- Injecting stdout write ---')

const original = match[0]
const replacement =
  original +
  PATCH_MARKER +
  `,process.stdout.write(JSON.stringify({` +
    `type:"rate_limit_event",` +
    `rate_limit_info:${infoVar},` +
    `header_utilization:${hd4Fn}(),` +
    `uuid:${uuidFn}(),` +
    `session_id:${sessionFn}()` +
  `})+"\\n")`

src = src.replace(original, replacement)

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

console.log('\nVerified.')
console.log('')
console.log('What this does:')
console.log('  Forwards rate_limit_event messages to SDK stdout transport')
console.log('  Enriches with header_utilization from parsed response headers')

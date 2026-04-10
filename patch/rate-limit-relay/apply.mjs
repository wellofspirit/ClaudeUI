/**
 * Patch: rate-limit-relay
 *
 * Forwards per-window rate limit utilization data to the SDK consumer via
 * stdout after every inference API call.
 *
 * The CLI parses `anthropic-ratelimit-unified-*` headers from each API
 * response into a per-window utilization store (`kh8`, accessed via `LR4()`).
 * However, this data is only used internally for the TUI status line — it
 * never reaches SDK consumers.
 *
 * The CLI does broadcast rate_limit_event messages via `d46` (a listener Set),
 * but only when the rate limit **status** changes (allowed → warning →
 * rejected). For normal usage that stays "allowed", the broadcast fires at
 * most once (on the first request). This means piggybacking on `d46` doesn't
 * give us per-turn updates.
 *
 * This patch injects a `process.stdout.write(...)` call right after
 * `pF1(U1.headers)` in the stream loop (`XiK`), which runs after every
 * successful streaming API call. The message includes:
 *   - `header_utilization`: from `LR4()` — the parsed per-window utilization
 *     data (five_hour, seven_day) with fractional utilization and reset epoch
 *
 * All minified function/variable names are extracted dynamically from content
 * patterns so the patch survives SDK version bumps.
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
// Step 2: Find the LR4 function (returns kh8 — parsed header utilization)
// ---------------------------------------------------------------------------
// LR4 is a tiny getter: function <name>(){return <kh8>}
// We find it by its nearby context: it's defined right before hR4 which
// parses "anthropic-ratelimit-unified-" headers.
// ---------------------------------------------------------------------------

console.log('\n--- Locating header utilization getter (LR4) ---')

// Pattern: function <LR4>(){return <kh8>}function <hR4>
const lr4Re = new RegExp(`function (${V})\\(\\)\\{return (${V})\\}function (${V})\\(${V}\\)\\{let ${V}=\\{\\};for\\(let\\[${V},${V}\\]of\\[\\["five_hour","5h"\\],\\["seven_day","7d"\\]\\]\\)`)
const lr4Match = lr4Re.exec(src)
if (!lr4Match) {
  console.error('ERROR: Cannot locate LR4 (header utilization getter) via hR4 context.')
  process.exit(1)
}

const lr4Fn = lr4Match[1]
const kh8Var = lr4Match[2]
console.log(`  Header utilization getter: ${lr4Fn} (returns ${kh8Var})`)

// ---------------------------------------------------------------------------
// Step 3: Find the pF1(U1.headers) call site in the stream loop
// ---------------------------------------------------------------------------
// After successful streaming, the code does:
//   let U1 = l; if (U1) pF1(U1.headers), k8 = U1.headers
// We need to find this pattern dynamically — pF1, U1, l, k8 are all minified.
// Stable anchor: the pattern `pF1(<var>.headers),<var>=<var>.headers` right
// after an `if(<var>)` guard. The pF1 function name we can find from its
// unique definition that calls hR4 and SR4.
// ---------------------------------------------------------------------------

console.log('\n--- Locating pF1 call in stream loop ---')

// Find pF1 function name dynamically: it's the function that calls hR4 and
// contains "anthropic-ratelimit-unified-status" via SR4.
// Pattern: function <pF1>(<q>){let <K>=<I7>();if(!<mN6>(<K>))
const pf1DefRe = new RegExp(`function (${V})\\(${V}\\)\\{let ${V}=(${V})\\(\\);if\\(!${V}\\(${V}\\)\\)\\{if\\(${kh8Var.replace(/\$/g, '\\$')}=\\{\\}`)
const pf1DefMatch = pf1DefRe.exec(src)
if (!pf1DefMatch) {
  console.error('ERROR: Cannot locate pF1 function definition.')
  process.exit(1)
}
const pf1Fn = pf1DefMatch[1]
console.log(`  pF1 function name: ${pf1Fn}`)

// Now find the call site: if(<var>)<pF1>(<var>.headers),<var>=<var>.headers
const callSiteRe = new RegExp(
  `if\\((${V})\\)${pf1Fn.replace(/\$/g, '\\$')}\\(\\1\\.headers\\),(${V})=\\1\\.headers`
)
const callSiteMatch = callSiteRe.exec(src)
if (!callSiteMatch) {
  console.error('ERROR: Cannot locate pF1 call site in stream loop.')
  process.exit(1)
}

// Verify uniqueness
const allCallSiteMatches = [...src.matchAll(new RegExp(callSiteRe, 'g'))]
if (allCallSiteMatches.length > 1) {
  console.error(`ERROR: pF1 call site matched ${allCallSiteMatches.length} times (expected 1). Aborting.`)
  process.exit(1)
}

console.log(`  Found call site at char ${callSiteMatch.index}`)
console.log(`  Response var: ${callSiteMatch[1]}, headers var: ${callSiteMatch[2]}`)

// ---------------------------------------------------------------------------
// Step 4: Inject stdout write after pF1(U1.headers),k8=U1.headers
// ---------------------------------------------------------------------------
// We append our stdout write after the existing comma-separated statements.
// The injected code:
//   ,process.stdout.write(JSON.stringify({
//     type: "rate_limit_event",
//     header_utilization: LR4()
//   }) + "\n")
// ---------------------------------------------------------------------------

console.log('\n--- Injecting stdout write after pF1 call ---')

const original = callSiteMatch[0]
const replacement =
  original +
  PATCH_MARKER +
  `,process.stdout.write(JSON.stringify({` +
    `type:"rate_limit_event",` +
    `header_utilization:${lr4Fn}()` +
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
console.log('  Writes rate_limit_event with header_utilization to stdout after every API call')
console.log('  header_utilization contains per-window utilization from parsed response headers')

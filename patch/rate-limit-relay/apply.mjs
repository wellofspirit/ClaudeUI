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

const PATCH_MARKER = '/*PATCHED:rate-limit-relay*/'

if (src.includes(PATCH_MARKER)) {
  console.log('Patch already applied. Skipping.')
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Step 2+3: Find the utilization getter (LR4) and the header-ingest fn (pF1)
// ---------------------------------------------------------------------------
// We need two names:
//   lr4Fn — a nullary getter returning the parsed header utilization; the
//           injected stdout write calls it as `lr4Fn()`.
//   pf1Fn — the function the stream loop calls with the response headers; its
//           call site is where we inject.
//
// v2.1.231 restructured this whole area from module-level state into a class:
//
//   ≤2.1.220  module var:  function LR4(){return kh8}function hR4(hdrs){...}
//             ingest fn:   function pF1(e,t,r=!1,n=Date.now()){...if(kh8={}...
//
//   ≥2.1.231  class field: class Wap{ rawUtilization={}; extractQuotaStatusFromHeaders(...){...} }
//             singleton:   var bne=new Wap
//             getter:      function lCn(){return bne.rawUtilization}
//             ingest fn:   function usa(e,t,r=!1,n=Date.now(),o){bne.extractQuotaStatusFromHeaders(e,t,r,n,o)}
//
// The class-shape anchors are STRONGER than the ones they replace: the property
// names (`rawUtilization`, `extractQuotaStatusFromHeaders`) survive minification,
// so we bind to those and let the minified function/singleton names fall out.
// Both shapes are tried so a rolled-back `claudeCliVersion` still builds.
// ---------------------------------------------------------------------------

console.log('\n--- Locating header utilization getter + header-ingest fn ---')

let lr4Fn
let pf1Fn

// --- Shape A (v2.1.231+): class-backed singleton ---
const getterRe = new RegExp(`function (${V})\\(\\)\\{return (${V})\\.rawUtilization\\}`)
const getterMatch = getterRe.exec(src)

if (getterMatch) {
  lr4Fn = getterMatch[1]
  const singleton = getterMatch[2]
  if (getterRe.exec(src.slice(getterMatch.index + 1))) {
    console.error('ERROR: rawUtilization getter matched more than once. Aborting.')
    process.exit(1)
  }
  console.log(`  Header utilization getter: ${lr4Fn} (returns ${singleton}.rawUtilization)`)

  // The module-level wrapper delegating to the singleton's ingest method. Bound
  // to the SAME singleton the getter reads, so the two can't drift apart.
  const wrapperRe = new RegExp(
    `function (${V})\\(${V},${V},${V}=!1,${V}=Date\\.now\\(\\),${V}\\)\\{` +
      `${singleton.replace(/[$]/g, '\\$&')}\\.extractQuotaStatusFromHeaders\\(`
  )
  const wrapperMatch = wrapperRe.exec(src)
  if (!wrapperMatch) {
    console.error(
      `ERROR: Found the rawUtilization getter but no module-level wrapper calling ` +
        `${singleton}.extractQuotaStatusFromHeaders(). Cannot locate the ingest fn.`
    )
    process.exit(1)
  }
  pf1Fn = wrapperMatch[1]
  console.log(`  Header-ingest fn: ${pf1Fn} (→ ${singleton}.extractQuotaStatusFromHeaders)`)
} else {
  // --- Shape B (≤2.1.220): module-level var + getter ---
  //
  // Pattern: function <LR4>(){return <kh8>}function <hR4>
  // v2.1.119+ appended ["overage","overage"] (and may add further bucket pairs)
  // to the for-loop array. Allow any number of trailing ["str","str"] entries.
  const lr4Re = new RegExp(
    `function (${V})\\(\\)\\{return (${V})\\}function (${V})\\(${V}\\)\\{let ${V}=\\{\\};for\\(let\\[${V},${V}\\]of\\[\\["five_hour","5h"\\],\\["seven_day","7d"\\](?:,\\["[\\w_]+","[\\w_]+"\\])*\\]\\)`
  )
  const lr4Match = lr4Re.exec(src)
  if (!lr4Match) {
    console.error(
      'ERROR: Cannot locate the header utilization getter in either shape ' +
        '(v2.1.231+ `function F(){return S.rawUtilization}`, or ' +
        '≤2.1.220 `function F(){return V}function P(h){...["five_hour","5h"]...}`).'
    )
    process.exit(1)
  }

  lr4Fn = lr4Match[1]
  const kh8Var = lr4Match[2]
  console.log(`  Header utilization getter: ${lr4Fn} (returns ${kh8Var})`)

  // v2.1.97 signature:  function <pF1>(<q>){let <K>=<I7>();if(!<mN6>(<K>)){if(<kh8>={} ...
  // v2.1.197 signature: function <pF1>(<e>,<t>,<n>=!1,<r>=Date.now()){let <o>=<Eo>();if(!<ndt>(<o>)){if(<kh8>={} ...
  // The function grew from 1 param to 4 (with two defaulted), and the guard var
  // is now called inline instead of assigned first. We match by the 4-param+defaults
  // signature, then anchor on the kh8 reset inside the falsy-scope guard.
  const escapedKh8 = kh8Var.replace(/\$/g, '\\$')
  const pf1DefRe = new RegExp(
    `function (${V})\\(${V},${V},${V}=!1,${V}=Date\\.now\\(\\)\\)\\{let ${V}=${V}\\(\\);if\\(!${V}\\(${V}\\)\\)\\{if\\(${escapedKh8}=\\{\\}`
  )
  const pf1DefMatch = pf1DefRe.exec(src)
  if (!pf1DefMatch) {
    console.error('ERROR: Cannot locate pF1 function definition.')
    process.exit(1)
  }
  pf1Fn = pf1DefMatch[1]
  console.log(`  Header-ingest fn: ${pf1Fn}`)
}

// ---------------------------------------------------------------------------
// Step 4: Find the pF1(<resp>.headers, ...) call site in the stream loop
// ---------------------------------------------------------------------------
// After successful streaming, the code does:
//   let U1 = l; if (U1) pF1(U1.headers), k8 = U1.headers
// U1/k8 are minified, so anchor on the call + its trailing headers assignment.
// ---------------------------------------------------------------------------

console.log('\n--- Locating pF1 call in stream loop ---')

// Now find the call site: if(<var>)<pF1>(<var>.headers,<args...>),<var>=<var>.headers
//
// v2.1.97:  if(<U1>)<pF1>(<U1>.headers),<k8>=<U1>.headers
// v2.1.197: if(<Hn>)<pF1>(<Hn>.headers,<model>,<bool_expr>,<we>),<Je>=<Hn>.headers
// The arg list now includes nested parens (e.g. (fg(model)||Sx(model))&&...).
// We handle up to 2 levels of paren nesting with:
//   (?:[^)(]|\((?:[^)(]|\([^)(]*\))*\))*
const argPat = `(?:[^)(]|\\((?:[^)(]|\\([^)(]*\\))*\\))*`
// v2.1.219 prepended another call (e.g. `EDu(<resp>.headers,...)`) before the
// pF1 call inside the `if(<resp>)` guard, so `if(<resp>)` is no longer
// immediately followed by pF1. Anchor directly on the pF1 call plus its
// `,<hdrVar>=<resp>.headers` capture assignment — that shape is unique to the
// stream loop (the interceptor/refresh call sites pass headers directly as
// `pF1(<hdrs>,...)` and lack the trailing assignment).
const callSiteRe = new RegExp(
  `${pf1Fn.replace(/\$/g, '\\$')}\\((${V})\\.headers,${argPat}\\),(${V})=\\1\\.headers`
)
const callSiteMatch = callSiteRe.exec(src)
if (!callSiteMatch) {
  console.error('ERROR: Cannot locate pF1 call site in stream loop.')
  process.exit(1)
}

// Verify uniqueness
const allCallSiteMatches = [...src.matchAll(new RegExp(callSiteRe, 'g'))]
if (allCallSiteMatches.length > 1) {
  console.error(
    `ERROR: pF1 call site matched ${allCallSiteMatches.length} times (expected 1). Aborting.`
  )
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

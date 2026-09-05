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
// Minified identifiers can only contain one regex-special char: `$`.
const idEsc = (s) => s.replace(/\$/g, '\\$')
// Full escape, for chunk paths etc. (goes into `new RegExp`, so `/` is literal).
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')

// A balanced-ish argument list, tolerating up to 2 levels of nested parens.
// Newlines are excluded on purpose: in the 2.1.261 concat each chunk's code is a
// single line, and every chunk is introduced by its own `\n// @bun-chunk …\n`
// delimiter. Barring `\n` therefore makes it structurally impossible for these
// spans to bridge a chunk boundary (see the chunk index below).
const argPat = `(?:[^)(\\n]|\\((?:[^)(\\n]|\\([^)(\\n]*\\))*\\))*`
// A parameter list, tolerating one level of nesting (for `x=Date.now()` defaults).
const paramPat = `(?:[^)(\\n]|\\([^)(\\n]*\\))*`

// ---------------------------------------------------------------------------
// Chunk index (2.1.261+)
// ---------------------------------------------------------------------------
// 2.1.261 replaced the single monolithic bundle with 1,631 minified ESM chunks;
// vendor/claude-cli/cli.js is their concatenation, each chunk preceded by
//   // @bun-chunk B:/~BUN/root/chunk-xxxxxxxx.js
// Every chunk is its own module scope, so a helper we want to CALL from the
// injection site must either be defined in that same chunk or imported into it
// (possibly under a different local name). Pre-2.1.261 bundles have no
// delimiters at all — the index comes back empty and everything degrades to the
// old "one global namespace" behaviour.
// ---------------------------------------------------------------------------

function buildChunkIndex(text) {
  const re = /^\/\/ @bun-chunk (.+)$/gm
  const out = []
  let m
  while ((m = re.exec(text)) !== null) out.push({ name: m[1].trim(), start: m.index })
  for (let i = 0; i < out.length; i++) {
    out[i].end = i + 1 < out.length ? out[i + 1].start : text.length
  }
  return out
}

function chunkAt(chunks, offset) {
  let lo = 0
  let hi = chunks.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (offset < chunks[mid].start) hi = mid - 1
    else if (offset >= chunks[mid].end) lo = mid + 1
    else return chunks[mid]
  }
  return null
}

/**
 * Name under which `exportedName` (declared at `defOffset`) is reachable from
 * `useOffset`. Same chunk (or an unchunked bundle) → the name itself. Different
 * chunk → the local alias from that chunk's `import{...}from"<defining chunk>"`.
 * Returns null when the binding is not importable there — the caller must abort
 * rather than emit a call to an unbound identifier.
 */
function localBindingFor(text, chunks, defOffset, useOffset, exportedName) {
  if (chunks.length === 0) return exportedName // pre-2.1.261 monolith
  const defChunk = chunkAt(chunks, defOffset)
  const useChunk = chunkAt(chunks, useOffset)
  if (!defChunk || !useChunk) return null
  if (defChunk === useChunk) return exportedName
  const body = text.slice(useChunk.start, useChunk.end)
  const importRe = new RegExp(`import\\{([^}]*)\\}from"${reEsc(defChunk.name)}"`, 'g')
  for (const m of body.matchAll(importRe)) {
    for (const spec of m[1].split(',')) {
      const parts = spec.trim().split(/\s+as\s+/)
      if (parts[0] === exportedName) return parts[1] ?? parts[0]
    }
  }
  return null
}

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
// v2.1.231 restructured this whole area from module-level state into a class,
// and v2.1.261 wrapped the getter in a validity filter:
//
//   ≤2.1.220  module var:  function LR4(){return kh8}function hR4(hdrs){...}
//             ingest fn:   function pF1(e,t,r=!1,n=Date.now()){...if(kh8={}...
//
//   2.1.231   class field: class Wap{ rawUtilization={}; extractQuotaStatusFromHeaders(...){...} }
//             singleton:   var bne=new Wap
//             getter:      function lCn(){return bne.rawUtilization}
//             ingest fn:   function usa(e,t,r=!1,n=Date.now(),o){bne.extractQuotaStatusFromHeaders(e,t,r,n,o)}
//
//   2.1.261   same class shape, but the getter now filters out windows whose
//             resets_at is in the past / absurdly far out:
//             getter:      function SL(){return eEn(QS.rawUtilization)}
//             ingest fn:   function Iot(e,t,r=!1,o=Date.now(),d,f){QS.extractQuotaStatusFromHeaders(e,t,r,o,d,f)}
//             (the wrapper gained a 6th param; we no longer pin the param count)
//
// The class-shape anchors are STRONGER than the ones they replace: the property
// names (`rawUtilization`, `extractQuotaStatusFromHeaders`) survive minification,
// so we bind to those and let the minified function/singleton names fall out.
// All shapes are tried so a rolled-back `claudeCliVersion` still builds.
// ---------------------------------------------------------------------------

console.log('\n--- Locating header utilization getter + header-ingest fn ---')

let lr4Fn
let pf1Fn
let lr4Offset = -1

// --- Shape A (v2.1.231+): class-backed singleton ---
// A1 (2.1.231–2.1.2xx): function G(){return S.rawUtilization}
// A2 (2.1.261+):        function G(){return F(S.rawUtilization)}   ← validity filter
const getterReA1 = new RegExp(`function (${V})\\(\\)\\{return (${V})\\.rawUtilization\\}`)
const getterReA2 = new RegExp(`function (${V})\\(\\)\\{return ${V}\\((${V})\\.rawUtilization\\)\\}`)
// Both capture: [1] = getter fn name, [2] = singleton var name.
const getterRe = getterReA1.exec(src) ? getterReA1 : getterReA2
const getterMatch = getterRe.exec(src)

if (getterMatch) {
  lr4Fn = getterMatch[1]
  lr4Offset = getterMatch.index
  const singleton = getterMatch[2]
  if (getterRe.exec(src.slice(getterMatch.index + 1))) {
    console.error('ERROR: rawUtilization getter matched more than once. Aborting.')
    process.exit(1)
  }
  console.log(
    `  Header utilization getter: ${lr4Fn} (reads ${singleton}.rawUtilization) at char ${lr4Offset}`
  )

  // The module-level wrapper delegating to the singleton's ingest method. Bound
  // to the SAME singleton the getter reads, so the two can't drift apart.
  // The param list is matched generically — it grew 1→4→5→6 params across
  // 2.1.97 / 2.1.197 / 2.1.231 / 2.1.261 and will keep growing.
  const wrapperRe = new RegExp(
    `function (${V})\\(${paramPat}\\)\\{${idEsc(singleton)}\\.extractQuotaStatusFromHeaders\\(`
  )
  const wrapperMatch = wrapperRe.exec(src)
  if (!wrapperMatch) {
    console.error(
      `ERROR: Found the rawUtilization getter but no module-level wrapper calling ` +
        `${singleton}.extractQuotaStatusFromHeaders(). Cannot locate the ingest fn.`
    )
    process.exit(1)
  }
  if (new RegExp(wrapperRe.source, 'g').exec(src.slice(wrapperMatch.index + 1))) {
    console.error(
      `ERROR: ${singleton}.extractQuotaStatusFromHeaders wrapper matched more than once. Aborting.`
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
      'ERROR: Cannot locate the header utilization getter in any known shape ' +
        '(v2.1.261+ `function F(){return W(S.rawUtilization)}`, ' +
        'v2.1.231 `function F(){return S.rawUtilization}`, or ' +
        '≤2.1.220 `function F(){return V}function P(h){...["five_hour","5h"]...}`).'
    )
    process.exit(1)
  }

  lr4Fn = lr4Match[1]
  lr4Offset = lr4Match.index
  const kh8Var = lr4Match[2]
  console.log(`  Header utilization getter: ${lr4Fn} (returns ${kh8Var}) at char ${lr4Offset}`)

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

// Now find the call site: if(<resp>)...<pF1>(<resp>.headers,<args...>),...,<hdr>=<resp>.headers
//
// v2.1.97:  if(<U1>)<pF1>(<U1>.headers),<k8>=<U1>.headers
// v2.1.197: if(<Hn>)<pF1>(<Hn>.headers,<model>,<bool_expr>,<we>),<Je>=<Hn>.headers
// v2.1.261: if(<Sp>)<a>(<x>,<y>),<b>(<Sp>.headers,...),<pF1>(<Sp>.headers,...),
//                    <c>(<Sp>.headers,...),<Lb>=<Sp>.headers
// The arg list includes nested parens (e.g. (tc(model)||gg(model))&&...); we
// handle up to 2 levels of paren nesting with `argPat`.
//
// v2.1.219 prepended another call before the pF1 call inside the `if(<resp>)`
// guard; v2.1.261 also APPENDED one between the pF1 call and the trailing
// headers assignment. So neither neighbour is contiguous with pF1 any more.
// We anchor on the pF1 call, allow a bounded run of further sibling calls, and
// end on the `,<hdrVar>=<resp>.headers` assignment that closes the comma chain.
// That combination is still unique to the stream loop (the non-streaming
// interceptor call site passes a headers object directly as `pF1(<hdrs>,...)`
// and has no trailing assignment). Injecting after the assignment keeps the
// write as the LAST element of the same comma expression, still under `if(<resp>)`.
const callSiteRe = new RegExp(
  `${idEsc(pf1Fn)}\\((${V})\\.headers,${argPat}\\)(?:,${V}\\(${argPat}\\)){0,8},(${V})=\\1\\.headers`
)
const callSiteMatch = callSiteRe.exec(src)
if (!callSiteMatch) {
  console.error('ERROR: Cannot locate pF1 call site in stream loop.')
  process.exit(1)
}

// Verify uniqueness
const allCallSiteMatches = [...src.matchAll(new RegExp(callSiteRe.source, 'g'))]
if (allCallSiteMatches.length > 1) {
  console.error(
    `ERROR: pF1 call site matched ${allCallSiteMatches.length} times (expected 1). Aborting.`
  )
  process.exit(1)
}

console.log(`  Found call site at char ${callSiteMatch.index}`)
console.log(`  Response var: ${callSiteMatch[1]}, headers var: ${callSiteMatch[2]}`)

// ---------------------------------------------------------------------------
// Step 5: Resolve the getter's binding name AT THE INJECTION SITE
// ---------------------------------------------------------------------------
// 2.1.261+ is a concat of independent ESM chunks. The injected call must name a
// binding that exists in the injection site's chunk scope — that is the getter's
// own name only when both live in the same chunk (true in 2.1.261: both are in
// chunk-9c0rs7w4.js), otherwise the local alias of its import.
// ---------------------------------------------------------------------------

const chunks = buildChunkIndex(src)
const injectChunk = chunks.length ? chunkAt(chunks, callSiteMatch.index) : null
const getterChunk = chunks.length ? chunkAt(chunks, lr4Offset) : null
console.log(
  `  Bundle shape: ${chunks.length ? `${chunks.length} chunks` : 'monolithic (pre-2.1.261)'}`
)
if (chunks.length) {
  console.log(`  Getter chunk:    ${getterChunk?.name ?? '<none>'}`)
  console.log(`  Injection chunk: ${injectChunk?.name ?? '<none>'}`)
}

const lr4Local = localBindingFor(src, chunks, lr4Offset, callSiteMatch.index, lr4Fn)
if (!lr4Local) {
  console.error(
    `ERROR: the header utilization getter \`${lr4Fn}\` (${getterChunk?.name}) is not in scope at ` +
      `the injection site (${injectChunk?.name}) and is not imported there. Injecting a call to it ` +
      `would produce a ReferenceError at runtime. Re-anchor the injection into the getter's chunk, ` +
      `or teach this script to add an import.`
  )
  process.exit(1)
}
if (lr4Local !== lr4Fn) console.log(`  Getter is imported at the injection site as: ${lr4Local}`)

// ---------------------------------------------------------------------------
// Step 6: Inject stdout write after <hdr>=<resp>.headers
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
  `header_utilization:${lr4Local}()` +
  `})+"\\n")`

// Replace by offset, not by String#replace: `original` contains no `$`-escapes
// hazard today, but offset splicing is exact and cannot hit a different site.
src =
  src.slice(0, callSiteMatch.index) +
  replacement +
  src.slice(callSiteMatch.index + original.length)

// ---------------------------------------------------------------------------
// Step 7: Write and verify
// ---------------------------------------------------------------------------

writeFileSync(cliPath, src)
console.log(`\nPatch applied to ${cliPath}`)

const verify = readFileSync(cliPath, 'utf-8')
const markerIdx = verify.indexOf(PATCH_MARKER)
const ok = markerIdx !== -1
console.log(`  ${ok ? 'OK' : 'MISSING'} Patch marker`)

if (!ok) {
  console.error('\nVerification FAILED.')
  process.exit(1)
}

// The injected write must land inside the same chunk we anchored on — a stray
// chunk delimiter between anchor and injection would mean the regex bridged a
// chunk boundary (see buildChunkIndex).
const verifyChunks = buildChunkIndex(verify)
if (verifyChunks.length) {
  const c = chunkAt(verifyChunks, markerIdx)
  console.log(`  OK Injected into ${c?.name ?? '<unknown chunk>'}`)
  if (injectChunk && c && c.name !== injectChunk.name) {
    console.error(
      `\nVerification FAILED: injection landed in ${c.name}, expected ${injectChunk.name}.`
    )
    process.exit(1)
  }
}

console.log(`\nPatched region (char ${callSiteMatch.index}):`)
console.log(`  ${verify.slice(callSiteMatch.index, markerIdx + PATCH_MARKER.length + 120)}`)

console.log('\nVerified.')
console.log('')
console.log('What this does:')
console.log('  Writes rate_limit_event with header_utilization to stdout after every API call')
console.log('  header_utilization contains per-window utilization from parsed response headers')

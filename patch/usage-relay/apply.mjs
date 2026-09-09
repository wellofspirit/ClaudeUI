/**
 * Patch: usage-relay
 *
 * Exposes the CLI's internal `/usage` API call via the SDK control message API,
 * so the UI can fetch usage data through the running CLI process instead of
 * making independent HTTP requests (which get rate-limited with 429s).
 *
 *   Part A (cli.js): get_usage control request handler — calls the CLI's
 *                     internal usage fetcher (k9q-like) and returns the raw
 *                     API response via control_response.
 *
 *   Part B (sdk.mjs): getUsage() method on the query object.
 *
 * The CLI's usage fetcher:
 *   - Uses the active OAuth session (token already managed by the CLI)
 *   - Sends proper User-Agent header (claude-code/<version>)
 *   - Calls GET {BASE_API_URL}/api/oauth/usage with 5s timeout
 *   - Returns { five_hour, seven_day, seven_day_sonnet, extra_usage }
 *
 * All minified function names are extracted dynamically from content patterns
 * so the patch survives SDK version bumps.
 *
 * See README.md for full analysis.
 *
 * Usage: node patch/usage-relay/apply.mjs
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

const PATCH_MARKER = '/*PATCHED:usage-relay*/'

// ---------------------------------------------------------------------------
// Chunked-bundle scope helpers (2.1.261+)
//
// 2.1.261 is a code-split build: vendor/claude-cli/cli.js is the concatenation
// of ~1.6k minified ESM chunks, each preceded by a delimiter line
//   // @bun-chunk B:/~BUN/root/chunk-xxxxxxxx.js
// The usage fetcher lives in a different chunk from the control-request
// dispatch we inject into, and the dispatch chunk does NOT import it — so a
// bare `SD()` call would apply clean and throw ReferenceError on the first
// get_usage request. We reach it the way the bundle reaches cross-chunk code
// it did not statically import: `await import("<chunk>")`, a form this very
// chunk already uses (`await import("B:/~BUN/root/chunk-wdwcp2mj.js")` in the
// workflow_launch branch).
//
// On a pre-split monolith the index is empty and the plain call is emitted.
// ---------------------------------------------------------------------------

function buildChunkIndex(text) {
  const list = []
  const re = /^\/\/ @bun-chunk (.+)$/gm
  let m
  while ((m = re.exec(text))) list.push({ name: m[1].trim(), start: m.index })
  for (let i = 0; i < list.length; i++)
    list[i].end = i + 1 < list.length ? list[i + 1].start : text.length
  return list
}

function chunkAt(index, off) {
  if (index.length === 0) return null // monolithic bundle — one implicit scope
  let lo = 0
  let hi = index.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (index[mid].start <= off) lo = mid
    else hi = mid - 1
  }
  return index[lo]
}

function chunkName(index, off) {
  return chunkAt(index, off)?.name ?? '(monolithic bundle)'
}

/** Walk an `import{a,b as c}`/`export{a,b as c}` specifier list. */
function* specifiers(list) {
  for (const raw of list.split(',')) {
    const spec = raw.trim()
    if (!spec) continue
    const aliased = /^([\w$]+) as ([\w$]+)$/.exec(spec)
    if (aliased) yield { outer: aliased[2], inner: aliased[1] }
    else yield { outer: spec, inner: spec }
  }
}

/** The name a chunk publishes `localName` under, or null if it is private. */
function exportedNameOf(chunkText, localName) {
  for (const m of chunkText.matchAll(/export\{([^}]*)\}/g))
    for (const { outer, inner } of specifiers(m[1])) if (inner === localName) return outer
  return null
}

/**
 * A callee expression for `localName` (defined at defOff) usable at useOff:
 * either the bare name (same chunk, or already imported under that alias) or
 * `(await import("chunk-….js")).exported`. Returns null when the defining
 * chunk keeps the helper private — the caller must then abort rather than
 * inject a name that throws at runtime.
 */
function resolveCall(text, index, localName, defOff, useOff) {
  const defChunk = chunkAt(index, defOff)
  const useChunk = chunkAt(index, useOff)
  if (defChunk === null || useChunk === null || defChunk.name === useChunk.name)
    return { call: localName, viaImport: false }

  const exported = exportedNameOf(text.slice(defChunk.start, defChunk.end), localName)
  if (!exported) return null

  const useText = text.slice(useChunk.start, useChunk.end)
  for (const m of useText.matchAll(/import\{([^}]*)\}from"([^"]+)"/g)) {
    if (m[2] !== defChunk.name) continue
    for (const { outer, inner } of specifiers(m[1]))
      if (inner === exported) return { call: outer, viaImport: false }
  }
  return {
    call: `(await import(${JSON.stringify(defChunk.name)})).${exported}`,
    viaImport: true
  }
}

// =====================================================================
// Part A: get_usage control request handler
// =====================================================================

if (src.includes(PATCH_MARKER)) {
  console.log('Part A already applied. Skipping.')
} else {
  console.log('\n=== Part A: get_usage control request ===')

  // ---------------------------------------------------------------------------
  // Find the injection point — the "Unsupported control request subtype" fallback
  // ---------------------------------------------------------------------------
  console.log('\n--- Locating control-request fallback ---')

  // v2.1.219 wrapped the control-request dispatch chain in a try/finally, so the
  // fallback tail changed from `...subtype}`);continue}else if(msg.type==="control_response")`
  // to `...subtype}`)}finally{...}continue}else if(...)`. Match the fallback call
  // itself (tail-less) — still globally unique.
  //
  // 2.1.261 wrapped the interpolated subtype in a string sanitizer:
  //   else Be(r,`Unsupported control request subtype: ${Xn(String(r.request.subtype))}`)
  // (was `${r.request.subtype}`). Both interpolations are admitted; pinning the
  // message variable by backreference is what keeps this off the lookalike
  // fallbacks elsewhere in the bundle — see README §"2.1.261 changes".
  const anchorRe = new RegExp(
    `else (${V})\\((${V}),\`Unsupported control request subtype: ` +
      `\\$\\{(?:\\2\\.request\\.subtype|${V}\\(String\\(\\2\\.request\\.subtype\\)\\))\\}\`\\)`
  )

  const anchorMatch = anchorRe.exec(src)
  if (!anchorMatch) {
    console.error('ERROR: Cannot locate control-request fallback anchor.')
    process.exit(1)
  }

  const anchorIdx = anchorMatch.index

  // Verify uniqueness
  const allAnchorMatches = [...src.matchAll(new RegExp(anchorRe, 'g'))]
  if (allAnchorMatches.length > 1) {
    console.error('ERROR: Anchor matched multiple times. Aborting.')
    process.exit(1)
  }

  const errorFn = anchorMatch[1] // error response function
  const msgVar = anchorMatch[2] // control message variable
  const chunkIndex = buildChunkIndex(src)
  console.log(
    `Found fallback anchor at char ${anchorIdx} (errorFn=${errorFn}, msgVar=${msgVar}) ` +
      `in ${chunkName(chunkIndex, anchorIdx)}`
  )

  // ---------------------------------------------------------------------------
  // Extract the success response helper
  //
  // NOTE: Search globally rather than within a window around the anchor.
  // The pattern is globally unique (verified below), and a windowed search
  // breaks when prior patches (e.g. background-task) shift the anchor and
  // push the original `,X(MH,{})}catch` site out of the window.
  // ---------------------------------------------------------------------------
  console.log('\n--- Extracting function names from content patterns ---')

  const successRe = new RegExp(
    `\\),(${V})\\(${msgVar.replace(/\$/g, '\\$')},\\{\\}\\)\\}catch`,
    'g'
  )
  const successMatches = [...src.matchAll(successRe)]
  if (successMatches.length === 0) {
    console.error('ERROR: Cannot find success response helper pattern')
    process.exit(1)
  }
  // Multiple match sites are fine as long as they all reference the same helper.
  // v2.1.143 added a stop_task handler that also uses `P8(JH,{})}catch`, so the
  // shape is no longer globally unique — but every site calls the same function.
  const successNames = new Set(successMatches.map((m) => m[1]))
  if (successNames.size > 1) {
    console.error(
      `ERROR: Success response helper pattern resolved to multiple names: ${[...successNames].join(', ')}`
    )
    process.exit(1)
  }
  const successFn = successMatches[0][1]
  console.log(`  Success response helper: ${successFn} (${successMatches.length} call sites)`)

  // ---------------------------------------------------------------------------
  // Find the usage fetcher function by its unique string: /api/oauth/usage
  // ---------------------------------------------------------------------------
  console.log('\n--- Locating usage fetcher function ---')

  // The usage fetcher contains: `${<config>().BASE_API_URL}/api/oauth/usage`
  // It's a small async function (~312 chars). Find it by searching backwards
  // from the unique "api/oauth/usage" string to the enclosing function declaration.
  //
  // 2.1.241: the fetcher grew an optional credentials parameter and a telemetry
  // wrapper — `async function t5e(e){return mp("api_usage_fetch",async()=>{…
  // _s.get("/api/oauth/usage",{…,credentials:e})…})}`. The API client treats a
  // nullish per-request `credentials` as "resolve from ambient config"
  // (constructor: `let l=i.credentials??null;if(l)…else if(i.config!=null)…`),
  // so our zero-arg call keeps the old zero-arg fetcher's semantics unchanged.
  //
  // 2.1.261: a SECOND, destructured options parameter —
  //   async function SD(e,{atWall:t=!1}={}){return br(t?"api_usage_fetch_at_wall":"api_usage_fetch",
  //     async()=>{…let r=t?"/api/oauth/usage?at_wall=1&skip_spend=1":"/api/oauth/usage"…})}
  // Both params default, so the zero-arg call still means "ambient credentials,
  // plain /api/oauth/usage" exactly as before. The declaration matcher now
  // admits any bounded parameter list rather than a single optional identifier.
  const usageUrlIdx = src.indexOf('api/oauth/usage')
  if (usageUrlIdx === -1) {
    console.error('ERROR: Cannot find "api/oauth/usage" string in cli.js')
    process.exit(1)
  }

  // Look backwards from the string to find `async function <name>(…){`.
  const lookback = src.slice(Math.max(0, usageUrlIdx - 500), usageUrlIdx)
  const fnDeclRe = new RegExp(`async function (${V})\\([^)\\n]{0,120}\\)\\{`, 'g')
  let usageFetcherFn = null
  let usageFetcherIdx = -1
  let fnMatch
  while ((fnMatch = fnDeclRe.exec(lookback)) !== null) {
    usageFetcherFn = fnMatch[1] // take the last (closest) match
    usageFetcherIdx = Math.max(0, usageUrlIdx - 500) + fnMatch.index
  }
  if (!usageFetcherFn) {
    console.error('ERROR: Cannot find enclosing async function for "api/oauth/usage"')
    process.exit(1)
  }
  console.log(
    `  Usage fetcher function: ${usageFetcherFn} in ${chunkName(chunkIndex, usageFetcherIdx)}`
  )

  // Verify that all `api/oauth/usage` occurrences are inside the same function
  // body. v2.1.143 added a debug log line (`GET /api/oauth/usage (attempt N)`)
  // alongside the existing `k4.get("/api/oauth/usage", ...)` call — both inside
  // the same fetcher function. As long as they cluster within a small window,
  // we're confident the lookback correctly identified the enclosing function.
  const usageUrlPositions = [...src.matchAll(/api\/oauth\/usage/g)].map((m) => m.index)
  const usageUrlSpan = usageUrlPositions[usageUrlPositions.length - 1] - usageUrlPositions[0]
  if (usageUrlPositions.length === 0 || usageUrlSpan > 500) {
    console.error(
      `ERROR: "api/oauth/usage" occurrences (${usageUrlPositions.length}) span ${usageUrlSpan} chars — not co-located. Aborting.`
    )
    process.exit(1)
  }
  console.log(
    `  Verified: "api/oauth/usage" appears ${usageUrlPositions.length}× within ${usageUrlSpan} chars (same function)`
  )

  // ---------------------------------------------------------------------------
  // Make the fetcher callable from the dispatch chunk
  // ---------------------------------------------------------------------------
  const resolvedCall = resolveCall(src, chunkIndex, usageFetcherFn, usageFetcherIdx, anchorIdx)
  if (!resolvedCall) {
    console.error(
      `ERROR: ${usageFetcherFn} is private to ${chunkName(chunkIndex, usageFetcherIdx)} — it ` +
        `cannot be reached from ${chunkName(chunkIndex, anchorIdx)}. Aborting rather than ` +
        'injecting a call that would throw at runtime.'
    )
    process.exit(1)
  }
  console.log(
    `  Call expression: ${resolvedCall.call}()` +
      (resolvedCall.viaImport
        ? ' (dynamic import — not statically imported by the dispatch chunk)'
        : '')
  )

  // ---------------------------------------------------------------------------
  // Inject the get_usage handler before the "Unsupported" fallback
  // ---------------------------------------------------------------------------
  console.log('\n--- Injecting get_usage handler ---')

  // Auth-state errors (essential-traffic-only / no-auth / data-residency) are
  // not real failures — they just mean usage data is not available for this
  // account. Return an empty object so consumers can branch on `Object.keys()`
  // without try/catch. Real fetcher failures (network, malformed) still bubble
  // up via the error path so callers see them.
  const injection =
    PATCH_MARKER +
    `else if(${msgVar}.request.subtype==="get_usage"){` +
    `try{` +
    `let Z6=await ${resolvedCall.call}();` +
    `${successFn}(${msgVar},Z6??{})` +
    `}catch(S6){` +
    `let X6=S6 instanceof Error?S6.message:String(S6);` +
    `if(typeof X6==="string"&&X6.indexOf("Auth error:")===0){` +
    `${successFn}(${msgVar},{})` +
    `}else{` +
    `${errorFn}(${msgVar},X6)` +
    `}` +
    `}` +
    `}`

  src = src.slice(0, anchorIdx) + injection + src.slice(anchorIdx)
  console.log('Injected get_usage handler')

  // Write and verify cli.js
  writeFileSync(cliPath, src)
  console.log(`\nPatch applied to ${cliPath}`)

  const verify = readFileSync(cliPath, 'utf-8')
  const cliOk = verify.includes(PATCH_MARKER)
  console.log(`  ${cliOk ? 'OK' : 'MISSING'} Part A marker`)

  if (!cliOk) {
    console.error('\nPart A verification FAILED.')
    process.exit(1)
  }
  console.log('\ncli.js verified.')
}

console.log('')
console.log('What this does:')
console.log(
  '  Part A (cli.js): get_usage control-request handler (calls internal OAuth usage API).'
)
console.log('  Part B (sdk.mjs) was removed — getUsage() lives in src/main/sdk/.')

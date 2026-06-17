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

  const anchorRe = new RegExp(
    `else (${V})\\((${V}),\`Unsupported control request subtype: \\$\\{\\2\\.request\\.subtype\\}\`\\);continue\\}else if\\(\\2\\.type==="control_response"\\)`
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
  console.log(`Found fallback anchor at char ${anchorIdx} (errorFn=${errorFn}, msgVar=${msgVar})`)

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
  const usageUrlIdx = src.indexOf('api/oauth/usage')
  if (usageUrlIdx === -1) {
    console.error('ERROR: Cannot find "api/oauth/usage" string in cli.js')
    process.exit(1)
  }

  // Look backwards from the string to find `async function <name>(){`
  const lookback = src.slice(Math.max(0, usageUrlIdx - 500), usageUrlIdx)
  const fnDeclRe = new RegExp(`async function (${V})\\(\\)\\{`, 'g')
  let usageFetcherFn = null
  let fnMatch
  while ((fnMatch = fnDeclRe.exec(lookback)) !== null) {
    usageFetcherFn = fnMatch[1] // take the last (closest) match
  }
  if (!usageFetcherFn) {
    console.error('ERROR: Cannot find enclosing async function for "api/oauth/usage"')
    process.exit(1)
  }
  console.log(`  Usage fetcher function: ${usageFetcherFn}`)

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
    `let Z6=await ${usageFetcherFn}();` +
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

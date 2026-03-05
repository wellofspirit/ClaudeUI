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
const cliPath = resolve(projectRoot, 'node_modules/@anthropic-ai/claude-agent-sdk/cli.js')
const sdkPath = resolve(projectRoot, 'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs')

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

  const errorFn = anchorMatch[1]   // error response function
  const msgVar = anchorMatch[2]    // control message variable
  console.log(`Found fallback anchor at char ${anchorIdx} (errorFn=${errorFn}, msgVar=${msgVar})`)

  // ---------------------------------------------------------------------------
  // Extract the success response helper
  // ---------------------------------------------------------------------------
  console.log('\n--- Extracting function names from content patterns ---')

  const nearbyCtx = src.slice(Math.max(0, anchorIdx - 5000), anchorIdx + 2000)

  const successRe = new RegExp(`\\),(${V})\\(${msgVar.replace(/\$/g, '\\$')},\\{\\}\\)\\}catch`)
  const successMatch = successRe.exec(nearbyCtx)
  if (!successMatch) {
    console.error('ERROR: Cannot find success response helper pattern')
    process.exit(1)
  }
  const successFn = successMatch[1]
  console.log(`  Success response helper: ${successFn}`)

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
    usageFetcherFn = fnMatch[1]  // take the last (closest) match
  }
  if (!usageFetcherFn) {
    console.error('ERROR: Cannot find enclosing async function for "api/oauth/usage"')
    process.exit(1)
  }
  console.log(`  Usage fetcher function: ${usageFetcherFn}`)

  // Verify uniqueness of the string
  const usageUrlCount = [...src.matchAll(/api\/oauth\/usage/g)].length
  if (usageUrlCount !== 1) {
    console.error(`ERROR: "api/oauth/usage" found ${usageUrlCount} times (expected 1). Aborting.`)
    process.exit(1)
  }
  console.log(`  Verified: "api/oauth/usage" appears exactly once`)

  // ---------------------------------------------------------------------------
  // Inject the get_usage handler before the "Unsupported" fallback
  // ---------------------------------------------------------------------------
  console.log('\n--- Injecting get_usage handler ---')

  const injection = PATCH_MARKER +
    `else if(${msgVar}.request.subtype==="get_usage"){` +
      `try{` +
        `let Z6=await ${usageFetcherFn}();` +
        `${successFn}(${msgVar},Z6??{})` +
      `}catch(S6){` +
        `${errorFn}(${msgVar},S6 instanceof Error?S6.message:String(S6))` +
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

// ===========================================================================
// Part B: Patch sdk.mjs — expose getUsage on the query
// ===========================================================================

console.log('\n\n=== Part B: Patching sdk.mjs ===')

const SDK_MARKER = '/*PATCHED:usage-relay-sdk*/'

let sdkSrc
try {
  sdkSrc = readFileSync(sdkPath, 'utf-8')
} catch (err) {
  console.error(`ERROR: Cannot read ${sdkPath}`)
  process.exit(1)
}

console.log(`Read ${sdkPath} (${(sdkSrc.length / 1024).toFixed(0)} KB)`)

if (sdkSrc.includes(SDK_MARKER)) {
  console.log('Part B already applied. Skipping.')
} else {
  // Anchor: async stopTask(<var>){await this.request({subtype:"stop_task",task_id:<var>})}
  const sdkAnchorRe = new RegExp(
    `async stopTask\\((${V})\\)\\{await this\\.request\\(\\{subtype:"stop_task",task_id:\\1\\}\\)\\}`
  )
  const sdkMatch = sdkAnchorRe.exec(sdkSrc)
  if (!sdkMatch) {
    console.error('ERROR: Cannot locate stopTask anchor in sdk.mjs')
    process.exit(1)
  }

  const sdkIdx = sdkMatch.index

  // Verify uniqueness
  const allSdkMatches = [...sdkSrc.matchAll(new RegExp(sdkAnchorRe, 'g'))]
  if (allSdkMatches.length > 1) {
    console.error('ERROR: stopTask anchor matched multiple times in sdk.mjs')
    process.exit(1)
  }
  console.log(`Found stopTask anchor at char ${sdkIdx}`)

  // Inject after the closing } of stopTask
  const insertAt = sdkIdx + sdkMatch[0].length
  const sdkInjection = SDK_MARKER +
    `async getUsage(){return(await this.request({subtype:"get_usage"})).response}`

  sdkSrc = sdkSrc.slice(0, insertAt) + sdkInjection + sdkSrc.slice(insertAt)
  writeFileSync(sdkPath, sdkSrc)
  console.log(`Patch applied to ${sdkPath}`)

  const sdkVerify = readFileSync(sdkPath, 'utf-8')
  const sdkOk = sdkVerify.includes(SDK_MARKER)
  console.log(`  ${sdkOk ? 'OK' : 'MISSING'} SDK patch marker`)
  if (!sdkOk) {
    console.error('\nPart B verification FAILED.')
    process.exit(1)
  }
  console.log('\nPart B verified (sdk.mjs).')
}

console.log('')
console.log('What this does:')
console.log('  cli.js: get_usage control-request handler (calls internal OAuth usage API)')
console.log('  sdk.mjs: getUsage() method on the query object')

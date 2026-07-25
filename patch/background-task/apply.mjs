/**
 * Patch: background-task
 *
 * Exposes the CLI's "send to background" feature via the SDK control message API.
 *
 *   Part A (cli.js): background_task control request handler — looks up the task
 *                     by ID, then for bash calls shellCommand.background() and for
 *                     agents resolves the backgroundSignal and sets isBackgrounded.
 *
 *   Part B (sdk.mjs): backgroundTask() method on the query object.
 *
 * All minified function names are extracted dynamically from content patterns
 * so the patch survives SDK version bumps.
 *
 * See README.md for full analysis.
 *
 * Usage: node patch/background-task/apply.mjs
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

const PATCH_MARKER = '/*PATCHED:background-task*/'

// =====================================================================
// Part A: background_task control request handler
// =====================================================================

if (src.includes(PATCH_MARKER)) {
  console.log('Part A already applied. Skipping.')
} else {
  console.log('\n=== Part A: background_task control request ===')

  // ---------------------------------------------------------------------------
  // Find the injection point — the "Unsupported control request subtype" fallback
  // ---------------------------------------------------------------------------
  console.log('\n--- Locating control-request fallback ---')

  // v2.1.219 wrapped the control-request dispatch chain in a try/finally, so the
  // fallback tail changed from `...subtype}`);continue}else if(msg.type==="control_response")`
  // to `...subtype}`)}finally{...}continue}else if(...)`. Match the fallback call
  // itself (tail-less) — still globally unique.
  const anchorRe = new RegExp(
    `else (${V})\\((${V}),\`Unsupported control request subtype: \\$\\{\\2\\.request\\.subtype\\}\`\\)`
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

  const errorFn = anchorMatch[1] // error response function (e.g., O6)
  const msgVar = anchorMatch[2] // control message variable (e.g., r)
  console.log(`Found fallback anchor at char ${anchorIdx} (errorFn=${errorFn}, msgVar=${msgVar})`)

  // ---------------------------------------------------------------------------
  // Extract minified function names from content patterns
  // ---------------------------------------------------------------------------
  console.log('\n--- Extracting function names from content patterns ---')

  // Window extended from 5000 → 8000: in v2.1.197 the stop_task handler (source
  // of the success-response-helper pattern) moved to 5647 chars before the anchor,
  // just outside the old 5000-char window.  8000 gives a comfortable margin.
  const nearbyCtx = src.slice(Math.max(0, anchorIdx - 8000), anchorIdx + 2000)

  // --- Success response helper (called after stop_task success) ---
  const successRe = new RegExp(`\\),(${V})\\(${msgVar.replace(/\$/g, '\\$')},\\{\\}\\)\\}catch`)
  const successMatch = successRe.exec(nearbyCtx)
  if (!successMatch) {
    console.error('ERROR: Cannot find success response helper pattern')
    process.exit(1)
  }
  const successFn = successMatch[1]
  console.log(`  Success response helper: ${successFn}`)

  // --- getAppState variable (from stop_task handler: getAppState:$VAR) ---
  const getAppStateRe = new RegExp(`getAppState:(${V}),setAppState:(${V})`)
  const getAppStateMatch = getAppStateRe.exec(nearbyCtx)
  if (!getAppStateMatch) {
    console.error('ERROR: Cannot find getAppState/setAppState variables')
    process.exit(1)
  }
  const getAppStateFn = getAppStateMatch[1]
  const setAppStateFn = getAppStateMatch[2]
  console.log(`  getAppState: ${getAppStateFn}, setAppState: ${setAppStateFn}`)

  // --- wi (local_bash type check): function <name>(A){return typeof A==="object"&&A!==null&&"type"in A&&A.type==="local_bash"} ---
  const wiRe = new RegExp(
    `function (${V})\\(${V}\\)\\{return typeof ${V}==="object"&&${V}!==null&&"type"in ${V}&&${V}\\.type==="local_bash"\\}`
  )
  const wiMatch = wiRe.exec(src)
  if (!wiMatch) {
    console.error('ERROR: Cannot find local_bash type check function (wi)')
    process.exit(1)
  }
  const wiFn = wiMatch[1]
  console.log(`  local_bash check (wi): ${wiFn}`)

  // Verify wi uniqueness
  const allWiMatches = [...src.matchAll(new RegExp(wiRe, 'g'))]
  if (allWiMatches.length > 1) {
    console.error('ERROR: local_bash type check matched multiple times. Aborting.')
    process.exit(1)
  }

  // --- Yi (local_agent type check): same shape as wi but type==="local_agent" ---
  // Since 0.2.87 two candidate functions define the identical
  // `typeof x==="object"&&...&&x.type==="local_agent"` shape (task-management +
  // TUI copies). Disambiguate by which one is used in a
  // `<fn>(x)&&x.agentType!=="main-session"` guard — only the task-management copy
  // is. Up to 2.1.207 the guard sat near the definition (≤400 chars) so a single
  // bounded-gap regex worked; v2.1.219 moved it ~2.3M chars away, so match the
  // definition and the guard usage independently rather than requiring adjacency.
  const yiDefRe = new RegExp(
    `function (${V})\\(${V}\\)\\{return typeof ${V}==="object"&&${V}!==null&&"type"in ${V}&&${V}\\.type==="local_agent"\\}`,
    'g'
  )
  const yiCandidates = [...new Set([...src.matchAll(yiDefRe)].map((m) => m[1]))]
  if (yiCandidates.length === 0) {
    console.error('ERROR: Cannot find local_agent type check function (Yi)')
    process.exit(1)
  }
  const yiUsed = yiCandidates.filter((name) =>
    new RegExp(`${name.replace(/\$/g, '\\$')}\\(${V}\\)&&${V}\\.agentType!=="main-session"`).test(
      src
    )
  )
  if (yiUsed.length !== 1) {
    console.error(
      `ERROR: local_agent disambiguation failed — ${yiUsed.length} of ${yiCandidates.length} candidate(s) [${yiCandidates.join(', ')}] used with agentType!=="main-session". Aborting.`
    )
    process.exit(1)
  }
  const yiFn = yiUsed[0]
  console.log(`  local_agent check (Yi): ${yiFn}`)

  // --- Ff6 (backgroundSignal resolver Map) ---
  // Found by looking for the pattern in the agent task factory:
  //   <MAP>.set(A, <resolveVar>), <registerFn>(...);
  // Near "backgroundSignal" which appears in the return statement
  // v0.2.97: MAP.set(A,B),FN(C,D);let E;if(F!==void 0&&F>0)
  // v0.2.105: MAP.set(q,J),Y.register(H);let M;if(A!==void 0&&A>0)
  const bgSignalRe = new RegExp(
    `(${V})\\.set\\(${V},${V}\\),${V}(?:\\.${V})?\\(${V}(?:,${V})?\\);let ${V};if\\(${V}!==void 0&&${V}>0\\)`
  )
  const bgSignalMatch = bgSignalRe.exec(src)
  if (!bgSignalMatch) {
    console.error('ERROR: Cannot find backgroundSignal resolver Map (Ff6-like)')
    process.exit(1)
  }
  const bgSignalMap = bgSignalMatch[1]
  console.log(`  backgroundSignal Map: ${bgSignalMap}`)

  // Verify: the Map should be defined as <name>=new Map somewhere
  const mapDefCheck = src.includes(`${bgSignalMap}=new Map`)
  if (!mapDefCheck) {
    console.error(`ERROR: ${bgSignalMap}=new Map not found — wrong variable captured`)
    process.exit(1)
  }
  console.log(`  Verified: ${bgSignalMap}=new Map exists`)

  // ---------------------------------------------------------------------------
  // Inject the background_task handler before the "Unsupported" fallback
  // ---------------------------------------------------------------------------
  console.log('\n--- Injecting background_task handler ---')

  // Use unique temp variable names that won't conflict with the existing scope
  // The handler uses Z6, S6, C6, d6 which are already used locally in other
  // branches but are scoped to those branches (let declarations)
  //
  // Accept tool_use_id (from the tool_use block) and search tasks by toolUseId
  // property — NOT by task key. Foreground tasks don't have a task_id mapping
  // in the consumer because detectTaskMapping only runs on tool results.
  const injection =
    PATCH_MARKER +
    `else if(${msgVar}.request.subtype==="background_task"){` +
    `let{tool_use_id:Z6}=${msgVar}.request;` +
    `try{` +
    `let S6=null,C6=null,d6=(await ${getAppStateFn}()).tasks;` +
    `for(let k6 of Object.keys(d6)){if(d6[k6].toolUseId===Z6){C6=k6;S6=d6[k6];break}}` +
    `if(!S6||!C6)throw Error("No task found with toolUseId: "+Z6);` +
    `if(S6.status!=="running")throw Error("Task "+C6+" is not running (status: "+S6.status+")");` +
    `if(S6.isBackgrounded)throw Error("Task "+C6+" is already backgrounded");` +
    `if(${wiFn}(S6)){` +
    `if(!S6.shellCommand||!S6.shellCommand.background(C6))throw Error("Failed to background bash task "+C6);` +
    `${setAppStateFn}((k6)=>{let m6=k6.tasks[C6];if(!m6||m6.isBackgrounded)return k6;return{...k6,tasks:{...k6.tasks,[C6]:{...m6,isBackgrounded:!0}}}})` +
    `}else if(${yiFn}(S6)){` +
    `${setAppStateFn}((k6)=>{let m6=k6.tasks[C6];if(!m6||m6.isBackgrounded)return k6;return{...k6,tasks:{...k6.tasks,[C6]:{...m6,isBackgrounded:!0}}}});` +
    `let k6=${bgSignalMap}.get(C6);if(k6)k6(),${bgSignalMap}.delete(C6)` +
    `}else{` +
    `throw Error("Unsupported task type for backgrounding")` +
    `}` +
    `${successFn}(${msgVar},{task_id:C6,tool_use_id:Z6})` +
    `}catch(S6){` +
    `${errorFn}(${msgVar},S6 instanceof Error?S6.message:String(S6))` +
    `}` +
    `}`

  src = src.slice(0, anchorIdx) + injection + src.slice(anchorIdx)
  console.log('Injected background_task handler')

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
  '  Part A (cli.js): background_task control-request handler (backgrounds running bash/agent tasks).'
)
console.log('  Part B (sdk.mjs) was removed — backgroundTask() lives in src/main/sdk/.')

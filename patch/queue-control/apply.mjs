/**
 * Patch: queue-control
 *
 * Two patches to the CLI + SDK for queue management mid-agent-turn:
 *
 *   Part A1 (cli.js): dequeue_message control request — removes a queued item
 *                      by value (text content) via the queue-remove-by-predicate
 *                      function.
 *
 *   Part A2 (cli.js): queued_command_consumed notification — fires a system
 *                      event when a queued_command attachment is consumed by
 *                      submitMessage, so the UI knows the steer was picked up.
 *
 *   Part B (sdk.mjs): dequeueMessage() method on the query object.
 *
 * The native steer mechanism (sendPrompt → messageChannel → stdin → queuePush)
 * handles injection. queue_message is NOT needed — see docs/cli-message-loop-internals.md.
 *
 * All minified function names are extracted dynamically from content patterns
 * so the patch survives SDK version bumps.
 *
 * See README.md for full analysis.
 *
 * Usage: node patch/queue-control/apply.mjs
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

const PATCH_A1_MARKER = '/*PATCHED:queue-control-dequeue*/'
const PATCH_A2_MARKER = '/*PATCHED:queue-control-consumed*/'

// =====================================================================
// Part A1: dequeue_message control request (value-based matching)
// =====================================================================

let skipA1 = src.includes(PATCH_A1_MARKER)
if (skipA1) {
  console.log('Part A1 already applied. Skipping.')
}

if (!skipA1) {
  console.log('\n=== Part A1: dequeue_message control request ===')

  // ---------------------------------------------------------------------------
  // Find the injection point — the "Unsupported control request subtype" fallback
  // ---------------------------------------------------------------------------
  console.log('\n--- Locating control-request fallback ---')

  // The message variable changed between versions (c in 0.2.50, e in 0.2.59).
  // Use a captured group + backreference to handle any variable name.
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

  const msgVar = anchorMatch[2]  // message variable (c in 0.2.50, e in 0.2.59)
  console.log(`Found fallback anchor at char ${anchorIdx} (msgVar=${msgVar})`)

  // ---------------------------------------------------------------------------
  // Extract minified function names from content patterns
  // ---------------------------------------------------------------------------
  console.log('\n--- Extracting function names from content patterns ---')

  const nearbyCtx = src.slice(Math.max(0, anchorIdx - 5000), anchorIdx + 2000)

  // --- Success response helper ---
  const successRe = new RegExp(`\\),(${V})\\(${msgVar.replace(/\$/g, '\\$')},\\{\\}\\)\\}catch`)
  const successMatch = successRe.exec(nearbyCtx)
  if (!successMatch) {
    console.error('ERROR: Cannot find success response helper pattern')
    process.exit(1)
  }
  const successFn = successMatch[1]
  console.log(`  Success response helper: ${successFn}`)

  // --- Queue push function (needed to find the queue module) ---
  const pushLoopRe = new RegExp(`(${V})\\(\\{mode:"prompt",value:${V}\\.message\\.content,uuid:${V}\\.uuid\\}\\),(${V})\\(\\)`)
  const pushLoopMatch = pushLoopRe.exec(nearbyCtx)
  if (!pushLoopMatch) {
    console.error('ERROR: Cannot find queue-push + loop-starter pattern')
    process.exit(1)
  }
  const pushFn = pushLoopMatch[1]
  console.log(`  Queue push function: ${pushFn}`)

  // --- Queue remove-by-predicate function ---
  const pushDefRe = new RegExp(`function ${pushFn.replace(/\$/g, '\\$')}\\((${V})\\)\\{(${V})\\.push\\(`)
  const pushDefMatch = pushDefRe.exec(src)
  if (!pushDefMatch) {
    console.error(`ERROR: Cannot find definition of queue push function: function ${pushFn}(...)`)
    process.exit(1)
  }
  const pushDefIdx = pushDefMatch.index
  const queueArr = pushDefMatch[2]
  console.log(`  Queue array: ${queueArr}`)

  const queueModule = src.slice(pushDefIdx, pushDefIdx + 1500)
  const removeFnRe = new RegExp(`function (${V})\\(${V}\\)\\{let ${V}=\\[\\];for\\(let ${V}=${queueArr.replace(/\$/g, '\\$')}\\.length-1`)
  const removeFnMatch = removeFnRe.exec(queueModule)
  if (!removeFnMatch) {
    console.error('ERROR: Cannot find queue remove-by-predicate function near queue push definition')
    process.exit(1)
  }
  const removeFn = removeFnMatch[1]
  console.log(`  Queue remove-by-predicate: ${removeFn}`)

  // --- Find extractQueueText function (Ha9-like) ---
  // This function extracts the text from a queue item's value.
  // It's used in popAllEditable: called like extractQueueText(<var>.value)
  // Pattern: near the queue module, look for a function that's called as <fn>(<var>.value)
  // in the context of popAllEditable (which also uses removeFn)
  //
  // The function appears in patterns like: <fn>(<var>.value) near popAllEditable's body
  // We find it by scanning near removeFn for a call pattern like <fn>(<var>.value)==="
  // which is used to check if a queued item is a specific type.
  //
  // Alternative: look for a function that extracts text from content blocks.
  // Pattern in popAllEditable: removeFn(X => extractFn(X.value) === ...)
  // But we can also just compare .value directly since steer items have string values.
  //
  // Actually, queue items from the native steer path have:
  //   { mode: "prompt", value: <sdkMessage>, uuid: ... }
  // where value is the full SDK user message object { type: "user", message: { role: "user", content: ... } }
  // The text is nested inside value.message.content (which can be a string or array).
  //
  // For matching, we just need to find items where the text content matches.
  // Let's extract the helper that the CLI uses. Look for a function called near
  // removeFn that processes queue values.
  //
  // Simpler approach: match on JSON.stringify of the value or use a custom predicate.
  // For robustness, let's find the extractQueueText pattern.

  // Search for a function called as <fn>(<var>.value) in the ~2000 chars after removeFn
  const afterRemoveFn = src.slice(pushDefIdx, pushDefIdx + 3000)
  // Look for pattern: <fn>(<var>.value) used with string comparison
  // In CLI 2.1.50, this appears as: Ha9(v2.value) in popAllEditable
  const extractTextRe = new RegExp(`(${V})\\(${V}\\.value\\)`)
  const extractTextMatch = extractTextRe.exec(afterRemoveFn)
  let extractTextFn = null
  if (extractTextMatch) {
    extractTextFn = extractTextMatch[1]
    console.log(`  Extract queue text function: ${extractTextFn}`)
  } else {
    console.log('  WARNING: Cannot find extractQueueText function — will use direct value comparison')
  }

  // ---------------------------------------------------------------------------
  // Inject the dequeue_message handler
  // ---------------------------------------------------------------------------
  console.log('\n--- Injecting dequeue_message handler ---')

  // The predicate for dequeue: match items where the extracted text equals the provided value
  const predicate = extractTextFn
    ? `(_6)=>${extractTextFn}(_6.value)===Y6`
    : `(_6)=>typeof _6.value==="string"?_6.value===Y6:JSON.stringify(_6.value)===Y6`

  const injectionA1 = PATCH_A1_MARKER +
    `else if(${msgVar}.request.subtype==="dequeue_message"){` +
      `let{value:Y6}=${msgVar}.request;` +
      `let O6=${removeFn}(${predicate});` +
      `${successFn}(${msgVar},{removed:O6.length})` +
    `}`

  src = src.slice(0, anchorIdx) + injectionA1 + src.slice(anchorIdx)

  console.log('Injected dequeue_message handler')
}

// =====================================================================
// Part A2: queued_command_consumed notification in submitMessage
// =====================================================================

let skipA2 = src.includes(PATCH_A2_MARKER)
if (skipA2) {
  console.log('Part A2 already applied. Skipping.')
}

if (!skipA2) {
  console.log('\n=== Part A2: queued_command_consumed notification ===')

  // Find the queued_command attachment handler in submitMessage.
  // Pattern: else if(G&&<var>.attachment.type==="queued_command")yield{...isReplay:!0}
  // We need to replace it so it:
  //   1. Always yields a system notification (regardless of G)
  //   2. Only yields the user message replay when G is true

  // Find the pattern: else if(REPLAY_VAR&&<var>.attachment.type==="queued_command")
  // Capture: the replayUserMessages var and the attachment var
  // v2.1.50: G, v2.1.59: Z — generalize with ${V}
  const qcRe = new RegExp(
    `else if\\((${V})&&(${V})\\.attachment\\.type==="queued_command"\\)yield\\{`
  )
  const qcMatch = qcRe.exec(src)
  if (!qcMatch) {
    console.error('ERROR: Cannot find queued_command attachment handler in submitMessage')
    console.error('Pattern: else if(REPLAY&&<var>.attachment.type==="queued_command")yield{')
    process.exit(1)
  }

  const qcIdx = qcMatch.index
  const replayVar = qcMatch[1]
  const attachVar = qcMatch[2]
  console.log(`Found queued_command handler at char ${qcIdx}, replay var: ${replayVar}, attachment var: ${attachVar}`)

  // Verify uniqueness
  const allQcMatches = [...src.matchAll(new RegExp(qcRe, 'g'))]
  if (allQcMatches.length > 1) {
    console.error('ERROR: queued_command handler matched multiple times. Aborting.')
    process.exit(1)
  }

  // Find the full extent of the yield statement. It ends with "isReplay:!0}"
  // The yield object contains nested braces (message:{...}), so we can't use [^}]*
  // Instead, use [\s\S]*? (non-greedy any char) anchored to isReplay:!0}
  const afterQc = src.slice(qcIdx)
  const fullQcRe = new RegExp(
    `else if\\(${replayVar.replace(/\$/g, '\\$')}&&${attachVar.replace(/\$/g, '\\$')}\\.attachment\\.type==="queued_command"\\)yield\\{[\\s\\S]*?isReplay:!0\\}`
  )
  const fullQcMatch = fullQcRe.exec(afterQc)
  if (!fullQcMatch) {
    console.error('ERROR: Cannot extract full queued_command yield statement')
    process.exit(1)
  }

  const oldCode = fullQcMatch[0]
  console.log(`Old code length: ${oldCode.length} chars`)

  // Extract session_id generator from the old code: session_id:<fn>()
  const sessionIdRe = new RegExp(`session_id:(${V})\\(\\)`)
  const sessionIdMatch = sessionIdRe.exec(oldCode)
  if (!sessionIdMatch) {
    console.error('ERROR: Cannot extract session_id generator from yield')
    process.exit(1)
  }
  const sessionIdFn = sessionIdMatch[1]
  console.log(`  Session ID generator: ${sessionIdFn}`)

  // Extract uuid generator from a nearby yield in the same function (submitMessage/vHq).
  // Look for "uuid:<fn>()" where <fn> is a standalone call (not .uuid or .source_uuid).
  // The queued_command yield itself uses uuid:g6.attachment.source_uuid||g6.uuid (not a generator),
  // but other yields in the same function use uuid:<fn>() — e.g., the result yield.
  // Search in the ~2000 chars before and after the queued_command handler.
  const vHqCtx = src.slice(Math.max(0, qcIdx - 3000), qcIdx + 3000)
  const uuidGenRe = new RegExp(`uuid:(${V})\\(\\)\\}`)
  const uuidGenMatch = uuidGenRe.exec(vHqCtx)
  if (!uuidGenMatch) {
    console.error('ERROR: Cannot extract uuid generator from submitMessage context')
    process.exit(1)
  }
  const uuidFn = uuidGenMatch[1]
  console.log(`  UUID generator: ${uuidFn}`)

  // Build the replacement code
  const newCode = PATCH_A2_MARKER +
    `else if(${attachVar}.attachment.type==="queued_command"){` +
      `yield{type:"system",subtype:"queued_command_consumed",` +
        `prompt:${attachVar}.attachment.prompt,source_uuid:${attachVar}.attachment.source_uuid,` +
        `session_id:${sessionIdFn}(),uuid:${uuidFn}()};` +
      `if(${replayVar})yield{type:"user",message:{role:"user",content:${attachVar}.attachment.prompt},` +
        `session_id:${sessionIdFn}(),parent_tool_use_id:null,` +
        `uuid:${attachVar}.attachment.source_uuid||${attachVar}.uuid,isReplay:!0}` +
    `}`

  src = src.slice(0, qcIdx) + newCode + src.slice(qcIdx + oldCode.length)
  console.log('Replaced queued_command handler with consumed notification')
}

// ---------------------------------------------------------------------------
// Write and verify cli.js
// ---------------------------------------------------------------------------

if (!skipA1 || !skipA2) {
  writeFileSync(cliPath, src)
  console.log(`\nPatch applied to ${cliPath}`)

  const verify = readFileSync(cliPath, 'utf-8')
  const a1Ok = verify.includes(PATCH_A1_MARKER)
  const a2Ok = verify.includes(PATCH_A2_MARKER)
  console.log(`  ${a1Ok ? 'OK' : 'MISSING'} Part A1 marker (dequeue_message)`)
  console.log(`  ${a2Ok ? 'OK' : 'MISSING'} Part A2 marker (queued_command_consumed)`)

  if (!a1Ok || !a2Ok) {
    console.error('\nVerification FAILED.')
    process.exit(1)
  }
  console.log('\ncli.js verified.')
}

// ===========================================================================
// Part B: Patch sdk.mjs — expose dequeueMessage on the query
// ===========================================================================

console.log('\n\n=== Part B: Patching sdk.mjs ===')

const SDK_MARKER = '/*PATCHED:queue-control-sdk*/'

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
    `async dequeueMessage(Q){return await this.request({subtype:"dequeue_message",value:Q})}`

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
console.log('  cli.js A1: dequeue_message control-request handler (value-based matching)')
console.log('  cli.js A2: queued_command_consumed system notification on attachment consumption')
console.log('  sdk.mjs:   dequeueMessage() method on the query object')

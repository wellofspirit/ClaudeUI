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

const PATCH_A1_MARKER = '/*PATCHED:queue-control-dequeue*/'
const PATCH_A2_MARKER = '/*PATCHED:queue-control-consumed*/'

// =====================================================================
// Part A1: dequeue_message control request (value-based matching)
// =====================================================================

const skipA1 = src.includes(PATCH_A1_MARKER)
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

  const msgVar = anchorMatch[2] // message variable (c in 0.2.50, e in 0.2.59)
  console.log(`Found fallback anchor at char ${anchorIdx} (msgVar=${msgVar})`)

  // ---------------------------------------------------------------------------
  // Extract minified function names from content patterns
  // ---------------------------------------------------------------------------
  console.log('\n--- Extracting function names from content patterns ---')

  // Window history: 5000 → 8000 (2.1.197 moved the stop_task handler holding the
  // success-response-helper anchor to 6578 chars before the fallback) → 16000
  // (2.1.231 pushed it to 8479, outside 8000 again).
  const NEARBY_BACK = 16000
  const nearbyCtx = src.slice(Math.max(0, anchorIdx - NEARBY_BACK), anchorIdx + 2000)

  // --- Success response helper ---
  //
  // The window only bounds the search; it does not identify the helper. Since
  // the anchor keeps drifting, widening it blindly would eventually let an
  // unrelated `FN(msg,{})}catch` be picked up as "the" helper. So take EVERY
  // match in the window and require them to name the same function — with
  // several sibling control handlers all replying through the one helper, unanimity
  // is a far stronger signal than "whatever matched first".
  const successRe = new RegExp(
    `\\),(${V})\\(${msgVar.replace(/\$/g, '\\$')},\\{\\}\\)\\}catch`,
    'g'
  )
  const successNames = [...nearbyCtx.matchAll(successRe)].map((m) => m[1])
  if (successNames.length === 0) {
    console.error(
      `ERROR: Cannot find success response helper pattern within ${NEARBY_BACK} chars ` +
        'before the control-request fallback anchor.'
    )
    process.exit(1)
  }
  const successFn = successNames[0]
  if (successNames.some((n) => n !== successFn)) {
    console.error(
      `ERROR: success response helper is ambiguous — candidates disagree: ${[...new Set(successNames)].join(', ')}. Aborting.`
    )
    process.exit(1)
  }
  console.log(`  Success response helper: ${successFn} (${successNames.length}/${successNames.length} call sites agree)`)

  // --- Queue push function (found by structural content pattern) ---
  // The push function pushes to an array with priority??"next". Shape history:
  //   ≤2.1.196  function <pushFn>(<A>){<arr>.push({...<A>,priority:<A>.priority??"next"}),...}
  //   2.1.197+  ...same, plus a trailing `timestamp:` field
  //   2.1.231   function X(ae){if(!q(ae))return;e.push({...xDd(ae),priority:ae.priority??"next",timestamp:...
  //             — gained an admission guard, and the spread is now a NORMALIZER
  //             CALL on the param rather than the bare param.
  // So both the guard and the normalizer are optional, and `priority:` is
  // pinned to the function's own parameter (the part that actually identifies
  // this as the enqueue path). The "next" literal keeps us off its `"later"`
  // sibling, which is otherwise identical.
  const pushDefRe = new RegExp(
    `function (${V})\\((${V})\\)\\{(?:if\\(!${V}\\(\\2\\)\\)return;)?` +
      `(${V})\\.push\\(\\{\\.\\.\\.(?:\\2|${V}\\(\\2\\)),priority:\\2\\.priority\\?\\?"next",timestamp:`
  )
  const pushDefMatch = pushDefRe.exec(src)
  if (!pushDefMatch) {
    console.error('ERROR: Cannot find queue push function by priority??"next" pattern')
    process.exit(1)
  }
  if (pushDefRe.exec(src.slice(pushDefMatch.index + 1))) {
    console.error('ERROR: queue push function pattern matched more than once. Aborting.')
    process.exit(1)
  }
  const pushFn = pushDefMatch[1]
  const pushDefIdx = pushDefMatch.index
  const queueArr = pushDefMatch[3]
  console.log(`  Queue push function: ${pushFn}`)
  console.log(`  Queue array: ${queueArr}`)

  // --- Queue remove-by-predicate function (module-level binding) ---
  // The actual function is defined inside a factory closure (closure-local names
  // like `Z` are NOT visible outside it). After the factory returns, the host
  // module binds each closure-export to a top-level identifier via an
  // assignment chain at module init: `MODLOCAL = FACTORY_RETURN.dequeueAllMatching`.
  // We need that MODLOCAL — the control-request handler runs in a scope where
  // the closure-locals are not in lexical scope. Using `Z` would shadow with
  // whatever happens to be named `Z` at the handler site (e.g. a string).
  const removeFnRe = new RegExp(`(${V})=(${V})\\.dequeueAllMatching\\b`)
  const removeFnMatch = removeFnRe.exec(src)
  if (!removeFnMatch) {
    console.error('ERROR: Cannot find module-level binding for queue.dequeueAllMatching')
    process.exit(1)
  }
  const removeFn = removeFnMatch[1]
  console.log(`  Queue remove-by-predicate: ${removeFn} (= ${removeFnMatch[2]}.dequeueAllMatching)`)

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
    console.log(
      '  WARNING: Cannot find extractQueueText function — will use direct value comparison'
    )
  }

  // ---------------------------------------------------------------------------
  // Inject the dequeue_message handler
  // ---------------------------------------------------------------------------
  console.log('\n--- Injecting dequeue_message handler ---')

  // The predicate for dequeue: match items where the extracted text equals the provided value
  const predicate = extractTextFn
    ? `(_6)=>${extractTextFn}(_6.value)===Y6`
    : `(_6)=>typeof _6.value==="string"?_6.value===Y6:JSON.stringify(_6.value)===Y6`

  const injectionA1 =
    PATCH_A1_MARKER +
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

const skipA2 = src.includes(PATCH_A2_MARKER)
if (skipA2) {
  console.log('Part A2 already applied. Skipping.')
}

if (!skipA2) {
  console.log('\n=== Part A2: queued_command_consumed notification ===')

  // Find the queued_command attachment handler in submitMessage.
  // SDK ≤0.2.87: else if(Z&&q8.attachment.type==="queued_command")yield{...isReplay:!0}
  // SDK ≥0.2.89: else if(Z&&q8.attachment.type==="queued_command"){let W6=q8.attachment;yield{...}}
  // We replace it so it:
  //   1. Always yields a system notification (regardless of replay var)
  //   2. Only yields the user message replay when replay var is true

  // Try new pattern first (≥0.2.89): has `let` extraction + braces wrapping + fileAttachments spread
  // Then fall back to old pattern (≤0.2.87): inline yield
  const qcReNew = new RegExp(
    `else if\\((${V})&&(${V})\\.attachment\\.type==="queued_command"\\)\\{let (${V})=\\2\\.attachment;yield\\{`
  )
  const qcReOld = new RegExp(
    `else if\\((${V})&&(${V})\\.attachment\\.type==="queued_command"\\)yield\\{`
  )

  let qcMatch = qcReNew.exec(src)
  const isNewPattern = !!qcMatch
  if (!qcMatch) qcMatch = qcReOld.exec(src)
  if (!qcMatch) {
    console.error('ERROR: Cannot find queued_command attachment handler in submitMessage')
    process.exit(1)
  }

  const qcIdx = qcMatch.index
  const replayVar = qcMatch[1]
  const attachVar = qcMatch[2]
  const extractedVar = isNewPattern ? qcMatch[3] : null
  console.log(
    `Found queued_command handler at char ${qcIdx}, replay var: ${replayVar}, attachment var: ${attachVar}${isNewPattern ? `, extracted var: ${extractedVar}` : ''} (${isNewPattern ? 'new' : 'old'} pattern)`
  )

  // Verify uniqueness
  const qcReUsed = isNewPattern ? qcReNew : qcReOld
  const allQcMatches = [...src.matchAll(new RegExp(qcReUsed, 'g'))]
  if (allQcMatches.length > 1) {
    console.error('ERROR: queued_command handler matched multiple times. Aborting.')
    process.exit(1)
  }

  // Find the full extent of the handler.
  // New pattern (≥0.2.89): ends with `...fileAttachments}:{}}}` (double-close for let-block + yield)
  // Old pattern (≤0.2.87): ends with `isReplay:!0}`
  const afterQc = src.slice(qcIdx)
  let fullQcRe
  if (isNewPattern) {
    // Match up to the `break;case"` that follows the handler block
    fullQcRe = new RegExp(
      `else if\\(${replayVar.replace(/\$/g, '\\$')}&&${attachVar.replace(/\$/g, '\\$')}\\.attachment\\.type==="queued_command"\\)\\{[\\s\\S]*?\\}\\}(?=break;case")`
    )
  } else {
    fullQcRe = new RegExp(
      `else if\\(${replayVar.replace(/\$/g, '\\$')}&&${attachVar.replace(/\$/g, '\\$')}\\.attachment\\.type==="queued_command"\\)yield\\{[\\s\\S]*?isReplay:!0\\}`
    )
  }
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
  // Accepts bare fn `FUNC()` and method call `OBJ.randomUUID()` (2.1.113+).
  const uuidGenRe = new RegExp(`uuid:(${V}(?:\\.${V})?)\\(\\)\\}`)
  const uuidGenMatch = uuidGenRe.exec(vHqCtx)
  if (!uuidGenMatch) {
    console.error('ERROR: Cannot extract uuid generator from submitMessage context')
    process.exit(1)
  }
  const uuidFn = uuidGenMatch[1]
  console.log(`  UUID generator: ${uuidFn}`)

  // Build the replacement code
  // For the new pattern (≥0.2.89), preserve timestamp and fileAttachments spread
  const att = isNewPattern ? extractedVar : `${attachVar}.attachment`
  const promptExpr = `${att}.prompt`
  const srcUuidExpr = `${att}.source_uuid`
  const fileAttachExpr = isNewPattern
    ? `,...${att}.fileAttachments?.length?{file_attachments:${att}.fileAttachments}:{}`
    : ''
  const timestampExpr = isNewPattern ? `,timestamp:${attachVar}.timestamp` : ''
  const letPrefix = isNewPattern ? `let ${extractedVar}=${attachVar}.attachment;` : ''

  const newCode =
    PATCH_A2_MARKER +
    `else if(${attachVar}.attachment.type==="queued_command"){` +
    letPrefix +
    `yield{type:"system",subtype:"queued_command_consumed",` +
    `prompt:${promptExpr},source_uuid:${srcUuidExpr},` +
    `session_id:${sessionIdFn}(),uuid:${uuidFn}()};` +
    `if(${replayVar})yield{type:"user",message:{role:"user",content:${promptExpr}},` +
    `session_id:${sessionIdFn}(),parent_tool_use_id:null,` +
    `uuid:${srcUuidExpr}||${attachVar}.uuid${timestampExpr},isReplay:!0${fileAttachExpr}}` +
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

console.log('')
console.log('What this does:')
console.log(
  '  Part A (cli.js): dequeue_message control-request + queued_command_consumed notification.'
)
console.log('  Part B (sdk.mjs) was removed — dequeueMessage() lives in src/main/sdk/.')

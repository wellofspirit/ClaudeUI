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

// ---------------------------------------------------------------------------
// Chunked-bundle helpers (2.1.261+)
//
// 2.1.261 is a code-split build: vendor/claude-cli/cli.js is the concatenation
// of ~1.6k minified ESM chunks, each preceded by a delimiter line
//   // @bun-chunk B:/~BUN/root/chunk-xxxxxxxx.js
// A minified name captured in one chunk is a DIFFERENT binding (or no binding
// at all) in another, so every name this patch injects has to be proven to
// come from the chunk being edited. On a pre-split monolith the index is empty
// and every "same chunk?" question answers yes.
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

// The stream-json control-request dispatch fallback — the injection point for
// A1, and (in 2.1.261) the marker for which chunk holds the headless loop that
// A2 has to patch. Both parts read it, so it lives at module scope.
//
// The message variable changed between versions (c in 0.2.50, e in 0.2.59), so
// it is captured and backreferenced rather than hard-coded.
// v2.1.219 wrapped the dispatch chain in a try/finally, so the fallback tail
// changed from `...subtype}`);continue}else if(msg.type==="control_response")`
// to `...subtype}`)}finally{...}continue}else if(...)`. Match the fallback call
// itself (tail-less) — still globally unique.
// 2.1.261 wrapped the interpolated subtype in a string sanitizer:
//   else Be(r,`Unsupported control request subtype: ${Xn(String(r.request.subtype))}`)
// (was `${r.request.subtype}`). Both interpolations are admitted; pinning the
// message variable by backreference is what keeps this off the four lookalike
// fallbacks elsewhere in the bundle — see README §"Picking the right fallback".
const anchorRe = new RegExp(
  `else (${V})\\((${V}),\`Unsupported control request subtype: ` +
    `\\$\\{(?:\\2\\.request\\.subtype|${V}\\(String\\(\\2\\.request\\.subtype\\)\\))\\}\`\\)`
)

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
  const chunkIndex = buildChunkIndex(src)
  console.log(
    `Found fallback anchor at char ${anchorIdx} (msgVar=${msgVar}) in ${chunkName(chunkIndex, anchorIdx)}`
  )

  // Start of the dispatch chain the fallback closes — every sibling handler we
  // read names off must live between here and the anchor, which is what proves
  // the captured locals are in scope at the injection point.
  const chainStartIdx = src.lastIndexOf(`${msgVar}.type==="control_request"`, anchorIdx)
  if (chainStartIdx === -1) {
    console.error('ERROR: Cannot locate the start of the control-request dispatch chain.')
    process.exit(1)
  }

  // ---------------------------------------------------------------------------
  // Extract minified function names from content patterns
  // ---------------------------------------------------------------------------
  console.log('\n--- Extracting function names from content patterns ---')

  // Window history: 5000 → 8000 (2.1.197 moved the stop_task handler holding the
  // success-response-helper anchor to 6578 chars before the fallback) → 16000
  // (2.1.231 pushed it to 8479, outside 8000 again). 2.1.261: 13214 — still
  // inside 16000. The window is additionally clamped to the dispatch chain, so
  // however far it has to grow next time it can never reach another function's
  // reply helper.
  const NEARBY_BACK = 16000
  const nearbyCtx = src.slice(Math.max(chainStartIdx, anchorIdx - NEARBY_BACK), anchorIdx)

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
  console.log(
    `  Success response helper: ${successFn} (${successNames.length}/${successNames.length} call sites agree)`
  )

  // --- Queue push function (structural cross-check only; NOT injected) ---
  //
  // Nothing below calls pushFn/queueArr — the injected handler only removes.
  // This match is kept as a structural assertion that the enqueue path this
  // patch reasons about still exists and is still singular; if it ever starts
  // costing more than it proves, delete it rather than loosening it.
  //
  // Shape history:
  //   ≤2.1.196  function <pushFn>(<A>){<arr>.push({...<A>,priority:<A>.priority??"next"}),...}
  //   2.1.197+  ...same, plus a trailing `timestamp:` field
  //   2.1.231   function X(ae){if(!q(ae))return;e.push({...xDd(ae),priority:ae.priority??"next",timestamp:...
  //             — gained an admission guard, and the spread is now a NORMALIZER
  //             CALL on the param rather than the bare param.
  //   2.1.241   function ne(Ze){if(!Z(Ze))return!1;return n.push({...GPf(Ze),priority:Ze.priority??"next",timestamp:...
  //             — the guard rejects with `return!1` and the push itself is now
  //             a `return` expression (the enqueue reports success).
  //   2.1.261   function Cn(Fo,{receipt:Wo="coalesced"}={}){let _s=$n(Fo,Wo);
  //               if(!_s.admitted)return _s;if(d.push({...u7t(Fo),priority:Fo.priority??"next",timestamp:...
  //             — a second destructured options parameter, and the guard now
  //             returns an admission RESULT OBJECT rather than a boolean, so
  //             neither the old parameter list nor the old guard shape matches.
  // Rather than enumerating guard shapes, admit any bounded single-line
  // preamble between the function head and the push, and keep the two parts
  // that actually identify the enqueue: the push spreads the function's OWN
  // parameter (bare or normalizer-wrapped) and stamps `priority:<param>
  // .priority??"next"`. The "next" literal keeps us off its `"later"` sibling,
  // which is otherwise identical. `[^\n]` cannot cross a chunk delimiter.
  const pushDefRe = new RegExp(
    `function (${V})\\((${V})[^)\\n]{0,80}\\)\\{[^\\n]{0,240}?` +
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
  const queueArr = pushDefMatch[3]
  console.log(`  Queue push function: ${pushFn} (cross-check only)`)
  console.log(`  Queue array: ${queueArr}`)

  // --- Queue instance (derived from the sibling cancel_async_message handler) ---
  // ≤2.1.231 this captured a module-level `MODLOCAL = FACTORY.dequeueAllMatching`
  // binding. 2.1.241 has NO such binding — the first `X=Y.dequeueAllMatching`
  // match in the bundle is an unrelated LOCAL holding a RESULT array
  // (`let o=e.dequeueAllMatching(...)` in a drain helper), which made the
  // injected handler call a non-function at runtime (silent until live).
  // The queue is an INSTANCE in the dispatch scope; read its name off the
  // native cancel_async_message handler in the SAME else-if chain as our
  // injection point, so the captured name is in-scope by construction:
  //   subtype==="cancel_async_message"){let Yn=Pt.request.message_uuid,
  //     Zo=S.isFoldInFlight(Yn)?[]:S.dequeueAllMatching((ga)=>ga.uuid===Yn);
  const msgVarEsc = msgVar.replace(/\$/g, '\\$')
  const cancelSiblingRe = new RegExp(
    `subtype==="cancel_async_message"\\)\\{let ${V}=${msgVarEsc}\\.request\\.message_uuid,` +
      `${V}=(${V})\\.isFoldInFlight\\(${V}\\)\\?\\[\\]:\\1\\.dequeueAllMatching\\(`
  )
  const cancelSiblingMatch = cancelSiblingRe.exec(src)
  if (!cancelSiblingMatch) {
    console.error(
      'ERROR: Cannot find the cancel_async_message sibling handler to derive the queue instance.'
    )
    process.exit(1)
  }
  if (cancelSiblingRe.exec(src.slice(cancelSiblingMatch.index + 1))) {
    console.error('ERROR: cancel_async_message sibling handler matched more than once. Aborting.')
    process.exit(1)
  }
  // "In-scope by construction" is only true if the sibling really is a sibling:
  // it has to sit inside the very else-if chain the fallback closes. A match
  // anywhere else names a local from some other function — the 2.1.241
  // misbind class (applies clean, calls a non-function at runtime).
  if (cancelSiblingMatch.index <= chainStartIdx || cancelSiblingMatch.index >= anchorIdx) {
    console.error(
      `ERROR: cancel_async_message handler at ${cancelSiblingMatch.index} is outside the ` +
        `control-request dispatch chain (${chainStartIdx}..${anchorIdx}) — its locals are not ` +
        'in scope at the injection point. Aborting.'
    )
    process.exit(1)
  }
  const queueInstance = cancelSiblingMatch[1]
  const removeFn = `${queueInstance}.dequeueAllMatching`
  console.log(`  Queue instance: ${queueInstance} (remove via ${removeFn})`)

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

  // ---------------------------------------------------------------------------
  // Inject the dequeue_message handler
  // ---------------------------------------------------------------------------
  console.log('\n--- Injecting dequeue_message handler ---')

  // Matching predicate: cli.js's own queue-text rule, INLINED. Earlier versions
  // captured the helper by name (Ha9/VV_; g1S in 2.1.241 — `typeof v==="string"
  // ?v:Gd(v,`\n`)`), but the helper lives in a different bundle module than the
  // dispatch scope, so a bare-name call is not guaranteed to resolve there. The
  // rule itself is three lines (docs/protocol-cc/04-system-subtypes.md §4.10:
  // string verbatim; else keep `text` blocks' text, joined with "\n"), so we
  // inline it — self-contained, scope-proof, and byte-compatible with
  // ClaudeUI's side (src/core/sdk/queued-command-text.ts).
  const predicate =
    `(_6)=>(typeof _6.value==="string"?_6.value:` +
    `Array.isArray(_6.value)?_6.value.filter((b6)=>b6&&b6.type==="text"&&typeof b6.text==="string")` +
    `.map((b6)=>b6.text).join("\\n"):"")===Y6`

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

  // Find the queued_command attachment handler.
  // SDK ≤0.2.87: else if(Z&&q8.attachment.type==="queued_command")yield{...isReplay:!0}
  // SDK ≥0.2.89: else if(Z&&q8.attachment.type==="queued_command"){let W6=q8.attachment;yield{...}}
  // 2.1.241:     the submitMessage else-if chain became a message-normalization
  //              switch — function*gGy(e,t,r,{replayUserMessages:n,includePartialMessages:o}):
  //                case"attachment":if(n&&e.attachment.type==="queued_command"){
  //                  yield{...seo(e.attachment,e),session_id:e.session_id};return}
  //                yield*WTn([e],e.session_id);return;
  //              where seo(att,msg) builds the isReplay user message. The message's
  //              own e.session_id is in scope, so no session-id generator extraction
  //              is needed; uuid uses globalThis.crypto.randomUUID (precedent:
  //              subagent-streaming).
  // 2.1.261:     the two sites COLLAPSED BACK INTO ONE. The headless (stdin
  //              stream-json) loop and the SDK-hosted transport now share one
  //              normalizer, `function*Au(e,t,o,{replayUserMessages:d,includePartialMessages:y})`,
  //              which lives in the same chunk as the control-request dispatch
  //              (chunk-gj501zgt.js, whose only exports are runHeadless & co.):
  //                case"attachment":if(d&&e.attachment.type==="queued_command")
  //                  {let P=smn(e.attachment,e);if(P)yield{...P,session_id:e.session_id};return}
  //              The builder is now NULLABLE (`smn` returns undefined for
  //              forwarded-intent commands), hence the `let P=…;if(P)yield` shape.
  // We replace it so it:
  //   1. Always yields a system notification (regardless of replay var)
  //   2. Only yields the user message replay when replay var is true
  //   3. (switch shape) leaves the non-queued_command fallthrough and the
  //      replay-off fallthrough (yield*WTn) byte-identical to unpatched.

  // Which chunk holds the headless loop ClaudeUI drives — the A2 site has to be
  // in it, or we are patching some other transport's normalizer (the 2.1.241
  // failure mode: applies clean, notification never fires on the wire).
  const chunkIndexA2 = buildChunkIndex(src)
  const dispatchMatch = anchorRe.exec(src)
  if (!dispatchMatch) {
    console.error('ERROR: Cannot re-locate the control-request fallback for the A2 chunk check.')
    process.exit(1)
  }
  const headlessChunk = chunkName(chunkIndexA2, dispatchMatch.index)

  // --- Shape 2.1.261 (current): single normalizer, nullable replay builder ---
  const qcRe261 = new RegExp(
    `case"attachment":if\\((${V})&&(${V})\\.attachment\\.type==="queued_command"\\)` +
      `\\{let (${V})=(${V})\\(\\2\\.attachment,\\2\\);if\\(\\3\\)yield\\{\\.\\.\\.\\3,` +
      `session_id:\\2\\.session_id\\};return\\}`
  )
  const match261 = qcRe261.exec(src)
  if (match261) {
    if (qcRe261.exec(src.slice(match261.index + 1))) {
      console.error('ERROR: queued_command normalizer matched more than once. Aborting.')
      process.exit(1)
    }
    const siteChunk = chunkName(chunkIndexA2, match261.index)
    if (siteChunk !== headlessChunk) {
      console.error(
        `ERROR: queued_command normalizer is in ${siteChunk}, not the headless chunk ` +
          `${headlessChunk} that serves the stdin stream-json loop. Aborting rather than ` +
          'patching a transport ClaudeUI does not drive.'
      )
      process.exit(1)
    }
    const [oldCode, replayVar, msgVar2, builtVar, replayBuilderFn] = match261
    console.log(
      `Found queued_command normalizer at char ${match261.index} in ${siteChunk}, ` +
        `replay var: ${replayVar}, message var: ${msgVar2}, ` +
        `replay builder: ${replayBuilderFn} -> ${builtVar}`
    )
    const att = `${msgVar2}.attachment`
    // Prepend the (unconditional) notification and leave the original branch
    // byte-identical behind it: the replay stays gated on the replay var, the
    // nullable-builder guard and the `return` keep their exact semantics, and
    // the replay-off fallthrough is untouched.
    //
    // The notification is deliberately NOT gated on the builder's own
    // suppression rule (`smn` drops forwarded-intent commands): ClaudeUI
    // correlates the notification against its own queue by text, so an
    // uncorrelated one is a no-op, while a missing one strands a queue card.
    const newCode =
      `case"attachment":${PATCH_A2_MARKER}` +
      `if(${att}.type==="queued_command")` +
      `yield{type:"system",subtype:"queued_command_consumed",` +
      `prompt:${att}.prompt,source_uuid:${att}.source_uuid,` +
      `session_id:${msgVar2}.session_id,uuid:globalThis.crypto.randomUUID()};` +
      oldCode.slice('case"attachment":'.length)
    src = src.slice(0, match261.index) + newCode + src.slice(match261.index + oldCode.length)
    console.log('Injected queued_command_consumed ahead of the normalizer branch')
  }

  // Try the switch shape next (2.1.241), then the two else-if shapes.
  const qcReSwitch = new RegExp(
    `case"attachment":if\\((${V})&&(${V})\\.attachment\\.type==="queued_command"\\)` +
      `\\{yield\\{\\.\\.\\.(${V})\\(\\2\\.attachment,\\2\\),session_id:\\2\\.session_id\\};return\\}`
  )
  const switchMatch = match261 ? null : qcReSwitch.exec(src)
  if (switchMatch) {
    if (qcReSwitch.exec(src.slice(switchMatch.index + 1))) {
      console.error('ERROR: queued_command switch handler matched more than once. Aborting.')
      process.exit(1)
    }
    const [oldCode, replayVar, msgVar2, replayBuilderFn] = switchMatch
    console.log(
      `Found queued_command switch handler at char ${switchMatch.index}, ` +
        `replay var: ${replayVar}, message var: ${msgVar2}, replay builder: ${replayBuilderFn}`
    )
    const att = `${msgVar2}.attachment`
    const newCode =
      `case"attachment":${PATCH_A2_MARKER}` +
      `if(${att}.type==="queued_command")` +
      `yield{type:"system",subtype:"queued_command_consumed",` +
      `prompt:${att}.prompt,source_uuid:${att}.source_uuid,` +
      `session_id:${msgVar2}.session_id,uuid:globalThis.crypto.randomUUID()};` +
      `if(${replayVar}&&${att}.type==="queued_command")` +
      `{yield{...${replayBuilderFn}(${att},${msgVar2}),session_id:${msgVar2}.session_id};return}`
    src = src.slice(0, switchMatch.index) + newCode + src.slice(switchMatch.index + oldCode.length)
    console.log('Replaced queued_command switch handler with consumed notification')

    // -- Site 2 (REQUIRED on 2.1.241): the stdin stream-json loop --------------
    // gGy above serves the SDK-hosted transport. The stdin loop that ClaudeUI
    // actually drives consumes mid-turn queued_command attachments here (the
    // true descendant of the old submitMessage else-if chain — note the yield
    // is now a BUILDER CALL, not an object literal, which is why every legacy
    // `yield{` pattern missed it):
    //   else if(C&&Sr.attachment.type==="queued_command")yield seo(Sr.attachment,Sr);
    // C = replayUserMessages, seo = the isReplay user-message builder. We make
    // the consumed notification unconditional and keep the replay gated on C.
    // session_id comes from the same generator the surrounding emitters use
    // (`session_id:Vt()` in the adjacent cases), extracted from forward context.
    const stdinSiteRe = new RegExp(
      `else if\\((${V})&&(${V})\\.attachment\\.type==="queued_command"\\)` +
        `yield (${V})\\(\\2\\.attachment,\\2\\);`
    )
    const stdinMatch = stdinSiteRe.exec(src)
    if (!stdinMatch) {
      console.error(
        'ERROR: Cannot find the stdin-loop queued_command handler (yield-builder shape).'
      )
      process.exit(1)
    }
    if (stdinSiteRe.exec(src.slice(stdinMatch.index + 1))) {
      console.error('ERROR: stdin-loop queued_command handler matched more than once. Aborting.')
      process.exit(1)
    }
    const [stdinOld, stdinReplayVar, stdinMsgVar, stdinBuilderFn] = stdinMatch
    const stdinFwd = src.slice(stdinMatch.index, stdinMatch.index + 1000)
    const sessGenMatch = new RegExp(`session_id:(${V})\\(\\)`).exec(stdinFwd)
    if (!sessGenMatch) {
      console.error('ERROR: Cannot extract session-id generator near the stdin-loop handler.')
      process.exit(1)
    }
    const stdinSessFn = sessGenMatch[1]
    console.log(
      `Found stdin-loop queued_command handler at char ${stdinMatch.index}, ` +
        `replay var: ${stdinReplayVar}, message var: ${stdinMsgVar}, ` +
        `builder: ${stdinBuilderFn}, session-id gen: ${stdinSessFn}`
    )
    const stdinAtt = `${stdinMsgVar}.attachment`
    const stdinNew =
      `else if(${stdinAtt}.type==="queued_command"){` +
      `yield{type:"system",subtype:"queued_command_consumed",` +
      `prompt:${stdinAtt}.prompt,source_uuid:${stdinAtt}.source_uuid,` +
      `session_id:${stdinSessFn}(),uuid:globalThis.crypto.randomUUID()};` +
      `if(${stdinReplayVar})yield ${stdinBuilderFn}(${stdinAtt},${stdinMsgVar});}`
    src = src.slice(0, stdinMatch.index) + stdinNew + src.slice(stdinMatch.index + stdinOld.length)
    console.log('Replaced stdin-loop queued_command handler with consumed notification')
  }

  // Legacy else-if shapes (pre-2.1.241) — only when neither newer shape matched.
  if (!match261 && !switchMatch) {
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
  } // end legacy else-if shapes
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

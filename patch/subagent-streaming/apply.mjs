/**
 * Patch: subagent-streaming
 *
 * Makes sub-agent messages (thinking, text, tool_use, tool_result) and
 * stream events (thinking_delta, text_delta) visible in the SDK stream.
 * Also patches the .output file writer for background agents to include
 * thinking blocks.
 *
 * See README.md for full analysis.
 *
 * Usage: node patch/subagent-streaming/apply.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '../..')
const cliPath = resolve(projectRoot, 'node_modules/@anthropic-ai/claude-agent-sdk/cli.js')

// Minified variable names can contain $ — use [\\w$] instead of \\w
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

const versionMatch = src.match(/Version:\s*([\d.]+)/)
if (versionMatch) {
  console.log(`CLI version: ${versionMatch[1]}`)
}

let patchCount = 0

// ===========================================================================
// Patch F: Yield stream_event from cR without collecting it
//
// cR() is the sub-agent query loop generator. It iterates fR() (which
// yields stream_event, assistant, user, etc.) but filters what it yields
// via RVY(). stream_event is NOT in RVY's whitelist.
//
// We can't just add stream_event to RVY because the yield line also
// pushes to the collection array x[] and records to transcript via E51.
// stream_event messages lack .message/.uuid properties that those
// operations expect.
//
// Instead, we inject a check BEFORE the RVY gate to yield stream_events
// directly without collecting or recording them:
//
// Before:
//   if(RVY($1))x.push($1),await E51(...),...,yield $1
//
// After:
//   if($1.type==="stream_event"){yield $1}else
//   if(RVY($1))x.push($1),await E51(...),...,yield $1
// ===========================================================================

console.log('\n--- Patch F: cR yield — stream_event bypass before RVY ---')

const patchFMarker = '/*PATCHED:subagent-F*/'

if (src.includes(patchFMarker)) {
  console.log('Already applied. Skipping.')
} else {
  // Find RVY function by its unique type-check pattern
  const rvyRe = new RegExp(
    `function (${V})\\(${V}\\)\\{` +
    `return ${V}\\.type==="assistant"\\|\\|` +
    `${V}\\.type==="user"\\|\\|` +
    `${V}\\.type==="progress"\\|\\|` +
    `${V}\\.type==="system"&&"subtype"in ${V}&&${V}\\.subtype==="compact_boundary"` +
    `\\}`
  )
  const rvyMatch = src.match(rvyRe)
  if (!rvyMatch) {
    console.error('ERROR: Cannot locate RVY function.')
    process.exit(1)
  }
  const rvyName = rvyMatch[1]
  console.log(`Found RVY function: ${rvyName}()`)

  // Find the RVY call site. Two known patterns:
  //
  // v2.1.45 (old): if(RVY(MSG))ARR.push(MSG),
  // v2.1.47 (new): if(RVY(MSG))await TRANSCRIPT([MSG],...
  //
  // We try the new pattern first, then fall back to the old one.
  const newCallRe = new RegExp(
    `if\\(${rvyName}\\((${V})\\)\\)await `
  )
  const oldCallRe = new RegExp(
    `if\\(${rvyName}\\((${V})\\)\\)(${V})\\.push\\(\\1\\),`
  )
  const callMatch = src.match(newCallRe) || src.match(oldCallRe)
  if (!callMatch) {
    console.error('ERROR: Cannot locate RVY call site in cR.')
    process.exit(1)
  }

  const oldStr = callMatch[0]
  const msgVar = callMatch[1]
  const idx = src.indexOf(oldStr)

  // Verify it's inside the sub-agent query generator (cR in v2.1.39, WR in v2.1.47)
  const before = src.slice(Math.max(0, idx - 5000), idx)
  if (!/async function\*[\w$]+\(/.test(before)) {
    console.error('ERROR: RVY call site is not inside an async generator. Aborting.')
    process.exit(1)
  }

  if (src.indexOf(oldStr, idx + 1) !== -1) {
    console.error('ERROR: Multiple matches for Patch F. Aborting.')
    process.exit(1)
  }

  // Inject stream_event bypass before the RVY gate.
  // The original "if(RVY(MSG))..." is preserved unchanged after our "else".
  const newStr =
    `${patchFMarker}if(${msgVar}.type==="stream_event"){yield ${msgVar}}else ` +
    oldStr

  src = src.slice(0, idx) + newStr + src.slice(idx + oldStr.length)
  patchCount++
  console.log(`Applied at char ${idx}. msg=${msgVar}`)
}

// ===========================================================================
// Patch A: Remove content-block filter from sub-agent progress callback
//
// Before:
//   for(let $1 of _1)for(let G1 of $1.message.content){
//     if(G1.type!=="tool_use"&&G1.type!=="tool_result")continue;
//     if(j)j({toolUseID:..., data:{message:$1,...}})
//   }
//
// After:
//   for(let $1 of _1){
//     if(j)j({toolUseID:..., data:{message:$1,...}})
//   }
// ===========================================================================

console.log('\n--- Patch A: Sub-agent progress callback filter ---')

const patchAMarker = '/*PATCHED:subagent-A*/'

if (src.includes(patchAMarker)) {
  console.log('Already applied. Skipping.')
} else {
  const filterRe = new RegExp(
    `for\\(let (${V}) of (${V})\\)` +
    `for\\(let (${V}) of \\1\\.message\\.content\\)\\{` +
    `if\\(\\3\\.type!=="tool_use"&&\\3\\.type!=="tool_result"\\)continue;`
  )
  const m = src.match(filterRe)
  if (!m) {
    console.error('ERROR: Cannot locate sub-agent progress callback filter.')
    process.exit(1)
  }

  const oldStr = m[0]
  const newStr = `${patchAMarker}for(let ${m[1]} of ${m[2]}){`
  const idx = src.indexOf(oldStr)

  if (src.indexOf(oldStr, idx + 1) !== -1) {
    console.error('ERROR: Multiple matches for Patch A. Aborting.')
    process.exit(1)
  }

  src = src.slice(0, idx) + newStr + src.slice(idx + oldStr.length)
  patchCount++
  console.log(`Applied at char ${idx}. Vars: msg=${m[1]}, msgs=${m[2]}, inner=${m[3]}`)
}

// ===========================================================================
// Patch B: Forward sub-agent stream_events through progress callback
//
// In the sync Task tool loop, after unwrapping the iterator result, the code
// pushes to the collection array and filters by message type. Stream events
// must be intercepted BEFORE the push (they lack .message/.uuid and break
// downstream processing in UEA/_kA).
//
// v2.1.39 had a single combined if:
//   if(O1.push(Y1),Y1.type!=="assistant"&&Y1.type!=="user")continue;
//
// v2.1.41 splits this into two ifs:
//   if(X1.push(w1),w1.type==="progress"&&w1.data.type==="bash_progress"&&D)D({...});
//   if(w1.type!=="assistant"&&w1.type!=="user")continue;
//
// We match the "if(ARR.push(MSG)," pattern that starts the sync loop body,
// and inject a stream_event check before it.
//
// After:
//   if(w1.type==="stream_event"){
//     if(D)D({toolUseID:`agent_${j.message.id}`,
//       data:{type:"agent_stream_event",event:w1.event,agentId:r}});continue}
//   if(X1.push(w1),w1.type==="progress"&&...
// ===========================================================================

console.log('\n--- Patch B: Sub-agent stream_event forwarding ---')

const patchBMarker = '/*PATCHED:subagent-B*/'

if (src.includes(patchBMarker)) {
  console.log('Already applied. Skipping.')
} else {
  // Find the unique sync loop pattern: if(ARR.push(MSG),MSG.type==="progress"&&...bash_progress...
  // v2.1.47: ...&&MSG.data.type==="bash_progress"
  // v2.1.49: ...&&(MSG.data.type==="bash_progress"||MSG.data.type==="powershell_progress")
  // This pattern is unique to the Task tool's sync for-await loop body.
  const pushRe = new RegExp(
    `if\\((${V})\\.push\\((${V})\\),\\2\\.type==="progress"&&` +
    `(?:\\(\\2\\.data\\.type==="bash_progress"\\|\\|\\2\\.data\\.type==="powershell_progress"\\)|` +
    `\\2\\.data\\.type==="bash_progress")`
  )
  const m = src.match(pushRe)
  if (!m) {
    console.error('ERROR: Cannot locate sub-agent sync loop push+bash_progress pattern.')
    process.exit(1)
  }

  const [matchStr, arrVar, msgVar] = m
  const idx = src.indexOf(matchStr)
  console.log(`Found sync loop body at char ${idx} (arr=${arrVar}, msg=${msgVar})`)

  // Extract callback var (D), parent msg var (j), agent ID var (r) from nearby code
  const nearby = src.slice(idx, idx + 1200)
  const cbRe = new RegExp(
    `if\\((${V})\\)\\1\\(\\{toolUseID:\`agent_\\$\\{(${V})\\.message\\.id\\}\`.*?agentId:(${V})\\}`
  )
  const cbm = nearby.match(cbRe)
  if (!cbm) {
    console.error('ERROR: Cannot extract callback var names from nearby code.')
    process.exit(1)
  }

  const [, cbVar, parentVar, agentVar] = cbm
  console.log(`  Callback=${cbVar}, ParentMsg=${parentVar}, AgentId=${agentVar}`)

  if (src.indexOf(matchStr, idx + 1) !== -1) {
    console.error('ERROR: Multiple matches for Patch B. Aborting.')
    process.exit(1)
  }

  // Inject stream_event check BEFORE the if(ARR.push(...)) statement.
  // The full "if(" is part of the match, so we prepend our check.
  const injection =
    `${patchBMarker}if(${msgVar}.type==="stream_event"){` +
    `if(${cbVar})${cbVar}({toolUseID:\`agent_\${${parentVar}.message.id}\`,` +
    `data:{type:"agent_stream_event",event:${msgVar}.event,agentId:${agentVar}}});continue}`

  // Insert before the matched "if(ARR.push(..." — don't remove anything
  src = src.slice(0, idx) + injection + src.slice(idx)
  patchCount++
  console.log('Applied. Stream events intercepted before push — never enter collection array.')
}

// ===========================================================================
// Patch C: Add ZhA handler for agent_stream_event
//
// Injects before the bash_progress handler:
//   else if(A.data.type==="agent_stream_event"){
//     yield{type:"stream_event",event:A.data.event,
//       parent_tool_use_id:A.parentToolUseID,session_id:U6(),uuid:A.uuid}
//   }
// ===========================================================================

console.log('\n--- Patch C: ZhA agent_stream_event handler ---')

const patchCMarker = '/*PATCHED:subagent-C*/'

if (src.includes(patchCMarker)) {
  console.log('Already applied. Skipping.')
} else {
  // v2.1.47: else if(A.data.type==="bash_progress"){
  // v2.1.49: else if(A.data.type==="bash_progress"||A.data.type==="powershell_progress"){
  const anchorNew = 'else if(A.data.type==="bash_progress"||A.data.type==="powershell_progress"){'
  const anchorOld = 'else if(A.data.type==="bash_progress"){'
  const anchor = src.includes(anchorNew) ? anchorNew : anchorOld
  const anchorIdx = src.indexOf(anchor)
  if (anchorIdx === -1) {
    console.error('ERROR: Cannot locate bash_progress handler in ZhA.')
    process.exit(1)
  }

  // Extract session_id function name from nearby ZhA code
  const ctx = src.slice(anchorIdx - 800, anchorIdx)
  if (!ctx.includes('agent_progress')) {
    console.error('ERROR: bash_progress found but not in expected ZhA context.')
    process.exit(1)
  }

  const sessFnMatch = ctx.match(/session_id:([\w$]+)\(\)/)
  if (!sessFnMatch) {
    console.error('ERROR: Cannot extract session ID function from ZhA.')
    process.exit(1)
  }
  const sessFn = sessFnMatch[1]

  const injection =
    `${patchCMarker}else if(A.data.type==="agent_stream_event"){` +
    `yield{type:"stream_event",event:A.data.event,` +
    `parent_tool_use_id:A.parentToolUseID,session_id:${sessFn}(),uuid:A.uuid}` +
    `}`

  src = src.slice(0, anchorIdx) + injection + src.slice(anchorIdx)
  patchCount++
  console.log(`Applied. Session ID function: ${sessFn}()`)
}

// ===========================================================================
// Patch D: Include thinking in .output file for background agents
//
// Patches FM6 and the background polling map to include thinking blocks.
// ===========================================================================

console.log('\n--- Patch D: .output file thinking inclusion ---')

const patchDMarker = '/*PATCHED:subagent-D*/'

if (src.includes(patchDMarker)) {
  console.log('Already applied. Skipping.')
} else {
  // --- Text extraction function (FM6/sM6 equivalent) ---
  // Find by structure: function NAME(A,q="Execution completed"){let K=GN(A);if(!K)return q;return K.message.content.filter(...)
  const textFnRe = new RegExp(
    `function (${V})\\((${V}),(${V})="Execution completed"\\)\\{` +
    `let (${V})=(${V})\\(\\2\\);if\\(!\\4\\)return \\3;` +
    `return \\4\\.message\\.content\\.filter`
  )
  const textFnMatch = src.match(textFnRe)
  if (!textFnMatch) {
    console.error('ERROR: Cannot locate text extraction function (FM6/sM6 equivalent).')
    process.exit(1)
  }

  const textFnName = textFnMatch[1]
  const textFnIdx = src.indexOf(textFnMatch[0])
  console.log(`Found text extraction function: ${textFnName}() at char ${textFnIdx}`)

  const fm6Area = src.slice(textFnIdx, textFnIdx + 300)
  const fm6FilterRe = new RegExp(`\\.filter\\(\\((${V})\\)=>\\1\\.type==="text"\\)`)
  const fm6m = fm6Area.match(fm6FilterRe)
  if (!fm6m) {
    console.error('ERROR: Cannot find text filter in text extraction function.')
    process.exit(1)
  }

  const fm6Var = fm6m[1]

  // Patch filter: type==="text" → type==="text"||VAR.type==="thinking"
  const oldFilter = `${fm6Var}.type==="text")`
  const newFilter = `${fm6Var}.type==="text"||${fm6Var}.type==="thinking")`
  const filterAbsIdx = src.indexOf(oldFilter, textFnIdx)
  if (filterAbsIdx === -1 || filterAbsIdx > textFnIdx + 300) {
    console.error('ERROR: Cannot find filter at expected location.')
    process.exit(1)
  }

  src = src.slice(0, filterAbsIdx) + patchDMarker + newFilter + src.slice(filterAbsIdx + oldFilter.length)

  // Patch map: ("text"in V)?V.text:"" → ("text"in V)?V.text:("thinking"in V)?V.thinking:""
  const oldMap = `("text"in ${fm6Var})?${fm6Var}.text:""`
  const newMap = `("text"in ${fm6Var})?${fm6Var}.text:("thinking"in ${fm6Var})?${fm6Var}.thinking:""`
  const mapIdx = src.indexOf(oldMap, filterAbsIdx)
  if (mapIdx !== -1 && mapIdx < filterAbsIdx + 200) {
    src = src.slice(0, mapIdx) + newMap + src.slice(mapIdx + oldMap.length)
    console.log('Patched FM6 (filter + map).')
  } else {
    console.log('Patched FM6 (filter only).')
  }

  // --- Background agent polling map ---
  const bgMapRe = new RegExp(
    `\\.map\\(\\((${V})\\)=>\\{if\\(\\1\\.type==="assistant"\\)` +
    `return \\1\\.message\\.content\\.filter\\(\\((${V})\\)=>\\2\\.type==="text"\\)` +
    `\\.map\\(\\(\\2\\)=>\\("text"in \\2\\)\\?\\2\\.text:""\\)` +
    `\\.join\\(\`\\n\`\\);return (${V})\\(\\1\\)\\}`
  )
  const bgm = src.match(bgMapRe)

  if (bgm) {
    const oldBg = bgm[0]
    const bgP = bgm[2]
    const newBg = oldBg
      .replace(`${bgP}.type==="text"`, `${bgP}.type==="text"||${bgP}.type==="thinking"`)
      .replace(`("text"in ${bgP})?${bgP}.text:""`, `("text"in ${bgP})?${bgP}.text:("thinking"in ${bgP})?${bgP}.thinking:""`)
    src = src.replace(oldBg, newBg)
    console.log('Patched background agent output writer.')
  } else {
    console.log('WARNING: Background agent output writer not found.')
  }

  patchCount++
}

// ===========================================================================
// Patch E: Direct stdout streaming for background agents
//
// Background (async) Task paths run detached — by the time their for-await
// loop executes, the tool executor has closed its output queue and the
// progress callback j() is dead. Instead, we write directly to stdout as
// newline-delimited JSON, formatting messages the same way mI8/ihA/ZhA would.
//
// Before (v2.1.41):
//   for await(let W1 of jy({...}))f1.push(W1),QM1(k1,W1,e,J.options.tools),XW8(AGENTID,...);
//
// After:
//   for await(let W1 of jy({...})){
//     if(W1.type==="stream_event"){...forward directly...}
//     else{f1.push(W1),QM1(k1,W1,e,J.options.tools),XW8(AGENTID,...);
//       ...forward assistant/user via stdout...
//     }
//   }
// ===========================================================================

console.log('\n--- Patch E: Background agent direct stdout streaming ---')

const patchEMarker = '/*PATCHED:subagent-E*/'

if (src.includes(patchEMarker)) {
  console.log('Already applied. Skipping.')
} else {
  // Find the session ID function from mI8/ihA/ZhA yields
  const sessFnRe = /session_id:([\w$]+)\(\).*?parent_tool_use_id/
  const sessFnMatch = src.match(sessFnRe)
  if (!sessFnMatch) {
    console.error('ERROR: Cannot locate session ID function.')
    process.exit(1)
  }
  const sessFn = sessFnMatch[1]
  console.log(`Session ID function: ${sessFn}()`)

  // Find the UUID generator from the progress wrapping function
  // Pattern: {type:"progress",data:...,uuid:FUNC(),timestamp:new Date
  const uuidFnRe = /\{type:"progress",data:[\w$]+,toolUseID:[\w$]+,parentToolUseID:[\w$]+,uuid:([\w$]+)\(\),timestamp:new Date/
  const uuidFnMatch = src.match(uuidFnRe)
  if (!uuidFnMatch) {
    console.error('ERROR: Cannot locate UUID generator function.')
    process.exit(1)
  }
  const uuidFn = uuidFnMatch[1]
  console.log(`UUID function: ${uuidFn}()`)

  // Find async for-await+jy loops by matching the body pattern after )).
  // Pattern: ))ARR.push(MSG),STATS_FN(STATS,MSG,TOOLS,J.options.tools),STATE_FN(AGENTID,...);
  // v2.1.41: ))f1.push(W1),QM1(k1,W1,e,J.options.tools),XW8(t.agentId,Nm1(k1),J.setAppState);
  // v2.1.42: ))J1.push(q6),tM1(M1,q6,y1,J.options.tools),kWA(S1,pm1(M1),J.setAppState);
  // v2.1.59: ))if(T6.push(r),_f6(s,r,o,j.options.tools),GI8(...),r.type==="assistant"&&...)Pa7(...);
  //          The `if(` wrapper is optional — matches both old and new patterns.
  const asyncBodyRe = new RegExp(
    `\\)\\)(?:if\\()?(${V})\\.push\\((${V})\\),` +  // ))ARR.push(MSG), or ))if(ARR.push(MSG),
    `(${V})\\((${V}),\\2,` +                         // STATS(STATS,MSG,
    `(${V}),(${V})\\.options\\.tools\\),` +           // TOOLS,j.options.tools),
    `[^;]+;`                                          // ...rest until ;
  , 'g')

  let asyncMatch
  let asyncPatchCount = 0

  const matches = []
  while ((asyncMatch = asyncBodyRe.exec(src)) !== null) {
    // v2.1.42: the initial async path spreads isAsync from a variable via ...n,
    // and it can be up to ~800 chars before the loop body. Use a 1000-char window.
    const before = src.slice(Math.max(0, asyncMatch.index - 1000), asyncMatch.index)
    if (!before.includes('for await')) continue
    matches.push({
      fullMatch: asyncMatch[0],
      msgVar: asyncMatch[2],
      index: asyncMatch.index
    })
  }

  if (matches.length === 0) {
    console.error('ERROR: Cannot locate async for-await loops.')
    console.error('The background agent loop structure may have changed.')
    console.error('Search for "for await" loops with .push() + stats + state-update patterns.')
    process.exit(1)
  }

  console.log(`Found ${matches.length} async for-await loop(s) to patch.`)

  // Extract parent message var and description var from the Task tool's call() signature.
  // Pattern: async call({...description:DESC,...},CONTEXT,CANUSE,PARENT_MSG,CALLBACK){
  // DESC is the minified name for the "description" input field.
  // PARENT_MSG is the 4th positional param (the parent assistant message).
  const callSigRe = new RegExp(
    `async call\\(\\{[^}]*description:(${V})[^}]*\\},` +  // {prompt:A,...,description:K,...},
    `(${V}),(${V}),(${V}),(${V})\\)\\{`                    // J,X,j,D){
  )
  const callSigMatch = src.match(callSigRe)
  if (!callSigMatch) {
    console.error('ERROR: Cannot locate Task tool call() signature.')
    console.error('Need to extract description and parent message variable names.')
    process.exit(1)
  }
  const descVar = callSigMatch[1]       // K in current version — "description" input
  const parentMsgVar = callSigMatch[4]  // j in current version — parent assistant message
  console.log(`Task call() signature: description=${descVar}, parentMsg=${parentMsgVar}`)

  // Apply in reverse order so indices stay valid
  for (let i = matches.length - 1; i >= 0; i--) {
    const { fullMatch, msgVar, index } = matches[i]

    const body = fullMatch.slice(2) // strip leading "))"

    // Write line-delimited JSON to stdout (the SDK reads newline-delimited
    // JSON, NOT binary-framed). parentMsgVar is the full assistant message
    // from the parent (may contain text/thinking blocks before the tool_use).
    // Find the matching tool_use block by description (descVar) for parent_tool_use_id.
    //
    // stream_events are forwarded directly without pushing to the collection
    // array (they lack .message/.uuid and break downstream processing).
    // For assistant/user messages, the original push+stats+state runs first.
    const ptuLookup =
      `let _ptu=null;for(let _b of ${parentMsgVar}.message.content)` +
      `{if(_b.type==="tool_use"&&_b.input&&_b.input.description===${descVar}){_ptu=_b.id;break}}`

    const replacement =
      `){${patchEMarker}` +
      // stream_event: forward directly, skip push to collection array
      `if(${msgVar}.type==="stream_event"){` +
        `${ptuLookup}` +
        `process.stdout.write(JSON.stringify({type:"stream_event",event:${msgVar}.event,` +
        `parent_tool_use_id:_ptu,session_id:${sessFn}(),uuid:${uuidFn}()})+"\\n")` +
      `}else{` +
      // non-stream_event: original body (push, stats, state update)
      `${body}` +
      `{${ptuLookup}` +
      `if(${msgVar}.type==="assistant")` +
        `process.stdout.write(JSON.stringify({type:"assistant",message:${msgVar}.message,` +
        `parent_tool_use_id:_ptu,session_id:${sessFn}(),uuid:${uuidFn}()})+"\\n");` +
      `else if(${msgVar}.type==="user")` +
        `process.stdout.write(JSON.stringify({type:"user",message:${msgVar}.message,` +
        `parent_tool_use_id:_ptu,session_id:${sessFn}(),uuid:${uuidFn}()})+"\\n");` +
      `}}}`

    src = src.slice(0, index + 1) + replacement + src.slice(index + fullMatch.length)
    asyncPatchCount++
    console.log(`  Patched loop ${i + 1} at char ${index} (msg=${msgVar})`)
  }

  patchCount++
  console.log(`Applied to ${asyncPatchCount} loop(s).`)
}

// ===========================================================================
// Write and verify
// ===========================================================================

if (patchCount === 0) {
  console.log('\nAll patches already applied. Nothing to do.')
  process.exit(0)
}

writeFileSync(cliPath, src)
console.log(`\nWrote patched file to ${cliPath}`)

const verify = readFileSync(cliPath, 'utf-8')
const markers = [
  ['F', patchFMarker, 'cR yield filter (RVY) — allow stream_event'],
  ['A', patchAMarker, 'Content-block filter removal'],
  ['B', patchBMarker, 'Stream_event forwarding (before O1.push)'],
  ['C', patchCMarker, 'ZhA agent_stream_event handler'],
  ['D', patchDMarker, '.output file thinking inclusion'],
  ['E', patchEMarker, 'Background agent stdout streaming']
]

let allGood = true
for (const [label, marker, desc] of markers) {
  const ok = verify.includes(marker)
  console.log(`  ${ok ? 'OK' : 'MISSING'} Patch ${label}: ${desc}`)
  if (!ok) allGood = false
}

if (!allGood) {
  console.error('\nVerification FAILED.')
  process.exit(1)
}

console.log('\nAll patches verified.')
console.log('')
console.log('Summary:')
console.log('  F — cR yield: stream_events bypass RVY and yield directly,')
console.log('      without being collected into results array or transcript.')
console.log('  A — All sub-agent content blocks (text, thinking, tool_use, tool_result)')
console.log('      flow through progress callback to SDK stream.')
console.log('  B — Sub-agent stream_events intercepted BEFORE O1.push (never enter')
console.log('      collection array), forwarded via agent_stream_event progress type.')
console.log('  C — ZhA converts agent_stream_event to SDK stream_event with')
console.log('      parent_tool_use_id for proper attribution.')
console.log('  D — .output files include thinking blocks alongside text.')
console.log('  E — Background (async) agents forward messages through progress')
console.log('      callback for real-time streaming in SDK consumers.')
console.log('')
console.log('NOT changed:')
console.log('  UEA (task result) still returns text-only to parent model.')

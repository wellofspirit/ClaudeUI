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
const cliPath = resolve(projectRoot, 'vendor/claude-cli/cli.js')

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
  console.error('Did you run: node scripts/extract-cli.mjs ?')
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

  // Find the RVY call site. Known patterns:
  //
  // v2.1.45 (old): if(RVY(MSG))ARR.push(MSG),
  // v2.1.47:       if(RVY(MSG))await TRANSCRIPT([MSG],...
  // v2.1.87:       if(RVY(MSG)){if(await TRANSCRIPT([MSG],...
  //
  // We try patterns newest first.
  const bracedCallRe = new RegExp(
    `if\\(${rvyName}\\((${V})\\)\\)\\{`
  )
  const awaitCallRe = new RegExp(
    `if\\(${rvyName}\\((${V})\\)\\)await `
  )
  const oldCallRe = new RegExp(
    `if\\(${rvyName}\\((${V})\\)\\)(${V})\\.push\\(\\1\\),`
  )
  const callMatch = src.match(bracedCallRe) || src.match(awaitCallRe) || src.match(oldCallRe)
  if (!callMatch) {
    console.error('ERROR: Cannot locate RVY call site in cR.')
    process.exit(1)
  }

  const oldStr = callMatch[0]
  const msgVar = callMatch[1]
  const idx = src.indexOf(oldStr)

  // Verify it's inside the sub-agent query generator (cR in v2.1.39, WR in v2.1.47)
  const before = src.slice(Math.max(0, idx - 10000), idx)
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
// v2.1.118 and earlier (nested for-loop, no forwardSubagentText option):
//   for(let MSG of MSGS)for(let BLK of MSG.message.content){
//     if(BLK.type!=="tool_use"&&BLK.type!=="tool_result")continue;
//     if(j)j({toolUseID:..., data:{message:MSG,...}})
//   }
//
// v2.1.119+ (upstream introduced ZX([msg]) flattener + forwardSubagentText
// option that, when true, forwards every content block):
//   let xH=ZX([LH]),FH=w.options.forwardSubagentText;
//   for(let H_ of xH){
//     if(!f)continue;
//     let iH=H_.message.content[0];
//     if(!FH&&iH.type!=="tool_use"&&iH.type!=="tool_result")continue;
//     f({toolUseID:`agent_${j.message.id}`,data:{message:H_,type:"agent_progress",...}})
//   }
//
// Goal in both shapes: forward every content block (text, thinking, tool_use,
// tool_result) regardless of upstream gating. Achieved by collapsing the inner
// for-loop (old) or by dropping the `if(...)continue;` guard (new). Once the
// guard is gone, ZX-split messages flow unconditionally.
// ===========================================================================

console.log('\n--- Patch A: Sub-agent progress callback filter ---')

const patchAMarker = '/*PATCHED:subagent-A*/'

if (src.includes(patchAMarker)) {
  console.log('Already applied. Skipping.')
} else {
  // v2.1.119+ shape: single content[0] check gated by forwardSubagentText flag.
  const newFilterRe = new RegExp(
    `let (${V})=(${V})\\.message\\.content\\[0\\];` +
    `if\\(!(${V})&&\\1\\.type!=="tool_use"&&\\1\\.type!=="tool_result"\\)continue;`
  )
  // Legacy shape: nested for-loops over message.content.
  const oldFilterRe = new RegExp(
    `for\\(let (${V}) of (${V})\\)` +
    `for\\(let (${V}) of \\1\\.message\\.content\\)\\{` +
    `if\\(\\3\\.type!=="tool_use"&&\\3\\.type!=="tool_result"\\)continue;`
  )

  const newM = src.match(newFilterRe)
  const oldM = src.match(oldFilterRe)

  if (newM) {
    const oldStr = newM[0]
    const idx = src.indexOf(oldStr)
    if (src.indexOf(oldStr, idx + 1) !== -1) {
      console.error('ERROR: Multiple matches for Patch A (v119 shape). Aborting.')
      process.exit(1)
    }
    // Keep the `let iH=H_.message.content[0];` declaration (harmless, no
    // downstream reads), just drop the gating `if(...)continue;`.
    const newStr = `${patchAMarker}let ${newM[1]}=${newM[2]}.message.content[0];`
    src = src.slice(0, idx) + newStr + src.slice(idx + oldStr.length)
    patchCount++
    console.log(`Applied (v119 shape) at char ${idx}. Vars: blk=${newM[1]}, msg=${newM[2]}, fwdFlag=${newM[3]}`)
  } else if (oldM) {
    const oldStr = oldM[0]
    const newStr = `${patchAMarker}for(let ${oldM[1]} of ${oldM[2]}){`
    const idx = src.indexOf(oldStr)
    if (src.indexOf(oldStr, idx + 1) !== -1) {
      console.error('ERROR: Multiple matches for Patch A (legacy shape). Aborting.')
      process.exit(1)
    }
    src = src.slice(0, idx) + newStr + src.slice(idx + oldStr.length)
    patchCount++
    console.log(`Applied (legacy shape) at char ${idx}. Vars: msg=${oldM[1]}, msgs=${oldM[2]}, inner=${oldM[3]}`)
  } else {
    console.error('ERROR: Cannot locate sub-agent progress callback filter (tried v119 + legacy shapes).')
    process.exit(1)
  }
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
  // Find the unique sync loop pattern.
  //
  // v2.1.47–v2.1.63: push and bash_progress in the same if:
  //   if(ARR.push(MSG),MSG.type==="progress"&&(MSG.data.type==="bash_progress"||...)
  //
  // v2.1.71–v2.1.81: push+stats in one if, bash_progress check is a separate if:
  //   =VAL.value;if(ARR.push(MSG),STATS(VARS,MSG,TOOLS,j.options.tools),...)
  //
  // v2.1.87+: push+stats+bool in one if, bash_progress is a separate if:
  //   =VAL.value;if(ARR.push(MSG),STATS(STATS,MSG,TOOLS,H.options.tools),BOOL){...}
  //   if(MSG.type==="progress"&&(bash_progress||...))
  //
  // Try patterns newest first.
  const v87PushRe = new RegExp(
    `=(${V})\\.value;if\\((${V})\\.push\\((${V})\\),` +
    `(${V})\\((${V}),\\3,(${V}),(${V})\\.options\\.tools\\),` +
    `(${V})\\)`
  )
  const v71PushRe = new RegExp(
    `=(${V})\\.value;if\\((${V})\\.push\\((${V})\\),` +
    `(${V})\\(${V},\\3,${V},${V}\\.options\\.tools\\)`
  )
  const oldPushRe = new RegExp(
    `if\\((${V})\\.push\\((${V})\\),\\2\\.type==="progress"&&` +
    `(?:\\(\\2\\.data\\.type==="bash_progress"\\|\\|\\2\\.data\\.type==="powershell_progress"\\)|` +
    `\\2\\.data\\.type==="bash_progress")`
  )
  let m = src.match(v87PushRe)
  let matchStr, msgVar, idx
  if (m) {
    // v2.1.87: matchStr starts at "if(" — skip "=VAL.value;"
    const fullMatch = m[0]
    const ifStart = fullMatch.indexOf('if(')
    matchStr = fullMatch.slice(ifStart)
    msgVar = m[3]
    idx = src.indexOf(fullMatch) + ifStart
    console.log(`Found sync loop body (v87 pattern) at char ${idx} (arr=${m[2]}, msg=${msgVar})`)
  } else if ((m = src.match(v71PushRe))) {
    const fullMatch = m[0]
    const ifStart = fullMatch.indexOf('if(')
    matchStr = fullMatch.slice(ifStart)
    msgVar = m[3]
    idx = src.indexOf(fullMatch) + ifStart
    console.log(`Found sync loop body (v71 pattern) at char ${idx} (arr=${m[2]}, msg=${msgVar})`)
  } else if ((m = src.match(oldPushRe))) {
    matchStr = m[0]
    msgVar = m[2]
    idx = src.indexOf(matchStr)
    console.log(`Found sync loop body (old pattern) at char ${idx} (arr=${m[1]}, msg=${msgVar})`)
  } else {
    console.error('ERROR: Cannot locate sub-agent sync loop push+bash_progress pattern.')
    process.exit(1)
  }

  // Extract callback var (D), parent msg var (j), agent ID var (r) from nearby code.
  // v2.1.118 and earlier: gated `if(D)D({toolUseID:`agent_${j.message.id}`...agentId:r}`.
  // v2.1.119+: upstream replaced the per-call gate with `if(!f)continue;` then an
  //   unconditional `f({toolUseID:`agent_${j.message.id}`...agentId:DH})`.
  const nearby = src.slice(idx, idx + 1200)
  const cbReGated = new RegExp(
    `if\\((${V})\\)\\1\\(\\{toolUseID:\`agent_\\$\\{(${V})\\.message\\.id\\}\`.*?agentId:(${V})\\}`
  )
  const cbReUnconditional = new RegExp(
    `(${V})\\(\\{toolUseID:\`agent_\\$\\{(${V})\\.message\\.id\\}\`.*?agentId:(${V})\\}`
  )
  const cbm = nearby.match(cbReGated) || nearby.match(cbReUnconditional)
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
  // The bash_progress handler anchor uses a variable name that changes between
  // versions (A in v2.1.47, q in v2.1.87). Use regex to find it dynamically.
  //
  // v2.1.47: else if(A.data.type==="bash_progress"){
  // v2.1.49: else if(A.data.type==="bash_progress"||A.data.type==="powershell_progress"){
  // v2.1.87: else if(q.data.type==="bash_progress"||q.data.type==="powershell_progress"){
  const anchorRe = new RegExp(
    `else if\\((${V})\\.data\\.type==="bash_progress"` +
    `(?:\\|\\|\\1\\.data\\.type==="powershell_progress")?\\)\\{`
  )
  const anchorMatch = src.match(anchorRe)
  if (!anchorMatch) {
    console.error('ERROR: Cannot locate bash_progress handler in ZhA.')
    process.exit(1)
  }
  const anchor = anchorMatch[0]
  const anchorIdx = src.indexOf(anchor)
  const progressVar = anchorMatch[1]

  // Extract session_id function name from nearby ZhA code
  const ctx = src.slice(anchorIdx - 1500, anchorIdx)
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
    `${patchCMarker}else if(${progressVar}.data.type==="agent_stream_event"){` +
    `yield{type:"stream_event",event:${progressVar}.data.event,` +
    `parent_tool_use_id:${progressVar}.parentToolUseID,session_id:${sessFn}(),uuid:${progressVar}.uuid}` +
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
  // --- Text extraction function (FM6/sM6/BI8 equivalent) ---
  //
  // v2.1.47–v2.1.81: function NAME(A,q="Execution completed"){let K=GN(A);if(!K)return q;return K.message.content.filter(...)
  // v2.1.87+: function NAME(q,K="Execution completed"){let _=x0(q);if(!_)return K;return S3(_.message.content,...)}
  //
  // In v2.1.87, the inline filter/map was extracted into a helper S3().
  // We can't modify S3 (used globally). Instead we replace S3(...) with
  // inline filter+map that includes thinking blocks.
  //
  // Try new pattern first (uses helper), then old (inline filter).
  const newTextFnRe = new RegExp(
    `function (${V})\\((${V}),(${V})="Execution completed"\\)\\{` +
    `let (${V})=(${V})\\(\\2\\);if\\(!\\4\\)return \\3;` +
    `return (${V})\\(\\4\\.message\\.content,\`\\n\`\\)\\|\\|\\3\\}`
  )
  const oldTextFnRe = new RegExp(
    `function (${V})\\((${V}),(${V})="Execution completed"\\)\\{` +
    `let (${V})=(${V})\\(\\2\\);if\\(!\\4\\)return \\3;` +
    `return \\4\\.message\\.content\\.filter`
  )
  const textFnMatch = src.match(newTextFnRe) || src.match(oldTextFnRe)
  if (!textFnMatch) {
    console.error('ERROR: Cannot locate text extraction function.')
    process.exit(1)
  }

  const textFnName = textFnMatch[1]
  const textFnIdx = src.indexOf(textFnMatch[0])
  console.log(`Found text extraction function: ${textFnName}() at char ${textFnIdx}`)

  if (textFnMatch[6]) {
    // New pattern (v2.1.87+): uses S3() helper
    // Replace: return S3(_.message.content,`\n`)||K}
    // With: return _.message.content.filter(X=>X.type==="text"||X.type==="thinking").map(X=>("text"in X)?X.text:("thinking"in X)?X.thinking:"").join(`\n`)||K}
    const resultVar = textFnMatch[4]
    const defaultVar = textFnMatch[3]
    const helperName = textFnMatch[6]
    const oldReturn = `return ${helperName}(${resultVar}.message.content,\`\n\`)||${defaultVar}}`
    const newReturn =
      `return ${patchDMarker}${resultVar}.message.content` +
      `.filter(_p=>_p.type==="text"||_p.type==="thinking")` +
      `.map(_p=>("text"in _p)?_p.text:("thinking"in _p)?_p.thinking:"")` +
      `.join(\`\n\`)||${defaultVar}}`
    const returnIdx = src.indexOf(oldReturn, textFnIdx)
    if (returnIdx === -1 || returnIdx > textFnIdx + 300) {
      console.error('ERROR: Cannot find S3 return in text extraction function.')
      process.exit(1)
    }
    src = src.slice(0, returnIdx) + newReturn + src.slice(returnIdx + oldReturn.length)
    console.log(`Patched ${textFnName} (replaced ${helperName}() with inline filter+map including thinking).`)
  } else {
    // Old pattern (v2.1.47–v2.1.81): inline filter/map
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
      console.log('Patched (filter + map).')
    } else {
      console.log('Patched (filter only).')
    }
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

  // Find the UUID generator in the progress wrapping function.
  // Accepts bare fn `FUNC()` (older SDK-built cli.js, <=2.1.112) and
  // method call `OBJ.randomUUID()` (Bun-extracted cli.js in 2.1.113+).
  const uuidFnRe = /\{type:"progress",data:[\w$]+,toolUseID:[\w$]+,parentToolUseID:[\w$]+,uuid:([\w$]+(?:\.[\w$]+)?)\(\),timestamp:new Date/
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
  // v2.1.76: )){ARR.push(MSG),STATS(STATS,MSG,TOOLS,J.options.tools),STATE(...);let V=wm8(MSG);if(V)Om8(...)}
  //          Loop body now uses braces with additional output-file statements.
  //
  // Try braced pattern first (v2.1.76+), fall back to old single-statement pattern.
  const bracedAsyncBodyRe = new RegExp(
    `\\)\\)\\{(${V})\\.push\\((${V})\\),` +          // )){ARR.push(MSG),
    `(${V})\\((${V}),\\2,` +                          // STATS(STATS,MSG,
    `(${V}),(${V})\\.options\\.tools\\),[^}]+\\}`      // TOOLS,j.options.tools),...}
  , 'g')
  const unbracedAsyncBodyRe = new RegExp(
    `\\)\\)(?:if\\()?(${V})\\.push\\((${V})\\),` +   // ))ARR.push(MSG), or ))if(ARR.push(MSG),
    `(${V})\\((${V}),\\2,` +                          // STATS(STATS,MSG,
    `(${V}),(${V})\\.options\\.tools\\),` +            // TOOLS,j.options.tools),
    `[^;]+;`                                           // ...rest until ;
  , 'g')

  let asyncMatch
  let asyncPatchCount = 0

  const matches = []
  // Try braced pattern first, fall back to unbraced
  for (const re of [bracedAsyncBodyRe, unbracedAsyncBodyRe]) {
    re.lastIndex = 0
    while ((asyncMatch = re.exec(src)) !== null) {
      const before = src.slice(Math.max(0, asyncMatch.index - 1000), asyncMatch.index)
      if (!before.includes('for await')) continue
      matches.push({
        fullMatch: asyncMatch[0],
        msgVar: asyncMatch[2],
        index: asyncMatch.index
      })
    }
    if (matches.length > 0) break
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
// Patch G: iu8() — async background agent direct stdout streaming
//
// iu8() is the function that runs agents launched with run_in_background=true.
// Unlike the re-background loop (Patch E), iu8 never had stdout forwarding.
// Its `for await` loop just collects messages — we inject forwarding logic
// identical to Patch E.
//
// Anchor: the unique function signature of iu8 plus its for-await body:
//   for await(let MSG of _(CACHE_PARAM)){ARR.push(MSG),REGISTRY.update(...)
// ===========================================================================

console.log('\n--- Patch G: iu8() background agent stdout streaming ---')

const patchGMarker = '/*PATCHED:subagent-G*/'

if (src.includes(patchGMarker)) {
  console.log('Already applied. Skipping.')
} else {
  // Find iu8 by its unique signature pattern:
  // async function FUNC({taskId:VAR,abortController:VAR,makeStream:VAR,metadata:VAR,description:VAR,toolUseContext:VAR,taskRegistry:VAR,...})
  const iu8SigRe = new RegExp(
    `async function (${V})\\(\\{taskId:(${V}),abortController:(${V}),makeStream:(${V}),` +
    `metadata:(${V}),description:(${V}),toolUseContext:(${V}),taskRegistry:(${V}),` +
    `agentIdForCleanup:(${V}),enableSummarization:(${V}),getWorktreeResult:(${V})\\}\\)`
  )
  const iu8Match = iu8SigRe.exec(src)
  if (!iu8Match) {
    console.error('ERROR: Cannot locate iu8() function signature.')
    process.exit(1)
  }
  // Re-discover session ID and UUID functions (same as Patch E but in Patch G scope)
  const sessFnReG = /session_id:([\w$]+)\(\).*?parent_tool_use_id/
  const sessFnMatchG = src.match(sessFnReG)
  if (!sessFnMatchG) { console.error('ERROR: Cannot locate session ID function for Patch G.'); process.exit(1) }
  const sessFnG = sessFnMatchG[1]

  // Accepts bare fn `FUNC()` and method call `OBJ.randomUUID()` (2.1.113+).
  const uuidFnReG = /\{type:"progress",data:[\w$]+,toolUseID:[\w$]+,parentToolUseID:[\w$]+,uuid:([\w$]+(?:\.[\w$]+)?)\(\),timestamp:new Date/
  const uuidFnMatchG = src.match(uuidFnReG)
  if (!uuidFnMatchG) { console.error('ERROR: Cannot locate UUID function for Patch G.'); process.exit(1) }
  const uuidFnG = uuidFnMatchG[1]

  const iu8Name = iu8Match[1]
  const taskIdVar = iu8Match[2]        // q
  const makeStreamVar = iu8Match[4]    // _
  const descVar_g = iu8Match[6]        // Y — description
  const toolUseCtxVar = iu8Match[7]    // A — toolUseContext (has .toolUseId)
  console.log(`  Found ${iu8Name}() at char ${iu8Match.index}`)
  console.log(`    taskId=${taskIdVar}, makeStream=${makeStreamVar}, desc=${descVar_g}, toolUseCtx=${toolUseCtxVar}`)

  // Find the for-await loop body inside iu8:
  // v2.1.76:  for await(let MSG of MAKESTREAM(CACHE)){ARR.push(MSG),REGISTRY.update(...
  // v2.1.114: for await(let MSG of MAKESTREAM(CACHE)){PROGRESS=MSG.type,WATCHDOG(),ARR.push(MSG),...
  // v2.1.118: for await(let MSG of MAKESTREAM(SUMFN,POKEFN)){PROGRESS=...,if(MSG.type==="assistant"){...}else if(MSG.type==="user"){...},...ARR.push(MSG),...
  //           MAKESTREAM now takes 2 args (summarization fn + watchdog poke) and
  //           the loop body contains nested { } for last-seen tracking, so a
  //           non-nested prefix won't reach .push(). We only need the loop
  //           variable — arr is never referenced in the injection. Match just
  //           the for-await opening, then find .push(msgVar) separately.
  const iu8Body = src.slice(iu8Match.index, iu8Match.index + 3000)
  // Minified identifiers can be `$`, which is a regex metachar (end-of-input)
  // when used outside a character class. Escape before interpolating.
  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const forAwaitRe = new RegExp(
    `for await\\(let (${V}) of ${reEsc(makeStreamVar)}\\([^)]*\\)\\)\\{`
  )
  const forAwaitMatch = forAwaitRe.exec(iu8Body)
  if (!forAwaitMatch) {
    console.error('ERROR: Cannot find for-await loop in iu8().')
    process.exit(1)
  }
  const msgVar_g = forAwaitMatch[1]
  // Sanity check: confirm `.push(msgVar)` exists in the body (proves we're in
  // the collection-building loop, not some other for-await).
  const pushRe = new RegExp(`(${V})\\.push\\(${reEsc(msgVar_g)}\\)`)
  const pushMatch = pushRe.exec(iu8Body.slice(forAwaitMatch.index + forAwaitMatch[0].length))
  if (!pushMatch) {
    console.error(`ERROR: Cannot find .push(${msgVar_g}) after iu8() for-await loop.`)
    process.exit(1)
  }
  const arrVar_g = pushMatch[1]
  console.log(`    Loop: msg=${msgVar_g}, arr=${arrVar_g}`)

  // The injection point is right after the opening `{` of the for-await body
  const forAwaitAbsIdx = iu8Match.index + iu8Body.indexOf(forAwaitMatch[0])
  const braceIdx = forAwaitAbsIdx + forAwaitMatch[0].indexOf('{') + 1

  // toolUseId for parent_tool_use_id comes from toolUseContext
  const ptuExpr = `${toolUseCtxVar}.toolUseId`

  // Single injection at the start of the loop body — handles all three types.
  // stream_event: forward + continue (skip collection).
  // assistant/user: forward + fall through to existing body (push, stats, etc).
  const gInjection = patchGMarker +
    `if(${msgVar_g}.type==="stream_event"){` +
      `try{process.stdout.write(JSON.stringify({type:"stream_event",event:${msgVar_g}.event,` +
      `parent_tool_use_id:${ptuExpr},session_id:${sessFnG}(),uuid:${uuidFnG}()})+"\\n")}catch(_ge){}` +
      `continue` +
    `}` +
    `if(${msgVar_g}.type==="assistant"||${msgVar_g}.type==="user")` +
      `try{process.stdout.write(JSON.stringify({type:${msgVar_g}.type,message:${msgVar_g}.message,` +
      `parent_tool_use_id:${ptuExpr},session_id:${sessFnG}(),uuid:${uuidFnG}()})+"\\n")}catch(_ge){}`

  src = src.slice(0, braceIdx) + gInjection + src.slice(braceIdx)

  if (!src.includes(patchGMarker)) {
    console.error('ERROR: Patch G injection failed.')
    process.exit(1)
  }

  patchCount++
  console.log('  Applied.')
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
  ['E', patchEMarker, 'Background agent stdout streaming (re-background)'],
  ['G', patchGMarker, 'Background agent stdout streaming (iu8 — run_in_background)']
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

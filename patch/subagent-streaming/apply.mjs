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
// Before:
//   if(O1.push(Y1),Y1.type!=="assistant"&&Y1.type!=="user")continue;
//
// After:
//   if(O1.push(Y1),Y1.type!=="assistant"&&Y1.type!=="user"){
//     if(Y1.type==="stream_event"&&j)j({toolUseID:`agent_${D.message.id}`,
//       data:{type:"agent_stream_event",event:Y1.event,agentId:r}});continue}
// ===========================================================================

console.log('\n--- Patch B: Sub-agent stream_event forwarding ---')

const patchBMarker = '/*PATCHED:subagent-B*/'

if (src.includes(patchBMarker)) {
  console.log('Already applied. Skipping.')
} else {
  // Find: VAR.push(MSG),MSG.type!=="assistant"&&MSG.type!=="user")continue;
  const typeFilterRe = new RegExp(
    `(${V})\\.push\\((${V})\\),\\2\\.type!=="assistant"&&\\2\\.type!=="user"\\)continue;`
  )
  const m = src.match(typeFilterRe)
  if (!m) {
    console.error('ERROR: Cannot locate sub-agent type filter.')
    process.exit(1)
  }

  const [oldStr, arrVar, msgVar] = m
  const idx = src.indexOf(oldStr)
  console.log(`Found type filter at char ${idx} (arr=${arrVar}, msg=${msgVar})`)

  // Extract callback var (j), parent msg var (D), agent ID var (r) from nearby code
  const nearby = src.slice(idx, idx + 800)
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

  if (src.indexOf(oldStr, idx + 1) !== -1) {
    console.error('ERROR: Multiple matches for Patch B. Aborting.')
    process.exit(1)
  }

  const newStr =
    `${arrVar}.push(${msgVar}),${msgVar}.type!=="assistant"&&${msgVar}.type!=="user")` +
    `{${patchBMarker}if(${msgVar}.type==="stream_event"&&${cbVar})` +
    `${cbVar}({toolUseID:\`agent_\${${parentVar}.message.id}\`,` +
    `data:{type:"agent_stream_event",event:${msgVar}.event,agentId:${agentVar}}});continue}`

  src = src.slice(0, idx) + newStr + src.slice(idx + oldStr.length)
  patchCount++
  console.log('Applied. Stream events now forwarded via progress callback.')
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
  const anchor = 'else if(A.data.type==="bash_progress"){'
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
// progress callback j() is dead. Instead, we write directly to stdout using
// the CLI's binary message transport (fY1 equivalent), formatting messages
// the same way ihA/ZhA would.
//
// Before:
//   for await(let D1 of cR({...}))N1.push(D1),s01(...),s0A(AGENTID,...);
//
// After:
//   for await(let D1 of cR({...})){N1.push(D1),s01(...),s0A(AGENTID,...);
//     let _ptu=D.message.content[0].id;
//     if(D1.type==="stream_event") TRANSPORT(JSON.stringify({...}));
//     else if(D1.type==="assistant") TRANSPORT(JSON.stringify({...}));
//     else if(D1.type==="user") TRANSPORT(JSON.stringify({...}));
//   }
// ===========================================================================

console.log('\n--- Patch E: Background agent direct stdout streaming ---')

const patchEMarker = '/*PATCHED:subagent-E*/'

if (src.includes(patchEMarker)) {
  console.log('Already applied. Skipping.')
} else {
  // Find the session ID function from ihA/ZhA yields
  const sessFnRe = /session_id:([\w$]+)\(\).*?parent_tool_use_id/
  const sessFnMatch = src.match(sessFnRe)
  if (!sessFnMatch) {
    console.error('ERROR: Cannot locate session ID function.')
    process.exit(1)
  }
  const sessFn = sessFnMatch[1]
  console.log(`Session ID function: ${sessFn}()`)

  // Find async for-await+cR loops by matching the body pattern after )).
  const asyncBodyRe = new RegExp(
    `\\)\\)(${V})\\.push\\((${V})\\),` +             // ))ARR.push(MSG),
    `${V}\\(${V},\\2,` +                             // STATS(STATS,MSG,
    `${V},${V}\\.options\\.tools\\),` +               // ...,J.options.tools),
    `${V}\\((${V}(?:\\.${V})?),` +                   // s0A(AGENTID or s0A(x.prop,
    `[^;]+;`                                          // ...);
  , 'g')

  let asyncMatch
  let asyncPatchCount = 0

  const matches = []
  while ((asyncMatch = asyncBodyRe.exec(src)) !== null) {
    const before = src.slice(Math.max(0, asyncMatch.index - 500), asyncMatch.index)
    if (!before.includes('for await') || !before.includes('cR({')) continue
    matches.push({
      fullMatch: asyncMatch[0],
      msgVar: asyncMatch[2],
      agentIdExpr: asyncMatch[3],
      index: asyncMatch.index
    })
  }

  if (matches.length === 0) {
    console.error('ERROR: Cannot locate async for-await+cR loops with s0A.')
    process.exit(1)
  }

  console.log(`Found ${matches.length} async for-await loop(s) to patch.`)

  // Apply in reverse order so indices stay valid
  for (let i = matches.length - 1; i >= 0; i--) {
    const { fullMatch, msgVar, index } = matches[i]

    const body = fullMatch.slice(2) // strip leading "))"

    // Write line-delimited JSON to stdout (the SDK reads newline-delimited
    // JSON, NOT binary-framed). D is the full assistant message (may contain
    // text/thinking blocks before the tool_use). Find the matching tool_use
    // block by description (K) for parent_tool_use_id.
    const replacement =
      `){${patchEMarker}${body}` +
      `{let _ptu=null;for(let _b of D.message.content){if(_b.type==="tool_use"&&_b.input&&_b.input.description===K){_ptu=_b.id;break}}` +
      `if(${msgVar}.type==="stream_event")` +
        `process.stdout.write(JSON.stringify({type:"stream_event",event:${msgVar}.event,` +
        `parent_tool_use_id:_ptu,session_id:${sessFn}(),uuid:_f()})+"\\n");` +
      `else if(${msgVar}.type==="assistant")` +
        `process.stdout.write(JSON.stringify({type:"assistant",message:${msgVar}.message,` +
        `parent_tool_use_id:_ptu,session_id:${sessFn}(),uuid:_f()})+"\\n");` +
      `else if(${msgVar}.type==="user")` +
        `process.stdout.write(JSON.stringify({type:"user",message:${msgVar}.message,` +
        `parent_tool_use_id:_ptu,session_id:${sessFn}(),uuid:_f()})+"\\n");` +
      `}}`

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
  ['A', patchAMarker, 'Content-block filter removal'],
  ['B', patchBMarker, 'Stream_event forwarding'],
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
console.log('  A — All sub-agent content blocks (text, thinking, tool_use, tool_result)')
console.log('      flow through progress callback to SDK stream.')
console.log('  B — Sub-agent stream_events (thinking_delta, text_delta) forwarded')
console.log('      via new agent_stream_event progress type.')
console.log('  C — ZhA converts agent_stream_event to SDK stream_event with')
console.log('      parent_tool_use_id for proper attribution.')
console.log('  D — .output files include thinking blocks alongside text.')
console.log('  E — Background (async) agents forward messages through progress')
console.log('      callback for real-time streaming in SDK consumers.')
console.log('')
console.log('NOT changed:')
console.log('  UEA (task result) still returns text-only to parent model.')

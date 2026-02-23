#!/usr/bin/env node
/**
 * Patch: team-streaming
 *
 * Fixes three bugs with in-process teammates (spawned via TeamCreate + Task
 * with team_name):
 *
 *   A) agentId fragmentation — Each teammate turn generates a random hex ID.
 *      We inject q.agentId into the override so one JSONL persists across turns.
 *
 *   B) No event streaming — Teammate thinking, text, tool calls, and stream
 *      deltas never reach the SDK consumer. We forward stream_event,
 *      assistant, and user messages to stdout as newline-delimited JSON.
 *
 *   C) No completion notification — When a teammate finishes or fails, no
 *      task_notification is emitted. We inject stdout writes at both exit paths.
 *
 * See README.md for full analysis.
 *
 * Usage: node patch/team-streaming/apply.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '../..')
const cliPath = resolve(projectRoot, 'node_modules/@anthropic-ai/claude-agent-sdk/cli.js')

// Minified variable names can contain $ — use [\w$] instead of \w
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
// Patch A: Fix agentId fragmentation
//
// The in-process runner calls the query runner with
//   override:{abortController:<var>}
// but omits agentId, so each turn gets a random hex ID from Qy().
//
// Fix: Inject agentId into the override. q.agentId (the stable "name@team"
// identity) is already in scope.
//
// We find the override by regex to be resilient to variable name changes.
// ===========================================================================

console.log('\n--- Patch A: Fix agentId fragmentation ---')

const patchAMarker = '/*PATCHED:team-streaming-A*/'

if (src.includes(patchAMarker)) {
  console.log('Already applied. Skipping.')
} else {
  // Find `override:{abortController:<var>}` inside the in-process runner.
  // Must be near 'teammateContext' and 'q.agentId' to confirm context.
  const overrideRe = new RegExp(`override:\\{abortController:(${V})\\}`)
  const overrideMatch = src.match(overrideRe)
  if (!overrideMatch) {
    console.error('ERROR: Cannot find override:{abortController:<var>} pattern.')
    process.exit(1)
  }

  const abortVar = overrideMatch[1]
  const anchor = overrideMatch[0]
  const idx = src.indexOf(anchor)

  // Verify uniqueness
  if (src.indexOf(anchor, idx + 1) !== -1) {
    console.error('ERROR: Multiple matches for Patch A anchor. Aborting.')
    process.exit(1)
  }

  // Verify we're inside the in-process teammate runner
  const before = src.slice(Math.max(0, idx - 5000), idx)
  if (!before.includes('teammateContext') || !before.includes('q.agentId')) {
    console.error('ERROR: Anchor not in expected in-process runner context.')
    process.exit(1)
  }

  const replacement = `${patchAMarker}override:{abortController:${abortVar},agentId:q.agentId.replace(/@/g,"--")}`

  src = src.slice(0, idx) + replacement + src.slice(idx + anchor.length)
  patchCount++
  console.log(`Applied at char ${idx}. abortController var: ${abortVar}`)
}

// ===========================================================================
// Patch B: Forward teammate events to stdout
//
// B1: Stream event bypass — prepended before the collection push.
// B2: Assistant/user forwarding — appended after the _g() state update.
//
// Both write newline-delimited JSON to stdout with teammate_id for routing.
// ===========================================================================

console.log('\n--- Patch B: Forward teammate events to stdout ---')

const patchBMarker = '/*PATCHED:team-streaming-B*/'

if (src.includes(patchBMarker)) {
  console.log('Already applied. Skipping.')
} else {
  // --- Extract session ID and UUID function names ---
  const sessFnRe = /session_id:([\w$]+)\(\).*?parent_tool_use_id/
  const sessFnMatch = src.match(sessFnRe)
  if (!sessFnMatch) {
    console.error('ERROR: Cannot locate session ID function.')
    process.exit(1)
  }
  const sessFn = sessFnMatch[1]
  console.log(`Session ID function: ${sessFn}()`)

  const uuidFnRe = /\{type:"progress",data:[\w$]+,toolUseID:[\w$]+,parentToolUseID:[\w$]+,uuid:([\w$]+)\(\),timestamp:new Date/
  const uuidFnMatch = src.match(uuidFnRe)
  if (!uuidFnMatch) {
    console.error('ERROR: Cannot locate UUID generator function.')
    process.exit(1)
  }
  const uuidFn = uuidFnMatch[1]
  console.log(`UUID function: ${uuidFn}()`)

  // --- B1: Stream event bypass (before collection arrays) ---
  // Pattern: <arr1>.push(<msg>),<arr2>.push(<msg>),<stats>(<var>,<msg>,<var>,<toolUseContext>.options.tools)
  // We find the push pair inside the in-process runner's for-await loop.
  const pushRe = new RegExp(
    `(${V})\\.push\\((${V})\\),(${V})\\.push\\(\\2\\),(${V})\\(` +
    `(${V}),\\2,(${V}),(${V})\\.options\\.tools\\)`
  )
  const pushMatch = src.match(pushRe)
  if (!pushMatch) {
    console.error('ERROR: Cannot find Patch B1 push pattern.')
    process.exit(1)
  }

  const anchorB1 = pushMatch[0]
  const msgVar = pushMatch[2]  // the loop variable (J6 in current version)
  const idxB1 = src.indexOf(anchorB1)

  if (src.indexOf(anchorB1, idxB1 + 1) !== -1) {
    console.error('ERROR: Multiple matches for Patch B1 anchor. Aborting.')
    process.exit(1)
  }

  // Verify context: should be inside the for-await loop in the in-process runner
  const beforeB1 = src.slice(Math.max(0, idxB1 - 2000), idxB1)
  if (!beforeB1.includes('for await') || !beforeB1.includes(patchAMarker.slice(0, 20).replace('*/', '') || 'override:{abortController:')) {
    // Fall back to checking for inProcessRunner context
    if (!beforeB1.includes('inProcessRunner') && !beforeB1.includes('teammateContext')) {
      console.error('ERROR: B1 anchor not in expected for-await context.')
      process.exit(1)
    }
  }

  console.log(`B1: msg var=${msgVar}, anchor at char ${idxB1}`)

  const injectionB1 =
    `${patchBMarker}if(${msgVar}.type==="stream_event"){` +
    `process.stdout.write(JSON.stringify({` +
    `type:"stream_event",event:${msgVar}.event,` +
    `teammate_id:q.agentId,` +
    `session_id:${sessFn}(),uuid:${uuidFn}()` +
    `})+"\\n");continue}`

  src = src.slice(0, idxB1) + injectionB1 + src.slice(idxB1)
  console.log(`B1 applied. Stream events bypass collection.`)

  // --- B2: Assistant/user forwarding (after _g() state update) ---
  // Pattern: lastReportedTokenCount:<fn>(<var>)}},<setAppState>)
  // This is the end of the _g() call inside the for-await loop body.
  const b2Re = new RegExp(`lastReportedTokenCount:(${V})\\((${V})\\)\\}\\},(${V})\\)`)
  const b2Match = src.match(b2Re)
  if (!b2Match) {
    console.error('ERROR: Cannot find Patch B2 anchor pattern.')
    process.exit(1)
  }

  const anchorB2 = b2Match[0]
  const idxB2 = src.indexOf(anchorB2)

  if (src.indexOf(anchorB2, idxB2 + 1) !== -1) {
    console.error('ERROR: Multiple matches for Patch B2 anchor. Aborting.')
    process.exit(1)
  }

  const injectionB2 =
    `;if(${msgVar}.type==="assistant"||${msgVar}.type==="user")` +
    `process.stdout.write(JSON.stringify({` +
    `type:${msgVar}.type,message:${msgVar}.message,` +
    `teammate_id:q.agentId,` +
    `session_id:${sessFn}(),uuid:${uuidFn}()` +
    `})+"\\n");`

  // Append after the anchor (end of the _g() call)
  const insertPos = idxB2 + anchorB2.length
  src = src.slice(0, insertPos) + injectionB2 + src.slice(insertPos)
  console.log(`B2 applied. Assistant/user messages forwarded after state update.`)

  patchCount++
}

// ===========================================================================
// Patch C: Emit task_notification on teammate completion/failure
//
// C1: Success path — comma expression: return _g(K,...,M),{success:!0,...}
// C2: Failure path — comma expression: return ...,_g(K,...,M),<idleNotify>(...),...
//
// We inject process.stdout.write between _g() and the next element.
// ===========================================================================

console.log('\n--- Patch C: Teammate completion/failure notifications ---')

const patchCMarker = '/*PATCHED:team-streaming-C*/'

if (src.includes(patchCMarker)) {
  console.log('Already applied. Skipping.')
} else {
  // Re-extract session/UUID functions
  let sessFnC, uuidFnC
  const sessFnReC = /session_id:([\w$]+)\(\).*?parent_tool_use_id/
  const sessFnMatchC = src.match(sessFnReC)
  if (!sessFnMatchC) {
    console.error('ERROR: Cannot locate session ID function for Patch C.')
    process.exit(1)
  }
  sessFnC = sessFnMatchC[1]

  const uuidFnReC = /\{type:"progress",data:[\w$]+,toolUseID:[\w$]+,parentToolUseID:[\w$]+,uuid:([\w$]+)\(\),timestamp:new Date/
  const uuidFnMatchC = src.match(uuidFnReC)
  if (!uuidFnMatchC) {
    console.error('ERROR: Cannot locate UUID generator function for Patch C.')
    process.exit(1)
  }
  uuidFnC = uuidFnMatchC[1]
  console.log(`Session ID: ${sessFnC}(), UUID: ${uuidFnC}()`)

  const notifySnippet = (status) =>
    `process.stdout.write(JSON.stringify({` +
    `type:"system",subtype:"task_notification",` +
    `task_id:q.agentId,status:"${status}",` +
    `output_file:"",summary:"",` +
    `session_id:${sessFnC}(),uuid:${uuidFnC}()` +
    `})+"\\n")`

  // --- C1: Success path ---
  // The success return is a comma expression ending with {success:!0,messages:<var>}.
  // Between the _g() state update and the return object there may be intermediate
  // cleanup calls (e.g., dX(K), tK6(q.agentId) added in SDK 0.2.50).
  //
  // Strategy: match inProgressToolUseIDs:void 0}),<setState>), then allow any
  // chain of calls before ,{success:!0,messages:<var>}. We inject our notification
  // right before {success:!0.
  //
  // v2.1.49: ...void 0}),M),{success:!0,messages:G}
  // v2.1.50: ...void 0}),M),dX(K),tK6(q.agentId),{success:!0,messages:G}
  const c1Re = new RegExp(
    `inProgressToolUseIDs:void 0\\}\\),${V}\\)` +  // ...void 0}),M)
    `((?:,${V}\\([^)]*\\))*)` +                    // optional chain: ,fn(args),fn(args),...
    `,\\{success:!0,messages:(${V})\\}`              // ,{success:!0,messages:G}
  )
  const c1Match = src.match(c1Re)
  if (!c1Match) {
    console.error('ERROR: Cannot find Patch C1 anchor (success path).')
    process.exit(1)
  }

  const anchorC1 = c1Match[0]
  const idxC1 = src.indexOf(anchorC1)
  const trailingCallsC1 = c1Match[1] // e.g. ",dX(K),tK6(q.agentId)" or ""
  const messagesVar = c1Match[2]

  if (src.indexOf(anchorC1, idxC1 + 1) !== -1) {
    console.error('ERROR: Multiple matches for Patch C1 anchor. Aborting.')
    process.exit(1)
  }

  // Verify in-process runner context
  const beforeC1 = src.slice(Math.max(0, idxC1 - 3000), idxC1)
  if (!beforeC1.includes('inProcessRunner')) {
    console.error('ERROR: C1 anchor not in expected context.')
    process.exit(1)
  }

  // Insert notification before {success:!0}. Keep everything else intact.
  const replacementC1 =
    `${patchCMarker}` + anchorC1.replace(
      `,{success:!0,messages:${messagesVar}}`,
      `,${notifySnippet('completed')},{success:!0,messages:${messagesVar}}`
    )

  src = src.slice(0, idxC1) + replacementC1 + src.slice(idxC1 + anchorC1.length)
  console.log(`C1 applied at char ${idxC1}. Completion notification injected.`)

  // --- C2: Failure path ---
  // The failure return ends with {success:!1,error:<var>,messages:<var>}} (the extra
  // trailing } closes the catch block). We find this pattern and inject before it.
  //
  // The calls between _g()/lg() and {success:!1} may include nested parens
  // (e.g., _$q(name,color,team,{idleReason:...})) which are hard to match with
  // simple [^)]* patterns. Instead, we match the unique return object directly.
  //
  // v2.1.49: ...),{success:!1,error:y,messages:G}}}
  // v2.1.50: ...),tK6(q.agentId),{success:!1,error:y,messages:G}}}
  const c2Re = new RegExp(
    `,\\{success:!1,error:(${V}),messages:(${V})\\}\\}\\}`
  )
  const c2Match = src.match(c2Re)
  if (!c2Match) {
    console.error('ERROR: Cannot find Patch C2 anchor (failure path).')
    process.exit(1)
  }

  const anchorC2 = c2Match[0]
  const idxC2 = src.indexOf(anchorC2)
  const errorVar = c2Match[1]
  const msgsVarC2 = c2Match[2]

  if (src.indexOf(anchorC2, idxC2 + 1) !== -1) {
    console.error('ERROR: Multiple matches for Patch C2 anchor. Aborting.')
    process.exit(1)
  }

  // Verify in-process runner context
  const beforeC2 = src.slice(Math.max(0, idxC2 - 3000), idxC2)
  if (!beforeC2.includes('inProcessRunner')) {
    console.error('ERROR: C2 anchor not in expected inProcessRunner context.')
    process.exit(1)
  }

  // Insert notification before {success:!1}. Keep trailing }}} intact.
  const replacementC2 = `,${notifySnippet('failed')},{success:!1,error:${errorVar},messages:${msgsVarC2}}}}`

  src = src.slice(0, idxC2) + replacementC2 + src.slice(idxC2 + anchorC2.length)
  console.log(`C2 applied at char ${idxC2}. Failure notification injected.`)

  patchCount++
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
  ['A', patchAMarker, 'agentId fragmentation fix'],
  ['B', patchBMarker, 'Teammate event forwarding to stdout'],
  ['C', patchCMarker, 'Teammate completion/failure notifications']
]

let allGood = true
for (const [label, marker, desc] of markers) {
  const count = verify.split(marker).length - 1
  const ok = count === 1
  console.log(`  ${ok ? 'OK' : 'FAIL'} Patch ${label}: ${desc} (${count} occurrence${count !== 1 ? 's' : ''})`)
  if (!ok) allGood = false
}

if (!allGood) {
  console.error('\nVerification FAILED.')
  process.exit(1)
}

console.log('\nAll patches verified.')
console.log('')
console.log('Summary:')
console.log('  A — Stable agentId injected into query runner override. One JSONL per')
console.log('      teammate across all turns (agent-<name>--<team>.jsonl).')
console.log('  B — Stream events, assistant, and user messages forwarded to')
console.log('      stdout as newline-delimited JSON with teammate_id for routing.')
console.log('  C — task_notification emitted on teammate completion/failure.')
console.log('      Uses q.agentId as task_id for correlation with taskIdMap.')

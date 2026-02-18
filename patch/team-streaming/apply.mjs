#!/usr/bin/env node
/**
 * Patch: team-streaming
 *
 * Fixes two bugs with in-process teammates (spawned via TeamCreate + Task
 * with team_name):
 *
 *   A) agentId fragmentation — Each teammate turn generates a random hex ID
 *      via Qy(), creating a separate JSONL per turn. We inject the stable
 *      q.agentId into the OR() override so one JSONL persists across turns.
 *
 *   B) No event streaming — Teammate thinking, text, tool calls, and stream
 *      deltas never reach the SDK consumer. We forward stream_event,
 *      assistant, and user messages to stdout as newline-delimited JSON.
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
// KfY (in-process runner) calls OR() with override:{abortController:T}
// but omits agentId. Inside OR(), N = O?.agentId ? O.agentId : Qy()
// falls through to Qy() (random hex) every turn.
//
// Fix: Inject agentId into the override. q.agentId (the stable "name@team"
// identity) is already in scope (q is the `identity` parameter of KfY).
// We sanitize @ → -- for filename safety.
//
// Before:
//   override:{abortController:T}
//
// After:
//   override:{abortController:T,agentId:q.agentId.replace(/@/g,"--")}
// ===========================================================================

console.log('\n--- Patch A: Fix agentId fragmentation ---')

const patchAMarker = '/*PATCHED:team-streaming-A*/'

if (src.includes(patchAMarker)) {
  console.log('Already applied. Skipping.')
} else {
  const anchor = 'override:{abortController:T}'
  const idx = src.indexOf(anchor)
  if (idx === -1) {
    console.error('ERROR: Cannot find Patch A anchor.')
    console.error('Expected:', JSON.stringify(anchor))
    process.exit(1)
  }

  // Verify uniqueness
  if (src.indexOf(anchor, idx + 1) !== -1) {
    console.error('ERROR: Multiple matches for Patch A anchor. Aborting.')
    process.exit(1)
  }

  // Verify we're inside KfY (the in-process teammate runner)
  const before = src.slice(Math.max(0, idx - 5000), idx)
  if (!before.includes('teammateContext') || !before.includes('q.agentId')) {
    console.error('ERROR: Anchor not in expected KfY context (no teammateContext or q.agentId nearby).')
    process.exit(1)
  }

  const replacement = `${patchAMarker}override:{abortController:T,agentId:q.agentId.replace(/@/g,"--")}`

  src = src.slice(0, idx) + replacement + src.slice(idx + anchor.length)
  patchCount++
  console.log(`Applied at char ${idx}.`)
}

// ===========================================================================
// Patch B: Forward teammate events to stdout
//
// Two injection points inside KfY's `for await(let _6 of OR({...}))` loop.
//
// B1: Stream event bypass — prepended before the collection push.
//     stream_events lack .message/.uuid and would break R06/im().
//     We forward them directly and `continue` to skip collection.
//
// B2: Assistant/user forwarding — appended after im() update.
//     Runs AFTER existing state update so AppState is current.
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
  const anchorB1 = 'x.push(_6),N.push(_6),R06(p,_6,Q,H.options.tools)'
  const idxB1 = src.indexOf(anchorB1)
  if (idxB1 === -1) {
    console.error('ERROR: Cannot find Patch B1 anchor.')
    console.error('Expected:', JSON.stringify(anchorB1))
    process.exit(1)
  }

  if (src.indexOf(anchorB1, idxB1 + 1) !== -1) {
    console.error('ERROR: Multiple matches for Patch B1 anchor. Aborting.')
    process.exit(1)
  }

  // Verify context: should be inside the for-await loop in KfY
  const beforeB1 = src.slice(Math.max(0, idxB1 - 1000), idxB1)
  if (!beforeB1.includes('for await') || !beforeB1.includes('override:{abortController:T')) {
    console.error('ERROR: B1 anchor not in expected for-await context.')
    process.exit(1)
  }

  const injectionB1 =
    `${patchBMarker}if(_6.type==="stream_event"){` +
    `process.stdout.write(JSON.stringify({` +
    `type:"stream_event",event:_6.event,` +
    `teammate_id:q.agentId,` +
    `session_id:${sessFn}(),uuid:${uuidFn}()` +
    `})+"\\n");continue}`

  src = src.slice(0, idxB1) + injectionB1 + src.slice(idxB1)
  console.log(`B1 applied at char ${idxB1}. Stream events bypass collection.`)

  // --- B2: Assistant/user forwarding (after im() update) ---
  const anchorB2 = 'lastReportedTokenCount:VP8(p)}},M)'
  const idxB2 = src.indexOf(anchorB2)
  if (idxB2 === -1) {
    console.error('ERROR: Cannot find Patch B2 anchor.')
    console.error('Expected:', JSON.stringify(anchorB2))
    process.exit(1)
  }

  if (src.indexOf(anchorB2, idxB2 + 1) !== -1) {
    console.error('ERROR: Multiple matches for Patch B2 anchor. Aborting.')
    process.exit(1)
  }

  const injectionB2 =
    `;if(_6.type==="assistant"||_6.type==="user")` +
    `process.stdout.write(JSON.stringify({` +
    `type:_6.type,message:_6.message,` +
    `teammate_id:q.agentId,` +
    `session_id:${sessFn}(),uuid:${uuidFn}()` +
    `})+"\\n");`

  // Append after the anchor (which is the end of the im() call)
  const insertPos = idxB2 + anchorB2.length
  src = src.slice(0, insertPos) + injectionB2 + src.slice(insertPos)
  console.log(`B2 applied at char ${insertPos}. Assistant/user messages forwarded after im().`)

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
  ['B', patchBMarker, 'Teammate event forwarding to stdout']
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
console.log('  A — Stable agentId injected into OR() override. One JSONL per')
console.log('      teammate across all turns (agent-<name>--<team>.jsonl).')
console.log('  B — Stream events, assistant, and user messages forwarded to')
console.log('      stdout as newline-delimited JSON with teammate_id for routing.')
console.log('')
console.log('Message format:')
console.log('  {"type":"stream_event","event":{...},"teammate_id":"name@team","session_id":"...","uuid":"..."}')
console.log('  {"type":"assistant","message":{...},"teammate_id":"name@team","session_id":"...","uuid":"..."}')
console.log('  {"type":"user","message":{...},"teammate_id":"name@team","session_id":"...","uuid":"..."}')

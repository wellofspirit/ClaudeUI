/**
 * Patch: incomplete-session-resume-fix
 *
 * Fixes broken parentUuid chain when filtered progress messages (bash_progress,
 * powershell_progress, mcp_progress) are skipped during JSONL loading, causing
 * resumed sessions to lose most conversation history.
 *
 * Bug: In u_6() (the JSONL parser), progress messages matching er6() are skipped
 * with `continue`, so their UUIDs never enter the messages Map. But subsequent
 * messages still reference them via parentUuid. When Ao6() walks the parentUuid
 * chain from leaf to root, it hits a missing UUID and stops — truncating the
 * conversation to only the messages after the last filtered progress message.
 *
 * Fix: When a progress message is filtered out, record its uuid → parentUuid
 * mapping. After loading all messages, walk each message's parentUuid through
 * the redirect map to skip over any chain of filtered messages.
 *
 * Usage: node patch/progress-chain-fix/apply.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '../..')
const cliPath = resolve(projectRoot, 'node_modules/@anthropic-ai/claude-agent-sdk/cli.js')

let src
try {
  src = readFileSync(cliPath, 'utf-8')
} catch (err) {
  console.error(`ERROR: Cannot read ${cliPath}`)
  console.error('Is @anthropic-ai/claude-agent-sdk installed?')
  process.exit(1)
}

const ver = src.match(/VERSION:"([^"]+)"/)?.[1] ?? 'unknown'
console.log(`Read ${cliPath} (${(src.length / 1024 / 1024).toFixed(1)} MB)`)
console.log(`CLI version: ${ver}`)

const MARKER = '/*PATCHED:incomplete-session-resume-fix*/'

if (src.includes(MARKER)) {
  console.log('\nPatch already applied. Nothing to do.')
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Part A: Capture filtered progress UUIDs during the filter loop
// ---------------------------------------------------------------------------
// In u_6(), the progress filter line looks like:
//   ...&&er6(R.data.type))continue;
//
// We replace the `continue` with code that records the filtered message's
// uuid → parentUuid mapping into a local Map, then continues.
//
// Anchor: the er6() call is unique and immediately followed by `continue;`

const filterPattern = '&&er6(R.data.type))continue;'
const filterMatches = src.split(filterPattern).length - 1
if (filterMatches !== 1) {
  console.error(`ERROR: Expected 1 match for filter pattern, found ${filterMatches}`)
  process.exit(1)
}

// Replace: record the redirect, then continue
const filterReplacement =
  `&&er6(R.data.type)){` +
  MARKER +
  `if(R.uuid&&R.parentUuid)` +
  `{if(!_pcf_redir)var _pcf_redir=new Map();` +
  `_pcf_redir.set(R.uuid,R.parentUuid)}` +
  `continue}`

src = src.replace(filterPattern, filterReplacement)
console.log('Part A: Injected redirect map capture at progress filter.')

// ---------------------------------------------------------------------------
// Part B: After all messages are loaded, fix parentUuid references
// ---------------------------------------------------------------------------
// Right after the message loading loop, ozz(q) is called.
// Pattern: ozz(q);
// We inject the parentUuid fixup right before ozz(q).
//
// The fixup walks each message's parentUuid through the redirect map
// (handling chains of consecutive filtered messages) and updates it.

const ozzPattern = 'ozz(q);'
// ozz(q) appears in u_6 — verify we target the right one by checking it's
// near our Part A injection
const ozzIndex = src.indexOf(ozzPattern, src.indexOf(MARKER))
if (ozzIndex === -1) {
  console.error('ERROR: Cannot find ozz(q) after Part A injection.')
  process.exit(1)
}

// Make sure there's only one ozz(q) in u_6 (check within ±5000 chars of marker)
const markerIdx = src.indexOf(MARKER)
const searchStart = Math.max(0, markerIdx - 2000)
const searchEnd = Math.min(src.length, markerIdx + 8000)
const searchSlice = src.slice(searchStart, searchEnd)
const ozzCount = searchSlice.split(ozzPattern).length - 1
if (ozzCount !== 1) {
  console.error(`ERROR: Expected 1 ozz(q) near marker, found ${ozzCount}`)
  process.exit(1)
}

const fixupCode =
  `if(typeof _pcf_redir!=="undefined"&&_pcf_redir.size>0){` +
  `for(let[,_m]of q){` +
  `if(_m.parentUuid&&_pcf_redir.has(_m.parentUuid)){` +
  `let _pu=_m.parentUuid;let _seen=new Set();` +
  `while(_pu&&_pcf_redir.has(_pu)&&!_seen.has(_pu)){` +
  `_seen.add(_pu);_pu=_pcf_redir.get(_pu)}` +
  `_m.parentUuid=_pu}}}`

src = src.replace(
  src.slice(ozzIndex, ozzIndex + ozzPattern.length),
  fixupCode + ozzPattern
)
console.log('Part B: Injected parentUuid fixup before ozz(q).')

// ---------------------------------------------------------------------------
// Write and verify
// ---------------------------------------------------------------------------

writeFileSync(cliPath, src)
console.log(`\nPatch applied to ${cliPath}`)

const verify = readFileSync(cliPath, 'utf-8')
if (!verify.includes(MARKER)) {
  console.error('\nVerification FAILED — marker not found.')
  process.exit(1)
}
console.log('cli.js verified.')

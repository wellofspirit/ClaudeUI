/**
 * Patch: incomplete-session-resume-fix
 *
 * Fixes broken parentUuid chain when filtered progress messages (bash_progress,
 * powershell_progress, mcp_progress) are skipped during JSONL loading, causing
 * resumed sessions to lose most conversation history.
 *
 * Bug: In the JSONL parser, progress messages matching the filter function are
 * skipped with `continue`, so their UUIDs never enter the messages Map. But
 * subsequent messages still reference them via parentUuid. When the chain walker
 * traverses parentUuid from leaf to root, it hits a missing UUID and stops —
 * truncating the conversation to only the messages after the last filtered
 * progress message.
 *
 * Fix: When a progress message is filtered out, record its uuid → parentUuid
 * mapping. After loading all messages, walk each message's parentUuid through
 * the redirect map to skip over any chain of filtered messages.
 *
 * Usage: bun patch/incomplete-session-resume-fix/apply.mjs
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

const V = '[\\w$]+'

// ---------------------------------------------------------------------------
// Part A: Capture filtered progress UUIDs during the filter loop
// ---------------------------------------------------------------------------
// The progress filter pattern in the JSONL loader looks like:
//   if(VAR.type==="progress"&&VAR.data&&typeof VAR.data==="object"&&"type"in VAR.data&&FUNC(VAR.data.type))continue;
//
// We match dynamically to capture the minified variable (VAR) and function (FUNC)
// names, then replace the `continue` with code that records uuid → parentUuid.

const filterRe = new RegExp(
  `if\\((${V})\\.type==="progress"&&\\1\\.data&&typeof \\1\\.data==="object"&&"type"\\s*in\\s*\\1\\.data&&(${V})\\(\\1\\.data\\.type\\)\\)continue;`
)

const filterMatch = filterRe.exec(src)
if (!filterMatch) {
  console.error('ERROR: Cannot find progress filter pattern in JSONL loader.')
  console.error('Expected pattern like: if(VAR.type==="progress"&&VAR.data&&typeof VAR.data==="object"&&"type" in VAR.data&&FUNC(VAR.data.type))continue;')
  process.exit(1)
}

const msgVar = filterMatch[1]   // e.g. "m"
const filterFn = filterMatch[2] // e.g. "Ns6"
const filterLiteral = filterMatch[0]

console.log(`  Found progress filter: ${filterFn}(${msgVar}.data.type) at offset ${filterMatch.index}`)

// Verify uniqueness
const filterCount = src.split(filterLiteral).length - 1
if (filterCount !== 1) {
  console.error(`ERROR: Expected 1 match for filter pattern, found ${filterCount}`)
  process.exit(1)
}

// Replace: record the redirect, then continue
const filterReplacement =
  `if(${msgVar}.type==="progress"&&${msgVar}.data&&typeof ${msgVar}.data==="object"&&"type"in ${msgVar}.data&&${filterFn}(${msgVar}.data.type)){` +
  MARKER +
  `if(${msgVar}.uuid&&${msgVar}.parentUuid)` +
  `{if(!_pcf_redir)var _pcf_redir=new Map();` +
  `_pcf_redir.set(${msgVar}.uuid,${msgVar}.parentUuid)}` +
  `continue}`

src = src.replace(filterLiteral, filterReplacement)
console.log('Part A: Injected redirect map capture at progress filter.')

// ---------------------------------------------------------------------------
// Part B: After all messages are loaded, fix parentUuid references
// ---------------------------------------------------------------------------
// Right after the message loading loop closes, a function is called on the
// messages Map variable, like: wHY(K);
// We find it dynamically by looking for a FUNC(VAR); call near the Part A
// injection site. The messages Map is the variable passed to .set() calls
// in the surrounding code.
//
// Strategy: Find a FUNC(VAR); pattern within ~2000 chars after the marker.
// The messages Map variable appears in patterns like VAR.set( near the marker.

const markerIdx = src.indexOf(MARKER)
if (markerIdx === -1) {
  console.error('ERROR: Marker not found after Part A — something went wrong.')
  process.exit(1)
}

// Find the messages Map variable by looking for .set( calls near the marker.
// In the JSONL loader, the pattern is: MAPVAR.set(VAR.uuid, VAR)
const mapSetRe = new RegExp(`(${V})\\.set\\(${msgVar}\\.uuid,\\s*${msgVar}\\)`)
const nearbySlice = src.slice(markerIdx, markerIdx + 3000)
const mapSetMatch = mapSetRe.exec(nearbySlice)
if (!mapSetMatch) {
  console.error('ERROR: Cannot find messages Map .set() call near marker.')
  process.exit(1)
}
const mapVar = mapSetMatch[1] // e.g. "K"
console.log(`  Messages Map variable: ${mapVar}`)

// Now find the FUNC(MAPVAR); call after the loading loop.
// Search for a pattern like: FUNC(MAPVAR); where FUNC is a simple identifier call
// This should be the first such call after the loop body ends.
const postLoopRe = new RegExp(`(${V})\\(${mapVar.replace(/\$/g, '\\$')}\\);`)
const postLoopSlice = src.slice(markerIdx, markerIdx + 5000)
const postLoopMatch = postLoopRe.exec(postLoopSlice)
if (!postLoopMatch) {
  console.error(`ERROR: Cannot find post-loop function call on ${mapVar} near marker.`)
  process.exit(1)
}
const postLoopFn = postLoopMatch[1] // e.g. "wHY"
const postLoopLiteral = `${postLoopFn}(${mapVar});`
const postLoopAbsIdx = markerIdx + postLoopMatch.index

console.log(`  Post-loop anchor: ${postLoopLiteral} at offset ${postLoopAbsIdx}`)

// Verify the anchor is unique in the nearby region
const regionStart = Math.max(0, markerIdx - 2000)
const regionEnd = Math.min(src.length, markerIdx + 8000)
const regionSlice = src.slice(regionStart, regionEnd)
const anchorCount = regionSlice.split(postLoopLiteral).length - 1
if (anchorCount !== 1) {
  console.error(`ERROR: Expected 1 ${postLoopLiteral} near marker, found ${anchorCount}`)
  process.exit(1)
}

// Inject the parentUuid fixup right before the post-loop call
const fixupCode =
  `if(typeof _pcf_redir!=="undefined"&&_pcf_redir.size>0){` +
  `for(let[,_m]of ${mapVar}){` +
  `if(_m.parentUuid&&_pcf_redir.has(_m.parentUuid)){` +
  `let _pu=_m.parentUuid;let _seen=new Set();` +
  `while(_pu&&_pcf_redir.has(_pu)&&!_seen.has(_pu)){` +
  `_seen.add(_pu);_pu=_pcf_redir.get(_pu)}` +
  `_m.parentUuid=_pu}}}`

src = src.replace(
  src.slice(postLoopAbsIdx, postLoopAbsIdx + postLoopLiteral.length),
  fixupCode + postLoopLiteral
)
console.log(`Part B: Injected parentUuid fixup before ${postLoopLiteral}`)

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

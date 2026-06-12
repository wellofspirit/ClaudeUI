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
 * Status: UPSTREAMED in SDK 0.2.87. The bo() JSONL loader now natively builds
 * a redirect map for filtered progress messages and applies it to subsequent
 * messages' parentUuid. This patch detects the upstream fix and exits as a no-op.
 *
 * Usage: bun patch/incomplete-session-resume-fix/apply.mjs
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '../..')
const cliPath = resolve(projectRoot, 'vendor/claude-cli/cli.js')

let src
try {
  src = readFileSync(cliPath, 'utf-8')
} catch (err) {
  console.error(`ERROR: Cannot read ${cliPath}`)
  console.error('Did you run: node scripts/extract-cli.mjs ?')
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
// Detect upstream fix (SDK >= 0.2.87)
// ---------------------------------------------------------------------------
// In 0.2.87+, the bo() JSONL loader uses a dedicated function to detect
// progress messages and natively builds a parentUuid redirect map:
//
//   if(FUNC(C)){let F=C.parentUuid;B.set(C.uuid,F&&B.has(F)?B.get(F)??null:F);continue}
//   if(xo(C)){if(C.parentUuid&&B.has(C.parentUuid))C.parentUuid=B.get(C.parentUuid)??null;
//
// We detect this by looking for the redirect map pattern: .set(VAR.uuid, ...
// combined with .parentUuid and .get() in the JSONL loader context.

const V = '[\\w$]+'

// Pattern: VAR.set(VAR.uuid,VAR&&VAR.has(VAR)?VAR.get(VAR)??null:VAR);continue|return
// This is the redirect map build + continue/return in the progress filter branch.
// SDK 0.2.87–0.2.89 used a for-loop with `continue`; 0.2.97+ uses an arrow
// callback with `return`.
const upstreamRedirectRe = new RegExp(
  `(${V})\\.set\\((${V})\\.uuid,(${V})&&\\1\\.has\\(\\3\\)\\?\\1\\.get\\(\\3\\)\\?\\?null:\\3\\);(?:continue|return)`
)

// Pattern: VAR.parentUuid&&VAR.has(VAR.parentUuid))VAR.parentUuid=VAR.get(VAR.parentUuid)??null
// This is the redirect map application for non-progress messages.
const upstreamApplyRe = new RegExp(
  `(${V})\\.parentUuid&&(${V})\\.has\\(\\1\\.parentUuid\\)\\)\\1\\.parentUuid=\\2\\.get\\(\\1\\.parentUuid\\)\\?\\?null`
)

const hasRedirectBuild = upstreamRedirectRe.test(src)
const hasRedirectApply = upstreamApplyRe.test(src)

if (hasRedirectBuild && hasRedirectApply) {
  console.log('\nUpstream fix detected (SDK >= 0.2.87). Patch is a no-op.')
  console.log('  - Progress message redirect map: found')
  console.log('  - parentUuid redirect application: found')
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Legacy path: apply the patch for older SDK versions (< 0.2.87)
// ---------------------------------------------------------------------------

// Part A: Capture filtered progress UUIDs during the filter loop
// The progress filter pattern in older SDKs looks like:
//   if(VAR.type==="progress"&&VAR.data&&typeof VAR.data==="object"&&"type"in VAR.data&&FUNC(VAR.data.type))continue;

const filterRe = new RegExp(
  `if\\((${V})\\.type==="progress"&&\\1\\.data&&typeof \\1\\.data==="object"&&"type"\\s*in\\s*\\1\\.data&&(${V})\\(\\1\\.data\\.type\\)\\)continue;`
)

const filterMatch = filterRe.exec(src)
if (!filterMatch) {
  console.error('ERROR: Cannot find progress filter pattern in JSONL loader.')
  console.error(
    'Expected pattern like: if(VAR.type==="progress"&&VAR.data&&typeof VAR.data==="object"&&"type" in VAR.data&&FUNC(VAR.data.type))continue;'
  )
  console.error('And upstream fix was not detected either. Cannot patch this SDK version.')
  process.exit(1)
}

const msgVar = filterMatch[1] // e.g. "m"
const filterFn = filterMatch[2] // e.g. "Ns6"
const filterLiteral = filterMatch[0]

console.log(
  `  Found progress filter: ${filterFn}(${msgVar}.data.type) at offset ${filterMatch.index}`
)

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

const markerIdx = src.indexOf(MARKER)
if (markerIdx === -1) {
  console.error('ERROR: Marker not found after Part A — something went wrong.')
  process.exit(1)
}

// Find the messages Map variable by looking for .set( calls near the marker.
const mapSetRe = new RegExp(`(${V})\\.set\\(${msgVar}\\.uuid,\\s*${msgVar}\\)`)
const nearbySlice = src.slice(markerIdx, markerIdx + 3000)
const mapSetMatch = mapSetRe.exec(nearbySlice)
if (!mapSetMatch) {
  console.error('ERROR: Cannot find messages Map .set() call near marker.')
  process.exit(1)
}
const mapVar = mapSetMatch[1]
console.log(`  Messages Map variable: ${mapVar}`)

// Find the FUNC(MAPVAR); call after the loading loop.
const postLoopRe = new RegExp(`(${V})\\(${mapVar.replace(/\$/g, '\\$')}\\);`)
const postLoopSlice = src.slice(markerIdx, markerIdx + 5000)
const postLoopMatch = postLoopRe.exec(postLoopSlice)
if (!postLoopMatch) {
  console.error(`ERROR: Cannot find post-loop function call on ${mapVar} near marker.`)
  process.exit(1)
}
const postLoopFn = postLoopMatch[1]
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

const { writeFileSync } = await import('node:fs')
writeFileSync(cliPath, src)
console.log(`\nPatch applied to ${cliPath}`)

const verify = readFileSync(cliPath, 'utf-8')
if (!verify.includes(MARKER)) {
  console.error('\nVerification FAILED — marker not found.')
  process.exit(1)
}
console.log('cli.js verified.')

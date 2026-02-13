/**
 * Patch: task-notification-killed-mapping
 *
 * Maps "killed" status to "stopped" in task_notification validation.
 * See README.md for full analysis.
 *
 * Usage: node patch/task-notification-killed-mapping/apply.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '../..')
const cliPath = resolve(projectRoot, 'node_modules/@anthropic-ai/claude-agent-sdk/cli.js')

// Minified variable names can contain $
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

// ---------------------------------------------------------------------------
// Step 2: Check if already patched
// ---------------------------------------------------------------------------

const patchMarker = '/*PATCHED:task-notification-killed-mapping*/'

if (src.includes(patchMarker)) {
  console.log('\nPatch already applied. Nothing to do.')
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Step 3: Locate the task_notification status validator
//
// Pattern in the XML parser for task-notification:
//   VALIDATOR=(STATUS)=>STATUS==="completed"||STATUS==="failed"||STATUS==="stopped",
//   EXTRACTED_STATUS=XML_MATCH?.[1],
//   VALIDATED_STATUS=VALIDATOR(EXTRACTED_STATUS)?EXTRACTED_STATUS:"completed";
//
// We need to:
// 1. Add "||STATUS==="killed"" to the validator
// 2. Add ternary mapping: VALIDATOR(X)?(X==="killed"?"stopped":X):"completed"
// ---------------------------------------------------------------------------

// Find the validator by its unique pattern
// Pattern: y1=(R1)=>R1==="completed"||R1==="failed"||R1==="stopped",x1=X1?.[1],G1=y1(x1)?x1:"completed";
const validatorRe = new RegExp(
  `(${V})=\\((${V})\\)=>\\2==="completed"\\|\\|\\2==="failed"\\|\\|\\2==="stopped",` +
  `(${V})=(${V})\\?\\.\\[1\\],` +
  `(${V})=\\1\\(\\3\\)\\?\\3:"completed";`
)

const validatorMatch = src.match(validatorRe)

if (!validatorMatch) {
  console.error('ERROR: Cannot locate task_notification status validator.')
  console.error('Expected pattern: VALIDATOR=(S)=>S==="completed"||S==="failed"||S==="stopped",EXTRACTED=XML?.[1],VALIDATED=VALIDATOR(EXTRACTED)?EXTRACTED:"completed";')
  process.exit(1)
}

const [fullMatch, validatorName, statusParam, extractedStatusName, xmlMatchName, validatedStatusName] = validatorMatch
console.log(`Found status validator:`)
console.log(`  validator fn: ${validatorName}(${statusParam})`)
console.log(`  extracted: ${extractedStatusName} = ${xmlMatchName}?.[1]`)
console.log(`  validated: ${validatedStatusName} = ${validatorName}(${extractedStatusName}) ? ${extractedStatusName} : "completed"`)

const matchIdx = src.indexOf(fullMatch)

// Ensure unique match
if (src.indexOf(fullMatch, matchIdx + 1) !== -1) {
  console.error('ERROR: Found multiple matches for the validator pattern. Aborting.')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Step 4: Apply the patch
//
// Before:
//   y1=(R1)=>R1==="completed"||R1==="failed"||R1==="stopped",
//   x1=X1?.[1],
//   G1=y1(x1)?x1:"completed";
//
// After:
//   y1=(R1)=>R1==="completed"||R1==="failed"||R1==="stopped"||R1==="killed",
//   x1=X1?.[1],
//   G1=y1(x1)?(x1==="killed"?"stopped":x1):"completed";
// ---------------------------------------------------------------------------

const patched = fullMatch
  // Add ||STATUS==="killed" to validator
  .replace(
    `${statusParam}==="stopped",`,
    `${statusParam}==="stopped"||${statusParam}==="killed",`
  )
  // Add mapping: if "killed" then "stopped", else original
  .replace(
    `${validatorName}(${extractedStatusName})?${extractedStatusName}:"completed";`,
    `${validatorName}(${extractedStatusName})?(${extractedStatusName}==="killed"?"stopped":${extractedStatusName}):"completed";`
  )

const patchedSrc =
  src.slice(0, matchIdx) +
  patchMarker +
  patched +
  src.slice(matchIdx + fullMatch.length)

// ---------------------------------------------------------------------------
// Step 5: Write and verify
// ---------------------------------------------------------------------------

writeFileSync(cliPath, patchedSrc)
console.log(`\nPatch applied to ${cliPath}`)

// Verify
const verify = readFileSync(cliPath, 'utf-8')
if (!verify.includes(patchMarker)) {
  console.error('ERROR: Verification failed — patch marker not found after write.')
  process.exit(1)
}

// Verify the "killed" validator extension
if (!verify.includes(`${statusParam}==="killed"`)) {
  console.error('ERROR: Verification failed — "killed" not added to validator.')
  process.exit(1)
}

// Verify the mapping
if (!verify.includes(`${extractedStatusName}==="killed"?"stopped":${extractedStatusName}`)) {
  console.error('ERROR: Verification failed — killed→stopped mapping not found.')
  process.exit(1)
}

console.log('Verified: patch is in place.')
console.log('')
console.log('What this does:')
console.log('  1. Accepts "killed" in the status validator (previously only completed/failed/stopped)')
console.log('  2. Maps "killed" → "stopped" for SDK consumers')
console.log('  3. This matches CLI behavior where tasks use internal "killed" status')

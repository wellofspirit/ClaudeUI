/**
 * Patch: bash-output-streaming
 *
 * Forwards real-time Bash/PowerShell output to the SDK stream so GUI clients
 * can render live terminal output while commands are running.
 *
 * In the SDK bash tool (inside function MNK), the command runner `Bc()` is
 * called with an `onProgress` callback that fires on every output chunk.
 * However, the progress data only gets yielded to the SDK consumer AFTER a
 * 2-second timeout (HEK=2000), and even then only through the progress loop.
 * Fast commands (< 2s) never yield any progress.
 *
 * This patch injects a process.stdout.write directly inside the `onProgress`
 * callback of `Bc()`, so every output chunk is immediately forwarded to the
 * SDK stream as a `bash_output` message, rate-limited to 1 per 200ms.
 *
 * Usage: node patch/bash-output-streaming/apply.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '../..')
const cliPath = resolve(projectRoot, 'node_modules/@anthropic-ai/claude-agent-sdk/cli.js')

const V = '[\\w$]+'

let src
try {
  src = readFileSync(cliPath, 'utf-8')
} catch (err) {
  console.error(`ERROR: Cannot read ${cliPath}`)
  process.exit(1)
}

console.log(`Read ${cliPath} (${(src.length / 1024 / 1024).toFixed(1)} MB)`)

const PATCH_MARKER = '/*PATCHED:bash-output-streaming*/'
const EARLY_POLL_MARKER = '/*PATCHED:bash-early-poll*/'

if (src.includes(PATCH_MARKER) && src.includes(EARLY_POLL_MARKER)) {
  console.log('Already applied (both parts). Skipping.')
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Find the onProgress callback inside the Bc() call in UZY (bash runner)
// ---------------------------------------------------------------------------
//
// Pattern shape (stable across versions):
//   onProgress(<5 vars>){<var>=<var>,<var>=<var>,<var>=<var>,<var>=<ternary>;
//     let <var>=<resolverVar>;if(<var>)<resolverVar>=null,<var>()
//   }
//
// We match the structural opening and inject our stdout write at the start.
// The 5 parameters are: (fullOutput, output, totalLines, totalBytes, hasBytes?)

const anchorRe = new RegExp(
  `onProgress\\((${V}),(${V}),(${V}),(${V}),(${V})\\)\\{` +
  `(${V})=\\1,(${V})=\\2,(${V})=\\3,(${V})=\\5\\?\\4:0;` +
  `let (${V})=(${V});if\\(\\10\\)\\11=null,\\10\\(\\)\\}`
)

// Match anchor whether or not Part A is already applied (the patch marker
// appears right after the opening brace, so try both patterns).
let anchorMatch = anchorRe.exec(src)
if (!anchorMatch) {
  // Part A might already be applied — try matching with the patch marker present
  const patchedRe = new RegExp(
    `onProgress\\((${V}),(${V}),(${V}),(${V}),(${V})\\)\\{/\\*PATCHED:bash-output-streaming\\*/`
  )
  anchorMatch = patchedRe.exec(src)
}
if (!anchorMatch) {
  console.error('ERROR: Cannot locate onProgress callback in Bc() call.')
  console.error('Use bundle-analyzer to find it:')
  console.error('  bundle-analyzer find cli.js "onProgress" --compact')
  process.exit(1)
}

const fullOutputVar = anchorMatch[1]  // U (fullOutput)
const outputVar = anchorMatch[2]      // c (output/tail)
const totalLinesVar = anchorMatch[3]  // n
const totalBytesVar = anchorMatch[4]  // l
console.log(`Found onProgress at char ${anchorMatch.index}`)
console.log(`  Params: fullOutput=${fullOutputVar}, output=${outputVar}, totalLines=${totalLinesVar}, totalBytes=${totalBytesVar}`)

// Find the toolUseId variable ($) from the enclosing scope
// Pattern: toolUseId:<var> in the UZY parameters
const nearCtx = src.slice(Math.max(0, anchorMatch.index - 2000), anchorMatch.index)
const toolUseIdRe = new RegExp(`toolUseId:(${V})[,}]`)
const toolUseIdMatch = toolUseIdRe.exec(nearCtx)
if (!toolUseIdMatch) {
  console.error('ERROR: Cannot find toolUseId in scope.')
  process.exit(1)
}
const toolUseIdVar = toolUseIdMatch[1]
console.log(`  toolUseId var: ${toolUseIdVar}`)

// ---------------------------------------------------------------------------
// Part A: Inject stdout write at the START of the onProgress callback body
// ---------------------------------------------------------------------------

if (src.includes(PATCH_MARKER)) {
  console.log('\nPart A (onProgress hook) already applied. Skipping.')
} else {
  console.log('\n--- Part A: onProgress hook ---')

  // Verify uniqueness
  const allMatches = [...src.matchAll(new RegExp(anchorRe, 'g'))]
  if (allMatches.length > 1) {
    console.error('ERROR: onProgress pattern matched multiple times. Aborting.')
    process.exit(1)
  }

  const openBrace = anchorMatch[0].slice(0, anchorMatch[0].indexOf('{') + 1)

  const injection = PATCH_MARKER +
    `{let _bo_now=Date.now();` +
    `if(!globalThis._bo_map)globalThis._bo_map=new Map;` +
    `let _bo_k=${toolUseIdVar}||"",_bo_last=globalThis._bo_map.get(_bo_k)||0;` +
    `if(_bo_now-_bo_last>=200){` +
      `globalThis._bo_map.set(_bo_k,_bo_now);` +
      `try{process.stdout.write(JSON.stringify({type:"bash_output",` +
        `tool_use_id:${toolUseIdVar},` +
        `output:${outputVar},` +
        `full_output:${fullOutputVar},` +
        `total_lines:${totalLinesVar},` +
        `total_bytes:${totalBytesVar}` +
      `})+"\\n")}catch(_bo_e){}` +
    `}}`

  const insertIdx = src.indexOf(anchorMatch[0]) + openBrace.length
  src = src.slice(0, insertIdx) + injection + src.slice(insertIdx)

  if (!src.includes(PATCH_MARKER)) {
    console.error('ERROR: Part A injection failed.')
    process.exit(1)
  }
  console.log('  Applied.')
}

// ---------------------------------------------------------------------------
// Part B: Start Nw file polling immediately after Bc() returns
// ---------------------------------------------------------------------------
//
// For normal bash execution, stdout goes to a file (not piped), so the inline
// writeStdout→onProgress path never fires. The CLI's own Nw.startPolling is
// deferred behind a 2s HEK timeout + 1s polling interval = 3s delay.
//
// We inject an early Nw.startPolling() call right after Bc() returns (process
// spawned), before the HEK timeout race. This eliminates the 2s wait.
//
// Pattern: ),<resultVar>=<bcVar>.result;
// We inject right after this, before function F() definition.

const INIT_MARKER = '/*PATCHED:bash-early-poll*/'

if (src.includes(INIT_MARKER)) {
  console.log('\nPart B (early poll) already applied. Skipping.')
} else {
  console.log('\n--- Part B: early Nw.startPolling after Bc() ---')

  // Find the Bc result assignment: ),<var>=<bcVar>.result;
  const afterPatch = src.slice(anchorMatch.index, anchorMatch.index + 3000)
  const resultRe = new RegExp(`\\),(${V})=(${V})\\.result;`)
  const resultMatch = resultRe.exec(afterPatch)
  if (!resultMatch) {
    console.error('ERROR: Cannot find Bc result assignment after onProgress.')
    process.exit(1)
  }

  const bcVar = resultMatch[2]  // b — the DH7 shell command instance
  const resultAbsIdx = anchorMatch.index + afterPatch.indexOf(resultMatch[0]) + resultMatch[0].length
  console.log(`  Found .result assignment: ${resultMatch[0]} (bcVar=${bcVar})`)

  // Verify uniqueness near the patch
  const searchArea = src.slice(anchorMatch.index, anchorMatch.index + 3000)
  const allResultMatches = [...searchArea.matchAll(new RegExp(resultRe, 'g'))]
  if (allResultMatches.length > 1) {
    console.error('ERROR: Multiple .result assignments found nearby. Aborting.')
    process.exit(1)
  }

  // Find Nw class name by looking for Nw.startPolling in this function
  // The existing call is: Nw.startPolling(b.taskOutput.taskId)
  const nwRe = new RegExp(`(${V})\\.startPolling\\(${bcVar}\\.taskOutput\\.taskId\\)`)
  const nwMatch = nwRe.exec(searchArea)
  if (!nwMatch) {
    console.error('ERROR: Cannot find Nw.startPolling call to determine class name.')
    process.exit(1)
  }
  const nwClass = nwMatch[1]
  console.log(`  Nw class name: ${nwClass}`)

  const initInjection = INIT_MARKER +
    `${nwClass}.startPolling(${bcVar}.taskOutput.taskId);`

  src = src.slice(0, resultAbsIdx) + initInjection + src.slice(resultAbsIdx)

  if (!src.includes(INIT_MARKER)) {
    console.error('ERROR: Part B injection failed.')
    process.exit(1)
  }
  console.log('  Applied.')
}

// ---------------------------------------------------------------------------
// Write and verify
// ---------------------------------------------------------------------------

writeFileSync(cliPath, src)
console.log(`\nPatch applied to ${cliPath}`)

const verify = readFileSync(cliPath, 'utf-8')
console.log(`  ${verify.includes(PATCH_MARKER) ? 'OK' : 'MISSING'} Part A marker`)
console.log(`  ${verify.includes(EARLY_POLL_MARKER) ? 'OK' : 'MISSING'} Part B marker`)

console.log('\ncli.js verified.')
console.log('')
console.log('What this does:')
console.log('  Part A: Writes bash_output messages to stdout on every Bash output chunk.')
console.log('    Fires from the onProgress callback of the command runner.')
console.log('    Rate-limited to 1 message per 200ms per tool_use.')
console.log('    Fields: tool_use_id, output, full_output, total_lines, total_bytes.')
console.log('  Part B: Starts Nw file polling immediately after Bc() spawns the process,')
console.log('    eliminating the 2s HEK timeout delay before output streaming begins.')

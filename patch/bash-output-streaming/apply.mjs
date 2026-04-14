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

const INIT_MARKER = '/*PATCHED:bash-output-init*/'

if (src.includes(PATCH_MARKER) && src.includes(INIT_MARKER)) {
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
// Part B: Emit bash_output_init with output file path right after Bc() returns
// ---------------------------------------------------------------------------
//
// After the Bc() call completes, the shell command object has .taskOutput.path
// (the output file where stdout is being written). We emit this path immediately
// so the GUI can start polling the file without waiting for the 2s HEK timeout.
//
// Pattern: ),<resultVar>=<bcVar>.result;
// We find this right after the onProgress callback closure.

if (src.includes(INIT_MARKER)) {
  console.log('\nPart B (bash_output_init) already applied. Skipping.')
} else {
  console.log('\n--- Part B: bash_output_init after Bc() ---')

  // Find the Bc result assignment after the onProgress we just patched.
  // Pattern: ),<var>=<bcVar>.result;
  // The Bc call variable is right before .result
  const afterPatch = src.slice(anchorMatch.index, anchorMatch.index + 2000)
  const resultRe = new RegExp(`\\),(${V})=(${V})\\.result;`)
  const resultMatch = resultRe.exec(afterPatch)
  if (!resultMatch) {
    console.error('ERROR: Cannot find Bc result assignment after onProgress.')
    process.exit(1)
  }

  const bcVar = resultMatch[2]  // k — the shell command (DH7) instance
  const resultAbsIdx = anchorMatch.index + afterPatch.indexOf(resultMatch[0]) + resultMatch[0].length
  console.log(`  Found .result assignment: ${resultMatch[0]} (bcVar=${bcVar})`)

  // Verify uniqueness near the patch
  const searchArea = src.slice(anchorMatch.index, anchorMatch.index + 2000)
  const allResultMatches = [...searchArea.matchAll(new RegExp(resultRe, 'g'))]
  if (allResultMatches.length > 1) {
    console.error('ERROR: Multiple .result assignments found nearby. Aborting.')
    process.exit(1)
  }

  const initInjection = INIT_MARKER +
    `try{process.stdout.write(JSON.stringify({type:"bash_output_init",` +
      `tool_use_id:${toolUseIdVar},` +
      `output_file:${bcVar}.taskOutput.path` +
    `})+"\\n")}catch(_bi_e){}`

  src = src.slice(0, resultAbsIdx) + initInjection + src.slice(resultAbsIdx)
  console.log('  Injected bash_output_init emit.')
}

// ---------------------------------------------------------------------------
// Write and verify
// ---------------------------------------------------------------------------

writeFileSync(cliPath, src)
console.log(`\nPatch applied to ${cliPath}`)

const verify = readFileSync(cliPath, 'utf-8')
console.log(`  ${verify.includes(PATCH_MARKER) ? 'OK' : 'MISSING'} Part A marker`)
console.log(`  ${verify.includes(INIT_MARKER) ? 'OK' : 'MISSING'} Part B marker`)

console.log('\ncli.js verified.')
console.log('')
console.log('What this does:')
console.log('  Part A: Writes bash_output messages to stdout on every Bash output chunk.')
console.log('    Fires from the onProgress callback of the command runner,')
console.log('    which runs from file polling (every ~1s).')
console.log('    Rate-limited to 1 message per 200ms per tool_use.')
console.log('    Fields: tool_use_id, output, full_output, total_lines, total_bytes.')
console.log('  Part B: Writes bash_output_init with the output file path immediately')
console.log('    after the command runner spawns the process, so the GUI can start')
console.log('    polling the file without waiting for the 2s progress-loop timeout.')
console.log('    Fields: tool_use_id, output_file.')

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

if (src.includes(PATCH_MARKER)) {
  console.log('Already applied. Skipping.')
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

const anchorMatch = anchorRe.exec(src)
if (!anchorMatch) {
  // Try alternative: the ternary might be different or the assignment order changed
  // Fallback: search by the unique "onProgress" inside an async function*UZY context
  console.error('ERROR: Cannot locate onProgress callback in Bc() call.')
  console.error('Use bundle-analyzer to find it:')
  console.error('  bundle-analyzer find cli.js "onProgress" --compact')
  process.exit(1)
}

// Verify uniqueness
const allMatches = [...src.matchAll(new RegExp(anchorRe, 'g'))]
if (allMatches.length > 1) {
  console.error('ERROR: onProgress pattern matched multiple times. Aborting.')
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
// Inject stdout write at the START of the onProgress callback body
// ---------------------------------------------------------------------------
//
// We add rate-limited stdout output right after the opening `{` of onProgress:
//   onProgress(U,c,n,l,O6){ /*PATCHED*/ {rate-limited stdout write} G=U,...

const openBrace = anchorMatch[0].slice(0, anchorMatch[0].indexOf('{') + 1)
// e.g., "onProgress(U,c,n,l,O6){"

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

const oldOpen = openBrace
const insertIdx = src.indexOf(anchorMatch[0]) + openBrace.length

src = src.slice(0, insertIdx) + injection + src.slice(insertIdx)

if (!src.includes(PATCH_MARKER)) {
  console.error('ERROR: Injection failed.')
  process.exit(1)
}

writeFileSync(cliPath, src)
console.log(`\nPatch applied to ${cliPath}`)

const verify = readFileSync(cliPath, 'utf-8')
console.log(`  ${verify.includes(PATCH_MARKER) ? 'OK' : 'MISSING'} Patch marker`)

console.log('\ncli.js verified.')
console.log('')
console.log('What this does:')
console.log('  Writes bash_output messages to stdout on every Bash output chunk.')
console.log('  Fires from the onProgress callback of the command runner (Bc),')
console.log('  which runs BEFORE the 2s progress-loop threshold.')
console.log('  Rate-limited to 1 message per 200ms per tool_use.')
console.log('  Fields: tool_use_id, output, full_output, total_lines, total_bytes.')

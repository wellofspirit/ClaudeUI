/**
 * Patch: bash-output-streaming
 *
 * Forwards real-time Bash output to the SDK stream so GUI clients can render
 * live terminal output while commands are running. (Bash only — the PowerShell
 * tool has a structurally different progress loop; see README.)
 *
 * In the SDK bash tool (the bash async generator — `ats` in 2.1.261), the
 * command runner (`w6` in 2.1.261) is called with an `onProgress` callback
 * that fires on every output chunk. However, the progress data only gets
 * yielded to the SDK consumer AFTER a 2-second timeout (HEK=2000), and even
 * then only through the progress loop. Fast commands (< 2s) never yield any
 * progress.
 *
 * Part A injects a process.stdout.write directly inside that `onProgress`
 * callback, so every output chunk is immediately forwarded to the SDK stream
 * as a `bash_output` message, rate-limited to 1 per 200ms.
 *
 * Part B starts the CLI's own TaskOutput file polling as soon as the runner
 * returns, so onProgress (and therefore Part A) begins firing ~2s earlier.
 *
 * Usage: node patch/bash-output-streaming/apply.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '../..')
const cliPath = resolve(projectRoot, 'vendor/claude-cli/cli.js')

const V = '[\\w$]+'
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

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
// Find the onProgress callback in the bash generator's runner options object
// ---------------------------------------------------------------------------
//
// Pattern shape (stable across versions):
//   onProgress(<5 vars>){<var>=<var>,<var>=<var>,<var>=<var>,<var>=<ternary>;
//     let <var>=<resolverVar>;if(<var>)<resolverVar>=null,<var>()
//   }
//
// We match the structural opening and inject our stdout write at the start.
// The 5 params are (last5Lines, last100Lines, totalLines, totalBytes, hasMore);
// pollProgress() calls it as #s(e.slice(d), e.slice(f), k, r, t<r).
//
// The resolver tail (`let X=Y;if(X)Y=null,X()`) is load-bearing for uniqueness:
// the PowerShell tool has the same four assignments but no resolver, so it is
// the only thing keeping this to one match. Never relax it to "first match".

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
  console.error('ERROR: Cannot locate the bash onProgress callback.')
  console.error('Use bundle-analyzer to find it:')
  console.error('  bundle-analyzer.cmd find cli.js "onProgress(" --compact')
  console.error(
    '  bundle-analyzer.cmd find cli.js \'"tengu_bash_command_explicitly_backgrounded"\' --compact'
  )
  process.exit(1)
}

const fullOutputVar = anchorMatch[1] // 2.1.261: hn — last ~5 lines
const outputVar = anchorMatch[2] // 2.1.261: vt — last ~100 lines
const totalLinesVar = anchorMatch[3] // 2.1.261: Fn
const totalBytesVar = anchorMatch[4] // 2.1.261: Kn
console.log(`Found onProgress at char ${anchorMatch.index}`)
console.log(
  `  Params: fullOutput=${fullOutputVar}, output=${outputVar}, totalLines=${totalLinesVar}, totalBytes=${totalBytesVar}`
)

// Find the toolUseId variable from the enclosing scope. It comes from the bash
// generator's own parameter destructuring — 2.1.261:
//   async function*ats({...,toolUseId:M,attributionMessageId:N,agentId:F,...})
// which is the only `toolUseId:<var>` in the 2000 chars before the anchor.
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

  const injection =
    PATCH_MARKER +
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
// Part B: Start TaskOutput file polling immediately after the runner returns
// ---------------------------------------------------------------------------
//
// For normal bash execution stdout is redirected to a file at the OS level
// (stdio ["pipe",fd,fd]), so the inline writeStdout→onProgress path never
// fires. onProgress can only come from TaskOutput.pollProgress(), and the
// CLI's own `<TaskOutput>.startPolling(...)` call is deferred behind the 2s HEK
// race plus a 1s first-poll interval — ~3s of dead air.
//
// We inject an extra startPolling() call as soon as the command runner has
// returned (process spawned), before the HEK race. The registry's startPolling
// is a Map.set + single shared interval, so calling it twice is a no-op, and
// every exit path still stops it (the generator's own `finally`, or
// ShellCommand.cleanup() → TaskOutput.clear() → stopPolling for the paths that
// return before that try/finally).
//
// Shape in 2.1.261 (chunk-9c0rs7w4.js, generator `ats`):
//
//   let tn,dn,cn,Pt,Mn;
//   try{ ...,tn=await w6(ke,d.signal,"bash",{...,onProgress(...){...},...}) }
//   catch(hn){throw Le?.(),hn}
//   if(tn.status==="killed")Le?.();
//   let gn=tn.result;                       <-- we inject right after this
//   ...
//   aI.startPolling(tn.taskOutput.taskId);  <-- the CLI's own (late) call
//
// <= 2.1.241 kept the runner call and the result assignment in one comma
// expression — `),h=k.result;`. Both shapes are accepted below.
//
// Capture order matters: we read the TaskOutput class binding AND the shell-
// command variable off the CLI's own startPolling call FIRST. `.startPolling(`
// and `.taskOutput.taskId` are property names, so they survive minification,
// and taking the class binding from a call site inside the SAME chunk
// guarantees the identifier we inject is in scope there (post code-splitting a
// class can reach a chunk as an imported binding under a chunk-local alias).

if (src.includes(EARLY_POLL_MARKER)) {
  console.log('\nPart B (early poll) already applied. Skipping.')
} else {
  console.log('\n--- Part B: early TaskOutput.startPolling after the runner returns ---')

  // Search window after the Part A anchor, clamped to the end of the enclosing
  // chunk so nothing can match across a `// @bun-chunk` delimiter. 4000 (was
  // 3000) because Part A has already injected ~450 chars into this window.
  let windowEnd = Math.min(src.length, anchorMatch.index + 4000)
  const chunkEdge = src.indexOf('\n// @bun-chunk ', anchorMatch.index)
  if (chunkEdge !== -1 && chunkEdge < windowEnd) windowEnd = chunkEdge
  const searchArea = src.slice(anchorMatch.index, windowEnd)

  // 1. TaskOutput class binding + shell-command var, from the CLI's own call.
  const pollRe = new RegExp(`(${V})\\.startPolling\\((${V})\\.taskOutput\\.taskId\\)`, 'g')
  const pollMatches = [...searchArea.matchAll(pollRe)]
  if (pollMatches.length !== 1) {
    console.error(
      `ERROR: expected exactly 1 <TaskOutput>.startPolling(<cmd>.taskOutput.taskId) call ` +
        `within ${searchArea.length} chars after onProgress, found ${pollMatches.length}.`
    )
    console.error('Use bundle-analyzer to relocate the bash generator:')
    console.error('  bundle-analyzer.cmd find cli.js ".taskOutput.taskId" --compact')
    process.exit(1)
  }
  const taskOutputClass = pollMatches[0][1] // aI — the TaskOutput class
  const shellCmdVar = pollMatches[0][2] // tn — the ShellCommand instance
  console.log(`  TaskOutput class: ${taskOutputClass}, shellCommand var: ${shellCmdVar}`)

  // 2. The result-promise assignment for that same shell-command variable.
  //    `;let gn=tn.result;` (2.1.261) or `),h=k.result;` (<= 2.1.241).
  const resultRe = new RegExp(`(?:\\),|;let )(${V})=${reEsc(shellCmdVar)}\\.result;`, 'g')
  const resultMatches = [...searchArea.matchAll(resultRe)]
  if (resultMatches.length !== 1) {
    console.error(
      `ERROR: expected exactly 1 \`${shellCmdVar}.result\` assignment after onProgress, ` +
        `found ${resultMatches.length}.`
    )
    process.exit(1)
  }
  const resultMatch = resultMatches[0]
  const resultAbsIdx = anchorMatch.index + resultMatch.index + resultMatch[0].length
  console.log(`  Found .result assignment: ${resultMatch[0]} (resultVar=${resultMatch[1]})`)

  const initInjection =
    EARLY_POLL_MARKER + `${taskOutputClass}.startPolling(${shellCmdVar}.taskOutput.taskId);`

  src = src.slice(0, resultAbsIdx) + initInjection + src.slice(resultAbsIdx)

  if (!src.includes(EARLY_POLL_MARKER)) {
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
const partAok = verify.includes(PATCH_MARKER)
const partBok = verify.includes(EARLY_POLL_MARKER)
console.log(`  ${partAok ? 'OK' : 'MISSING'} Part A marker`)
console.log(`  ${partBok ? 'OK' : 'MISSING'} Part B marker`)

// A missing marker after write means an injection silently no-op'd (e.g. an
// upstream reshape moved an anchor). Fail the build rather than shipping a
// half-patched cli.js whose bash output never streams — apply-success is not
// behavioural correctness (this was the only patch whose final verify was
// non-fatal).
if (!partAok || !partBok) {
  console.error('\nVerification FAILED: expected patch marker(s) absent after write.')
  process.exit(1)
}

console.log('\ncli.js verified.')
console.log('')
console.log('What this does:')
console.log('  Part A: Writes bash_output messages to stdout on every Bash output chunk.')
console.log('    Fires from the onProgress callback of the command runner.')
console.log('    Rate-limited to 1 message per 200ms per tool_use.')
console.log('    Fields: tool_use_id, output, full_output, total_lines, total_bytes.')
console.log('  Part B: Starts TaskOutput file polling as soon as the command runner returns,')
console.log('    eliminating the 2s HEK timeout delay before output streaming begins.')

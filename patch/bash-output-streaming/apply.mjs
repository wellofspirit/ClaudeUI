/**
 * Patch: bash-output-streaming
 *
 * Forwards real-time Bash output to the SDK stream so GUI clients can render
 * live terminal output while commands are running. (Bash only — the PowerShell
 * tool has a structurally different progress loop; see README.)
 *
 * The Bash tool's async generator hands the command runner an onProgress
 * callback that fires on every output poll. Its data only reaches the SDK
 * consumer through the generator's own progress loop, which starts after a
 * 2-second race, so fast commands (< 2s) never yield any progress.
 *
 * Part A injects a process.stdout.write at the start of that callback's body,
 * so every output chunk is forwarded to the SDK stream as a `bash_output`
 * message, rate-limited to 1 per 200ms per tool use.
 *
 * Part B starts the CLI's own TaskOutput file polling as soon as the runner
 * returns, so onProgress (and therefore Part A) begins firing ~2s earlier.
 *
 * This script never calls process.exit(): it sets process.exitCode and lets
 * Node exit by itself. See README "Exit without process.exit()".
 *
 * Usage: node patch/bash-output-streaming/apply.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'

import { CHUNK_DELIM_PREFIX } from '../../scripts/lib/chunk-format.mjs'
import { cliJsPath } from '../../scripts/lib/cli-paths.mjs'

const V = '[\\w$]+'
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const PATCH_MARKER = '/*PATCHED:bash-output-streaming*/'
const EARLY_POLL_MARKER = '/*PATCHED:bash-early-poll*/'
const POLL_FLAG_MARKER = '/*PATCHED:bash-poll-flag*/'
const CHUNK_DELIM = `\n${CHUNK_DELIM_PREFIX}`

// Every search after the anchor runs over a slice of at most this many chars,
// clamped to the enclosing chunk, so nothing can match across a `// @bun-chunk`
// delimiter and no search scans more than it needs to.
const GEN_LOOKBACK = 6000 // bash generator head -> anchor: 1533 (2.1.326), 1358 (2.1.330)
const GEN_PARAMS_MAX = 3000 // the generator's destructured parameter list
const WRAPPER_SITE_WINDOW = 4000 // anchor -> `onProgress:<wrapper>.call`: ~350 (2.1.330)
const BASH_CALL_LOOKBACK = 400 // `"bash",{` -> the onProgress key: ~95
const PART_B_WINDOW = 6000 // anchor -> the CLI's own startPolling: ~3700 after Part A (2.1.330)

// ---------------------------------------------------------------------------
// The Bash onProgress callback (Part A anchor)
// ---------------------------------------------------------------------------
//
// The callback's body has been the same since 2.1.97 (2.1.321 prepended a guard):
//   <a>=<p1>,<b>=<p2>,<c>=<p3>,<d>=<p5>?<p4>:0;let <e>=<r>;if(<e>)<r>=null,<e>()
// The 5 params are (last5Lines, last100Lines, totalLines, totalBytes, hasMore);
// pollProgress() calls it as #s(e.slice(d), e.slice(f), k, r, t<r).
//
// The resolver tail (`let X=Y;if(X)Y=null,X()`) is load-bearing for uniqueness:
// the PowerShell tool has the same four assignments but no resolver, so it is
// the only thing keeping this to one match. Never relax it to "first match".
//
// Two shapes carry that body:
//
// 2.1.330+: an arrow handed to a disposable wrapper, whose `.call` is the option:
//   using ws=new _eo((fi,fs,hi,Ea,gl)=>{lo=fi,Dn=fs,Ho=hi,To=gl?Ea:0;let Ii=Jo;if(Ii)Jo=null,Ii()});
//   ... ,"bash",{...,onProgress:ws.call,...}
//   class _eo{#e;constructor(e){this.#e=e}call=(...e)=>this.#e?.(...e);[Symbol.dispose](){this.#e=null}}
// The wrapper is the CLI's late-call guard now: when the generator's scope exits
// (`using`), dispose nulls the arrow and every later poll is dropped. Part A goes
// INSIDE the arrow, so a call the CLI drops never reaches the SDK stream either.
//
// <= 2.1.326: a method on the runner options object, `onProgress(a,b,c,d,e){...}`.
// 2.1.321 alone opened its body with a late-callback guard that drops the first
// stray call once the shell command is killed/completed:
//   onProgress(a,b,c,d,e){if(!X&&!Y&&(Z.status==="killed"||Z.status==="completed")){Y=!0;return}...
// It is optional in the anchor, and Part A goes AFTER it, for the same reason.
const lateGuard =
  `if\\(!${V}&&!${V}&&\\(${V}\\.status==="killed"\\|\\|${V}\\.status==="completed"\\)\\)` +
  `\\{${V}=!0;return\\}`

// Groups 1-5: the callback params. 6-9: the assigned closure vars. 10: the
// resolver temp declared with `let` in the body. 11: the resolver variable.
// Neither head adds a capture group, so the numbering holds for both shapes.
const P5 = `\\((${V}),(${V}),(${V}),(${V}),(${V})\\)`
const BODY =
  `(${V})=\\1,(${V})=\\2,(${V})=\\3,(${V})=\\5\\?\\4:0;` +
  `let (${V})=(${V});if\\(\\10\\)\\11=null,\\10\\(\\)`

const SHAPES = [
  {
    name: 'arrow handed to a disposable wrapper (2.1.330+)',
    head: `new ${V}\\(${P5}=>\\{`,
    tail: '\\}\\)',
    wrapped: true
  },
  {
    name: 'onProgress method on the runner options (<= 2.1.326)',
    head: `onProgress${P5}\\{(?:${lateGuard})?`,
    tail: '\\}',
    wrapped: false
  }
]

function fail(...lines) {
  for (const line of lines) console.error(line)
  return 1
}

/** [start, end) of the chunk that contains `idx` (the whole file when there are no delimiters). */
function chunkAround(src, idx) {
  const before = src.lastIndexOf(CHUNK_DELIM, idx)
  const after = src.indexOf(CHUNK_DELIM, idx)
  return { start: before === -1 ? 0 : before + 1, end: after === -1 ? src.length : after }
}

/**
 * Every callback with the Bash body, pristine or already carrying Part A, in
 * either shape. A pristine match needs the whole body right after the head; a
 * patched one has the marker there instead, so one callback never counts twice.
 */
function findCallbacks(src) {
  const hits = []
  for (const shape of SHAPES) {
    const pristineRe = new RegExp(shape.head + BODY + shape.tail, 'g')
    const patchedRe = new RegExp(shape.head + reEsc(PATCH_MARKER), 'g')
    for (const m of src.matchAll(pristineRe)) hits.push({ shape, m, patched: false })
    for (const m of src.matchAll(patchedRe)) hits.push({ shape, m, patched: true })
  }
  return hits
}

/**
 * Where the callback becomes the runner's `onProgress` option. The method shape
 * is the option itself. The wrapped shape must be bound (`X=new W(...)`) and
 * `X.call` passed as `onProgress:` exactly once shortly after: that proves the
 * arrow is the runner's callback and not some other five-argument arrow.
 */
function onProgressSite(src, hit, chunk) {
  if (!hit.shape.wrapped) return { at: hit.m.index }
  const before = src.slice(Math.max(chunk.start, hit.m.index - 64), hit.m.index)
  const bind = new RegExp(`(?:^|[^\\w$.])(${V})=$`).exec(before)
  if (!bind) return { error: `the wrapper is not bound to a variable: ...${before.slice(-40)}` }
  const area = src.slice(hit.m.index, Math.min(chunk.end, hit.m.index + WRAPPER_SITE_WINDOW))
  const siteRe = new RegExp(`onProgress:${reEsc(bind[1])}\\.call[,}]`, 'g')
  const sites = [...area.matchAll(siteRe)]
  if (sites.length !== 1) {
    return {
      error: `expected exactly 1 \`onProgress:${bind[1]}.call\` within ${area.length} chars after the wrapper, found ${sites.length}`
    }
  }
  return { at: hit.m.index + sites[0].index, wrapperVar: bind[1] }
}

/**
 * The toolUseId variable Part A emits. It must be the Bash generator's own
 * destructured parameter (2.1.330: `async function*jGi({...,toolUseId:Ve,...}){`),
 * so it is read from the nearest `async function*` head before the anchor, never
 * from whatever `toolUseId:` happens to be nearby (2.1.330 has `toolUseId:g.toolUseId`
 * and `toolUseId:Ve` in calls around it). The callback's own params and its `let`
 * temp must not reuse the name: a minifier may, since the callback never reads it,
 * and the injection would then read the shadowing binding (or hit the `let` TDZ).
 */
function bindToolUseId(src, hit, chunk) {
  const back = src.slice(Math.max(chunk.start, hit.m.index - GEN_LOOKBACK), hit.m.index)
  const at = back.lastIndexOf('async function*')
  if (at === -1)
    return { error: `no \`async function*\` within ${back.length} chars before the anchor` }
  const head = new RegExp(`^async function\\*[\\w$]*\\(\\{([^(){}]*)\\}\\)\\{`).exec(
    back.slice(at, at + GEN_PARAMS_MAX)
  )
  if (!head) {
    return { error: 'the enclosing async generator does not take one flat destructured object' }
  }
  const ids = [...head[1].matchAll(new RegExp(`(?:^|,)toolUseId:(${V})(?=,|$)`, 'g'))]
  if (ids.length !== 1) {
    return { error: `expected 1 toolUseId in the generator's parameters, found ${ids.length}` }
  }
  const name = ids[0][1]
  const local = [1, 2, 3, 4, 5, 10].map((g) => hit.m[g])
  if (local.includes(name)) {
    return {
      error: `toolUseId var \`${name}\` is shadowed inside the callback (${local.join(',')})`
    }
  }
  return { name }
}

function main() {
  const cliPath = cliJsPath()

  let src
  try {
    src = readFileSync(cliPath, 'utf-8')
  } catch {
    return fail(`ERROR: Cannot read ${cliPath}`)
  }

  console.log(`Read ${cliPath} (${(src.length / 1024 / 1024).toFixed(1)} MB)`)

  if (src.includes(PATCH_MARKER) && src.includes(EARLY_POLL_MARKER)) {
    console.log('Already applied (both parts). Skipping.')
    return 0
  }

  const hits = findCallbacks(src)
  if (hits.length !== 1) {
    return fail(
      hits.length === 0
        ? 'ERROR: Cannot locate the bash onProgress callback.'
        : `ERROR: the bash onProgress callback shape matched ${hits.length} times ` +
            `(at ${hits.map((h) => h.m.index).join(', ')}). Aborting.`,
      'Use bundle-analyzer to find it:',
      '  bundle-analyzer.cmd find cli.js "onProgress:" --compact',
      '  bundle-analyzer.cmd find cli.js \'"tengu_bash_command_explicitly_backgrounded"\' --compact'
    )
  }
  const hit = hits[0]
  const anchorIdx = hit.m.index
  const chunk = chunkAround(src, anchorIdx)
  console.log(`Found the bash onProgress callback (${hit.shape.name}) at char ${anchorIdx}`)

  const site = onProgressSite(src, hit, chunk)
  if (site.error) return fail(`ERROR: ${site.error}.`)
  if (site.wrapperVar)
    console.log(`  Wrapper: ${site.wrapperVar}, passed as onProgress:${site.wrapperVar}.call`)

  // The option must sit in the Bash runner call, `<runner>(cmd,signal,"bash",{...,onProgress...`.
  // PowerShell's call reads `"powershell",{`; this keeps the anchor on a string literal too.
  const callHead = src.slice(Math.max(chunk.start, site.at - BASH_CALL_LOOKBACK), site.at)
  if (!callHead.includes(',"bash",{')) {
    return fail(
      `ERROR: no \`,"bash",{\` in the ${callHead.length} chars before the onProgress option; ` +
        'this is not the Bash runner call.'
    )
  }

  // ---------------------------------------------------------------------------
  // Part A: Inject stdout write at the START of the callback body
  // ---------------------------------------------------------------------------

  if (hit.patched) {
    console.log('\nPart A (onProgress hook) already applied. Skipping.')
  } else if (src.includes(PATCH_MARKER)) {
    return fail('ERROR: the Part A marker is present, but not at the bash onProgress callback.')
  } else {
    console.log('\n--- Part A: onProgress hook ---')

    const [, last5Var, last100Var, totalLinesVar, totalBytesVar] = hit.m
    console.log(
      `  Params: last5=${last5Var}, last100=${last100Var}, totalLines=${totalLinesVar}, totalBytes=${totalBytesVar}`
    )
    const toolUse = bindToolUseId(src, hit, chunk)
    if (toolUse.error) return fail(`ERROR: Cannot bind toolUseId: ${toolUse.error}.`)
    const toolUseIdVar = toolUse.name
    console.log(`  toolUseId var: ${toolUseIdVar} (the generator's destructured parameter)`)

    // After the opening brace and, for the 2.1.321 method, the late-callback guard.
    const headLen = new RegExp(`^${hit.shape.head}`).exec(hit.m[0])[0].length

    // `output` is the larger window (param 2) and `full_output` the smaller one
    // (param 1); see README "Message Format" before renaming.
    const injection =
      PATCH_MARKER +
      `{let _bo_now=Date.now();` +
      `if(!globalThis._bo_map)globalThis._bo_map=new Map;` +
      `let _bo_k=${toolUseIdVar}||"",_bo_last=globalThis._bo_map.get(_bo_k)||0;` +
      `if(_bo_now-_bo_last>=200){` +
      `globalThis._bo_map.set(_bo_k,_bo_now);` +
      `try{process.stdout.write(JSON.stringify({type:"bash_output",` +
      `tool_use_id:${toolUseIdVar},` +
      `output:${last100Var},` +
      `full_output:${last5Var},` +
      `total_lines:${totalLinesVar},` +
      `total_bytes:${totalBytesVar}` +
      `})+"\\n")}catch(_bo_e){}` +
      `}}`

    const insertIdx = anchorIdx + headLen
    src = src.slice(0, insertIdx) + injection + src.slice(insertIdx)
    console.log('  Applied.')
  }

  // ---------------------------------------------------------------------------
  // Part B: Start TaskOutput file polling immediately after the runner returns
  // ---------------------------------------------------------------------------
  //
  // For normal bash execution stdout is redirected to a file at the OS level
  // (stdio ["pipe",fd,fd]), so the inline writeStdout→onProgress path never
  // fires. onProgress can only come from TaskOutput.pollProgress(), and the
  // CLI's own `<TaskOutput>.startPolling(...)` call is deferred behind the 2s
  // race plus a 1s first-poll interval — ~3s of dead air.
  //
  // We inject an extra startPolling() call as soon as the command runner has
  // returned (process spawned), before the race. The registry's startPolling is
  // a Map.set + single shared interval, so calling it twice is a no-op, and
  // every exit path still stops it (the generator's own `finally`, or
  // ShellCommand.cleanup() → TaskOutput.clear() → stopPolling for the paths that
  // return before that try/finally).
  //
  // Shape in 2.1.330 (darwin, chunk-bzyb60p0.js, generator `jGi`):
  //
  //   let wr,rs,hs,Es;
  //   try{ ...,wr=await Xrt(ln,be.signal,"bash",{...,onProgress:ws.call,...}) }
  //   catch(fi){throw Lo?.(),fi}
  //   let Do=...;if(wr.status==="killed")Lo?.();
  //   let Ms=wr.result;                         <-- we inject right after this
  //   ...
  //   one.startPolling(wr.taskOutput.taskId);   <-- the CLI's own (late) call
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
    // chunk (re-read: Part A may have just grown it by ~450 chars).
    const windowEnd = Math.min(chunkAround(src, anchorIdx).end, anchorIdx + PART_B_WINDOW)
    const searchArea = src.slice(anchorIdx, windowEnd)

    // 1. TaskOutput class binding + shell-command var, from the CLI's own call.
    // 2.1.321 passed a second arg, `startPolling(id,so)`: `startPolling(e,n=!0)` stored it as the
    // "read the output file" flag. `so` was computed just before as `so=!(n&&Mji())`, where Mji is
    // a server-side gate; see the pin below. 2.1.326 and 2.1.330 are one-arg again.
    const pollRe = new RegExp(
      `(${V})\\.startPolling\\((${V})\\.taskOutput\\.taskId(?:,(${V}))?\\)`,
      'g'
    )
    const pollMatches = [...searchArea.matchAll(pollRe)]
    if (pollMatches.length !== 1) {
      return fail(
        `ERROR: expected exactly 1 <TaskOutput>.startPolling(<cmd>.taskOutput.taskId) call ` +
          `within ${searchArea.length} chars after onProgress, found ${pollMatches.length}.`,
        'Use bundle-analyzer to relocate the bash generator:',
        '  bundle-analyzer.cmd find cli.js ".taskOutput.taskId" --compact'
      )
    }
    const taskOutputClass = pollMatches[0][1] // one — the TaskOutput class
    const shellCmdVar = pollMatches[0][2] // wr — the ShellCommand instance
    console.log(`  TaskOutput class: ${taskOutputClass}, shellCommand var: ${shellCmdVar}`)

    // 2. The result-promise assignment for that same shell-command variable.
    //    `;let Ms=wr.result;` (2.1.261+) or `),h=k.result;` (<= 2.1.241).
    const resultRe = new RegExp(`(?:\\),|;let )(${V})=${reEsc(shellCmdVar)}\\.result;`, 'g')
    const resultMatches = [...searchArea.matchAll(resultRe)]
    if (resultMatches.length !== 1) {
      return fail(
        `ERROR: expected exactly 1 \`${shellCmdVar}.result\` assignment after onProgress, ` +
          `found ${resultMatches.length}.`
      )
    }
    const resultMatch = resultMatches[0]
    const resultAbsIdx = anchorIdx + resultMatch.index + resultMatch[0].length
    console.log(`  Found .result assignment: ${resultMatch[0]} (resultVar=${resultMatch[1]})`)

    // 3. Pin the CLI's read-the-file flag (2.1.321 only so far). `so=!(n&&GATE())` turns false
    //    when a server-side gate flips on; startPolling then stores false, pollProgress stops
    //    reading the output file and calls onProgress("","",0,0,!1), so Part A would forward empty
    //    bash_output frames. Rewrite it to `so=!0` (2.1.319 behaviour). Keep the variable: the
    //    late-callback guard and the rest of the generator read it. Anchored on the CLI's own
    //    call: the assignment's target must be that call's 2nd argument (backreference).
    //    One-arg call: nothing to pin.
    let flagPatch = null
    if (pollMatches[0][3] !== undefined) {
      const flagRe = new RegExp(
        `(${V})=!\\((${V})&&${V}\\(\\)\\),` +
          `${reEsc(taskOutputClass)}\\.startPolling\\(${reEsc(shellCmdVar)}\\.taskOutput\\.taskId,\\1\\)`,
        'g'
      )
      const flagMatches = [...searchArea.matchAll(flagRe)]
      if (flagMatches.length !== 1) {
        return fail(
          `ERROR: expected exactly 1 \`<flag>=!(<n>&&<gate>()),${taskOutputClass}.startPolling(...,<flag>)\` ` +
            `site after onProgress, found ${flagMatches.length}.`
        )
      }
      const fm = flagMatches[0]
      const assignEnd = fm[0].indexOf(',' + taskOutputClass + '.startPolling')
      flagPatch = {
        start: anchorIdx + fm.index,
        end: anchorIdx + fm.index + assignEnd,
        text: `${POLL_FLAG_MARKER}${fm[1]}=!0`
      }
      console.log(`  Pinning poll flag: ${fm[0].slice(0, assignEnd)} -> ${fm[1]}=!0`)
    } else {
      console.log('  One-arg startPolling (all but 2.1.321): no poll flag to pin.')
    }

    const initInjection =
      EARLY_POLL_MARKER + `${taskOutputClass}.startPolling(${shellCmdVar}.taskOutput.taskId);`

    // The flag site is after the .result assignment: apply it first so offsets hold.
    if (flagPatch) {
      if (flagPatch.start < resultAbsIdx) {
        return fail('ERROR: poll flag site precedes the .result assignment; unexpected shape.')
      }
      src = src.slice(0, flagPatch.start) + flagPatch.text + src.slice(flagPatch.end)
    }
    src = src.slice(0, resultAbsIdx) + initInjection + src.slice(resultAbsIdx)
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
  // behavioural correctness.
  if (!partAok || !partBok) {
    return fail('\nVerification FAILED: expected patch marker(s) absent after write.')
  }

  console.log('\ncli.js verified.')
  console.log('')
  console.log('What this does:')
  console.log('  Part A: Writes bash_output messages to stdout on every Bash output chunk.')
  console.log('    Fires from the onProgress callback of the command runner.')
  console.log('    Rate-limited to 1 message per 200ms per tool_use.')
  console.log('    Fields: tool_use_id, output, full_output, total_lines, total_bytes.')
  console.log('  Part B: Starts TaskOutput file polling as soon as the command runner returns,')
  console.log('    eliminating the 2s timeout delay before output streaming begins.')
  return 0
}

// Never process.exit() here, not even on failure. With the ~60 MB bundle in the
// heap, Node 26's process.exit() can deadlock: it tears the V8 platform down and
// joins its worker threads while one of them waits for a GC that only the
// exiting main thread could run (README "Exit without process.exit()"). Setting
// process.exitCode and returning lets Node dispose the isolate first, which wakes
// that worker. The catch keeps an unexpected throw off the same exit path.
try {
  process.exitCode = main()
} catch (err) {
  console.error(err)
  process.exitCode = 1
}

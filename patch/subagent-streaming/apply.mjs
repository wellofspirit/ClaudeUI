/**
 * Patch: subagent-streaming
 *
 * Makes sub-agent messages (thinking, text, tool_use, tool_result) and
 * stream events (thinking_delta, text_delta) visible in the SDK stream.
 * Also patches the .output file writer for background agents to include
 * thinking blocks.
 *
 * See README.md for full analysis.
 *
 * Usage: node patch/subagent-streaming/apply.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '../..')
const cliPath = resolve(projectRoot, 'vendor/claude-cli/cli.js')

// Minified variable names can contain $ — use [\\w$] instead of \\w
const V = '[\\w$]+'

// Escape captured minified identifiers before interpolating into regex
// templates. They may contain `$` (regex end-of-input anchor) or other
// metachars that silently break pattern matching.
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Literal (first-occurrence) replace. String.prototype.replace interprets `$&`,
// `$1`, `` $` `` etc. in the REPLACEMENT — and minified identifiers may contain
// `$` — so never build injected code with it.
const litReplace = (hay, needle, rep) => {
  const i = hay.indexOf(needle)
  return i === -1 ? hay : hay.slice(0, i) + rep + hay.slice(i + needle.length)
}

// ---------------------------------------------------------------------------
// Chunk scoping (v2.1.261+)
//
// <= v2.1.241 shipped ONE monolithic minified bundle. v2.1.261 ships ~1.6k
// separate minified ESM chunks; the vendored cli.js is their concatenation in
// module-graph order, each chunk preceded by a delimiter line:
//   // @bun-chunk B:/~BUN/root/chunk-xxxxxxxx.js
// Minified identifiers are CHUNK-LOCAL: the same short name means unrelated
// things in different chunks (`Hr` alone has five independent definitions), and
// a helper a chunk uses is often an IMPORTED binding aliased per chunk. So any
// lookback window, and any "find this helper's definition" search, must be
// clamped to the chunk that contains the anchor — otherwise a lookback can walk
// into a neighbouring module and capture a name that is not in scope at the
// injection site. On a pre-split bundle there are no delimiters and the whole
// file behaves as a single chunk, so these helpers are no-ops there.
// ---------------------------------------------------------------------------

const CHUNK_MARK = '// @bun-chunk '

/**
 * The chunk containing `off` in the CURRENT `src`. Recomputed per call because
 * `src` grows as patches are injected (offsets shift, chunk membership does not).
 */
function chunkAt(off) {
  const head = src.lastIndexOf('\n' + CHUNK_MARK, off)
  // head === -1 means either the very first chunk (its delimiter sits at offset
  // 0, with no leading newline) or a monolithic pre-split bundle.
  if (head === -1 && !src.startsWith(CHUNK_MARK)) {
    return { name: '(monolithic bundle)', start: 0, end: src.length }
  }
  const delimStart = head === -1 ? 0 : head + 1
  const nameEnd = src.indexOf('\n', delimStart)
  const next = src.indexOf('\n' + CHUNK_MARK, off)
  return {
    name: src.slice(delimStart + CHUNK_MARK.length, nameEnd),
    start: nameEnd + 1,
    end: next === -1 ? src.length : next + 1
  }
}

/** `src.slice(off - size, off)` clamped so it can never reach into a previous chunk. */
function prefixWindow(off, size) {
  const { start } = chunkAt(off)
  return src.slice(Math.max(start, off - size), off)
}

/** `src.slice(off, off + size)` clamped so it can never run into the next chunk. */
function suffixWindow(off, size) {
  const { end } = chunkAt(off)
  return src.slice(off, Math.min(end, off + size))
}

/**
 * Resolve the session-id getter that is IN SCOPE at `off`, for injections that
 * emit `session_id:<fn>()`.
 *
 * Must not be searched globally. In v2.1.261 the getter is an imported binding
 * (`import{...,Y,...}from"…chunk-….js"`) whose local alias differs per chunk, so
 * a whole-file `session_id:X()` scan resolved to `s` — Zod's `string()` builder
 * from an unrelated schema chunk, which is also imported (under a different
 * meaning) into the injection chunk. That compiles and then emits a Zod object
 * as `session_id` at runtime.
 *
 * So: scan only the anchor's own chunk, and only sites that sit next to
 * `parent_tool_use_id` (i.e. real SDK-message yields, not schema builders).
 * Require a single unambiguous name.
 */
function findSessionIdFn(off, label) {
  const { name: chunkName, start, end } = chunkAt(off)
  const body = src.slice(start, end)
  const counts = new Map()
  for (const m of body.matchAll(/session_id:([\w$]+)\(\)/g)) {
    const near = body.slice(Math.max(0, m.index - 400), m.index + 400)
    if (!near.includes('parent_tool_use_id')) continue
    counts.set(m[1], (counts.get(m[1]) || 0) + 1)
  }
  if (counts.size !== 1) {
    console.error(
      `ERROR: ${counts.size} candidate session-id functions for ${label} in chunk ${chunkName} ` +
        `(expected 1): ${[...counts.entries()].map(([n, c]) => `${n}()x${c}`).join(', ') || 'none'}. ` +
        'Aborting rather than emitting an out-of-scope binding.'
    )
    process.exit(1)
  }
  const [[fn, hits]] = [...counts.entries()]
  console.log(`${label} session ID function: ${fn}() (${hits} SDK yields in chunk ${chunkName})`)
  return fn
}

// ---------------------------------------------------------------------------
// Step 1: Read cli.js
// ---------------------------------------------------------------------------

let src
try {
  src = readFileSync(cliPath, 'utf-8')
} catch (err) {
  console.error(`ERROR: Cannot read ${cliPath}`)
  console.error('Did you run: node scripts/extract-cli.mjs ?')
  process.exit(1)
}

console.log(`Read ${cliPath} (${(src.length / 1024 / 1024).toFixed(1)} MB)`)

const versionMatch = src.match(/Version:\s*([\d.]+)/)
if (versionMatch) {
  console.log(`CLI version: ${versionMatch[1]}`)
}

let patchCount = 0

// ===========================================================================
// Patch F: Yield stream_event from cR without collecting it
//
// cR() is the sub-agent query loop generator. It iterates fR() (which
// yields stream_event, assistant, user, etc.) but filters what it yields
// via RVY(). stream_event is NOT in RVY's whitelist.
//
// We can't just add stream_event to RVY because the yield line also
// pushes to the collection array x[] and records to transcript via E51.
// stream_event messages lack .message/.uuid properties that those
// operations expect.
//
// Instead, we inject a check BEFORE the RVY gate to yield stream_events
// directly without collecting or recording them:
//
// Before:
//   if(RVY($1))x.push($1),await E51(...),...,yield $1
//
// After:
//   if($1.type==="stream_event"){yield $1}else
//   if(RVY($1))x.push($1),await E51(...),...,yield $1
// ===========================================================================

console.log('\n--- Patch F: cR yield — stream_event bypass before RVY ---')

const patchFMarker = '/*PATCHED:subagent-F*/'

if (src.includes(patchFMarker)) {
  console.log('Already applied. Skipping.')
} else {
  // Find RVY function by its unique type-check pattern
  const rvyRe = new RegExp(
    `function (${V})\\(${V}\\)\\{` +
      `return ${V}\\.type==="assistant"\\|\\|` +
      `${V}\\.type==="user"\\|\\|` +
      `${V}\\.type==="progress"\\|\\|` +
      `${V}\\.type==="system"&&"subtype"in ${V}&&${V}\\.subtype==="compact_boundary"` +
      `\\}`
  )
  const rvyMatch = src.match(rvyRe)
  if (!rvyMatch) {
    console.error('ERROR: Cannot locate RVY function.')
    process.exit(1)
  }
  const rvyName = rvyMatch[1]
  console.log(`Found RVY function: ${rvyName}()`)

  // Find the RVY call site. Known patterns:
  //
  // v2.1.45 (old): if(RVY(MSG))ARR.push(MSG),
  // v2.1.47:       if(RVY(MSG))await TRANSCRIPT([MSG],...
  // v2.1.87:       if(RVY(MSG)){if(await TRANSCRIPT([MSG],...
  //
  // We try patterns newest first.
  const rvyNameRe = reEsc(rvyName)
  const bracedCallRe = new RegExp(`if\\(${rvyNameRe}\\((${V})\\)\\)\\{`)
  const awaitCallRe = new RegExp(`if\\(${rvyNameRe}\\((${V})\\)\\)await `)
  const oldCallRe = new RegExp(`if\\(${rvyNameRe}\\((${V})\\)\\)(${V})\\.push\\(\\1\\),`)
  const callMatch = src.match(bracedCallRe) || src.match(awaitCallRe) || src.match(oldCallRe)
  if (!callMatch) {
    console.error('ERROR: Cannot locate RVY call site in cR.')
    process.exit(1)
  }

  const oldStr = callMatch[0]
  const msgVar = callMatch[1]
  const idx = src.indexOf(oldStr)

  // Verify it's inside the sub-agent query generator (cR in v2.1.39, WR in v2.1.47).
  // `yield` can only belong to the nearest enclosing generator, so a preceding
  // `async function*` decl in the window confirms the injected `yield` is legal.
  // v2.1.219 grew the generator body: the decl now sits ~10.9k chars before the
  // RVY gate (was <10k), so widen the window to 20000 to keep the sanity check.
  // v2.1.261: ~14.5k (`async function*dw(`). The window is clamped to the
  // anchor's chunk so it can never pick up a generator from a neighbouring
  // module in the concatenated bundle.
  const before = prefixWindow(idx, 20000)
  if (!/async function\*[\w$]+\(/.test(before)) {
    console.error('ERROR: RVY call site is not inside an async generator. Aborting.')
    process.exit(1)
  }

  if (src.indexOf(oldStr, idx + 1) !== -1) {
    console.error('ERROR: Multiple matches for Patch F. Aborting.')
    process.exit(1)
  }

  // Inject stream_event bypass before the RVY gate.
  // The original "if(RVY(MSG))..." is preserved unchanged after our "else".
  const newStr = `${patchFMarker}if(${msgVar}.type==="stream_event"){yield ${msgVar}}else ` + oldStr

  src = src.slice(0, idx) + newStr + src.slice(idx + oldStr.length)
  patchCount++
  console.log(`Applied at char ${idx}. msg=${msgVar}`)
}

// ===========================================================================
// Patch F2: Yield stream_event past the IVe/fHo streaming pre-filter (v2.1.197+)
//
// In v2.1.197 the sub-agent query generator gained a pre-filter ABOVE the
// RVY gate that Patch F targets:
//
//   for await(let MSG of b4({...})){
//     if(CB?.(),IVe(MSG)){FHO(MSG,CFG,N),yield*BUF,BUF.length=0;continue}
//     ...
//     /*PATCHED:subagent-F*/if(MSG.type==="stream_event"){yield MSG}else  ← now DEAD for stream_event
//     if(RVY(MSG))...
//   }
//
// IVe(MSG) === Bam.has(MSG.type), and Bam/Fam INCLUDES "stream_event". So
// stream_events hit this branch first: FHO() consumes them for display
// side-effects (onStreamingText etc.) and the branch `continue`s — they
// never reach Patch F's yield, and thus never reach the `nt` onMessage
// callback (Patch B) or BVe. That is why no sub-agent stream_event ever
// surfaces. Patch F's RVY-gate injection is now unreachable for stream_event
// but is kept (harmless, marker-verified, still correct on older CLIs).
//
// Fix: inside that IVe branch, after FHO's side-effects, also `yield MSG`
// when it is a stream_event, BEFORE flushing BUF and continuing. The yielded
// stream_event then flows to `nt` (Patch B, sync) / BVe's h.push (Patch E,
// background) exactly as designed.
//
// Anchor: `IVe(MSG)){FHO(MSG,CFG,N),yield*BUF,BUF.length=0;continue}`.
// We only patch when it exists (older CLIs without the pre-filter skip it —
// Patch F alone was sufficient there).
//
// v2.1.261 interposed a stream-mode bookkeeping statement between the branch
// head and the fHo call, so the branch is no longer one contiguous string:
//
//   if(en?.(),bq(Rn)){
//     if(tn&&Rn.type==="stream_event"){                       ← NEW in v2.1.261
//       if(Rn.event.type==="message_start")Gm();
//       else if(Rn.event.type==="message_stop")km()
//     }
//     lut(Rn,Jd,ZS),yield*la,la.length=0;continue
//   }
//
// So the anchor is matched in TWO parts, the same way Patch E's BVe anchor is:
// the (unique) fHo+flush TAIL, then the IVe gate HEAD required within a small
// window before it. Only the tail is rewritten — whatever upstream splices into
// the gap is left verbatim, so the next interposed statement won't break this.
// ===========================================================================

console.log('\n--- Patch F2: yield stream_event past IVe/fHo pre-filter ---')

const patchF2Marker = '/*PATCHED:subagent-F2*/'
// Older CLIs (< v2.1.197) have no IVe/fHo pre-filter; F2 is then inapplicable
// and Patch F's RVY-gate injection alone forwards stream_events.
let patchF2Applicable = true

if (src.includes(patchF2Marker)) {
  console.log('Already applied. Skipping.')
} else {
  // TAIL: FHO(MSG,CFG1,CFG2),yield*BUF,BUF.length=0;continue}
  //   FHO = the streaming display handler, CFG1/CFG2 = its config args,
  //   BUF  = the buffer the handler fills, flushed and cleared on every message.
  const preFilterTailRe = new RegExp(
    `(${V})\\((${V}),(${V}),(${V})\\),yield\\*(${V}),\\5\\.length=0;continue\\}`
  )
  // HEAD: if(CB?.(),IVe(MSG)){
  //   CB = optional-call progress callback, IVe = the Bam/DCo `.has(MSG.type)` gate.
  const preFilterHeadRe = new RegExp(`if\\((${V})\\?\\.\\(\\),(${V})\\((${V})\\)\\)\\{`, 'g')
  /** Chars before the tail in which the IVe gate head must appear (117 in v2.1.261). */
  const F2_HEAD_WINDOW = 600

  const tailMatch = src.match(preFilterTailRe)

  if (!tailMatch) {
    // Distinguish "this CLI has no pre-filter" (pre-v2.1.197 — F2 genuinely
    // inapplicable) from "the pre-filter exists but was reshaped" (a silent
    // skip there would ship dead sub-agent streaming).
    const strayHead = [...src.matchAll(preFilterHeadRe)].find((m) =>
      src.slice(m.index, m.index + 4000).includes(patchFMarker)
    )
    if (strayHead) {
      console.error(
        `ERROR: IVe gate head found at char ${strayHead.index} ("${strayHead[0]}") but no ` +
          `fHo+flush tail (\`FHO(MSG,CFG1,CFG2),yield*BUF,BUF.length=0;continue}\`) after it. ` +
          'The sub-agent generator pre-filter has changed shape — re-anchor Patch F2.'
      )
      process.exit(1)
    }
    console.log(
      'IVe/fHo streaming pre-filter not found — pre-v2.1.197 CLI. Patch F alone forwards stream_events. Skipping.'
    )
    patchF2Applicable = false
  } else {
    const tailStr = tailMatch[0]
    const tailIdx = src.indexOf(tailStr)

    if (src.indexOf(tailStr, tailIdx + 1) !== -1) {
      console.error('ERROR: Multiple matches for Patch F2 tail. Aborting.')
      process.exit(1)
    }

    // The tail must be the body of the IVe gate — require exactly one gate head
    // in the bounded window before it. (Without this the tail alone would not
    // prove we are in the sub-agent generator's streaming branch.)
    const headWindowStart = Math.max(chunkAt(tailIdx).start, tailIdx - F2_HEAD_WINDOW)
    const headWindow = src.slice(headWindowStart, tailIdx)
    const heads = [...headWindow.matchAll(preFilterHeadRe)]
    if (heads.length !== 1) {
      console.error(
        `ERROR: ${heads.length} IVe gate heads (\`if(CB?.(),IVe(MSG)){\`) in the ${F2_HEAD_WINDOW} ` +
          'chars before the fHo+flush tail (expected 1). Aborting.'
      )
      process.exit(1)
    }
    const [, cbVar, iveFn, gateArg] = heads[0]

    const fhoFn = tailMatch[1]
    const msgVar = tailMatch[2] // MSG (the for-await loop variable)
    const cfg1 = tailMatch[3]
    const cfg2 = tailMatch[4]
    const buf = tailMatch[5]

    // The gate must test the same message the handler consumes — otherwise the
    // head and tail belong to different statements.
    if (gateArg !== msgVar) {
      console.error(
        `ERROR: IVe gate tests ${gateArg} but fHo consumes ${msgVar} — head/tail mismatch. Aborting.`
      )
      process.exit(1)
    }

    // Sanity: this branch must live inside the same sub-agent async generator
    // Patch F targeted (verify a Patch-F marker is nearby downstream, in the
    // same chunk — a marker in a neighbouring module would prove nothing).
    const after = suffixWindow(tailIdx, 6000)
    if (!after.includes(patchFMarker)) {
      console.error('ERROR: IVe pre-filter is not co-located with Patch F. Context mismatch.')
      process.exit(1)
    }

    // Rewrite the TAIL only: keep the fHo side-effects and the BUF flush, and
    // insert a stream_event yield between them. Everything upstream splices
    // between the gate head and the tail is left byte-for-byte intact. The
    // comma-sequenced `(yield MSG)` expression is valid inside a generator body.
    const newTail =
      `${fhoFn}(${msgVar},${cfg1},${cfg2}),` +
      `${patchF2Marker}${msgVar}.type==="stream_event"&&(yield ${msgVar}),` +
      `yield*${buf},${buf}.length=0;continue}`

    src = src.slice(0, tailIdx) + newTail + src.slice(tailIdx + tailStr.length)
    patchCount++
    console.log(
      `Applied at char ${tailIdx}. msg=${msgVar}, CB=${cbVar}, IVe=${iveFn}, fHo=${fhoFn}, buf=${buf}, ` +
        `head gap=${tailIdx - (headWindowStart + heads[0].index + heads[0][0].length)} chars`
    )
  }
}

// ===========================================================================
// Patch A: Remove content-block filter from sub-agent progress callback
//
// v2.1.118 and earlier (nested for-loop, no forwardSubagentText option):
//   for(let MSG of MSGS)for(let BLK of MSG.message.content){
//     if(BLK.type!=="tool_use"&&BLK.type!=="tool_result")continue;
//     if(j)j({toolUseID:..., data:{message:MSG,...}})
//   }
//
// v2.1.119+ (upstream introduced ZX([msg]) flattener + forwardSubagentText
// option that, when true, forwards every content block):
//   let xH=ZX([LH]),FH=w.options.forwardSubagentText;
//   for(let H_ of xH){
//     if(!f)continue;
//     let iH=H_.message.content[0];
//     if(!FH&&iH.type!=="tool_use"&&iH.type!=="tool_result")continue;
//     f({toolUseID:`agent_${j.message.id}`,data:{message:H_,type:"agent_progress",...}})
//   }
//
// Goal in both shapes: forward every content block (text, thinking, tool_use,
// tool_result) regardless of upstream gating. Achieved by collapsing the inner
// for-loop (old) or by dropping the `if(...)continue;` guard (new). Once the
// guard is gone, ZX-split messages flow unconditionally.
// ===========================================================================

console.log('\n--- Patch A: Sub-agent progress callback filter ---')

const patchAMarker = '/*PATCHED:subagent-A*/'

if (src.includes(patchAMarker)) {
  console.log('Already applied. Skipping.')
} else {
  // v2.1.119+ shape: single content[0] check gated by forwardSubagentText flag.
  const newFilterRe = new RegExp(
    `let (${V})=(${V})\\.message\\.content\\[0\\];` +
      `if\\(!(${V})&&\\1\\.type!=="tool_use"&&\\1\\.type!=="tool_result"\\)continue;`
  )
  // Legacy shape: nested for-loops over message.content.
  const oldFilterRe = new RegExp(
    `for\\(let (${V}) of (${V})\\)` +
      `for\\(let (${V}) of \\1\\.message\\.content\\)\\{` +
      `if\\(\\3\\.type!=="tool_use"&&\\3\\.type!=="tool_result"\\)continue;`
  )

  const newM = src.match(newFilterRe)
  const oldM = src.match(oldFilterRe)

  if (newM) {
    const oldStr = newM[0]
    const idx = src.indexOf(oldStr)
    if (src.indexOf(oldStr, idx + 1) !== -1) {
      console.error('ERROR: Multiple matches for Patch A (v119 shape). Aborting.')
      process.exit(1)
    }
    // Keep the `let iH=H_.message.content[0];` declaration (harmless, no
    // downstream reads), just drop the gating `if(...)continue;`.
    const newStr = `${patchAMarker}let ${newM[1]}=${newM[2]}.message.content[0];`
    src = src.slice(0, idx) + newStr + src.slice(idx + oldStr.length)
    patchCount++
    console.log(
      `Applied (v119 shape) at char ${idx}. Vars: blk=${newM[1]}, msg=${newM[2]}, fwdFlag=${newM[3]}`
    )
  } else if (oldM) {
    const oldStr = oldM[0]
    const newStr = `${patchAMarker}for(let ${oldM[1]} of ${oldM[2]}){`
    const idx = src.indexOf(oldStr)
    if (src.indexOf(oldStr, idx + 1) !== -1) {
      console.error('ERROR: Multiple matches for Patch A (legacy shape). Aborting.')
      process.exit(1)
    }
    src = src.slice(0, idx) + newStr + src.slice(idx + oldStr.length)
    patchCount++
    console.log(
      `Applied (legacy shape) at char ${idx}. Vars: msg=${oldM[1]}, msgs=${oldM[2]}, inner=${oldM[3]}`
    )
  } else {
    console.error(
      'ERROR: Cannot locate sub-agent progress callback filter (tried v119 + legacy shapes).'
    )
    process.exit(1)
  }
}

// ===========================================================================
// Patch B: Forward sub-agent stream_events through progress callback
//
// In the sync Task tool loop, after unwrapping the iterator result, the code
// pushes to the collection array and filters by message type. Stream events
// must be intercepted BEFORE the push (they lack .message/.uuid and break
// downstream processing in UEA/_kA).
//
// v2.1.39 had a single combined if:
//   if(O1.push(Y1),Y1.type!=="assistant"&&Y1.type!=="user")continue;
//
// v2.1.41 splits this into two ifs:
//   if(X1.push(w1),w1.type==="progress"&&w1.data.type==="bash_progress"&&D)D({...});
//   if(w1.type!=="assistant"&&w1.type!=="user")continue;
//
// We match the "if(ARR.push(MSG)," pattern that starts the sync loop body,
// and inject a stream_event check before it.
//
// After:
//   if(w1.type==="stream_event"){
//     if(D)D({toolUseID:`agent_${j.message.id}`,
//       data:{type:"agent_stream_event",event:w1.event,agentId:r}});continue}
//   if(X1.push(w1),w1.type==="progress"&&...
// ===========================================================================

console.log('\n--- Patch B: Sub-agent stream_event forwarding ---')

const patchBMarker = '/*PATCHED:subagent-B*/'

if (src.includes(patchBMarker)) {
  console.log('Already applied. Skipping.')
} else {
  // In v2.1.197 the Task tool's sync path was refactored: the old for-await loop
  // with O1.push(MSG) is gone. Instead Task.call() creates an `nt` onMessage callback
  // and passes it to BVe() which runs the for-await internally.
  //
  // The nt callback receives every message from the sub-agent. stream_events are
  // dangerous because Ye[] (the collection array) is later passed to Tko/FVe which
  // call NAe() on the last non-system/progress message — NAe accesses .message.content
  // and would crash on a stream_event lacking .message.
  //
  // The `nt` callback structure (v2.1.197+):
  //   nt=(MSG)=>{
  //     if(DONE_FLAG)return;
  //     if(MSG.type==="spinner_mode")return;
  //     if(MSG.type!=="api_metrics"&&MSG.type!=="set_in_progress_tool_use_ids")ARR.push(MSG);  ← target
  //     if(!CALLBACK)return;
  //     ...bash_progress forward...
  //     if(MSG.type!=="assistant"&&MSG.type!=="user")return;  ← stream_event dropped here
  //     ...agent_progress forward...
  //   }
  //
  // We intercept stream_event BEFORE ARR.push and forward via CALLBACK, then `return`
  // (not `continue` — this is an arrow function, not a for-loop body).
  //
  // v2.1.47–v2.1.196 patterns (for-await with push) are tried first for backward compat.
  // The new nt-callback pattern is the final fallback.
  const v144PushRe = new RegExp(
    `=(${V})\\.value;if\\((${V})\\.type==="api_metrics"\\)\\{(${V})\\?\\.\\(\\2\\);continue\\}` +
      `if\\((${V})\\.push\\(\\2\\),` +
      `(${V})\\((${V}),\\2,(${V}),(${V})\\.options\\.tools\\),` +
      `(${V})\\)`
  )
  const v87PushRe = new RegExp(
    `=(${V})\\.value;if\\((${V})\\.push\\((${V})\\),` +
      `(${V})\\((${V}),\\3,(${V}),(${V})\\.options\\.tools\\),` +
      `(${V})\\)`
  )
  const v71PushRe = new RegExp(
    `=(${V})\\.value;if\\((${V})\\.push\\((${V})\\),` +
      `(${V})\\(${V},\\3,${V},${V}\\.options\\.tools\\)`
  )
  const oldPushRe = new RegExp(
    `if\\((${V})\\.push\\((${V})\\),\\2\\.type==="progress"&&` +
      `(?:\\(\\2\\.data\\.type==="bash_progress"\\|\\|\\2\\.data\\.type==="powershell_progress"\\)|` +
      `\\2\\.data\\.type==="bash_progress")`
  )
  // v2.1.197+: nt-callback pattern — unique to this architecture
  const ntCallbackRe = new RegExp(
    `if\\((${V})\\.type!=="api_metrics"&&\\1\\.type!=="set_in_progress_tool_use_ids"\\)(${V})\\.push\\(\\1\\)`
  )

  let m = src.match(v144PushRe)
  let matchStr, msgVar, idx
  let isNtCallback = false
  if (m) {
    // v2.1.144: matchStr starts at the SECOND "if(" (the push gate) — skip
    // the `=VAL.value;` prefix and the api_metrics guard.
    const fullMatch = m[0]
    // Find the SECOND `if(` occurrence — first is the api_metrics check
    const firstIf = fullMatch.indexOf('if(')
    const ifStart = fullMatch.indexOf('if(', firstIf + 1)
    matchStr = fullMatch.slice(ifStart)
    msgVar = m[2] // the message variable used in api_metrics check + push
    idx = src.indexOf(fullMatch) + ifStart
    console.log(`Found sync loop body (v144 pattern) at char ${idx} (arr=${m[4]}, msg=${msgVar})`)
  } else if ((m = src.match(v87PushRe))) {
    // v2.1.87: matchStr starts at "if(" — skip "=VAL.value;"
    const fullMatch = m[0]
    const ifStart = fullMatch.indexOf('if(')
    matchStr = fullMatch.slice(ifStart)
    msgVar = m[3]
    idx = src.indexOf(fullMatch) + ifStart
    console.log(`Found sync loop body (v87 pattern) at char ${idx} (arr=${m[2]}, msg=${msgVar})`)
  } else if ((m = src.match(v71PushRe))) {
    const fullMatch = m[0]
    const ifStart = fullMatch.indexOf('if(')
    matchStr = fullMatch.slice(ifStart)
    msgVar = m[3]
    idx = src.indexOf(fullMatch) + ifStart
    console.log(`Found sync loop body (v71 pattern) at char ${idx} (arr=${m[2]}, msg=${msgVar})`)
  } else if ((m = src.match(oldPushRe))) {
    matchStr = m[0]
    msgVar = m[2]
    idx = src.indexOf(matchStr)
    console.log(`Found sync loop body (old pattern) at char ${idx} (arr=${m[1]}, msg=${msgVar})`)
  } else if ((m = src.match(ntCallbackRe))) {
    // v2.1.197+: nt onMessage callback — no for-await push loop anymore
    matchStr = m[0]
    msgVar = m[1]
    idx = src.indexOf(matchStr)
    isNtCallback = true
    console.log(
      `Found sync loop body (v197+ nt-callback pattern) at char ${idx} (arr=${m[2]}, msg=${msgVar})`
    )
  } else {
    console.error('ERROR: Cannot locate sub-agent sync loop push+bash_progress pattern.')
    process.exit(1)
  }

  // Extract callback var (D), parent msg var (j), agent ID var (r) from nearby code.
  // v2.1.118 and earlier: gated `if(D)D({toolUseID:`agent_${j.message.id}`...agentId:r}`.
  // v2.1.119+: upstream replaced the per-call gate with `if(!f)continue;` then an
  //   unconditional `f({toolUseID:`agent_${j.message.id}`...agentId:DH})`.
  // v2.1.143+: upstream added outer `type:"progress",` and moved agentId inside
  //   `data:{...,agentId:VAR,agentType,description}`. Allow agentId to be
  //   followed by either `,` or `}`.
  // Chunk-clamped: the captured callback/parent/agent names must be bindings
  // that are in scope at the injection site, so never look past this chunk.
  const nearby = suffixWindow(idx, 1200)
  const cbReGated = new RegExp(
    `if\\((${V})\\)\\1\\(\\{(?:type:"progress",)?toolUseID:\`agent_\\$\\{(${V})\\.message\\.id\\}\`.*?agentId:(${V})[,}]`
  )
  const cbReUnconditional = new RegExp(
    `(${V})\\(\\{(?:type:"progress",)?toolUseID:\`agent_\\$\\{(${V})\\.message\\.id\\}\`.*?agentId:(${V})[,}]`
  )
  const cbm = nearby.match(cbReGated) || nearby.match(cbReUnconditional)
  if (!cbm) {
    console.error('ERROR: Cannot extract callback var names from nearby code.')
    process.exit(1)
  }

  const [, cbVar, parentVar, agentVar] = cbm
  // Detect whether we're patching a v2.1.143+ cli.js — the callback wraps args
  // with `type:"progress",` and ZhA's switch dispatches on the outer type.
  const hasProgressWrap = cbm[0].includes('type:"progress",')
  console.log(
    `  Callback=${cbVar}, ParentMsg=${parentVar}, AgentId=${agentVar}, wrap=${hasProgressWrap ? 'v143+' : 'legacy'}`
  )

  if (src.indexOf(matchStr, idx + 1) !== -1) {
    console.error('ERROR: Multiple matches for Patch B. Aborting.')
    process.exit(1)
  }

  // Inject stream_event check BEFORE the collection-array push.
  // In the old for-await loop shape: use `continue` (valid in loop body).
  // In the v2.1.197+ nt-callback shape: use `return` (arrow function, not a loop body).
  // v2.1.143+ requires outer `type:"progress",` so ZhA's switch dispatches it.
  const wrapPrefix = hasProgressWrap ? `type:"progress",` : ``
  const loopExit = isNtCallback ? `return` : `continue`
  const injection =
    `${patchBMarker}if(${msgVar}.type==="stream_event"){` +
    `if(${cbVar})${cbVar}({${wrapPrefix}toolUseID:\`agent_\${${parentVar}.message.id}\`,` +
    `data:{type:"agent_stream_event",event:${msgVar}.event,agentId:${agentVar}}});${loopExit}}`

  // Insert before the matched pattern — don't remove anything
  src = src.slice(0, idx) + injection + src.slice(idx)
  patchCount++
  console.log('Applied. Stream events intercepted before push — never enter collection array.')
}

// ===========================================================================
// Patch C: Add ZhA handler for agent_stream_event
//
// Injects before the bash_progress handler:
//   else if(A.data.type==="agent_stream_event"){
//     yield{type:"stream_event",event:A.data.event,
//       parent_tool_use_id:A.parentToolUseID,session_id:U6(),uuid:A.uuid}
//   }
// ===========================================================================

console.log('\n--- Patch C: ZhA agent_stream_event handler ---')

const patchCMarker = '/*PATCHED:subagent-C*/'

if (src.includes(patchCMarker)) {
  console.log('Already applied. Skipping.')
} else {
  // The bash_progress handler anchor uses a variable name that changes between
  // versions (A in v2.1.47, q in v2.1.87). Use regex to find it dynamically.
  //
  // v2.1.47: else if(A.data.type==="bash_progress"){
  // v2.1.49: else if(A.data.type==="bash_progress"||A.data.type==="powershell_progress"){
  // v2.1.87: else if(q.data.type==="bash_progress"||q.data.type==="powershell_progress"){
  // v2.1.261: else if(e.data.type==="bash_progress"||e.data.type==="powershell_progress"){
  const anchorRe = new RegExp(
    `else if\\((${V})\\.data\\.type==="bash_progress"` +
      `(?:\\|\\|\\1\\.data\\.type==="powershell_progress")?\\)\\{`,
    'g'
  )
  const anchorMatches = [...src.matchAll(anchorRe)]
  if (anchorMatches.length === 0) {
    console.error('ERROR: Cannot locate bash_progress handler in ZhA.')
    process.exit(1)
  }
  if (anchorMatches.length > 1) {
    console.error(
      `ERROR: ${anchorMatches.length} bash_progress else-if handlers found ` +
        `(at ${anchorMatches.map((m) => m.index).join(', ')}). Ambiguous — aborting.`
    )
    process.exit(1)
  }
  const anchorIdx = anchorMatches[0].index
  const progressVar = anchorMatches[0][1]

  // Verify we are inside the SDK converter's `case"progress":` dispatch chain
  // (not some other bash_progress consumer), and that the chain routes
  // agent_progress — that branch is what Patch A's messages ride on, and our
  // `else if` is spliced into the same chain.
  const ctx = prefixWindow(anchorIdx, 1500)
  const caseIdx = ctx.lastIndexOf('case"progress":')
  if (caseIdx === -1) {
    console.error(
      'ERROR: bash_progress found but no `case"progress":` dispatch within 1500 chars before it. ' +
        'Not the ZhA/WOe SDK converter — aborting.'
    )
    process.exit(1)
  }
  const dispatch = ctx.slice(caseIdx)

  // <= v2.1.241 tested the literal inline: `if(A.data.type==="agent_progress")`.
  // v2.1.261 extracted it into a predicate helper defined in the same chunk:
  //   case"progress":if(lmn(e))yield*cmn(e,r);else if(...bash_progress...)
  //   function lmn(e){return e.type==="progress"&&(e.data.type==="agent_progress"||e.data.type==="skill_progress")}
  let routesAgentProgress = dispatch.includes('agent_progress')
  if (!routesAgentProgress) {
    const predMatch = dispatch.match(new RegExp(`^case"progress":if\\((${V})\\(${V}\\)\\)`))
    if (predMatch) {
      // Minified names are chunk-local — resolve the predicate inside the
      // anchor's own chunk, never across the whole concatenated bundle.
      const predDefRe = new RegExp(
        `function ${reEsc(predMatch[1])}\\(${V}\\)\\{[^{}]*"agent_progress"`
      )
      const { name: chunkName, start, end } = chunkAt(anchorIdx)
      if (predDefRe.test(src.slice(start, end))) {
        routesAgentProgress = true
        console.log(`  agent_progress routed via predicate ${predMatch[1]}() (chunk ${chunkName})`)
      }
    }
  }
  if (!routesAgentProgress) {
    console.error(
      'ERROR: bash_progress found but its `case"progress":` chain does not route agent_progress ' +
        '(neither inline nor via a predicate helper defined in the same chunk). Context mismatch.'
    )
    process.exit(1)
  }

  // Session-id function: take the NEAREST `session_id:X()` before the anchor —
  // it is a sibling yield in the same switch arm, so its binding is guaranteed
  // to be in scope (and in the same chunk) at the injection site.
  const sessFnMatches = [...ctx.matchAll(/session_id:([\w$]+)\(\)/g)]
  if (sessFnMatches.length === 0) {
    console.error('ERROR: Cannot extract session ID function from ZhA.')
    process.exit(1)
  }
  const sessFn = sessFnMatches[sessFnMatches.length - 1][1]

  const injection =
    `${patchCMarker}else if(${progressVar}.data.type==="agent_stream_event"){` +
    `yield{type:"stream_event",event:${progressVar}.data.event,` +
    `parent_tool_use_id:${progressVar}.parentToolUseID,session_id:${sessFn}(),uuid:${progressVar}.uuid}` +
    `}`

  src = src.slice(0, anchorIdx) + injection + src.slice(anchorIdx)
  patchCount++
  console.log(`Applied. Session ID function: ${sessFn}()`)
}

// ===========================================================================
// Patch D: Include thinking in .output file for background agents
//
// Patches FM6 and the background polling map to include thinking blocks.
// ===========================================================================

console.log('\n--- Patch D: .output file thinking inclusion ---')

const patchDMarker = '/*PATCHED:subagent-D*/'

if (src.includes(patchDMarker)) {
  console.log('Already applied. Skipping.')
} else {
  // --- Text extraction function (FM6/sM6/BI8 equivalent) ---
  //
  // v2.1.47–v2.1.81: function NAME(A,q="Execution completed"){let K=GN(A);if(!K)return q;return K.message.content.filter(...)
  // v2.1.87+: function NAME(q,K="Execution completed"){let _=x0(q);if(!_)return K;return S3(_.message.content,...)}
  //
  // In v2.1.87, the inline filter/map was extracted into a helper S3().
  // We can't modify S3 (used globally). Instead we replace S3(...) with
  // inline filter+map that includes thinking blocks.
  //
  // Try new pattern first (uses helper), then old (inline filter).
  const newTextFnRe = new RegExp(
    `function (${V})\\((${V}),(${V})="Execution completed"\\)\\{` +
      `let (${V})=(${V})\\(\\2\\);if\\(!\\4\\)return \\3;` +
      `return (${V})\\(\\4\\.message\\.content,\`\\n\`\\)\\|\\|\\3\\}`
  )
  const oldTextFnRe = new RegExp(
    `function (${V})\\((${V}),(${V})="Execution completed"\\)\\{` +
      `let (${V})=(${V})\\(\\2\\);if\\(!\\4\\)return \\3;` +
      `return \\4\\.message\\.content\\.filter`
  )
  const textFnMatch = src.match(newTextFnRe) || src.match(oldTextFnRe)
  if (!textFnMatch) {
    console.error('ERROR: Cannot locate text extraction function.')
    process.exit(1)
  }

  const textFnName = textFnMatch[1]
  const textFnIdx = src.indexOf(textFnMatch[0])
  console.log(`Found text extraction function: ${textFnName}() at char ${textFnIdx}`)

  if (textFnMatch[6]) {
    // New pattern (v2.1.87+): uses S3() helper
    // Replace: return S3(_.message.content,`\n`)||K}
    // With: return _.message.content.filter(X=>X.type==="text"||X.type==="thinking").map(X=>("text"in X)?X.text:("thinking"in X)?X.thinking:"").join(`\n`)||K}
    const resultVar = textFnMatch[4]
    const defaultVar = textFnMatch[3]
    const helperName = textFnMatch[6]
    const oldReturn = `return ${helperName}(${resultVar}.message.content,\`\n\`)||${defaultVar}}`
    const newReturn =
      `return ${patchDMarker}${resultVar}.message.content` +
      `.filter(_p=>_p.type==="text"||_p.type==="thinking")` +
      `.map(_p=>("text"in _p)?_p.text:("thinking"in _p)?_p.thinking:"")` +
      `.join(\`\n\`)||${defaultVar}}`
    const returnIdx = src.indexOf(oldReturn, textFnIdx)
    if (returnIdx === -1 || returnIdx > textFnIdx + 300) {
      console.error('ERROR: Cannot find S3 return in text extraction function.')
      process.exit(1)
    }
    src = src.slice(0, returnIdx) + newReturn + src.slice(returnIdx + oldReturn.length)
    console.log(
      `Patched ${textFnName} (replaced ${helperName}() with inline filter+map including thinking).`
    )
  } else {
    // Old pattern (v2.1.47–v2.1.81): inline filter/map
    const fm6Area = src.slice(textFnIdx, textFnIdx + 300)
    const fm6FilterRe = new RegExp(`\\.filter\\(\\((${V})\\)=>\\1\\.type==="text"\\)`)
    const fm6m = fm6Area.match(fm6FilterRe)
    if (!fm6m) {
      console.error('ERROR: Cannot find text filter in text extraction function.')
      process.exit(1)
    }

    const fm6Var = fm6m[1]

    // Patch filter: type==="text" → type==="text"||VAR.type==="thinking"
    const oldFilter = `${fm6Var}.type==="text")`
    const newFilter = `${fm6Var}.type==="text"||${fm6Var}.type==="thinking")`
    const filterAbsIdx = src.indexOf(oldFilter, textFnIdx)
    if (filterAbsIdx === -1 || filterAbsIdx > textFnIdx + 300) {
      console.error('ERROR: Cannot find filter at expected location.')
      process.exit(1)
    }

    src =
      src.slice(0, filterAbsIdx) +
      patchDMarker +
      newFilter +
      src.slice(filterAbsIdx + oldFilter.length)

    // Patch map: ("text"in V)?V.text:"" → ("text"in V)?V.text:("thinking"in V)?V.thinking:""
    const oldMap = `("text"in ${fm6Var})?${fm6Var}.text:""`
    const newMap = `("text"in ${fm6Var})?${fm6Var}.text:("thinking"in ${fm6Var})?${fm6Var}.thinking:""`
    const mapIdx = src.indexOf(oldMap, filterAbsIdx)
    if (mapIdx !== -1 && mapIdx < filterAbsIdx + 200) {
      src = src.slice(0, mapIdx) + newMap + src.slice(mapIdx + oldMap.length)
      console.log('Patched (filter + map).')
    } else {
      console.log('Patched (filter only).')
    }
  }

  // --- Background agent polling map ---
  const bgMapRe = new RegExp(
    `\\.map\\(\\((${V})\\)=>\\{if\\(\\1\\.type==="assistant"\\)` +
      `return \\1\\.message\\.content\\.filter\\(\\((${V})\\)=>\\2\\.type==="text"\\)` +
      `\\.map\\(\\(\\2\\)=>\\("text"in \\2\\)\\?\\2\\.text:""\\)` +
      `\\.join\\(\`\\n\`\\);return (${V})\\(\\1\\)\\}`
  )
  const bgm = src.match(bgMapRe)

  if (bgm) {
    const oldBg = bgm[0]
    const bgIdx = src.indexOf(oldBg)
    if (src.indexOf(oldBg, bgIdx + 1) !== -1) {
      console.error('ERROR: Multiple matches for the background output writer map. Aborting.')
      process.exit(1)
    }
    const bgP = bgm[2]
    let newBg = litReplace(
      oldBg,
      `${bgP}.type==="text"`,
      `${bgP}.type==="text"||${bgP}.type==="thinking"`
    )
    newBg = litReplace(
      newBg,
      `("text"in ${bgP})?${bgP}.text:""`,
      `("text"in ${bgP})?${bgP}.text:("thinking"in ${bgP})?${bgP}.thinking:""`
    )
    // Splice by index, not String.replace(str, str): minified names can contain
    // `$`, and `$&`/`$'`/`$\`` in a replacement string are substitution patterns
    // that would silently corrupt the injected code.
    src = src.slice(0, bgIdx) + newBg + src.slice(bgIdx + oldBg.length)
    console.log(
      `Patched background agent output writer at char ${bgIdx} (msg=${bgm[1]}, blk=${bgP}).`
    )
  } else {
    // This sub-patch inserts NO marker of its own, so the final verify loop
    // (which only checks patchDMarker from the primary text-fn patch above)
    // cannot catch its absence. A silent skip ships background `.output` files
    // with thinking blocks missing while Patch D still counts as applied. If
    // an upstream reshape moves this map, fail loudly instead of shipping
    // silently-degraded background transcripts.
    console.error('ERROR: Background agent output writer not found (Patch D sub-patch).')
    console.error('The background polling .map() structure may have changed upstream.')
    process.exit(1)
  }

  patchCount++
}

// ===========================================================================
// Patch E: Background agent streaming — BVe for-await injection (v2.1.197+)
//          OR direct stdout streaming for old re-background loops (v2.1.196-)
//
// v2.1.196 and earlier: Two distinct for-await loops handled re-backgrounding.
// v2.1.197+: iu8() and both re-background loops were unified into BVe(). BVe
//   takes an `onMessage` callback (nt in Task.call()). When Task.call() backgrounds
//   (sets Fe=!0 and returns), nt returns early for all subsequent messages.
//   BVe's own for-await then has `h.push(ce)` for every message including
//   stream_events, which corrupts h[] (NAe crashes on stream_event.message).
//
//   Fix: inject before the h.push() statement in BVe's for-await:
//   - stream_event: if notify-owner mode (gate()===true), write stdout; always continue
//   - assistant/user: if notify-owner mode, write stdout; fall through to h.push()
//
//   The gate is the defaulted shouldNotifyOwner alias (`let X=shouldNotifyOwnerParam??(()=>!0)`),
//   extracted structurally — it was `p` in v2.1.197–207 but `m` in v2.1.219 (new
//   onRunSettled/onTerminalSuccess params claimed `p`/`f`). Semantics:
//   - sync Task path passes shouldNotifyOwner:()=>Fe → gate()=false while running
//     (nt/progress-callback forwards), true after re-backgrounding → stdout.
//   - spawned/background path passes no shouldNotifyOwner → gate()=true → stdout.
//
//   Anchor: if(WATCHDOG(),MSG.type==="system"&&MSG.subtype==="api_error")continue;ARR.push(MSG)
//   (unique to BVe's for-await loop body)
//
// v2.1.41 and later old shapes:
//   ))ARR.push(MSG),STATS_FN(STATS,MSG,TOOLS,J.options.tools),STATE_FN(AGENTID,...);
// ===========================================================================

console.log('\n--- Patch E: Background agent streaming (BVe or legacy re-background loops) ---')

const patchEMarker = '/*PATCHED:subagent-E*/'

if (src.includes(patchEMarker)) {
  console.log('Already applied. Skipping.')
} else {
  // The session-id getter is resolved per injection site (see findSessionIdFn):
  // it is chunk-local, so it can only be looked up once the anchor is known.
  const uuidFn = 'globalThis.crypto.randomUUID'
  console.log(`UUID function: ${uuidFn}() (web crypto global)`)

  // ---- Try v2.1.197+ BVe for-await injection first ----
  //
  // Unique anchor in BVe's for-await loop:
  //   if(WATCHDOG(),MSG.type==="system"&&MSG.subtype==="api_error")continue;ARR.push(MSG)
  //
  // Variables available in BVe scope:
  //   - msg var (ce) = loop variable
  //   - arr var (h) = collection array
  //   - p() = shouldNotifyOwner callback — returns Fe (true when backgrounded)
  //   - toolUseContext param (.toolUseId = parent_tool_use_id)
  //
  // The anchor is matched in TWO parts. Up to v2.1.220 the api_error `continue`
  // was immediately followed by `ARR.push(MSG)`, so one regex covered both. In
  // v2.1.231 upstream interposed a model-refusal branch between them:
  //
  //   if(Z(),_e.type==="system"&&_e.subtype==="api_error")continue;
  //   if(_e.type==="system"&&_e.subtype==="model_refusal_fallback")s.update(...);
  //   y.push(_e),...
  //
  // A single contiguous regex is therefore too brittle — any future statement
  // spliced into the same gap breaks it again. Match the (unique) api_error
  // head, then find the collection push for the SAME message var within a
  // bounded window after it. The window keeps the search local to this loop
  // body rather than letting it run into unrelated code.
  const bveHeadRe = new RegExp(
    `if\\((${V})\\(\\),(${V})\\.type==="system"&&\\2\\.subtype==="api_error"\\)continue;`
  )
  const bveHeadMatch = src.match(bveHeadRe)

  /** Chars after the api_error `continue;` to search for `ARR.push(MSG)`. */
  const BVE_PUSH_WINDOW = 800

  let bveAnchorMatch = null
  if (bveHeadMatch) {
    const headIdx = src.indexOf(bveHeadMatch[0])
    if (src.indexOf(bveHeadMatch[0], headIdx + 1) !== -1) {
      console.error('ERROR: BVe anchor head matches more than once. Aborting.')
      process.exit(1)
    }
    // Minified names can contain `$`, which is a regex metacharacter.
    const msgVarLit = bveHeadMatch[2].replace(/[$]/g, '\\$&')
    const windowStart = headIdx + bveHeadMatch[0].length
    const window = suffixWindow(windowStart, BVE_PUSH_WINDOW)
    const pushMatch = window.match(new RegExp(`(${V})\\.push\\(${msgVarLit}\\)`))
    if (!pushMatch) {
      console.error(
        `ERROR: BVe anchor head found, but no \`ARR.push(${bveHeadMatch[2]})\` within ` +
          `${BVE_PUSH_WINDOW} chars after it. The collection loop body has changed shape.`
      )
      process.exit(1)
    }
    bveAnchorMatch = {
      headIdx,
      watchdogFn: bveHeadMatch[1],
      msgVar: bveHeadMatch[2],
      arrVar: pushMatch[1],
      pushGap: pushMatch.index
    }
  }

  if (bveAnchorMatch) {
    // v2.1.197+ BVe path
    const { watchdogFn, msgVar, arrVar, pushGap } = bveAnchorMatch
    const anchorIdx = bveAnchorMatch.headIdx
    const sessFn = findSessionIdFn(anchorIdx, 'Patch E (BVe)')

    // Detect the toolUseContext variable by binding structurally to the
    // BVe function's destructured parameter. The minified name changes
    // between versions (s in v197-v198, i in v207+).
    //
    // Collect ALL matching `async function NAME({...,toolUseContext:VAR,...})`
    // signatures in the bounded prefix. Exactly one must exist — the BVe
    // (sje/async background runner) function. If zero or multiple match,
    // fail closed: we cannot safely distinguish the correct scope.
    // Clamped to the anchor's chunk: in the v2.1.261 concat a raw 15KB lookback
    // can cross a chunk boundary and capture a binding that is not in scope here.
    const sigBefore = prefixWindow(anchorIdx, 15000)
    const sigBeforeStart = anchorIdx - sigBefore.length
    const globalSigRe = new RegExp(`async function (${V})\\([^)]*toolUseContext:(${V})[,)]`, 'g')
    const sigCandidates = [...sigBefore.matchAll(globalSigRe)].map((m) => ({
      fn: m[1],
      ctxVar: m[2]
    }))
    if (sigCandidates.length === 0) {
      console.error(
        'ERROR: No `async function(...toolUseContext:VAR,...)` signature found ' +
          'in the 15KB prefix before the BVe anchor. Cannot determine toolUseContext binding.'
      )
      process.exit(1)
    }
    if (sigCandidates.length > 1) {
      const summary = sigCandidates.map((c) => `${c.fn}(toolUseContext:${c.ctxVar})`).join(', ')
      console.error(
        `ERROR: ${sigCandidates.length} async functions with toolUseContext found in the 15KB prefix. ` +
          `Ambiguous — cannot determine which encloses the anchor. Candidates: ${summary}`
      )
      process.exit(1)
    }
    const toolUseCtxVar = sigCandidates[0].ctxVar
    console.log(
      `  toolUseContext var: ${toolUseCtxVar} (from function sig "${sigCandidates[0].fn}", 1/1 matches)`
    )

    // Extract the shouldNotifyOwner gate. It must NOT be hardcoded: in
    // v2.1.197–v2.1.207 the defaulted alias was `p` (`shouldNotifyOwner:d}){let p=d??(()=>!0)`),
    // but v2.1.219 appended params (`onRunSettled:p,onTerminalSuccess:f`) and renamed the
    // alias to `m` (`let m=d??(()=>!0)`). Hardcoding `p` silently called onRunSettled()
    // instead — gate always falsy, so background/spawned agents never got stdout
    // stream_events, and the run-settled callback fired spuriously per message.
    // Match the destructured param + its defaulted alias structurally.
    //
    // Until v2.1.241 the alias was the runner's FIRST statement, so signature
    // and alias were adjacent (`shouldNotifyOwner:d}){let m=d??(()=>!0)`).
    // v2.1.261 opens the body with watchdog/registry wiring first, and the alias
    // is now a `let`-continuation further in:
    //   ...shouldNotifyOwner:N,reviewInlineHandoff:F=!1,onRunSettled:U,onTerminalSuccess:q}){
    //     let re=qUt(e,t);KUt(e,k,t),ghe(k);let ue=()=>{re(),U?.()},de=N??(()=>!0),...
    // So: capture the param from the signature, then find its `??(()=>!0)`
    // defaulting within a bounded window after the signature — accepting either
    // `let X=` or a `,X=` continuation.
    const notifySigRe = new RegExp(`shouldNotifyOwner:(${V})[^)]*\\)\\{`, 'g')
    /** Chars after the runner signature in which the defaulted alias must appear (57 in v2.1.261). */
    const NOTIFY_ALIAS_WINDOW = 1500
    const notifySigs = [...sigBefore.matchAll(notifySigRe)]
    if (notifySigs.length !== 1) {
      console.error(
        `ERROR: shouldNotifyOwner signature matched ${notifySigs.length} times in the 15KB prefix (expected 1). Aborting.`
      )
      process.exit(1)
    }
    const notifyParam = notifySigs[0][1]
    const aliasSearchFrom = sigBeforeStart + notifySigs[0].index + notifySigs[0][0].length
    const aliasWindow = suffixWindow(aliasSearchFrom, NOTIFY_ALIAS_WINDOW)
    const aliasMatches = [
      ...aliasWindow.matchAll(
        new RegExp(`(?:let |,)(${V})=${reEsc(notifyParam)}\\?\\?\\(\\(\\)=>!0\\)`, 'g')
      )
    ]
    if (aliasMatches.length !== 1) {
      console.error(
        `ERROR: found ${aliasMatches.length} \`X=${notifyParam}??(()=>!0)\` aliases within ` +
          `${NOTIFY_ALIAS_WINDOW} chars of the shouldNotifyOwner signature (expected 1). ` +
          'The gate must never be hardcoded — aborting.'
      )
      process.exit(1)
    }
    const notifyFn = aliasMatches[0][1]
    console.log(
      `  shouldNotifyOwner gate: ${notifyFn}() (param ${notifyParam}, alias ${aliasMatches[0].index} chars into the body)`
    )

    // v2.1.219's runner refactor (the one that added onRunSettled/onTerminalSuccess
    // to this signature) also added a native relay that forwards spawned/background
    // sub-agent assistant/user messages to the SDK stream with parent_tool_use_id
    // (verified live: with Patch E inert, background runs still delivered tagged
    // assistants; with Patch E writing them too, the same message.id arrived twice).
    // stream_events are still NOT natively forwarded. So on relay-capable builds,
    // Patch E must forward ONLY stream_events; on older builds (v2.1.197–2.1.207,
    // no onRunSettled param) it must keep forwarding assistant/user as well.
    const hasNativeRelay = notifySigs[0][0].includes('onRunSettled:')
    console.log(
      `  native assistant/user relay: ${hasNativeRelay ? 'present (skip assistant/user writes)' : 'absent (write assistant/user)'}`
    )

    console.log(
      `Found BVe for-await anchor at char ${anchorIdx} (watchdog=${watchdogFn}, msg=${msgVar}, ` +
        `arr=${arrVar}, push gap=${pushGap} chars)`
    )

    // Inject before the full `if(WATCHDOG(),...api_error...)continue;ARR.push(MSG)` sequence.
    // We insert our check BEFORE the watchdog call so the anchor remains intact after insertion.
    //
    // Injection (GATE = extracted shouldNotifyOwner alias):
    //   if(MSG.type==="stream_event"){
    //     if(GATE())try{process.stdout.write(...)...}catch(_e){}
    //     continue  ← skip h.push regardless — stream_events must NOT enter h[]
    //   }
    //   // only when the native relay is absent (pre-v2.1.219):
    //   if(MSG.type==="assistant"||MSG.type==="user"){
    //     if(GATE())try{process.stdout.write(...)...}catch(_e){}
    //     // fall through to original h.push below
    //   }
    const assistantUserWrite = hasNativeRelay
      ? ''
      : `if(${msgVar}.type==="assistant"||${msgVar}.type==="user")` +
        `if(${notifyFn}())try{process.stdout.write(JSON.stringify({type:${msgVar}.type,message:${msgVar}.message,` +
        `parent_tool_use_id:${toolUseCtxVar}.toolUseId,session_id:${sessFn}(),uuid:${uuidFn}()})+"\\n")}catch(_e){}`
    const injection =
      `${patchEMarker}` +
      `if(${msgVar}.type==="stream_event"){` +
      `if(${notifyFn}())try{process.stdout.write(JSON.stringify({type:"stream_event",event:${msgVar}.event,` +
      `parent_tool_use_id:${toolUseCtxVar}.toolUseId,session_id:${sessFn}(),uuid:${uuidFn}()})+"\\n")}catch(_e){}` +
      `continue}` +
      assistantUserWrite

    src = src.slice(0, anchorIdx) + injection + src.slice(anchorIdx)
    patchCount++
    console.log(
      'Applied (v197+ BVe path). stream_events skipped from h[], background agents get stdout.'
    )
  } else {
    // ---- Fallback: v2.1.41–v2.1.196 legacy re-background for-await loops ----
    //
    // Pattern: ))ARR.push(MSG),STATS_FN(STATS,MSG,TOOLS,J.options.tools),STATE_FN(AGENTID,...);
    // v2.1.41: ))f1.push(W1),QM1(k1,W1,e,J.options.tools),XW8(t.agentId,Nm1(k1),J.setAppState);
    // v2.1.76+: )){ARR.push(MSG),STATS(...),STATE(...);let V=wm8(MSG);if(V)Om8(...)}
    // v2.1.144+: optional api_metrics early-exit before push.
    const bracedAsyncBodyRe = new RegExp(
      `\\)\\)\\{(?:if\\([\\w$]+\\.type==="api_metrics"\\)continue;)?` +
        `(${V})\\.push\\((${V})\\),` +
        `(${V})\\((${V}),\\2,` +
        `(${V}),(${V})\\.options\\.tools\\),[^}]+\\}`,
      'g'
    )
    const unbracedAsyncBodyRe = new RegExp(
      `\\)\\)(?:if\\()?(${V})\\.push\\((${V})\\),` +
        `(${V})\\((${V}),\\2,` +
        `(${V}),(${V})\\.options\\.tools\\),` +
        `[^;]+;`,
      'g'
    )

    let asyncMatch
    let asyncPatchCount = 0
    const legacyMatches = []
    for (const re of [bracedAsyncBodyRe, unbracedAsyncBodyRe]) {
      re.lastIndex = 0
      while ((asyncMatch = re.exec(src)) !== null) {
        const before = src.slice(Math.max(0, asyncMatch.index - 1000), asyncMatch.index)
        if (!before.includes('for await')) continue
        legacyMatches.push({
          fullMatch: asyncMatch[0],
          msgVar: asyncMatch[2],
          index: asyncMatch.index
        })
      }
      if (legacyMatches.length > 0) break
    }

    if (legacyMatches.length === 0) {
      console.error(
        'ERROR: Cannot locate async for-await loops (tried BVe anchor and legacy patterns).'
      )
      console.error('The background agent loop structure may have changed.')
      process.exit(1)
    }

    console.log(`Found ${legacyMatches.length} legacy async for-await loop(s) to patch.`)

    // Extract parent message var and description var from the Task tool's call() signature.
    const callSigRe = new RegExp(
      `async call\\(\\{[^}]*description:(${V})[^}]*\\},` + `(${V}),(${V}),(${V}),(${V})\\)\\{`
    )
    const callSigMatch = src.match(callSigRe)
    if (!callSigMatch) {
      console.error('ERROR: Cannot locate Task tool call() signature.')
      process.exit(1)
    }
    const descVar = callSigMatch[1]
    const parentMsgVar = callSigMatch[4]
    console.log(`Task call() signature: description=${descVar}, parentMsg=${parentMsgVar}`)

    // Apply in reverse order so indices stay valid
    for (let i = legacyMatches.length - 1; i >= 0; i--) {
      const { fullMatch, msgVar, index } = legacyMatches[i]
      // Resolved per loop: on a chunked bundle each loop could live in its own
      // module, where the session-id getter carries a different local alias.
      const sessFn = findSessionIdFn(index, `Patch E (legacy loop ${i + 1})`)
      const body = fullMatch.slice(2) // strip leading "))"
      const ptuLookup =
        `let _ptu=null;for(let _b of ${parentMsgVar}.message.content)` +
        `{if(_b.type==="tool_use"&&_b.input&&_b.input.description===${descVar}){_ptu=_b.id;break}}`
      const replacement =
        `){${patchEMarker}` +
        `if(${msgVar}.type==="stream_event"){` +
        `${ptuLookup}` +
        `process.stdout.write(JSON.stringify({type:"stream_event",event:${msgVar}.event,` +
        `parent_tool_use_id:_ptu,session_id:${sessFn}(),uuid:${uuidFn}()})+"\\n")` +
        `}else{` +
        `${body}` +
        `{${ptuLookup}` +
        `if(${msgVar}.type==="assistant")` +
        `process.stdout.write(JSON.stringify({type:"assistant",message:${msgVar}.message,` +
        `parent_tool_use_id:_ptu,session_id:${sessFn}(),uuid:${uuidFn}()})+"\\n");` +
        `else if(${msgVar}.type==="user")` +
        `process.stdout.write(JSON.stringify({type:"user",message:${msgVar}.message,` +
        `parent_tool_use_id:_ptu,session_id:${sessFn}(),uuid:${uuidFn}()})+"\\n");` +
        `}}}`
      src = src.slice(0, index + 1) + replacement + src.slice(index + fullMatch.length)
      asyncPatchCount++
      console.log(`  Patched loop ${i + 1} at char ${index} (msg=${msgVar})`)
    }

    patchCount++
    console.log(`Applied (legacy path) to ${asyncPatchCount} loop(s).`)
  }
}

// ===========================================================================
// Patch G: iu8() — async background agent direct stdout streaming
//
// In v2.1.196 and earlier, iu8() was a standalone function for agents launched
// directly with run_in_background=true. In v2.1.197+, iu8() was unified into
// BVe() which already handles background streaming via Patch E's BVe injection.
// When iu8() is absent, this patch auto-skips with a notice.
// ===========================================================================

console.log('\n--- Patch G: iu8() background agent stdout streaming ---')

const patchGMarker = '/*PATCHED:subagent-G*/'
// Set false when iu8() does not exist (v2.1.197+: merged into BVe, covered by Patch E),
// so the final marker verification doesn't require a Patch G that was correctly skipped.
let patchGApplicable = true

if (src.includes(patchGMarker)) {
  console.log('Already applied. Skipping.')
} else {
  // Find iu8 by its unique signature pattern.
  // In v2.1.197+, iu8() was merged into BVe() and this pattern no longer exists.
  // When absent, skip gracefully — BVe (Patch E) covers this case.
  const iu8SigRe = new RegExp(
    `async function (${V})\\(\\{taskId:(${V}),abortController:(${V}),makeStream:(${V}),` +
      `metadata:(${V}),description:(${V}),toolUseContext:(${V}),taskRegistry:(${V}),` +
      `agentIdForCleanup:(${V}),enableSummarization:(${V}),getWorktreeResult:(${V})\\}\\)`
  )
  const iu8Match = iu8SigRe.exec(src)
  if (!iu8Match) {
    console.log(
      'iu8() not found — merged into BVe() in v2.1.197+. Patch E covers this path. Skipping.'
    )
    patchGApplicable = false
  } else {
    // Re-discover session ID and UUID functions (same as Patch E but in Patch G scope).
    // Scoped to iu8()'s own chunk — see findSessionIdFn.
    const sessFnG = findSessionIdFn(iu8Match.index, 'Patch G (iu8)')

    // Same rationale as Patch E — use the web crypto global, not a module-local.
    const uuidFnG = 'globalThis.crypto.randomUUID'

    const iu8Name = iu8Match[1]
    const taskIdVar = iu8Match[2] // q
    const makeStreamVar = iu8Match[4] // _
    const descVar_g = iu8Match[6] // Y — description
    const toolUseCtxVar = iu8Match[7] // A — toolUseContext (has .toolUseId)
    console.log(`  Found ${iu8Name}() at char ${iu8Match.index}`)
    console.log(
      `    taskId=${taskIdVar}, makeStream=${makeStreamVar}, desc=${descVar_g}, toolUseCtx=${toolUseCtxVar}`
    )

    // Find the for-await loop body inside iu8.
    const iu8Body = src.slice(iu8Match.index, iu8Match.index + 3000)
    const reEscG = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const forAwaitRe = new RegExp(
      `for await\\(let (${V}) of ${reEscG(makeStreamVar)}\\([^)]*\\)\\)\\{`
    )
    const forAwaitMatch = forAwaitRe.exec(iu8Body)
    if (!forAwaitMatch) {
      console.error('ERROR: Cannot find for-await loop in iu8().')
      process.exit(1)
    }
    const msgVar_g = forAwaitMatch[1]
    const pushRe = new RegExp(`(${V})\\.push\\(${reEscG(msgVar_g)}\\)`)
    const pushMatch = pushRe.exec(iu8Body.slice(forAwaitMatch.index + forAwaitMatch[0].length))
    if (!pushMatch) {
      console.error(`ERROR: Cannot find .push(${msgVar_g}) after iu8() for-await loop.`)
      process.exit(1)
    }
    const arrVar_g = pushMatch[1]
    console.log(`    Loop: msg=${msgVar_g}, arr=${arrVar_g}`)

    const forAwaitAbsIdx = iu8Match.index + iu8Body.indexOf(forAwaitMatch[0])
    const braceIdx = forAwaitAbsIdx + forAwaitMatch[0].indexOf('{') + 1
    const ptuExpr = `${toolUseCtxVar}.toolUseId`

    const gInjection =
      patchGMarker +
      `if(${msgVar_g}.type==="stream_event"){` +
      `try{process.stdout.write(JSON.stringify({type:"stream_event",event:${msgVar_g}.event,` +
      `parent_tool_use_id:${ptuExpr},session_id:${sessFnG}(),uuid:${uuidFnG}()})+"\\n")}catch(_ge){}` +
      `continue` +
      `}` +
      `if(${msgVar_g}.type==="assistant"||${msgVar_g}.type==="user")` +
      `try{process.stdout.write(JSON.stringify({type:${msgVar_g}.type,message:${msgVar_g}.message,` +
      `parent_tool_use_id:${ptuExpr},session_id:${sessFnG}(),uuid:${uuidFnG}()})+"\\n")}catch(_ge){}`

    src = src.slice(0, braceIdx) + gInjection + src.slice(braceIdx)

    if (!src.includes(patchGMarker)) {
      console.error('ERROR: Patch G injection failed.')
      process.exit(1)
    }

    patchCount++
    console.log('  Applied.')
  }
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
  ['F', patchFMarker, 'cR yield filter (RVY) — allow stream_event'],
  ...(patchF2Applicable
    ? [['F2', patchF2Marker, 'yield stream_event past IVe/fHo pre-filter (v2.1.197+)']]
    : []),
  ['A', patchAMarker, 'Content-block filter removal'],
  ['B', patchBMarker, 'Stream_event forwarding (before O1.push)'],
  ['C', patchCMarker, 'ZhA agent_stream_event handler'],
  ['D', patchDMarker, '.output file thinking inclusion'],
  ['E', patchEMarker, 'Background agent stdout streaming (re-background)'],
  // Patch G only applies when iu8() exists as a standalone function (≤ v2.1.196).
  // In v2.1.197+ iu8() was merged into BVe(), so Patch E (BVe path) covers it.
  ...(patchGApplicable
    ? [['G', patchGMarker, 'Background agent stdout streaming (iu8 — run_in_background)']]
    : [])
]

let allGood = true
for (const [label, marker, desc] of markers) {
  const ok = verify.includes(marker)
  console.log(`  ${ok ? 'OK' : 'MISSING'} Patch ${label}: ${desc}`)
  if (!ok) allGood = false
}
if (!patchGApplicable) {
  console.log('  SKIP Patch G: iu8() merged into BVe() (v2.1.197+) — covered by Patch E')
}
if (!patchF2Applicable) {
  console.log('  SKIP Patch F2: no IVe/fHo pre-filter (< v2.1.197) — Patch F alone suffices')
}

if (!allGood) {
  console.error('\nVerification FAILED.')
  process.exit(1)
}

console.log('\nAll patches verified.')
console.log('')
console.log('Summary:')
console.log('  F — cR yield: stream_events bypass RVY and yield directly,')
console.log('      without being collected into results array or transcript.')
console.log('  A — All sub-agent content blocks (text, thinking, tool_use, tool_result)')
console.log('      flow through progress callback to SDK stream.')
console.log('  B — Sub-agent stream_events intercepted BEFORE O1.push (never enter')
console.log('      collection array), forwarded via agent_stream_event progress type.')
console.log('  C — ZhA converts agent_stream_event to SDK stream_event with')
console.log('      parent_tool_use_id for proper attribution.')
console.log('  D — .output files include thinking blocks alongside text.')
console.log('  E — Background (async) agents forward messages through progress')
console.log('      callback for real-time streaming in SDK consumers.')
console.log('')
console.log('NOT changed:')
console.log('  UEA (task result) still returns text-only to parent model.')

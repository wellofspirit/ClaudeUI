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
  const before = src.slice(Math.max(0, idx - 20000), idx)
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
// Anchor is unique: `IVe(MSG)){FHO(MSG,CFG,N),yield*BUF,BUF.length=0;continue}`.
// We only patch when it exists (older CLIs without the pre-filter skip it —
// Patch F alone was sufficient there).
// ===========================================================================

console.log('\n--- Patch F2: yield stream_event past IVe/fHo pre-filter ---')

const patchF2Marker = '/*PATCHED:subagent-F2*/'
// Older CLIs (< v2.1.197) have no IVe/fHo pre-filter; F2 is then inapplicable
// and Patch F's RVY-gate injection alone forwards stream_events.
let patchF2Applicable = true

if (src.includes(patchF2Marker)) {
  console.log('Already applied. Skipping.')
} else {
  // Match: if(CB?.(),IVe(MSG)){FHO(MSG,CFG,N),yield*BUF,BUF.length=0;continue}
  // - CB (optional-call callback), IVe (the Bam.has type-gate),
  //   FHO (the stream-handler), CFG/N (fHo config args), BUF (buffer array).
  const preFilterRe = new RegExp(
    `if\\((${V})\\?\\.\\(\\),(${V})\\((${V})\\)\\)\\{` +
      `(${V})\\(\\3,(${V}),(${V})\\),` +
      `yield\\*(${V}),\\7\\.length=0;continue\\}`
  )
  const pfMatch = src.match(preFilterRe)

  if (!pfMatch) {
    console.log(
      'IVe/fHo streaming pre-filter not found — pre-v2.1.197 CLI. Patch F alone forwards stream_events. Skipping.'
    )
    patchF2Applicable = false
  } else {
    const pfStr = pfMatch[0]
    const msgVar = pfMatch[3] // MSG (the loop variable)
    const idx = src.indexOf(pfStr)

    if (src.indexOf(pfStr, idx + 1) !== -1) {
      console.error('ERROR: Multiple matches for Patch F2. Aborting.')
      process.exit(1)
    }

    // Sanity: this branch must live inside the same sub-agent async generator
    // Patch F targeted (verify a Patch-F marker is nearby downstream).
    const after = src.slice(idx, idx + 6000)
    if (!after.includes(patchFMarker)) {
      console.error('ERROR: IVe pre-filter is not co-located with Patch F. Context mismatch.')
      process.exit(1)
    }

    // Rebuild the branch: keep the fHo side-effects and BUF flush, but insert
    // a stream_event yield between them. The comma-sequenced `(yield MSG)`
    // expression is valid inside a generator body.
    const fhoFn = pfMatch[4]
    const cfg1 = pfMatch[5]
    const cfg2 = pfMatch[6]
    const buf = pfMatch[7]
    const cbVar = pfMatch[1]
    const iveFn = pfMatch[2]
    const gateArg = pfMatch[3]
    const newStr =
      `if(${cbVar}?.(),${iveFn}(${gateArg})){` +
      `${patchF2Marker}${fhoFn}(${msgVar},${cfg1},${cfg2}),` +
      `${msgVar}.type==="stream_event"&&(yield ${msgVar}),` +
      `yield*${buf},${buf}.length=0;continue}`

    src = src.slice(0, idx) + newStr + src.slice(idx + pfStr.length)
    patchCount++
    console.log(
      `Applied at char ${idx}. msg=${msgVar}, IVe=${iveFn}, fHo=${fhoFn}, buf=${buf}`
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
    console.log(`Found sync loop body (v197+ nt-callback pattern) at char ${idx} (arr=${m[2]}, msg=${msgVar})`)
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
  const nearby = src.slice(idx, idx + 1200)
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
  const anchorRe = new RegExp(
    `else if\\((${V})\\.data\\.type==="bash_progress"` +
      `(?:\\|\\|\\1\\.data\\.type==="powershell_progress")?\\)\\{`
  )
  const anchorMatch = src.match(anchorRe)
  if (!anchorMatch) {
    console.error('ERROR: Cannot locate bash_progress handler in ZhA.')
    process.exit(1)
  }
  const anchor = anchorMatch[0]
  const anchorIdx = src.indexOf(anchor)
  const progressVar = anchorMatch[1]

  // Extract session_id function name from nearby ZhA code
  const ctx = src.slice(anchorIdx - 1500, anchorIdx)
  if (!ctx.includes('agent_progress')) {
    console.error('ERROR: bash_progress found but not in expected ZhA context.')
    process.exit(1)
  }

  const sessFnMatch = ctx.match(/session_id:([\w$]+)\(\)/)
  if (!sessFnMatch) {
    console.error('ERROR: Cannot extract session ID function from ZhA.')
    process.exit(1)
  }
  const sessFn = sessFnMatch[1]

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
    const bgP = bgm[2]
    const newBg = oldBg
      .replace(`${bgP}.type==="text"`, `${bgP}.type==="text"||${bgP}.type==="thinking"`)
      .replace(
        `("text"in ${bgP})?${bgP}.text:""`,
        `("text"in ${bgP})?${bgP}.text:("thinking"in ${bgP})?${bgP}.thinking:""`
      )
    src = src.replace(oldBg, newBg)
    console.log('Patched background agent output writer.')
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
  // Find the session ID function from mI8/ihA/ZhA/ATt yields
  const sessFnRe = /session_id:([\w$]+)\(\).*?parent_tool_use_id/
  const sessFnMatch = src.match(sessFnRe)
  if (!sessFnMatch) {
    console.error('ERROR: Cannot locate session ID function.')
    process.exit(1)
  }
  const sessFn = sessFnMatch[1]
  console.log(`Session ID function: ${sessFn}()`)

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
  const bveAnchorRe = new RegExp(
    `if\\((${V})\\(\\),(${V})\\.type==="system"&&\\2\\.subtype==="api_error"\\)continue;(${V})\\.push\\(\\2\\)`
  )
  const bveAnchorMatch = src.match(bveAnchorRe)

  if (bveAnchorMatch) {
    // v2.1.197+ BVe path
    const anchorStr = bveAnchorMatch[0]
    const watchdogFn = bveAnchorMatch[1]
    const msgVar = bveAnchorMatch[2]
    const arrVar = bveAnchorMatch[3]
    const anchorIdx = src.indexOf(anchorStr)

    if (src.indexOf(anchorStr, anchorIdx + 1) !== -1) {
      console.error('ERROR: BVe anchor matches more than once. Aborting.')
      process.exit(1)
    }

    // Detect the toolUseContext variable by binding structurally to the
    // BVe function's destructured parameter. The minified name changes
    // between versions (s in v197-v198, i in v207+).
    //
    // Collect ALL matching `async function NAME({...,toolUseContext:VAR,...})`
    // signatures in the bounded prefix. Exactly one must exist — the BVe
    // (sje/async background runner) function. If zero or multiple match,
    // fail closed: we cannot safely distinguish the correct scope.
    const sigBefore = src.slice(Math.max(0, anchorIdx - 15000), anchorIdx)
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
    console.log(`  toolUseContext var: ${toolUseCtxVar} (from function sig "${sigCandidates[0].fn}", 1/1 matches)`)

    // Extract the shouldNotifyOwner gate. It must NOT be hardcoded: in
    // v2.1.197–v2.1.207 the defaulted alias was `p` (`shouldNotifyOwner:d}){let p=d??(()=>!0)`),
    // but v2.1.219 appended params (`onRunSettled:p,onTerminalSuccess:f`) and renamed the
    // alias to `m` (`let m=d??(()=>!0)`). Hardcoding `p` silently called onRunSettled()
    // instead — gate always falsy, so background/spawned agents never got stdout
    // stream_events, and the run-settled callback fired spuriously per message.
    // Match the destructured param + its defaulted alias structurally.
    const notifyRe = new RegExp(
      `shouldNotifyOwner:(${V})[^)]*\\)\\{let (${V})=\\1\\?\\?\\(\\(\\)=>!0\\)`
    )
    const notifyMatches = [...sigBefore.matchAll(new RegExp(notifyRe, 'g'))]
    if (notifyMatches.length !== 1) {
      console.error(
        `ERROR: shouldNotifyOwner alias pattern matched ${notifyMatches.length} times in the 15KB prefix (expected 1). Aborting.`
      )
      process.exit(1)
    }
    const notifyFn = notifyMatches[0][2]
    console.log(`  shouldNotifyOwner gate: ${notifyFn}() (param ${notifyMatches[0][1]})`)

    // v2.1.219's runner refactor (the one that added onRunSettled/onTerminalSuccess
    // to this signature) also added a native relay that forwards spawned/background
    // sub-agent assistant/user messages to the SDK stream with parent_tool_use_id
    // (verified live: with Patch E inert, background runs still delivered tagged
    // assistants; with Patch E writing them too, the same message.id arrived twice).
    // stream_events are still NOT natively forwarded. So on relay-capable builds,
    // Patch E must forward ONLY stream_events; on older builds (v2.1.197–2.1.207,
    // no onRunSettled param) it must keep forwarding assistant/user as well.
    const hasNativeRelay = notifyMatches[0][0].includes('onRunSettled:')
    console.log(`  native assistant/user relay: ${hasNativeRelay ? 'present (skip assistant/user writes)' : 'absent (write assistant/user)'}`)

    console.log(`Found BVe for-await anchor at char ${anchorIdx} (watchdog=${watchdogFn}, msg=${msgVar}, arr=${arrVar})`)

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
    console.log('Applied (v197+ BVe path). stream_events skipped from h[], background agents get stdout.')
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
      console.error('ERROR: Cannot locate async for-await loops (tried BVe anchor and legacy patterns).')
      console.error('The background agent loop structure may have changed.')
      process.exit(1)
    }

    console.log(`Found ${legacyMatches.length} legacy async for-await loop(s) to patch.`)

    // Extract parent message var and description var from the Task tool's call() signature.
    const callSigRe = new RegExp(
      `async call\\(\\{[^}]*description:(${V})[^}]*\\},` +
        `(${V}),(${V}),(${V}),(${V})\\)\\{`
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
    console.log('iu8() not found — merged into BVe() in v2.1.197+. Patch E covers this path. Skipping.')
    patchGApplicable = false
  } else {
    // Re-discover session ID and UUID functions (same as Patch E but in Patch G scope)
    const sessFnReG = /session_id:([\w$]+)\(\).*?parent_tool_use_id/
    const sessFnMatchG = src.match(sessFnReG)
    if (!sessFnMatchG) {
      console.error('ERROR: Cannot locate session ID function for Patch G.')
      process.exit(1)
    }
    const sessFnG = sessFnMatchG[1]

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

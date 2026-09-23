/**
 * Patch: automode-verdict
 *
 * Emits a `system/permission_allowed` frame when the auto-mode classifier
 * ALLOWS a tool call, so an SDK host can render the verdict on the card it
 * judged — the half `system/permission_denied` already covers for a block.
 *
 * Why it is needed
 * ----------------
 * Claude's auto mode is cli.js-native: the two-stage classifier
 * (docs/protocol-cc/14-auto-mode-classifier.md) runs inside the CLI, so its
 * verdict reaches a host ONLY as a wire frame. Upstream emits one for a denial
 * and nothing for an allow — the permission wrapper returns early:
 *
 *     async (tool, input, ctx, assistantMsg, toolUseId, precomputed) => {
 *       let result; switch (kind) { … result = precomputed ?? await check(…) … }
 *       if (result.behavior === "allow") return result          // ← nothing
 *       if (result.behavior === "deny") { …emitPermissionDenied…; return result }
 *       …ask path…
 *     }
 *
 * …even though the allow carries the same decision object the denial does:
 *
 *     { type: "classifier", classifier: "auto-mode", reason: "Allowed by fast classifier" }
 *
 * ClaudeUI renders a judge's verdict on approved AND denied cards for opencode,
 * pi and Codex. Without this patch Claude is the one engine of four that shows
 * one only when it blocks.
 *
 * What it changes (five edits)
 * ----------------------------
 * A. A sibling `emitPermissionAllowed` next to `emitPermissionDenied` on the
 *    control-channel class. Same queue (`this.outbound`), same fields, same
 *    uuid/session stamping — the only differences are the subtype and the
 *    absence of `message`, because an allow has no rejection text to carry.
 *    The stock emitter is rewritten too: BOTH frames carry `no_verdict: true`
 *    when `decisionReason.noVerdict === true` and omit the key otherwise. A
 *    `classifier` decision is not always a verdict — an empty classifier
 *    action, a transcript that overflowed the classifier's context, a safeguard
 *    refusal all come back `type:"classifier"` with `noVerdict:true` — and the
 *    stock frame carries nothing that tells them apart.
 *
 * B. The method is exposed on the permission-prompt host object, which is what
 *    the wrapper in (C1) actually holds.
 *
 * C1/C2. The emit itself, gated on a real verdict:
 *    `decisionReason?.classifierAllowed === true`. That is cli.js's own flag
 *    for "the classifier ran and reached an allow verdict": the permission
 *    check's allow finisher stamps it only on a `classifier` decision with
 *    `noVerdict !== true` and `classifierRan !== false`. The filter is the whole
 *    design: a rule allow, a mode allow and a fast-path allow never carry it,
 *    and none of them is a judgment anyone reached — the same line pi and
 *    opencode draw when they skip a review for a fast-path allow. Neither do
 *    the no-verdict allows ("Delivered with a note: the classifier could not
 *    review it") or "Tool declares no classifier-relevant input" (the
 *    classifier never ran). Without the gate the patch would narrate every tool
 *    call in the session. If upstream renames the flag, allow frames stop
 *    appearing and test.mjs fails on "permission_allowed emitted" — the safe
 *    direction to fail in.
 *
 *    There are TWO wrappers because cli.js builds two:
 *      C1 — the `--permission-prompt-tool stdio` one. THE LIVE PATH for
 *           ClaudeUI: `src/core/sdk/args.ts` passes that flag whenever
 *           `canUseTool` is set, and ClaudeSession always sets it. The call is
 *           made WITHOUT `?.`, so a host object missing the method fails at
 *           patch time (edit B's exactly-once check), never quietly at runtime.
 *      C2 — the one used when there is no prompt tool, or it is `none`. Kept
 *           patched for hosts that run that way.
 *
 * D. The "worth keeping" predicate gains `permission_allowed` beside
 *    `permission_denied`. It does NOT gate stdout — stream-json writes the
 *    outbound queue unconditionally — but it gates the accumulated message
 *    list, the `--output-format json` last-message pick, and the transcript
 *    mirror. Upstream keeps `permission_denied` out of all three; a frame we
 *    invented must get the same treatment or it lands in session JSONL no
 *    reader understands.
 *
 * Why NOT the engine-side emitter
 * -------------------------------
 * The engine turn loop has its own `permission_denied` emit. It looks like the
 * obvious hook and is a DEAD END: everything that queue yields passes through
 * the stdout adapter's `case "system"` switch, whose `default: return` drops
 * every subtype not explicitly listed — `permission_denied` included. Probed
 * 2026-09-21: an engine-side frame reaches the adapter and is dropped, while
 * the control-channel one reaches stdout. Both emitters exist; only this one is
 * on the wire.
 *
 * All minified names are extracted from the anchors themselves, so the patch
 * survives a version bump that renames everything. See README.md for how to
 * re-locate each anchor from scratch.
 *
 * Usage: node patch/automode-verdict/apply.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '../..')
const cliPath = resolve(projectRoot, 'vendor/claude-cli/cli.js')

/** Regex shorthand for a minified identifier. */
const V = '[\\w$]+'

/**
 * One character that does not start a nested arrow body or function. Used,
 * bounded, to span the statements between two anchor points without letting
 * the match wander into a neighbouring function.
 */
const SAME_FN = '(?:(?!=>\\{|function )[\\s\\S])'

const source = readFileSync(cliPath, 'utf8')

// `ensure-cli` re-extracts a pristine cli.js before applying patches, so this
// normally never fires — it guards a second apply.mjs by hand, which would
// otherwise define the method twice.
if (source.includes('permission_allowed')) {
  console.log('automode-verdict: already applied (permission_allowed present) — nothing to do.')
  process.exit(0)
}

/** Match exactly once, or fail loudly naming the README section to re-locate. */
function matchOnce(re, what, section) {
  const hits = [...source.matchAll(re)]
  if (hits.length !== 1) {
    fail(`expected exactly 1 ${what}, found ${hits.length}.`, section)
  }
  return hits[0]
}

function fail(why, section) {
  console.error(
    `automode-verdict: ${why}\n` +
      `The anchor moved — see patch/automode-verdict/README.md §"${section}".`
  )
  process.exit(1)
}

/** `String#replace` with a literal replacement — minified names may hold `$`. */
function replaceLiteral(haystack, needle, replacement, what, section) {
  if (!haystack.includes(needle)) fail(`${what}: injection point not found.`, section)
  return haystack.replace(needle, () => replacement)
}

// ---------------------------------------------------------------------------
// Edit A — the sibling emitter on the control-channel class, and `no_verdict`
// on both
// ---------------------------------------------------------------------------
//   emitPermissionDenied(N,U,A,R){let L=R.decisionReason;this.outbound.enqueue(
//     {type:"system",subtype:"permission_denied",tool_name:N,tool_use_id:U,
//      agent_id:A,decision_reason_type:L?.type,decision_reason_code:CODE(L),
//      decision_reason:REASON(L),message:R.message,uuid:UUID(),session_id:SID()})}
const methodRe = new RegExp(
  `emitPermissionDenied\\((${V}),(${V}),(${V}),(${V})\\)\\{let (${V})=\\4\\.decisionReason;` +
    `this\\.outbound\\.enqueue\\(\\{type:"system",subtype:"permission_denied",` +
    `tool_name:\\1,tool_use_id:\\2,agent_id:\\3,` +
    `decision_reason_type:\\5\\?\\.type,decision_reason_code:(${V})\\(\\5\\),` +
    `decision_reason:(${V})\\(\\5\\),` +
    `message:\\4\\.message,uuid:(${V})\\(\\),session_id:(${V})\\(\\)\\}\\)\\}`,
  'g'
)
const method = matchOnce(methodRe, 'emitPermissionDenied method', 'Re-locating edit A')
const [methodFull, mName, mId, mAgent, mResult, mReason, codeFn, reasonFn, uuidFn, sidFn] = method

// Present only when the classifier reached no verdict; absent otherwise, so a
// consumer tests `no_verdict === true` and never sees a `false` to misread.
const noVerdictSpread = `...(${mReason}?.noVerdict===!0&&{no_verdict:!0}),`

const deniedPatched = replaceLiteral(
  methodFull,
  `message:${mResult}.message,`,
  `message:${mResult}.message,${noVerdictSpread}`,
  'edit A (stock emitter)',
  'Re-locating edit A'
)

// No `message:` — an allow carries no rejection text, and an undefined key would
// only invite a consumer to render an empty sentence.
const methodPatched =
  `${deniedPatched}` +
  `emitPermissionAllowed(${mName},${mId},${mAgent},${mResult}){` +
  `let ${mReason}=${mResult}.decisionReason;` +
  `this.outbound.enqueue({type:"system",subtype:"permission_allowed",` +
  `tool_name:${mName},tool_use_id:${mId},agent_id:${mAgent},` +
  `decision_reason_type:${mReason}?.type,decision_reason_code:${codeFn}(${mReason}),` +
  `decision_reason:${reasonFn}(${mReason}),${noVerdictSpread}` +
  `uuid:${uuidFn}(),session_id:${sidFn}()})}`

// ---------------------------------------------------------------------------
// Edit B — expose it on the permission-prompt host object
// ---------------------------------------------------------------------------
const hostRe = new RegExp(
  `emitPermissionDenied:\\((${V}),(${V}),(${V}),(${V})\\)=>` +
    `this\\.emitPermissionDenied\\(\\1,\\2,\\3,\\4\\),`,
  'g'
)
const host = matchOnce(hostRe, 'permission-prompt host binding', 'Re-locating edit B')
const [hostFull, h1, h2, h3, h4] = host
const hostPatched =
  `${hostFull}emitPermissionAllowed:(${h1},${h2},${h3},${h4})=>` +
  `this.emitPermissionAllowed(${h1},${h2},${h3},${h4}),`

// ---------------------------------------------------------------------------
// Edit C1 — emit on the classifier's allow, `--permission-prompt-tool stdio`
// (THE LIVE PATH for ClaudeUI: args.ts passes that flag whenever canUseTool is
// set, and ClaudeSession always sets it)
// ---------------------------------------------------------------------------
//   function WRAP(KIND,HOST){return async(TOOL,INPUT,CTX,MSG,TOOLUSEID,PRE)=>{
//     let R;switch(KIND.kind){case"launcher":R=PRE??await …;break;case"strict":…}
//     if(R.behavior==="allow")return R;
//     if(R.behavior==="deny"){…;return HOST.emitPermissionDenied(TOOL.name,TOOLUSEID,CTX.agentId,R),R}
//
// Anchoring through the deny branch's own emit is what pins this to the
// emitting wrapper — cli.js builds several permission wrappers with the same
// parameter shape — and it hands us the host: whichever of the enclosing
// function's parameters the deny branch emits on is the one the allow branch
// must emit on too.
const wrapperRe = new RegExp(
  `function (${V})\\(((?:${V},)*${V})\\)\\{` +
    `return async\\((${V}),(${V}),(${V}),(${V}),(${V}),(${V})\\)=>\\{` +
    `let (${V})[;=]${SAME_FN}{0,400}?` +
    `if\\(\\9\\.behavior==="allow"\\)return \\9;if\\(\\9\\.behavior==="deny"\\)\\{` +
    `${SAME_FN}{0,600}?(${V})\\.emitPermissionDenied\\(\\3\\.name,\\7,\\5\\.agentId,\\9\\)`,
  'g'
)
const wrapper = matchOnce(wrapperRe, 'stdio permission wrapper', 'Re-locating edit C1')
const [wrapperFull, wFn, wParams, wTool, , wCtx, , wToolUseId, , wResult, wHost] = wrapper
if (!wParams.split(',').includes(wHost)) {
  fail(
    `stdio wrapper ${wFn}(${wParams}) emits its denial on "${wHost}", which is not one of ` +
      `its own parameters — cannot tell which object is the permission-prompt host.`,
    'Re-locating edit C1'
  )
}
// The abort guard matches C2's: a cancelled turn must not narrate a verdict for
// a call that never ran.
const wrapperPatched = replaceLiteral(
  wrapperFull,
  `if(${wResult}.behavior==="allow")return ${wResult};`,
  `if(${wResult}.behavior==="allow"){` +
    `if(${wResult}.decisionReason?.classifierAllowed===!0&&` +
    `!${wCtx}.abortController.signal.aborted)` +
    `${wHost}.emitPermissionAllowed(${wTool}.name,${wToolUseId},${wCtx}.agentId,${wResult});` +
    `return ${wResult}}`,
  'edit C1 (stdio allow emit)',
  'Re-locating edit C1'
)

// ---------------------------------------------------------------------------
// Edit C2 — emit on the classifier's allow, no-prompt-tool path (used when
// --permission-prompt-tool is absent or `none`; not ClaudeUI's path)
// ---------------------------------------------------------------------------
//   if(R.behavior!=="allow"&&HAS_CALL(MSG,TOOLUSEID)&&!ABORTED(CTX.abortController.signal))
//     CH.emitPermissionDenied(TOOL.name,TOOLUSEID,CTX.agentId,R);
//   return R}
//
// Both upstream guards are carried over deliberately. `HAS_CALL` checks that the
// assistant message really contains this tool_use — which is exactly what makes
// the frame bindable to a card — and the abort check keeps a cancelled turn from
// emitting a verdict for a call that never ran.
const chRe = new RegExp(
  `if\\((${V})\\.behavior!=="allow"&&(${V})\\((${V}),(${V})\\)&&` +
    `!(${V})\\((${V})\\.abortController\\.signal\\)\\)` +
    `(${V})\\.emitPermissionDenied\\((${V})\\.name,\\4,\\6\\.agentId,\\1\\);return \\1\\}`,
  'g'
)
const ch = matchOnce(chRe, 'no-prompt-tool permission wrapper', 'Re-locating edit C2')
const [chFull, cResult, cHasCall, cMsg, cToolUseId, cAborted, cCtx, cChannel, cTool] = ch
const chPatched = replaceLiteral(
  chFull,
  `return ${cResult}}`,
  `if(${cResult}.behavior==="allow"&&${cResult}.decisionReason?.classifierAllowed===!0&&` +
    `${cHasCall}(${cMsg},${cToolUseId})&&!${cAborted}(${cCtx}.abortController.signal))` +
    `${cChannel}.emitPermissionAllowed(${cTool}.name,${cToolUseId},${cCtx}.agentId,${cResult});` +
    `return ${cResult}}`,
  'edit C2 (no-prompt-tool allow emit)',
  'Re-locating edit C2'
)

// ---------------------------------------------------------------------------
// Edit D — keep the new frame out of the accumulator, the json pick and the
// transcript mirror, exactly as `permission_denied` is kept out.
// ---------------------------------------------------------------------------
const keepRe = new RegExp(
  `\\((${V})\\.type==="system"&&\\(\\1\\.subtype==="session_state_changed"\\|\\|` +
    `\\1\\.subtype==="permission_denied"\\|\\|`,
  'g'
)
const keep = matchOnce(keepRe, 'ephemeral-subtype list', 'Re-locating edit D')
const [keepFull, keepVar] = keep
const keepPatched = `${keepFull}${keepVar}.subtype==="permission_allowed"||`

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------
let out = source
for (const [what, from, to] of [
  ['edit A (emitters)', methodFull, methodPatched],
  ['edit B (host binding)', hostFull, hostPatched],
  ['edit C1 (stdio allow emit)', wrapperFull, wrapperPatched],
  ['edit C2 (no-prompt-tool allow emit)', chFull, chPatched],
  ['edit D (ephemeral list)', keepFull, keepPatched]
]) {
  const next = out.replace(from, () => to)
  if (next === out) {
    console.error(`automode-verdict: ${what} matched but did not apply.`)
    process.exit(1)
  }
  out = next
}

writeFileSync(cliPath, out)

console.log('automode-verdict: applied.')
console.log(
  `  emitter params=${mName},${mId},${mAgent},${mResult} code=${codeFn} reason=${reasonFn}`
)
console.log(
  `  stdio wrapper (live) ${wFn}(${wParams}) host=${wHost} tool=${wTool} ctx=${wCtx} ` +
    `toolUseId=${wToolUseId} result=${wResult}`
)
console.log(`  no-prompt-tool wrapper channel=${cChannel} tool=${cTool} result=${cResult}`)
console.log(`  ephemeral-list var=${keepVar}`)

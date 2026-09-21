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
 *       const result = precomputed ?? await checkPermissions(…)
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
 * What it changes (four edits)
 * ----------------------------
 * A. A sibling `emitPermissionAllowed` next to `emitPermissionDenied` on the
 *    control-channel class. Same queue (`this.outbound`), same uuid/session
 *    stamping — the only differences are the subtype and the absence of
 *    `message`, because an allow has no rejection text to carry.
 *
 * B. The method is exposed on the permission-prompt host object, which is what
 *    the wrapper in (C1) actually holds.
 *
 * C1/C2. The emit itself, gated on `decisionReason?.type === "classifier"`.
 *    That filter is the whole design: a rule allow, a mode allow and a
 *    fast-path allow carry a different (or absent) `decisionReason`, and none
 *    of them is a judgment anyone reached — the same line pi and opencode draw
 *    when they skip a review for a fast-path allow. Without it the patch would
 *    narrate every tool call in the session.
 *
 *    There are TWO wrappers because cli.js builds two: C1 is the
 *    `--permission-prompt-tool=stdio` one (patched for completeness, with an
 *    optional call so a host object lacking the method degrades quietly), and
 *    C2 is the control-channel one an SDK host with no permission-prompt tool
 *    actually gets — the live path for ClaudeUI.
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
 * The engine turn loop has its own `permission_denied` emit, queued through
 * `zn(…)`/`vo()`. It looks like the obvious hook and is a DEAD END: everything
 * that queue yields passes through the stdout adapter's `case "system"` switch,
 * whose `default: return` drops every subtype not explicitly listed —
 * `permission_denied` included. Probed 2026-09-21: an engine-side frame reaches
 * the adapter and is dropped, while the control-channel one reaches stdout.
 * Both emitters exist; only this one is on the wire.
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
    console.error(
      `automode-verdict: expected exactly 1 ${what}, found ${hits.length}.\n` +
        `The anchor moved — see patch/automode-verdict/README.md §"${section}".`
    )
    process.exit(1)
  }
  return hits[0]
}

// ---------------------------------------------------------------------------
// Edit A — the sibling emitter on the control-channel class
// ---------------------------------------------------------------------------
//   emitPermissionDenied(N,U,A,R){let L=R.decisionReason;this.outbound.enqueue(
//     {type:"system",subtype:"permission_denied",tool_name:N,tool_use_id:U,
//      agent_id:A,decision_reason_type:L?.type,decision_reason:REASON(L),
//      message:R.message,uuid:UUID(),session_id:SID()})}
const methodRe = new RegExp(
  `emitPermissionDenied\\((${V}),(${V}),(${V}),(${V})\\)\\{let (${V})=\\4\\.decisionReason;` +
    `this\\.outbound\\.enqueue\\(\\{type:"system",subtype:"permission_denied",` +
    `tool_name:\\1,tool_use_id:\\2,agent_id:\\3,` +
    `decision_reason_type:\\5\\?\\.type,decision_reason:(${V})\\(\\5\\),` +
    `message:\\4\\.message,uuid:(${V})\\(\\),session_id:(${V})\\(\\)\\}\\)\\}`,
  'g'
)
const method = matchOnce(methodRe, 'emitPermissionDenied method', 'Re-locating edit A')
const [methodFull, mName, mId, mAgent, mResult, mReason, reasonFn, uuidFn, sidFn] = method

// No `message:` — an allow carries no rejection text, and an undefined key would
// only invite a consumer to render an empty sentence.
const methodPatched =
  `${methodFull}` +
  `emitPermissionAllowed(${mName},${mId},${mAgent},${mResult}){` +
  `let ${mReason}=${mResult}.decisionReason;` +
  `this.outbound.enqueue({type:"system",subtype:"permission_allowed",` +
  `tool_name:${mName},tool_use_id:${mId},agent_id:${mAgent},` +
  `decision_reason_type:${mReason}?.type,decision_reason:${reasonFn}(${mReason}),` +
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
// Edit C1 — emit on the classifier's allow, `--permission-prompt-tool=stdio`
// ---------------------------------------------------------------------------
//   return async(TOOL,INPUT,CTX,MSG,TOOLUSEID,PRE)=>{
//     let R=PRE??await CHECK(TOOL,INPUT,CTX,MSG,TOOLUSEID);
//     if(R.behavior==="allow")return R;
//     if(R.behavior==="deny"){…}
//
// Anchoring through the deny branch is what pins this to a wrapper that emits:
// cli.js builds several permission wrappers with the same parameter shape, and
// only this one follows the allow return with that deny check.
const wrapperRe = new RegExp(
  `return async\\((${V}),(${V}),(${V}),(${V}),(${V}),(${V})\\)=>\\{` +
    `let (${V})=\\6\\?\\?await (${V})\\(\\1,\\2,\\3,\\4,\\5\\);` +
    `if\\(\\7\\.behavior==="allow"\\)return \\7;` +
    `if\\(\\7\\.behavior==="deny"\\)\\{`,
  'g'
)
const wrapper = matchOnce(wrapperRe, 'stdio permission wrapper', 'Re-locating edit C1')
const [wrapperFull, wTool, , wCtx, , wToolUseId, , wResult] = wrapper
const wrapperPatched = wrapperFull.replace(
  `if(${wResult}.behavior==="allow")return ${wResult};`,
  `if(${wResult}.behavior==="allow"){` +
    `if(${wResult}.decisionReason?.type==="classifier")` +
    `${hostVarOf(wrapperFull)}.emitPermissionAllowed?.(${wTool}.name,${wToolUseId},${wCtx}.agentId,${wResult});` +
    `return ${wResult}}`
)

// ---------------------------------------------------------------------------
// Edit C2 — emit on the classifier's allow, control-channel path (THE ONE THAT
// RUNS for an SDK host with no --permission-prompt-tool, i.e. ClaudeUI)
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
const ch = matchOnce(chRe, 'control-channel permission wrapper', 'Re-locating edit C2')
const [chFull, cResult, cHasCall, cMsg, cToolUseId, cAborted, cCtx, cChannel, cTool] = ch
const chPatched = chFull.replace(
  `return ${cResult}}`,
  `if(${cResult}.behavior==="allow"&&${cResult}.decisionReason?.type==="classifier"&&` +
    `${cHasCall}(${cMsg},${cToolUseId})&&!${cAborted}(${cCtx}.abortController.signal))` +
    `${cChannel}.emitPermissionAllowed(${cTool}.name,${cToolUseId},${cCtx}.agentId,${cResult});` +
    `return ${cResult}}`
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
  ['edit A (emitter)', methodFull, methodPatched],
  ['edit B (host binding)', hostFull, hostPatched],
  ['edit C1 (stdio allow emit)', wrapperFull, wrapperPatched],
  ['edit C2 (control-channel allow emit)', chFull, chPatched],
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
console.log(`  emitter params=${mName},${mId},${mAgent},${mResult} reason=${reasonFn}`)
console.log(`  stdio wrapper tool=${wTool} ctx=${wCtx} toolUseId=${wToolUseId} result=${wResult}`)
console.log(`  control-channel wrapper channel=${cChannel} tool=${cTool} result=${cResult}`)
console.log(`  ephemeral-list var=${keepVar}`)

/**
 * The host parameter the wrapper closes over — `function ie(HOST){return async(…`.
 * Read from the text immediately before the match rather than captured, because
 * the wrapper regex starts at `return async(` so the enclosing function's
 * parameter is outside it.
 */
function hostVarOf(fullMatch) {
  const at = source.indexOf(fullMatch)
  const before = source.slice(Math.max(0, at - 40), at)
  const m = /function\s+[\w$]+\((?<host>[\w$]+)\)\{$/.exec(before)
  if (!m?.groups?.host) {
    console.error(
      'automode-verdict: could not read the wrapper host parameter.\n' +
        'See patch/automode-verdict/README.md §"Re-locating edit C1".'
    )
    process.exit(1)
  }
  return m.groups.host
}

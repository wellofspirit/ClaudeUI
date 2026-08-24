/**
 * Patch: taskstop-notification
 *
 * Fixes two bugs in TaskStop:
 * 1. TaskStop doesn't send task_notification when stopping a task
 * 2. The "killed" status (used internally by CLI) is not recognized by the
 *    XML parser, causing stopped tasks to show as "completed"
 *
 * See README.md for full analysis.
 *
 * Usage: node patch/taskstop-notification/apply.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '../..')
const cliPath = resolve(projectRoot, 'vendor/claude-cli/cli.js')

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
// Part A: Map "killed" → "stopped" in task_notification status
//
// Historically the CLI used "killed" internally, and a shared status
// *validator* rejected anything outside completed|failed|stopped, silently
// defaulting unknown statuses (including "killed") to "completed" (wrong).
//
// As of SDK 0.2.49 that shared validator is gone entirely. There is no
// longer a single allowlist to extend — the killed→stopped translation now
// happens at each kill-site call, right before the value is handed to the
// notification emitter (`qu(taskId, status, opts)` in 2.1.198's naming,
// previously `cN`/`rx8` etc. — names churn every version). The emitter
// itself does no validation; it forwards whatever status string it's given
// straight into the `task_notification` system event
// (`CT({type:"system",subtype:"task_notification",...,status:t,...})`).
//
// So "is this upstreamed" is no longer a single-token regex question. We
// verify the *behavior* directly:
//   1. Every task-type kill path (local_bash/local_agent/remote_agent/
//      dream/workflow/system-sweep) must call the emitter with the literal
//      "stopped" — i.e. `<emitter>(<id-expr>,"stopped"` must exist.
//   2. No call site must ever hand the emitter the raw "killed" internal
//      status — i.e. `<emitter>(<id-expr>,"killed"` must NOT exist.
//   3. The emitter itself must not gate/allowlist the status param before
//      forwarding it (a defensive check — if some future version reintroduces
//      a validator, we want to fail loud rather than assume it's fine).
// If all three hold, "killed" never reaches an SDK consumer unmapped, and
// Part A is a no-op by construction — there is no validator token left to
// patch.
// ===========================================================================

console.log('\n--- Part A: killed → stopped mapping in status validator ---')

const patchAMarker = '/*PATCHED:taskstop-notification-A*/'

if (src.includes(patchAMarker)) {
  console.log('Already applied. Skipping.')
} else {
  // Legacy path for older SDK versions: the original shared validator shape.
  // (`y1=(R1)=>R1==="completed"||R1==="failed"||R1==="stopped"`, followed by
  // `x1=X1?.[1]` extraction and a `y1(x1)?x1:"completed"` ternary default.)
  const legacyValidatorRe = new RegExp(
    `(${V})=\\((${V})\\)=>\\2==="completed"\\|\\|\\2==="failed"\\|\\|\\2==="stopped",` +
      `(${V})=(${V})\\?\\.\\[1\\],` +
      `(${V})=\\1\\(\\3\\)\\?\\3:"completed";`
  )
  // Already-patched-shape or an even older upstream form that inlined
  // "killed" directly into the allowlist.
  const upstreamKilledRe = new RegExp(
    `=\\((${V})\\)=>\\1==="completed"\\|\\|\\1==="failed"\\|\\|\\1==="stopped"\\|\\|\\1==="killed"`
  )

  const legacyValidatorMatch = src.match(legacyValidatorRe)
  const upstreamKilledMatch = src.match(upstreamKilledRe)

  if (upstreamKilledMatch) {
    console.log('Upstreamed in this SDK version (validator already accepts "killed"). Skipping.')
  } else if (legacyValidatorMatch) {
    // A shared validator still exists in this SDK version — patch it as before.
    const [fullMatch, validatorName, statusParam, , extractedStatusName] = legacyValidatorMatch
    console.log(`Found status validator: ${validatorName}(${statusParam})`)

    const matchIdx = src.indexOf(fullMatch)

    if (src.indexOf(fullMatch, matchIdx + 1) !== -1) {
      console.error('ERROR: Found multiple matches for the validator pattern. Aborting.')
      process.exit(1)
    }

    const patched = fullMatch
      .replace(
        `${statusParam}==="stopped",`,
        `${statusParam}==="stopped"||${statusParam}==="killed",`
      )
      .replace(
        `${validatorName}(${extractedStatusName})?${extractedStatusName}:"completed";`,
        `${validatorName}(${extractedStatusName})?(${extractedStatusName}==="killed"?"stopped":${extractedStatusName}):"completed";`
      )

    src = src.slice(0, matchIdx) + patchAMarker + patched + src.slice(matchIdx + fullMatch.length)
    patchCount++
    console.log('Applied.')
  } else {
    // No shared validator at all anymore (SDK 0.2.49+ removed it). Verify the
    // translation is happening at kill-site call sites instead, by content,
    // before concluding this is safe to skip.
    //
    // Signature: function NAME(id,status,opts){if(!GUARD(id))return;
    // EMIT({type:"system",subtype:"task_notification",task_id:id,
    // tool_use_id:opts?.toolUseId,status:status,...})}
    const emitterRe = new RegExp(
      `function (${V})\\((${V}),(${V}),(${V})\\)\\{` +
        `if\\(!(${V})\\(\\2\\)\\)return;` +
        `(${V})\\(\\{type:"system",subtype:"task_notification",task_id:\\2,` +
        `tool_use_id:\\4\\?\\.toolUseId,status:\\3,`
    )
    const emitterMatch = src.match(emitterRe)

    if (!emitterMatch) {
      console.error(
        'ERROR: Cannot locate task_notification status validator, nor the ' +
          'expected no-validator emitter shape ' +
          '(function NAME(id,status,opts){if(!GUARD(id))return;EMIT({type:"system",' +
          'subtype:"task_notification",...,status:status,...})}). The status-plumbing ' +
          'code has changed shape again — this needs re-analysis, not a blind skip.'
      )
      process.exit(1)
    }

    const [, emitterName] = emitterMatch
    console.log(`Found no-validator emitter: ${emitterName}(taskId, status, opts)`)

    // Minified identifiers may contain `$`, which is a regex metacharacter
    // (end-of-input anchor). v2.1.231 renamed this emitter to `$m`, which made
    // BOTH checks below unmatchable: check 1 then failed loudly, but check 2 is
    // a NEGATIVE assertion — an unescaped name would have silently "passed" it
    // while a real unmapped "killed" leak sat right there in the source. Escape
    // before interpolating, always.
    const emitterLit = emitterName.replace(/[$]/g, '\\$&')

    // Behavioral check 1: at least one kill-site call must translate the
    // internal "killed" registry status into a literal "stopped" argument
    // to the emitter, right after setting status:"killed" in the registry.
    const translationAtCallSiteRe = new RegExp(
      `status:"killed",[\\s\\S]{1,400}?${emitterLit}\\([^,]+,"stopped"`
    )
    if (!src.match(translationAtCallSiteRe)) {
      console.error(
        `ERROR: ${emitterName}() has no validator, but no kill-site call could be found ` +
          'translating internal "killed" status to "stopped" before emission. ' +
          '"killed" may be leaking to SDK consumers unmapped — needs re-analysis.'
      )
      process.exit(1)
    }

    // Behavioral check 2: no call site should ever hand the emitter the raw
    // "killed" status directly (that would mean an unmapped leak).
    const rawKilledToEmitterRe = new RegExp(`${emitterLit}\\([^,]+,"killed"`)
    if (src.match(rawKilledToEmitterRe)) {
      console.error(
        `ERROR: Found a call site passing "killed" directly to ${emitterName}() — ` +
          'this would surface an invalid status to SDK consumers. Needs re-analysis ' +
          '(the old Part A patch shape may need to be revived against this call site).'
      )
      process.exit(1)
    }

    console.log(
      'Upstreamed in this SDK version: no shared validator exists; every kill-site ' +
        `call translates "killed" → "stopped" before calling ${emitterName}(), and no ` +
        'call site leaks "killed" unmapped. Skipping.'
    )
  }
}

// ===========================================================================
// Part B: Make TaskStop actually send a task_notification
//
// TaskStop kills the task and sets notified:true, but never calls the
// notification sender. We inject a call to the sender before the flag is set.
//
// Before:
//   await O.kill(w,{...}),SET_STATE((S)=>{...notified:!0...});
//
// After:
//   await O.kill(w,{...}),NOTIFY(w,$.description||"","killed",SET_STATE,void 0),SET_STATE((S)=>{...notified:!0...});
// ===========================================================================

console.log('\n--- Part B: Inject notification call into TaskStop ---')

const patchBMarker = '/*PATCHED:taskstop-notification-B*/'

if (src.includes(patchBMarker)) {
  console.log('Already applied. Skipping.')
} else {
  // Check if the fix has been upstreamed (SDK 0.2.87+):
  // rx8() now calls cN(taskId,"stopped",{...}) after setting notified:true,
  // and cN() pushes to the internal queue which is drained into the SDK output stream.
  // Detect by finding the notified setter + cN call pattern near "Successfully stopped task:".
  const taskStopAnchor = 'Successfully stopped task:'
  const anchorIdx = src.indexOf(taskStopAnchor)

  if (anchorIdx === -1) {
    console.error('ERROR: Cannot locate TaskStop call method.')
    process.exit(1)
  }

  // In 0.2.87+, TaskStop.call() delegates to rx8() which contains both the
  // notified setter and the cN() notification call. Look for the pattern:
  //   notified:!0...cN(TASKID,"stopped"
  // within the function that contains the TaskStop anchor (or its callees).
  // We search a wide window around the anchor since rx8 is defined nearby.
  const wideStart = Math.max(0, anchorIdx - 5000)
  const wideEnd = Math.min(src.length, anchorIdx + 1000)
  const wideContext = src.slice(wideStart, wideEnd)

  const upstreamNotifyRe = new RegExp(
    `notified:!0[\\s\\S]{1,300}?` + `(${V})\\(${V},"stopped",\\{toolUseId:`
  )

  if (wideContext.match(upstreamNotifyRe)) {
    console.log('Upstreamed in this SDK version (rx8 calls cN with "stopped"). Skipping.')
  } else {
    // Legacy path for older SDK versions
    // Find the notification sender by its unique structure:
    //   function NAME(A,q,K,Y,z){...K==="completed"?...:K==="failed"?...:"was stopped"...}
    const notifySenderRe = new RegExp(
      `function (${V})\\((${V}),(${V}),(${V}),(${V}),(${V})\\)\\{` +
        `[\\s\\S]{1,500}?` +
        `\\4==="completed"\\?[\\s\\S]{1,200}?` +
        `\\4==="failed"\\?[\\s\\S]{1,200}?` +
        `:"was stopped"`
    )

    const notifySenderMatch = src.match(notifySenderRe)

    if (!notifySenderMatch) {
      console.error('ERROR: Cannot locate notification sender function.')
      console.error(
        'Search pattern: function NAME(taskId,cwd,status,summary,setState){..."was stopped"}'
      )
      process.exit(1)
    }

    const [, notifySenderName] = notifySenderMatch
    console.log(`Found notification sender: ${notifySenderName}()`)

    console.log(`Found TaskStop at char ${anchorIdx}`)

    // Find the notified setter pattern near TaskStop:
    //   SET_STATE((S)=>{let T=S.tasks[ID];if(!T||T.notified)return S;return{...S,tasks:{...S.tasks,[ID]:{...T,notified:!0}}}})
    const contextStart = Math.max(0, anchorIdx - 3000)
    const contextEnd = Math.min(src.length, anchorIdx + 500)
    const context = src.slice(contextStart, contextEnd)

    const notifiedSetterRe = new RegExp(
      `(${V})\\(\\((${V})\\)=>\\{let (${V})=\\2\\.tasks\\[(${V})\\];if\\(!\\3\\|\\|\\3\\.notified\\)return \\2;return\\{\\.\\.\\.\\2,tasks:\\{\\.\\.\\.\\2\\.tasks,\\[\\4\\]:\\{\\.\\.\\.\\3,notified:!0\\}\\}\\}\\}\\)`
    )
    const notifiedSetterMatch = context.match(notifiedSetterRe)

    if (!notifiedSetterMatch) {
      console.error('ERROR: Cannot locate notified setter in TaskStop.')
      process.exit(1)
    }

    const [notifiedSetterFull, setStateFnName, , , taskIdVarName] = notifiedSetterMatch
    console.log(`  setState: ${setStateFnName}(), taskId var: ${taskIdVarName}`)

    // Find the full pattern in original source
    const fullSetterIdx = src.indexOf(notifiedSetterFull, contextStart)
    if (fullSetterIdx === -1) {
      console.error('ERROR: Cannot find notified setter at expected location.')
      process.exit(1)
    }

    // Find the task object variable: VAR=(await ...).tasks?.[TASK_ID] or VAR=FUNC().tasks?.[TASK_ID]
    const searchStart = Math.max(0, fullSetterIdx - 2000)
    const searchContext = src.slice(searchStart, fullSetterIdx)
    const taskVarRe1 = new RegExp(
      `let (${V})=\\(await [^)]+\\(\\)\\)\\.tasks\\?\\.\\[${taskIdVarName}\\];`
    )
    const taskVarRe2 = new RegExp(
      `(${V})=\\(await (${V})\\(\\)\\)\\.tasks\\?\\.\\[${taskIdVarName}\\]`
    )
    // v2.1.71+: refactored into JS1() — no await, just Y().tasks?.[A]
    const taskVarRe3 = new RegExp(`let (${V})=(${V})\\(\\)\\.tasks\\?\\.\\[${taskIdVarName}\\];`)
    // v2.1.71+: comma-separated let — let{...}=q,VAR=FUNC().tasks?.[TASKID];
    const taskVarRe4 = new RegExp(`,(${V})=(${V})\\(\\)\\.tasks\\?\\.\\[${taskIdVarName}\\];`)
    const taskVarMatch =
      searchContext.match(taskVarRe1) ||
      searchContext.match(taskVarRe2) ||
      searchContext.match(taskVarRe3) ||
      searchContext.match(taskVarRe4)

    if (!taskVarMatch) {
      console.error(`ERROR: Cannot locate task variable for tasks?.[${taskIdVarName}]`)
      process.exit(1)
    }

    const taskObjVar = taskVarMatch[1]
    console.log(`  task object var: ${taskObjVar}`)

    // Find comma before the notified setter (injection point)
    let commaIdx = fullSetterIdx - 1
    while (commaIdx > 0 && src[commaIdx] !== ',') commaIdx--

    if (src[commaIdx] !== ',') {
      console.error('ERROR: Cannot find comma before notified setter.')
      process.exit(1)
    }

    // Inject: NOTIFY(taskId, description, "killed", setState, toolUseId),
    // kxY signature: kxY(taskId, description, status, setState, toolUseId)
    // - 4th param = setState (required for Xw to set notified:true)
    // - 5th param = toolUseId (optional, used in XML <tool-use-id> element)
    const injection = `${patchBMarker}${notifySenderName}(${taskIdVarName},${taskObjVar}.description||${taskObjVar}.command||"","killed",${setStateFnName},void 0),`

    src = src.slice(0, commaIdx + 1) + injection + src.slice(commaIdx + 1)
    patchCount++
    console.log('Applied.')
  }
}

// ===========================================================================
// Write and verify
// ===========================================================================

if (patchCount > 0) {
  writeFileSync(cliPath, src)
  console.log(`\nPatch applied to ${cliPath}`)
} else {
  console.log('\nAll parts already applied or upstreamed. Nothing to write.')
}

const verify = readFileSync(cliPath, 'utf-8')

// Part A is optional — upstreamed either via:
//  - the legacy validator extended to accept "killed" (old SDKs, or our own
//    patch having run), or
//  - SDK 0.2.49+'s shared-validator-free design, where every kill-site call
//    translates "killed" -> "stopped" before handing it to the emitter (see
//    the detection logic above for the exact behavioral checks).
const legacyPatchedShapeRe =
  /=\([\w$]+\)=>[\w$]+===\s*"completed"\|\|[\w$]+===\s*"failed"\|\|[\w$]+===\s*"stopped"\|\|[\w$]+===\s*"killed"/
const noValidatorEmitterRe = new RegExp(
  `function (${V})\\((${V}),(${V}),(${V})\\)\\{` +
    `if\\(!(${V})\\(\\2\\)\\)return;` +
    `(${V})\\(\\{type:"system",subtype:"task_notification",task_id:\\2,` +
    `tool_use_id:\\4\\?\\.toolUseId,status:\\3,`
)
const noValidatorEmitterMatch = verify.match(noValidatorEmitterRe)
// Escape `$` in the captured emitter name — see the identical note at the
// detection site. Unescaped, the negative check below inverts to a false PASS.
const noValidatorEmitterLit = noValidatorEmitterMatch?.[1].replace(/[$]/g, '\\$&')
const noValidatorUpstreamed =
  !!noValidatorEmitterMatch &&
  new RegExp(`status:"killed",[\\s\\S]{1,400}?${noValidatorEmitterLit}\\([^,]+,"stopped"`).test(
    verify
  ) &&
  !new RegExp(`${noValidatorEmitterLit}\\([^,]+,"killed"`).test(verify)
const partAOk =
  verify.includes(patchAMarker) || legacyPatchedShapeRe.test(verify) || noValidatorUpstreamed

// Part B is optional (upstreamed in SDK 0.2.87+ — TaskStop's kill path calls
// the emitter with "stopped" right after setting notified:true)
const partBUpstreamed = new RegExp(
  `notified:!0[\\s\\S]{1,300}?` + `[\\w$]+\\([\\w$]+,"stopped",\\{toolUseId:`
).test(verify)
const partBOk = verify.includes(patchBMarker) || partBUpstreamed

console.log(
  `  ${partAOk ? 'OK' : 'MISSING'} Part A: killed → stopped mapping ${verify.includes(patchAMarker) ? '(patched)' : '(upstreamed)'}`
)
console.log(
  `  ${partBOk ? 'OK' : 'MISSING'} Part B: TaskStop notification injection ${verify.includes(patchBMarker) ? '(patched)' : '(upstreamed)'}`
)

if (!partAOk || !partBOk) {
  console.error('\nVerification FAILED.')
  process.exit(1)
}

console.log('\nAll parts verified.')
console.log('')
console.log('What this does:')
console.log('  A — Ensures "killed" is mapped to "stopped" before reaching SDK consumers')
console.log(
  '  B — Ensures TaskStop sends a notification sender call before the notified flag is set'
)

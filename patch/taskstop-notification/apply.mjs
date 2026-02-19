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
const cliPath = resolve(projectRoot, 'node_modules/@anthropic-ai/claude-agent-sdk/cli.js')

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
  console.error('Is @anthropic-ai/claude-agent-sdk installed?')
  process.exit(1)
}

console.log(`Read ${cliPath} (${(src.length / 1024 / 1024).toFixed(1)} MB)`)

const versionMatch = src.match(/Version:\s*([\d.]+)/)
if (versionMatch) {
  console.log(`CLI version: ${versionMatch[1]}`)
}

let patchCount = 0

// ===========================================================================
// Part A: Map "killed" → "stopped" in task_notification XML parser
//
// The CLI uses "killed" internally but the SDK schema expects "stopped".
// The validator rejects "killed" and defaults to "completed" (wrong).
//
// Before:
//   y1=(R1)=>R1==="completed"||R1==="failed"||R1==="stopped",
//   x1=X1?.[1],
//   G1=y1(x1)?x1:"completed";
//
// After:
//   y1=(R1)=>R1==="completed"||R1==="failed"||R1==="stopped"||R1==="killed",
//   x1=X1?.[1],
//   G1=y1(x1)?(x1==="killed"?"stopped":x1):"completed";
// ===========================================================================

console.log('\n--- Part A: killed → stopped mapping in status validator ---')

const patchAMarker = '/*PATCHED:taskstop-notification-A*/'

if (src.includes(patchAMarker)) {
  console.log('Already applied. Skipping.')
} else {
  // Find the validator by its unique pattern:
  //   VALIDATOR=(STATUS)=>STATUS==="completed"||STATUS==="failed"||STATUS==="stopped",
  //   EXTRACTED=XML_MATCH?.[1],
  //   VALIDATED=VALIDATOR(EXTRACTED)?EXTRACTED:"completed";
  const validatorRe = new RegExp(
    `(${V})=\\((${V})\\)=>\\2==="completed"\\|\\|\\2==="failed"\\|\\|\\2==="stopped",` +
    `(${V})=(${V})\\?\\.\\[1\\],` +
    `(${V})=\\1\\(\\3\\)\\?\\3:"completed";`
  )

  const validatorMatch = src.match(validatorRe)

  if (!validatorMatch) {
    console.error('ERROR: Cannot locate task_notification status validator.')
    console.error('Expected: VALIDATOR=(S)=>S==="completed"||S==="failed"||S==="stopped",EXTRACTED=XML?.[1],VALIDATED=VALIDATOR(EXTRACTED)?EXTRACTED:"completed";')
    process.exit(1)
  }

  const [fullMatch, validatorName, statusParam, extractedStatusName, xmlMatchName, validatedStatusName] = validatorMatch
  console.log(`Found status validator: ${validatorName}(${statusParam})`)
  console.log(`  extracted: ${extractedStatusName} = ${xmlMatchName}?.[1]`)
  console.log(`  validated: ${validatedStatusName} = ${validatorName}(${extractedStatusName}) ? ${extractedStatusName} : "completed"`)

  const matchIdx = src.indexOf(fullMatch)

  // Ensure unique match
  if (src.indexOf(fullMatch, matchIdx + 1) !== -1) {
    console.error('ERROR: Found multiple matches for the validator pattern. Aborting.')
    process.exit(1)
  }

  // Apply: add "killed" to validator, add killed→stopped mapping
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
    console.error('Search pattern: function NAME(taskId,cwd,status,summary,setState){..."was stopped"}')
    process.exit(1)
  }

  const [, notifySenderName] = notifySenderMatch
  console.log(`Found notification sender: ${notifySenderName}()`)

  // Find TaskStop by its unique return message
  const taskStopAnchor = 'Successfully stopped task:'
  const anchorIdx = src.indexOf(taskStopAnchor)
  if (anchorIdx === -1) {
    console.error('ERROR: Cannot locate TaskStop call method.')
    process.exit(1)
  }

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

  // Find the task object variable: VAR=(await ...).tasks?.[TASK_ID]
  const searchStart = Math.max(0, fullSetterIdx - 2000)
  const searchContext = src.slice(searchStart, fullSetterIdx)
  const taskVarRe1 = new RegExp(
    `let (${V})=\\(await [^)]+\\(\\)\\)\\.tasks\\?\\.\\[${taskIdVarName}\\];`
  )
  const taskVarRe2 = new RegExp(
    `(${V})=\\(await (${V})\\(\\)\\)\\.tasks\\?\\.\\[${taskIdVarName}\\]`
  )
  const taskVarMatch = searchContext.match(taskVarRe1) || searchContext.match(taskVarRe2)

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

// ===========================================================================
// Write and verify
// ===========================================================================

if (patchCount === 0) {
  console.log('\nAll parts already applied. Nothing to do.')
  process.exit(0)
}

writeFileSync(cliPath, src)
console.log(`\nPatch applied to ${cliPath}`)

const verify = readFileSync(cliPath, 'utf-8')
const markers = [
  ['A', patchAMarker, 'killed → stopped mapping in status validator'],
  ['B', patchBMarker, 'TaskStop notification injection']
]

let allGood = true
for (const [label, marker, desc] of markers) {
  const ok = verify.includes(marker)
  console.log(`  ${ok ? 'OK' : 'MISSING'} Part ${label}: ${desc}`)
  if (!ok) allGood = false
}

if (!allGood) {
  console.error('\nVerification FAILED.')
  process.exit(1)
}

console.log('\nAll parts verified.')
console.log('')
console.log('What this does:')
console.log('  A — Accepts "killed" in status validator, maps it to "stopped" for SDK consumers')
console.log('  B — Injects notification sender call into TaskStop before notified flag is set')

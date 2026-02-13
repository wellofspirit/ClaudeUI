/**
 * Patch: taskstop-send-notification
 *
 * Fixes TaskStop to actually send task_notification when tasks are stopped.
 * See README.md for full analysis.
 *
 * Usage: node patch/taskstop-send-notification/apply.mjs
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

// ---------------------------------------------------------------------------
// Step 2: Check if already patched
// ---------------------------------------------------------------------------

const patchMarker = '/*PATCHED:taskstop-send-notification*/'

if (src.includes(patchMarker)) {
  console.log('\nPatch already applied. Nothing to do.')
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Step 3: Locate the notification sender function (NB1 equivalent)
//
// Pattern: function NAME(A,q,K,Y,z){
//   let w=!1;
//   if(n5(A,z,(H)=>{if(H.notified)return H;return w=!0,{...H,notified:!0}}),!w)return;
//   let H=K==="completed"?`completed...`:K==="failed"?`failed...`:"was stopped"
//   ...
// }
//
// We identify it by:
// 1. The "was stopped" string (used for killed status)
// 2. Pattern of checking .notified and setting it
// 3. The ternary for status messages
// ---------------------------------------------------------------------------

// Find the notification sender by its unique pattern
// Looking for: function NAME(A,q,K,Y,z){...was stopped...}
// Pattern: function NB1(A,q,K,Y,z){let w=!1;if(n5(A,z,...),!w)return;let H=K==="completed"?...:K==="failed"?...:"was stopped"
const notifySenderRe = new RegExp(
  `function (${V})\\((${V}),(${V}),(${V}),(${V}),(${V})\\)\\{` +
  `[\\s\\S]{1,500}?` +  // Allow up to 500 chars of function body
  `\\4==="completed"\\?[\\s\\S]{1,200}?` +  // completed case (K param)
  `\\4==="failed"\\?[\\s\\S]{1,200}?` +     // failed case
  `:"was stopped"`  // stopped case
)

const notifySenderMatch = src.match(notifySenderRe)

if (!notifySenderMatch) {
  console.error('ERROR: Cannot locate notification sender function (NB1 equivalent).')
  console.error('Search pattern: function NAME(taskId,cwd,status,summary,setState){..."was stopped"}')
  process.exit(1)
}

const [, notifySenderName, taskIdParam, cwdParam, statusParam, summaryParam, setStateParam] = notifySenderMatch
console.log(`Found notification sender: ${notifySenderName}(${taskIdParam}, ${cwdParam}, ${statusParam}, ${summaryParam}, ${setStateParam})`)

// ---------------------------------------------------------------------------
// Step 4: Locate TaskStop call method
//
// Pattern: async call({task_id:X,...},{getAppState:G,setAppState:S,...}) {
//   ...
//   await KILL_FN(TASKID_VAR, {...}),
//   SET_STATE_FN((STATE_VAR)=>{
//     let TASK_VAR=STATE_VAR.tasks[TASKID_VAR];
//     if(!TASK_VAR||TASK_VAR.notified)return STATE_VAR;
//     return{...STATE_VAR,tasks:{...STATE_VAR.tasks,[TASKID_VAR]:{...TASK_VAR,notified:!0}}}
//   });
//   ...
//   return{data:{message:`Successfully stopped task: ${TASKID_VAR} (...)`,...}}
// }
//
// We identify it by the "Successfully stopped task:" message
// ---------------------------------------------------------------------------

const taskStopAnchor = 'Successfully stopped task:'
const anchorIdx = src.indexOf(taskStopAnchor)
if (anchorIdx === -1) {
  console.error('ERROR: Cannot locate TaskStop call method.')
  console.error('Search anchor: "Successfully stopped task:" message')
  process.exit(1)
}

console.log(`Found TaskStop at char ${anchorIdx}`)

// Extract context around TaskStop (need to search before the anchor for the notified setter)
const contextStart = Math.max(0, anchorIdx - 2000)
const contextEnd = Math.min(src.length, anchorIdx + 500)
const context = src.slice(contextStart, contextEnd)

// Find the notified setter pattern:
// SET_STATE((STATE)=>{let TASK=STATE.tasks[TASKID];if(!TASK||TASK.notified)return STATE;return{...STATE,tasks:{...STATE.tasks,[TASKID]:{...TASK,notified:!0}}}})
const notifiedSetterRe = new RegExp(
  `(${V})\\(\\((${V})\\)=>\\{let (${V})=\\2\\.tasks\\[(${V})\\];if\\(!\\3\\|\\|\\3\\.notified\\)return \\2;return\\{\\.\\.\\.\\2,tasks:\\{\\.\\.\\.\\2\\.tasks,\\[\\4\\]:\\{\\.\\.\\.\\3,notified:!0\\}\\}\\}\\}\\)`
)
const notifiedSetterMatch = context.match(notifiedSetterRe)

if (!notifiedSetterMatch) {
  console.error('ERROR: Cannot locate notified setter in TaskStop.')
  console.error('Expected pattern: SET_STATE((S)=>{let T=S.tasks[ID];...notified:!0...})')
  process.exit(1)
}

const [notifiedSetterFull, setStateFnName, stateVarName, taskVarName, taskIdVarName] = notifiedSetterMatch
console.log(`  setState: ${setStateFnName}()`)
console.log(`  taskId var: ${taskIdVarName}`)
console.log(`  state var: ${stateVarName}`)
console.log(`  task var: ${taskVarName}`)

// Find the full pattern in the source to patch
// We need to find: ),SET_STATE((STATE)=>{...notified...});
// And inject: NOTIFY_FN(...),SET_STATE((STATE)=>{...notified...});
const fullSetterIdx = src.indexOf(notifiedSetterFull, contextStart)
if (fullSetterIdx === -1) {
  console.error('ERROR: Cannot find notified setter at expected location.')
  process.exit(1)
}

// Look backwards from the setter to find the preceding comma
// Pattern: ...),SET_STATE((STATE)=>{...})
let commaIdx = fullSetterIdx - 1
while (commaIdx > 0 && src[commaIdx] !== ',') {
  commaIdx--
}

if (src[commaIdx] !== ',') {
  console.error('ERROR: Cannot find comma before notified setter.')
  process.exit(1)
}

// Now we need to find the task variable ($) - it's defined in the function body
// Pattern: let TASK_VAR=(await GET_STATE_FN()).tasks?.[TASK_ID_VAR];
// This retrieves the task object which has .cwd, .command, etc.
const taskVarRe = new RegExp(
  `let (${V})=\\(await [^)]+\\(\\)\\)\\.tasks\\?\\.\\[${taskIdVarName}\\];`
)

// Search backwards from the notified setter (task var should be defined before it)
const searchStart = Math.max(0, fullSetterIdx - 1000)
const searchContext = src.slice(searchStart, fullSetterIdx)
const taskVarMatch = searchContext.match(taskVarRe)

if (!taskVarMatch) {
  console.error('ERROR: Cannot locate task variable in TaskStop call method.')
  console.error(`Expected pattern: let VAR=(await ...).tasks?.[${taskIdVarName}];`)
  process.exit(1)
}

const toolInputVar = taskVarMatch[1]
console.log(`  task object var: ${toolInputVar}`)

// ---------------------------------------------------------------------------
// Step 5: Apply the patch
//
// Insert notification sender call BEFORE the notified setter:
//
// Before:
//   await O.kill(w,{...}),SET_STATE((S)=>{...notified:!0...});
//
// After:
//   await O.kill(w,{...}),NOTIFY(w,$.cwd||"","killed",void 0,SET_STATE),SET_STATE((S)=>{...notified:!0...});
// ---------------------------------------------------------------------------

// Build the injection
const injection = `${patchMarker}${notifySenderName}(${taskIdVarName},${toolInputVar}.cwd||"","killed",void 0,${setStateFnName}),`

// Insert at the comma before the notified setter
const patched =
  src.slice(0, commaIdx + 1) +
  injection +
  src.slice(commaIdx + 1)

// ---------------------------------------------------------------------------
// Step 6: Write and verify
// ---------------------------------------------------------------------------

writeFileSync(cliPath, patched)
console.log(`\nPatch applied to ${cliPath}`)

// Verify
const verify = readFileSync(cliPath, 'utf-8')
if (!verify.includes(patchMarker)) {
  console.error('ERROR: Verification failed — patch marker not found after write.')
  process.exit(1)
}

// Verify the notification call is present
const expectedCall = `${notifySenderName}(${taskIdVarName},${toolInputVar}.cwd||"","killed",void 0,${setStateFnName})`
if (!verify.includes(expectedCall)) {
  console.error('ERROR: Verification failed — notification call not found.')
  console.error(`Expected: ${expectedCall}`)
  process.exit(1)
}

console.log('Verified: patch is in place.')
console.log('')
console.log('What this does:')
console.log(`  Calls ${notifySenderName}() to send task_notification BEFORE setting notified flag.`)
console.log('  Uses status="killed" to match CLI behavior.')
console.log('  The task-notification-killed-mapping patch will map "killed" → "stopped".')

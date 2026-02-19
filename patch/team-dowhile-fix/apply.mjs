#!/usr/bin/env node
/**
 * Patch: team-dowhile-fix
 *
 * Bug: After the team-lead's first AI turn spawns teammates, the do-while loop
 * checks `getRunningTasks(appState).some(isActive)` — which returns true for ALL
 * running tasks, including `in_process_teammate` tasks. This blocks the code from
 * ever reaching the team inbox polling loop, creating a deadlock.
 *
 * Fix: Filter the do-while condition to only loop for non-teammate tasks (same
 * filter used by the result-holding check), allowing the code to fall through to
 * the team inbox polling when only teammate tasks are running.
 *
 * Stable anchors (content-based):
 *   - Do-while condition: <var>=<getRunning>(<state>).some((<item>)=><isActive>(<item>)),<var>=<hasQueued>()
 *   - Comparable result-hold check: .some((<item>)=><item>.type==="local_agent"&&<isActive>(<item>))
 *
 * bundle-analyzer commands:
 *   find cli.js "local_agent" --near <do-while-offset>
 *   find cli.js ".some" --near <do-while-offset>
 */

import { readFileSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI_PATH = resolve(__dirname, '..', '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'cli.js')

const PATCH_MARKER = '/*PATCHED:team-dowhile-fix*/'
const V = '[\\w$]+'

let code = readFileSync(CLI_PATH, 'utf-8')

console.log(`Read ${CLI_PATH} (${(code.length / 1024 / 1024).toFixed(1)} MB)`)

const versionMatch = code.match(/Version:\s*([\d.]+)/)
if (versionMatch) console.log(`CLI version: ${versionMatch[1]}`)

if (code.includes(PATCH_MARKER)) {
  console.log('Patch already applied. Nothing to do.')
  process.exit(0)
}

// Find the do-while condition. The pattern is:
//   <resultVar>=<getRunning>(<stateVar>).some((<item>)=><isActive>(<item>)),<queuedVar>=<hasQueued>()
//
// Nearby, the result-hold check uses the same getRunning/isActive but with a
// type==="local_agent" filter. We use that to confirm we found the right code.
//
// The do-while condition is inside a block like:
//   do{await <dequeue>(),<loopVar>=!1;{let <state>=await <getState>(),
//      <resultVar>=<getRunning>(<state>).some((<item>)=><isActive>(<item>)),
//      <queuedVar>=<hasQueued>();...}}while(<loopVar>);

const doWhileRe = new RegExp(
  `(${V})=(${V})\\((${V})\\)\\.some\\(\\((${V})\\)=>(${V})\\(\\4\\)\\),(${V})=(${V})\\(\\)` +
  // Followed by: if(<resultVar>||<queuedVar>){...} to confirm it's the right one
  `;?if\\(\\1\\|\\|\\6\\)`
)

const m = code.match(doWhileRe)
if (!m) {
  console.error('ERROR: Cannot find do-while condition.')
  console.error('Pattern:', doWhileRe.source)
  process.exit(1)
}

// Verify we're near the do-while and team polling code
const matchIdx = m.index
const nearby = code.slice(matchIdx - 2000, matchIdx + 2000)
if (!nearby.includes('while(') || !nearby.includes('teamContext')) {
  console.error('ERROR: Match found but not near do-while/team code.')
  process.exit(1)
}

// Verify the result-hold check uses the SAME getRunning + isActive with local_agent filter
const [, resultVar, getRunning, stateVar, item, isActive, queuedVar, hasQueued] = m
console.log(`Found do-while condition at char ${matchIdx}`)
console.log(`  getRunning=${getRunning}, isActive=${isActive}, hasQueued=${hasQueued}`)

const resultHoldPattern = `${getRunning}(`
if (!nearby.includes(`type==="local_agent"&&${isActive}(`)) {
  console.error('ERROR: Cannot find matching result-hold check with local_agent filter.')
  console.error(`Expected nearby: type==="local_agent"&&${isActive}(`)
  process.exit(1)
}
console.log('  Confirmed: result-hold check uses same functions with local_agent filter.')

// Build anchor and replacement. The anchor is the full match up to (but not including)
// the if() part — we only replace the .some() callback.
const anchor = `${resultVar}=${getRunning}(${stateVar}).some((${item})=>${isActive}(${item}))`
const replacement = `${PATCH_MARKER}${resultVar}=${getRunning}(${stateVar}).some((${item})=>${item}.type!=="in_process_teammate"&&${isActive}(${item}))`

// Verify anchor uniqueness
const anchorCount = code.split(anchor).length - 1
if (anchorCount !== 1) {
  console.error(`ERROR: Expected 1 match for anchor, found ${anchorCount}.`)
  process.exit(1)
}

code = code.replace(anchor, replacement)

writeFileSync(CLI_PATH, code)

// Verify
const verify = readFileSync(CLI_PATH, 'utf-8')
if (!verify.includes(PATCH_MARKER)) {
  console.error('ERROR: Verification failed — marker not found after write.')
  process.exit(1)
}
const count = (verify.match(/PATCHED:team-dowhile-fix/g) || []).length
if (count !== 1) {
  console.error(`ERROR: Expected 1 marker, found ${count}.`)
  process.exit(1)
}

console.log('Patch applied successfully: team-dowhile-fix')
console.log('  Do-while loop now skips in_process_teammate tasks,')
console.log('  allowing team inbox polling to run.')

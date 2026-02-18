#!/usr/bin/env node
/**
 * Patch: team-dowhile-fix
 *
 * Bug: After the team-lead's first AI turn spawns teammates, the do-while loop
 * in f6() checks `eC8(appState).some(jf)` — which returns true for ALL running
 * tasks, including `in_process_teammate` tasks. This blocks the code from ever
 * reaching the team inbox polling loop, creating a deadlock: the team-lead waits
 * for teammates to finish, but teammates wait for the team-lead to respond.
 *
 * Fix: Filter the do-while condition to only loop for `local_agent` tasks (same
 * filter used by the result-holding check), allowing the code to fall through to
 * the team inbox polling when only teammate tasks are running.
 *
 * Stable anchors (content-based, not offset-based):
 *   - Do-while condition: Z6=eC8($6).some((L6)=>jf(L6))
 *   - Comparable result-hold check: eC8(z1).some((D1)=>D1.type==="local_agent"&&jf(D1))
 *
 * bundle-analyzer commands to find this code:
 *   find cli.js "eC8($6).some" --compact
 *   find cli.js "local_agent" --near <offset>
 */

import { readFileSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI_PATH = resolve(__dirname, '..', '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'cli.js')

const PATCH_MARKER = '/*PATCHED:team-dowhile-fix*/'

let code = readFileSync(CLI_PATH, 'utf-8')

if (code.includes(PATCH_MARKER)) {
  console.log('Patch already applied. Nothing to do.')
  process.exit(0)
}

// The do-while condition checks ALL running tasks:
//   Z6=eC8($6).some((L6)=>jf(L6))
//
// We add a filter to exclude in_process_teammate tasks, matching the result-hold logic:
//   Z6=eC8($6).some((L6)=>L6.type!=="in_process_teammate"&&jf(L6))
const ANCHOR = 'Z6=eC8($6).some((L6)=>jf(L6)),X6=$6.queuedCommands'
const idx = code.indexOf(ANCHOR)
if (idx === -1) {
  console.error('ERROR: Cannot find do-while condition anchor.')
  console.error('Expected:', JSON.stringify(ANCHOR))
  process.exit(1)
}

const REPLACEMENT = `${PATCH_MARKER}Z6=eC8($6).some((L6)=>L6.type!=="in_process_teammate"&&jf(L6)),X6=$6.queuedCommands`

code = code.slice(0, idx) + REPLACEMENT + code.slice(idx + ANCHOR.length)

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

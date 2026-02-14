/**
 * Master patch runner — applies all patches in order.
 *
 * Usage: node patch/apply-all.mjs
 */

import { execFileSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const patches = [
  resolve(__dirname, 'subagent-streaming/apply.mjs'),
  resolve(__dirname, 'task-notification-usage/apply.mjs'),
  resolve(__dirname, 'taskstop-notification/apply.mjs')
]

for (const patch of patches) {
  console.log(`\n>>> Applying ${patch}\n`)
  execFileSync('node', [patch], { stdio: 'inherit' })
}

console.log('\nAll patches applied.')

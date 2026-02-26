#!/usr/bin/env node
/**
 * Run all patch tests sequentially and report results.
 *
 * Usage: node patch/test-all.mjs
 *
 * Each test exits 0 on all-pass, 1 on any failure.
 * This runner reports per-test OK/FAILED and overall summary.
 */

import { execFileSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const tests = [
  { name: 'subagent-streaming', script: resolve(__dirname, 'subagent-streaming/test.mjs') },
  { name: 'taskstop-notification', script: resolve(__dirname, 'taskstop-notification/test.mjs') },
  { name: 'team-streaming', script: resolve(__dirname, 'team-streaming/test.mjs') },
]

console.log(`\nRunning ${tests.length} patch tests...\n`)

const results = []

for (const { name, script } of tests) {
  console.log(`\n>>> ${name}`)
  try {
    execFileSync('node', [script], { stdio: 'inherit', timeout: 300_000 })
    results.push({ name, ok: true })
    console.log(`>>> ${name}: \x1b[32mOK\x1b[0m`)
  } catch (err) {
    results.push({ name, ok: false })
    console.log(`>>> ${name}: \x1b[31mFAILED\x1b[0m`)
  }
}

// Summary
console.log('\n' + '='.repeat(60))
console.log('  PATCH TEST SUMMARY')
console.log('='.repeat(60))

const passed = results.filter((r) => r.ok).length
const failed = results.filter((r) => !r.ok).length

for (const { name, ok } of results) {
  const icon = ok ? '\x1b[32mOK\x1b[0m' : '\x1b[31mFAILED\x1b[0m'
  console.log(`  ${icon}  ${name}`)
}

console.log('')
console.log(`  ${passed}/${results.length} passed`)
if (failed > 0) {
  console.log(`  \x1b[31m${failed} FAILED\x1b[0m`)
}
console.log('')

process.exit(failed > 0 ? 1 : 0)

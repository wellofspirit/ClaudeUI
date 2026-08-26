#!/usr/bin/env node
/**
 * Run all patch tests sequentially and report results.
 *
 * Usage: node patch/test-all.mjs
 *
 * Each test exits 0 on all-pass, 1 on any failure.
 * This runner reports per-test OK/FAILED and overall summary.
 */

import { execFile } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const tests = [
  { name: 'subagent-streaming', script: resolve(__dirname, 'subagent-streaming/test.mjs') },
  { name: 'taskstop-notification', script: resolve(__dirname, 'taskstop-notification/test.mjs') },
  { name: 'queue-control', script: resolve(__dirname, 'queue-control/test.mjs') },
  { name: 'mcp-status', script: resolve(__dirname, 'mcp-status/test.mjs') },
  { name: 'mcp-tool-refresh', script: resolve(__dirname, 'mcp-tool-refresh/test.mjs') },
  { name: 'usage-relay', script: resolve(__dirname, 'usage-relay/test.mjs') },
  { name: 'request-usage', script: resolve(__dirname, 'request-usage/test.mjs') },
  { name: 'rate-limit-relay', script: resolve(__dirname, 'rate-limit-relay/test.mjs') },
  { name: 'bash-output-streaming', script: resolve(__dirname, 'bash-output-streaming/test.mjs') },
  { name: 'subprocess-proxy-strip', script: resolve(__dirname, 'subprocess-proxy-strip/test.mjs') },
  { name: 'skip-securestorage', script: resolve(__dirname, 'skip-securestorage/test.mjs') }
]

// Tests are independent processes (separate CLI sessions, stdio MCP stubs, no
// fixed ports; skip-securestorage is a read-only structural check), so they run
// concurrently with a bounded pool. Each test's output is buffered and printed
// whole when it finishes, so logs never interleave. PATCH_TEST_CONCURRENCY=1
// restores the old fully-sequential behaviour (e.g. when debugging one test's
// live session with DEBUG_HARNESS=1).
const concurrency = Math.max(1, Number(process.env.PATCH_TEST_CONCURRENCY) || 4)

console.log(`\nRunning ${tests.length} patch tests (concurrency ${concurrency})...\n`)

const runOne = ({ name, script }) =>
  new Promise((done) => {
    execFile(
      'node',
      [script],
      { timeout: 300_000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const ok = !err
        console.log(`\n>>> ${name}`)
        if (stdout) process.stdout.write(stdout)
        if (stderr) process.stderr.write(stderr)
        console.log(`>>> ${name}: ${ok ? '\x1b[32mOK\x1b[0m' : '\x1b[31mFAILED\x1b[0m'}`)
        done({ name, ok })
      }
    )
  })

const results = []
{
  const queue = [...tests]
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const test = queue.shift()
      results.push(await runOne(test))
    }
  })
  await Promise.all(workers)
}

// Preserve the declaration order in the summary regardless of completion order.
results.sort(
  (a, b) => tests.findIndex((t) => t.name === a.name) - tests.findIndex((t) => t.name === b.name)
)

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

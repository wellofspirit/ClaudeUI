/**
 * Master patch runner — applies all patches in order, then verifies syntax.
 *
 * Usage: node patch/apply-all.mjs
 */

import { execFileSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const patches = [
  resolve(__dirname, 'subagent-streaming/apply.mjs'),
  resolve(__dirname, 'taskstop-notification/apply.mjs'),
  resolve(__dirname, 'team-streaming/apply.mjs'),
  resolve(__dirname, 'queue-control/apply.mjs'),
  resolve(__dirname, 'mcp-status/apply.mjs'),
  resolve(__dirname, 'mcp-tool-refresh/apply.mjs'),
  resolve(__dirname, 'sandbox-network-fix/apply.mjs'),
  resolve(__dirname, 'background-task/apply.mjs'),
  resolve(__dirname, 'usage-relay/apply.mjs'),
  resolve(__dirname, 'rate-limit-relay/apply.mjs'),
  resolve(__dirname, 'incomplete-session-resume-fix/apply.mjs'),
  resolve(__dirname, 'voice-server/apply.mjs')
]

for (const patch of patches) {
  console.log(`\n>>> Applying ${patch}\n`)
  execFileSync('node', [patch], { stdio: 'inherit' })
}

console.log('\nAll patches applied.')

// ---------------------------------------------------------------------------
// Syntax check — verify patched cli.js parses without errors.
//
// Uses `bun build --no-bundle` (fast, native parser) with esbuild fallback.
// Both parse the full file and exit non-zero on syntax errors.
// ---------------------------------------------------------------------------

const cliPath = resolve(
  __dirname,
  '..',
  'node_modules',
  '@anthropic-ai',
  'claude-agent-sdk',
  'cli.js'
)

console.log('\n>>> Syntax check: %s\n', cliPath)

const checkers = [
  {
    name: 'node --check',
    run: () => execFileSync('node', ['--check', cliPath], { stdio: 'pipe' })
  },
  {
    name: 'bun build',
    run: () =>
      execFileSync('bun', ['build', '--no-bundle', '--outfile', '/dev/null', cliPath], {
        stdio: 'pipe'
      })
  },
  {
    name: 'esbuild',
    run: () =>
      execFileSync(
        resolve(__dirname, '..', 'node_modules', '.bin', 'esbuild'),
        ['--bundle=false', cliPath],
        { stdio: 'pipe' }
      )
  }
]

let checked = false
for (const checker of checkers) {
  try {
    checker.run()
    console.log('  OK Syntax check passed (%s)', checker.name)
    checked = true
    break
  } catch (err) {
    if (err.code === 'ENOENT') continue // tool not installed, try next
    const stderr = err.stderr?.toString() || ''
    // bun's node shim doesn't support --check — skip to next checker
    if (checker.name === 'node --check' && stderr.includes('Input must be provided')) continue
    // Tool exists but syntax check failed
    console.error('  FAIL Syntax check failed! (%s)', checker.name)
    console.error(stderr || err.message)
    process.exit(1)
  }
}

if (!checked) {
  console.warn('  SKIP Syntax check — none of node, bun, esbuild found in PATH')
}

console.log('\nDone.')

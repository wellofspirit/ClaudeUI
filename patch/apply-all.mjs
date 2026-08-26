/**
 * Master patch runner — applies all patches in order, then verifies syntax.
 *
 * Usage: node patch/apply-all.mjs
 *        node patch/apply-all.mjs --quiet   # print only per-patch verdicts +
 *                                           # warnings/errors; full output on failure
 */

import { execFileSync } from 'node:child_process'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const QUIET = process.argv.includes('--quiet')

// Colour on a real terminal, or when the orchestrator told us to via
// FORCE_COLOR (it pipes our stdout, which would otherwise look like a non-TTY).
// Redirects to a file stay free of escape codes.
const forceColor = process.env.FORCE_COLOR
const useColor =
  !!process.stdout.isTTY ||
  (forceColor !== undefined && forceColor !== '0' && forceColor !== 'false')
const green = (s) => (useColor ? `\x1b[32m${s}\x1b[0m` : s)
const red = (s) => (useColor ? `\x1b[31m${s}\x1b[0m` : s)

const patches = [
  resolve(__dirname, 'subagent-streaming/apply.mjs'),
  resolve(__dirname, 'taskstop-notification/apply.mjs'),
  resolve(__dirname, 'queue-control/apply.mjs'),
  resolve(__dirname, 'mcp-status/apply.mjs'),
  resolve(__dirname, 'mcp-tool-refresh/apply.mjs'),
  resolve(__dirname, 'background-task/apply.mjs'),
  resolve(__dirname, 'usage-relay/apply.mjs'),
  resolve(__dirname, 'request-usage/apply.mjs'),
  resolve(__dirname, 'rate-limit-relay/apply.mjs'),
  resolve(__dirname, 'incomplete-session-resume-fix/apply.mjs'),
  resolve(__dirname, 'voice-server/apply.mjs'),
  resolve(__dirname, 'bash-output-streaming/apply.mjs'),
  resolve(__dirname, 'subprocess-proxy-strip/apply.mjs'),
  resolve(__dirname, 'skip-securestorage/apply.mjs')
  // ci-path-remap retired: cli.js now runs inside a rebundled Bun binary,
  // which resolves baked file:// URLs natively via its module graph. The
  // Node-compatibility shim is no longer needed.
]

function runPatch(patch) {
  const name = basename(dirname(patch))
  if (QUIET) {
    try {
      execFileSync('node', [patch], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
      console.log(`>>> ${name} ${green('applied.')}`)
    } catch (err) {
      // Errors may live on either stream — dump both.
      console.error(`\n  >>> ${name} ${red('failed.')}`)
      if (err.stdout) console.error(err.stdout.toString())
      if (err.stderr) console.error(err.stderr.toString())
      process.exit(1)
    }
  } else {
    console.log(`\n>>> Applying ${patch}\n`)
    execFileSync('node', [patch], { stdio: 'inherit' })
  }
}

for (const patch of patches) {
  runPatch(patch)
}

if (!QUIET) console.log('\nAll patches applied.')

// ---------------------------------------------------------------------------
// Syntax check — verify patched cli.js parses without errors.
//
// Uses `bun build --no-bundle` (fast, native parser) with esbuild fallback.
// Both parse the full file and exit non-zero on syntax errors.
// ---------------------------------------------------------------------------

const cliPath = resolve(__dirname, '..', 'vendor', 'claude-cli', 'cli.js')

if (!QUIET) console.log('\n>>> Syntax check: %s\n', cliPath)

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
    console.log(`  ${green('OK')} Syntax check passed (%s)`, checker.name)
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

if (!QUIET) console.log('\nDone.')

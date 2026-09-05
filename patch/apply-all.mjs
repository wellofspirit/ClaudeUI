/**
 * Master patch runner — applies all patches in order, then checks that the
 * patch target still has the shape the rebundler expects.
 *
 * Usage: node patch/apply-all.mjs
 *        node patch/apply-all.mjs --quiet   # print only per-patch verdicts +
 *                                           # warnings/errors; full output on failure
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
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
// Structure check — verify the patched target still looks like the chunk
// concat the rebundler will split apart.
//
// Since Claude Code 2.1.261 `vendor/claude-cli/cli.js` is NOT one program: it
// is ~1,630 separate minified ESM chunks concatenated behind `// @bun-chunk`
// delimiter lines (see scripts/extract-cli.mjs). No parser can read that as a
// single file — duplicate top-level import bindings alone guarantee failure —
// so the old whole-file node/bun/esbuild check is gone.
//
// Real syntax checking is now PER CHUNK and lives in scripts/rebundle-cli.mjs,
// which esbuild-parses every chunk whose bytes a patch actually changed. That
// runs immediately after this script in the same `ensure-cli` pipeline, so a
// patch that produces broken JS still fails the build — just one step later.
// What we check here is only that the delimiter structure survived patching.
// ---------------------------------------------------------------------------

const cliPath = resolve(__dirname, '..', 'vendor', 'claude-cli', 'cli.js')
const MIN_CHUNKS = 1000

if (!QUIET) console.log('\n>>> Structure check: %s\n', cliPath)

function structureFail(msg) {
  console.error(`  ${red('FAIL')} Structure check: ${msg}`)
  process.exit(1)
}

const cliBytes = readFileSync(cliPath)
if (!cliBytes.subarray(0, 16).toString('latin1').startsWith('// @bun-chunk B:')) {
  structureFail(
    'file does not start with a "// @bun-chunk B:" delimiter line — ' +
      'a patch clobbered the header, or the file was produced by an old extractor. ' +
      'Re-run `node scripts/extract-cli.mjs`.'
  )
}

const DELIM = Buffer.from('\n// @bun-chunk ', 'latin1')
let chunkCount = 1 // the leading delimiter has no preceding newline
for (let i = cliBytes.indexOf(DELIM); i !== -1; i = cliBytes.indexOf(DELIM, i + 1)) chunkCount++
if (chunkCount <= MIN_CHUNKS) {
  structureFail(
    `only ${chunkCount} chunk delimiters found (expected > ${MIN_CHUNKS}) — ` +
      'the concat looks truncated. Re-run `node scripts/extract-cli.mjs`.'
  )
}
console.log(`  ${green('OK')} Structure check passed (${chunkCount} chunks)`)

if (!QUIET) console.log('\nDone.')

/**
 * Master patch runner — applies all patches in order, checks that the patch
 * target still has the shape the rebundler expects, then records which patches
 * the result carries in `vendor/claude-cli/version.json` (`patches`).
 *
 * The registry itself lives in `patch/lib/patch-registry.mjs`.
 *
 * Usage: node patch/apply-all.mjs
 *        node patch/apply-all.mjs --quiet   # print only per-patch verdicts, the
 *                                           # `patches:` line and warnings/errors;
 *                                           # full output on failure
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CHUNK_DELIM_PREFIX, isChunkConcat } from '../scripts/lib/chunk-format.mjs'
import { PATCH_REGISTRY, mergeIntoVersionJson, patchesPresent } from './lib/patch-registry.mjs'

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

function runPatch({ name, apply }) {
  if (QUIET) {
    try {
      execFileSync('node', [apply], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
      console.log(`>>> ${name} ${green('applied.')}`)
    } catch (err) {
      // Errors may live on either stream — dump both.
      console.error(`\n  >>> ${name} ${red('failed.')}`)
      if (err.stdout) console.error(err.stdout.toString())
      if (err.stderr) console.error(err.stderr.toString())
      process.exit(1)
    }
  } else {
    console.log(`\n>>> Applying ${apply}\n`)
    execFileSync('node', [apply], { stdio: 'inherit' })
  }
}

for (const entry of PATCH_REGISTRY) {
  runPatch(entry)
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
if (!isChunkConcat(cliBytes)) {
  structureFail(
    'file does not start with a "// @bun-chunk <module>" delimiter line — ' +
      'a patch clobbered the header, or the file was produced by an old extractor. ' +
      'Re-run `node scripts/extract-cli.mjs`.'
  )
}

const DELIM = Buffer.from(`\n${CHUNK_DELIM_PREFIX}`, 'latin1')
let chunkCount = 1 // the leading delimiter has no preceding newline
for (let i = cliBytes.indexOf(DELIM); i !== -1; i = cliBytes.indexOf(DELIM, i + 1)) chunkCount++
if (chunkCount <= MIN_CHUNKS) {
  structureFail(
    `only ${chunkCount} chunk delimiters found (expected > ${MIN_CHUNKS}) — ` +
      'the concat looks truncated. Re-run `node scripts/extract-cli.mjs`.'
  )
}
console.log(`  ${green('OK')} Structure check passed (${chunkCount} chunks)`)

// ---------------------------------------------------------------------------
// Record which patches the build carries — `version.json` `patches`.
//
// Read from the patched bytes, not from the registry: a patch that no-opped
// because upstream fixed the bug leaves no marker and is not listed. The app
// gates patch-dependent surfaces on this list (src/core/sdk/harness.ts), and
// Anthropic's own binary, which has no version.json, reads as "no patches".
// ---------------------------------------------------------------------------

const versionPath = resolve(__dirname, '..', 'vendor', 'claude-cli', 'version.json')
// Chunks are pure ASCII (extract-cli.mjs validates it), so latin1 is lossless.
const present = patchesPresent(cliBytes.toString('latin1'))
try {
  mergeIntoVersionJson(versionPath, { patches: present })
} catch (err) {
  console.error(`  ${red('FAIL')} Could not record patches in ${versionPath}: ${err.message}`)
  process.exit(1)
}
console.log(`patches: ${present.join(', ')}`)
if (!QUIET) {
  const absent = PATCH_REGISTRY.map((entry) => entry.name).filter((name) => !present.includes(name))
  if (absent.length > 0) console.log(`  no marker (no-op on this cli.js): ${absent.join(', ')}`)
  console.log(`  recorded in ${versionPath}`)
}

if (!QUIET) console.log('\nDone.')

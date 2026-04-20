/**
 * Patch: ci-path-remap
 *
 * Generic runtime remapper for CI-baked `file:///home/runner/.../` URLs that
 * leak into cli.js from the Bun build process.
 *
 * Bun's compiled binary preserves these source-file URLs as virtual paths
 * that its own loader resolves against embedded files. When cli.js is
 * extracted and run under Node, `fileURLToPath` on these URLs just decodes
 * the literal CI worker path (which never exists on any user machine).
 *
 * Fix: inject an IIFE at the top of cli.js that monkey-patches
 * `url.fileURLToPath` to intercept CI-root URLs and redirect them to paths
 * relative to the real cli.js directory. A per-subpath override map handles
 * cases where the extracted layout doesn't mirror the CI source tree; an
 * identity prefix-swap handles everything else.
 *
 * All 6 known leaks in cli.js v2.1.114 go through property access on
 * `require("url")` — `<mod>.fileURLToPath(<literal URL>)` — so monkey-patching
 * the module property intercepts every call site.
 *
 * Usage: node patch/ci-path-remap/apply.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '../..')
const cliPath = resolve(projectRoot, 'vendor/claude-cli/cli.js')

let src
try {
  src = readFileSync(cliPath, 'utf-8')
} catch (err) {
  console.error(`ERROR: Cannot read ${cliPath}`)
  console.error('Did you run: node scripts/extract-cli.mjs ?')
  process.exit(1)
}

const ver = src.match(/VERSION:"([^"]+)"/)?.[1] ?? 'unknown'
console.log(`Read ${cliPath} (${(src.length / 1024 / 1024).toFixed(1)} MB)`)
console.log(`CLI version: ${ver}`)

const MARKER = '/*PATCHED:ci-path-remap*/'

if (src.includes(MARKER)) {
  console.log('\nPatch already applied. Nothing to do.')
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Anchor: the end-of-Bun-shim comment line injected by scripts/extract-cli.mjs.
// We append our IIFE after this line so both shims sit together at the top.
// Matching on 'end Bun shim' is robust — the Unicode box-drawing chars are
// part of the comment but we don't rely on them in the regex.
// ---------------------------------------------------------------------------

const anchorRe = /\/\/ [^\n]*end Bun shim[^\n]*\n/

const anchorMatch = anchorRe.exec(src)
if (!anchorMatch) {
  console.error('ERROR: Cannot locate the "end Bun shim" anchor comment.')
  console.error('This comment is injected by scripts/extract-cli.mjs.')
  console.error('Did extract-cli run? Is the SHIM constant still emitting the "end Bun shim" line?')
  process.exit(1)
}

const allAnchors = [...src.matchAll(new RegExp(anchorRe, 'g'))]
if (allAnchors.length > 1) {
  console.error(`ERROR: Anchor matched ${allAnchors.length} times. Aborting.`)
  process.exit(1)
}

console.log(`Anchor found at char ${anchorMatch.index}`)

// ---------------------------------------------------------------------------
// The injected IIFE. Kept as a literal template so it's easy to read/audit.
// ---------------------------------------------------------------------------
//
// Override rationale — each value is a synthetic basename under CLI_DIR
// chosen so the consuming code's path.join/dirname chain lands on the real
// extracted file:
//
//   src/utils/ripgrep.ts
//     → 'ripgrep.ts' (anything under CLI_DIR)
//     consumer: join(P, "../", "vendor", "ripgrep", <arch>, "rg")
//     target:   <CLI_DIR>/vendor/ripgrep/<arch>/rg
//
//   src/utils/claudeInChrome/setup.ts
//     → 'claudeInChrome-setup.ts'
//     consumer: join(P, "..", "cli.js")
//     target:   <CLI_DIR>/cli.js
//
//   src/utils/computerUse/setup.ts
//     → 'computerUse-setup.ts'
//     consumer: join(P, "..", "cli.js")
//     target:   <CLI_DIR>/cli.js
//
// Unknown subpaths fall through to the naive prefix swap (CLI_DIR + sub).
// That handles modifiers-napi, open, and sandbox-runtime/seccomp URLs, all
// of which are wrapped in try/catch upstream and degrade gracefully when
// their downstream targets don't exist.

const SHIM = `${MARKER}
// ─── CI path remap (injected by patch/ci-path-remap) ───────────────────────
// The official cli.js bakes "file:///home/runner/work/claude-cli-internal/..."
// URLs from Anthropic's build host. Under Bun these resolve to embedded
// files; under Node they're just broken literal paths. Intercept
// url.fileURLToPath to redirect them to the real extracted layout.
(function () {
  const url = require('url')
  const path = require('path')
  const origFileURLToPath = url.fileURLToPath
  const CI_ROOT = 'file:///home/runner/work/claude-cli-internal/claude-cli-internal/'
  const CLI_DIR = __dirname
  const overrides = {
    'src/utils/ripgrep.ts': 'ripgrep.ts',
    'src/utils/claudeInChrome/setup.ts': 'claudeInChrome-setup.ts',
    'src/utils/computerUse/setup.ts': 'computerUse-setup.ts',
  }
  url.fileURLToPath = function fileURLToPathShim(input) {
    const s = typeof input === 'string' ? input : input && input.href
    if (s && s.startsWith(CI_ROOT)) {
      const sub = s.slice(CI_ROOT.length)
      const synth = Object.prototype.hasOwnProperty.call(overrides, sub)
        ? overrides[sub]
        : sub
      return path.resolve(CLI_DIR, synth)
    }
    return origFileURLToPath.apply(this, arguments)
  }
})();
// ─── end CI path remap ─────────────────────────────────────────────────────
`

// Insert AFTER the anchor (i.e., after the newline at the end of the Bun shim
// comment). match.index is the start of the match; match[0].length is the
// span, which includes the trailing \n.
const insertAt = anchorMatch.index + anchorMatch[0].length
src = src.slice(0, insertAt) + SHIM + '\n' + src.slice(insertAt)
console.log(`Injected CI path remap shim (${SHIM.length} chars) after Bun shim`)

// ---------------------------------------------------------------------------
// Write and verify
// ---------------------------------------------------------------------------

writeFileSync(cliPath, src)
console.log(`\nPatch applied to ${cliPath}`)

const verify = readFileSync(cliPath, 'utf-8')
if (!verify.includes(MARKER)) {
  console.error('\nVerification FAILED — marker not found.')
  process.exit(1)
}
if (!verify.includes('url.fileURLToPath = function fileURLToPathShim')) {
  console.error('\nVerification FAILED — interceptor body missing.')
  process.exit(1)
}
console.log('cli.js verified.')

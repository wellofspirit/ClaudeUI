/**
 * Patch: skip-securestorage
 *
 * When the env var `SKIP_SECURESTORAGE` is truthy, force cli.js to read/write
 * OAuth credentials from the plaintext file backend ONLY, bypassing the macOS
 * Keychain entirely.
 *
 * Why: ClaudeUI's multi-account support keeps a separate `.credentials.json`
 * per account (under a per-account `CLAUDE_SECURESTORAGE_CONFIG_DIR`) and swaps
 * the active one. The Keychain is single-item and prompts on cross-process
 * access, so file-only storage is required to manage and switch accounts
 * without `security` trust prompts. See ADR-014 / ADR-015.
 *
 * How it works: cli.js's credential store is a facade
 *   getter() => COMPOSE(<secure store>, file)
 * where COMPOSE builds a "<store>-with-plaintext-fallback" object: the OS
 * secure store is primary, the plaintext file is the fallback. The plaintext
 * backend (name:"plaintext") implements read/readAsync/mutate/update/delete;
 * the only methods it lacks (readAsyncStrict/invalidateCache) are called
 * exclusively via optional chaining (`?.`) inside the mutate helper, so the
 * bare backend is sufficient. We prepend a SKIP_SECURESTORAGE short-circuit to
 * the getter that returns the file backend directly.
 *
 * The getter body is PLATFORM-SPECIFIC (verified on 2.1.177):
 *   macOS:   function p1(){return ev9(oM8,lK6)}                       // keychain
 *   Windows: function pf(){if(v21())return cy$(OXq,s_6);return s_6}    // windows-credman, gated
 * The original patch matched only the macOS unconditional body and aborted on
 * Windows. We now capture the WHOLE body and prepend the short-circuit, so the
 * gate (and any future shape) is preserved. See README "Anchor 2".
 *
 * Anchors (both content-based; minified names + body shape vary by platform):
 *   1. The facade composer, via its `${X.name}-with-${Y.name}-fallback`
 *      template literal — captures the composer fn name.
 *   2. The zero-arg getter: the only `function NAME(){…COMPOSER(primary,file)…}`
 *      with a brace-free body — captures the getter name, the original body,
 *      and the two backend identifiers. The file backend is the SECOND
 *      COMPOSER arg (fallback).
 *
 * Usage: node patch/skip-securestorage/apply.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '../..')
const cliPath = resolve(projectRoot, 'vendor/claude-cli/cli.js')

const V = '[\\w$]+'
const MARKER = '/*PATCHED:skip-securestorage*/'

let src
try {
  src = readFileSync(cliPath, 'utf-8')
} catch {
  console.error(`ERROR: Cannot read ${cliPath}`)
  console.error('Did you run: node scripts/extract-cli.mjs ?')
  process.exit(1)
}

const ver = src.match(/VERSION:"([^"]+)"/)?.[1] ?? 'unknown'
console.log(`Read ${cliPath} (${(src.length / 1024 / 1024).toFixed(1)} MB)`)
console.log(`CLI version: ${ver}`)

if (src.includes(MARKER)) {
  console.log('Already patched (marker found) — skipping.')
  process.exit(0)
}

// --- 1. Find the facade composer name via its template-literal signature -----
//   function ev9(H,_){let q={name:`${H.name}-with-${_.name}-fallback`,...
const composerRe = new RegExp(
  `function (${V})\\(${V},${V}\\)\\{let ${V}=\\{name:\`\\$\\{${V}\\.name\\}-with-\\$\\{${V}\\.name\\}-fallback\``
)
const composerMatch = src.match(composerRe)
if (!composerMatch) {
  console.error('ERROR: could not locate the credential-store facade composer.')
  console.error('cli.js may have changed the "keychain-with-plaintext-fallback" shape.')
  process.exit(1)
}
const composer = composerMatch[1]
console.log(`Facade composer: ${composer}()`)

// --- 2. Find & rewrite the getter. Its body shape varies by version/platform:
//   old (macOS):  function P(){return COMPOSER(keychain,file)}
//   new (2.1.x):  function pf(){if(v21())return COMPOSER(windows-credman,file);return file}
// Both are a zero-arg getter whose brace-free body contains COMPOSER(primary,file)
// where `file` is the SECOND (fallback) arg. Rather than matching the exact body
// (which broke when the `if(<credman-gate>())` prefix was added), we capture the
// whole body and inject a SKIP_SECURESTORAGE short-circuit at the top that returns
// the file backend directly — the original gate logic is preserved for the unset
// case. The body is brace-free in every observed shape, so [^{}]* is safe and also
// excludes the composer DEFINITION (which takes args and has a braced body).
const composerLit = composer.replace(/[$]/g, '\\$&') // escape $ for regex
const siteRe = new RegExp(
  `function (${V})\\(\\)\\{([^{}]*?${composerLit}\\((${V}),(${V})\\)[^{}]*?)\\}`
)
const matches = [...src.matchAll(new RegExp(siteRe, 'g'))]
if (matches.length !== 1) {
  console.error(
    `ERROR: expected exactly 1 store-getter match, found ${matches.length}. Aborting.`
  )
  process.exit(1)
}

// $1 = getter name, $2 = original body, $3 = primary (secure store), $4 = file (fallback).
// `$2` interpolates the captured body verbatim — its literal `$` chars (e.g. `cy$`)
// are NOT re-interpreted by replace(), so no escaping is needed.
const replacement = `function $1(){${MARKER}if(process.env.SKIP_SECURESTORAGE)return $4;$2}`

src = src.replace(siteRe, replacement)

writeFileSync(cliPath, src, 'utf-8')
const m = matches[0]
console.log(
  `Patched ${m[1]}(): SKIP_SECURESTORAGE -> file backend "${m[4]}" (bypassing secure store "${m[3]}").`
)
console.log('skip-securestorage applied.')

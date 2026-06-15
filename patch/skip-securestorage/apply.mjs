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
 *   p1() => COMPOSE(keychain, file)
 * where COMPOSE (minified `ev9`) builds a "keychain-with-plaintext-fallback"
 * object: keychain is primary, the plaintext file is the fallback. We rewrite
 * the `p1()` getter so that, when `SKIP_SECURESTORAGE` is set, it returns the
 * file backend directly. The file backend (`lK6`, name:"plaintext") implements
 * read/readAsync/mutate/update/delete; the only methods it lacks
 * (readAsyncStrict/invalidateCache) are called exclusively via optional
 * chaining (`?.`) inside the mutate helper, so the bare backend is sufficient.
 *
 * Anchors (both content-based; minified names vary by version):
 *   1. The facade composer, via its `${X.name}-with-${Y.name}-fallback`
 *      template literal — captures the composer fn name.
 *   2. The zero-arg getter `function P(){return COMPOSER(keychain,file)}`
 *      — captures the getter name + the two backend identifiers. The file
 *      backend is the SECOND arg (fallback).
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

// --- 2. Find & rewrite the getter: function P(){return COMPOSER(keychain,file)}
const composerLit = composer.replace(/[$]/g, '\\$&') // escape $ for regex
const siteRe = new RegExp(`function (${V})\\(\\)\\{return ${composerLit}\\((${V}),(${V})\\)\\}`)
const matches = [...src.matchAll(new RegExp(siteRe, 'g'))]
if (matches.length !== 1) {
  console.error(
    `ERROR: expected exactly 1 store-getter match, found ${matches.length}. Aborting.`
  )
  process.exit(1)
}

// $1 = getter name, $2 = keychain (primary), $3 = file (fallback).
const composerRepl = composer.replace(/[$]/g, '$$$$') // escape $ for replacement
const replacement =
  `function $1(){${MARKER}return process.env.SKIP_SECURESTORAGE?$3:${composerRepl}($2,$3)}`

src = src.replace(siteRe, replacement)

writeFileSync(cliPath, src, 'utf-8')
const m = matches[0]
console.log(
  `Patched ${m[1]}(): SKIP_SECURESTORAGE -> file backend "${m[3]}" (bypassing keychain "${m[2]}").`
)
console.log('skip-securestorage applied.')

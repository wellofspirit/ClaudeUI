/**
 * Patch: subprocess-proxy-strip
 *
 * Strip HTTP_PROXY / HTTPS_PROXY / ALL_PROXY / NO_PROXY from env handed to
 * cli.js subprocesses (Bash tool, MCP stdio servers, LSP server, shell
 * snapshot, subagent status line).
 *
 * Why: ClaudeUI sets proxy env vars on the cli.js spawn so Anthropic API
 * traffic gets routed through a user-configured proxy. Without this patch,
 * every shell command Claude runs (`git push`, `curl`, `npm install`, etc.)
 * also inherits those env vars and routes through the proxy. Users typically
 * want the proxy scoped to Claude's API calls only.
 *
 * How it works: cli.js funnels every subprocess spawn's env through `Qk()`,
 * which returns either `process.env` verbatim (our usual path, since
 * `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` isn't set) or a scrubbed clone. We
 * intercept by wrapping every return with a helper that deletes the proxy
 * keys. Gated off when ClaudeUI sets `CLAUDEUI_PROXY_SUBPROCESSES=1` (user
 * opted in to "proxy everything").
 *
 * Anchor: the Qk() function body, located via its structural shape (not name).
 *
 * Usage: node patch/subprocess-proxy-strip/apply.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '../..')
const cliPath = resolve(projectRoot, 'vendor/claude-cli/cli.js')

const V = '[\\w$]+'

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

const MARKER = '/*PATCHED:subprocess-proxy-strip*/'

if (src.includes(MARKER)) {
  console.log('\nPatch already applied. Nothing to do.')
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Anchor the Qk() function.
//
// Shape (cli.js 2.1.114):
//   function Qk(){
//     let H=QE_(),_=Object.keys(H).length>0,q=Y_1();
//     if(!_&&!q&&!0)return process.env;
//     let O={...process.env,...H};
//     if(!q)return O;
//     for(let T of D_1)delete O[T],delete O[`INPUT_${T}`];
//     return O
//   }
//
// We capture the name + minified locals so the rebuilt body type-checks
// against whatever variables cli.js renamed them to across versions.
// ---------------------------------------------------------------------------

const fnRe = new RegExp(
  `function (${V})\\(\\)\\{` +
    `let (${V})=(${V})\\(\\),(${V})=Object\\.keys\\(\\2\\)\\.length>0,(${V})=(${V})\\(\\);` +
    `if\\(!\\4&&!\\5&&!0\\)return process\\.env;` +
    `let (${V})=\\{\\.\\.\\.process\\.env,\\.\\.\\.\\2\\};` +
    `if\\(!\\5\\)return \\7;` +
    `for\\(let (${V}) of (${V})\\)delete \\7\\[\\8\\],delete \\7\\[\`INPUT_\\$\\{\\8\\}\`\\];` +
    `return \\7` +
    `\\}`
)

const match = fnRe.exec(src)
if (!match) {
  console.error('ERROR: Cannot locate Qk() function by structural shape.')
  console.error('The function may have been refactored by upstream. Re-run bundle-analyzer.')
  process.exit(1)
}

const duplicates = [...src.matchAll(new RegExp(fnRe.source, 'g'))]
if (duplicates.length > 1) {
  console.error(`ERROR: Pattern matched ${duplicates.length} times. Aborting.`)
  process.exit(1)
}

const [full, fnName, H, QE_, flagNotEmpty, flagScrub, Y_1_, O, T, D_1] = match
console.log(`Found ${fnName}() at char ${match.index}`)
console.log(`  locals: H=${H} QE_=${QE_} _=${flagNotEmpty} q=${flagScrub} Y_1=${Y_1_} O=${O} T=${T} D_1=${D_1}`)

// ---------------------------------------------------------------------------
// Rebuild the function body, routing every return through a proxy-strip
// helper. The helper returns the input unchanged if CLAUDEUI_PROXY_SUBPROCESSES
// is set (opt-in "proxy everything"), otherwise returns a shallow clone with
// HTTP_PROXY / HTTPS_PROXY / ALL_PROXY / NO_PROXY (upper + lower case) removed.
// ---------------------------------------------------------------------------

const stripHelperName = '__cuPS' // ClaudeUI proxy strip
const newFn =
  MARKER +
  `function ${fnName}(){` +
    `let ${stripHelperName}=(E)=>{` +
      `if(process.env.CLAUDEUI_PROXY_SUBPROCESSES)return E;` +
      `let R={...E};` +
      `delete R.HTTP_PROXY;delete R.HTTPS_PROXY;delete R.ALL_PROXY;delete R.NO_PROXY;` +
      `delete R.http_proxy;delete R.https_proxy;delete R.all_proxy;delete R.no_proxy;` +
      `return R` +
    `};` +
    `let ${H}=${QE_}(),${flagNotEmpty}=Object.keys(${H}).length>0,${flagScrub}=${Y_1_}();` +
    `if(!${flagNotEmpty}&&!${flagScrub}&&!0)return ${stripHelperName}(process.env);` +
    `let ${O}={...process.env,...${H}};` +
    `if(!${flagScrub})return ${stripHelperName}(${O});` +
    `for(let ${T} of ${D_1})delete ${O}[${T}],delete ${O}[\`INPUT_\${${T}}\`];` +
    `return ${stripHelperName}(${O})` +
  `}`

src = src.replace(full, newFn)
console.log('Wrapped every return with proxy-strip helper')

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
console.log('cli.js verified.')

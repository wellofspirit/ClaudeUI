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
// Anchor the env-builder function (Qk() in 2.1.114, uv() in 2.1.118, PV() in 2.1.119).
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
// Shape (cli.js 2.1.118 — adds remote env merge):
//   function uv(){
//     let H=Bu_(),
//         _=Object.keys(H).length>0,
//         q=hH(process.env.CLAUDE_CODE_REMOTE)?QD9(_?{...process.env,...H}:process.env):{},
//         K=Object.keys(q).length>0,
//         O=LO1();
//     if(!_&&!K&&!O&&!0)return process.env;
//     let $={...process.env,...H,...q};
//     if(!O)return $;
//     for(let A of NO1)delete $[A],delete $[`INPUT_${A}`];
//     return $
//   }
//
// Shape (cli.js 2.1.119 — adds CLAUDE_BG_* / CLAUDE_CODE_SESSION_KIND scrub):
//   function PV(){
//     let H=Nd_(),
//         _=Object.keys(H).length>0,
//         q=EH(process.env.CLAUDE_CODE_REMOTE)?d09(_?{...process.env,...H}:process.env):{},
//         K=Object.keys(q).length>0,
//         O=mR1(),
//         T=!1;
//     if(T=process.env.CLAUDE_CODE_SESSION_KIND!==void 0||
//          process.env.CLAUDE_BG_SOURCE!==void 0||
//          process.env.CLAUDE_BG_ISOLATION!==void 0||
//          process.env.CLAUDE_BG_BACKEND!==void 0||
//          process.env.CLAUDE_CODE_SESSION_NAME!==void 0,
//          !_&&!K&&!O&&!T)return process.env;
//     let $={...process.env,...H,...q};
//     if(delete $.CLAUDE_CODE_SESSION_KIND,
//        delete $.CLAUDE_BG_SOURCE,
//        delete $.CLAUDE_BG_ISOLATION,
//        delete $.CLAUDE_BG_BACKEND,
//        delete $.CLAUDE_CODE_SESSION_NAME,
//        !O)return $;
//     for(let A of gR1)delete $[A],delete $[`INPUT_${A}`];
//     return $
//   }
//
// We capture the name + minified locals so the rebuilt body type-checks
// against whatever variables cli.js renamed them to across versions.
// ---------------------------------------------------------------------------

// v2.1.143 shape — adds:
//   * A new global env source `ifq` (merged between process.env and user env).
//     `$=Object.keys(ifq).length>0` is added as an extra "has-content" flag.
//   * `CLAUDE_BG_AUTH_SNAPSHOT_PATH` appended to the OAuth-style scrub list
//     and an unconditional `delete M.CLAUDE_BG_AUTH_SNAPSHOT_PATH` after the
//     merge.
//
//   function VS(){
//     let H=$e8(),
//         q=Object.keys(H).length>0,
//         $=Object.keys(ifq).length>0,
//         K=xH(process.env.CLAUDE_CODE_REMOTE)?TgK(q?{...process.env,...H}:process.env):{},
//         _=Object.keys(K).length>0,
//         A=Ct9(),
//         f=process.env.CLAUDE_CODE_OAUTH_TOKEN!==void 0||
//            process.env.CLAUDE_CODE_SUBSCRIPTION_TYPE!==void 0||
//            process.env.CLAUDE_CODE_RATE_LIMIT_TIER!==void 0||
//            process.env.CLAUDE_BG_AUTH_SNAPSHOT_PATH!==void 0,
//         z=!1;
//     z=process.env.CLAUDE_CODE_SESSION_KIND!==void 0||...;
//     let Y=Object.keys(process.env).some((O)=>O.startsWith("OTEL_"));
//     if(!q&&!_&&!A&&!z&&!f&&!Y&&!$)return process.env;
//     let M={...process.env,...ifq,...H,...K};
//     delete M.CLAUDE_CODE_OAUTH_TOKEN,...,delete M.CLAUDE_BG_AUTH_SNAPSHOT_PATH,...;
//     for(let O of Object.keys(M))if(O.startsWith("OTEL_"))delete M[O];
//     if(!A)return M;
//     for(let O of ut9)delete M[O],delete M[`INPUT_${O}`];
//     return M
//   }
const fnReV143 = new RegExp(
  `function (${V})\\(\\)\\{` +
    `let (${V})=(${V})\\(\\),` +
    `(${V})=Object\\.keys\\(\\2\\)\\.length>0,` +
    `(${V})=Object\\.keys\\((${V})\\)\\.length>0,` +
    `(${V})=(${V})\\(process\\.env\\.CLAUDE_CODE_REMOTE\\)\\?(${V})\\(\\4\\?\\{\\.\\.\\.process\\.env,\\.\\.\\.\\2\\}:process\\.env\\):\\{\\},` +
    `(${V})=Object\\.keys\\(\\7\\)\\.length>0,` +
    `(${V})=(${V})\\(\\),` +
    `(${V})=process\\.env\\.CLAUDE_CODE_OAUTH_TOKEN!==void 0\\|\\|` +
       `process\\.env\\.CLAUDE_CODE_SUBSCRIPTION_TYPE!==void 0\\|\\|` +
       `process\\.env\\.CLAUDE_CODE_RATE_LIMIT_TIER!==void 0\\|\\|` +
       `process\\.env\\.CLAUDE_BG_AUTH_SNAPSHOT_PATH!==void 0,` +
    `(${V})=!1;` +
    `\\14=process\\.env\\.CLAUDE_CODE_SESSION_KIND!==void 0\\|\\|` +
       `process\\.env\\.CLAUDE_BG_SOURCE!==void 0\\|\\|` +
       `process\\.env\\.CLAUDE_BG_ISOLATION!==void 0\\|\\|` +
       `process\\.env\\.CLAUDE_BG_BACKEND!==void 0\\|\\|` +
       `process\\.env\\.CLAUDE_CODE_SESSION_NAME!==void 0;` +
    `let (${V})=Object\\.keys\\(process\\.env\\)\\.some\\(\\((${V})\\)=>\\16\\.startsWith\\("OTEL_"\\)\\);` +
    `if\\(!\\4&&!\\10&&!\\11&&!\\14&&!\\13&&!\\15&&!\\5\\)return process\\.env;` +
    `let (${V})=\\{\\.\\.\\.process\\.env,\\.\\.\\.\\6,\\.\\.\\.\\2,\\.\\.\\.\\7\\};` +
    `delete \\17\\.CLAUDE_CODE_OAUTH_TOKEN,` +
    `delete \\17\\.CLAUDE_CODE_SUBSCRIPTION_TYPE,` +
    `delete \\17\\.CLAUDE_CODE_RATE_LIMIT_TIER,` +
    `delete \\17\\.CLAUDE_BG_AUTH_SNAPSHOT_PATH,` +
    `delete \\17\\.CLAUDE_CODE_SESSION_KIND,` +
    `delete \\17\\.CLAUDE_BG_SOURCE,` +
    `delete \\17\\.CLAUDE_BG_ISOLATION,` +
    `delete \\17\\.CLAUDE_BG_BACKEND,` +
    `delete \\17\\.CLAUDE_CODE_SESSION_NAME,` +
    `delete \\17\\.CLAUDE_CODE_RESUME_INTERRUPTED_TURN;` +
    `for\\(let (${V}) of Object\\.keys\\(\\17\\)\\)if\\(\\18\\.startsWith\\("OTEL_"\\)\\)delete \\17\\[\\18\\];` +
    `if\\(!\\11\\)return \\17;` +
    `for\\(let (${V}) of (${V})\\)delete \\17\\[\\19\\],delete \\17\\[\`INPUT_\\$\\{\\19\\}\`\\];` +
    `return \\17` +
    `\\}`
)

// v2.1.129 shape — adds OAuth token scrub (T flag) and OTEL_* scrub (z flag),
//                  plus an unconditional CLAUDE_CODE_RESUME_INTERRUPTED_TURN delete.
//
//   function sy(){
//     let H=Fn_(),
//         _=Object.keys(H).length>0,
//         q=hH(process.env.CLAUDE_CODE_REMOTE)?Kh9(_?{...process.env,...H}:process.env):{},
//         K=Object.keys(q).length>0,
//         O=_C1(),
//         T=process.env.CLAUDE_CODE_OAUTH_TOKEN!==void 0||process.env.CLAUDE_CODE_SUBSCRIPTION_TYPE!==void 0||process.env.CLAUDE_CODE_RATE_LIMIT_TIER!==void 0,
//         A=!1;
//     A=process.env.CLAUDE_CODE_SESSION_KIND!==void 0||process.env.CLAUDE_BG_SOURCE!==void 0||process.env.CLAUDE_BG_ISOLATION!==void 0||process.env.CLAUDE_BG_BACKEND!==void 0||process.env.CLAUDE_CODE_SESSION_NAME!==void 0;
//     let z=Object.keys(process.env).some((Y)=>Y.startsWith("OTEL_"));
//     if(!_&&!K&&!O&&!A&&!T&&!z)return process.env;
//     let $={...process.env,...H,...q};
//     delete $.CLAUDE_CODE_OAUTH_TOKEN,delete $.CLAUDE_CODE_SUBSCRIPTION_TYPE,delete $.CLAUDE_CODE_RATE_LIMIT_TIER,delete $.CLAUDE_CODE_SESSION_KIND,delete $.CLAUDE_BG_SOURCE,delete $.CLAUDE_BG_ISOLATION,delete $.CLAUDE_BG_BACKEND,delete $.CLAUDE_CODE_SESSION_NAME,delete $.CLAUDE_CODE_RESUME_INTERRUPTED_TURN;
//     for(let Y of Object.keys($))if(Y.startsWith("OTEL_"))delete $[Y];
//     if(!O)return $;
//     for(let Y of OC1)delete $[Y],delete $[`INPUT_${Y}`];
//     return $
//   }
const fnReV129 = new RegExp(
  `function (${V})\\(\\)\\{` +
    `let (${V})=(${V})\\(\\),` +
    `(${V})=Object\\.keys\\(\\2\\)\\.length>0,` +
    `(${V})=(${V})\\(process\\.env\\.CLAUDE_CODE_REMOTE\\)\\?(${V})\\(\\4\\?\\{\\.\\.\\.process\\.env,\\.\\.\\.\\2\\}:process\\.env\\):\\{\\},` +
    `(${V})=Object\\.keys\\(\\5\\)\\.length>0,` +
    `(${V})=(${V})\\(\\),` +
    `(${V})=process\\.env\\.CLAUDE_CODE_OAUTH_TOKEN!==void 0\\|\\|` +
       `process\\.env\\.CLAUDE_CODE_SUBSCRIPTION_TYPE!==void 0\\|\\|` +
       `process\\.env\\.CLAUDE_CODE_RATE_LIMIT_TIER!==void 0,` +
    `(${V})=!1;` +
    `\\12=process\\.env\\.CLAUDE_CODE_SESSION_KIND!==void 0\\|\\|` +
       `process\\.env\\.CLAUDE_BG_SOURCE!==void 0\\|\\|` +
       `process\\.env\\.CLAUDE_BG_ISOLATION!==void 0\\|\\|` +
       `process\\.env\\.CLAUDE_BG_BACKEND!==void 0\\|\\|` +
       `process\\.env\\.CLAUDE_CODE_SESSION_NAME!==void 0;` +
    `let (${V})=Object\\.keys\\(process\\.env\\)\\.some\\(\\((${V})\\)=>\\14\\.startsWith\\("OTEL_"\\)\\);` +
    `if\\(!\\4&&!\\8&&!\\9&&!\\12&&!\\11&&!\\13\\)return process\\.env;` +
    `let (${V})=\\{\\.\\.\\.process\\.env,\\.\\.\\.\\2,\\.\\.\\.\\5\\};` +
    `delete \\15\\.CLAUDE_CODE_OAUTH_TOKEN,` +
    `delete \\15\\.CLAUDE_CODE_SUBSCRIPTION_TYPE,` +
    `delete \\15\\.CLAUDE_CODE_RATE_LIMIT_TIER,` +
    `delete \\15\\.CLAUDE_CODE_SESSION_KIND,` +
    `delete \\15\\.CLAUDE_BG_SOURCE,` +
    `delete \\15\\.CLAUDE_BG_ISOLATION,` +
    `delete \\15\\.CLAUDE_BG_BACKEND,` +
    `delete \\15\\.CLAUDE_CODE_SESSION_NAME,` +
    `delete \\15\\.CLAUDE_CODE_RESUME_INTERRUPTED_TURN;` +
    `for\\(let (${V}) of Object\\.keys\\(\\15\\)\\)if\\(\\16\\.startsWith\\("OTEL_"\\)\\)delete \\15\\[\\16\\];` +
    `if\\(!\\9\\)return \\15;` +
    `for\\(let (${V}) of (${V})\\)delete \\15\\[\\17\\],delete \\15\\[\`INPUT_\\$\\{\\17\\}\`\\];` +
    `return \\15` +
    `\\}`
)

// v2.1.119 shape — adds CLAUDE_BG_*/SESSION_KIND scrub on top of v2.1.118
const fnReV119 = new RegExp(
  `function (${V})\\(\\)\\{` +
    `let (${V})=(${V})\\(\\),` +
    `(${V})=Object\\.keys\\(\\2\\)\\.length>0,` +
    `(${V})=(${V})\\(process\\.env\\.CLAUDE_CODE_REMOTE\\)\\?(${V})\\(\\4\\?\\{\\.\\.\\.process\\.env,\\.\\.\\.\\2\\}:process\\.env\\):\\{\\},` +
    `(${V})=Object\\.keys\\(\\5\\)\\.length>0,` +
    `(${V})=(${V})\\(\\),` +
    `(${V})=!1;` +
    `if\\(\\11=` +
      `process\\.env\\.CLAUDE_CODE_SESSION_KIND!==void 0\\|\\|` +
      `process\\.env\\.CLAUDE_BG_SOURCE!==void 0\\|\\|` +
      `process\\.env\\.CLAUDE_BG_ISOLATION!==void 0\\|\\|` +
      `process\\.env\\.CLAUDE_BG_BACKEND!==void 0\\|\\|` +
      `process\\.env\\.CLAUDE_CODE_SESSION_NAME!==void 0,` +
      `!\\4&&!\\8&&!\\9&&!\\11\\)return process\\.env;` +
    `let (${V})=\\{\\.\\.\\.process\\.env,\\.\\.\\.\\2,\\.\\.\\.\\5\\};` +
    `if\\(` +
      `delete \\12\\.CLAUDE_CODE_SESSION_KIND,` +
      `delete \\12\\.CLAUDE_BG_SOURCE,` +
      `delete \\12\\.CLAUDE_BG_ISOLATION,` +
      `delete \\12\\.CLAUDE_BG_BACKEND,` +
      `delete \\12\\.CLAUDE_CODE_SESSION_NAME,` +
      `!\\9\\)return \\12;` +
    `for\\(let (${V}) of (${V})\\)delete \\12\\[\\13\\],delete \\12\\[\`INPUT_\\$\\{\\13\\}\`\\];` +
    `return \\12` +
    `\\}`
)

// v2.1.118 shape — 3-source merge (process.env + user env + remote env)
const fnReV118 = new RegExp(
  `function (${V})\\(\\)\\{` +
    `let (${V})=(${V})\\(\\),` +
    `(${V})=Object\\.keys\\(\\2\\)\\.length>0,` +
    `(${V})=(${V})\\(process\\.env\\.CLAUDE_CODE_REMOTE\\)\\?(${V})\\(\\4\\?\\{\\.\\.\\.process\\.env,\\.\\.\\.\\2\\}:process\\.env\\):\\{\\},` +
    `(${V})=Object\\.keys\\(\\5\\)\\.length>0,` +
    `(${V})=(${V})\\(\\);` +
    `if\\(!\\4&&!\\8&&!\\9&&!0\\)return process\\.env;` +
    `let (${V})=\\{\\.\\.\\.process\\.env,\\.\\.\\.\\2,\\.\\.\\.\\5\\};` +
    `if\\(!\\9\\)return \\11;` +
    `for\\(let (${V}) of (${V})\\)delete \\11\\[\\12\\],delete \\11\\[\`INPUT_\\$\\{\\12\\}\`\\];` +
    `return \\11` +
    `\\}`
)

// v2.1.114 shape — 2-source merge (process.env + user env)
const fnReV114 = new RegExp(
  `function (${V})\\(\\)\\{` +
    `let (${V})=(${V})\\(\\),(${V})=Object\\.keys\\(\\2\\)\\.length>0,(${V})=(${V})\\(\\);` +
    `if\\(!\\4&&!\\5&&!0\\)return process\\.env;` +
    `let (${V})=\\{\\.\\.\\.process\\.env,\\.\\.\\.\\2\\};` +
    `if\\(!\\5\\)return \\7;` +
    `for\\(let (${V}) of (${V})\\)delete \\7\\[\\8\\],delete \\7\\[\`INPUT_\\$\\{\\8\\}\`\\];` +
    `return \\7` +
    `\\}`
)

const stripHelperName = '__cuPS' // ClaudeUI proxy strip
const stripHelperDecl =
  `let ${stripHelperName}=(E)=>{` +
    `if(process.env.CLAUDEUI_PROXY_SUBPROCESSES)return E;` +
    `let R={...E};` +
    `delete R.HTTP_PROXY;delete R.HTTPS_PROXY;delete R.ALL_PROXY;delete R.NO_PROXY;` +
    `delete R.http_proxy;delete R.https_proxy;delete R.all_proxy;delete R.no_proxy;` +
    `return R` +
  `};`

let match, full, newFn, shape

match = fnReV143.exec(src)
if (match) {
  shape = 'v143'
  const duplicates = [...src.matchAll(new RegExp(fnReV143.source, 'g'))]
  if (duplicates.length > 1) {
    console.error(`ERROR: v143 pattern matched ${duplicates.length} times. Aborting.`)
    process.exit(1)
  }
  const [
    ,
    fnName,
    H,                       // 2  — user env binding
    userFn,                  // 3  — getter function for user env
    flagUserNotEmpty,        // 4  — q
    flagExtraNotEmpty,       // 5  — $
    extraGlobal,             // 6  — ifq (additional global env source)
    qRemote,                 // 7  — K
    remoteGate,              // 8  — xH
    remoteFn,                // 9  — TgK
    flagRemoteNotEmpty,      // 10 — _
    flagScrub,               // 11 — A
    scrubFn,                 // 12 — Ct9
    flagOAuth,               // 13 — f
    flagBg,                  // 14 — z
    flagOtel,                // 15 — Y
    YLambda,                 // 16 — O lambda for OTEL .some
    merged,                  // 17 — M
    YOtelLoop,               // 18 — O loop var for OTEL strip
    YBlockLoop,              // 19 — O loop var for block list
    blockList                // 20 — ut9
  ] = match
  full = match[0]
  console.log(`Found ${fnName}() [v143 shape] at char ${match.index}`)
  console.log(
    `  locals: H=${H} userFn=${userFn} q=${flagUserNotEmpty} $=${flagExtraNotEmpty} ifq=${extraGlobal} ` +
    `K=${qRemote} xH=${remoteGate} TgK=${remoteFn} _=${flagRemoteNotEmpty} A=${flagScrub} Ct9=${scrubFn} ` +
    `f=${flagOAuth} z=${flagBg} Y=${flagOtel} O(λ)=${YLambda} M=${merged} ` +
    `O(otel)=${YOtelLoop} O(block)=${YBlockLoop} ut9=${blockList}`
  )

  newFn =
    MARKER +
    `function ${fnName}(){` +
      stripHelperDecl +
      `let ${H}=${userFn}(),` +
          `${flagUserNotEmpty}=Object.keys(${H}).length>0,` +
          `${flagExtraNotEmpty}=Object.keys(${extraGlobal}).length>0,` +
          `${qRemote}=${remoteGate}(process.env.CLAUDE_CODE_REMOTE)?${remoteFn}(${flagUserNotEmpty}?{...process.env,...${H}}:process.env):{},` +
          `${flagRemoteNotEmpty}=Object.keys(${qRemote}).length>0,` +
          `${flagScrub}=${scrubFn}(),` +
          `${flagOAuth}=process.env.CLAUDE_CODE_OAUTH_TOKEN!==void 0||` +
              `process.env.CLAUDE_CODE_SUBSCRIPTION_TYPE!==void 0||` +
              `process.env.CLAUDE_CODE_RATE_LIMIT_TIER!==void 0||` +
              `process.env.CLAUDE_BG_AUTH_SNAPSHOT_PATH!==void 0,` +
          `${flagBg}=!1;` +
      `${flagBg}=process.env.CLAUDE_CODE_SESSION_KIND!==void 0||` +
          `process.env.CLAUDE_BG_SOURCE!==void 0||` +
          `process.env.CLAUDE_BG_ISOLATION!==void 0||` +
          `process.env.CLAUDE_BG_BACKEND!==void 0||` +
          `process.env.CLAUDE_CODE_SESSION_NAME!==void 0;` +
      `let ${flagOtel}=Object.keys(process.env).some((${YLambda})=>${YLambda}.startsWith("OTEL_"));` +
      `if(!${flagUserNotEmpty}&&!${flagRemoteNotEmpty}&&!${flagScrub}&&!${flagBg}&&!${flagOAuth}&&!${flagOtel}&&!${flagExtraNotEmpty})return ${stripHelperName}(process.env);` +
      `let ${merged}={...process.env,...${extraGlobal},...${H},...${qRemote}};` +
      `delete ${merged}.CLAUDE_CODE_OAUTH_TOKEN,` +
      `delete ${merged}.CLAUDE_CODE_SUBSCRIPTION_TYPE,` +
      `delete ${merged}.CLAUDE_CODE_RATE_LIMIT_TIER,` +
      `delete ${merged}.CLAUDE_BG_AUTH_SNAPSHOT_PATH,` +
      `delete ${merged}.CLAUDE_CODE_SESSION_KIND,` +
      `delete ${merged}.CLAUDE_BG_SOURCE,` +
      `delete ${merged}.CLAUDE_BG_ISOLATION,` +
      `delete ${merged}.CLAUDE_BG_BACKEND,` +
      `delete ${merged}.CLAUDE_CODE_SESSION_NAME,` +
      `delete ${merged}.CLAUDE_CODE_RESUME_INTERRUPTED_TURN;` +
      `for(let ${YOtelLoop} of Object.keys(${merged}))if(${YOtelLoop}.startsWith("OTEL_"))delete ${merged}[${YOtelLoop}];` +
      `if(!${flagScrub})return ${stripHelperName}(${merged});` +
      `for(let ${YBlockLoop} of ${blockList})delete ${merged}[${YBlockLoop}],delete ${merged}[\`INPUT_\${${YBlockLoop}}\`];` +
      `return ${stripHelperName}(${merged})` +
    `}`
} else if ((match = fnReV129.exec(src))) {
  shape = 'v129'
  const duplicates = [...src.matchAll(new RegExp(fnReV129.source, 'g'))]
  if (duplicates.length > 1) {
    console.error(`ERROR: v129 pattern matched ${duplicates.length} times. Aborting.`)
    process.exit(1)
  }
  const [
    ,
    fnName,
    H,
    Fn_,
    flagUserNotEmpty,
    qRemote,
    hH_,
    Kh9_,
    flagRemoteNotEmpty,
    flagScrub,
    _C1_,
    flagOAuth,
    flagBg,
    flagOtel,
    YLambda,
    merged,
    YOtelLoop,
    YBlockLoop,
    OC1_
  ] = match
  full = match[0]
  console.log(`Found ${fnName}() [v129 shape] at char ${match.index}`)
  console.log(
    `  locals: H=${H} Fn_=${Fn_} _=${flagUserNotEmpty} q=${qRemote} hH=${hH_} Kh9=${Kh9_} ` +
    `K=${flagRemoteNotEmpty} O=${flagScrub} _C1=${_C1_} T=${flagOAuth} A=${flagBg} z=${flagOtel} ` +
    `Y(λ)=${YLambda} $=${merged} Y(otel)=${YOtelLoop} Y(block)=${YBlockLoop} OC1=${OC1_}`
  )

  newFn =
    MARKER +
    `function ${fnName}(){` +
      stripHelperDecl +
      `let ${H}=${Fn_}(),` +
          `${flagUserNotEmpty}=Object.keys(${H}).length>0,` +
          `${qRemote}=${hH_}(process.env.CLAUDE_CODE_REMOTE)?${Kh9_}(${flagUserNotEmpty}?{...process.env,...${H}}:process.env):{},` +
          `${flagRemoteNotEmpty}=Object.keys(${qRemote}).length>0,` +
          `${flagScrub}=${_C1_}(),` +
          `${flagOAuth}=process.env.CLAUDE_CODE_OAUTH_TOKEN!==void 0||` +
              `process.env.CLAUDE_CODE_SUBSCRIPTION_TYPE!==void 0||` +
              `process.env.CLAUDE_CODE_RATE_LIMIT_TIER!==void 0,` +
          `${flagBg}=!1;` +
      `${flagBg}=process.env.CLAUDE_CODE_SESSION_KIND!==void 0||` +
          `process.env.CLAUDE_BG_SOURCE!==void 0||` +
          `process.env.CLAUDE_BG_ISOLATION!==void 0||` +
          `process.env.CLAUDE_BG_BACKEND!==void 0||` +
          `process.env.CLAUDE_CODE_SESSION_NAME!==void 0;` +
      `let ${flagOtel}=Object.keys(process.env).some((${YLambda})=>${YLambda}.startsWith("OTEL_"));` +
      `if(!${flagUserNotEmpty}&&!${flagRemoteNotEmpty}&&!${flagScrub}&&!${flagBg}&&!${flagOAuth}&&!${flagOtel})return ${stripHelperName}(process.env);` +
      `let ${merged}={...process.env,...${H},...${qRemote}};` +
      `delete ${merged}.CLAUDE_CODE_OAUTH_TOKEN,` +
      `delete ${merged}.CLAUDE_CODE_SUBSCRIPTION_TYPE,` +
      `delete ${merged}.CLAUDE_CODE_RATE_LIMIT_TIER,` +
      `delete ${merged}.CLAUDE_CODE_SESSION_KIND,` +
      `delete ${merged}.CLAUDE_BG_SOURCE,` +
      `delete ${merged}.CLAUDE_BG_ISOLATION,` +
      `delete ${merged}.CLAUDE_BG_BACKEND,` +
      `delete ${merged}.CLAUDE_CODE_SESSION_NAME,` +
      `delete ${merged}.CLAUDE_CODE_RESUME_INTERRUPTED_TURN;` +
      `for(let ${YOtelLoop} of Object.keys(${merged}))if(${YOtelLoop}.startsWith("OTEL_"))delete ${merged}[${YOtelLoop}];` +
      `if(!${flagScrub})return ${stripHelperName}(${merged});` +
      `for(let ${YBlockLoop} of ${OC1_})delete ${merged}[${YBlockLoop}],delete ${merged}[\`INPUT_\${${YBlockLoop}}\`];` +
      `return ${stripHelperName}(${merged})` +
    `}`
} else if ((match = fnReV119.exec(src))) {
  shape = 'v119'
  const duplicates = [...src.matchAll(new RegExp(fnReV119.source, 'g'))]
  if (duplicates.length > 1) {
    console.error(`ERROR: v119 pattern matched ${duplicates.length} times. Aborting.`)
    process.exit(1)
  }
  const [
    ,
    fnName,
    H,
    Nd_,
    flagUserNotEmpty,
    qRemote,
    EH_,
    d09_,
    flagRemoteNotEmpty,
    flagScrub,
    mR1_,
    flagBg,
    merged,
    T,
    gR1_
  ] = match
  full = match[0]
  console.log(`Found ${fnName}() [v119 shape] at char ${match.index}`)
  console.log(
    `  locals: H=${H} Nd_=${Nd_} _=${flagUserNotEmpty} q=${qRemote} EH=${EH_} d09=${d09_} ` +
    `K=${flagRemoteNotEmpty} O=${flagScrub} mR1=${mR1_} T=${flagBg} $=${merged} A=${T} gR1=${gR1_}`
  )

  newFn =
    MARKER +
    `function ${fnName}(){` +
      stripHelperDecl +
      `let ${H}=${Nd_}(),` +
          `${flagUserNotEmpty}=Object.keys(${H}).length>0,` +
          `${qRemote}=${EH_}(process.env.CLAUDE_CODE_REMOTE)?${d09_}(${flagUserNotEmpty}?{...process.env,...${H}}:process.env):{},` +
          `${flagRemoteNotEmpty}=Object.keys(${qRemote}).length>0,` +
          `${flagScrub}=${mR1_}(),` +
          `${flagBg}=!1;` +
      `if(${flagBg}=` +
        `process.env.CLAUDE_CODE_SESSION_KIND!==void 0||` +
        `process.env.CLAUDE_BG_SOURCE!==void 0||` +
        `process.env.CLAUDE_BG_ISOLATION!==void 0||` +
        `process.env.CLAUDE_BG_BACKEND!==void 0||` +
        `process.env.CLAUDE_CODE_SESSION_NAME!==void 0,` +
        `!${flagUserNotEmpty}&&!${flagRemoteNotEmpty}&&!${flagScrub}&&!${flagBg})return ${stripHelperName}(process.env);` +
      `let ${merged}={...process.env,...${H},...${qRemote}};` +
      `if(` +
        `delete ${merged}.CLAUDE_CODE_SESSION_KIND,` +
        `delete ${merged}.CLAUDE_BG_SOURCE,` +
        `delete ${merged}.CLAUDE_BG_ISOLATION,` +
        `delete ${merged}.CLAUDE_BG_BACKEND,` +
        `delete ${merged}.CLAUDE_CODE_SESSION_NAME,` +
        `!${flagScrub})return ${stripHelperName}(${merged});` +
      `for(let ${T} of ${gR1_})delete ${merged}[${T}],delete ${merged}[\`INPUT_\${${T}}\`];` +
      `return ${stripHelperName}(${merged})` +
    `}`
} else if ((match = fnReV118.exec(src))) {
  shape = 'v118'
  const duplicates = [...src.matchAll(new RegExp(fnReV118.source, 'g'))]
  if (duplicates.length > 1) {
    console.error(`ERROR: v118 pattern matched ${duplicates.length} times. Aborting.`)
    process.exit(1)
  }
  const [, fnName, H, Bu_, flagUserNotEmpty, qRemote, hH_, QD9_, flagRemoteNotEmpty, flagScrub, LO1_, merged, T, D_1] = match
  full = match[0]
  console.log(`Found ${fnName}() [v118 shape] at char ${match.index}`)
  console.log(`  locals: H=${H} Bu_=${Bu_} _=${flagUserNotEmpty} q=${qRemote} hH=${hH_} QD9=${QD9_} K=${flagRemoteNotEmpty} O=${flagScrub} LO1=${LO1_} $=${merged} A=${T} NO1=${D_1}`)

  newFn =
    MARKER +
    `function ${fnName}(){` +
      stripHelperDecl +
      `let ${H}=${Bu_}(),` +
          `${flagUserNotEmpty}=Object.keys(${H}).length>0,` +
          `${qRemote}=${hH_}(process.env.CLAUDE_CODE_REMOTE)?${QD9_}(${flagUserNotEmpty}?{...process.env,...${H}}:process.env):{},` +
          `${flagRemoteNotEmpty}=Object.keys(${qRemote}).length>0,` +
          `${flagScrub}=${LO1_}();` +
      `if(!${flagUserNotEmpty}&&!${flagRemoteNotEmpty}&&!${flagScrub}&&!0)return ${stripHelperName}(process.env);` +
      `let ${merged}={...process.env,...${H},...${qRemote}};` +
      `if(!${flagScrub})return ${stripHelperName}(${merged});` +
      `for(let ${T} of ${D_1})delete ${merged}[${T}],delete ${merged}[\`INPUT_\${${T}}\`];` +
      `return ${stripHelperName}(${merged})` +
    `}`
} else if ((match = fnReV114.exec(src))) {
  shape = 'v114'
  const duplicates = [...src.matchAll(new RegExp(fnReV114.source, 'g'))]
  if (duplicates.length > 1) {
    console.error(`ERROR: v114 pattern matched ${duplicates.length} times. Aborting.`)
    process.exit(1)
  }
  const [, fnName, H, QE_, flagNotEmpty, flagScrub, Y_1_, O, T, D_1] = match
  full = match[0]
  console.log(`Found ${fnName}() [v114 shape] at char ${match.index}`)
  console.log(`  locals: H=${H} QE_=${QE_} _=${flagNotEmpty} q=${flagScrub} Y_1=${Y_1_} O=${O} T=${T} D_1=${D_1}`)

  newFn =
    MARKER +
    `function ${fnName}(){` +
      stripHelperDecl +
      `let ${H}=${QE_}(),${flagNotEmpty}=Object.keys(${H}).length>0,${flagScrub}=${Y_1_}();` +
      `if(!${flagNotEmpty}&&!${flagScrub}&&!0)return ${stripHelperName}(process.env);` +
      `let ${O}={...process.env,...${H}};` +
      `if(!${flagScrub})return ${stripHelperName}(${O});` +
      `for(let ${T} of ${D_1})delete ${O}[${T}],delete ${O}[\`INPUT_\${${T}}\`];` +
      `return ${stripHelperName}(${O})` +
    `}`
} else {
  console.error('ERROR: Cannot locate env-builder function by v114, v118, or v119 structural shape.')
  console.error('The function may have been refactored by upstream. Re-run bundle-analyzer.')
  process.exit(1)
}

src = src.replace(full, newFn)
console.log(`Wrapped every return with proxy-strip helper (${shape} shape)`)

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

/**
 * Patch: mcp-status
 *
 * Fixes the mcp_status control request returning empty/incomplete servers in
 * headless/SDK mode.
 *
 * Bug: In headless (bare) mode, MCP servers from `--mcp-config` are never
 * loaded into the appState because the headless refresh function V6() is
 * gated by `if(!Y9())` (skipped in bare mode). Even if V6() ran, the server
 * loading function s() is gated by BeK() (plugin installation), which may
 * return false. As a result, mcpServerStatus() returns only cloud-configured
 * servers (e.g. claude.ai proxy servers), missing locally configured ones.
 *
 * Fix (Part A): Always store the plugin refresh promise (remove SYNC_PLUGIN
 *               conditional) so it can be awaited when available.
 * Fix (Part B): Before returning mcp_status, call the headless MCP refresh
 *               function s() which loads all configured servers (from
 *               --mcp-config, user/project config, etc.) into the appState.
 *               The underlying X6() serializer ensures concurrent calls are
 *               safe. Also await the plugin refresh promise z6 if available.
 *
 * Usage: node patch/mcp-status/apply.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '../..')
const cliPath = resolve(projectRoot, 'vendor/claude-cli/cli.js')

// Regex shorthand for minified identifier
const V = '[\\w$]+'

// ---------------------------------------------------------------------------
// Step 1: Read cli.js
// ---------------------------------------------------------------------------

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

const PATCH_A_MARKER = '/*PATCHED:mcp-status-store-promise*/'
const PATCH_B_MARKER = '/*PATCHED:mcp-status-await-refresh*/'

// =====================================================================
// Part A: Always store the plugin refresh promise (V6)
// =====================================================================
// In older SDKs: X6=null;if(!Y9())if(_1(SYNC_PLUGIN_INSTALL))X6=J6();else J6()
// Fixed to:      X6=null;if(!Y9())X6=J6()
//
// In newer SDKs (0.2.112+): The SYNC_PLUGIN_INSTALL block is more complex
// with callback setup and separate sync/async branches. The sync branch
// already stores the promise in V6. The else branch stores a non-awaitable
// wrapper in f6.
//
// We now handle both patterns. For the new pattern, we modify the else
// branch to also store the raw promise in V6 for awaiting.

const skipA = src.includes(PATCH_A_MARKER)
if (skipA) {
  console.log('\n--- Part A: Store plugin refresh promise ---')
  console.log('Already applied. Skipping.')
}

if (!skipA) {
  console.log('\n--- Part A: Store plugin refresh promise ---')

  // Try old pattern first (<=0.2.105):
  //   X6=null;[if(!Y9())]if(S6(SYNC_PLUGIN_INSTALL))X6=J6();else J6()
  const oldAnchorRe = new RegExp(
    `(${V})=null;(if\\(!${V}\\(\\)\\))?if\\((${V})\\(process\\.env\\.CLAUDE_CODE_SYNC_PLUGIN_INSTALL\\)\\)\\1=(${V})\\(\\);else \\4\\(\\)`
  )
  const oldMatch = oldAnchorRe.exec(src)

  // Try new pattern (0.2.112+):
  //   The sync branch has: ,V6=W6(callback);else f6=$X5(W6);
  //   V6 is the promise var, f6 is a non-awaitable wrapper.
  //   We need to also set V6 in the else branch.
  //
  //   Strategy: find f6=$X5(W6) by its unique position (right before "let k6=")
  //   and extract V6/W6 from the sync branch nearby.
  const newElseRe = new RegExp(
    `(${V})=(${V})\\((${V})\\);let ${V}=${V}\\(\\(\\)=>!${V}\\)`
  )
  const newElseMatch = newElseRe.exec(src)

  // Try v2.1.144 pattern:
  //   if(xH(process.env.CLAUDE_CODE_SYNC_PLUGIN_INSTALL))
  //     BH=j.outputFormat==="stream-json"?(pH)=>void H.write({...big-callback-obj...}):void 0,
  //     BH?.({status:"started"}),
  //     TH=A8((pH)=>BH?.(pH));
  //   else mH=Mq4(A8);
  // The trailing `let` no longer leads with the fire-forget assignment so the
  // v0.2.112 anchor doesn't fire. Anchor on the SYNC_PLUGIN_INSTALL check, but
  // the branch body now spans ~500 chars (complex JSON write callback). Use
  // multiline-dotall to skip over commas without committing to char counts.
  // We capture the LAST `(VAR)=(VAR)(...);` before the matching `else`.
  const v144AnchorRe = new RegExp(
    `process\\.env\\.CLAUDE_CODE_SYNC_PLUGIN_INSTALL\\)\\)[\\s\\S]*?` +
    `(${V})=(${V})\\([^;]+\\);` +
    `else (${V})=(${V})\\(\\2\\);`
  )
  const v144Match = v144AnchorRe.exec(src)

  // v2.1.163 pattern:
  //   The env access moved from process.env.CLAUDE_CODE_SYNC_PLUGIN_INSTALL to
  //   a cached env ref (<R>.CLAUDE_CODE_SYNC_PLUGIN_INSTALL). The conditional is
  //   now `if(<R>.CLAUDE_CODE_SYNC_PLUGIN_INSTALL){...sync block...<M>=(async()=>{
  //   ...})()}else <k>=<wrap>(<refresh>);`. The sync branch's awaitable
  //   orchestration promise lives in <M>; the else branch only stores a
  //   non-awaitable wrapper result in <k>. We rewrite the else branch to start
  //   the refresh ONCE and store its promise in <M> too (the same var Part B
  //   awaits and the existing `if(<M>){await <M>;<M>=null}` join consumes),
  //   reusing the started promise via a thunk so the wrapper doesn't re-invoke.
  //
  //   `INSTALL)\{` (closing-if-paren + block-open) is unique to this site;
  //   other SYNC_PLUGIN_INSTALL hits are `_TIMEOUT_MS`, `)return`, `||`,
  //   `)L_=`, `)TT()`. Lazy spans skip the ~700-char JSON-write callback
  //   without committing to char counts; the first `})()}else X=Y(Z);` after
  //   the `<M>=(async()=>{` IIFE is the matching else.
  const v163AnchorRe = new RegExp(
    `(?:${V})\\.CLAUDE_CODE_SYNC_PLUGIN_INSTALL\\)\\{` +
    `[\\s\\S]*?` +
    `(${V})=\\(async\\(\\)=>\\{` +
    `[\\s\\S]*?` +
    `\\}\\)\\(\\)\\}else (${V})=(${V})\\((${V})\\);`
  )
  const v163Match = v163AnchorRe.exec(src)

  if (v163Match) {
    const promiseVar = v163Match[1]    // M_ — awaitable orchestration promise (sync branch)
    const fireForgetVar = v163Match[2] // k_ — non-awaitable wrapper result (else branch)
    const wrapperFn = v163Match[3]     // ux4 — fire-and-forget wrapper
    const refreshFn = v163Match[4]     // T_ — plugin refresh function

    console.log(`Found v163 pattern at char ${v163Match.index}`)
    console.log(`  Promise variable: ${promiseVar}`)
    console.log(`  Fire-forget variable: ${fireForgetVar}`)
    console.log(`  Wrapper function: ${wrapperFn}`)
    console.log(`  Refresh function: ${refreshFn}`)

    const tmp = '_cuMcpRef'
    const oldElse = `else ${fireForgetVar}=${wrapperFn}(${refreshFn});`
    // Start the refresh once (tmp), expose it as the awaitable promiseVar, and
    // hand the wrapper a thunk returning the same promise (no double-invoke).
    const newElse =
      PATCH_A_MARKER +
      `else{let ${tmp}=${refreshFn}();${promiseVar}=${tmp};${fireForgetVar}=${wrapperFn}(()=>${tmp});}`

    const elseIdx = src.indexOf(oldElse)
    if (elseIdx === -1) {
      console.error(`ERROR: Cannot find else branch to patch — looking for "${oldElse}".`)
      process.exit(1)
    }
    if (src.indexOf(oldElse, elseIdx + 1) !== -1) {
      console.error(`ERROR: else branch "${oldElse}" matched multiple times. Aborting.`)
      process.exit(1)
    }

    src = src.slice(0, elseIdx) + newElse + src.slice(elseIdx + oldElse.length)
    console.log(`Patched else branch: store awaitable ${promiseVar} (refresh started once, wrapper reuses it)`)
  } else if (oldMatch) {
    // Verify uniqueness
    const allMatches = [...src.matchAll(new RegExp(oldAnchorRe, 'g'))]
    if (allMatches.length > 1) {
      console.error('ERROR: Old J6 pattern matched multiple times. Aborting.')
      process.exit(1)
    }

    const x6Var = oldMatch[1]
    const guard = oldMatch[2] ?? ''
    const j6Fn = oldMatch[4]
    console.log(`Found old pattern at char ${oldMatch.index}`)
    console.log(`  Promise variable: ${x6Var}`)
    console.log(`  Guard clause: ${guard || '(none)'}`)
    console.log(`  Refresh function: ${j6Fn}`)

    const oldCode = oldMatch[0]
    const newCode = PATCH_A_MARKER + `${x6Var}=null;${guard}${x6Var}=${j6Fn}()`

    src = src.replace(oldCode, newCode)
    console.log(`Replaced fire-and-forget with always-stored promise`)
  } else if (v144Match) {
    const promiseVar = v144Match[1]    // TH
    const refreshFn = v144Match[2]     // A8
    const fireForgetVar = v144Match[3] // mH
    const wrapperFn = v144Match[4]     // Mq4

    console.log(`Found v144 pattern at char ${v144Match.index}`)
    console.log(`  Promise variable: ${promiseVar}`)
    console.log(`  Fire-forget variable: ${fireForgetVar}`)
    console.log(`  Refresh function: ${refreshFn}`)
    console.log(`  Wrapper function: ${wrapperFn}`)

    const oldElse = `else ${fireForgetVar}=${wrapperFn}(${refreshFn});`
    // Set promiseVar in the else branch too (refresh fn is called once; the
    // serializer dedupes concurrent calls).
    const newElse = PATCH_A_MARKER + `else{${promiseVar}=${refreshFn}();${fireForgetVar}=${wrapperFn}(${refreshFn});}`

    const elseIdx = src.indexOf(oldElse)
    if (elseIdx === -1) {
      console.error(`ERROR: Cannot find else branch to patch — looking for "${oldElse}".`)
      process.exit(1)
    }
    if (src.indexOf(oldElse, elseIdx + 1) !== -1) {
      console.error(`ERROR: else branch "${oldElse}" matched multiple times. Aborting.`)
      process.exit(1)
    }

    src = src.slice(0, elseIdx) + newElse + src.slice(elseIdx + oldElse.length)
    console.log(`Patched else branch: added ${promiseVar}=${refreshFn}() before wrapper`)
  } else if (newElseMatch) {
    const fireForgetVar = newElseMatch[1]  // f6
    const wrapperFn = newElseMatch[2]      // $X5
    const refreshFn = newElseMatch[3]      // W6

    // Extract V6 from the sync branch: ,V6=W6(...);else f6=
    const syncRe = new RegExp(
      `,(${V})=${refreshFn}\\([^;]*\\);else ${fireForgetVar}=`
    )
    const syncMatch = syncRe.exec(src)
    if (!syncMatch) {
      console.error('ERROR: Cannot find sync branch V6=W6(...) before else.')
      process.exit(1)
    }
    const promiseVar = syncMatch[1]  // V6

    console.log(`Found new pattern at char ${newElseMatch.index}`)
    console.log(`  Promise variable: ${promiseVar}`)
    console.log(`  Fire-forget variable: ${fireForgetVar}`)
    console.log(`  Refresh function: ${refreshFn}`)
    console.log(`  Wrapper function: ${wrapperFn}`)

    // Replace: else f6=$X5(W6);
    // With:    else{V6=W6();f6=$X5(W6);}
    // W6 is called twice but the underlying serializer dedupes concurrent calls.
    const oldElse = `else ${fireForgetVar}=${wrapperFn}(${refreshFn});`
    const newElse = PATCH_A_MARKER + `else{${promiseVar}=${refreshFn}();${fireForgetVar}=${wrapperFn}(${refreshFn});}`

    const elseIdx = src.indexOf(oldElse)
    if (elseIdx === -1) {
      console.error('ERROR: Cannot find else branch to patch.')
      process.exit(1)
    }

    src = src.slice(0, elseIdx) + newElse + src.slice(elseIdx + oldElse.length)
    console.log(`Patched else branch: added ${promiseVar}=${refreshFn}() before wrapper`)
  } else {
    console.error('ERROR: Cannot locate SYNC_PLUGIN_INSTALL pattern (tried old and new).')
    process.exit(1)
  }
}

// =====================================================================
// Part B: Make mcp_status call the headless refresh function to load
//         all configured servers before returning status
// =====================================================================
// The headless MCP refresh function (previously named s(), now
// dynamically extracted) loads servers from all config sources
// (--mcp-config, user/project/local config, plugins) and connects
// them via the serialized updater. Calling it ensures all configured
// servers are in the appState before reading status.
//
// The function is found by the "Headless MCP refresh" string anchor
// inside its body. Its name changes between SDK versions.
//
// Original (0.2.87+):  h6.request.subtype==="mcp_status")E6(h6,{mcpServers:J6()});
// Changed:             h6.request.subtype==="mcp_status"){await <refresh>();if(<pluginVar>)await <pluginVar>;E6(h6,{mcpServers:J6()})}

const skipB = src.includes(PATCH_B_MARKER)
if (skipB) {
  console.log('\n--- Part B: mcp_status await refresh ---')
  console.log('Already applied. Skipping.')
}

if (!skipB) {
  console.log('\n--- Part B: mcp_status await refresh ---')

  // We need the plugin refresh variable name from Part A.
  // It's the promise variable (V6) that stores the plugin refresh promise.
  let x6Var

  // Try 1: old Part A marker pattern (<=0.2.105): /*PATCHED:...*/V6=null;...V6=J6()
  const markerRe = new RegExp(`\\/\\*PATCHED:mcp-status-store-promise\\*\\/(${V})=(?:null;(?:if\\(!${V}\\(\\)\\))\\1=)?(?:${V})\\(\\)`)
  const markerMatch = markerRe.exec(src)
  if (markerMatch) {
    x6Var = markerMatch[1]
    console.log(`  Plugin refresh var from Part A marker (old): ${x6Var}`)
  }

  // Try 2: new Part A marker pattern (0.2.112+): /*PATCHED:...*/else{V6=W6();...}
  if (!x6Var) {
    const newMarkerRe = new RegExp(`\\/\\*PATCHED:mcp-status-store-promise\\*\\/else\\{(${V})=`)
    const newMarkerMatch = newMarkerRe.exec(src)
    if (newMarkerMatch) {
      x6Var = newMarkerMatch[1]
      console.log(`  Plugin refresh var from Part A marker (new): ${x6Var}`)
    }
  }

  // Try 2b: v163 Part A marker pattern: /*PATCHED:...*/else{let <tmp>=<refresh>();<M>=<tmp>;...}
  if (!x6Var) {
    const v163MarkerRe = new RegExp(
      `\\/\\*PATCHED:mcp-status-store-promise\\*\\/else\\{let (${V})=(${V})\\(\\);(${V})=\\1;`
    )
    const v163MarkerMatch = v163MarkerRe.exec(src)
    if (v163MarkerMatch) {
      x6Var = v163MarkerMatch[3]
      console.log(`  Plugin refresh var from Part A marker (v163): ${x6Var}`)
    }
  }

  // Try 3: unpatched env pattern (fallback)
  if (!x6Var) {
    const envRe = new RegExp(`(${V})=null,(?:${V})=null[^;]*;if\\(!${V}\\(\\)\\)if\\(${V}\\(process\\.env\\.CLAUDE_CODE_SYNC_PLUGIN_INSTALL\\)\\)`)
    const envMatch = envRe.exec(src)
    if (envMatch) {
      x6Var = envMatch[1]
      console.log(`  Plugin refresh var from env pattern: ${x6Var}`)
    }
  }

  if (!x6Var) {
    console.error('ERROR: Cannot determine plugin refresh variable name.')
    console.error('Ensure Part A was applied first.')
    process.exit(1)
  }

  // ---------------------------------------------------------------
  // Dynamically extract the headless MCP refresh function name.
  // It's an async function containing the "Headless MCP refresh"
  // string literal. Pattern: `async function <name>(){...Headless MCP refresh...}`
  // ---------------------------------------------------------------
  // Find the "Headless MCP refresh" string, then search backward for the
  // nearest `async function <name>()` — that's the refresh function.
  const anchorStr = 'Headless MCP refresh'
  const anchorIdx = src.indexOf(anchorStr)
  let refreshFn
  if (anchorIdx === -1) {
    console.error('ERROR: Cannot locate "Headless MCP refresh" string in cli.js.')
    process.exit(1)
  }
  // Backward window: in 2.1.163 the enclosing `async function OH(...)` sits
  // ~540 chars before the "Headless MCP refresh" string (its body grew), so a
  // 500-char window misses it. 2000 comfortably spans the body while the
  // last-match logic still resolves to the function containing the string.
  const BACK = 2000
  {
    const before = src.slice(Math.max(0, anchorIdx - BACK), anchorIdx)
    // Accept zero-or-more args: older versions had `()`, 2.1.114+ has `(param)`.
    const fnRe = new RegExp(`async function (${V})\\([^)]*\\)\\{`, 'g')
    let m, last
    while ((m = fnRe.exec(before)) !== null) last = m
    if (last) {
      refreshFn = last[1]
      const fnGlobalOffset = Math.max(0, anchorIdx - BACK) + last.index
      console.log(`  Headless MCP refresh function: ${refreshFn} (at char ${fnGlobalOffset})`)
    } else {
      console.error('ERROR: Cannot find async function before "Headless MCP refresh" string.')
      process.exit(1)
    }
  }

  // Verify the refresh function is in scope at the mcp_status handler.
  // Both should be inside the same parent function (the main run loop).
  const refreshFnIdx = Math.max(0, anchorIdx - BACK) + (src.slice(Math.max(0, anchorIdx - BACK), anchorIdx).lastIndexOf(`async function ${refreshFn}`))
  const mcpHandlerIdx = src.indexOf('"mcp_status"', refreshFnIdx)
  if (mcpHandlerIdx === -1 || mcpHandlerIdx - refreshFnIdx > 50000) {
    console.warn(`  WARNING: Refresh function at ${refreshFnIdx}, mcp_status at ${mcpHandlerIdx} — may not share scope`)
  } else {
    console.log(`  Scope check OK: refresh fn and mcp_status handler are ${mcpHandlerIdx - refreshFnIdx} chars apart`)
  }

  // Try new pattern first (0.2.87+): inline call without block
  const mcpInlineRe = new RegExp(
    `(${V})\\.request\\.subtype==="mcp_status"\\)(${V})\\(\\1,\\{mcpServers:(${V})\\(\\)\\}\\);`
  )
  const mcpInlineMatch = mcpInlineRe.exec(src)

  // Try old pattern (<=0.2.81): block with optional await d()
  const mcpBlockRe = new RegExp(
    `(${V})\\.request\\.subtype==="mcp_status"\\)\\{(await (${V})\\(\\);)?let`
  )
  const mcpBlockMatch = mcpBlockRe.exec(src)

  if (mcpInlineMatch) {
    // Verify uniqueness
    const allMatches = [...src.matchAll(new RegExp(mcpInlineRe, 'g'))]
    if (allMatches.length > 1) {
      console.error('ERROR: mcp_status inline pattern matched multiple times. Aborting.')
      process.exit(1)
    }

    const msgVar = mcpInlineMatch[1]
    const respondFn = mcpInlineMatch[2]
    const getMcpFn = mcpInlineMatch[3]
    console.log(`Found mcp_status handler (inline form) at char ${mcpInlineMatch.index}`)
    console.log(`  Message variable: ${msgVar}`)
    console.log(`  Respond function: ${respondFn}`)
    console.log(`  getMcp function: ${getMcpFn}`)

    // Replace: wrap in block, call refresh fn to load servers, then await plugin refresh
    const oldMcp = mcpInlineMatch[0]
    const newMcp = PATCH_B_MARKER +
      `${msgVar}.request.subtype==="mcp_status"){await ${refreshFn}();if(${x6Var})await ${x6Var};${respondFn}(${msgVar},{mcpServers:${getMcpFn}()})}`

    src = src.replace(oldMcp, newMcp)
    console.log(`Injected await ${refreshFn}() + await ${x6Var} in mcp_status handler (inline->block)`)
  } else if (mcpBlockMatch) {
    // Verify uniqueness
    const allMatches = [...src.matchAll(new RegExp(mcpBlockRe, 'g'))]
    if (allMatches.length > 1) {
      console.error('ERROR: mcp_status block pattern matched multiple times. Aborting.')
      process.exit(1)
    }

    const msgVar = mcpBlockMatch[1]
    const hasAwaitD = !!mcpBlockMatch[2]
    const dFn = mcpBlockMatch[3]
    console.log(`Found mcp_status handler (block form) at char ${mcpBlockMatch.index}`)
    console.log(`  Message variable: ${msgVar}`)
    console.log(`  Has await d(): ${hasAwaitD}${hasAwaitD ? ` (fn: ${dFn})` : ''}`)

    const oldMcp = mcpBlockMatch[0]
    const awaitPart = hasAwaitD ? `await ${dFn}();` : ''
    const newMcp = PATCH_B_MARKER +
      `${msgVar}.request.subtype==="mcp_status"){${awaitPart}await ${refreshFn}();if(${x6Var})await ${x6Var};let`

    src = src.replace(oldMcp, newMcp)
    console.log(`Injected await ${refreshFn}() + await ${x6Var} in mcp_status handler (block form)`)
  } else {
    console.error('ERROR: Cannot locate mcp_status handler pattern.')
    console.error('Tried inline pattern: <msg>.request.subtype==="mcp_status")<respondFn>(<msg>,{mcpServers:<fn>()});')
    console.error('Tried block pattern: <msg>.request.subtype==="mcp_status"){(await <fn>();)?let')
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// Write and verify
// ---------------------------------------------------------------------------

if (!skipA || !skipB) {
  writeFileSync(cliPath, src)
  console.log(`\nPatch applied to ${cliPath}`)

  const verify = readFileSync(cliPath, 'utf-8')
  const aOk = verify.includes(PATCH_A_MARKER)
  const bOk = verify.includes(PATCH_B_MARKER)
  console.log(`  ${aOk ? 'OK' : 'MISSING'} Part A marker (store plugin refresh promise)`)
  console.log(`  ${bOk ? 'OK' : 'MISSING'} Part B marker (mcp_status await s())`)

  if (!aOk || !bOk) {
    console.error('\nVerification FAILED.')
    process.exit(1)
  }
  console.log('\ncli.js verified.')
} else {
  console.log('\nAll patches already applied. Nothing to do.')
}

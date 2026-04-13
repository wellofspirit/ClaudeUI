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
const cliPath = resolve(projectRoot, 'node_modules/@anthropic-ai/claude-agent-sdk/cli.js')

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
  console.error('Is @anthropic-ai/claude-agent-sdk installed?')
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
// Original:  X6=null;if(!Y9())if(_1(process.env.CLAUDE_CODE_SYNC_PLUGIN_INSTALL))X6=J6();else J6()
// Changed:   X6=null;if(!Y9())X6=J6()
// This ensures the headless MCP refresh promise is stored so it can be awaited.

const skipA = src.includes(PATCH_A_MARKER)
if (skipA) {
  console.log('\n--- Part A: Store plugin refresh promise ---')
  console.log('Already applied. Skipping.')
}

if (!skipA) {
  console.log('\n--- Part A: Store plugin refresh promise ---')

  const anchorRe = new RegExp(
    `(${V})=null;(if\\(!${V}\\(\\)\\))?if\\((${V})\\(process\\.env\\.CLAUDE_CODE_SYNC_PLUGIN_INSTALL\\)\\)\\1=(${V})\\(\\);else \\4\\(\\)`
  )

  const match = anchorRe.exec(src)
  if (!match) {
    console.error('ERROR: Cannot locate J6 fire-and-forget pattern.')
    console.error('Pattern: <X6>=null;[if(!<zY>())]if(<_1>(process.env.CLAUDE_CODE_SYNC_PLUGIN_INSTALL))<X6>=<J6>();else <J6>()')
    process.exit(1)
  }

  // Verify uniqueness
  const allMatches = [...src.matchAll(new RegExp(anchorRe, 'g'))]
  if (allMatches.length > 1) {
    console.error('ERROR: J6 pattern matched multiple times. Aborting.')
    process.exit(1)
  }

  const x6Var = match[1]
  const guard = match[2] ?? ''
  const j6Fn = match[4]
  console.log(`Found J6 pattern at char ${match.index}`)
  console.log(`  Promise variable: ${x6Var}`)
  console.log(`  Guard clause: ${guard || '(none)'}`)
  console.log(`  Refresh function: ${j6Fn}`)

  const oldCode = match[0]
  const newCode = PATCH_A_MARKER + `${x6Var}=null;${guard}${x6Var}=${j6Fn}()`

  src = src.replace(oldCode, newCode)
  console.log(`Replaced fire-and-forget with always-stored promise`)
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
  let x6Var
  const markerRe = new RegExp(`\\/\\*PATCHED:mcp-status-store-promise\\*\\/(${V})=(?:null;(?:if\\(!${V}\\(\\)\\))\\1=)?(?:${V})\\(\\)`)
  const markerMatch = markerRe.exec(src)
  if (markerMatch) {
    x6Var = markerMatch[1]
    console.log(`  Plugin refresh var from Part A marker: ${x6Var}`)
  } else {
    // Fallback: try extracting from the unpatched env pattern
    const envRe = new RegExp(`(${V})=null;(?:if\\(!${V}\\(\\)\\))?if\\((${V})\\(process\\.env\\.CLAUDE_CODE_SYNC_PLUGIN_INSTALL\\)\\)`)
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
  {
    const before = src.slice(Math.max(0, anchorIdx - 500), anchorIdx)
    const fnRe = new RegExp(`async function (${V})\\(\\)\\{`, 'g')
    let m, last
    while ((m = fnRe.exec(before)) !== null) last = m
    if (last) {
      refreshFn = last[1]
      const fnGlobalOffset = Math.max(0, anchorIdx - 500) + last.index
      console.log(`  Headless MCP refresh function: ${refreshFn} (at char ${fnGlobalOffset})`)
    } else {
      console.error('ERROR: Cannot find async function before "Headless MCP refresh" string.')
      process.exit(1)
    }
  }

  // Verify the refresh function is in scope at the mcp_status handler.
  // Both should be inside the same parent function (the main run loop).
  const refreshFnIdx = Math.max(0, anchorIdx - 500) + (src.slice(Math.max(0, anchorIdx - 500), anchorIdx).lastIndexOf(`async function ${refreshFn}`))
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

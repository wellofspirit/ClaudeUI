/**
 * Patch: mcp-status
 *
 * Fixes the mcp_status control request returning empty servers in headless/SDK mode.
 *
 * Bug: In headless mode, plugin MCP servers are loaded asynchronously by J6()
 * (the headless MCP refresh function) which runs fire-and-forget. When the SDK
 * sends mcp_status before J6() completes, the response contains no servers
 * because:
 *   1. w6.mcp.clients is empty (initial state created before plugins installed)
 *   2. h is empty (no SDK-type servers)
 *   3. x.clients is empty (dynamic servers not yet loaded by J6)
 *
 * Fix (Part A): Always store the J6() promise so it can be awaited.
 * Fix (Part B): Make the mcp_status handler await the stored J6 promise
 *               before reading state, ensuring plugin servers are loaded.
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
// Part A: Always store the J6() promise
// =====================================================================
// Original:  X6=null;if(_1(process.env.CLAUDE_CODE_SYNC_PLUGIN_INSTALL))X6=J6();else J6()
// Changed:   X6=J6()
// This ensures the headless MCP refresh promise is stored so it can be awaited.

const skipA = src.includes(PATCH_A_MARKER)
if (skipA) {
  console.log('\n--- Part A: Store J6 promise ---')
  console.log('Already applied. Skipping.')
}

if (!skipA) {
  console.log('\n--- Part A: Store J6 promise ---')

  // Find the pattern where J6() is conditionally stored based on env var
  // X6=null;if(_1(process.env.CLAUDE_CODE_SYNC_PLUGIN_INSTALL))X6=J6();else J6()
  const anchorRe = new RegExp(
    `(${V})=null;if\\((${V})\\(process\\.env\\.CLAUDE_CODE_SYNC_PLUGIN_INSTALL\\)\\)\\1=(${V})\\(\\);else \\3\\(\\)`
  )

  const match = anchorRe.exec(src)
  if (!match) {
    console.error('ERROR: Cannot locate J6 fire-and-forget pattern.')
    console.error('Pattern: <X6>=null;if(<_1>(process.env.CLAUDE_CODE_SYNC_PLUGIN_INSTALL))<X6>=<J6>();else <J6>()')
    process.exit(1)
  }

  // Verify uniqueness
  const allMatches = [...src.matchAll(new RegExp(anchorRe, 'g'))]
  if (allMatches.length > 1) {
    console.error('ERROR: J6 pattern matched multiple times. Aborting.')
    process.exit(1)
  }

  const x6Var = match[1]  // X6 (the promise storage variable)
  const j6Fn = match[3]   // J6 (the headless MCP refresh function)
  console.log(`Found J6 pattern at char ${match.index}`)
  console.log(`  Promise variable: ${x6Var}`)
  console.log(`  Refresh function: ${j6Fn}`)

  // Replace: always store the promise
  const oldCode = match[0]
  const newCode = PATCH_A_MARKER + `${x6Var}=${j6Fn}()`

  src = src.replace(oldCode, newCode)
  console.log(`Replaced fire-and-forget with always-stored promise`)
}

// =====================================================================
// Part B: Make mcp_status await the stored promise
// =====================================================================
// Original:  e.request.subtype==="mcp_status"){await d();let
// Changed:   e.request.subtype==="mcp_status"){await d();if(X6)await X6;let
// This ensures mcp_status waits for plugin MCP servers to be loaded.

const skipB = src.includes(PATCH_B_MARKER)
if (skipB) {
  console.log('\n--- Part B: mcp_status await refresh ---')
  console.log('Already applied. Skipping.')
}

if (!skipB) {
  console.log('\n--- Part B: mcp_status await refresh ---')

  // We need to find the X6 variable name from Part A (or re-extract it)
  // The X6 variable is in the same function scope as the mcp_status handler.
  // After Part A, the code has: <X6>=<J6>()
  // We already know X6 from Part A, but if Part A was already applied, extract it.
  let x6Var
  const markerRe = new RegExp(`\\/\\*PATCHED:mcp-status-store-promise\\*\\/(${V})=(${V})\\(\\)`)
  const markerMatch = markerRe.exec(src)
  if (markerMatch) {
    x6Var = markerMatch[1]
    console.log(`  X6 from Part A marker: ${x6Var}`)
  } else {
    // Part A was already applied in a previous run with a different marker? Try extracting.
    const envRe = new RegExp(`(${V})=null;if\\((${V})\\(process\\.env\\.CLAUDE_CODE_SYNC_PLUGIN_INSTALL\\)\\)`)
    const envMatch = envRe.exec(src)
    if (envMatch) {
      x6Var = envMatch[1]
      console.log(`  X6 from env pattern: ${x6Var}`)
    } else {
      // Try the patched form
      const patchedRe = new RegExp(`(${V})=(${V})\\(\\);let ${V}=`)
      // This is ambiguous, so let's use a more specific pattern
      // Look for the SYNC_PLUGIN_INSTALL env var reference
      const syncRe = new RegExp(`CLAUDE_CODE_SYNC_PLUGIN_INSTALL.*?(${V})=(${V})\\(\\)`)
      const syncMatch = syncRe.exec(src)
      if (syncMatch) {
        x6Var = syncMatch[1]
        console.log(`  X6 from SYNC pattern: ${x6Var}`)
      }
    }
  }

  if (!x6Var) {
    console.error('ERROR: Cannot determine X6 (promise storage) variable name.')
    console.error('Ensure Part A was applied first.')
    process.exit(1)
  }

  // Find the mcp_status handler pattern
  // Pattern: e.request.subtype==="mcp_status"){await d();let
  const mcpRe = new RegExp(
    `(${V})\\.request\\.subtype==="mcp_status"\\)\\{await (${V})\\(\\);let`
  )
  const mcpMatch = mcpRe.exec(src)
  if (!mcpMatch) {
    console.error('ERROR: Cannot locate mcp_status handler pattern.')
    process.exit(1)
  }

  // Verify uniqueness
  const allMcpMatches = [...src.matchAll(new RegExp(mcpRe, 'g'))]
  if (allMcpMatches.length > 1) {
    console.error('ERROR: mcp_status pattern matched multiple times. Aborting.')
    process.exit(1)
  }

  const mcpIdx = mcpMatch.index
  const msgVar = mcpMatch[1]
  const dFn = mcpMatch[2]
  console.log(`Found mcp_status handler at char ${mcpIdx}`)
  console.log(`  Message variable: ${msgVar}`)
  console.log(`  Deferred fn: ${dFn}`)

  // Replace: add X6 await after d() call
  const oldMcp = mcpMatch[0]
  const newMcp = PATCH_B_MARKER +
    `${msgVar}.request.subtype==="mcp_status"){await ${dFn}();if(${x6Var})await ${x6Var};let`

  src = src.replace(oldMcp, newMcp)
  console.log(`Injected await ${x6Var} in mcp_status handler`)
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
  console.log(`  ${aOk ? 'OK' : 'MISSING'} Part A marker (store J6 promise)`)
  console.log(`  ${bOk ? 'OK' : 'MISSING'} Part B marker (mcp_status await)`)

  if (!aOk || !bOk) {
    console.error('\nVerification FAILED.')
    process.exit(1)
  }
  console.log('\ncli.js verified.')
} else {
  console.log('\nAll patches already applied. Nothing to do.')
}

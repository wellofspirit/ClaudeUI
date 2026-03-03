/**
 * Patch: mcp-tool-refresh
 *
 * Fixes MCP server enable/disable (mcp_toggle) not updating the model's tool
 * list in the SDK query path. The CLI React UI has a `refreshTools` callback
 * that reads live MCP tools from app state after each turn, but the SDK query
 * path (used by ClaudeUI via sdkQuery()) never sets this callback — tools are
 * frozen at session start.
 *
 * Two-part fix:
 *   Part A — Refresh tools before each EVq call in the main message loop.
 *            This ensures each NEW user message gets the current MCP tool list.
 *   Part B — Add refreshTools fallback in iR's turn loop.
 *            This ensures multi-turn tool-use cycles within a single message
 *            also get fresh tools between API calls.
 *
 * Usage: node patch/mcp-tool-refresh/apply.mjs
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

const PATCH_A_MARKER = '/*PATCHED:mcp-tool-refresh-A*/'
const PATCH_B_MARKER = '/*PATCHED:mcp-tool-refresh-B*/'

// Helper: deduplicate-by-name code snippet (reused in both parts)
function deduplicateCode(toolsExpr, mcpToolsExpr, assignTarget) {
  return (
    `{let _base=${toolsExpr}.filter(function(_t){return!_t.isMcp});` +
    `let _merged=[..._base,...${mcpToolsExpr}];` +
    `let _seen=new Set();` +
    `${assignTarget}=_merged.filter(function(_t){` +
      `if(_seen.has(_t.name))return!1;` +
      `_seen.add(_t.name);return!0` +
    `})}`
  )
}


// =====================================================================
// Part A: Refresh tools before each EVq call in the main message loop
// =====================================================================
//
// In the SDK's main message loop, tools are built ONCE at session start:
//   let w6 = hZ([...Y, ...e, ...p, ...x.tools], "name")
//
// Then for each user message, EVq is called with `tools: w6` (frozen).
// We inject a tool refresh right before the `for await(... of EVq({`
// call. This reads current MCP tools from getAppState() and rebuilds w6.
//
// Anchor: `for await(let <V> of EVq({commands:<V>,prompt:<V>,
//          promptUuid:<V>.uuid,cwd:ml8(),tools:<w6>,`
//
// We also need getAppState which is `$` in this scope. We extract it
// from `getAppState:<$>,setAppState:` within the same EVq call.

const skipA = src.includes(PATCH_A_MARKER)
if (skipA) {
  console.log('\n--- Part A: Refresh tools before EVq ---')
  console.log('Already applied. Skipping.')
}

if (!skipA) {
  console.log('\n--- Part A: Refresh tools before EVq ---')

  // Step A1: Find the query call and extract the tools variable name
  // Pattern: `for await(let <V> of <queryFn>({commands:<V>,prompt:<V>,
  //           promptUuid:<V>.uuid,cwd:<cwdFn>(),tools:<toolsVar>,`
  // Function names (EVq, ml8, etc.) change between versions — match by content shape.
  const evqRe = new RegExp(
    `for await\\(let (${V}) of (${V})\\(\\{` +
    `commands:(${V}),prompt:(${V}),` +
    `promptUuid:(${V})\\.uuid,cwd:(${V})\\(\\),` +
    `tools:(${V}),`
  )

  const evqMatch = evqRe.exec(src)
  if (!evqMatch) {
    console.error('ERROR: Cannot locate query call site (EVq/ckq equivalent).')
    console.error('Use bundle-analyzer to find it:')
    console.error('  bundle-analyzer find cli.js "promptUuid" --compact')
    process.exit(1)
  }

  // Verify uniqueness
  const allEvqMatches = [...src.matchAll(new RegExp(evqRe, 'g'))]
  if (allEvqMatches.length > 1) {
    console.error('ERROR: Query call pattern matched multiple times. Aborting.')
    process.exit(1)
  }

  const queryFn = evqMatch[2]   // EVq / ckq
  const toolsVar = evqMatch[7]  // w6 / Z6
  console.log(`Found ${queryFn} call at char ${evqMatch.index}`)
  console.log(`  Tools variable: ${toolsVar}`)

  // Step A2: Extract getAppState variable from the same query call
  // Look forward from the match to find `getAppState:<$>,setAppState:`
  const evqRegion = src.slice(evqMatch.index, evqMatch.index + 1500)
  const gasRe = new RegExp(`getAppState:(${V}),setAppState:`)
  const gasMatch = gasRe.exec(evqRegion)
  if (!gasMatch) {
    console.error(`ERROR: Cannot find getAppState in ${queryFn} call.`)
    process.exit(1)
  }

  const getAppStateVar = gasMatch[1]  // $
  console.log(`  getAppState variable: ${getAppStateVar}`)

  // Step A3: Build the injection code
  // Inject right before `for await(let ... of EVq({`
  // Read MCP tools from app state and rebuild the tools list
  const refreshCode = PATCH_A_MARKER +
    `{let _st=await ${getAppStateVar}();` +
    `if(_st&&_st.mcp&&_st.mcp.tools)` +
    deduplicateCode(toolsVar, '_st.mcp.tools', toolsVar) +
    `}`

  // Replace: inject refresh code before `for await`
  const forAwaitStr = evqMatch[0]
  src = src.replace(forAwaitStr, refreshCode + forAwaitStr)
  console.log(`Injected tool refresh before ${queryFn} call`)
}


// =====================================================================
// Part B: Add refreshTools fallback in iR's turn loop
// =====================================================================
//
// Even after Part A refreshes tools for each new message, multi-turn
// tool-use cycles within a single message still use frozen tools.
// The refreshTools check in iR only fires when the CLI React UI sets it.
//
// We add an `else` branch: when refreshTools is NOT set (SDK path),
// read MCP tools from app state and rebuild the tool list.
//
// Anchor: The unique refreshTools if-block in iR:
//   <X6>.options.refreshTools){
//     let <s>=<X6>.options.refreshTools();
//     if(<s>!==<X6>.options.tools)
//       <X6>={...<X6>,options:{...<X6>.options,tools:<s>}}
//   }

const skipB = src.includes(PATCH_B_MARKER)
if (skipB) {
  console.log('\n--- Part B: iR refreshTools fallback ---')
  console.log('Already applied. Skipping.')
}

if (!skipB) {
  console.log('\n--- Part B: iR refreshTools fallback ---')

  const refreshRe = new RegExp(
    `(${V})\\.options\\.refreshTools\\)\\{` +
    `let (${V})=\\1\\.options\\.refreshTools\\(\\);` +
    `if\\(\\2!==\\1\\.options\\.tools\\)` +
    `\\1=\\{` +
    `\\.\\.\\.\\1,options:\\{` +
    `\\.\\.\\.\\1\\.options,tools:\\2` +
    `\\}\\}\\}`
  )

  const match = refreshRe.exec(src)
  if (!match) {
    console.error('ERROR: Cannot locate refreshTools check pattern.')
    console.error('Use bundle-analyzer to find it:')
    console.error('  bundle-analyzer find cli.js "refreshTools" --compact')
    process.exit(1)
  }

  // Verify uniqueness
  const allMatches = [...src.matchAll(new RegExp(refreshRe, 'g'))]
  if (allMatches.length > 1) {
    console.error('ERROR: refreshTools pattern matched multiple times. Aborting.')
    process.exit(1)
  }

  const ctxVar = match[1]  // X6 (toolUseContext)
  console.log(`Found refreshTools check at char ${match.index}`)
  console.log(`  Context variable: ${ctxVar}`)

  // Build else branch
  const oldCode = match[0]
  const newCode = oldCode +
    `else ${PATCH_B_MARKER}` +
    `{let _st=await ${ctxVar}.getAppState();` +
    `if(_st&&_st.mcp&&_st.mcp.tools){` +
      `let _base=${ctxVar}.options.tools.filter(function(_t){return!_t.isMcp});` +
      `let _merged=[..._base,..._st.mcp.tools];` +
      `let _seen=new Set();` +
      `let _deduped=_merged.filter(function(_t){` +
        `if(_seen.has(_t.name))return!1;` +
        `_seen.add(_t.name);return!0` +
      `});` +
      `if(_deduped.length!==${ctxVar}.options.tools.length` +
        `||_deduped.some(function(_t,_i){` +
          `return _t.name!==(${ctxVar}.options.tools[_i]||{}).name` +
        `}))` +
        `${ctxVar}={...${ctxVar},options:{...${ctxVar}.options,tools:_deduped}}` +
    `}}`

  src = src.replace(oldCode, newCode)
  console.log('Injected MCP tool refresh fallback in iR')
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
  console.log(`  ${aOk ? 'OK' : 'MISSING'} Part A marker (refresh before EVq)`)
  console.log(`  ${bOk ? 'OK' : 'MISSING'} Part B marker (iR refreshTools fallback)`)

  if (!aOk || !bOk) {
    console.error('\nVerification FAILED.')
    process.exit(1)
  }

  // Verify syntax with node --check
  try {
    const { execSync } = await import('node:child_process')
    execSync(`node --check "${cliPath}"`, { stdio: 'pipe' })
    console.log('  OK Syntax check passed')
  } catch (err) {
    console.error('  FAIL Syntax check failed!')
    console.error(err.stderr?.toString() || err.message)
    process.exit(1)
  }

  console.log('\ncli.js verified.')
} else {
  console.log('\nAll patches already applied. Nothing to do.')
}

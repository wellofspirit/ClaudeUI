/**
 * Patch: background-task
 *
 * Exposes the CLI's "send to background" feature via the SDK control message API.
 *
 *   Part A (cli.js): background_task control request handler — looks up the task
 *                     by ID, then for bash calls shellCommand.background() and for
 *                     agents resolves the backgroundSignal and sets isBackgrounded.
 *
 *   Part B (sdk.mjs): backgroundTask() method on the query object.
 *
 * All minified function names are extracted dynamically from content patterns
 * so the patch survives SDK version bumps.
 *
 * See README.md for full analysis.
 *
 * Usage: node patch/background-task/apply.mjs
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

console.log(`Read ${cliPath} (${(src.length / 1024 / 1024).toFixed(1)} MB)`)

const PATCH_MARKER = '/*PATCHED:background-task*/'

// ---------------------------------------------------------------------------
// Chunked-bundle scope helpers (2.1.261+)
//
// 2.1.261 is a code-split build: vendor/claude-cli/cli.js is the concatenation
// of ~1.6k minified ESM chunks, each preceded by a delimiter line
//   // @bun-chunk B:/~BUN/root/chunk-xxxxxxxx.js
// This patch injects a handler that CALLS four helpers, and three of them are
// defined in a chunk other than the one holding the injection point. A name
// captured at its definition site is not a binding at the call site, so each
// one is resolved into the injection chunk's own scope: its static import
// alias if it has one, otherwise a dynamic import of the defining chunk
// (a form the bundle itself already uses inside this very chunk). Failing to
// do this yields a patch that applies clean and throws ReferenceError live.
//
// On a pre-split monolith the index is empty and every name resolves to itself.
// ---------------------------------------------------------------------------

function buildChunkIndex(text) {
  const list = []
  const re = /^\/\/ @bun-chunk (.+)$/gm
  let m
  while ((m = re.exec(text))) list.push({ name: m[1].trim(), start: m.index })
  for (let i = 0; i < list.length; i++)
    list[i].end = i + 1 < list.length ? list[i + 1].start : text.length
  return list
}

function chunkAt(index, off) {
  if (index.length === 0) return null // monolithic bundle — one implicit scope
  let lo = 0
  let hi = index.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (index[mid].start <= off) lo = mid
    else hi = mid - 1
  }
  return index[lo]
}

function chunkName(index, off) {
  return chunkAt(index, off)?.name ?? '(monolithic bundle)'
}

/** Walk an `import{a,b as c}`/`export{a,b as c}` specifier list. */
function* specifiers(list) {
  for (const raw of list.split(',')) {
    const spec = raw.trim()
    if (!spec) continue
    const aliased = /^([\w$]+) as ([\w$]+)$/.exec(spec)
    if (aliased) yield { outer: aliased[2], inner: aliased[1] }
    else yield { outer: spec, inner: spec }
  }
}

/** The name a chunk publishes `localName` under, or null if it is private. */
function exportedNameOf(chunkText, localName) {
  for (const m of chunkText.matchAll(/export\{([^}]*)\}/g))
    for (const { outer, inner } of specifiers(m[1])) if (inner === localName) return outer
  return null
}

/**
 * Which chunk really owns `name` as referenced at `refOff`, and under what
 * exported name. A capture site is often a *use* site in a chunk that itself
 * imported the binding, so follow the import before falling back to "defined
 * here, published under its export alias".
 */
function originOf(text, index, name, refOff) {
  const refChunk = chunkAt(index, refOff)
  if (refChunk === null) return null
  const refText = text.slice(refChunk.start, refChunk.end)
  for (const m of refText.matchAll(/import\{([^}]*)\}from"([^"]+)"/g))
    for (const { outer, inner } of specifiers(m[1]))
      if (outer === name) return { chunk: m[2], exported: inner }
  return { chunk: refChunk.name, exported: exportedNameOf(refText, name) }
}

/**
 * Make `name` — as it reads at `refOff` — callable at `useOff`.
 * Returns { expr } for a name usable verbatim, { expr, hoist } when the caller
 * must emit `hoist` (a `let` binding via dynamic import) first, or null when
 * the helper is unreachable from the injection chunk.
 */
function resolveBinding(text, index, name, refOff, useOff, hoistName) {
  const refChunk = chunkAt(index, refOff)
  const useChunk = chunkAt(index, useOff)
  if (refChunk === null || useChunk === null || refChunk.name === useChunk.name)
    return { expr: name }

  const origin = originOf(text, index, name, refOff)
  if (!origin || !origin.exported) return null

  const useText = text.slice(useChunk.start, useChunk.end)
  if (origin.chunk === useChunk.name) {
    // The binding is defined in the chunk we are editing, under whatever local
    // name that chunk publishes as `origin.exported`.
    for (const m of useText.matchAll(/export\{([^}]*)\}/g))
      for (const { outer, inner } of specifiers(m[1]))
        if (outer === origin.exported) return { expr: inner }
    return null
  }

  for (const m of useText.matchAll(/import\{([^}]*)\}from"([^"]+)"/g)) {
    if (m[2] !== origin.chunk) continue
    for (const { outer, inner } of specifiers(m[1]))
      if (inner === origin.exported) return { expr: outer }
  }
  return {
    expr: hoistName,
    hoist: `let ${hoistName}=(await import(${JSON.stringify(origin.chunk)})).${origin.exported};`
  }
}

// =====================================================================
// Part A: background_task control request handler
// =====================================================================

if (src.includes(PATCH_MARKER)) {
  console.log('Part A already applied. Skipping.')
} else {
  console.log('\n=== Part A: background_task control request ===')

  // ---------------------------------------------------------------------------
  // Find the injection point — the "Unsupported control request subtype" fallback
  // ---------------------------------------------------------------------------
  console.log('\n--- Locating control-request fallback ---')

  // v2.1.219 wrapped the control-request dispatch chain in a try/finally, so the
  // fallback tail changed from `...subtype}`);continue}else if(msg.type==="control_response")`
  // to `...subtype}`)}finally{...}continue}else if(...)`. Match the fallback call
  // itself (tail-less) — still globally unique.
  //
  // 2.1.261 wrapped the interpolated subtype in a string sanitizer:
  //   else Be(r,`Unsupported control request subtype: ${Xn(String(r.request.subtype))}`)
  // (was `${r.request.subtype}`). Both interpolations are admitted; pinning the
  // message variable by backreference is what keeps this off the lookalike
  // fallbacks elsewhere in the bundle — see README §"2.1.261 changes".
  const anchorRe = new RegExp(
    `else (${V})\\((${V}),\`Unsupported control request subtype: ` +
      `\\$\\{(?:\\2\\.request\\.subtype|${V}\\(String\\(\\2\\.request\\.subtype\\)\\))\\}\`\\)`
  )

  const anchorMatch = anchorRe.exec(src)
  if (!anchorMatch) {
    console.error('ERROR: Cannot locate control-request fallback anchor.')
    process.exit(1)
  }

  const anchorIdx = anchorMatch.index

  // Verify uniqueness
  const allAnchorMatches = [...src.matchAll(new RegExp(anchorRe, 'g'))]
  if (allAnchorMatches.length > 1) {
    console.error('ERROR: Anchor matched multiple times. Aborting.')
    process.exit(1)
  }

  const errorFn = anchorMatch[1] // error response function (e.g., O6)
  const msgVar = anchorMatch[2] // control message variable (e.g., r)
  const chunkIndex = buildChunkIndex(src)
  console.log(
    `Found fallback anchor at char ${anchorIdx} (errorFn=${errorFn}, msgVar=${msgVar}) ` +
      `in ${chunkName(chunkIndex, anchorIdx)}`
  )

  // Start of the dispatch chain the fallback closes. Anything we read a local
  // name off has to sit between here and the anchor to be in scope at the
  // injection point.
  const chainStartIdx = src.lastIndexOf(`${msgVar}.type==="control_request"`, anchorIdx)
  if (chainStartIdx === -1) {
    console.error('ERROR: Cannot locate the start of the control-request dispatch chain.')
    process.exit(1)
  }

  // ---------------------------------------------------------------------------
  // Extract minified function names from content patterns
  // ---------------------------------------------------------------------------
  console.log('\n--- Extracting function names from content patterns ---')

  // Window history: 5000 → 8000 (v2.1.197 moved the stop_task handler, source of
  // the success-response-helper pattern, to 5647 chars before the anchor) →
  // 16000 (2.1.231 pushed it past 8000 again; 2.1.261 sits at 13214). Mirrors
  // queue-control, which anchors off the same control-request fallback.
  //
  // Two windows now. The reply-helper search is clamped to the dispatch chain,
  // so however far it has to grow it can never reach another function's helper.
  // The app-state search keeps the ±window: getAppState/setAppState are locals
  // of the *enclosing* stream loop, and the nearest mentions can fall on either
  // side of the control_request branch.
  const NEARBY_BACK = 16000
  const chainCtx = src.slice(Math.max(chainStartIdx, anchorIdx - NEARBY_BACK), anchorIdx)
  const nearbyCtx = src.slice(Math.max(0, anchorIdx - NEARBY_BACK), anchorIdx + 2000)

  // --- Success response helper (called after stop_task success) ---
  //
  // Take every match in the window and require unanimity rather than trusting
  // the first: the window has had to grow twice, and a wide window that picks
  // "whatever matched first" is how an unrelated handler's reply helper gets
  // silently adopted. See the identical note in queue-control/apply.mjs.
  const successRe = new RegExp(
    `\\),(${V})\\(${msgVar.replace(/\$/g, '\\$')},\\{\\}\\)\\}catch`,
    'g'
  )
  const successNames = [...chainCtx.matchAll(successRe)].map((m) => m[1])
  if (successNames.length === 0) {
    console.error(
      `ERROR: Cannot find success response helper pattern within ${NEARBY_BACK} chars ` +
        'before the control-request fallback anchor.'
    )
    process.exit(1)
  }
  if (successNames.some((n) => n !== successNames[0])) {
    console.error(
      `ERROR: success response helper is ambiguous — candidates disagree: ${[...new Set(successNames)].join(', ')}. Aborting.`
    )
    process.exit(1)
  }
  const successFn = successNames[0]
  console.log(
    `  Success response helper: ${successFn} (${successNames.length}/${successNames.length} call sites agree)`
  )

  // --- getAppState/setAppState locals of the enclosing stream loop ---
  //
  // Read off the sibling handlers that forward them (`{…,getAppState:k,setAppState:w,…}`).
  // As with the reply helper, require every mention in the window to agree
  // rather than trusting the first: a wide window that takes whatever matched
  // first is how a nested callback's own accessors get adopted.
  const getAppStateRe = new RegExp(`getAppState:(${V}),setAppState:(${V})`, 'g')
  const appStatePairs = [...nearbyCtx.matchAll(getAppStateRe)].map((m) => `${m[1]},${m[2]}`)
  if (appStatePairs.length === 0) {
    console.error('ERROR: Cannot find getAppState/setAppState variables')
    process.exit(1)
  }
  if (appStatePairs.some((p) => p !== appStatePairs[0])) {
    console.error(
      `ERROR: getAppState/setAppState are ambiguous — candidates disagree: ${[
        ...new Set(appStatePairs)
      ].join(' | ')}. Aborting.`
    )
    process.exit(1)
  }
  const [getAppStateFn, setAppStateFn] = appStatePairs[0].split(',')
  console.log(
    `  getAppState: ${getAppStateFn}, setAppState: ${setAppStateFn} ` +
      `(${appStatePairs.length}/${appStatePairs.length} call sites agree)`
  )

  // --- wi (local_bash type check): function <name>(A){return typeof A==="object"&&A!==null&&"type"in A&&A.type==="local_bash"} ---
  const wiRe = new RegExp(
    `function (${V})\\(${V}\\)\\{return typeof ${V}==="object"&&${V}!==null&&"type"in ${V}&&${V}\\.type==="local_bash"\\}`
  )
  const wiMatch = wiRe.exec(src)
  if (!wiMatch) {
    console.error('ERROR: Cannot find local_bash type check function (wi)')
    process.exit(1)
  }
  const wiFnDef = wiMatch[1]
  const wiFnDefIdx = wiMatch.index

  // Verify wi uniqueness
  const allWiMatches = [...src.matchAll(new RegExp(wiRe, 'g'))]
  if (allWiMatches.length > 1) {
    console.error('ERROR: local_bash type check matched multiple times. Aborting.')
    process.exit(1)
  }

  // --- Yi (local_agent type check): same shape as wi but type==="local_agent" ---
  // Since 0.2.87 two candidate functions define the identical
  // `typeof x==="object"&&...&&x.type==="local_agent"` shape (task-management +
  // TUI copies). Disambiguate by which one is used in a
  // `<fn>(x)&&x.agentType!=="main-session"` guard — only the task-management copy
  // is. Up to 2.1.207 the guard sat near the definition (≤400 chars) so a single
  // bounded-gap regex worked; v2.1.219 moved it ~2.3M chars away, so match the
  // definition and the guard usage independently rather than requiring adjacency.
  const yiDefRe = new RegExp(
    `function (${V})\\(${V}\\)\\{return typeof ${V}==="object"&&${V}!==null&&"type"in ${V}&&${V}\\.type==="local_agent"\\}`,
    'g'
  )
  const yiDefs = [...src.matchAll(yiDefRe)]
  const yiCandidates = [...new Set(yiDefs.map((m) => m[1]))]
  if (yiCandidates.length === 0) {
    console.error('ERROR: Cannot find local_agent type check function (Yi)')
    process.exit(1)
  }
  const yiUsed = yiCandidates.filter((name) =>
    new RegExp(`${name.replace(/\$/g, '\\$')}\\(${V}\\)&&${V}\\.agentType!=="main-session"`).test(
      src
    )
  )
  if (yiUsed.length !== 1) {
    console.error(
      `ERROR: local_agent disambiguation failed — ${yiUsed.length} of ${yiCandidates.length} candidate(s) [${yiCandidates.join(', ')}] used with agentType!=="main-session". Aborting.`
    )
    process.exit(1)
  }
  const yiFnDef = yiUsed[0]
  const yiFnDefIdx = yiDefs.find((m) => m[1] === yiFnDef).index

  // --- backgroundSignal resolver Map ---
  // The Map that holds each agent task's "you are backgrounded now" resolver.
  // Shape history:
  //   v0.2.97   MAP.set(A,B),FN(C,D);let E;if(F!==void 0&&F>0)
  //   v0.2.105  MAP.set(q,J),Y.register(H);let M;if(A!==void 0&&A>0)
  //   2.1.261   the Map moved onto a session-state object reached through a
  //             zero-arg accessor, and the property name survives minification:
  //               sr().agentBackgroundSignalResolvers.set(e,re),v.register(q);let de;…
  //             The OLD regex still "matches" this — it captures the *property*
  //             `agentBackgroundSignalResolvers`, and even its `=new Map`
  //             sanity check passes (the class field is declared exactly that
  //             way), so it silently produced a bare undefined identifier: the
  //             2.1.241 misbind class again, invisible until live.
  // Anchor on the unminified property instead and capture the ACCESSOR.
  const bgAccessorRe = new RegExp(
    `(${V})\\(\\)\\.agentBackgroundSignalResolvers\\.set\\(${V},${V}\\),`,
    'g'
  )
  const bgAccessorMatches = [...src.matchAll(bgAccessorRe)]
  let bgSignalMapExpr = null
  let bgAccessorDefIdx = -1
  let bgAccessorName = null
  let bgLegacyName = null
  let bgLegacyDefIdx = -1

  if (bgAccessorMatches.length > 0) {
    if (bgAccessorMatches.length > 1) {
      console.error('ERROR: agentBackgroundSignalResolvers .set() site matched more than once.')
      process.exit(1)
    }
    bgAccessorName = bgAccessorMatches[0][1]
    bgAccessorDefIdx = bgAccessorMatches[0].index
    // The native backgrounding helper reads and clears through the same
    // accessor — require that, so a stray `X().agentBackgroundSignalResolvers`
    // on some other object cannot be mistaken for the live one.
    const esc = bgAccessorName.replace(/\$/g, '\\$')
    for (const op of ['get', 'delete']) {
      if (!new RegExp(`${esc}\\(\\)\\.agentBackgroundSignalResolvers\\.${op}\\(`).test(src)) {
        console.error(
          `ERROR: ${bgAccessorName}().agentBackgroundSignalResolvers.${op}( not found — ` +
            'the captured accessor is not the one the CLI backgrounds agents through.'
        )
        process.exit(1)
      }
    }
    if (!/agentBackgroundSignalResolvers=new Map/.test(src)) {
      console.error('ERROR: agentBackgroundSignalResolvers=new Map declaration not found.')
      process.exit(1)
    }
    console.log(`  backgroundSignal Map: ${bgAccessorName}().agentBackgroundSignalResolvers`)
  } else {
    // Legacy (≤2.1.241): a plain module-level Map identifier.
    const bgSignalRe = new RegExp(
      `(${V})\\.set\\(${V},${V}\\),${V}(?:\\.${V})?\\(${V}(?:,${V})?\\);let ${V};if\\(${V}!==void 0&&${V}>0\\)`
    )
    const bgSignalMatch = bgSignalRe.exec(src)
    if (!bgSignalMatch) {
      console.error('ERROR: Cannot find backgroundSignal resolver Map (Ff6-like)')
      process.exit(1)
    }
    bgLegacyName = bgSignalMatch[1]
    bgLegacyDefIdx = bgSignalMatch.index
    console.log(`  backgroundSignal Map: ${bgLegacyName}`)

    // Verify: the Map should be defined as <name>=new Map somewhere
    if (!src.includes(`${bgLegacyName}=new Map`)) {
      console.error(`ERROR: ${bgLegacyName}=new Map not found — wrong variable captured`)
      process.exit(1)
    }
    console.log(`  Verified: ${bgLegacyName}=new Map exists`)
  }

  // ---------------------------------------------------------------------------
  // Bring every captured helper into the INJECTION chunk's scope
  // ---------------------------------------------------------------------------
  const hoists = []
  function bind(label, name, refIdx, hoistName) {
    const resolved = resolveBinding(src, chunkIndex, name, refIdx, anchorIdx, hoistName)
    if (!resolved) {
      console.error(
        `ERROR: ${label} (${name}, read in ${chunkName(chunkIndex, refIdx)}) is not published by ` +
          `its owning chunk, so it cannot be reached from ${chunkName(chunkIndex, anchorIdx)}. ` +
          'Aborting rather than injecting a name that would throw at runtime.'
      )
      process.exit(1)
    }
    if (resolved.hoist) hoists.push(resolved.hoist)
    console.log(
      `  ${label}: ${name} -> ${resolved.expr}` +
        (resolved.hoist ? ' (via dynamic import)' : '') +
        ` [read in ${chunkName(chunkIndex, refIdx)}]`
    )
    return resolved.expr
  }

  const wiFn = bind('local_bash check (wi)', wiFnDef, wiFnDefIdx, 'v6')
  const yiFn = bind('local_agent check (Yi)', yiFnDef, yiFnDefIdx, 'x6')
  if (bgAccessorName !== null) {
    const accessor = bind('backgroundSignal accessor', bgAccessorName, bgAccessorDefIdx, 'y6')
    bgSignalMapExpr = `${accessor}().agentBackgroundSignalResolvers`
  } else {
    bgSignalMapExpr = bind('backgroundSignal Map', bgLegacyName, bgLegacyDefIdx, 'y6')
  }

  // ---------------------------------------------------------------------------
  // Inject the background_task handler before the "Unsupported" fallback
  // ---------------------------------------------------------------------------
  console.log('\n--- Injecting background_task handler ---')

  // Use unique temp variable names that won't conflict with the existing scope
  // The handler uses Z6, S6, C6, d6 (plus v6/x6/y6 for any dynamic-import
  // hoists) which may also be used locally in other branches, but every one of
  // them is `let`-scoped inside this block.
  //
  // Accept tool_use_id (from the tool_use block) and search tasks by toolUseId
  // property — NOT by task key. Foreground tasks don't have a task_id mapping
  // in the consumer because detectTaskMapping only runs on tool results.
  const injection =
    PATCH_MARKER +
    `else if(${msgVar}.request.subtype==="background_task"){` +
    `let{tool_use_id:Z6}=${msgVar}.request;` +
    `try{` +
    hoists.join('') +
    `let S6=null,C6=null,d6=(await ${getAppStateFn}()).tasks;` +
    `for(let k6 of Object.keys(d6)){if(d6[k6].toolUseId===Z6){C6=k6;S6=d6[k6];break}}` +
    `if(!S6||!C6)throw Error("No task found with toolUseId: "+Z6);` +
    `if(S6.status!=="running")throw Error("Task "+C6+" is not running (status: "+S6.status+")");` +
    `if(S6.isBackgrounded)throw Error("Task "+C6+" is already backgrounded");` +
    `if(${wiFn}(S6)){` +
    `if(!S6.shellCommand||!S6.shellCommand.background(C6))throw Error("Failed to background bash task "+C6);` +
    `${setAppStateFn}((k6)=>{let m6=k6.tasks[C6];if(!m6||m6.isBackgrounded)return k6;return{...k6,tasks:{...k6.tasks,[C6]:{...m6,isBackgrounded:!0}}}})` +
    `}else if(${yiFn}(S6)){` +
    `${setAppStateFn}((k6)=>{let m6=k6.tasks[C6];if(!m6||m6.isBackgrounded)return k6;return{...k6,tasks:{...k6.tasks,[C6]:{...m6,isBackgrounded:!0}}}});` +
    `let k6=${bgSignalMapExpr}.get(C6);if(k6)k6(),${bgSignalMapExpr}.delete(C6)` +
    `}else{` +
    `throw Error("Unsupported task type for backgrounding")` +
    `}` +
    `${successFn}(${msgVar},{task_id:C6,tool_use_id:Z6})` +
    `}catch(S6){` +
    `${errorFn}(${msgVar},S6 instanceof Error?S6.message:String(S6))` +
    `}` +
    `}`

  src = src.slice(0, anchorIdx) + injection + src.slice(anchorIdx)
  console.log('Injected background_task handler')

  // Write and verify cli.js
  writeFileSync(cliPath, src)
  console.log(`\nPatch applied to ${cliPath}`)

  const verify = readFileSync(cliPath, 'utf-8')
  const cliOk = verify.includes(PATCH_MARKER)
  console.log(`  ${cliOk ? 'OK' : 'MISSING'} Part A marker`)

  if (!cliOk) {
    console.error('\nPart A verification FAILED.')
    process.exit(1)
  }
  console.log('\ncli.js verified.')
}

console.log('')
console.log('What this does:')
console.log(
  '  Part A (cli.js): background_task control-request handler (backgrounds running bash/agent tasks).'
)
console.log('  Part B (sdk.mjs) was removed — backgroundTask() lives in src/main/sdk/.')

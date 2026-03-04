/**
 * Patch: sandbox-network-fix
 *
 * Fixes sandbox network proxy always starting even when no domains are configured.
 *
 * Bug: oz1() always builds { network: { allowedDomains: K, ... } } where K is
 * an array (even if empty). The dg5() function checks:
 *   J = K?.network?.allowedDomains !== void 0 || Q3?.network?.allowedDomains !== void 0
 * Since Q3 (the merged config from oz1) always has allowedDomains as an array,
 * Q3?.network?.allowedDomains !== void 0 is always true, and the network proxy
 * always starts — even when the user has no domain restrictions configured.
 *
 * Fix: Change the check from "does allowedDomains exist?" to "does it have
 * entries?" by checking .length > 0 instead of !== void 0. Also check
 * deniedDomains so the proxy still starts when deny rules are configured.
 *
 * Usage: node patch/sandbox-network-fix/apply.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '../..')
const cliPath = resolve(projectRoot, 'node_modules/@anthropic-ai/claude-agent-sdk/cli.js')

const V = '[\\w$]+'

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

const MARKER = '/*PATCHED:sandbox-network-fix*/'

if (src.includes(MARKER)) {
  console.log('\nPatch already applied. Nothing to do.')
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Find the network restriction check in dg5()
// ---------------------------------------------------------------------------
// Pattern: J=K?.network?.allowedDomains!==void 0||Q3?.network?.allowedDomains!==void 0,D=J,X=J
//
// Anchored by the unique surrounding context:
//   {denyOnly:H},<J>=<K>?.network?.allowedDomains!==void 0||<Q3>?.network?.allowedDomains!==void 0,<D>=<J>,<X>=<J>

const re = new RegExp(
  `\\{denyOnly:(${V})\\},(${V})=(${V})\\?\\.network\\?\\.allowedDomains!==void 0\\|\\|(${V})\\?\\.network\\?\\.allowedDomains!==void 0,(${V})=(${V}),(${V})=(${V})`
)

const match = re.exec(src)
if (!match) {
  console.error('ERROR: Cannot locate network restriction check in dg5().')
  console.error('Expected pattern: {denyOnly:<H>},<J>=<K>?.network?.allowedDomains!==void 0||<Q3>?.network?.allowedDomains!==void 0,<D>=<J>,<X>=<J>')
  process.exit(1)
}

// Verify uniqueness
const allMatches = [...src.matchAll(new RegExp(re, 'g'))]
if (allMatches.length > 1) {
  console.error('ERROR: Pattern matched multiple times. Aborting.')
  process.exit(1)
}

const hVar = match[1]   // H (denyOnly array)
const jVar = match[2]   // J (needsNetworkRestriction flag)
const kVar = match[3]   // K (API options)
const q3Var = match[4]  // Q3 (merged config)
const dVar = match[5]   // D (alias for J, should == jVar)
const dVal = match[6]   // value assigned to D (should == jVar)
const xVar = match[7]   // X (alias for J, should == jVar)
const xVal = match[8]   // value assigned to X (should == jVar)

console.log(`Found network check at char ${match.index}`)
console.log(`  J=${jVar}, K=${kVar}, Q3=${q3Var}, D=${dVar}=${dVal}, X=${xVar}=${xVal}`)

// Replace: check .length > 0 instead of !== void 0, also check deniedDomains
const oldCode = match[0]
const newCode = MARKER +
  `{denyOnly:${hVar}},${jVar}=${kVar}?.network?.allowedDomains?.length>0||${q3Var}?.network?.allowedDomains?.length>0||${q3Var}?.network?.deniedDomains?.length>0,${dVar}=${dVal},${xVar}=${xVal}`

src = src.replace(oldCode, newCode)
console.log('Replaced !== void 0 checks with .length > 0')

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

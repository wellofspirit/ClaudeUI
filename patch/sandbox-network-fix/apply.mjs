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
// Pattern (old):  {denyOnly:H},J=K?.network?.allowedDomains!==void 0||Q3?.network?.allowedDomains!==void 0,D=J,X=J
// Pattern (0.2.81): {denyOnly:H,allowWithinDeny:J},X=K?.network?.allowedDomains!==void 0||N5?.network?.allowedDomains!==void 0,D=X,P=X
//
// The object before the check may contain extra keys (allowWithinDeny was added).
// We anchor on `denyOnly:` inside the object, allow any content until `},`, then
// capture the check expression and trailing alias assignments.

// Core regex: skips object internals via [^}]+, captures checkVar, apiOpts, mergedCfg, trailing aliases
const re = new RegExp(
  `(\\{denyOnly:[^}]+\\}),(${V})=(${V})\\?\\.network\\?\\.allowedDomains!==void 0\\|\\|(${V})\\?\\.network\\?\\.allowedDomains!==void 0((?:,${V}=${V})+)`
)

const match = re.exec(src)
if (!match) {
  console.error('ERROR: Cannot locate network restriction check in dg5().')
  console.error('Expected pattern: {denyOnly:...},<J>=<K>?.network?.allowedDomains!==void 0||<Q3>?.network?.allowedDomains!==void 0,<alias>=<J>[,...]')
  process.exit(1)
}

// Verify uniqueness
const allMatches = [...src.matchAll(new RegExp(re, 'g'))]
if (allMatches.length > 1) {
  console.error('ERROR: Pattern matched multiple times. Aborting.')
  process.exit(1)
}

const objLiteral = match[1]  // full object e.g. {denyOnly:H} or {denyOnly:H,allowWithinDeny:J}
const checkVar = match[2]   // needsNetworkRestriction flag (was J, now X)
const apiOpts = match[3]    // API options (K)
const mergedCfg = match[4]  // merged config (was Q3, now N5)
const aliasSuffix = match[5] // trailing aliases e.g. ",D=J,X=J" or ",D=X,P=X"

console.log(`Found network check at char ${match.index}`)
console.log(`  object=${objLiteral}, checkVar=${checkVar}, apiOpts=${apiOpts}, mergedCfg=${mergedCfg}, aliases=${aliasSuffix}`)

// Replace: check .length > 0 instead of !== void 0, also check deniedDomains
const oldCode = match[0]
const newCode = MARKER +
  `${objLiteral},${checkVar}=${apiOpts}?.network?.allowedDomains?.length>0||${mergedCfg}?.network?.allowedDomains?.length>0||${mergedCfg}?.network?.deniedDomains?.length>0${aliasSuffix}`

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

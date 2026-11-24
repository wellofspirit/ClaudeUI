#!/usr/bin/env bun
/**
 * Release step: hash the release assets, write `update-manifest.json` and sign
 * it (`update-manifest.json.sig`, base64 Ed25519 over the manifest's exact bytes).
 *
 *   bun scripts/release/update-manifest.mjs --dir <artifacts> --version <v> \
 *     --channel <stable|pre-release> --out-dir <dir>
 *
 * The private key (PEM PKCS#8 Ed25519) comes from UPDATE_SIGNING_KEY and is
 * never printed. After signing, the signature is verified against the PINNED
 * public keys (`src/shared/update-keys.ts`): a secret that does not match them
 * stops the release rather than shipping a manifest no client accepts. With no
 * key in the environment nothing is written and the run exits 0 (clients then
 * see no update: fail-safe). Imports the shared TS, so bun runs it.
 */
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  UPDATE_MANIFEST_FILE,
  UPDATE_MANIFEST_SIG_FILE,
  assetTargetFor,
  looksLikeReleaseAsset,
  isReleaseVersion,
  serializeManifest
} from '../../src/shared/update-manifest.ts'
import { UPDATE_PUBLIC_KEYS } from '../../src/shared/update-keys.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** First 16 hex chars of the SPKI's sha256: the id to put beside a pinned key. */
export function keyIdFor(spkiBase64) {
  return crypto
    .createHash('sha256')
    .update(Buffer.from(spkiBase64, 'base64'))
    .digest('hex')
    .slice(0, 16)
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    fs.createReadStream(file)
      .on('data', (c) => hash.update(c))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * The asset scan: every file in `dir` that maps to a target is hashed.
 * Throws on a release-looking file with no target, on two files for one target,
 * and when a desktop target is missing.
 */
export async function buildManifest({ dir, version, channel, claudeCodeVersion, publishedAt }) {
  if (!isReleaseVersion(version)) throw new Error(`bad version "${version}"`)
  if (channel !== 'stable' && channel !== 'pre-release') throw new Error(`bad channel "${channel}"`)
  const assets = {}
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    const target = assetTargetFor(entry.name, version)
    if (!target) {
      if (looksLikeReleaseAsset(entry.name))
        throw new Error(
          `${entry.name} looks like a release asset but maps to no target for ${version}`
        )
      continue
    }
    if (assets[target])
      throw new Error(`two files map to ${target}: ${assets[target].name}, ${entry.name}`)
    const file = path.join(dir, entry.name)
    assets[target] = {
      name: entry.name,
      size: fs.statSync(file).size,
      sha256: await sha256File(file)
    }
  }
  for (const t of ['desktop-darwin-arm64', 'desktop-win32-x64'])
    if (!assets[t]) throw new Error(`missing the ${t} asset in ${dir}`)
  for (const [t, a] of Object.entries(assets))
    if (a.size <= 0) throw new Error(`${t} asset ${a.name} is empty`)
  return {
    schema: 1,
    version,
    tag: `v${version}`,
    channel,
    publishedAt,
    claudeCodeVersion,
    assets
  }
}

export function signBytes(bytes, privateKeyPem) {
  return crypto.sign(null, bytes, crypto.createPrivateKey(privateKeyPem)).toString('base64')
}

/** The id of the first pinned key that verifies `sigBase64` over `bytes`, or null. */
export function verifyPinned(bytes, sigBase64, keys = UPDATE_PUBLIC_KEYS) {
  const sig = Buffer.from(sigBase64, 'base64')
  for (const k of keys) {
    try {
      const key = crypto.createPublicKey({
        key: Buffer.from(k.spki, 'base64'),
        format: 'der',
        type: 'spki'
      })
      if (crypto.verify(null, bytes, key, sig)) return k.id
    } catch {
      /* a malformed pinned key verifies nothing */
    }
  }
  return null
}

/**
 * Writes the manifest and signature into `outDir`. Returns false (writing
 * nothing) when there is no key.
 */
export async function writeSignedManifest({
  dir,
  version,
  channel,
  outDir,
  signingKey,
  keys,
  now = new Date()
}) {
  if (!signingKey) return false
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const manifest = await buildManifest({
    dir,
    version,
    channel,
    claudeCodeVersion: pkg.claudeCliVersion,
    publishedAt: now.toISOString()
  })
  const bytes = Buffer.from(serializeManifest(manifest), 'utf8')
  let sig
  try {
    sig = signBytes(bytes, signingKey)
  } catch {
    throw new Error('UPDATE_SIGNING_KEY is not a usable PEM PKCS#8 Ed25519 private key')
  }
  if (!verifyPinned(bytes, sig, keys))
    throw new Error(
      'the signature does not verify under any key pinned in src/shared/update-keys.ts: ' +
        'the UPDATE_SIGNING_KEY secret does not match the pinned public key(s)'
    )
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, UPDATE_MANIFEST_FILE), bytes)
  fs.writeFileSync(path.join(outDir, UPDATE_MANIFEST_SIG_FILE), sig + '\n')
  return true
}

function parseArgs(argv) {
  const o = {}
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]
    if (!['--dir', '--version', '--channel', '--out-dir'].includes(k) || argv[i + 1] === undefined)
      throw new Error(`bad argument: ${k}`)
    o[k.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = argv[i + 1]
  }
  for (const k of ['dir', 'version', 'channel', 'outDir'])
    if (!o[k]) throw new Error(`missing --${k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}`)
  return o
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2))
    const signingKey = process.env.UPDATE_SIGNING_KEY
    const wrote = await writeSignedManifest({
      ...args,
      dir: path.resolve(args.dir),
      outDir: path.resolve(args.outDir),
      signingKey
    })
    if (wrote) console.log(`update-manifest: signed ${args.version} (${args.channel})`)
    else
      console.warn(
        'update-manifest: UPDATE_SIGNING_KEY is not set; no manifest written (clients will see no update)'
      )
  } catch (e) {
    console.error(`update-manifest: ${e instanceof Error ? e.message : e}`)
    process.exit(1)
  }
}

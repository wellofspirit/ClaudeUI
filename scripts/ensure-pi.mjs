#!/usr/bin/env node
/**
 * ensure-pi.mjs
 *
 * Downloads the platform-specific pi coding agent standalone build from the
 * earendil-works/pi GitHub release pinned by package.json#piCliVersion,
 * verifies it against the release SHA256SUMS, and extracts it into
 * vendor/pi-cli/. Cache-hit skip on matching version.
 *
 * Uses Node.js-native zlib plus minimal zip/tar parsers to avoid relying on
 * external `unzip`/`tar` commands (Git Bash's tar treats Windows drive
 * letters like "D:" as hostnames; unzip is not guaranteed to exist).
 *
 * Usage:
 *   node scripts/ensure-pi.mjs              # pinned version from package.json#piCliVersion
 *   node scripts/ensure-pi.mjs --force      # re-download even if vendor/ has it
 */

import { createHash } from 'node:crypto'
import { gunzipSync, inflateRawSync } from 'node:zlib'
import {
  existsSync,
  mkdirSync,
  chmodSync,
  rmSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from 'node:fs'
import { join, dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const VENDOR_DIR = join(ROOT, 'vendor', 'pi-cli')
const RELEASE_BASE = 'https://github.com/earendil-works/pi/releases/download'

// ── Platform detection ────────────────────────────────────────────────────────

function detectAssetName() {
  const plat = process.platform
  const arch = process.arch
  if (plat === 'win32') return arch === 'arm64' ? 'pi-windows-arm64.zip' : 'pi-windows-x64.zip'
  if (plat === 'darwin') return arch === 'arm64' ? 'pi-darwin-arm64.tar.gz' : 'pi-darwin-x64.tar.gz'
  return arch === 'arm64' ? 'pi-linux-arm64.tar.gz' : 'pi-linux-x64.tar.gz'
}

// ── Version from package.json ─────────────────────────────────────────────────

function getPinnedVersion() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const version = pkg.piCliVersion
  if (!version) throw new Error('package.json#piCliVersion is not set')
  return version
}

// ── Cache-hit check ────────────────────────────────────────────────────────────

function isCacheHit(version) {
  const versionFile = join(VENDOR_DIR, 'version.json')
  if (!existsSync(versionFile)) return false
  try {
    const saved = JSON.parse(readFileSync(versionFile, 'utf8'))
    return saved.version === version
  } catch {
    return false
  }
}

// ── Download helper ────────────────────────────────────────────────────────────

async function fetchBytes(url) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`)
  return Buffer.from(await res.arrayBuffer())
}

// ── SHA256SUMS verification ────────────────────────────────────────────────────

function verifySha256(bytes, sumsText, assetName) {
  const line = sumsText
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.endsWith(assetName))
  if (!line) throw new Error(`${assetName} not listed in SHA256SUMS`)
  const expected = line.split(/\s+/)[0].toLowerCase()
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== expected) {
    throw new Error(`SHA256 mismatch for ${assetName}: expected ${expected}, got ${actual}`)
  }
}

// ── Path safety for archive extraction ────────────────────────────────────────

function safeDest(destDir, entryName) {
  const norm = entryName.replace(/\\/g, '/')
  if (norm.startsWith('/') || /^[A-Za-z]:/.test(norm) || norm.split('/').includes('..')) {
    throw new Error(`unsafe archive entry path: ${entryName}`)
  }
  const dest = resolve(destDir, norm)
  if (!dest.startsWith(resolve(destDir) + sep) && dest !== resolve(destDir)) {
    throw new Error(`archive entry escapes destination: ${entryName}`)
  }
  return dest
}

// ── Minimal zip extractor (central-directory walk, stored/deflate only) ──────

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50
const LOC_SIG = 0x04034b50

function extractZip(buf, destDir) {
  // Find End Of Central Directory: scan backwards over the max comment span.
  const scanStart = Math.max(0, buf.length - 65557)
  let eocd = -1
  for (let i = buf.length - 22; i >= scanStart; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('zip: End Of Central Directory not found')

  const entryCount = buf.readUInt16LE(eocd + 10)
  const cenOffset = buf.readUInt32LE(eocd + 16)
  if (cenOffset === 0xffffffff || entryCount === 0xffff) {
    throw new Error('zip: zip64 archives are not supported')
  }

  const files = []
  let pos = cenOffset
  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(pos) !== CEN_SIG) throw new Error('zip: bad central directory entry')
    const method = buf.readUInt16LE(pos + 10)
    const compSize = buf.readUInt32LE(pos + 20)
    const nameLen = buf.readUInt16LE(pos + 28)
    const extraLen = buf.readUInt16LE(pos + 30)
    const commentLen = buf.readUInt16LE(pos + 32)
    const externalAttrs = buf.readUInt32LE(pos + 38)
    const localOffset = buf.readUInt32LE(pos + 42)
    const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString('utf8')
    files.push({ name, method, compSize, localOffset, externalAttrs })
    pos += 46 + nameLen + extraLen + commentLen
  }

  const extracted = []
  for (const f of files) {
    if (f.name.endsWith('/')) continue // directory entry
    if (buf.readUInt32LE(f.localOffset) !== LOC_SIG) {
      throw new Error(`zip: bad local header for ${f.name}`)
    }
    const nameLen = buf.readUInt16LE(f.localOffset + 26)
    const extraLen = buf.readUInt16LE(f.localOffset + 28)
    const dataStart = f.localOffset + 30 + nameLen + extraLen
    const raw = buf.subarray(dataStart, dataStart + f.compSize)
    let data
    if (f.method === 0) data = Buffer.from(raw)
    else if (f.method === 8) data = inflateRawSync(raw)
    else throw new Error(`zip: unsupported compression method ${f.method} for ${f.name}`)

    const dest = safeDest(destDir, f.name)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, data)
    // Upper 16 bits of external attrs carry the unix mode when present.
    const unixMode = (f.externalAttrs >>> 16) & 0o7777
    if (process.platform !== 'win32' && unixMode) chmodSync(dest, unixMode)
    extracted.push({ name: f.name, size: data.length })
  }
  return extracted
}

// ── Minimal tar.gz extractor (all entries) ────────────────────────────────────

const TAR_BLOCK = 512

function readOctal(buf, offset, len) {
  const s = buf.subarray(offset, offset + len).toString('ascii').trim()
  return s ? parseInt(s, 8) : 0
}

function readCStr(buf, offset, len) {
  let end = offset
  while (end < offset + len && buf[end] !== 0) end++
  return buf.subarray(offset, end).toString('utf8')
}

function extractTarGz(gzBuf, destDir) {
  const tar = gunzipSync(gzBuf)
  const extracted = []
  let pos = 0
  let pendingLongName = null

  while (pos + TAR_BLOCK <= tar.length) {
    const header = tar.subarray(pos, pos + TAR_BLOCK)
    if (header.every((b) => b === 0)) break
    pos += TAR_BLOCK

    const typeFlag = String.fromCharCode(header[156])
    const fileSize = readOctal(header, 124, 12)
    const dataBlocks = Math.ceil(fileSize / TAR_BLOCK) * TAR_BLOCK

    if (typeFlag === 'L') {
      pendingLongName = tar.subarray(pos, pos + fileSize).toString('utf8').replace(/\0/g, '')
      pos += dataBlocks
      continue
    }

    let name
    if (pendingLongName !== null) {
      name = pendingLongName
      pendingLongName = null
    } else {
      const prefix = readCStr(header, 345, 155)
      const fname = readCStr(header, 0, 100)
      name = prefix ? `${prefix}/${fname}` : fname
    }

    if ((typeFlag === '0' || typeFlag === '\0') && fileSize > 0) {
      const dest = safeDest(destDir, name)
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, tar.subarray(pos, pos + fileSize))
      if (process.platform !== 'win32') {
        const mode = readOctal(header, 100, 8) & 0o7777
        chmodSync(dest, mode || 0o755)
      }
      extracted.push({ name, size: fileSize })
    }

    pos += dataBlocks
  }
  return extracted
}

// ── Main download + extract logic ─────────────────────────────────────────────

async function download(assetName, version) {
  const tag = `v${version}`
  console.log(`[ensure-pi] Downloading ${assetName} for pi ${tag} ...`)

  const [assetBytes, sumsBytes] = await Promise.all([
    fetchBytes(`${RELEASE_BASE}/${tag}/${assetName}`),
    fetchBytes(`${RELEASE_BASE}/${tag}/SHA256SUMS`),
  ])

  console.log(`[ensure-pi] Downloaded ${(assetBytes.length / 1024 / 1024).toFixed(1)} MB, verifying SHA256 ...`)
  verifySha256(assetBytes, sumsBytes.toString('utf8'), assetName)

  // Extract into a temp dir, then swap into place for atomicity.
  const tmpDir = VENDOR_DIR + '.tmp'
  rmSync(tmpDir, { recursive: true, force: true })
  mkdirSync(tmpDir, { recursive: true })

  const extracted = assetName.endsWith('.zip')
    ? extractZip(assetBytes, tmpDir)
    : extractTarGz(assetBytes, tmpDir)
  if (extracted.length === 0) throw new Error(`no files extracted from ${assetName}`)
  for (const f of extracted) {
    console.log(`[ensure-pi]   ${f.name} (${(f.size / 1024 / 1024).toFixed(1)} MB)`)
  }

  writeFileSync(
    join(tmpDir, 'version.json'),
    JSON.stringify(
      {
        version,
        asset: assetName,
        platform: process.platform,
        arch: process.arch,
        downloadedAt: new Date().toISOString(),
      },
      null,
      2
    ) + '\n'
  )

  rmSync(VENDOR_DIR, { recursive: true, force: true })
  renameSync(tmpDir, VENDOR_DIR)
  console.log(`[ensure-pi] pi ${version} installed to vendor/pi-cli/`)
}

// ── Entry point ────────────────────────────────────────────────────────────────

const force = process.argv.includes('--force')
const version = getPinnedVersion()
const assetName = detectAssetName()

if (!force && isCacheHit(version)) {
  console.log(`[ensure-pi] pi ${version} already vendored (cache hit). Use --force to re-download.`)
  process.exit(0)
}

download(assetName, version).catch((err) => {
  console.error(`\n[ensure-pi] FAIL: ${err.message}`)
  if (err.stack) console.error(err.stack)
  process.exit(1)
})

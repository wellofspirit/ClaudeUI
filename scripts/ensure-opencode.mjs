#!/usr/bin/env node
/**
 * ensure-opencode.mjs
 *
 * Downloads the platform-specific opencode binary via `npm pack` and extracts it
 * into vendor/opencode-cli/. Cache-hit skip on matching version.
 *
 * Uses Node.js-native zlib + a minimal tar parser to avoid relying on any
 * external `tar` command (Git Bash's tar treats Windows drive letters like
 * "D:" as hostnames, causing extraction failures).
 *
 * Usage:
 *   node scripts/ensure-opencode.mjs              # pinned version from package.json#opencodeCliVersion
 *   node scripts/ensure-opencode.mjs --force      # re-download even if vendor/ has it
 */

import { createGunzip } from 'node:zlib'
import { createReadStream } from 'node:fs'
import {
  existsSync,
  mkdirSync,
  chmodSync,
  rmSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  openSync,
  writeSync,
  closeSync,
  renameSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const VENDOR_DIR = join(ROOT, 'vendor', 'opencode-cli')
const CACHE_BASE = join(ROOT, '.cache')

// ── Platform detection ────────────────────────────────────────────────────────

function detectPackageName() {
  const plat = process.platform
  const arch = process.arch
  if (plat === 'win32') return 'opencode-windows-x64'
  if (plat === 'darwin' && arch === 'arm64') return 'opencode-darwin-arm64'
  if (plat === 'darwin') return 'opencode-darwin-x64'
  return 'opencode-linux-x64'
}

// ── Version from package.json ─────────────────────────────────────────────────

function getPinnedVersion() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  return pkg.opencodeCliVersion ?? '1.17.9'
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

// ── Minimal tar extractor (Node.js native, no external tar command) ───────────
//
// Tar format: 512-byte header blocks followed by file data padded to 512 bytes.
// POSIX ustar header layout (offsets):
//   0   name[100]
//   100 mode[8]
//   124 size[12]   (octal)
//   156 typeflag[1]  ('0'/'\0' = file, '5' = dir, 'L' = GNU long-name)
//   265 prefix[155]  (ustar prefix for long filenames)
// GNU long-name: typeflag='L', data block(s) contain the real path.

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

/**
 * Extract the first file whose path ends with `targetSuffix` from a .tgz.
 * Reads the file as a stream to avoid loading the 165MB binary fully into RAM
 * before gunzip. Returns a Buffer with the file contents.
 */
function extractFileFromTgz(tgzPath, targetSuffix) {
  return new Promise((resolve, reject) => {
    const chunks = []
    const readable = createReadStream(tgzPath)
    const gunzip = createGunzip()

    readable.on('error', reject)
    gunzip.on('error', reject)

    gunzip.on('data', (chunk) => chunks.push(chunk))
    gunzip.on('end', () => {
      try {
        const tar = Buffer.concat(chunks)
        const result = walkTar(tar, targetSuffix)
        if (!result) {
          reject(new Error(`"${targetSuffix}" not found in ${tgzPath}`))
        } else {
          resolve(result)
        }
      } catch (e) {
        reject(e)
      }
    })

    readable.pipe(gunzip)
  })
}

/**
 * Walk a raw tar buffer and return the contents of the first entry whose path
 * ends with `targetSuffix`.
 */
function walkTar(tar, targetSuffix) {
  let pos = 0
  let pendingLongName = null

  while (pos + TAR_BLOCK <= tar.length) {
    const header = tar.subarray(pos, pos + TAR_BLOCK)
    if (header.every((b) => b === 0)) break  // end-of-archive sentinel

    pos += TAR_BLOCK

    const typeFlag = String.fromCharCode(header[156])
    const fileSize = readOctal(header, 124, 12)

    // GNU long-name extension: typeflag 'L' → the next data block(s) hold the real name
    if (typeFlag === 'L') {
      const nameBytes = tar.subarray(pos, pos + fileSize)
      pendingLongName = nameBytes.toString('utf8').replace(/\0/g, '')
      pos += Math.ceil(fileSize / TAR_BLOCK) * TAR_BLOCK
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

    // Normalize path separators for cross-platform matching
    const normName = name.replace(/\\/g, '/')
    const normTarget = targetSuffix.replace(/\\/g, '/')

    const dataBlocks = Math.ceil(fileSize / TAR_BLOCK) * TAR_BLOCK

    if ((typeFlag === '0' || typeFlag === '\0') && fileSize > 0) {
      if (normName.endsWith('/' + normTarget) || normName === normTarget) {
        return Buffer.from(tar.subarray(pos, pos + fileSize))
      }
    }

    pos += dataBlocks
  }

  return null
}

// ── Main download + extract logic ─────────────────────────────────────────────

async function download(pkgName, version) {
  const tmpDir = join(CACHE_BASE, `opencode-tmp-${Date.now()}`)
  mkdirSync(tmpDir, { recursive: true })

  try {
    const fullPkg = `${pkgName}@${version}`
    console.log(`[ensure-opencode] Downloading ${fullPkg} via npm pack ...`)

    // Use execSync with a constructed command string so Node runs it via the
    // shell on all platforms. This avoids the shell:true + array-args deprecation
    // warning (DEP0190), and lets npm be found as a .cmd script on Windows.
    // All values are version strings / file paths from trusted sources (not user input).
    // The tmpDir path is quoted to handle spaces. The package name has no spaces.
    const packCmd = `npm pack ${fullPkg} --pack-destination "${tmpDir}"`
    execSync(packCmd, { stdio: 'inherit', cwd: ROOT })

    // Find the .tgz produced by npm pack
    const tgzFiles = readdirSync(tmpDir).filter((f) => f.endsWith('.tgz'))
    if (tgzFiles.length === 0) {
      throw new Error(`npm pack did not produce a .tgz in ${tmpDir}`)
    }
    const tgzPath = join(tmpDir, tgzFiles[0])

    const binName = process.platform === 'win32' ? 'opencode.exe' : 'opencode'
    // The npm pack layout is: package/bin/opencode[.exe]
    const targetSuffix = `bin/${binName}`

    console.log(`[ensure-opencode] Extracting ${binName} from ${tgzFiles[0]} ...`)
    const binBytes = await extractFileFromTgz(tgzPath, targetSuffix)
    console.log(`[ensure-opencode] Extracted ${(binBytes.length / 1024 / 1024).toFixed(1)} MB`)

    mkdirSync(VENDOR_DIR, { recursive: true })
    const dest = join(VENDOR_DIR, binName)

    // Write via temp file + rename for atomicity
    const tmpDest = dest + '.tmp'
    const fd = openSync(tmpDest, 'w')
    writeSync(fd, binBytes)
    closeSync(fd)
    renameSync(tmpDest, dest)

    if (process.platform !== 'win32') {
      chmodSync(dest, 0o755)
    }

    writeFileSync(
      join(VENDOR_DIR, 'version.json'),
      JSON.stringify(
        {
          version,
          package: pkgName,
          platform: process.platform,
          arch: process.arch,
          downloadedAt: new Date().toISOString(),
        },
        null,
        2
      ) + '\n'
    )

    console.log(
      `[ensure-opencode] opencode ${version} installed to vendor/opencode-cli/${binName}`
    )
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

// ── Entry point ────────────────────────────────────────────────────────────────

const force = process.argv.includes('--force')
const version = getPinnedVersion()
const pkgName = detectPackageName()

if (!force && isCacheHit(version)) {
  console.log(
    `[ensure-opencode] opencode ${version} already vendored (cache hit). Use --force to re-download.`
  )
  process.exit(0)
}

download(pkgName, version).catch((err) => {
  console.error(`\n[ensure-opencode] FAIL: ${err.message}`)
  if (err.stack) console.error(err.stack)
  process.exit(1)
})

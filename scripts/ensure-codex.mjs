#!/usr/bin/env node
/**
 * Download the @openai/codex platform-specific native binary and install it
 * into vendor/codex-cli/codex[.exe].
 *
 * Distribution shape:
 *   @openai/codex root package has optional platform aliases, e.g.
 *   @openai/codex-darwin-arm64 -> npm:@openai/codex@<ver>-darwin-arm64
 *   The native binary lives inside that platform package as 'bin/codex[.exe]'.
 *
 * Cache-skip logic:
 *   vendor/codex-cli/version.json stores the installed version.
 *   If it matches package.json#codexCliVersion, skip the download.
 *   --force bypasses the cache check.
 *
 * Usage:
 *   node scripts/ensure-codex.mjs           # pinned version (default)
 *   node scripts/ensure-codex.mjs 0.141.0   # specific version
 *   node scripts/ensure-codex.mjs --force   # force re-download
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { get as httpsGet } from 'node:https'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const VENDOR_DIR = join(ROOT, 'vendor', 'codex-cli')
const OUT_VERSION = join(VENDOR_DIR, 'version.json')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(...args) {
  console.log('[ensure-codex]', ...args)
}

function parseArgs(argv) {
  let defaultVersion = '0.140.0'
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    if (typeof pkg.codexCliVersion === 'string' && pkg.codexCliVersion) {
      defaultVersion = pkg.codexCliVersion
    }
  } catch { /* fall through */ }

  const out = { version: defaultVersion, force: false }
  for (const a of argv) {
    if (a === '--force') out.force = true
    else if (!a.startsWith('--')) out.version = a
  }
  return out
}

/**
 * Map Node's process.platform + process.arch to the @openai/codex platform suffix.
 * Platform packages:
 *   @openai/codex-darwin-arm64
 *   @openai/codex-darwin-x64
 *   @openai/codex-linux-arm64
 *   @openai/codex-linux-x64
 *   @openai/codex-win32-x64
 *   @openai/codex-win32-arm64
 */
function detectPlatformSuffix() {
  const plat = process.platform  // darwin | linux | win32
  const arch = process.arch      // arm64 | x64
  const suffix = `${plat}-${arch}`
  const supported = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64', 'win32-arm64']
  if (!supported.includes(suffix)) {
    throw new Error(`Unsupported platform: ${suffix}. Supported: ${supported.join(', ')}`)
  }
  return suffix
}

function binName() {
  return process.platform === 'win32' ? 'codex.exe' : 'codex'
}

function fetchJson(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    httpsGet(url, { headers: { 'User-Agent': 'claudeui-ensure-codex/1.0' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        if (redirects > 5) return reject(new Error('too many redirects'))
        return resolve(fetchJson(res.headers.location, redirects + 1))
      }
      if (res.statusCode !== 200) return reject(new Error(`GET ${url} → ${res.statusCode}`))
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
        catch (e) { reject(e) }
      })
    }).on('error', reject)
  })
}

function fetchBinary(url, outPath, redirects = 0) {
  return new Promise((resolve, reject) => {
    httpsGet(url, { headers: { 'User-Agent': 'claudeui-ensure-codex/1.0' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        if (redirects > 5) return reject(new Error('too many redirects'))
        return resolve(fetchBinary(res.headers.location, outPath, redirects + 1))
      }
      if (res.statusCode !== 200) return reject(new Error(`GET ${url} → ${res.statusCode}`))
      const total = parseInt(res.headers['content-length'] || '0', 10)
      let seen = 0
      const ws = createWriteStream(outPath)
      res.on('data', chunk => {
        seen += chunk.length
        if (total) process.stdout.write(`\r  downloaded ${(seen / 1024 / 1024).toFixed(1)}MB/${(total / 1024 / 1024).toFixed(1)}MB…  `)
      })
      res.pipe(ws)
      ws.on('finish', () => { process.stdout.write('\n'); ws.close(resolve) })
      ws.on('error', reject)
    }).on('error', reject)
  })
}

/**
 * Determine the tarball URL for the platform package from the npm registry.
 * Platform-specific versions are published as @openai/codex@<version>-<platform>,
 * e.g. @openai/codex@0.140.0-darwin-arm64.
 */
async function resolvePackageTarball(version, platformSuffix) {
  // Platform packages are published under the main package name with a platform version suffix
  const platformVersion = `${version}-${platformSuffix}`
  const registryUrl = `https://registry.npmjs.org/@openai%2Fcodex/${platformVersion}`
  log(`fetching registry metadata for @openai/codex@${platformVersion}`)
  const meta = await fetchJson(registryUrl)
  const tarball = meta?.dist?.tarball
  if (!tarball) {
    throw new Error(`No tarball URL in registry metadata for @openai/codex@${platformVersion}`)
  }
  return { tarball, sha512: meta?.dist?.integrity }
}

/**
 * Map the npm platform suffix to the Rust target triple used inside the tarball.
 * Layout: package/vendor/<rust-triple>/bin/codex[.exe]
 */
function platformToRustTriple(platformSuffix) {
  const map = {
    'darwin-arm64': 'aarch64-apple-darwin',
    'darwin-x64': 'x86_64-apple-darwin',
    'linux-arm64': 'aarch64-unknown-linux-gnu',
    'linux-x64': 'x86_64-unknown-linux-gnu',
    'win32-arm64': 'aarch64-pc-windows-msvc',
    'win32-x64': 'x86_64-pc-windows-msvc',
  }
  const triple = map[platformSuffix]
  if (!triple) throw new Error(`No Rust triple mapping for platform: ${platformSuffix}`)
  return triple
}

/**
 * Extract the native codex binary from the npm tarball (gzipped tar).
 * The binary lives at package/vendor/<rust-triple>/bin/codex[.exe].
 * Falls back to listing the tarball to find it if the expected path is absent.
 */
async function extractBinaryFromTarball(tarballPath, outBinPath, platformSuffix) {
  const bin = binName()
  const rustTriple = platformToRustTriple(platformSuffix)
  const targetEntry = `package/vendor/${rustTriple}/bin/${bin}`

  const extractDir = join(tmpdir(), `codex-extract-${Date.now()}`)
  mkdirSync(extractDir, { recursive: true })
  try {
    execSync(`tar xf "${tarballPath}" -C "${extractDir}"`, { stdio: 'pipe' })
    let srcPath = join(extractDir, targetEntry)
    if (!existsSync(srcPath)) {
      // Fallback: list the archive and find the actual codex binary
      const contents = execSync(`tar tf "${tarballPath}"`, { encoding: 'utf8' })
      const binEntry = contents.split('\n').find(l => l.endsWith(`/bin/${bin}`) || l.endsWith(`/bin/codex`))
      if (!binEntry) {
        const binEntries = contents.split('\n').filter(l => l.includes('bin/'))
        throw new Error(
          `Binary not found in tarball at expected path: ${targetEntry}\nBin entries: ${binEntries.join(', ')}`
        )
      }
      srcPath = join(extractDir, binEntry.trim())
      log(`found binary at fallback path: ${binEntry.trim()}`)
    }
    const binData = readFileSync(srcPath)
    writeFileSync(outBinPath, binData, { mode: 0o755 })
    log(`extracted ${bin}: ${(binData.length / 1024 / 1024).toFixed(1)}MB`)
  } finally {
    rmSync(extractDir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// macOS ad-hoc codesign
// ---------------------------------------------------------------------------

function codesignIfNeeded(binPath) {
  if (process.platform !== 'darwin') return
  try {
    execSync(`codesign -v "${binPath}" 2>/dev/null`, { stdio: 'pipe' })
    log('codesign: already signed')
  } catch {
    log('codesign: applying ad-hoc signature')
    execSync(`codesign --force --sign - "${binPath}"`, { stdio: 'inherit' })
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const { version, force } = args

  const outBin = join(VENDOR_DIR, binName())

  // Cache-hit check
  if (!force && existsSync(OUT_VERSION)) {
    try {
      const stored = JSON.parse(readFileSync(OUT_VERSION, 'utf8'))
      if (stored.version === version && existsSync(outBin)) {
        log(`cache hit: ${outBin} @ ${version} — skipping download`)
        return
      }
    } catch { /* stale or malformed version.json — re-download */ }
  }

  const platformSuffix = detectPlatformSuffix()
  log(`target platform: ${platformSuffix}`)
  log(`codex version: ${version}`)

  // Resolve tarball URL from npm registry
  const { tarball, sha512 } = await resolvePackageTarball(version, platformSuffix)
  log(`tarball URL: ${tarball}`)

  // Download to cache dir
  const cacheDir = join(ROOT, '.cache', 'codex-cli')
  mkdirSync(cacheDir, { recursive: true })
  const tarballPath = join(cacheDir, `codex-${version}-${platformSuffix}.tgz`)

  if (!force && existsSync(tarballPath)) {
    log(`cache hit tarball: ${tarballPath}`)
  } else {
    log(`downloading tarball…`)
    await fetchBinary(tarball, tarballPath)
  }

  // Verify SHA-512 integrity (npm integrity format: sha512-<base64>)
  if (sha512 && sha512.startsWith('sha512-')) {
    const expected = sha512.slice('sha512-'.length)
    const actual = createHash('sha512').update(readFileSync(tarballPath)).digest('base64')
    if (actual !== expected) {
      rmSync(tarballPath, { force: true })
      throw new Error(`SHA-512 mismatch for tarball.\nExpected: ${expected}\nActual:   ${actual}`)
    }
    log(`integrity verified: sha512 ok`)
  }

  // Wipe vendor dir and recreate
  if (existsSync(VENDOR_DIR)) rmSync(VENDOR_DIR, { recursive: true, force: true })
  mkdirSync(VENDOR_DIR, { recursive: true })

  // Extract binary from tarball
  await extractBinaryFromTarball(tarballPath, outBin, platformSuffix)

  // Make executable
  if (process.platform !== 'win32') {
    chmodSync(outBin, 0o755)
  }

  // macOS ad-hoc codesign
  codesignIfNeeded(outBin)

  // Write version stamp
  writeFileSync(OUT_VERSION, JSON.stringify({
    version,
    platform: platformSuffix,
    source: `@openai/codex-${platformSuffix}@${version}-${platformSuffix}`,
    tarball,
    installedAt: new Date().toISOString(),
  }, null, 2) + '\n')
  log(`wrote ${OUT_VERSION}`)
  log('done.')
}

main().catch(err => {
  console.error(`\n[ensure-codex] FAIL: ${err.message}`)
  if (err.stack) console.error(err.stack)
  process.exit(1)
})

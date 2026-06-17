#!/usr/bin/env node
/**
 * Download the official @anthropic-ai/claude-code Bun standalone binary and
 * extract the wrapped cli.js module from its `.bun` section for patching.
 *
 * Output:
 *   - `vendor/claude-cli/cli.js` — wrapped CJS IIFE bytes ready for text
 *     patching by `patch/apply-all.mjs` and re-injection by
 *     `scripts/rebundle-cli.mjs`.
 *   - `vendor/claude-cli/vendor/<addon>/<arch>-<platform>/<addon>.node` —
 *     native NAPI addons (e.g. `audio-capture.node`) for the Electron
 *     main process to load directly. cli.js itself resolves these from
 *     the rebundled Bun binary's own module graph, but `voice-capture.ts`
 *     in the Electron main process needs a loose copy on disk.
 *
 * Pipeline:
 *   1. Resolve upstream version (pin via package.json#claudeCliVersion).
 *   2. Download claude-<version>-<platform>.exe from downloads.claude.ai
 *      (verifies SHA256 against manifest; cached under .cache/claude-cli/ —
 *      CI caches this directory keyed on the pinned version).
 *   3. Parse Bun's standalone trailer, walk the modules table, extract
 *      cli.js and every `.node` addon verbatim.
 *   4. Write to vendor/claude-cli/cli.js + per-triple addon paths +
 *      version.json.
 *
 * Runs unconditionally — the full extract + patch + rebundle pipeline costs
 * a few seconds once the source binary is cached, and patches can change
 * independently of claudeCliVersion, so there's nothing to gain from
 * short-circuiting on a vendor/ cache.
 *
 * Usage:
 *   node scripts/extract-cli.mjs              # pinned version
 *   node scripts/extract-cli.mjs 2.1.114      # specific version
 *   node scripts/extract-cli.mjs --force      # re-download even if .cache/ has it
 *   node scripts/extract-cli.mjs --binary P   # use pre-downloaded binary P
 */

import { createHash } from 'node:crypto'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { get as httpsGet } from 'node:https'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const VENDOR_DIR = join(ROOT, 'vendor', 'claude-cli')
const OUT_CLI = join(VENDOR_DIR, 'cli.js')
const OUT_VERSION = join(VENDOR_DIR, 'version.json')
const DL_BASE = 'https://downloads.claude.ai/claude-code-releases'
const UA = {
  'User-Agent': 'claude-ui-extract/2.0 (+https://github.com/wellofspirit/ClaudeUI)'
}
const BUN_MAGIC = Buffer.from('\n---- Bun! ----\n', 'utf8')

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  let defaultVersion = 'latest'
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    if (typeof pkg.claudeCliVersion === 'string' && pkg.claudeCliVersion) {
      defaultVersion = pkg.claudeCliVersion
    }
  } catch {
    /* fall through */
  }
  const out = { version: defaultVersion, binaryPath: null, force: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--binary') out.binaryPath = argv[++i]
    else if (a === '--force') out.force = true
    else if (!a.startsWith('--')) out.version = a
  }
  return out
}

function log(...args) {
  console.log('[extract-cli]', ...args)
}

function mb(n) {
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}

// ---------------------------------------------------------------------------
// Download — the source binary lives in .cache/claude-cli/ keyed by version;
// re-extracting + re-patching + re-rebundling is cheap (~2s) so we always
// run the full pipeline and only cache the 200MB download.
// ---------------------------------------------------------------------------

function detectPlatform() {
  const plat = process.platform
  const arch = process.arch
  const key =
    plat === 'win32' ? `win32-${arch}` : plat === 'darwin' ? `darwin-${arch}` : `linux-${arch}`
  const binName = plat === 'win32' ? 'claude.exe' : 'claude'
  return { key, binName }
}

function fetchText(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    httpsGet(url, { headers: UA }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        if (redirects > 5) return reject(new Error('too many redirects'))
        return resolve(fetchText(res.headers.location, redirects + 1))
      }
      if (res.statusCode !== 200) return reject(new Error(`GET ${url} → ${res.statusCode}`))
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    }).on('error', reject)
  })
}

function fetchBinary(url, outPath, redirects = 0) {
  return new Promise((resolve, reject) => {
    httpsGet(url, { headers: UA }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        if (redirects > 5) return reject(new Error('too many redirects'))
        return resolve(fetchBinary(res.headers.location, outPath, redirects + 1))
      }
      if (res.statusCode !== 200) return reject(new Error(`GET ${url} → ${res.statusCode}`))
      const total = parseInt(res.headers['content-length'] || '0', 10)
      let seen = 0
      const ws = createWriteStream(outPath)
      res.on('data', (chunk) => {
        seen += chunk.length
        if (total) process.stdout.write(`\r  downloaded ${mb(seen)}/${mb(total)}…  `)
      })
      res.pipe(ws)
      ws.on('finish', () => {
        process.stdout.write('\n')
        ws.close(resolve)
      })
      ws.on('error', reject)
    }).on('error', reject)
  })
}

function sha256File(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex')
}

async function resolveBinary(arg) {
  if (arg.binaryPath) {
    const p = resolve(arg.binaryPath)
    if (!existsSync(p)) throw new Error(`--binary path not found: ${p}`)
    return { binPath: p, version: null }
  }
  let version = arg.version
  if (version === 'latest' || version === 'stable') {
    version = (await fetchText(`${DL_BASE}/${version}`)).trim()
  }
  log(`upstream version: ${version}`)

  const manifest = JSON.parse(await fetchText(`${DL_BASE}/${version}/manifest.json`))
  const { key, binName } = detectPlatform()
  const entry = manifest.platforms[key]
  if (!entry) {
    throw new Error(
      `Platform ${key} not in manifest for ${version}. Available: ${Object.keys(manifest.platforms).join(', ')}`
    )
  }

  const cacheDir = join(ROOT, '.cache', 'claude-cli')
  mkdirSync(cacheDir, { recursive: true })
  const binPath = join(
    cacheDir,
    `claude-${version}-${key}${binName.endsWith('.exe') ? '.exe' : ''}`
  )

  if (existsSync(binPath) && !arg.force) {
    const have = sha256File(binPath)
    if (have === entry.checksum) {
      log(`cache hit: ${binPath}`)
      return { binPath, version }
    }
    log(`cache stale (sha mismatch), re-downloading`)
  } else if (existsSync(binPath) && arg.force) {
    log(`--force: ignoring cached ${binPath}`)
  }

  const url = `${DL_BASE}/${version}/${key}/${binName}`
  log(`downloading ${url}`)
  await fetchBinary(url, binPath)

  const got = sha256File(binPath)
  if (got !== entry.checksum) {
    rmSync(binPath, { force: true })
    throw new Error(`SHA256 mismatch: expected ${entry.checksum}, got ${got}`)
  }
  log(`sha256 verified: ${got}`)
  return { binPath, version }
}

// ---------------------------------------------------------------------------
// Wrapped cli.js extractor — walks the PE `.bun` section, finds the cli.js
// module entry in the trailer's modules table, and returns its contents bytes.
// ---------------------------------------------------------------------------

function findBunSectionRawOff(buf) {
  if (buf.readUInt16LE(0) !== 0x5a4d) throw new Error('not a PE binary')
  const peOff = buf.readUInt32LE(0x3c)
  if (buf.readUInt32LE(peOff) !== 0x00004550) throw new Error('no PE signature')
  const numSections = buf.readUInt16LE(peOff + 6)
  const sizeOptHdr = buf.readUInt16LE(peOff + 20)
  const sectionsOff = peOff + 24 + sizeOptHdr
  for (let i = 0; i < numSections; i++) {
    const s = sectionsOff + i * 40
    const name = buf
      .subarray(s, s + 8)
      .toString('ascii')
      .replace(/\0+$/, '')
    if (name === '.bun') return buf.readUInt32LE(s + 20)
  }
  throw new Error('.bun section not found in PE binary')
}

/**
 * Extract cli.js and all `.node` native addons from a Bun standalone binary.
 * Walks the trailer at the end of the `.bun` section (PE) or the file
 * (overlay formats on mac/linux).
 */
function extractWrappedAssets(buf) {
  let blob
  if (buf.readUInt16LE(0) === 0x5a4d) {
    // Windows PE — `.bun` section holds [u64 blobLen][blob][padding]
    const rawOff = findBunSectionRawOff(buf)
    const blobLen = Number(buf.readBigUInt64LE(rawOff))
    blob = buf.subarray(rawOff + 8, rawOff + 8 + blobLen)
  } else {
    // Mach-O / ELF — blob sits at EOF or in a named section. `lastIndexOf`
    // on the full buffer + `byte_count` computation is format-agnostic for
    // reading (see Bun's StandaloneModuleGraph.zig).
    blob = buf
  }

  const magicIdx = blob.lastIndexOf(BUN_MAGIC)
  if (magicIdx < 0) throw new Error('Bun trailer magic not found')
  const offsetsOff = magicIdx - 32
  const byte_count = Number(blob.readBigUInt64LE(offsetsOff))
  const mod_off = blob.readUInt32LE(offsetsOff + 8)
  const mod_len = blob.readUInt32LE(offsetsOff + 12)
  const data_start = offsetsOff - byte_count

  if (mod_len % 52 !== 0) throw new Error(`invalid modules table length ${mod_len}`)
  const n = mod_len / 52
  const base = data_start + mod_off

  const assets = { cliName: null, cliBytes: null, addons: [] }
  for (let i = 0; i < n; i++) {
    const e = base + i * 52
    const nameOff = blob.readUInt32LE(e)
    const nameLen = blob.readUInt32LE(e + 4)
    const name = blob
      .subarray(data_start + nameOff, data_start + nameOff + nameLen)
      .toString('utf8')
    const cOff = blob.readUInt32LE(e + 8)
    const cLen = blob.readUInt32LE(e + 12)
    const bytes = Buffer.from(blob.subarray(data_start + cOff, data_start + cOff + cLen))

    if (name.endsWith('/cli.js') || name.endsWith('\\cli.js')) {
      assets.cliName = name
      assets.cliBytes = bytes
    } else if (name.endsWith('.node')) {
      const leaf = name.split(/[\\/]/).pop()
      const addonName = leaf.replace(/\.node$/, '')
      assets.addons.push({ name, addonName, bytes })
    }
  }
  if (!assets.cliBytes) throw new Error('cli.js module not found in modules table')
  return assets
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const { binPath, version } = await resolveBinary(args)

  log(`reading ${binPath}`)
  const buf = readFileSync(binPath)
  const { cliName, cliBytes, addons } = extractWrappedAssets(buf)
  log(`extracted cli.js: ${cliBytes.length.toLocaleString()} bytes (from "${cliName}")`)

  // Wipe the vendor dir so stale artifacts (old pipeline's unwrapped cli.js
  // with Bun-path shim, stale addon copies, vendored ripgrep) don't leak
  // into the build. Safe — rebundle + addon writes below regenerate
  // what's needed.
  if (existsSync(VENDOR_DIR)) rmSync(VENDOR_DIR, { recursive: true, force: true })
  mkdirSync(VENDOR_DIR, { recursive: true })
  writeFileSync(OUT_CLI, cliBytes)
  log(`wrote ${OUT_CLI}`)

  // Native addons — extracted for the host triple (Bun binary is
  // host-specific, so cross-platform packaging is already host-bound).
  // Layout matches what voice-capture.ts expects:
  //   vendor/claude-cli/vendor/<addonName>/<arch>-<platform>/<addonName>.node
  const triple = `${process.arch}-${process.platform}`
  for (const addon of addons) {
    const outDir = join(VENDOR_DIR, 'vendor', addon.addonName, triple)
    mkdirSync(outDir, { recursive: true })
    const outPath = join(outDir, `${addon.addonName}.node`)
    writeFileSync(outPath, addon.bytes)
    log(`wrote ${outPath} (${addon.bytes.length.toLocaleString()} bytes)`)
  }

  // Store `sourceBinary` relative to ROOT when the binary lives inside the
  // project (the usual .cache/claude-cli/ path); fall back to the absolute
  // path for `--binary <external-path>` overrides. Relative paths survive
  // project relocation and are meaningful across machines with the same
  // checkout layout — unlike the hardcoded absolute path we stored before.
  const rel = relative(ROOT, binPath)
  const sourceBinary = rel === '' || rel.startsWith('..') || isAbsolute(rel) ? binPath : rel

  writeFileSync(
    OUT_VERSION,
    JSON.stringify(
      {
        version: version ?? 'unknown',
        source: '@anthropic-ai/claude-code (Bun standalone binary)',
        sourceBinary,
        extractedAt: new Date().toISOString(),
        cliSize: cliBytes.length,
        cliSha256: createHash('sha256').update(cliBytes).digest('hex'),
        form: 'wrapped'
      },
      null,
      2
    ) + '\n'
  )
  log(`wrote ${OUT_VERSION}`)
  log('done.')
}

main().catch((err) => {
  console.error(`\n[extract-cli] FAIL: ${err.message}`)
  if (err.stack) console.error(err.stack)
  process.exit(1)
})

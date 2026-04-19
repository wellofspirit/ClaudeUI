#!/usr/bin/env node
/**
 * Extracts cli.js from the official @anthropic-ai/claude-code Bun standalone
 * binary, transforms it into a Node-runnable script, and vendors it under
 * vendor/claude-cli/.
 *
 * Pipeline:
 *   1. Download claude-<version>-<platform>.exe from downloads.claude.ai
 *      (verifies SHA256 against the manifest).
 *   2. Parse Bun's standalone executable trailer:
 *        [data buffer] [Offsets struct: 32 bytes] [Magic: 16 bytes] [optional cert]
 *      Magic: "\n---- Bun! ----\n"
 *      Offsets: byte_count(u64) modules_ptr(u32,u32) entry_point_id(u32)
 *               argv_ptr(u32,u32) flags(u32)
 *      Module entries are 52 bytes each: 6×StringPointer + 4 u8 flags.
 *   3. Locate the cli.js entry by name, slice its contents.
 *   4. Transform Bun's CJS wrapper into a standalone Node script:
 *        strip "// @bun @bytecode @bun-cjs" header
 *        unwrap "(function(exports, require, module, __filename, __dirname) { ... })"
 *        prepend "#!/usr/bin/env node"
 *   5. Write cli.js + native .node addons under vendor/claude-cli/.
 *
 *   Usage:
 *     node scripts/extract-cli.mjs                # download latest, extract
 *     node scripts/extract-cli.mjs 2.1.114        # specific version
 *     node scripts/extract-cli.mjs --binary path  # use a pre-downloaded .exe
 */

import {
  createHash,
} from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { get as httpsGet } from 'node:https'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const VENDOR_DIR = join(ROOT, 'vendor', 'claude-cli')
const OUT_VERSION = join(VENDOR_DIR, 'version.json')
const DL_BASE = 'https://downloads.claude.ai/claude-code-releases'

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  // Default version comes from package.json#claudeCliVersion — lets us pin
  // the build to a specific upstream release without passing args everywhere.
  let defaultVersion = 'latest'
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    if (typeof pkg.claudeCliVersion === 'string' && pkg.claudeCliVersion) {
      defaultVersion = pkg.claudeCliVersion
    }
  } catch {
    /* fall through to 'latest' */
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

/**
 * Return the version stamped in an existing vendor/claude-cli install, or
 * null if missing/unreadable. Used for cache-hit detection so repeated
 * `bun run dev` / `bun run build` calls don't re-download 250MB each time.
 */
function readCachedVersion() {
  try {
    const v = JSON.parse(readFileSync(OUT_VERSION, 'utf8'))
    if (existsSync(join(VENDOR_DIR, 'cli.js'))) {
      return typeof v.version === 'string' ? v.version : null
    }
  } catch {
    /* no cache */
  }
  return null
}

function log(...args) {
  console.log('[extract-cli]', ...args)
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

function detectPlatform() {
  const plat = process.platform
  const arch = process.arch
  const key =
    plat === 'win32' ? `win32-${arch}` : plat === 'darwin' ? `darwin-${arch}` : `linux-${arch}`
  const binName = plat === 'win32' ? 'claude.exe' : 'claude'
  return { key, binName }
}

const UA = { 'User-Agent': 'claude-ui-extract/1.0 (+https://github.com/wellofspirit/ClaudeUI)' }

function fetchText(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    httpsGet(url, { headers: UA }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        if (redirects > 5) return reject(new Error('too many redirects'))
        return resolve(fetchText(res.headers.location, redirects + 1))
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`GET ${url} → ${res.statusCode}`))
      }
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    }).on('error', reject)
  })
}

function fetchBinary(url, outPath, redirects = 0) {
  return new Promise((resolve, reject) => {
    const { createWriteStream } = require('node:fs')
    httpsGet(url, { headers: UA }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        if (redirects > 5) return reject(new Error('too many redirects'))
        return resolve(fetchBinary(res.headers.location, outPath, redirects + 1))
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`GET ${url} → ${res.statusCode}`))
      }
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

function mb(n) {
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}

// Delayed-load require for createWriteStream; keeps top-level imports clean.
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

async function resolveBinary(arg) {
  if (arg.binaryPath) {
    const p = resolve(arg.binaryPath)
    if (!existsSync(p)) throw new Error(`--binary path not found: ${p}`)
    return { binPath: p, version: null }
  }

  // Resolve version
  let version = arg.version
  if (version === 'latest' || version === 'stable') {
    version = (await fetchText(`${DL_BASE}/${version}`)).trim()
  }
  log(`upstream version: ${version}`)

  // Manifest has SHA256 and per-platform sizes
  const manifest = JSON.parse(await fetchText(`${DL_BASE}/${version}/manifest.json`))
  const { key, binName } = detectPlatform()
  const entry = manifest.platforms[key]
  if (!entry) {
    throw new Error(`Platform ${key} not in manifest for ${version}. Available: ${Object.keys(manifest.platforms).join(', ')}`)
  }

  const cacheDir = join(ROOT, '.cache', 'claude-cli')
  mkdirSync(cacheDir, { recursive: true })
  const binPath = join(cacheDir, `claude-${version}-${key}${binName.endsWith('.exe') ? '.exe' : ''}`)

  if (existsSync(binPath)) {
    const have = sha256File(binPath)
    if (have === entry.checksum) {
      log(`cache hit: ${binPath}`)
      return { binPath, version }
    }
    log(`cache stale (sha mismatch), re-downloading`)
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

function sha256File(p) {
  const h = createHash('sha256')
  h.update(readFileSync(p))
  return h.digest('hex')
}

// ---------------------------------------------------------------------------
// Bun standalone binary parser
// ---------------------------------------------------------------------------

const BUN_MAGIC = Buffer.from('\n---- Bun! ----\n', 'utf8') // 16 bytes

/**
 * Locate the Bun trailer magic. On Windows PE binaries, the magic sits before
 * the Authenticode certificate table, so scan from EOF backwards.
 */
function findMagic(buf) {
  const idx = buf.lastIndexOf(BUN_MAGIC)
  if (idx < 0) throw new Error('Bun trailer magic not found — not a standalone binary?')
  return idx
}

/**
 * Parse the Offsets struct (32 bytes) that sits immediately before the magic:
 *   byte_count: u64
 *   modules_ptr: { offset: u32, length: u32 }
 *   entry_point_id: u32
 *   argv_ptr: { offset: u32, length: u32 }
 *   flags: u32
 * Offsets are relative to a "data buffer" that ends at the Offsets struct.
 * So: data_start = magic_offset - 32 - byte_count.
 */
function parseOffsets(buf, magicIdx) {
  const o = magicIdx - 32
  const byte_count = Number(buf.readBigUInt64LE(o))
  const mod_off = buf.readUInt32LE(o + 8)
  const mod_len = buf.readUInt32LE(o + 12)
  const entry = buf.readUInt32LE(o + 16)
  const argv_off = buf.readUInt32LE(o + 20)
  const argv_len = buf.readUInt32LE(o + 24)
  const flags = buf.readUInt32LE(o + 28)
  const data_start = magicIdx - 32 - byte_count
  return { byte_count, mod_off, mod_len, entry, argv_off, argv_len, flags, data_start }
}

/**
 * Parse the 52-byte CompiledModuleGraphFile records at the modules table.
 * Layout (file-order verified against claude-code 2.1.112):
 *   name, contents, sourcemap, bytecode, module_info, bytecode_origin_path:
 *     each StringPointer { offset: u32, length: u32 } (8 bytes)
 *   encoding: u8
 *   loader: u8
 *   module_format: u8
 *   side: u8
 *   ───────
 *   48 + 4 = 52 bytes
 */
function parseModules(buf, { data_start, mod_off, mod_len }) {
  const ENTRY_SIZE = 52
  if (mod_len % ENTRY_SIZE !== 0) {
    throw new Error(`modules table length ${mod_len} not divisible by ${ENTRY_SIZE}`)
  }
  const n = mod_len / ENTRY_SIZE
  const base = data_start + mod_off
  const out = []
  for (let i = 0; i < n; i++) {
    const e = base + i * ENTRY_SIZE
    const sp = (p) => ({ off: buf.readUInt32LE(p), len: buf.readUInt32LE(p + 4) })
    const name = sp(e)
    const contents = sp(e + 8)
    const sourcemap = sp(e + 16)
    const bytecode = sp(e + 24)
    const module_info = sp(e + 32)
    const bytecode_origin_path = sp(e + 40)
    const encoding = buf.readUInt8(e + 48)
    const loader = buf.readUInt8(e + 49)
    const module_format = buf.readUInt8(e + 50)
    const side = buf.readUInt8(e + 51)
    const readStr = ({ off, len }) => buf.subarray(data_start + off, data_start + off + len)
    out.push({
      name: readStr(name).toString('utf8'),
      contents: readStr(contents),
      sourcemap,
      bytecode,
      module_info,
      bytecode_origin_path,
      encoding,
      loader,
      module_format,
      side,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Transform: Bun CJS wrapper → Node-runnable script
// ---------------------------------------------------------------------------

/**
 * The Bun binary ships cli.js wrapped as:
 *   // @bun @bytecode @bun-cjs
 *   (function(exports, require, module, __filename, __dirname) { ... })
 *
 * To run under plain Node we:
 *   1. Strip the leading "@bun" header comment
 *   2. Unwrap the outer `(function(...){ BODY })` into bare BODY
 *   3. Prepend `#!/usr/bin/env node` + a short provenance header
 *
 * The body is what Node's own CJS loader would wrap — so unwrapped, it
 * behaves identically when Node re-wraps via `module._compile`.
 */
const SHIM = `
// ─── Bun path redirect (injected by scripts/extract-cli.mjs) ───────────────
// Bun's compiled binary uses virtual paths like "B:/~BUN/root/X.node" for
// embedded native addons. Under Node, intercept those and redirect to the
// vendored files next to this cli.js.
(function () {
  const path = require('path')
  const Module = require('module')
  const origResolve = Module._resolveFilename
  const archPlat = process.arch + '-' + process.platform
  const here = __dirname
  const redirects = {
    'B:/~BUN/root/audio-capture.node':
      path.join(here, 'vendor', 'audio-capture', archPlat, 'audio-capture.node'),
    'B:/~BUN/root/image-processor.node':
      path.join(here, 'vendor', 'image-processor', archPlat, 'image-processor.node'),
  }
  Module._resolveFilename = function (request, parent) {
    if (redirects[request]) return redirects[request]
    return origResolve.apply(this, arguments)
  }
})();
// ─── end Bun shim ──────────────────────────────────────────────────────────
`

function transformCliJs(content, upstreamVersion, { isHelper = false } = {}) {
  let src = content.toString('utf8')

  // A. Strip the @bun header line
  if (src.startsWith('// @bun')) {
    const nl = src.indexOf('\n')
    src = src.slice(nl + 1)
  }

  // B. Unwrap outer `(function(exports, require, module, __filename, __dirname){ BODY })`
  const openRe = /^\s*\(\s*function\s*\(([^)]*)\)\s*\{/
  const m = openRe.exec(src)
  if (!m) {
    throw new Error('Not a CJS wrapper IIFE — cannot unwrap')
  }
  src = src.slice(m[0].length)
  let end = src.length - 1
  while (end >= 0 && /\s/.test(src[end])) end--
  if (src[end] !== ')' || src[end - 1] !== '}') {
    throw new Error('Does not end with `})` — cannot unwrap')
  }
  src = src.slice(0, end - 1) // drop `})`

  // C/D. Prepend shebang + shim + provenance
  const header =
    '#!/usr/bin/env node\n' +
    '// (c) Anthropic PBC. All rights reserved.\n' +
    (upstreamVersion
      ? `// Source: @anthropic-ai/claude-code ${upstreamVersion} (Bun standalone binary)\n`
      : '') +
    '// Extracted by scripts/extract-cli.mjs and unwrapped from Bun CJS form.\n'

  // Only main cli.js gets the Bun-path shim. Helper .js files are inlined
  // into cli.js's CJS module cache and therefore inherit the redirects.
  const shim = isHelper ? '' : SHIM

  return header + shim + '\n' + src
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2))

  // Cache-hit check: skip the whole download+extract dance if we already
  // have the target version extracted. Patches are idempotent and run
  // separately, so re-running them on a cached extract is safe.
  if (!args.force && !args.binaryPath && args.version !== 'latest' && args.version !== 'stable') {
    const cached = readCachedVersion()
    if (cached === args.version) {
      log(`cache hit: vendor/claude-cli/ already at ${cached} — skipping extraction`)
      log('(run with --force to re-extract)')
      return
    }
    if (cached) {
      log(`cache version (${cached}) != target (${args.version}) — re-extracting`)
    } else {
      log(`no cache — extracting ${args.version}`)
    }
  }

  const { binPath, version } = await resolveBinary(args)

  log(`parsing ${binPath}`)
  const buf = readFileSync(binPath)
  const magicIdx = findMagic(buf)
  log(`magic at 0x${magicIdx.toString(16)}`)
  const offsets = parseOffsets(buf, magicIdx)
  log(`data_start=0x${offsets.data_start.toString(16)}  byte_count=${offsets.byte_count.toLocaleString()}`)
  const modules = parseModules(buf, offsets)
  log(`modules (${modules.length}):`)
  for (const m of modules) log(`  - ${m.name} (${m.contents.length.toLocaleString()} bytes)`)

  // Find cli.js
  const cliEntry = modules.find((m) => m.name.endsWith('/cli.js') || m.name.endsWith('\\cli.js'))
  if (!cliEntry) throw new Error('No cli.js in embedded modules')

  // Transform
  const transformed = transformCliJs(cliEntry.contents, version)
  log(`transformed cli.js: ${transformed.length.toLocaleString()} bytes`)

  // Syntax check — catches IIFE-unwrap mistakes before we commit.
  // Try node → bun → esbuild; skip whichever isn't installed. Same pattern
  // as patch/apply-all.mjs: bun's node-compat shim doesn't implement --check
  // and bails with "Input must be provided", which we treat as "try next".
  const tmp = join(ROOT, '.cache', 'cli-check.js')
  mkdirSync(dirname(tmp), { recursive: true })
  writeFileSync(tmp, transformed)

  const checkers = [
    {
      name: 'node --check',
      run: () => execFileSync('node', ['--check', tmp], { stdio: 'pipe' }),
    },
    {
      name: 'bun build --no-bundle',
      run: () =>
        execFileSync('bun', ['build', '--no-bundle', '--outfile', '/dev/null', tmp], {
          stdio: 'pipe',
        }),
    },
    {
      name: 'esbuild',
      run: () =>
        execFileSync(
          resolve(ROOT, 'node_modules', '.bin', 'esbuild'),
          ['--bundle=false', tmp],
          { stdio: 'pipe' },
        ),
    },
  ]

  let checked = false
  for (const checker of checkers) {
    try {
      checker.run()
      log(`syntax check passed (${checker.name})`)
      checked = true
      break
    } catch (err) {
      if (err.code === 'ENOENT') continue // tool not installed; try next
      const stderr = err.stderr?.toString() || ''
      // bun's node shim rejects --check — advance to the next checker.
      if (checker.name === 'node --check' && stderr.includes('Input must be provided')) continue
      throw new Error(`Transformed cli.js failed syntax check (${checker.name}):\n${stderr || err.message}`)
    }
  }
  if (!checked) {
    log('WARN: no syntax checker available (node/bun/esbuild all absent) — skipping')
  }

  // Clean vendor/ dir before rebuilding (don't leak stale ripgrep/etc).
  if (existsSync(VENDOR_DIR)) rmSync(VENDOR_DIR, { recursive: true, force: true })
  mkdirSync(VENDOR_DIR, { recursive: true })
  writeFileSync(join(VENDOR_DIR, 'cli.js'), transformed)
  log(`wrote ${join(VENDOR_DIR, 'cli.js')}`)

  // Native addons live under vendor/<name>/<arch>-<platform>/<name>.node
  // — this matches (a) the Bun-shim redirect map in the transform, and (b)
  // the layout the SDK's own cli.js expects.
  const addons = modules.filter((m) => m.name.endsWith('.node'))
  const archPlat = `${process.arch}-${process.platform}`
  for (const m of addons) {
    const base = basenameOf(m.name).replace(/\.node$/, '') // "audio-capture"
    const outDir = join(VENDOR_DIR, 'vendor', base, archPlat)
    mkdirSync(outDir, { recursive: true })
    const outPath = join(outDir, `${base}.node`)
    writeFileSync(outPath, m.contents)
    log(`wrote ${outPath} (${m.contents.length.toLocaleString()} bytes)`)
  }
  // Helper .js files aren't needed once the Bun-shim is in place — the main
  // cli.js has them inlined into its own module cache and the shim redirects
  // their require() paths. Skip writing them.

  // Ripgrep is statically linked into Bun, not an extractable module. Download
  // it from BurntSushi/ripgrep releases for the current platform.
  await downloadRipgrep(archPlat)

  // Version manifest
  writeFileSync(
    join(VENDOR_DIR, 'version.json'),
    JSON.stringify(
      {
        version: version ?? 'unknown',
        source: '@anthropic-ai/claude-code (Bun standalone binary)',
        extractedAt: new Date().toISOString(),
        cliSize: transformed.length,
        cliSha256: createHash('sha256').update(transformed).digest('hex'),
      },
      null,
      2,
    ) + '\n',
  )
  log(`wrote ${join(VENDOR_DIR, 'version.json')}`)
  log('done.')
}

function basenameOf(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}

// ---------------------------------------------------------------------------
// Ripgrep — downloaded separately (statically linked inside Bun binary)
// ---------------------------------------------------------------------------

/**
 * Map our arch-platform key to the ripgrep release asset name + extracted binary.
 */
function ripgrepAssetFor(archPlat) {
  // Ripgrep's release naming: <version>-<triple>.<ext>
  const map = {
    'x64-win32': { triple: 'x86_64-pc-windows-msvc', ext: 'zip', bin: 'rg.exe' },
    'arm64-win32': { triple: 'aarch64-pc-windows-msvc', ext: 'zip', bin: 'rg.exe' },
    'x64-darwin': { triple: 'x86_64-apple-darwin', ext: 'tar.gz', bin: 'rg' },
    'arm64-darwin': { triple: 'aarch64-apple-darwin', ext: 'tar.gz', bin: 'rg' },
    'x64-linux': { triple: 'x86_64-unknown-linux-musl', ext: 'tar.gz', bin: 'rg' },
    'arm64-linux': { triple: 'aarch64-unknown-linux-gnu', ext: 'tar.gz', bin: 'rg' },
  }
  const m = map[archPlat]
  if (!m) throw new Error(`No ripgrep mapping for platform ${archPlat}`)
  return m
}

async function downloadRipgrep(archPlat) {
  log(`resolving ripgrep release for ${archPlat}…`)
  const meta = JSON.parse(
    await fetchText('https://api.github.com/repos/BurntSushi/ripgrep/releases/latest'),
  )
  const version = meta.tag_name
  const { triple, ext, bin } = ripgrepAssetFor(archPlat)
  const assetName = `ripgrep-${version}-${triple}.${ext}`
  const asset = meta.assets.find((a) => a.name === assetName)
  if (!asset) {
    throw new Error(`ripgrep asset not found: ${assetName}. Available: ${meta.assets.map((a) => a.name).join(', ')}`)
  }
  log(`ripgrep ${version}: ${assetName} (${mb(asset.size)})`)

  const cacheDir = join(ROOT, '.cache', 'ripgrep')
  mkdirSync(cacheDir, { recursive: true })
  const archivePath = join(cacheDir, assetName)
  if (!existsSync(archivePath)) {
    log(`downloading ${asset.browser_download_url}`)
    await fetchBinary(asset.browser_download_url, archivePath)
  } else {
    log(`cache hit: ${archivePath}`)
  }

  // Extract just the binary. bsdtar handles both .tar.gz and .zip on Win/macOS;
  // GNU tar on Linux handles .tar.gz (we don't ship .zip to Linux).
  const outDir = join(VENDOR_DIR, 'vendor', 'ripgrep', archPlat)
  mkdirSync(outDir, { recursive: true })
  // Extract to a temp dir, then move the one binary we need.
  const extractDir = join(cacheDir, `extract-${archPlat}`)
  if (existsSync(extractDir)) rmSync(extractDir, { recursive: true, force: true })
  mkdirSync(extractDir, { recursive: true })
  const tarExe = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'tar'
  execFileSync(tarExe, ['-xf', archivePath, '-C', extractDir], { stdio: 'pipe' })

  // The archive extracts to a subdir named like the archive (sans extension).
  // Find the rg/rg.exe inside it.
  const found = findBinary(extractDir, bin)
  if (!found) throw new Error(`${bin} not found inside extracted ripgrep archive`)
  const outBin = join(outDir, bin)
  writeFileSync(outBin, readFileSync(found))
  if (process.platform !== 'win32') {
    // Preserve executable bit
    execFileSync('chmod', ['+x', outBin])
  }
  log(`wrote ${outBin}`)

  // Clean up extract dir; keep archive in cache for next time.
  rmSync(extractDir, { recursive: true, force: true })
}

function findBinary(dir, name) {
  const { readdirSync, statSync } = require('node:fs')
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    for (const entry of readdirSync(cur)) {
      const p = join(cur, entry)
      const st = statSync(p)
      if (st.isDirectory()) stack.push(p)
      else if (entry === name) return p
    }
  }
  return null
}

main().catch((err) => {
  console.error(`\n[extract-cli] FAIL: ${err.message}`)
  if (err.stack) console.error(err.stack)
  process.exit(1)
})

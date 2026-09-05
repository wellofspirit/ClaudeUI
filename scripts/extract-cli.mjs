#!/usr/bin/env node
/**
 * Download the official @anthropic-ai/claude-code Bun standalone binary and
 * extract every JS chunk from its `.bun` section into one patchable file.
 *
 * Since Claude Code 2.1.261 (Bun 1.4.1) the standalone module graph is no
 * longer one monolithic wrapped-CJS `cli` module — it is ~1,800 modules, of
 * which ~1,630 are minified **ESM chunks** (`B:/~BUN/root/chunk-*.js`, plus the
 * `B:/~BUN/root/cli` entry and a couple of worker scripts). JS modules are
 * identified by their loader byte (`loader == 1`).
 *
 * Output:
 *   - `vendor/claude-cli/cli.js` — the concatenation of every JS chunk in
 *     module-table order, each preceded by a delimiter line:
 *
 *         // @bun-chunk B:/~BUN/root/chunk-w7xy78n9.js
 *         <chunk contents, byte-verbatim, always ends with \n>
 *         // @bun-chunk B:/~BUN/root/cli
 *         <chunk contents>
 *
 *     `patch/apply-all.mjs` text-patches this file; `scripts/rebundle-cli.mjs`
 *     splits it back apart on the delimiters and re-injects each chunk into its
 *     own module-table slot. Every chunk's bytes are pure ASCII and end with a
 *     newline, so delimiters always start at column 0 (validated below).
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
 *   3. Parse Bun's standalone trailer, walk the modules table, concatenate
 *      every loader==1 module and extract every `.node` addon verbatim.
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
 *   node scripts/extract-cli.mjs --quiet      # suppress info logs (errors still shown)
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
/** Loader byte for JavaScript modules in Bun's standalone module table. */
const LOADER_JS = 1
/** Encoding byte for latin1 text (0 = binary). */
const ENCODING_LATIN1 = 1
/** Delimiter that separates chunks in the concatenated patch target. */
const DELIM_PREFIX = Buffer.from('// @bun-chunk ', 'latin1')
const NEWLINE = Buffer.from('\n', 'latin1')
/** A delimiter line anywhere but column 0 of the file, i.e. a collision. */
const DELIM_INLINE = Buffer.concat([NEWLINE, DELIM_PREFIX])

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
  const out = { version: defaultVersion, binaryPath: null, force: false, quiet: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--binary') out.binaryPath = argv[++i]
    else if (a === '--force') out.force = true
    else if (a === '--quiet') out.quiet = true
    else if (!a.startsWith('--')) out.version = a
  }
  return out
}

const QUIET = process.argv.includes('--quiet')

function log(...args) {
  if (!QUIET) console.log('[extract-cli]', ...args)
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
    let done = false
    const settleReject = (err) => {
      if (done) return
      done = true
      reject(err)
    }
    const req = httpsGet(url, { headers: UA }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        if (redirects > 5) return settleReject(new Error('too many redirects'))
        res.resume() // drain the redirect body so the socket can close
        done = true
        return resolve(fetchBinary(res.headers.location, outPath, redirects + 1))
      }
      if (res.statusCode !== 200) {
        res.resume()
        return settleReject(new Error(`GET ${url} → ${res.statusCode}`))
      }
      const total = parseInt(res.headers['content-length'] || '0', 10)
      let seen = 0
      const ws = createWriteStream(outPath)
      const bail = (err) => {
        req.destroy()
        ws.destroy()
        settleReject(err)
      }
      res.on('data', (chunk) => {
        seen += chunk.length
        if (!QUIET && total) process.stdout.write(`\r  downloaded ${mb(seen)}/${mb(total)}…  `)
      })
      // pipe() does NOT forward source-stream errors — a mid-body connection
      // reset would otherwise leave the promise pending and hang the build.
      res.on('error', bail)
      ws.on('error', bail)
      res.pipe(ws)
      ws.on('finish', () => {
        done = true
        if (!QUIET) process.stdout.write('\n')
        ws.close(resolve)
      })
    })
    req.on('error', settleReject)
    // Guard against a stalled body (reset with no FIN): abort if the socket is
    // idle for 60s rather than blocking the build indefinitely.
    req.setTimeout(60_000, () => {
      if (done) return
      req.destroy(new Error(`download stalled (no data for 60s): ${url}`))
    })
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
  const isMovingTag = version === 'latest' || version === 'stable'
  const { key, binName } = detectPlatform()
  const cachedBinPath = (v) =>
    join(
      ROOT,
      '.cache',
      'claude-cli',
      `claude-${v}-${key}${binName.endsWith('.exe') ? '.exe' : ''}`
    )

  // Offline cache short-circuit (pinned versions only). Previously resolveBinary
  // always fetched manifest.json to learn the expected checksum, so every
  // ensure-cli (thus every `bun install`/build) hard-required downloads.claude.ai
  // even on a full cache hit. If we already verified a cached binary, we record
  // that checksum in a sibling `.sha256` sidecar; a subsequent run that still
  // matches it can be trusted without any network. Fail-safe: any mismatch (or a
  // missing/stale sidecar) simply falls through to the normal verified-download
  // path below. Moving tags must still resolve remotely.
  if (!isMovingTag && !arg.force) {
    const binPath = cachedBinPath(version)
    const sidecar = `${binPath}.sha256`
    if (existsSync(binPath) && existsSync(sidecar)) {
      const expected = readFileSync(sidecar, 'utf8').trim()
      if (expected && sha256File(binPath) === expected) {
        log(`cache hit (offline, sidecar-verified sha256): ${binPath}`)
        return { binPath, version }
      }
    }
  }

  if (isMovingTag) {
    version = (await fetchText(`${DL_BASE}/${version}`)).trim()
  }
  log(`upstream version: ${version}`)

  const manifest = JSON.parse(await fetchText(`${DL_BASE}/${version}/manifest.json`))
  const entry = manifest.platforms[key]
  if (!entry) {
    throw new Error(
      `Platform ${key} not in manifest for ${version}. Available: ${Object.keys(manifest.platforms).join(', ')}`
    )
  }

  const cacheDir = join(ROOT, '.cache', 'claude-cli')
  mkdirSync(cacheDir, { recursive: true })
  const binPath = cachedBinPath(version)
  const sidecar = `${binPath}.sha256`

  if (existsSync(binPath) && !arg.force) {
    const have = sha256File(binPath)
    if (have === entry.checksum) {
      log(`cache hit: ${binPath}`)
      writeFileSync(sidecar, `${entry.checksum}\n`) // enable future offline hits
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
  writeFileSync(sidecar, `${entry.checksum}\n`) // enable future offline hits
  return { binPath, version }
}

// ---------------------------------------------------------------------------
// Chunk extractor — walks the PE `.bun` section (or the whole file for
// overlay containers), reads the trailer's modules table, and returns every
// JS chunk plus every `.node` addon.
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
 * Guard the invariants the concat patch-target format depends on. Any
 * violation means upstream changed how it packages JS and the concat/split
 * round-trip is no longer lossless — fail the build rather than ship a
 * silently-corrupted binary.
 *
 * @param {string} name    module name from the table
 * @param {Buffer} bytes   module contents
 * @param {number} encoding encoding byte from the table
 */
function validateJsChunk(name, bytes, encoding) {
  const fail = (why) => {
    throw new Error(
      `JS chunk "${name}" ${why}.\n` +
        '  The vendor/claude-cli/cli.js concat format requires every loader==1 module to be\n' +
        '  non-empty, newline-terminated, pure-ASCII, latin1-encoded text with no embedded\n' +
        '  "// @bun-chunk " delimiter line. Upstream packaging changed — re-verify\n' +
        "  scripts/extract-cli.mjs + scripts/rebundle-cli.mjs against Bun's\n" +
        '  StandaloneModuleGraph before shipping.'
    )
  }
  if (name.length === 0) fail('has an empty module name')
  if (name.includes('\n')) fail('has a newline in its module name')
  if (bytes.length === 0) fail('has empty contents')
  if (bytes[bytes.length - 1] !== 0x0a) fail('does not end with a newline')
  if (encoding !== ENCODING_LATIN1) fail(`has encoding byte ${encoding} (expected 1 = latin1)`)
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] >= 0x80) {
      fail(`contains non-ASCII byte 0x${bytes[i].toString(16)} at offset ${i}`)
    }
  }
  // Delimiter collision: a chunk that itself contains a line starting with the
  // delimiter would be split into two on the way back in. Impossible today
  // (the delimiter is our own invention), cheap to prove.
  if (bytes.includes(DELIM_INLINE) || bytes.subarray(0, DELIM_PREFIX.length).equals(DELIM_PREFIX)) {
    fail('contains a "// @bun-chunk " delimiter line of its own')
  }
}

/**
 * Extract every JS chunk and all `.node` native addons from a Bun standalone
 * binary. Walks the trailer at the end of the `.bun` section (PE) or the file
 * (overlay formats on mac/linux).
 */
function extractAssets(buf) {
  let blob
  if (buf.readUInt16LE(0) === 0x5a4d) {
    // Windows PE — `.bun` section holds [u64 blobLen][blob][padding]
    const rawOff = findBunSectionRawOff(buf)
    const blobLen = Number(buf.readBigUInt64LE(rawOff))
    blob = buf.subarray(rawOff + 8, rawOff + 8 + blobLen)
  } else {
    // Mach-O / ELF — blob sits at EOF or in a named section. `lastIndexOf`
    // on the full buffer + `byte_count` computation is format-agnostic for
    // reading (see Bun's StandaloneModuleGraph — Zig through 1.3, Rust from 1.4).
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

  const assets = { chunks: [], addons: [], moduleCount: n }
  const seen = new Set()
  for (let i = 0; i < n; i++) {
    const e = base + i * 52
    const nameOff = blob.readUInt32LE(e)
    const nameLen = blob.readUInt32LE(e + 4)
    const nameBytes = Buffer.from(
      blob.subarray(data_start + nameOff, data_start + nameOff + nameLen)
    )
    const name = nameBytes.toString('utf8')
    const cOff = blob.readUInt32LE(e + 8)
    const cLen = blob.readUInt32LE(e + 12)
    const bytes = Buffer.from(blob.subarray(data_start + cOff, data_start + cOff + cLen))
    const encoding = blob.readUInt8(e + 48)
    const loader = blob.readUInt8(e + 49)

    if (loader === LOADER_JS) {
      validateJsChunk(name, bytes, encoding)
      // Names key the split on the rebundle side, so duplicates would make the
      // round-trip ambiguous.
      if (seen.has(name)) throw new Error(`duplicate JS module name in modules table: "${name}"`)
      seen.add(name)
      assets.chunks.push({ name, nameBytes, bytes })
    } else if (name.endsWith('.node')) {
      const leaf = name.split(/[\\/]/).pop()
      const addonName = leaf.replace(/\.node$/, '')
      assets.addons.push({ name, addonName, bytes })
    }
  }
  if (assets.chunks.length === 0) {
    throw new Error(
      `no JS modules (loader==${LOADER_JS}) found in the ${n}-entry modules table — ` +
        'the standalone format changed; see scripts/extract-cli.mjs header'
    )
  }
  return assets
}

/**
 * Concatenate the chunks into the patch target. Delimiter line is
 * `// @bun-chunk <exact module name>\n`; chunk bytes follow verbatim and
 * always end with `\n`, so the next delimiter starts at column 0.
 */
function buildConcat(chunks) {
  const parts = []
  for (const c of chunks) parts.push(DELIM_PREFIX, c.nameBytes, NEWLINE, c.bytes)
  return Buffer.concat(parts)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const { binPath, version } = await resolveBinary(args)

  log(`reading ${binPath}`)
  const buf = readFileSync(binPath)
  const { chunks, addons, moduleCount } = extractAssets(buf)
  const concat = buildConcat(chunks)
  // Named (non `chunk-*`) modules are the entry + workers — worth naming in the
  // log since a rename there is exactly what broke extraction on past bumps.
  const named = chunks.filter((c) => !/\/chunk-[^/]*$/.test(c.name)).map((c) => c.name)
  log(
    `extracted ${chunks.length} JS chunks of ${moduleCount} modules → ` +
      `${concat.length.toLocaleString()} bytes; named modules: ` +
      (named.slice(0, 8).join(', ') + (named.length > 8 ? `, … (${named.length})` : ''))
  )

  // Wipe the vendor dir so stale artifacts (previous versions' chunk set,
  // stale addon copies, vendored ripgrep) don't leak into the build. Safe —
  // rebundle + addon writes below regenerate what's needed.
  if (existsSync(VENDOR_DIR)) rmSync(VENDOR_DIR, { recursive: true, force: true })
  mkdirSync(VENDOR_DIR, { recursive: true })
  writeFileSync(OUT_CLI, concat)
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
        cliSize: concat.length,
        cliSha256: createHash('sha256').update(concat).digest('hex'),
        form: 'chunked',
        chunkCount: chunks.length
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

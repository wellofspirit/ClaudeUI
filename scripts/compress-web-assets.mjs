#!/usr/bin/env node
/**
 * compress-web-assets.mjs
 *
 * Writes `.br` + `.gz` siblings next to the built remote web client's text
 * assets, so `RemoteServer.serveStatic` can hand a precompressed file straight
 * to a phone instead of ~2.4 MB of raw JS on every visit.
 *
 * Compression happens at build time, not per request: the assets are immutable
 * (vite content-hashes them) and brotli quality 11 costs seconds — far too much
 * to pay on a GET, and pointless to repeat for a file that never changes.
 *
 * Only text-ish extensions are eligible; fonts and images are already
 * compressed, and `index.html` is served by a different handler
 * (`serveWebClient`) that reads it directly. A sibling is kept only when it
 * actually pays for itself (≤ 90 % of the original), so tiny or
 * high-entropy files don't gain a useless extra file.
 *
 * Zero dependencies and pure Node path handling — this runs in `build:win` CI
 * under Git Bash, where shell globs and drive letters both misbehave.
 *
 * Usage:
 *   node scripts/compress-web-assets.mjs                # compress out/web
 *   node scripts/compress-web-assets.mjs --dir out/web2  # another directory
 *   node scripts/compress-web-assets.mjs --quiet         # silent on success
 */

import { brotliCompressSync, gzipSync, constants } from 'node:zlib'
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

const argv = process.argv.slice(2)
const QUIET = argv.includes('--quiet')
const dirArgIndex = argv.indexOf('--dir')
// Resolve against the repo root, not cwd, so the script works from anywhere.
const TARGET_DIR =
  dirArgIndex !== -1 && argv[dirArgIndex + 1]
    ? resolve(ROOT, argv[dirArgIndex + 1])
    : join(ROOT, 'out', 'web')

/** Extensions worth compressing. `.html` is served by another handler. */
const COMPRESSIBLE = new Set(['.js', '.css', '.svg', '.json'])
/** Below this, framing + an extra request-time stat cost more than the saving. */
const MIN_SIZE = 1024
/** Keep a sibling only if it is at most this fraction of the original. */
const MAX_RATIO = 0.9

/** Info-level log — suppressed by --quiet. */
function info(...args) {
  if (!QUIET) console.log(...args)
}

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.isFile()) out.push(full)
  }
  return out
}

/**
 * Write `<file><suffix>` if the encoded form is a real win and return its size;
 * otherwise return null, having removed any stale sibling from an earlier build
 * so it cannot be served as fresh content.
 */
function writeSibling(filePath, suffix, encoded, rawSize) {
  const siblingPath = filePath + suffix
  if (encoded.length > rawSize * MAX_RATIO) {
    if (existsSync(siblingPath)) rmSync(siblingPath)
    return null
  }
  writeFileSync(siblingPath, encoded)
  return encoded.length
}

function main() {
  if (!existsSync(TARGET_DIR)) {
    console.error(`[compress-web-assets] directory not found: ${TARGET_DIR}`)
    process.exit(1)
  }

  /**
   * dir (relative to TARGET_DIR) → totals. `br` is what a brotli-capable client
   * downloads, i.e. the sibling size when one was kept and the raw size when it
   * wasn't — so the summary reads as a real before/after.
   */
  const perDir = new Map()

  for (const filePath of walk(TARGET_DIR)) {
    // Never compress our own output (a `.js.br` has extname `.br` anyway, but
    // be explicit — a stale `.gz.br` would be served as a broken asset).
    if (filePath.endsWith('.br') || filePath.endsWith('.gz')) continue
    if (!COMPRESSIBLE.has(extname(filePath).toLowerCase())) continue

    const rawSize = statSync(filePath).size
    if (rawSize < MIN_SIZE) continue

    const buf = readFileSync(filePath)
    const br = brotliCompressSync(buf, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
        [constants.BROTLI_PARAM_SIZE_HINT]: buf.length
      }
    })
    const gz = gzipSync(buf, { level: 9 })

    const brSize = writeSibling(filePath, '.br', br, rawSize)
    writeSibling(filePath, '.gz', gz, rawSize)

    const key = relative(TARGET_DIR, dirname(filePath)) || '.'
    const acc = perDir.get(key) ?? { files: 0, raw: 0, br: 0 }
    acc.files += 1
    acc.raw += rawSize
    acc.br += brSize ?? rawSize
    perDir.set(key, acc)
  }

  const kb = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} kB`)
  let totals = { files: 0, raw: 0, br: 0 }
  for (const [dir, acc] of [...perDir].sort(([a], [b]) => a.localeCompare(b))) {
    info(`[compress-web-assets] ${dir}: ${acc.files} files, ${kb(acc.raw)} → ${kb(acc.br)} br`)
    totals = { files: totals.files + acc.files, raw: totals.raw + acc.raw, br: totals.br + acc.br }
  }
  if (perDir.size === 0) info('[compress-web-assets] nothing to compress')
  else if (perDir.size > 1)
    info(
      `[compress-web-assets] total: ${totals.files} files, ${kb(totals.raw)} → ${kb(totals.br)} br`
    )
}

main()

/**
 * compress-web-assets.mjs
 *
 * Writes `.br` + `.gz` siblings next to the built UI's text assets, so
 * `RemoteServer.serveStatic` can hand a precompressed file straight to a phone
 * instead of ~2.4 MB of raw JS on every visit.
 *
 * Compression happens at build time, not per request: the assets are immutable
 * (vite content-hashes them) and brotli quality 11 costs seconds — far too much
 * to pay on a GET, and pointless to repeat for a file that never changes.
 *
 * The renderer build runs this itself (`compressDir` from a plugin in
 * `electron.vite.config.ts`), so every path that builds the UI — `bun run
 * build`, a bare `electron-vite build` in CI, packaging — produces the siblings.
 * Only `out/renderer/assets` is compressed.
 *
 * Only text-ish extensions are eligible; fonts and images are already
 * compressed, and `web.html` is served by a different handler
 * (`serveWebClient`) that reads it directly. A sibling is kept only when it
 * actually pays for itself (≤ 90 % of the original), so tiny or
 * high-entropy files don't gain a useless extra file.
 *
 * Zero dependencies and pure Node path handling — this runs in `build:win` CI
 * under Git Bash, where shell globs and drive letters both misbehave.
 *
 * Usage:
 *   node scripts/compress-web-assets.mjs                # compress out/renderer/assets
 *   node scripts/compress-web-assets.mjs --dir out/other # another directory
 *   node scripts/compress-web-assets.mjs --quiet         # silent on success
 */

import { brotliCompress, gzip, constants } from 'node:zlib'
import { promisify } from 'node:util'
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const brotliAsync = promisify(brotliCompress)
const gzipAsync = promisify(gzip)

/** Extensions worth compressing. `.html` is served by another handler. */
const COMPRESSIBLE = new Set(['.js', '.css', '.svg', '.json'])
/** Below this, framing + an extra request-time stat cost more than the saving. */
const MIN_SIZE = 1024
/** Keep a sibling only if it is at most this fraction of the original. */
const MAX_RATIO = 0.9

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

/**
 * Compress one file. The async zlib calls run on libuv's thread pool, so files
 * compress in parallel. Brotli 11 over ~65 files was ~6 s on one core, and is
 * now bounded by the largest bundle (~2 s).
 */
async function compressFile(filePath) {
  const buf = readFileSync(filePath)
  const [br, gz] = await Promise.all([
    brotliAsync(buf, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
        [constants.BROTLI_PARAM_SIZE_HINT]: buf.length
      }
    }),
    gzipAsync(buf, { level: 9 })
  ])
  const brSize = writeSibling(filePath, '.br', br, buf.length)
  writeSibling(filePath, '.gz', gz, buf.length)
  return { filePath, rawSize: buf.length, brSize }
}

/**
 * Compress every eligible file under `dir`. Throws when `dir` does not exist,
 * so a build that produced no assets fails loudly instead of shipping raw JS.
 */
export async function compressDir(dir, { quiet = false } = {}) {
  if (!existsSync(dir)) {
    throw new Error(`[compress-web-assets] directory not found: ${dir}`)
  }
  const info = (...args) => {
    if (!quiet) console.log(...args)
  }

  /**
   * dir (relative to `dir`) → totals. `br` is what a brotli-capable client
   * downloads, i.e. the sibling size when one was kept and the raw size when it
   * wasn't — so the summary reads as a real before/after.
   */
  const perDir = new Map()

  const eligible = walk(dir).filter(
    (filePath) =>
      // Never compress our own output (a `.js.br` has extname `.br` anyway, but
      // be explicit — a stale `.gz.br` would be served as a broken asset).
      !filePath.endsWith('.br') &&
      !filePath.endsWith('.gz') &&
      COMPRESSIBLE.has(extname(filePath).toLowerCase()) &&
      statSync(filePath).size >= MIN_SIZE
  )

  for (const { filePath, rawSize, brSize } of await Promise.all(eligible.map(compressFile))) {
    const key = relative(dir, dirname(filePath)) || '.'
    const acc = perDir.get(key) ?? { files: 0, raw: 0, br: 0 }
    acc.files += 1
    acc.raw += rawSize
    acc.br += brSize ?? rawSize
    perDir.set(key, acc)
  }

  const kb = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} kB`)
  let totals = { files: 0, raw: 0, br: 0 }
  for (const [sub, acc] of [...perDir].sort(([a], [b]) => a.localeCompare(b))) {
    info(`[compress-web-assets] ${sub}: ${acc.files} files, ${kb(acc.raw)} → ${kb(acc.br)} br`)
    totals = { files: totals.files + acc.files, raw: totals.raw + acc.raw, br: totals.br + acc.br }
  }
  if (perDir.size === 0) info('[compress-web-assets] nothing to compress')
  else if (perDir.size > 1)
    info(
      `[compress-web-assets] total: ${totals.files} files, ${kb(totals.raw)} → ${kb(totals.br)} br`
    )
}

// CLI entry. `import.meta.url` equals the entry script's URL only when this
// file is run directly, not when `electron.vite.config.ts` imports it. No
// top-level await: the config is bundled by esbuild, which may emit CJS.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2)
  const dirArgIndex = argv.indexOf('--dir')
  // Resolve against the repo root, not cwd, so the script works from anywhere.
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const target =
    dirArgIndex !== -1 && argv[dirArgIndex + 1]
      ? resolve(root, argv[dirArgIndex + 1])
      : join(root, 'out', 'renderer', 'assets')
  compressDir(target, { quiet: argv.includes('--quiet') }).catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}

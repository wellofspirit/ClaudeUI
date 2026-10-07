#!/usr/bin/env node
/**
 * decode-stack.mjs
 *
 * Rewrites the frames of a minified stack trace back to original source
 * positions, using the linked source maps the renderer build emits next to its
 * chunks (`out/renderer/assets/<chunk>.js.map`).
 *
 * Chromium never applies source maps to `Error.stack` (only DevTools does), so
 * stacks that reach logs stay minified. The maps are linked and ship with the
 * build: a packaged app keeps them inside `resources/app.asar` under
 * `out/renderer/assets` (extract with `@electron/asar`, e.g.
 * `bunx @electron/asar extract-file resources/app.asar out/renderer/assets/<chunk>.js.map`,
 * or extract the whole archive), and `RemoteServer` serves them under `/assets/`.
 * Point `--dir` at any directory holding them — the maps are looked up by chunk
 * file name only, so the layout does not matter.
 *
 * A frame is any `…/assets/<chunk>.js:<line>:<col>` — a `file://` URL, an http
 * URL or a bare Windows/POSIX path alike. The location is replaced with
 * `<original path>:<line>:<col>` (plus ` [name]` when the map knows the
 * original identifier). Every other line, and every frame whose map is
 * missing, passes through unchanged.
 *
 * Zero dependencies: `node:module`'s `SourceMap`. Stack traces are one-based in
 * both line and column; `findEntry` is zero-based in both, so the script
 * converts on the way in and out.
 *
 * Usage:
 *   node scripts/decode-stack.mjs trace.txt                  # a file
 *   pbpaste | node scripts/decode-stack.mjs                  # stdin
 *   node scripts/decode-stack.mjs trace.txt --dir ./maps     # maps from elsewhere
 *
 * `--dir` defaults to `out/renderer/assets` under the repo root.
 */

import { existsSync, readFileSync } from 'node:fs'
import { SourceMap } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const argv = process.argv.slice(2)
const dirArgIndex = argv.indexOf('--dir')
const dir = resolve(
  ROOT,
  dirArgIndex !== -1 && argv[dirArgIndex + 1] ? argv[dirArgIndex + 1] : 'out/renderer/assets'
)
const fileArg = argv.find(
  (a, i) => !a.startsWith('--') && (dirArgIndex === -1 || i !== dirArgIndex + 1)
)

/** `…/assets/<chunk>.js:<line>:<col>`; the prefix is any URL or path ending in `assets/`. */
const FRAME = /[^\s()]*?[\\/]assets[\\/]([\w.-]+\.js):(\d+):(\d+)/g

/** chunk file name → SourceMap, or null when its map is missing/unreadable. */
const maps = new Map()

function loadMap(chunk) {
  if (maps.has(chunk)) return maps.get(chunk)
  const mapPath = join(dir, `${chunk}.map`)
  let map = null
  if (existsSync(mapPath)) {
    try {
      map = new SourceMap(JSON.parse(readFileSync(mapPath, 'utf8')))
    } catch (err) {
      console.error(`[decode-stack] cannot read ${mapPath}: ${err.message}`)
    }
  } else {
    console.error(`[decode-stack] no source map for ${chunk} in ${dir}`)
  }
  maps.set(chunk, map)
  return map
}

/** Map sources are relative to the chunk (`../../../src/…`); keep the repo-relative tail. */
function tidy(source) {
  return source.replace(/^[a-z]+:\/\/\/?/i, '').replace(/^(\.\.[\\/])+/, '')
}

function decode(text) {
  return text.replace(FRAME, (frame, chunk, line, col) => {
    const entry = loadMap(chunk)?.findEntry(Number(line) - 1, Number(col) - 1)
    if (!entry || entry.originalSource === undefined) return frame
    const where = `${tidy(entry.originalSource)}:${entry.originalLine + 1}:${entry.originalColumn + 1}`
    return entry.name ? `${where} [${entry.name}]` : where
  })
}

const input = fileArg ? readFileSync(fileArg, 'utf8') : readFileSync(0, 'utf8')
process.stdout.write(decode(input))

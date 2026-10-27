#!/usr/bin/env node
/**
 * Apply every cli.js patch to the Windows, macOS and Linux bundles of Claude
 * Code, without touching `vendor/claude-cli` and without running anything.
 *
 *   node scripts/check-patches-cross-platform.mjs
 *   node scripts/check-patches-cross-platform.mjs --platforms win32-x64,darwin-arm64
 *   node scripts/check-patches-cross-platform.mjs --version 2.1.300   # default: the pinned one
 *   node scripts/check-patches-cross-platform.mjs --keep              # keep the scratch dirs
 *
 * Why: a bump is built on one host, but the chunk set (and so the minified
 * code the patches anchor on) differs per platform — macOS and Linux used to
 * be found broken only after merge, in CI. For each platform this runs the
 * real pipeline into a scratch dir (`CLAUDEUI_CLI_VENDOR_DIR`, see
 * scripts/lib/cli-paths.mjs):
 *
 *   extract-cli --platform <key>  →  patch/apply-all.mjs  →  rebundle-cli
 *
 * Rebundle on PE / Mach-O writes into the scratch dir; its per-chunk Node
 * syntax check of every patched chunk is the point. On ELF it prints its skip
 * line (no Linux rebundle yet), which counts as a pass. The produced binaries
 * are never executed. The official binaries are downloaded once into
 * `.cache/claude-cli/` and verified against the release manifest, like any
 * `ensure-cli`.
 *
 * Exit 1 when any step fails, or when a platform's `patches:` line differs
 * from the host platform's (a patch that applies on one platform but leaves no
 * marker on another is a no-op there, which is exactly what to catch).
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { CLI_PLATFORM_KEYS } from './lib/cli-paths.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_PLATFORMS = Object.freeze(['win32-x64', 'darwin-arm64', 'linux-x64'])
const ELF_SKIP_MARKER = 'ELF (Linux) rebundle not implemented'

export function parseCheckArgs(argv) {
  const args = { platforms: [...DEFAULT_PLATFORMS], version: null, keep: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--keep') args.keep = true
    else if (a === '--platforms' || a === '--version') {
      const v = argv[++i]
      if (!v || v.startsWith('--')) throw new Error(`${a} needs a value`)
      if (a === '--version') args.version = v
      else {
        const keys = [...new Set(v.split(',').map((k) => k.trim()))].filter(Boolean)
        const bad = keys.filter((k) => !CLI_PLATFORM_KEYS.includes(k))
        if (keys.length === 0 || bad.length > 0) {
          throw new Error(
            `--platforms: unknown ${bad.join(', ') || '(empty)'}; known: ${CLI_PLATFORM_KEYS.join(', ')}`
          )
        }
        args.platforms = keys
      }
    } else throw new Error(`unknown argument: ${a}`)
  }
  return args
}

/** The `patches:` line apply-all prints, as a list; null when there is none. */
export function parsePatchesLine(stdout) {
  const m = /^patches: ?(.*)$/m.exec(stdout)
  return m
    ? m[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : null
}

/**
 * Mark each result whose patch list differs from the reference platform's: the
 * host's when it was run, otherwise the first platform that produced a list.
 * Returns the reference key (or null when none produced one).
 */
export function comparePatches(results, hostKey) {
  const withList = results.filter((r) => r.patches)
  const ref = withList.find((r) => r.key === hostKey) ?? withList[0]
  if (!ref) return null
  for (const r of withList) {
    if (r.patches.join(',') !== ref.patches.join(',')) {
      r.failure ??= `patches differ from ${ref.key}: [${r.patches.join(', ')}] vs [${ref.patches.join(', ')}]`
    }
  }
  return ref.key
}

function runNode(script, scriptArgs, vendorDir) {
  const r = spawnSync(process.execPath, [join(ROOT, script), ...scriptArgs], {
    cwd: ROOT,
    env: { ...process.env, CLAUDEUI_CLI_VENDOR_DIR: vendorDir },
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true
  })
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error }
}

const tail = (text, n = 20) => text.trimEnd().split(/\r?\n/).slice(-n).join('\n')

/** One platform, start to finish. Never throws; the scratch dir is removed unless `keep`. */
export function checkPlatform(key, { version, keep }) {
  const scratch = mkdtempSync(join(tmpdir(), `claudeui-patchcheck-${key}-`))
  const result = {
    key,
    version: null,
    extract: '-',
    apply: '-',
    rebundle: '-',
    patches: null,
    failure: null,
    scratch: keep ? scratch : null
  }
  const step = (field, script, scriptArgs) => {
    const r = runNode(script, scriptArgs, scratch)
    if (r.code === 0) {
      result[field] = 'ok'
      return r
    }
    result[field] = 'FAIL'
    result.failure = `${script} exited ${r.code}\n${tail(`${r.stdout}\n${r.stderr}${r.error ?? ''}`)}`
    return null
  }
  try {
    const extracted = step('extract', 'scripts/extract-cli.mjs', [
      '--platform',
      key,
      ...(version ? [version] : []),
      '--quiet'
    ])
    if (!extracted) return result
    try {
      result.version = JSON.parse(readFileSync(join(scratch, 'version.json'), 'utf8')).version
    } catch {
      /* shown as "?" */
    }

    const applied = step('apply', 'patch/apply-all.mjs', ['--quiet'])
    if (!applied) return result
    result.patches = parsePatchesLine(applied.stdout)
    if (!result.patches) {
      result.apply = 'FAIL'
      result.failure = 'apply-all printed no "patches:" line'
      return result
    }

    const rebundled = step('rebundle', 'scripts/rebundle-cli.mjs', ['--quiet'])
    if (rebundled && rebundled.stdout.includes(ELF_SKIP_MARKER)) result.rebundle = 'skip (ELF)'
    return result
  } finally {
    if (!keep && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true })
  }
}

export function formatTable(results, refKey) {
  const rows = [
    ['platform', 'version', 'extract', 'apply', 'rebundle', 'patches'],
    ...results.map((r) => [
      r.key,
      r.version ?? '?',
      r.extract,
      r.apply,
      r.rebundle,
      r.patches ? r.patches.join(', ') || '(none)' : '-'
    ])
  ]
  const widths = rows[0].map((_, c) => Math.max(...rows.map((row) => row[c].length)))
  const lines = rows.map((row) =>
    row
      .map((cell, c) => cell.padEnd(widths[c]))
      .join('  ')
      .trimEnd()
  )
  lines.splice(1, 0, widths.map((w) => '-'.repeat(w)).join('  '))
  if (refKey) lines.push('', `patches compared against ${refKey}`)
  return lines.join('\n')
}

function main() {
  let args
  try {
    args = parseCheckArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`check-patches-cross-platform: ${err.message}`)
    process.exit(2)
  }

  const hostKey = `${process.platform}-${process.arch}`
  const results = []
  for (const key of args.platforms) {
    console.log(`[${results.length + 1}/${args.platforms.length}] ${key} ...`)
    results.push(checkPlatform(key, args))
  }
  const refKey = comparePatches(results, hostKey)

  console.log(`\n${formatTable(results, refKey)}`)
  const failed = results.filter((r) => r.failure)
  for (const r of failed) console.error(`\n${r.key}: ${r.failure}`)
  for (const r of results) if (r.scratch) console.log(`kept: ${r.key} -> ${r.scratch}`)

  if (failed.length > 0) {
    console.error(`\ncheck-patches-cross-platform: FAILED (${failed.map((r) => r.key).join(', ')})`)
    process.exitCode = 1
  } else {
    console.log('\ncheck-patches-cross-platform: ok')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()

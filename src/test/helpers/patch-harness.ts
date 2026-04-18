/**
 * Patch test harness — reusable helpers for anchor/idempotency tests.
 *
 * Behavioral tests live under `patch/<name>/test.mjs` and are invoked by
 * `patch/test-all.mjs` against a real SDK — gated on network + auth. This
 * harness focuses on the *static* checks that can run in Vitest CI without
 * the SDK:
 *   - the patch markers exist in cli.js (post-apply)
 *   - applying the patch a second time is a no-op (idempotent)
 *   - the anchor pattern from apply.mjs matches exactly once pre-patch
 *
 * These catch the two most common regressions when the SDK upgrades:
 *   1. Marker missing → patch silently didn't apply this release
 *   2. Anchor matches 0 or >1 times → apply.mjs needs a refactor
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'

export const CLI_JS_PATH = path.resolve(
  process.cwd(),
  'node_modules',
  '@anthropic-ai',
  'claude-agent-sdk',
  'cli.js',
)

export function readCliJs(): string {
  return fs.readFileSync(CLI_JS_PATH, 'utf-8')
}

export function cliJsExists(): boolean {
  try {
    fs.accessSync(CLI_JS_PATH)
    return true
  } catch {
    return false
  }
}

/**
 * Extract all `/*PATCHED:<name>*\/` markers from a source string.
 */
export function findMarkers(src: string): string[] {
  const re = /\/\*PATCHED:[\w-]+\*\//g
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    out.push(m[0])
  }
  return out
}

export function hasMarker(src: string, markerName: string): boolean {
  return src.includes(`/*PATCHED:${markerName}*/`)
}

export function countOccurrences(src: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let i = 0
  while ((i = src.indexOf(needle, i)) !== -1) {
    count++
    i += needle.length
  }
  return count
}

export function countRegex(src: string, pattern: RegExp): number {
  const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g'
  const re = new RegExp(pattern.source, flags)
  return (src.match(re) ?? []).length
}

/**
 * Apply a patch (by running its apply.mjs) against a temp copy of cli.js.
 * Returns the pre-patch src, post-patch src, and the temp dir path.
 *
 * Callers should assert idempotency by running this twice and comparing
 * post-patch src byte-for-byte.
 */
export function applyPatchOnCopy(patchDir: string): {
  pre: string
  post: string
  postAgain: string
} {
  const sdkDir = path.dirname(CLI_JS_PATH)
  const backup = fs.readFileSync(CLI_JS_PATH, 'utf-8')
  const applyJs = path.resolve(patchDir, 'apply.mjs')
  if (!fs.existsSync(applyJs)) {
    throw new Error(`apply.mjs not found at ${applyJs}`)
  }

  try {
    // Run apply.mjs against the real cli.js — it edits in place.
    execFileSync('node', [applyJs], { stdio: 'pipe', cwd: path.resolve(sdkDir, '..', '..', '..') })
    const post = fs.readFileSync(CLI_JS_PATH, 'utf-8')
    execFileSync('node', [applyJs], { stdio: 'pipe', cwd: path.resolve(sdkDir, '..', '..', '..') })
    const postAgain = fs.readFileSync(CLI_JS_PATH, 'utf-8')
    return { pre: backup, post, postAgain }
  } finally {
    // Always restore original
    fs.writeFileSync(CLI_JS_PATH, backup, 'utf-8')
  }
}

/**
 * What the Claude Code binary we spawn is: its version and which of our cli.js
 * patches it carries.
 *
 * Chat works on any Claude Code binary. A surface that exists only because of a
 * patch (voice today) must go dark when the binary lacks that patch, rather than
 * offer a control that fails (ADR-030). This module is the one place that
 * answers "does the harness have patch X".
 *
 * Source: `version.json` beside the binary. `scripts/extract-cli.mjs` writes
 * `version`; `patch/apply-all.mjs` merges `patches`, the patches whose markers
 * it found in the patched cli.js bytes (docs/protocol-cc/01-transport.md
 * §1.12). Anthropic's own binary ships no version.json, so it reads as
 * version `'unknown'` with no patches, which is what it is to us.
 *
 * Electron-free, like everything in core.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { locateBunClaude } from './locate'

export interface HarnessInfo {
  /** Upstream Claude Code version, or `'unknown'`. */
  readonly version: string
  /** Names of the patches the binary carries (`patch/lib/patch-registry.mjs`). */
  readonly patches: ReadonlySet<string>
}

const UNKNOWN: HarnessInfo = Object.freeze({
  version: 'unknown',
  patches: new Set<string>()
})

/** Parsed version.json per path, re-read when the file's mtime moves. */
const cache = new Map<string, { mtimeMs: number; info: HarnessInfo }>()

function parse(text: string): HarnessInfo {
  let meta: unknown
  try {
    meta = JSON.parse(text)
  } catch {
    return UNKNOWN
  }
  if (meta === null || typeof meta !== 'object') return UNKNOWN
  const { version, patches } = meta as { version?: unknown; patches?: unknown }
  return {
    version: typeof version === 'string' && version !== '' ? version : 'unknown',
    patches: new Set(
      Array.isArray(patches) ? patches.filter((p): p is string => typeof p === 'string') : []
    )
  }
}

/**
 * Read the `version.json` that sits beside `binaryPath`. A missing or
 * unreadable file, malformed JSON, or a missing field reads as version
 * `'unknown'` and no patches: when in doubt, the harness is unpatched.
 */
export function readHarnessInfo(binaryPath: string): HarnessInfo {
  const versionPath = path.join(path.dirname(binaryPath), 'version.json')
  let mtimeMs: number
  try {
    mtimeMs = fs.statSync(versionPath).mtimeMs
  } catch {
    cache.delete(versionPath)
    return UNKNOWN
  }
  const hit = cache.get(versionPath)
  if (hit && hit.mtimeMs === mtimeMs) return hit.info

  let info: HarnessInfo
  try {
    info = parse(fs.readFileSync(versionPath, 'utf-8'))
  } catch {
    info = UNKNOWN
  }
  cache.set(versionPath, { mtimeMs, info })
  return info
}

/** Does the binary the app spawns (`locateBunClaude()`) carry patch `name`? */
export function harnessHasPatch(name: string): boolean {
  return readHarnessInfo(locateBunClaude()).patches.has(name)
}

/** The spawned binary's Claude Code version, or `'unknown'`. */
export function getCliVersion(): string {
  return readHarnessInfo(locateBunClaude()).version
}

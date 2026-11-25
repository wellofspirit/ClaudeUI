/**
 * Is a directory a ClaudeUI checkout? One rule for the desktop's rebuild tree
 * list (`src/main/services/rebuild/trees.ts`) and the admin setter of the
 * rebuild source (`app-update:set-source`): a `package.json` named `claudui`
 * and a `scripts/build.mjs`. Reads two files, never runs anything.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

/** The package name a ClaudeUI checkout carries (package.json). */
export const CLAUDEUI_PACKAGE_NAME = 'claudui'

/** A ClaudeUI checkout: `package.json` named `claudui` and `scripts/build.mjs` present. */
export function isClaudeUiCheckout(dir: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
      name?: unknown
    }
    if (pkg.name !== CLAUDEUI_PACKAGE_NAME) return false
    return fs.statSync(path.join(dir, 'scripts', 'build.mjs')).isFile()
  } catch {
    return false
  }
}

export type SourcePathCheck = { ok: true; path: string } | { ok: false; reason: string }

/**
 * A rebuild source a client typed: an absolute path to a ClaudeUI checkout,
 * resolved. The reasons name no path (the caller already knows it).
 */
export function checkSourcePath(
  raw: string,
  isCheckout: (dir: string) => boolean = isClaudeUiCheckout
): SourcePathCheck {
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: false, reason: 'Enter the folder of a ClaudeUI checkout' }
  if (!path.isAbsolute(trimmed)) return { ok: false, reason: 'The path must be absolute' }
  const resolved = path.resolve(trimmed)
  if (!isCheckout(resolved))
    return {
      ok: false,
      reason:
        'Not a ClaudeUI checkout: it needs a package.json named "claudui" and scripts/build.mjs'
    }
  return { ok: true, path: resolved }
}

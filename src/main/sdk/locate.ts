/**
 * Resolve the rebundled Bun standalone binary path in both dev and production.
 *
 *   dev        → <projectRoot>/vendor/claude-cli/bun-claude[.exe]
 *   production → <Resources>/claude-cli/bun-claude[.exe]  (primary, extraResources)
 *                <app.asar.unpacked>/vendor/claude-cli/bun-claude[.exe]  (fallback)
 *
 * The binary is produced by `scripts/rebundle-cli.mjs` and contains our
 * patched cli.js embedded in Anthropic's Bun runtime — no Electron-as-Node
 * shim required. electron-builder copies vendor/claude-cli → extraResources
 * at build time.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { app } from 'electron'

const BIN_NAME = process.platform === 'win32' ? 'bun-claude.exe' : 'bun-claude'

/** Resolve the path to the rebundled Bun standalone binary. */
export function locateBunClaude(): string {
  const appPath = app.getAppPath()

  if (!appPath.includes('app.asar')) {
    // Dev — appPath is the project root.
    return path.join(appPath, 'vendor', 'claude-cli', BIN_NAME)
  }

  // Production — extraResources copies vendor/claude-cli → <Resources>/claude-cli.
  // path.dirname(appPath) is the Resources directory (where app.asar lives).
  const candidates = [
    path.join(path.dirname(appPath), 'claude-cli', BIN_NAME),
    path.join(
      appPath.replace('app.asar', 'app.asar.unpacked'),
      'vendor',
      'claude-cli',
      BIN_NAME,
    ),
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  // Return primary candidate anyway — caller surfaces the missing-file error.
  return candidates[0]
}

/** @deprecated Use {@link locateBunClaude}. Kept for callers mid-migration. */
export function locateCliJs(): string {
  return locateBunClaude()
}

/** Read the vendored CLI version string (or "unknown" on any failure). */
export function getCliVersion(): string {
  try {
    const bin = locateBunClaude()
    const versionPath = path.join(path.dirname(bin), 'version.json')
    const v = JSON.parse(fs.readFileSync(versionPath, 'utf-8'))
    return typeof v.version === 'string' ? v.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

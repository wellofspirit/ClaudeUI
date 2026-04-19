/**
 * Resolve the vendored cli.js path in both dev and production Electron.
 *
 *   dev           → <projectRoot>/vendor/claude-cli/cli.js
 *   production    → <app.asar.unpacked>/vendor/claude-cli/cli.js (primary)
 *                   <resources>/claude-cli/cli.js                 (fallback)
 *
 * The electron-builder config copies vendor/claude-cli → extraResources and
 * also asar-unpacks it, mirroring the old SDK layout.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { app } from 'electron'

export function locateCliJs(): string {
  const appPath = app.getAppPath()

  if (!appPath.includes('app.asar')) {
    // Dev mode — appPath is the project root.
    return path.join(appPath, 'vendor', 'claude-cli', 'cli.js')
  }

  // Production — extraResources copies vendor/claude-cli → <Resources>/claude-cli.
  // path.dirname(appPath) is the Resources directory (where app.asar lives).
  const candidates = [
    path.join(path.dirname(appPath), 'claude-cli', 'cli.js'),
    // Fallback: if asarUnpack is ever re-enabled for vendor/
    path.join(
      appPath.replace('app.asar', 'app.asar.unpacked'),
      'vendor',
      'claude-cli',
      'cli.js',
    ),
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  // Return the primary candidate anyway — caller handles missing-file error.
  return candidates[0]
}

/** Read the vendored CLI version string (or "unknown" on any failure). */
export function getCliVersion(): string {
  try {
    const cliJs = locateCliJs()
    const versionPath = path.join(path.dirname(cliJs), 'version.json')
    const v = JSON.parse(fs.readFileSync(versionPath, 'utf-8'))
    return typeof v.version === 'string' ? v.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

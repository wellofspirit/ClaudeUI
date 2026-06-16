/**
 * Resolve the vendored Codex CLI binary path in both dev and production.
 *
 *   dev        → <projectRoot>/vendor/codex-cli/codex[.exe]
 *   production → <Resources>/codex-cli/codex[.exe]  (primary, extraResources)
 *                <app.asar.unpacked>/vendor/codex-cli/codex[.exe]  (fallback)
 *
 * The binary is downloaded from npm by `scripts/ensure-codex.mjs` and placed
 * under vendor/codex-cli/. electron-builder copies vendor/codex-cli →
 * extraResources at build time. Mirrors src/main/sdk/locate.ts for claude-cli.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { app } from 'electron'

const BIN_NAME = process.platform === 'win32' ? 'codex.exe' : 'codex'

/** Resolve the path to the vendored Codex CLI binary. */
export function locateCodex(): string {
  // Outside Electron (vitest integration project, harness scripts) `app` is
  // undefined — fall back to cwd, which is the project root in those contexts.
  const appPath = app?.getAppPath ? app.getAppPath() : process.cwd()

  if (!appPath.includes('app.asar')) {
    // Dev — appPath is the project root.
    return path.join(appPath, 'vendor', 'codex-cli', BIN_NAME)
  }

  // Production — extraResources copies vendor/codex-cli → <Resources>/codex-cli.
  // path.dirname(appPath) is the Resources directory (where app.asar lives).
  const candidates = [
    path.join(path.dirname(appPath), 'codex-cli', BIN_NAME),
    path.join(
      appPath.replace('app.asar', 'app.asar.unpacked'),
      'vendor',
      'codex-cli',
      BIN_NAME
    )
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  // Return primary candidate anyway — caller surfaces the missing-file error.
  return candidates[0]
}

/** Read the vendored Codex CLI version string (or "unknown" on any failure). */
export function getCodexVersion(): string {
  try {
    const bin = locateCodex()
    const versionPath = path.join(path.dirname(bin), 'version.json')
    const v = JSON.parse(fs.readFileSync(versionPath, 'utf-8'))
    return typeof v.version === 'string' ? v.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Resolve the vendored pi binary path in both dev and production.
 *
 *   dev        → <projectRoot>/vendor/pi-cli/pi[.exe]
 *   production → <Resources>/pi-cli/pi[.exe]                      (primary, extraResources)
 *                <app.asar.unpacked>/vendor/pi-cli/pi[.exe]        (fallback)
 *
 * Mirrors `OpencodeServerManager.locateBinary()` (same dev/prod split, same
 * `app.getAppPath()` / app.asar detection per ADR-026 — never `__dirname`,
 * which resolves inside the bundled out/main dir in built/dev Electron and
 * can't find <projectRoot>/vendor). electron-builder copies vendor/pi-cli →
 * extraResources `pi-cli` at build time (scripts/ensure-pi.mjs downloads it;
 * electron-builder.yml's extraResources entry maps vendor/pi-cli → pi-cli).
 */
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { app } from 'electron'

const BINARY_NAME = process.platform === 'win32' ? 'pi.exe' : 'pi'

/**
 * Resolve the path to the vendored pi binary. Does not check existence —
 * callers that need a hard guarantee should pair this with `piBinaryAvailable()`.
 */
export function locatePiBinary(): string | null {
  // Outside Electron (vitest, integration tests, harness scripts) `app` is
  // undefined — fall back to cwd, which is the project root in those contexts.
  const appPath = app?.getAppPath ? app.getAppPath() : process.cwd()

  if (!appPath.includes('app.asar')) {
    // Dev/built — appPath is the project root.
    const vendor = join(appPath, 'vendor', 'pi-cli', BINARY_NAME)
    return existsSync(vendor) ? vendor : null
  }

  // Production — extraResources copies vendor/pi-cli → <Resources>/pi-cli.
  // dirname(appPath) is the Resources directory (where app.asar lives).
  const candidates = [
    join(dirname(appPath), 'pi-cli', BINARY_NAME),
    join(appPath.replace('app.asar', 'app.asar.unpacked'), 'vendor', 'pi-cli', BINARY_NAME)
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

/**
 * Cheap, deterministic "is pi installed?" check — does the binary resolve to
 * a file that exists on disk? Never spawns a process. Mirrors
 * `OpencodeServerManager.isBinaryAvailable()`.
 */
export function piBinaryAvailable(): boolean {
  try {
    return locatePiBinary() !== null
  } catch {
    return false
  }
}

/**
 * Resolve the vendored pi binary path in both dev and production.
 *
 *   dev        → <projectRoot>/vendor/pi-cli/pi[.exe]              (flat legacy layout)
 *                <projectRoot>/vendor/pi-cli/pi/pi[.exe]           (release payload layout)
 *   production → <Resources>/pi-cli/pi[.exe]                       (flat, extraResources)
 *                <Resources>/pi-cli/pi/pi[.exe]                    (nested, extraResources)
 *                <app.asar.unpacked>/vendor/pi-cli/pi[.exe]        (flat fallback)
 *                <app.asar.unpacked>/vendor/pi-cli/pi/pi[.exe]     (nested fallback)
 *
 * Mirrors `OpencodeServerManager.locateBinary()` (same dev/prod split, same
 * `app.getAppPath()` / app.asar detection per ADR-026 — never `__dirname`,
 * which resolves inside the bundled out/main dir in built/dev Electron and
 * can't find <projectRoot>/vendor). electron-builder copies vendor/pi-cli →
 * extraResources `pi-cli` at build time (scripts/ensure-pi.mjs downloads it;
 * electron-builder.yml's extraResources entry maps vendor/pi-cli → pi-cli).
 */
import { statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { getAppPath } from '../host'

const BINARY_NAME = process.platform === 'win32' ? 'pi.exe' : 'pi'

function firstFile(candidates: string[]): string | null {
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // Missing or inaccessible candidates are unavailable.
    }
  }
  return null
}

/**
 * Resolve the path to the first vendored pi candidate that is a regular file.
 */
export function locatePiBinary(): string | null {
  // Outside Electron (vitest, integration tests, harness scripts) no host
  // paths are wired — `getAppPath()` falls back to cwd, which is the project
  // root in those contexts.
  const appPath = getAppPath()

  if (!appPath.includes('app.asar')) {
    // Dev/built — appPath is the project root.
    const vendorDir = join(appPath, 'vendor', 'pi-cli')
    return firstFile([join(vendorDir, BINARY_NAME), join(vendorDir, 'pi', BINARY_NAME)])
  }

  // Production — extraResources copies vendor/pi-cli → <Resources>/pi-cli.
  // dirname(appPath) is the Resources directory (where app.asar lives).
  const resourcesDir = join(dirname(appPath), 'pi-cli')
  const unpackedDir = join(appPath.replace('app.asar', 'app.asar.unpacked'), 'vendor', 'pi-cli')
  return firstFile([
    join(resourcesDir, BINARY_NAME),
    join(resourcesDir, 'pi', BINARY_NAME),
    join(unpackedDir, BINARY_NAME),
    join(unpackedDir, 'pi', BINARY_NAME)
  ])
}

/**
 * Cheap, deterministic "is pi installed?" check — does the binary resolve to
 * a regular file that exists on disk? Never spawns a process. Mirrors
 * `OpencodeServerManager.isBinaryAvailable()`.
 */
export function piBinaryAvailable(): boolean {
  try {
    return locatePiBinary() !== null
  } catch {
    return false
  }
}

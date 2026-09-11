import { lstatSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { getAppPath } from '../host'

/** Only the macOS arm64 asset has acquisition and runtime evidence so far. */
export function codexBinaryAvailable(): boolean {
  return process.platform === 'darwin' && process.arch === 'arm64' && locateCodexBinary() !== null
}

/** Vendored paths only. Packaged layouts are reserved; packaging is not wired in M1a. */
export function locateCodexBinary(): string | null {
  const appPath = getAppPath()
  const name = process.platform === 'win32' ? 'codex.exe' : 'codex'
  const candidates =
    basename(appPath) === 'app.asar'
      ? [
          join(dirname(appPath), 'codex-cli', name),
          join(`${appPath}.unpacked`, 'vendor/codex-cli', name)
        ]
      : [join(appPath, 'vendor/codex-cli', name)]
  for (const candidate of candidates) {
    try {
      if (lstatSync(candidate).isFile()) return candidate
    } catch {
      /* unavailable */
    }
  }
  return null
}

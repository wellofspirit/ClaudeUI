import { lstatSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { getAppPath } from '../host'

/**
 * Only the macOS arm64 asset has acquisition and runtime evidence so far. Catalog
 * models are `tool_mode: code_mode_only`, so a `codex` without its code-mode host
 * cannot start a single tool; treat that install as unavailable rather than broken.
 */
export function codexBinaryAvailable(): boolean {
  return (
    process.platform === 'darwin' && process.arch === 'arm64' && locateCodexCodeModeHost() !== null
  )
}

/**
 * Vendored paths only, never PATH.
 *
 *   dev        → <projectRoot>/vendor/codex-cli/codex[.exe]
 *   production → <Resources>/codex-cli/codex[.exe]        (extraResources)
 *                <app.asar.unpacked>/vendor/codex-cli/…   (fallback, as pi-locate)
 *
 * electron-builder.yml maps vendor/codex-cli → extraResources `codex-cli`, so
 * `dirname(appPath)` (the Resources directory beside app.asar) is the packaged
 * hit; the unpacked path only matters if that mapping is ever dropped.
 */
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

/**
 * Codex resolves `codex-code-mode-host` from the directory of its own executable
 * (`install-context::code_mode_host_program_from_exe`), so only a host beside the
 * located `codex` counts. Exported for diagnostics.
 */
export function locateCodexCodeModeHost(): string | null {
  const binary = locateCodexBinary()
  if (binary === null) return null
  const candidate = join(
    dirname(binary),
    process.platform === 'win32' ? 'codex-code-mode-host.exe' : 'codex-code-mode-host'
  )
  try {
    if (lstatSync(candidate).isFile()) return candidate
  } catch {
    /* unavailable */
  }
  return null
}

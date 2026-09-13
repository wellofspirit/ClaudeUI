import { lstatSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { getAppPath } from '../host'

/**
 * Hosts whose release assets have a reviewed digest manifest, so acquisition can
 * install them and the engine may be offered. Mirrors the keys of
 * `scripts/codex-digests.json#hosts` — a test asserts the two stay in parity, and
 * that manifest is the place a new host is added first.
 */
export const CODEX_SUPPORTED_HOSTS: ReadonlySet<string> = new Set(['darwin-arm64', 'win32-x64'])

export function codexHostSupported(
  platform: string = process.platform,
  arch: string = process.arch
): boolean {
  return CODEX_SUPPORTED_HOSTS.has(`${platform}-${arch}`)
}

/**
 * Catalog models are `tool_mode: code_mode_only`, so a `codex` without its
 * code-mode host cannot start a single tool; treat that install as unavailable
 * rather than broken. An unreviewed host never installed one in the first place.
 */
export function codexBinaryAvailable(): boolean {
  return codexHostSupported() && locateCodexCodeModeHost() !== null
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

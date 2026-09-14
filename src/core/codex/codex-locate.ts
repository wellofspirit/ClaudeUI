import { lstatSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { getAppPath } from '../host'

/**
 * Hosts whose release assets have a reviewed digest manifest, so acquisition can
 * install them and the engine may be offered. Mirrors the keys of
 * `scripts/codex-digests.json#hosts` — a test asserts the two stay in parity, and
 * that manifest is the place a new host is added first.
 */
export const CODEX_SUPPORTED_HOSTS: ReadonlySet<string> = new Set([
  'darwin-arm64',
  'win32-x64',
  'linux-x64',
  'linux-arm64'
])

export function codexHostSupported(
  platform: string = process.platform,
  arch: string = process.arch
): boolean {
  return CODEX_SUPPORTED_HOSTS.has(`${platform}-${arch}`)
}

/**
 * The Linux sandbox is bubblewrap. Codex prefers a system `bwrap` on PATH
 * (`codex-rs/sandboxing/src/bwrap.rs::find_system_bwrap_in_path`, a `which`-style
 * walk), then one beside its own executable, and with neither it panics
 * `bubblewrap is unavailable` on the FIRST sandboxed command. The release does
 * publish a `bwrap` asset, but by decision (M5-L, 2026-09-14) ClaudeUI treats it
 * as a distro package rather than a manifest member, so the only thing we owe the
 * operator is to say so at boot rather than at the first failed command.
 *
 * Pure by construction — platform, environment and the "is this an executable
 * file" question are all arguments — so the whole rule is unit-testable without
 * touching a filesystem. `null` means nothing to say.
 */
export function codexLinuxSandboxWarning(
  platform: string,
  env: NodeJS.ProcessEnv,
  isExecutableFile: (path: string) => boolean
): string | null {
  if (platform !== 'linux') return null
  const entries = (env.PATH ?? '').split(':').filter((entry) => entry !== '')
  // A PATH entry is a directory to look INSIDE, exactly as `which` does; an entry
  // that is itself named `bwrap` is not the executable.
  if (entries.some((entry) => isExecutableFile(join(entry, 'bwrap')))) return null
  return (
    'Codex sandboxed commands need bubblewrap: no `bwrap` on PATH. Install the ' +
    'bubblewrap package (apt, dnf, apk or pacman) and restart; until then every ' +
    'Codex command that runs inside the sandbox fails, while commands you approve ' +
    'still run.'
  )
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

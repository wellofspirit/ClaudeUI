import { posix } from 'node:path'
import { codexCodeModeHostPath, harnessAvailable, resolveHarness } from '../harness/resolve'

// The reviewed-host gate lives with the resolver, which needs it for
// `harnessAvailable('codex')`; re-exported here for existing callers.
export { CODEX_SUPPORTED_HOSTS, codexHostSupported } from '../harness/resolve'

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
  // A Linux PATH is always POSIX; the platform join would produce backslashes
  // when this runs under the Windows host's test suite.
  if (entries.some((entry) => isExecutableFile(posix.join(entry, 'bwrap')))) return null
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
  return harnessAvailable('codex')
}

/**
 * The `codex` executable, resolved by the harness resolver
 * (`../harness/resolve.ts`, ADR-082): `CLAUDEUI_CODEX_CLI`, then the
 * harnesses.json selection, then the vendored copy (`vendor/codex-cli`, or
 * `<Resources>/codex-cli` packaged). Never PATH.
 */
export function locateCodexBinary(): string | null {
  return resolveHarness('codex').path
}

/**
 * Codex resolves `codex-code-mode-host` from the directory of its own executable
 * (`install-context::code_mode_host_program_from_exe`), so only a host beside the
 * resolved `codex` counts. Exported for diagnostics.
 */
export function locateCodexCodeModeHost(): string | null {
  return codexCodeModeHostPath()
}

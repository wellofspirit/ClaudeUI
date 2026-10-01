/**
 * The pi binary the app spawns: thin delegates to the harness resolver
 * (`../harness/resolve.ts`, ADR-082), which decides for every harness
 * (`CLAUDEUI_PI_CLI`, then the harnesses.json selection: ClaudeUI's store or a
 * System install; pi is not bundled, ADR-082 §8).
 *
 * A managed version is the whole release directory
 * (`~/.claude/ui/harnesses/pi/<version>/`), because pi resolves its wasm,
 * native addons and themes relative to its own executable; it may be flat
 * (`<version>/pi[.exe]`) or nested (`<version>/pi/pi[.exe]`). The installer
 * (`../harness/install/`, or `bun run ensure-pi` in development) puts it there.
 */
import type { HarnessLaunch } from '../../shared/harness-types'
import { harnessAvailable, harnessLaunch, resolveHarness } from '../harness/resolve'

/** The pi executable, or null when none was found. For display and gating; spawn with {@link locatePiLaunch}. */
export function locatePiBinary(): string | null {
  return resolveHarness('pi').path
}

/**
 * The pi a user can run in a terminal (`pi:binary-path`, the Settings "run
 * `pi /login`" hint), or null when none was found. For a System pi from npm or
 * pi.dev that is the shim or launcher detection found on PATH, not the `cli.js`
 * ClaudeUI hands to node; every other source runs its executable directly.
 */
export function locatePiDisplayPath(): string | null {
  const resolved = resolveHarness('pi')
  return resolved.displayPath ?? resolved.path
}

/**
 * How to spawn pi, or null when none was found. A System npm install runs as
 * `<node> <cli.js>` (ADR-082 §2), so every pi spawn goes through this.
 */
export function locatePiLaunch(): HarnessLaunch | null {
  return harnessLaunch('pi')
}

/** Cheap "is pi installed?" check. Never spawns a process. */
export function piBinaryAvailable(): boolean {
  return harnessAvailable('pi')
}

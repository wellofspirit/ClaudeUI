/**
 * The Claude Code binary the app spawns: a thin delegate to the harness
 * resolver (`../harness/resolve.ts`, ADR-082), which decides for every harness.
 *
 *   `CLAUDEUI_CLAUDE_CLI=<path>`  development override (warns once and falls
 *                                 back when it names no file); it is how the app
 *                                 runs against Anthropic's unpatched binary
 *   bundled                       the rebundled `bun-claude[.exe]`:
 *                                   dev        <projectRoot>/vendor/claude-cli/
 *                                   production <Resources>/claude-cli/
 *                                              <app.asar.unpacked>/vendor/claude-cli/
 *
 * The bundled binary is produced by `scripts/rebundle-cli.mjs` (our patched
 * cli.js embedded in Anthropic's Bun runtime); electron-builder copies
 * vendor/claude-cli → extraResources. What a binary can do is read from the
 * `version.json` beside it (`./harness.ts`); the official one has none, so it
 * counts as unpatched.
 */
import type { HarnessLaunch } from '../../shared/harness-types'
import { nativeLaunch } from '../harness/launch'
import {
  bundledHarnessPath,
  harnessEnvVar,
  harnessLaunch,
  resolveHarness
} from '../harness/resolve'

/** Env var naming a Claude Code binary to spawn instead of the bundled one. */
export const CLAUDE_CLI_OVERRIDE_ENV = harnessEnvVar('claude')

/**
 * Resolve the path to the Claude Code binary the app spawns: the resolved
 * launch's command (ADR-082 §2), which for Claude Code is always the
 * executable itself, a System install's included. Never null: when nothing was
 * found it returns where the bundled binary would be, so the spawn error names
 * that path.
 */
export function locateBunClaude(): string {
  return resolveHarness('claude').launch?.command ?? bundledHarnessPath('claude')
}

/**
 * How to spawn Claude Code (ADR-082 §2). Never null, like `locateBunClaude`:
 * when nothing was found it is a native launch of where the bundled binary
 * would be, so the spawn error names that path.
 */
export function locateClaudeLaunch(): HarnessLaunch {
  return harnessLaunch('claude') ?? nativeLaunch(bundledHarnessPath('claude'))
}

/** @deprecated Use {@link locateBunClaude}. Kept for callers mid-migration. */
export function locateCliJs(): string {
  return locateBunClaude()
}

// `getCliVersion()` lives in ./harness.ts, the one reader of version.json. It
// sits there rather than here so harness.ts → locate.ts stays a one-way import.

/**
 * Resolve the rebundled Bun standalone binary path in both dev and production.
 *
 *   dev        → <projectRoot>/vendor/claude-cli/bun-claude[.exe]
 *   production → <Resources>/claude-cli/bun-claude[.exe]  (primary, extraResources)
 *                <app.asar.unpacked>/vendor/claude-cli/bun-claude[.exe]  (fallback)
 *
 * The binary is produced by `scripts/rebundle-cli.mjs` and contains our
 * patched cli.js embedded in Anthropic's Bun runtime — no Electron-as-Node
 * shim required. electron-builder copies vendor/claude-cli → extraResources
 * at build time.
 *
 * `CLAUDEUI_CLAUDE_CLI=<path>` replaces all of the above, in dev and in a
 * packaged build: it is how the app runs against Anthropic's unpatched binary.
 * What that binary can do is read from the `version.json` beside it
 * (`./harness.ts`); the official one has none, so it counts as unpatched.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { getAppPath } from '../host'

const BIN_NAME = process.platform === 'win32' ? 'bun-claude.exe' : 'bun-claude'

/** Env var naming a Claude Code binary to spawn instead of the bundled one. */
export const CLAUDE_CLI_OVERRIDE_ENV = 'CLAUDEUI_CLAUDE_CLI'

/**
 * Override paths already warned about, so a value resolved on every spawn warns
 * once. `console`, not the app logger: core/sdk stays free of core/services, and
 * the path actually spawned is logged by ClaudeSession at every spawn anyway.
 */
const warnedOverrides = new Set<string>()

/**
 * The `CLAUDEUI_CLAUDE_CLI` binary, or null when the variable is unset or names
 * no file. Meant to be absolute; a relative value resolves against the cwd, as
 * `CLAUDEUI_TEST_BIN` does in `patch/test-helpers.mjs`. A missing file falls
 * back to the bundled binary with a warning rather than failing every spawn.
 */
function overrideBinary(): string | null {
  const raw = process.env[CLAUDE_CLI_OVERRIDE_ENV]
  if (!raw) return null
  const bin = path.resolve(raw)
  let isFile = false
  try {
    isFile = fs.statSync(bin).isFile()
  } catch {
    // Missing or unreadable: same fallback as a directory.
  }
  if (!isFile) {
    if (!warnedOverrides.has(bin)) {
      warnedOverrides.add(bin)
      console.warn(
        `[claude-harness] ${CLAUDE_CLI_OVERRIDE_ENV}=${raw} is not a file; using the bundled Claude Code binary`
      )
    }
    return null
  }
  return bin
}

/** Resolve the path to the Claude Code binary the app spawns. */
export function locateBunClaude(): string {
  const override = overrideBinary()
  if (override) return override

  // Outside Electron (vitest integration project, harness scripts) no host
  // paths are wired — `getAppPath()` falls back to cwd, which is the project
  // root in those contexts.
  const appPath = getAppPath()

  if (!appPath.includes('app.asar')) {
    // Dev — appPath is the project root.
    return path.join(appPath, 'vendor', 'claude-cli', BIN_NAME)
  }

  // Production — extraResources copies vendor/claude-cli → <Resources>/claude-cli.
  // path.dirname(appPath) is the Resources directory (where app.asar lives).
  const candidates = [
    path.join(path.dirname(appPath), 'claude-cli', BIN_NAME),
    path.join(appPath.replace('app.asar', 'app.asar.unpacked'), 'vendor', 'claude-cli', BIN_NAME)
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  // Return primary candidate anyway — caller surfaces the missing-file error.
  return candidates[0]
}

/** @deprecated Use {@link locateBunClaude}. Kept for callers mid-migration. */
export function locateCliJs(): string {
  return locateBunClaude()
}

// `getCliVersion()` lives in ./harness.ts, the one reader of version.json. It
// sits there rather than here so harness.ts → locate.ts stays a one-way import.

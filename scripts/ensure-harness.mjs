#!/usr/bin/env bun
/**
 * The body of `bun run ensure-{opencode,pi,codex}` and `update-*` (ADR-082 §8):
 * install the release manifest's tested version of a harness into ClaudeUI's
 * managed store (`~/.claude/ui/harnesses/<id>/<version>/`, or
 * `CLAUDEUI_HARNESS_STORE`) through the app's own installer
 * (`src/core/harness/install/installer.ts`). Development, CI, `postinstall` and
 * the Installed page therefore share one download-and-verify implementation:
 * the same official hosts, the same reviewed digests, the same `--version`
 * check, the same atomic publish.
 *
 * It imports the TypeScript installer directly, so it runs under bun, the
 * repo's package manager (`scripts/build.mjs` spawns it with `bun`).
 *
 *   ensure-<id>             install Tested; a valid install already there is kept
 *   update-<id> (--force)   move the installed Tested version aside (renamed
 *                           into the store's `.trash/` and removed there; a
 *                           locked file stays until released), then install
 *                           it again; the next spawn
 *                           runs the new copy. Windows renames the directory
 *                           of a running executable too, so close sessions
 *                           first: a running pi loads assets relative to its
 *                           executable and would lose them. Fails, changing
 *                           nothing, only when the move itself is refused
 *   --quiet                 only the result line
 *
 * Codex on a host without reviewed digests (Windows arm64, macOS x64) is
 * skipped with one line and exit 0, so `postinstall` succeeds there.
 *
 * Bumping a harness: set `tested` (and `floor`) in
 * `src/shared/harness-manifests/<id>.json` with the new release's reviewed
 * digests (opencode: each platform package's npm `integrity` and the SHA-256 of
 * `package/bin/opencode[.exe]`; pi: each asset's SHA-256 from the release's
 * `SHA256SUMS`; Codex: every host's archive and binary digests, the source
 * commit and the LICENSE digest, then `bun run generate-codex-protocol`), and
 * run `bun run ensure-<id>`.
 */
import * as fs from 'node:fs'
import { harnessManifest } from '../src/core/harness/manifests.ts'
import { codexHostSupported } from '../src/core/harness/resolve.ts'
import { installDir } from '../src/core/harness/store.ts'
import { installHarness, onInstallProgress } from '../src/core/harness/install/installer.ts'
import { isValidInstall, moveToTrash } from '../src/core/harness/install/store-writer.ts'
import { logger } from '../src/core/services/logger.ts'

const LABELS = { opencode: 'opencode', pi: 'pi', codex: 'Codex' }

/** `--force` and `--quiet`, nothing else. Throws on anything else. */
export function parseEnsureArgs(argv) {
  const options = { force: false, quiet: false }
  for (const arg of argv) {
    if (arg === '--force') options.force = true
    else if (arg === '--quiet') options.quiet = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

const defaultDeps = {
  tested: (id) => harnessManifest(id).tested,
  hostSupported: (id) => id !== 'codex' || codexHostSupported(),
  isValid: isValidInstall,
  exists: (id, version) => fs.existsSync(installDir(id, version)),
  dir: installDir,
  remove: (id, version) => moveToTrash(installDir(id, version), `${id}-${version}`),
  install: (id, version) => installHarness(id, version),
  onProgress: onInstallProgress,
  out: (line) => console.log(line),
  err: (line) => console.error(line)
}

/**
 * Ensure `id`'s tested version is in the store. Resolves with the process exit
 * code: 0 installed, already there, or skipped on an unsupported host; 1 on a
 * failure; 2 on bad arguments. Never throws.
 */
export async function ensureHarness(id, argv, overrides = {}) {
  const deps = { ...defaultDeps, ...overrides }
  const tag = `[ensure-${id}]`
  let options
  try {
    options = parseEnsureArgs(argv)
  } catch (error) {
    deps.err(`${tag} ${error.message} (accepted: --force, --quiet)`)
    return 2
  }
  const label = LABELS[id]
  if (!label) {
    deps.err(`${tag} ${id} has no ClaudeUI-managed copy`)
    return 2
  }
  if (!deps.hostSupported(id)) {
    deps.out(
      `${tag} skipped: ${label} has no reviewed release for ${process.platform}-${process.arch}; it will be unavailable on this machine`
    )
    return 0
  }
  const version = deps.tested(id)
  try {
    if (!options.force && deps.isValid(id, version)) {
      deps.out(`${tag} ${label} ${version} is already installed (${deps.dir(id, version)})`)
      return 0
    }
    if (options.force && deps.exists(id, version)) {
      try {
        await deps.remove(id, version)
      } catch (error) {
        deps.err(
          `${tag} ${label} ${version} could not be moved aside and was left as it is (${error.code ?? error.message}); close the sessions running it and try again`
        )
        return 1
      }
    }
  } catch (error) {
    deps.err(`${tag} ${label} ${version} could not be checked: ${error.message}`)
    return 1
  }

  let lastPhase = null
  const off = options.quiet
    ? () => {}
    : deps.onProgress((p) => {
        if (p.id !== id || p.version !== version || p.phase === lastPhase) return
        lastPhase = p.phase
        if (p.phase !== 'done' && p.phase !== 'failed') deps.out(`${tag} ${p.phase}...`)
      })
  try {
    const result = await deps.install(id, version)
    if (result.status === 'installed') {
      deps.out(
        `${tag} ${label} ${version} installed and verified (${result.verified}) in ${deps.dir(id, version)}`
      )
      return 0
    }
    deps.err(`${tag} ${result.reason}`)
    return 1
  } catch (error) {
    deps.err(`${tag} ${label} ${version} could not be installed: ${error.message}`)
    return 1
  } finally {
    off()
  }
}

/** The entry point the per-harness scripts call. Sets the exit code; never throws. */
export async function runEnsure(id) {
  // The script prints every outcome itself; the installer's own lines would
  // repeat them, and belong in the app's log, not a development shell's.
  logger.sourceLevels.set('harness', 'silent')
  let code
  try {
    code = await ensureHarness(id, process.argv.slice(2))
  } catch (error) {
    console.error(`[ensure-${id}] failed: ${error instanceof Error ? error.message : error}`)
    code = 1
  }
  process.exit(code)
}

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { codexHostSupported } from '../../core/codex/codex-locate'
import { harnessManifest } from '../../core/harness/manifests'
import { harnessEnvVar, invalidateHarness, payloadExecutable } from '../../core/harness/resolve'
import { installDir, readInstallRecord } from '../../core/harness/store'

/**
 * The pinned Codex's version directory in ClaudeUI's managed store
 * (`bun run ensure-codex`; `CLAUDEUI_HARNESS_STORE` honoured), or null when it
 * is not installed there. Codex is not bundled (ADR-082 §8), so this is the one
 * copy the suites run: deliberately the store's tested version, not the
 * resolver's answer, which a System selection or an override could make another
 * version.
 */
export function storeCodexDir(): string | null {
  const tested = harnessManifest('codex').tested
  if (!readInstallRecord('codex', tested)) return null
  const dir = installDir('codex', tested)
  return payloadExecutable('codex', dir) ? dir : null
}

/** A file of the installed pinned Codex (`codex[.exe]`, `codex-code-mode-host[.exe]`). */
export function storeCodexPath(name: string): string {
  const dir = storeCodexDir()
  if (!dir) throw new Error('The pinned Codex is not installed: run `bun run ensure-codex`')
  return join(dir, name)
}

/** Evaluated once at collection time, so a suite skips cleanly without it. */
export const codexInstalled = storeCodexDir() !== null

/**
 * The gate every real-binary Codex integration shares.
 *
 * `CODEX_INTEGRATION=1` is the opt-in (these suites spawn the pinned binary and
 * are not part of the default run), and the host question is the SAME one
 * acquisition and the runtime gate ask: a host the reviewed manifest covers can
 * install the pinned Codex into the store, and no other host has anything to
 * run. Reusing `codexHostSupported()` rather than listing platforms here is
 * what stops a newly pinned host being provisioned but never exercised. A host
 * whose store lacks the pinned Codex skips rather than fails.
 *
 * Containment differs per host and is each suite's own business: macOS wraps the
 * child in `sandbox-exec`, while Windows and Linux rely on the fixture's own
 * isolation — a replacement environment, a temp `CODEX_HOME`, a config whose only
 * provider is a localhost fixture, and every network feature off.
 */
export const codexIntegrationEnabled =
  process.env.CODEX_INTEGRATION === '1' && codexHostSupported() && codexInstalled

/** Where a fixture copies the binaries it runs, under its temp directory. */
export const FIXTURE_CODEX_DIR = 'codex-bin'

const OVERRIDE = harnessEnvVar('codex')
const developerOverride = process.env[OVERRIDE]

/**
 * Make the fixture's copy of `codex` (in `<directory>/codex-bin/`) the one the
 * production code spawns, through the resolver's development override
 * (`CLAUDEUI_CODEX_CLI`). The resolver caches per override value, so each
 * fixture's fresh directory is a fresh resolution; `codex-code-mode-host` counts
 * only when it sits beside the copy.
 */
export function useFixtureCodex(directory: string): void {
  const dir = join(directory, FIXTURE_CODEX_DIR)
  const bin = ['codex.exe', 'codex'].map((name) => join(dir, name)).find((p) => existsSync(p))
  if (!bin) throw new Error(`No codex copied into ${dir}`)
  process.env[OVERRIDE] = bin
  invalidateHarness('codex')
}

/**
 * Re-read the fixture's copy after a file was added beside it (a probe that
 * copies `codex-code-mode-host` in late).
 */
export function refreshFixtureCodex(): void {
  invalidateHarness('codex')
}

/** Undo `useFixtureCodex`: the override the process started with, if any. */
export function releaseFixtureCodex(): void {
  if (developerOverride === undefined) delete process.env[OVERRIDE]
  else process.env[OVERRIDE] = developerOverride
  invalidateHarness('codex')
}

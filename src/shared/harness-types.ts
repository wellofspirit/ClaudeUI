/**
 * Harness sources and resolution (ADR-082). A harness is the program ClaudeUI
 * runs for an engine: Claude Code, opencode, pi or Codex.
 *
 * Main owns the selection file (`~/.claude/ui/harnesses.json`,
 * `src/core/harness/selection-store.ts`) and the resolver
 * (`src/core/harness/resolve.ts`); these are the shapes both share with the
 * renderer.
 */

export const HARNESS_IDS = ['claude', 'opencode', 'pi', 'codex'] as const

export type HarnessId = (typeof HARNESS_IDS)[number]

export function isHarnessId(value: unknown): value is HarnessId {
  return typeof value === 'string' && (HARNESS_IDS as readonly string[]).includes(value)
}

/**
 * Where the user wants a harness to come from. Claude Code offers
 * `bundled | system`; opencode, pi and Codex offer `managed | system`.
 */
export type HarnessSourceChoice = 'bundled' | 'managed' | 'system'

export interface HarnessSelection {
  source: HarnessSourceChoice
  /**
   * For `managed`: `tested` (this release's manifest version, the default),
   * `latest` (the newest installed version) or one exact version.
   */
  version?: 'latest' | 'tested' | (string & {})
}

/** `~/.claude/ui/harnesses.json`. Unknown keys are preserved on save. */
export interface HarnessesConfig {
  selections?: Partial<Record<HarnessId, HarnessSelection>>
}

/** Where a resolved harness actually came from. */
export type HarnessResolvedSource = 'env' | 'bundled' | 'managed' | 'system'

export interface ResolvedHarness {
  id: HarnessId
  /** The executable (claude: bun-claude; codex: codex), or null when none was found. */
  path: string | null
  /** The executable's directory: the payload root (Codex's host and pi's assets live here). */
  dir: string | null
  source: HarnessResolvedSource
  /** The version when a `version.json` / `install.json` states it, else null. */
  version: string | null
  /** Why `path` is null, or why a fallback was taken. User-readable. */
  reason?: string
}

/**
 * `install.json` in `~/.claude/ui/harnesses/<id>/<version>/`. The download
 * pipeline writes it last, so a directory without a valid one is not an install.
 */
export interface HarnessInstallRecord {
  id: HarnessId
  version: string
  platform: string
  arch: string
  installedAt: string
  /** `reviewed`: checked against a digest in this repo. `publisher`: only against the publisher's own hash. */
  verified: 'reviewed' | 'publisher'
}

/** `src/shared/harness-manifests/<id>.json`: what this ClaudeUI release tested. */
export interface HarnessManifest {
  id: HarnessId
  /** The version this release pins and tests ("Tested" in the UI). */
  tested: string
  /** The oldest version ClaudeUI accepts from a system install. */
  floor: string
  /** Download coordinates and reviewed digests, keyed `<platform>-<arch>`. */
  platforms: Record<string, Record<string, unknown>>
}

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

/**
 * How to start a harness: the process to spawn, the arguments that go before
 * the site's own, and environment entries laid over the site's environment.
 * A native executable is `{ command: path, args: [] }`; a Node-script install
 * (pi from npm, ADR-082 §2) is `{ command: node, args: [cli.js] }`, so node is
 * the harness process itself. Compose argv only with `withLaunch`
 * (`src/core/harness/launch.ts`).
 */
export interface HarnessLaunch {
  command: string
  args: readonly string[]
  /** Never `PATH`: `withLaunch` drops it. Directories go in `pathPrepend`. */
  env?: Readonly<Record<string, string>>
  /**
   * Directories put in front of the spawn site's own `PATH` (pi.dev's
   * `pi-node`). Prepended at spawn time, so a PATH captured at detection never
   * replaces the site's.
   */
  pathPrepend?: readonly string[]
}

export interface ResolvedHarness {
  id: HarnessId
  /** The executable (claude: bun-claude; codex: codex), or null when none was found. */
  path: string | null
  /** How to spawn it; null exactly when `path` is null. */
  launch: HarnessLaunch | null
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
  /**
   * The first version ClaudeUI refuses (exclusive upper bound): the next major,
   * whose config or protocol may be incompatible (opencode 2.x). Versions in
   * `[floor, ceiling)` other than `tested` are accepted as untested.
   */
  ceiling: string
  /** Download coordinates and reviewed digests, keyed `<platform>-<arch>`. */
  platforms: Record<string, Record<string, unknown>>
}

// ── System detection (ADR-082 §3) ─────────────────────────────────────────────

/** How a detected system install got onto the machine, read from where it lives. */
export type HarnessInstallKind =
  | 'npm'
  | 'pnpm'
  | 'bun'
  | 'native-installer'
  | 'homebrew'
  | 'scoop'
  | 'winget'
  | 'standalone'
  | 'pi-managed'
  | 'path'

/**
 * A detected install's label. The first four are `classifyVersion`'s
 * (`src/core/harness/version-gate.ts`); `unsupported` means ClaudeUI cannot
 * run it at all (a script launcher, a version-manager shim, pi without a
 * suitable Node, Codex without its code-mode host); `failed` means its
 * `--version` probe errored, timed out or printed something unrecognisable.
 */
export type DetectedVerdict =
  'tested' | 'untested' | 'too-old' | 'incompatible' | 'unsupported' | 'failed'

/**
 * The node that runs a Node-script install (pi): a node found on disk, or
 * Electron itself with `ELECTRON_RUN_AS_NODE=1` (`kind: 'electron'`).
 */
export type DetectedNode = { path: string; version: string } | { kind: 'electron'; version: string }

export interface DetectedInstall {
  id: HarnessId
  /** What the user would recognise: the PATH hit or shim, else the install's own path. */
  displayPath: string
  /** The file that runs: the native executable, or for pi the `cli.js` node runs. */
  realPath: string
  /** How to spawn it; null when it is `unsupported` (or could not be resolved to a launch). */
  launch: HarnessLaunch | null
  installKind: HarnessInstallKind
  /** What `--version` printed, parsed; null when the probe did not run or failed. */
  version: string | null
  verdict: DetectedVerdict
  /** Why it is not tested/untested, or a note on it. User-readable. */
  reason?: string
  /** `realPath`'s size and mtime at detection, so a cached result can be checked with one stat. */
  fingerprint: { path: string; size: number; mtimeMs: number }
  /** pi only: the node that runs `cli.js`. */
  node?: DetectedNode
  /**
   * pi with a node on disk: that node's fingerprint at detection. The resolver
   * trusts the install only while both fingerprints hold.
   */
  nodeFingerprint?: { path: string; size: number; mtimeMs: number }
}

export interface HarnessDetection {
  id: HarnessId
  /** ISO timestamp. */
  detectedAt: string
  installs: DetectedInstall[]
}

// ── Managed installs (ADR-082 §4) ─────────────────────────────────────────────

/** Where an install is: `resolving` covers waiting for a free slot and reading upstream metadata. */
export type HarnessInstallPhase =
  'resolving' | 'downloading' | 'verifying' | 'extracting' | 'checking' | 'done' | 'failed'

/** One install's state, as `onInstallProgress` reports it (at most four updates a second). */
export interface HarnessInstallProgress {
  id: HarnessId
  /** The exact version being installed (`latest` / `tested` already resolved). */
  version: string
  phase: HarnessInstallPhase
  /** Bytes downloaded so far across the install's files. */
  receivedBytes?: number
  /** The download's expected size, when the server states it. */
  totalBytes?: number
  /** `failed` only: why. User-readable. */
  reason?: string
}

/**
 * An install's outcome. Discriminated by `status`, never `ok`: the preload and
 * web transports treat any object with an `ok` key as their own envelope.
 */
export type HarnessInstallResult =
  | {
      status: 'installed'
      id: HarnessId
      version: string
      verified: HarnessInstallRecord['verified']
    }
  | { status: 'failed'; id: HarnessId; version: string; reason: string }

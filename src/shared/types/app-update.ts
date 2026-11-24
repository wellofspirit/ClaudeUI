/**
 * The app-update view (`app-update:state`): what the host knows about a newer
 * ClaudeUI release on the chosen channel, and where its download stands. One
 * shape for every client; remote clients read it with `config`, so it carries
 * no local path.
 */

/** `auto` follows the running build: a release build's own channel, a local build's base tag. */
export type AppUpdateChannelSetting = 'auto' | 'stable' | 'pre-release'

/** `auto` downloads in the background; `ask` downloads on a click; `off` never checks. */
export type AppUpdateMode = 'auto' | 'ask' | 'off'

export type AppUpdateDownloadPhase =
  'idle' | 'downloading' | 'verifying' | 'staging' | 'staged' | 'failed'

/**
 * `notice`: a host that can update, with something the user should know first
 * (the macOS and Windows server: their firewalls approve each executable, and an
 * update runs from a new one).
 */
export type AppUpdateEligibility = { ok: true; notice?: string } | { ok: false; reason: string }

export interface AppUpdateView {
  /** A host seam and an update target exist (desktop and server builds that can update). */
  supported: boolean
  current: {
    kind: 'release' | 'local' | 'dev'
    version: string | null
    /** What an update must be newer than; null for a dev or untagged local build (no checks). */
    comparisonVersion: string | null
    channel?: 'stable' | 'pre-release'
    commit?: string | null
    dirty?: boolean | null
    ahead?: number | null
  }
  /** From the host: can an update be applied here (writable install, not translocated, ...). */
  eligibility: AppUpdateEligibility
  settings: {
    channel: AppUpdateChannelSetting
    effectiveChannel: 'stable' | 'pre-release'
    mode: AppUpdateMode
  }
  check: { running: boolean; lastCheckedAt?: string; error?: string }
  /** The newest verified release on the channel, newer than `current`; absent when none or skipped. */
  available?: {
    version: string
    tag: string
    notesUrl: string
    size: number
    claudeCodeVersion: string
    publishedAt: string
  }
  skippedVersion?: string
  download: {
    phase: AppUpdateDownloadPhase
    version?: string
    received?: number
    total?: number
    error?: string
  }
  /** A local rebuild from source (desktop hosts that can rebuild); absent where none can run. */
  rebuild?: AppUpdateRebuildView
  /** The host can rebuild ClaudeUI from a source checkout it knows (no tree list needed to tell). */
  rebuildAvailable: boolean
  /**
   * The host-owned rebuild source (`appUpdateSourcePath`) is set. Never the
   * path: an admin sets it with `app-update:set-source`.
   */
  sourceConfigured: boolean
}

/** Where to restart from: the staged release (default) or the built rebuild. */
export type AppUpdateApplySource = 'release' | 'rebuild'

/** `app-update:apply`: the host accepted the restart (an error is thrown otherwise). */
export interface AppUpdateApplyResult {
  accepted: true
}

// ── Local rebuild ─────────────────────────────────────────────────────────────

export type AppUpdateRebuildPhase = 'idle' | 'building' | 'built' | 'failed'

/** A ClaudeUI checkout or worktree the host can rebuild, as every client sees it (no path). */
export interface AppUpdateTreeSummary {
  /** The worktree's folder name, or "main checkout" for the repository's main worktree. */
  name: string
  /** Null when HEAD is detached. */
  branch: string | null
  /** Short commit of HEAD; null when git could not tell. */
  commit: string | null
  /** Uncommitted changes (`git status --porcelain` lines, untracked included). */
  dirty: number
}

/** `app-update:trees`: one entry per tree. `id` is what `app-update:rebuild` takes. */
export interface AppUpdateTree extends AppUpdateTreeSummary {
  id: string
}

export interface AppUpdateRebuildStage {
  /** As `scripts/build.mjs` prints it (`[i/N] <label>`); parallel members joined with ` ‖ `. */
  label: string
  state: 'done' | 'running' | 'pending'
  elapsedMs?: number
}

/** What a running rebuild reports as it goes (host → service). */
export interface AppUpdateRebuildProgress {
  stages: AppUpdateRebuildStage[]
  /** The build's last output line, local paths replaced. */
  lastLine?: string
}

export interface AppUpdateRebuildView {
  phase: AppUpdateRebuildPhase
  tree?: AppUpdateTreeSummary
  stages?: AppUpdateRebuildStage[]
  lastLine?: string
  /** ISO time the build started. */
  startedAt?: string
  /** `built`: the version and commit the staged rebuild carries. */
  built?: { version: string; commit: string | null }
  error?: string
}

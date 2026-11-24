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
}

/** `app-update:apply`: the host accepted the restart (an error is thrown otherwise). */
export interface AppUpdateApplyResult {
  accepted: true
}

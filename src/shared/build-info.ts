/**
 * Build identity: what a build of ClaudeUI is, as a machine-readable file
 * (`out/build-info.json`, written by `scripts/stamp-build-info.mjs`).
 *
 * Pure (no Node imports): the renderer and the web client import `src/shared`.
 * The file is untrusted input to every reader, so `parseBuildInfo` validates it
 * strictly and answers null on anything unexpected.
 */

export const BUILD_INFO_FILE = 'build-info.json'
/** Where the file lives, relative to the app path (the directory that contains `out/`). */
export const BUILD_INFO_RELATIVE_PATH = `out/${BUILD_INFO_FILE}`

export type BuildKind = 'release' | 'local' | 'dev'
export type BuildChannel = 'stable' | 'pre-release'

export interface BuildGitInfo {
  describe: string | null
  baseTag: string | null
  ahead: number | null
  commit: string | null
  dirty: boolean | null
  branch: string | null
}

export interface BuildInfo {
  schema: 1
  kind: 'release' | 'local'
  version: string
  /** Release builds only. */
  channel?: BuildChannel
  git: BuildGitInfo
  /** Local builds only; never present in a published artifact. */
  sourcePath?: string
  builtAt: string
}

/** What a reader gets when there is no usable stamp (`bun run dev`, an old build). */
export interface DevBuildInfo {
  kind: 'dev'
}

export interface GitDescribe {
  baseTag: string
  ahead: number
  shortCommit: string
  dirty: boolean
}

/** `git describe --tags --long --match "v*" --dirty`: `v3.9.1-pre.13-5-ge4f1a2c[-dirty]`. */
export function parseGitDescribe(s: string): GitDescribe | null {
  const m = /^(v\d.*)-(\d+)-g([0-9a-f]{4,40})(-dirty)?$/.exec(s.trim())
  if (!m) return null
  return { baseTag: m[1], ahead: Number(m[2]), shortCommit: m[3], dirty: m[4] !== undefined }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const strOrNull = (v: unknown): string | null | undefined =>
  v === null || typeof v === 'string' ? v : undefined

function parseGit(raw: unknown): BuildGitInfo | null {
  if (!isRecord(raw)) return null
  const describe = strOrNull(raw.describe)
  const baseTag = strOrNull(raw.baseTag)
  const commit = strOrNull(raw.commit)
  const branch = strOrNull(raw.branch)
  const { ahead, dirty } = raw
  if ([describe, baseTag, commit, branch].includes(undefined)) return null
  if (ahead !== null && !(typeof ahead === 'number' && Number.isInteger(ahead) && ahead >= 0))
    return null
  if (dirty !== null && typeof dirty !== 'boolean') return null
  return {
    describe: describe!,
    baseTag: baseTag!,
    ahead: ahead as number | null,
    commit: commit!,
    dirty: dirty as boolean | null,
    branch: branch!
  }
}

export function parseBuildInfo(raw: unknown): BuildInfo | null {
  if (!isRecord(raw) || raw.schema !== 1) return null
  const { kind, version, channel, sourcePath, builtAt } = raw
  if (kind !== 'release' && kind !== 'local') return null
  if (typeof version !== 'string' || version === '') return null
  if (typeof builtAt !== 'string' || builtAt === '') return null
  const git = parseGit(raw.git)
  if (!git) return null
  const info: BuildInfo = { schema: 1, kind, version, git, builtAt }
  if (channel !== undefined) {
    if (channel !== 'stable' && channel !== 'pre-release') return null
    info.channel = channel
  }
  if (sourcePath !== undefined) {
    if (typeof sourcePath !== 'string') return null
    info.sourcePath = sourcePath
  }
  return info
}

/** The version an update check compares against; null when this build has none to offer. */
export function comparisonVersion(info: BuildInfo | DevBuildInfo): string | null {
  if (info.kind === 'dev') return null
  if (info.kind === 'release') return info.version
  const tag = info.git.baseTag
  if (!tag) return null
  return tag.startsWith('v') ? tag.slice(1) : tag
}

/** Stable id that changes whenever the build does (a remote client reloads on a change). */
export function buildId(info: BuildInfo): string {
  const who = info.git.commit ? info.git.commit.slice(0, 7) : info.version
  return `${who}@${info.builtAt}`
}

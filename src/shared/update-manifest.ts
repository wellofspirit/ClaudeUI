/**
 * The signed update manifest (schema 1) every GitHub release publishes as
 * `update-manifest.json` + `update-manifest.json.sig`. Pure: the release script
 * and the client share it. The signature covers the exact bytes
 * `serializeManifest` produces.
 */

export const UPDATE_MANIFEST_FILE = 'update-manifest.json'
export const UPDATE_MANIFEST_SIG_FILE = 'update-manifest.json.sig'

/** The GitHub repository whose releases are the update feed (`owner/repo`). */
export const UPDATE_FEED_REPO = 'wellofspirit/ClaudeUI'

export const UPDATE_TARGETS = [
  'desktop-darwin-arm64',
  'desktop-win32-x64',
  'server-darwin-arm64',
  'server-win32-x64',
  'server-linux-x64',
  'server-linux-arm64'
] as const
export type UpdateTarget = (typeof UPDATE_TARGETS)[number]

export interface UpdateAsset {
  name: string
  size: number
  sha256: string
}

export interface UpdateManifest {
  schema: 1
  version: string
  tag: string
  channel: 'stable' | 'pre-release'
  publishedAt: string
  claudeCodeVersion: string
  assets: Partial<Record<UpdateTarget, UpdateAsset>>
}

const VERSION_RE = /^\d+\.\d+\.\d+(?:-pre\.\d+)?$/

export function isReleaseVersion(v: string): boolean {
  return VERSION_RE.test(v)
}

/** The release asset file name for each target, for `version`. */
const ASSET_NAMES: Record<UpdateTarget, (v: string) => string> = {
  'desktop-darwin-arm64': (v) => `ClaudeUI-${v}-mac-arm64.zip`,
  'desktop-win32-x64': (v) => `ClaudeUI-${v}-win-x64.zip`,
  'server-darwin-arm64': (v) => `claudeui-server-${v}-mac-arm64.zip`,
  'server-win32-x64': (v) => `claudeui-server-${v}-win-x64.zip`,
  'server-linux-x64': (v) => `claudeui-server-${v}-linux-x64.tar.gz`,
  'server-linux-arm64': (v) => `claudeui-server-${v}-linux-arm64.tar.gz`
}

/** Exact match on name and version; anything else is null. */
export function assetTargetFor(filename: string, version: string): UpdateTarget | null {
  for (const t of UPDATE_TARGETS) if (ASSET_NAMES[t](version) === filename) return t
  return null
}

/** True when a name looks like one of our release assets, whatever its version. */
export function looksLikeReleaseAsset(filename: string): boolean {
  return /^(?:ClaudeUI|claudeui-server)-.+\.(?:zip|tar\.gz)$/.test(filename)
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== ''

function parseAsset(raw: unknown): UpdateAsset | null {
  if (!isRecord(raw)) return null
  const { name, size, sha256 } = raw
  if (!nonEmpty(name) || /[\\/]/.test(name) || name === '.' || name === '..') return null
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) return null
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return null
  return { name, size, sha256 }
}

export function parseManifest(raw: unknown): UpdateManifest | null {
  if (!isRecord(raw) || raw.schema !== 1) return null
  const { version, tag, channel, publishedAt, claudeCodeVersion, assets } = raw
  if (typeof version !== 'string' || !VERSION_RE.test(version)) return null
  if (typeof tag !== 'string' || tag === '') return null
  if (channel !== 'stable' && channel !== 'pre-release') return null
  if (!nonEmpty(publishedAt) || !nonEmpty(claudeCodeVersion)) return null
  if (!isRecord(assets)) return null
  const out: UpdateManifest['assets'] = {}
  for (const [key, value] of Object.entries(assets)) {
    if (!(UPDATE_TARGETS as readonly string[]).includes(key)) return null
    const asset = parseAsset(value)
    if (!asset) return null
    out[key as UpdateTarget] = asset
  }
  return { schema: 1, version, tag, channel, publishedAt, claudeCodeVersion, assets: out }
}

/** Fixed key order and a trailing newline: the signature covers these bytes. */
export function serializeManifest(m: UpdateManifest): string {
  const assets: Record<string, UpdateAsset> = {}
  for (const t of UPDATE_TARGETS) {
    const a = m.assets[t]
    if (a) assets[t] = { name: a.name, size: a.size, sha256: a.sha256 }
  }
  return (
    JSON.stringify(
      {
        schema: 1,
        version: m.version,
        tag: m.tag,
        channel: m.channel,
        publishedAt: m.publishedAt,
        claudeCodeVersion: m.claudeCodeVersion,
        assets
      },
      null,
      2
    ) + '\n'
  )
}

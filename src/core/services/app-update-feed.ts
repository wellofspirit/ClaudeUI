/**
 * The ClaudeUI update feed (auto-update design §2): GitHub's release list for
 * {@link UPDATE_FEED_REPO}, the pick of the newest release on a channel, and the
 * verification of that release's signed manifest.
 *
 * Trust: nothing a release says is believed until its `update-manifest.json`
 * verifies under a key pinned in this build (`src/shared/update-keys.ts`,
 * Ed25519 over the manifest's exact bytes). The manifest then pins the asset
 * by name, size and sha256; the release list only supplies the download link
 * for that exact name, and every byte is checked against the manifest after it
 * arrives. Never a downgrade: the manifest's version must be newer than the
 * running build, so an old signed manifest cannot be replayed.
 *
 * `parseReleases`, `pickRelease` and `verifyManifest` are pure (arguments in,
 * answer out); `fetchReleases` and `fetchManifestFiles` go through the harness
 * download machinery (`harness/install/download.ts`: host allowlist, redirects
 * checked hop by hop, timeouts, size caps) with an injected `fetch`.
 */
import { createPublicKey, verify } from 'node:crypto'
import {
  UPDATE_FEED_REPO,
  UPDATE_MANIFEST_FILE,
  UPDATE_MANIFEST_SIG_FILE,
  isReleaseVersion,
  parseManifest,
  type UpdateAsset,
  type UpdateManifest,
  type UpdateTarget
} from '../../shared/update-manifest'
import {
  DownloadError,
  GITHUB_API,
  GITHUB_RELEASES,
  HttpStatusError,
  checkUrl,
  fetchBytes,
  fetchJson,
  fetchText
} from '../harness/install/download'
import { compareVersions } from '../harness/store'

export const RELEASES_URL = `https://api.github.com/repos/${UPDATE_FEED_REPO}/releases?per_page=30`
export const MAX_RELEASES_BYTES = 4 * 1024 * 1024
export const MAX_MANIFEST_BYTES = 64 * 1024
/** The largest asset a manifest may name. */
export const MAX_ASSET_BYTES = 1024 ** 3

/** As `harness/install/upstream.ts` asks GitHub. */
export const GITHUB_HEADERS: Readonly<Record<string, string>> = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'ClaudeUI'
}

/** A pinned public key: a label and the base64 DER SPKI (`src/shared/update-keys.ts`). */
export interface PinnedKey {
  id: string
  spki: string
}

export interface FeedAsset {
  name: string
  /** GitHub's `browser_download_url`; never built from anything else. */
  url: string
}

export interface FeedRelease {
  tag: string
  /** Missing or not `false` counts as a draft. */
  draft: boolean
  /** Missing or not `false` counts as a prerelease. */
  prerelease: boolean
  assets: FeedAsset[]
}

export type CompareVersions = (a: string, b: string) => number

/** GitHub refused the list for its rate limit (HTTP 403 or 429). */
export class RateLimitedError extends Error {
  override name = 'RateLimitedError'
  constructor(
    /** When GitHub says to ask again (epoch ms), or null when it did not say. */
    readonly resetAt: number | null
  ) {
    super('GitHub rate limit')
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** The release list as far as it can be read; malformed entries are dropped. */
export function parseReleases(raw: unknown): FeedRelease[] {
  if (!Array.isArray(raw)) throw new DownloadError('the GitHub release list is not a list')
  const out: FeedRelease[] = []
  for (const r of raw) {
    if (!isRecord(r) || typeof r.tag_name !== 'string') continue
    const assets: FeedAsset[] = []
    if (Array.isArray(r.assets)) {
      for (const a of r.assets) {
        if (!isRecord(a)) continue
        if (typeof a.name !== 'string' || typeof a.browser_download_url !== 'string') continue
        assets.push({ name: a.name, url: a.browser_download_url })
      }
    }
    out.push({
      tag: r.tag_name,
      draft: r.draft !== false,
      prerelease: r.prerelease !== false,
      assets
    })
  }
  return out
}

/**
 * When to ask again, from a refusal's headers: `retry-after` (seconds or an
 * HTTP date; GitHub's secondary limit) first, then `x-ratelimit-reset` (epoch
 * seconds; the primary limit). Null when neither is usable.
 */
export function rateLimitResetAt(headers: Headers, now: number): number | null {
  const retry = headers.get('retry-after')?.trim()
  if (retry) {
    if (/^\d+$/.test(retry)) return now + Number(retry) * 1000
    const date = Date.parse(retry)
    if (!Number.isNaN(date)) return date
  }
  const reset = headers.get('x-ratelimit-reset')?.trim()
  if (reset && /^\d+$/.test(reset)) return Number(reset) * 1000
  return null
}

export interface FeedFetchOptions {
  fetch: typeof fetch
  signal?: AbortSignal
}

/** The newest 30 releases. HTTP 403/429 is a {@link RateLimitedError}. */
export async function fetchReleases(
  opts: FeedFetchOptions & { now: number }
): Promise<FeedRelease[]> {
  let raw: unknown
  try {
    raw = await fetchJson(RELEASES_URL, {
      fetch: opts.fetch,
      policy: GITHUB_API,
      headers: { ...GITHUB_HEADERS },
      maxBytes: MAX_RELEASES_BYTES,
      ...(opts.signal ? { signal: opts.signal } : {})
    })
  } catch (err) {
    if (err instanceof HttpStatusError && (err.status === 403 || err.status === 429)) {
      throw new RateLimitedError(rateLimitResetAt(err.headers, opts.now))
    }
    throw err
  }
  return parseReleases(raw)
}

export interface PickedRelease {
  release: FeedRelease
  /** The tag without its `v`. */
  version: string
}

/**
 * The newest release on `channel` that is newer than `current` and carries both
 * manifest files. Drafts never count; the stable channel drops releases GitHub
 * marks as prereleases and pre-release versions alike. A release without its
 * manifest files is ignored (it may still be uploading, or predate the feed).
 */
export function pickRelease(
  releases: readonly FeedRelease[],
  opts: { channel: 'stable' | 'pre-release'; current: string; compare: CompareVersions }
): PickedRelease | null {
  let best: PickedRelease | null = null
  for (const release of releases) {
    if (release.draft) continue
    if (opts.channel === 'stable' && release.prerelease) continue
    if (!release.tag.startsWith('v')) continue
    const version = release.tag.slice(1)
    if (!isReleaseVersion(version)) continue
    if (opts.channel === 'stable' && version.includes('-')) continue
    if (opts.compare(version, opts.current) <= 0) continue
    const names = new Set(release.assets.map((a) => a.name))
    if (!names.has(UPDATE_MANIFEST_FILE) || !names.has(UPDATE_MANIFEST_SIG_FILE)) continue
    if (!best || opts.compare(version, best.version) > 0) best = { release, version }
  }
  return best
}

export interface ManifestFiles {
  manifestBytes: Buffer
  sigText: string
}

/** The release's `update-manifest.json` and `.sig`, each capped at 64 KiB. */
export async function fetchManifestFiles(
  release: FeedRelease,
  opts: FeedFetchOptions
): Promise<ManifestFiles> {
  const urlOf = (name: string): string => {
    const asset = release.assets.find((a) => a.name === name)
    if (!asset) throw new DownloadError(`${release.tag} has no ${name}`)
    return asset.url
  }
  const request = {
    fetch: opts.fetch,
    policy: GITHUB_RELEASES,
    headers: { 'User-Agent': GITHUB_HEADERS['User-Agent'] },
    maxBytes: MAX_MANIFEST_BYTES,
    ...(opts.signal ? { signal: opts.signal } : {})
  }
  const [manifestBytes, sigText] = await Promise.all([
    fetchBytes(urlOf(UPDATE_MANIFEST_FILE), request),
    fetchText(urlOf(UPDATE_MANIFEST_SIG_FILE), request)
  ])
  return { manifestBytes, sigText }
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/
const ED25519_SIGNATURE_BYTES = 64

/** The id of the first pinned Ed25519 key that verifies `sigText` over `bytes`, or null. */
export function verifySignature(
  bytes: Uint8Array,
  sigText: string,
  keys: readonly PinnedKey[]
): string | null {
  const text = sigText.trim()
  if (!BASE64_RE.test(text)) return null
  const sig = Buffer.from(text, 'base64')
  if (sig.length !== ED25519_SIGNATURE_BYTES) return null
  for (const k of keys) {
    try {
      const key = createPublicKey({
        key: Buffer.from(k.spki, 'base64'),
        format: 'der',
        type: 'spki'
      })
      if (key.asymmetricKeyType !== 'ed25519') continue
      if (verify(null, bytes, key, sig)) return k.id
    } catch {
      // A malformed pinned key verifies nothing.
    }
  }
  return null
}

export interface VerifyManifestInput {
  manifestBytes: Uint8Array
  sigText: string
  keys: readonly PinnedKey[]
  release: FeedRelease
  channel: 'stable' | 'pre-release'
  /** The running build's comparison version. */
  current: string
  target: UpdateTarget
  compare?: CompareVersions
}

export type VerifyManifestResult =
  | {
      ok: true
      manifest: UpdateManifest
      asset: UpdateAsset
      /** The release's own download link for `asset.name`. */
      assetUrl: string
      keyId: string
    }
  | { ok: false; reason: string }

/**
 * Every check a release must pass before anything is downloaded, in order; the
 * first failure is the answer, each with its own reason.
 */
export function verifyManifest(input: VerifyManifestInput): VerifyManifestResult {
  const compare = input.compare ?? compareVersions
  const fail = (reason: string): VerifyManifestResult => ({ ok: false, reason })
  if (input.keys.length === 0) return fail('no update signing key is pinned in this build')
  const keyId = verifySignature(input.manifestBytes, input.sigText, input.keys)
  if (keyId === null)
    return fail('the update manifest signature does not verify under a pinned key')
  let manifest: UpdateManifest | null
  try {
    manifest = parseManifest(JSON.parse(Buffer.from(input.manifestBytes).toString('utf8')))
  } catch {
    manifest = null
  }
  if (!manifest) return fail('the update manifest is malformed')
  const { release } = input
  if (manifest.tag !== release.tag)
    return fail(`the update manifest is for ${manifest.tag}, not the release ${release.tag}`)
  if (manifest.version !== manifest.tag.slice(1))
    return fail(`the update manifest's version ${manifest.version} does not match its tag`)
  if (input.channel === 'stable' && manifest.channel !== 'stable')
    return fail(`${manifest.version} is a pre-release, and this build follows the stable channel`)
  if (compare(manifest.version, input.current) <= 0)
    return fail(`${manifest.version} is not newer than the running version ${input.current}`)
  const asset = manifest.assets[input.target]
  if (!asset) return fail(`${manifest.version} has no ${input.target} build`)
  if (asset.size > MAX_ASSET_BYTES)
    return fail(`the ${input.target} build is ${asset.size} bytes, over the 1 GiB limit`)
  const listed = release.assets.find((a) => a.name === asset.name)
  if (!listed) return fail(`the release does not list ${asset.name}`)
  try {
    checkUrl(listed.url, GITHUB_RELEASES.hosts)
  } catch {
    return fail(`the release's link for ${asset.name} is not a github.com download`)
  }
  return { ok: true, manifest, asset, assetUrl: listed.url, keyId }
}

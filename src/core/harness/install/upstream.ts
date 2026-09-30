/**
 * What upstream has released (ADR-082 §4, §6), for "Latest" and the version
 * dropdown:
 *
 *   opencode  the npm registry's abbreviated document of this host's platform
 *             package (`opencode-<os>-<arch>`), so every version listed has a
 *             binary for this host; deprecated versions are skipped
 *   pi        GitHub's release list for `earendil-works/pi` (the newest 100),
 *             not drafts or prereleases, and only releases that carry this
 *             host's asset and `SHA256SUMS`
 *   Codex     the manifest's tested version, always (ClaudeUI's Codex is
 *             locked to the pin, ADR-082 §2); no network
 *   Claude    nothing (Claude Code has no ClaudeUI-managed copy)
 *
 * Only stable versions (`x.y.z`) at or above the floor and below the ceiling
 * are listed, newest first. Answers are cached in memory for an hour, and a
 * failure for five minutes. Errors are logged and answered with null or an
 * empty list; nothing here throws.
 */
import type { HarnessId, HarnessManifest } from '../../../shared/harness-types'
import { logger } from '../../services/logger'
import { pickNetFetch } from '../../services/net-fetch'
import { harnessManifest } from '../manifests'
import { compareVersions } from '../store'
import { GITHUB_API, NPM_REGISTRY, fetchJson } from './download'
import { opencodePlatformKey, piPlatformKey } from './sources'

export const UPSTREAM_TTL_MS = 60 * 60 * 1000
export const UPSTREAM_FAILURE_TTL_MS = 5 * 60 * 1000
const MAX_METADATA_BYTES = 64 * 1024 * 1024

const STABLE = /^\d+\.\d+\.\d+$/

export interface UpstreamDeps {
  fetch?: () => Promise<typeof fetch>
  manifest?: (id: HarnessId) => HarnessManifest
  now?: () => number
  platform?: string
  arch?: string
}

export interface Upstream {
  /** The newest installable version, or null when it cannot be told. */
  latestVersion(id: HarnessId): Promise<string | null>
  /** Installable versions, newest first, at most `limit`. */
  availableVersions(id: HarnessId, limit?: number): Promise<string[]>
}

function inRange(manifest: HarnessManifest, version: string): boolean {
  return (
    STABLE.test(version) &&
    compareVersions(version, manifest.floor) >= 0 &&
    compareVersions(version, manifest.ceiling) < 0
  )
}

function newestFirst(manifest: HarnessManifest, versions: Iterable<string>): string[] {
  return [...new Set(versions)]
    .filter((v) => inRange(manifest, v))
    .sort((a, b) => compareVersions(b, a))
}

export function createUpstream(deps: UpstreamDeps = {}): Upstream {
  const getFetch = deps.fetch ?? (() => pickNetFetch())
  const manifestOf = deps.manifest ?? harnessManifest
  const now = deps.now ?? Date.now
  const platform = deps.platform ?? process.platform
  const arch = deps.arch ?? process.arch

  const cache = new Map<HarnessId, { at: number; versions: string[] | null }>()
  const inflight = new Map<HarnessId, Promise<string[] | null>>()

  async function opencodeVersions(manifest: HarnessManifest): Promise<string[]> {
    const key = opencodePlatformKey(platform, arch)
    const pkg =
      key && Object.hasOwn(manifest.platforms, key) ? manifest.platforms[key].package : null
    if (typeof pkg !== 'string') throw new Error(`no opencode package for ${platform}-${arch}`)
    const doc = await fetchJson(`https://registry.npmjs.org/${pkg}`, {
      fetch: await getFetch(),
      policy: NPM_REGISTRY,
      headers: { Accept: 'application/vnd.npm.install-v1+json' },
      maxBytes: MAX_METADATA_BYTES
    })
    const versions = (doc as { versions?: unknown } | null)?.versions
    if (!versions || typeof versions !== 'object') throw new Error(`${pkg} lists no versions`)
    return Object.entries(versions as Record<string, unknown>)
      .filter(([, meta]) => !(meta as { deprecated?: unknown } | null)?.deprecated)
      .map(([version]) => version)
  }

  async function piVersions(manifest: HarnessManifest): Promise<string[]> {
    const key = piPlatformKey(platform, arch)
    const asset = Object.hasOwn(manifest.platforms, key) ? manifest.platforms[key].asset : null
    if (typeof asset !== 'string') throw new Error(`no pi asset for ${key}`)
    const releases = await fetchJson(
      'https://api.github.com/repos/earendil-works/pi/releases?per_page=100',
      {
        fetch: await getFetch(),
        policy: GITHUB_API,
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ClaudeUI' },
        maxBytes: MAX_METADATA_BYTES
      }
    )
    if (!Array.isArray(releases)) throw new Error('the GitHub release list is not a list')
    const versions: string[] = []
    for (const r of releases as Array<Record<string, unknown> | null>) {
      if (!r || r.draft !== false || r.prerelease !== false) continue
      const tag = r.tag_name
      if (typeof tag !== 'string' || !tag.startsWith('v')) continue
      const names = Array.isArray(r.assets)
        ? (r.assets as Array<{ name?: unknown } | null>).map((a) => a?.name)
        : []
      if (names.includes(asset) && names.includes('SHA256SUMS')) versions.push(tag.slice(1))
    }
    return versions
  }

  async function load(id: HarnessId): Promise<string[] | null> {
    const manifest = manifestOf(id)
    try {
      if (id === 'codex') return [manifest.tested]
      if (id === 'opencode') return newestFirst(manifest, await opencodeVersions(manifest))
      if (id === 'pi') return newestFirst(manifest, await piVersions(manifest))
      return []
    } catch (err) {
      logger.warn(
        'harness',
        `could not read ${id}'s upstream versions: ${err instanceof Error ? err.message : String(err)}`
      )
      return null
    }
  }

  function versions(id: HarnessId): Promise<string[] | null> {
    const hit = cache.get(id)
    if (hit) {
      const ttl = hit.versions === null ? UPSTREAM_FAILURE_TTL_MS : UPSTREAM_TTL_MS
      if (now() - hit.at < ttl) return Promise.resolve(hit.versions)
    }
    const pending = inflight.get(id)
    if (pending) return pending
    const next = load(id).then((result) => {
      cache.set(id, { at: now(), versions: result })
      inflight.delete(id)
      return result
    })
    inflight.set(id, next)
    return next
  }

  return {
    async latestVersion(id) {
      return (await versions(id))?.[0] ?? null
    },
    async availableVersions(id, limit = 20) {
      return ((await versions(id)) ?? []).slice(0, Math.max(0, limit))
    }
  }
}

const defaultUpstream = createUpstream()

/** The newest installable upstream version of `id`, or null. Never throws. */
export function latestVersion(id: HarnessId): Promise<string | null> {
  return defaultUpstream.latestVersion(id)
}

/** Installable upstream versions of `id`, newest first. Never throws. */
export function availableVersions(id: HarnessId, limit?: number): Promise<string[]> {
  return defaultUpstream.availableVersions(id, limit)
}

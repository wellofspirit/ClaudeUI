/**
 * @vitest-environment node
 *
 * Upstream versions (ADR-082 §4, §6): stable only, within [floor, ceiling),
 * newest first, cached; errors answer null / [] and never throw. `fetch` is a
 * fake.
 */
import { describe, expect, it, vi } from 'vitest'
import type { HarnessId, HarnessManifest } from '../../../../shared/harness-types'
import { harnessManifest } from '../../manifests'
import { UPSTREAM_FAILURE_TTL_MS, UPSTREAM_TTL_MS, createUpstream } from '../upstream'
import { fakeFetch, type Route } from './fixtures'

const OPENCODE: HarnessManifest = {
  id: 'opencode',
  tested: '2.0.24',
  floor: '2.0.20',
  ceiling: '3.0.0',
  platforms: { 'linux-x64': { package: '@opencode/cli-linux-x64' } }
}
const PI: HarnessManifest = {
  id: 'pi',
  tested: '0.87.1',
  floor: '0.87.1',
  ceiling: '1.0.0',
  platforms: { 'linux-x64': { asset: 'pi-linux-x64.tar.gz' } }
}
// npm's escaped form of a scoped package name.
const REGISTRY = 'https://registry.npmjs.org/@opencode%2fcli-linux-x64'
const RELEASES = 'https://api.github.com/repos/earendil-works/pi/releases?per_page=100'

function upstream(routes: Record<string, Route>, now = { t: 0 }) {
  const f = fakeFetch(routes)
  const u = createUpstream({
    fetch: async () => f.fetch,
    manifest: (id: HarnessId) =>
      id === 'opencode' ? OPENCODE : id === 'pi' ? PI : harnessManifest(id),
    now: () => now.t,
    platform: 'linux',
    arch: 'x64'
  })
  return { u, f, now }
}

const opencodeDoc = {
  body: JSON.stringify({
    versions: {
      '1.18.34': {},
      '2.0.18': {},
      '2.0.20': {},
      '2.0.24': {},
      '2.0.25': {},
      '2.0.26': { deprecated: 'broken' },
      '2.1.0-beta.1': {},
      '0.0.0-dev-20640': {},
      '3.0.0': {},
      '3.1.0': {}
    }
  })
}

function release(tag: string, extra: Record<string, unknown> = {}) {
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    assets: [{ name: 'pi-linux-x64.tar.gz' }, { name: 'SHA256SUMS' }],
    ...extra
  }
}

describe('opencode', () => {
  it('lists stable, non-deprecated versions in [floor, ceiling), newest first', async () => {
    const { u, f } = upstream({ [REGISTRY]: opencodeDoc })
    expect(await u.latestVersion('opencode')).toBe('2.0.25')
    expect(await u.availableVersions('opencode')).toEqual(['2.0.25', '2.0.24', '2.0.20'])
    expect(await u.availableVersions('opencode', 2)).toEqual(['2.0.25', '2.0.24'])
    // One request serves every call within the hour.
    expect(f.calls).toEqual([REGISTRY])
  })

  it('asks for the abbreviated registry document', async () => {
    let accept: string | null = null
    const { u } = upstream({
      [REGISTRY]: (init) => {
        accept = new Headers(init?.headers).get('accept')
        return new Response(opencodeDoc.body)
      }
    })
    await u.latestVersion('opencode')
    expect(accept).toBe('application/vnd.npm.install-v1+json')
  })
})

describe('opencode package names', () => {
  it('reads only an @opencode/cli-* platform package (never 1.x’s opencode-<plat>)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const f = fakeFetch({})
    const u = createUpstream({
      fetch: async () => f.fetch,
      manifest: (id: HarnessId) =>
        id === 'opencode'
          ? { ...OPENCODE, platforms: { 'linux-x64': { package: 'opencode-linux-x64' } } }
          : harnessManifest(id),
      platform: 'linux',
      arch: 'x64'
    })
    expect(await u.latestVersion('opencode')).toBeNull()
    expect(f.calls).toEqual([])
    warn.mockRestore()
  })
})

describe('pi', () => {
  it('skips drafts, prereleases and releases without this host’s asset', async () => {
    const { u } = upstream({
      [RELEASES]: {
        body: JSON.stringify([
          release('v1.0.0'),
          release('v0.99.2', { prerelease: true }),
          release('v0.99.1', { draft: true }),
          release('v0.99.0', { assets: [{ name: 'SHA256SUMS' }] }),
          release('v0.98.0'),
          release('v0.87.1'),
          release('v0.86.0'),
          release('nightly')
        ])
      }
    })
    expect(await u.latestVersion('pi')).toBe('0.98.0')
    expect(await u.availableVersions('pi')).toEqual(['0.98.0', '0.87.1'])
  })
})

describe('Codex and Claude Code', () => {
  it('answers Codex with the pin and Claude Code with nothing, without a request', async () => {
    const { u, f } = upstream({})
    expect(await u.latestVersion('codex')).toBe(harnessManifest('codex').tested)
    expect(await u.availableVersions('codex')).toEqual([harnessManifest('codex').tested])
    expect(await u.latestVersion('claude')).toBeNull()
    expect(await u.availableVersions('claude')).toEqual([])
    expect(f.calls).toEqual([])
  })
})

describe('caching and failures', () => {
  it('refreshes after an hour', async () => {
    const { u, f, now } = upstream({ [REGISTRY]: opencodeDoc })
    await u.latestVersion('opencode')
    now.t += UPSTREAM_TTL_MS - 1
    await u.latestVersion('opencode')
    expect(f.calls).toHaveLength(1)
    now.t += 1
    await u.latestVersion('opencode')
    expect(f.calls).toHaveLength(2)
  })

  it('a caller may ask for a younger answer (Check now), which also refreshes the cache', async () => {
    const { u, f, now } = upstream({ [REGISTRY]: opencodeDoc })
    await u.latestVersion('opencode')
    now.t += 30_000
    await u.latestVersion('opencode', { maxAgeMs: 60_000 })
    expect(f.calls).toHaveLength(1)
    now.t += 30_000
    await u.latestVersion('opencode', { maxAgeMs: 60_000 })
    expect(f.calls).toHaveLength(2)
    // The fresh answer serves later callers for the usual hour.
    now.t += UPSTREAM_TTL_MS - 1
    await u.latestVersion('opencode')
    expect(f.calls).toHaveLength(2)
  })

  it('shares one request between concurrent calls', async () => {
    const { u, f } = upstream({ [REGISTRY]: opencodeDoc })
    await Promise.all([u.latestVersion('opencode'), u.availableVersions('opencode')])
    expect(f.calls).toHaveLength(1)
  })

  it('answers null on an error, logs why, and retries after five minutes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { u, f, now } = upstream({ [REGISTRY]: { status: 503, body: 'down' } })
    expect(await u.latestVersion('opencode')).toBeNull()
    expect(await u.availableVersions('opencode')).toEqual([])
    expect(f.calls).toHaveLength(1)
    now.t += UPSTREAM_FAILURE_TTL_MS
    f.routes.set(REGISTRY, opencodeDoc)
    expect(await u.latestVersion('opencode')).toBe('2.0.25')
    warn.mockRestore()
  })

  it('never throws on a malformed answer', async () => {
    const { u } = upstream({ [REGISTRY]: { body: '[]' }, [RELEASES]: { body: '{}' } })
    await expect(u.latestVersion('opencode')).resolves.toBeNull()
    await expect(u.latestVersion('pi')).resolves.toBeNull()
  })
})

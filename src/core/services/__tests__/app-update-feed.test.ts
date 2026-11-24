/**
 * @vitest-environment node
 *
 * The ClaudeUI update feed (auto-update design §2): which release a channel
 * picks, every check a signed manifest must pass before anything downloads, and
 * GitHub's rate limit read off the refusal. The key pair is made per run;
 * `fetch` is a fake. Nothing touches the network.
 */
import { describe, expect, it } from 'vitest'
import { UPDATE_MANIFEST_FILE, UPDATE_MANIFEST_SIG_FILE } from '../../../shared/update-manifest'
import { DownloadError } from '../../harness/install/download'
import { compareVersions } from '../../harness/store'
import { fakeFetch } from '../../harness/install/__tests__/fixtures'
import {
  MAX_ASSET_BYTES,
  RELEASES_URL,
  RateLimitedError,
  fetchManifestFiles,
  fetchReleases,
  parseReleases,
  pickRelease,
  rateLimitResetAt,
  verifyManifest,
  type FeedRelease,
  type VerifyManifestInput
} from '../app-update-feed'
import {
  TARGET,
  assetName,
  downloadUrl,
  makeKey,
  manifestFor,
  releaseJson,
  signed,
  signedBytes
} from './app-update-fixtures'

const KEY = makeKey()
const OTHER_KEY = makeKey('other')

const releases = (...entries: Record<string, unknown>[]): FeedRelease[] => parseReleases(entries)
const pick = (
  list: FeedRelease[],
  channel: 'stable' | 'pre-release' = 'stable',
  current = '1.0.0'
): string | null =>
  pickRelease(list, { channel, current, compare: compareVersions })?.version ?? null

describe('parseReleases', () => {
  it('reads the fields the feed uses and drops malformed entries', () => {
    const list = parseReleases([
      releaseJson('1.1.0'),
      null,
      { name: 'no tag' },
      { tag_name: 'v1.2.0', assets: [{ name: 'x' }, { browser_download_url: 'y' }, 7] }
    ])
    expect(list).toHaveLength(2)
    expect(list[0]).toEqual({
      tag: 'v1.1.0',
      draft: false,
      prerelease: false,
      assets: [
        { name: UPDATE_MANIFEST_FILE, url: downloadUrl('1.1.0', UPDATE_MANIFEST_FILE) },
        { name: UPDATE_MANIFEST_SIG_FILE, url: downloadUrl('1.1.0', UPDATE_MANIFEST_SIG_FILE) },
        { name: assetName('1.1.0'), url: downloadUrl('1.1.0', assetName('1.1.0')) }
      ]
    })
    // Missing flags count as a draft and a prerelease: never offered.
    expect(list[1]).toMatchObject({ tag: 'v1.2.0', draft: true, prerelease: true, assets: [] })
  })

  it('refuses an answer that is not a list', () => {
    expect(() => parseReleases({ message: 'Not Found' })).toThrow(DownloadError)
  })
})

describe('pickRelease', () => {
  it('drops drafts', () => {
    expect(pick(releases(releaseJson('1.2.0', { draft: true }), releaseJson('1.1.0')))).toBe(
      '1.1.0'
    )
  })

  it('drops prereleases on stable, by GitHub flag and by version, and takes them on pre-release', () => {
    const list = releases(
      releaseJson('1.3.0-pre.1'),
      releaseJson('1.2.0', { prerelease: true }),
      releaseJson('1.2.5-pre.2', { prerelease: false }),
      releaseJson('1.1.0')
    )
    expect(pick(list, 'stable')).toBe('1.1.0')
    expect(pick(list, 'pre-release')).toBe('1.3.0-pre.1')
  })

  it('needs a tag of v plus a release version', () => {
    const list = releases(
      releaseJson('1.5.0', { tag: '1.5.0' }),
      releaseJson('1.4.0', { tag: 'v1.4' }),
      releaseJson('1.3.0', { tag: 'v1.3.0-beta.1' }),
      releaseJson('1.2.0', { tag: 'v1.2.0+build' }),
      releaseJson('1.1.0')
    )
    expect(pick(list, 'pre-release')).toBe('1.1.0')
  })

  it('offers only versions newer than the running one', () => {
    expect(pick(releases(releaseJson('1.0.0'), releaseJson('0.9.0')))).toBeNull()
    expect(pick(releases(releaseJson('1.0.0-pre.3')), 'pre-release', '1.0.0')).toBeNull()
    expect(pick(releases(releaseJson('1.0.0')), 'pre-release', '1.0.0-pre.3')).toBe('1.0.0')
  })

  it('ignores a release without both manifest files', () => {
    const list = releases(
      releaseJson('1.3.0', { assets: [UPDATE_MANIFEST_FILE, assetName('1.3.0')] }),
      releaseJson('1.2.0', { assets: [UPDATE_MANIFEST_SIG_FILE, assetName('1.2.0')] }),
      releaseJson('1.1.0')
    )
    expect(pick(list)).toBe('1.1.0')
  })

  it('takes the highest version, whatever the order (pre.13 above pre.2)', () => {
    const list = releases(
      releaseJson('1.1.0-pre.2'),
      releaseJson('1.1.0-pre.13'),
      releaseJson('1.0.5'),
      releaseJson('1.1.0-pre.9')
    )
    expect(pick(list, 'pre-release')).toBe('1.1.0-pre.13')
    expect(pick(list, 'stable')).toBe('1.0.5')
  })
})

describe('verifyManifest', () => {
  const release = releases(releaseJson('1.1.0'))[0]
  const input = (patch: Partial<VerifyManifestInput> = {}): VerifyManifestInput => ({
    ...signed(manifestFor('1.1.0'), KEY),
    keys: [KEY.key],
    release,
    channel: 'stable',
    current: '1.0.0',
    target: TARGET,
    ...patch
  })
  const reason = (patch: Partial<VerifyManifestInput>): string => {
    const r = verifyManifest(input(patch))
    if (r.ok) throw new Error('expected a refusal')
    return r.reason
  }

  it('accepts a signed manifest and answers the asset and the release link for it', () => {
    const r = verifyManifest(input())
    expect(r).toMatchObject({
      ok: true,
      keyId: 'test-key',
      asset: manifestFor('1.1.0').assets[TARGET],
      assetUrl: downloadUrl('1.1.0', assetName('1.1.0'))
    })
  })

  it('accepts under any pinned key (a rotation)', () => {
    expect(verifyManifest(input({ keys: [OTHER_KEY.key, KEY.key] }))).toMatchObject({
      ok: true,
      keyId: 'test-key'
    })
  })

  it('refuses a tampered byte', () => {
    const { manifestBytes, sigText } = signed(manifestFor('1.1.0'), KEY)
    const tampered = Buffer.from(manifestBytes)
    tampered[tampered.length - 5] ^= 1
    expect(reason({ manifestBytes: tampered, sigText })).toMatch(/signature does not verify/)
  })

  it('refuses a signature by a key that is not pinned', () => {
    expect(reason({ ...signed(manifestFor('1.1.0'), OTHER_KEY) })).toMatch(
      /signature does not verify/
    )
  })

  it('refuses a malformed signature and a malformed pinned key', () => {
    expect(reason({ sigText: 'not base64!' })).toMatch(/signature does not verify/)
    expect(reason({ sigText: Buffer.alloc(10).toString('base64') })).toMatch(
      /signature does not verify/
    )
    expect(reason({ keys: [{ id: 'bad', spki: 'AAAA' }] })).toMatch(/signature does not verify/)
  })

  it('refuses everything when no key is pinned', () => {
    expect(reason({ keys: [] })).toBe('no update signing key is pinned in this build')
  })

  it('refuses signed bytes that are not a manifest', () => {
    const schema2 = Buffer.from(JSON.stringify({ ...manifestFor('1.1.0'), schema: 2 }))
    expect(reason(signedBytes(schema2, KEY))).toBe('the update manifest is malformed')
    expect(reason(signedBytes(Buffer.from('not json'), KEY))).toBe(
      'the update manifest is malformed'
    )
  })

  it("refuses another release's manifest (tag mismatch)", () => {
    expect(reason(signed(manifestFor('1.2.0'), KEY))).toMatch(
      /manifest is for v1\.2\.0, not the release v1\.1\.0/
    )
  })

  it('refuses a version that does not match the tag', () => {
    expect(reason(signed(manifestFor('1.1.1', { tag: 'v1.1.0' }), KEY))).toMatch(
      /version 1\.1\.1 does not match its tag/
    )
  })

  it('refuses a pre-release manifest on the stable channel', () => {
    const pre = signed(manifestFor('1.1.0', { channel: 'pre-release' }), KEY)
    expect(reason(pre)).toMatch(/is a pre-release, and this build follows the stable channel/)
    expect(verifyManifest(input({ ...pre, channel: 'pre-release' })).ok).toBe(true)
  })

  it('refuses a downgrade and the same version (no replay of an old manifest)', () => {
    expect(reason({ current: '1.1.0' })).toMatch(/not newer than the running version 1\.1\.0/)
    expect(reason({ current: '1.2.0' })).toMatch(/not newer than the running version 1\.2\.0/)
  })

  it('refuses a manifest with no build for this target', () => {
    expect(reason({ target: 'desktop-win32-x64' })).toBe('1.1.0 has no desktop-win32-x64 build')
  })

  it('refuses an asset over 1 GiB', () => {
    const big = manifestFor('1.1.0')
    big.assets[TARGET] = { ...big.assets[TARGET]!, size: MAX_ASSET_BYTES + 1 }
    expect(reason(signed(big, KEY))).toMatch(/over the 1 GiB limit/)
  })

  it('refuses an asset name the release does not list', () => {
    const other = releases(
      releaseJson('1.1.0', { assets: [UPDATE_MANIFEST_FILE, UPDATE_MANIFEST_SIG_FILE] })
    )[0]
    expect(reason({ release: other })).toBe(`the release does not list ${assetName('1.1.0')}`)
  })

  it('refuses a release link that is not a github.com download', () => {
    const moved: FeedRelease = {
      ...release,
      assets: release.assets.map((a) =>
        a.name === assetName('1.1.0') ? { ...a, url: 'https://evil.test/x.zip' } : a
      )
    }
    expect(reason({ release: moved })).toMatch(/not a github\.com download/)
  })
})

describe('rateLimitResetAt', () => {
  const NOW = 1_000_000
  const headers = (h: Record<string, string>): Headers => new Headers(h)

  it('prefers retry-after, in seconds or as a date', () => {
    expect(rateLimitResetAt(headers({ 'retry-after': '60', 'x-ratelimit-reset': '5' }), NOW)).toBe(
      NOW + 60_000
    )
    expect(rateLimitResetAt(headers({ 'retry-after': 'Wed, 25 Nov 2026 10:00:00 GMT' }), NOW)).toBe(
      Date.parse('2026-11-25T10:00:00Z')
    )
  })

  it('falls back to x-ratelimit-reset (epoch seconds), else null', () => {
    expect(rateLimitResetAt(headers({ 'x-ratelimit-reset': '1800000000' }), NOW)).toBe(
      1_800_000_000_000
    )
    expect(rateLimitResetAt(headers({ 'x-ratelimit-reset': 'soon' }), NOW)).toBeNull()
    expect(rateLimitResetAt(headers({}), NOW)).toBeNull()
  })
})

describe('fetchReleases', () => {
  it('asks the API for the newest 30 with GitHub headers', async () => {
    let sent: Headers | undefined
    const f = fakeFetch({
      [RELEASES_URL]: (init) => {
        sent = new Headers(init?.headers)
        return new Response(JSON.stringify([releaseJson('1.1.0')]), { status: 200 })
      }
    })
    const list = await fetchReleases({ fetch: f.fetch, now: 0 })
    expect(RELEASES_URL).toBe(
      'https://api.github.com/repos/wellofspirit/ClaudeUI/releases?per_page=30'
    )
    expect(list.map((r) => r.tag)).toEqual(['v1.1.0'])
    expect(sent?.get('accept')).toBe('application/vnd.github+json')
    expect(sent?.get('user-agent')).toBe('ClaudeUI')
  })

  it.each([403, 429])('turns HTTP %s into a rate limit with its reset time', async (status) => {
    const f = fakeFetch({
      [RELEASES_URL]: { status, body: '{}', headers: { 'x-ratelimit-reset': '1800000000' } }
    })
    const err = await fetchReleases({ fetch: f.fetch, now: 0 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RateLimitedError)
    expect((err as RateLimitedError).resetAt).toBe(1_800_000_000_000)
  })

  it('leaves any other failure a download error', async () => {
    const f = fakeFetch({ [RELEASES_URL]: { status: 500, body: 'oops' } })
    const err = await fetchReleases({ fetch: f.fetch, now: 0 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DownloadError)
    expect(err).not.toBeInstanceOf(RateLimitedError)
  })
})

describe('fetchManifestFiles', () => {
  it("fetches the release's own manifest and signature links", async () => {
    const pair = signed(manifestFor('1.1.0'), KEY)
    const f = fakeFetch({
      [downloadUrl('1.1.0', UPDATE_MANIFEST_FILE)]: { body: pair.manifestBytes },
      [downloadUrl('1.1.0', UPDATE_MANIFEST_SIG_FILE)]: { body: pair.sigText }
    })
    const got = await fetchManifestFiles(releases(releaseJson('1.1.0'))[0], { fetch: f.fetch })
    expect(got.manifestBytes.equals(pair.manifestBytes)).toBe(true)
    expect(got.sigText).toBe(pair.sigText)
  })

  it('caps each file at 64 KiB', async () => {
    const f = fakeFetch({
      [downloadUrl('1.1.0', UPDATE_MANIFEST_FILE)]: { body: Buffer.alloc(64 * 1024 + 1) },
      [downloadUrl('1.1.0', UPDATE_MANIFEST_SIG_FILE)]: { body: 'sig' }
    })
    await expect(
      fetchManifestFiles(releases(releaseJson('1.1.0'))[0], { fetch: f.fetch })
    ).rejects.toThrow(/byte limit/)
  })
})

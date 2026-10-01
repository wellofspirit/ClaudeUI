/**
 * @vitest-environment node
 *
 * The managed harness installer end to end (ADR-082 §4), against a fake
 * `fetch` serving archives built in the test, a fake `--version` probe, and a
 * temp store (`CLAUDEUI_HARNESS_STORE`). The manifests are the real ones with
 * this host's digests replaced by the fixtures', so the reviewed-digest
 * checks run exactly as in production.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { HarnessId, HarnessLaunch, HarnessManifest } from '../../../../shared/harness-types'
import { setHostPaths } from '../../../host'
import type { ProbeResult } from '../../detect/probe'
import { harnessManifest } from '../../manifests'
import { invalidateHarness, resolveHarness } from '../../resolve'
import { harnessesConfigPath } from '../../selection-store'
import { HARNESS_STORE_ENV, LAST_USED_FILE, readInstallRecord } from '../../store'
import { createInstaller, type InstallerDeps, type InstallProgress } from '../installer'
import { opencodePlatformKey, piPlatformKey } from '../sources'
import { STAGING_DIR, TRASH_DIR } from '../store-writer'
import {
  fakeFetch,
  hangingBody,
  sha256,
  sha512b64,
  tarEntry,
  tgz,
  zip,
  type FakeFetch
} from './fixtures'

const WIN = process.platform === 'win32'
const exe = (base: string): string => (WIN ? `${base}.exe` : base)
const HOST = `${process.platform}-${process.arch}`

let tmp: string
let store: string
let savedStore: string | undefined

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-install-'))
  store = path.join(tmp, 'store')
  savedStore = process.env[HARNESS_STORE_ENV]
  process.env[HARNESS_STORE_ENV] = store
  // An app root with no vendored harnesses, so the resolver's fallback is empty.
  setHostPaths({ getAppPath: () => path.join(tmp, 'app') })
  fs.rmSync(harnessesConfigPath(), { force: true })
  invalidateHarness()
})

afterEach(() => {
  setHostPaths(null)
  if (savedStore === undefined) delete process.env[HARNESS_STORE_ENV]
  else process.env[HARNESS_STORE_ENV] = savedStore
  fs.rmSync(harnessesConfigPath(), { force: true })
  fs.rmSync(tmp, { recursive: true, force: true })
  invalidateHarness()
})

/** The next patch release after `version`: in range, not tested. */
function untested(version: string): string {
  const [major, minor, patch] = version.split('.').map(Number)
  return `${major}.${minor}.${patch + 7}`
}

function okProbe(version: string): { calls: HarnessLaunch[]; probe: InstallerDeps['probe'] } {
  const calls: HarnessLaunch[] = []
  return {
    calls,
    probe: async (_id, launch): Promise<ProbeResult> => {
      calls.push(launch)
      return { status: 'ok', version }
    }
  }
}

/** The store's directories other than `.staging`/`.trash`, and what those two hold. */
function storeState(): { versions: string[]; staging: string[]; trash: string[] } {
  const list = (dir: string): string[] => {
    try {
      return fs.readdirSync(dir).sort()
    } catch {
      return []
    }
  }
  const versions: string[] = []
  for (const id of list(store)) {
    if (id === STAGING_DIR || id === TRASH_DIR) continue
    for (const v of list(path.join(store, id))) versions.push(`${id}/${v}`)
  }
  return {
    versions,
    staging: list(path.join(store, STAGING_DIR)),
    trash: list(path.join(store, TRASH_DIR))
  }
}

function withPlatforms(id: HarnessId, platforms: HarnessManifest['platforms']): HarnessManifest {
  return { ...harnessManifest(id), platforms }
}

// ── opencode ──────────────────────────────────────────────────────────────────

const OC_KEY = opencodePlatformKey(process.platform, process.arch)
const OC_PKG = OC_KEY ? (harnessManifest('opencode').platforms[OC_KEY]?.package as string) : ''
const OC_TESTED = harnessManifest('opencode').tested

interface OpencodeFixture {
  f: FakeFetch
  manifest: HarnessManifest
  bin: Buffer
  tarball: Buffer
}

function opencodeFixture(
  version: string,
  opts: { reviewedIntegrity?: string; reviewedBinary?: string; npmIntegrity?: string } = {}
): OpencodeFixture {
  const bin = Buffer.from(`opencode ${version} binary`)
  const tarball = tgz([
    tarEntry('package/package.json', '{}'),
    tarEntry(`package/bin/${exe('opencode')}`, bin, { mode: 0o755 })
  ])
  const integrity = `sha512-${sha512b64(tarball)}`
  const tarballUrl = `https://registry.npmjs.org/${OC_PKG}/-/${OC_PKG}-${version}.tgz`
  const f = fakeFetch({
    [`https://registry.npmjs.org/${OC_PKG}/${version}`]: {
      body: JSON.stringify({
        dist: { tarball: tarballUrl, integrity: opts.npmIntegrity ?? integrity }
      })
    },
    [tarballUrl]: { body: tarball }
  })
  const manifest = withPlatforms('opencode', {
    [OC_KEY as string]: {
      package: OC_PKG,
      integrity: opts.reviewedIntegrity ?? integrity,
      binarySha256: opts.reviewedBinary ?? sha256(bin)
    }
  })
  return { f, manifest, bin, tarball }
}

function installerFor(
  fixture: { f: FakeFetch; manifest: HarnessManifest },
  version: string,
  extra: Partial<InstallerDeps> = {}
): ReturnType<typeof createInstaller> {
  return createInstaller({
    fetch: async () => fixture.f.fetch,
    manifest: (id) => (id === fixture.manifest.id ? fixture.manifest : harnessManifest(id)),
    probe: okProbe(version).probe,
    invalidate: () => {},
    ...extra
  })
}

describe.skipIf(!OC_KEY)('opencode', () => {
  it('installs the tested version as reviewed, in the resolver layout, with install.json', async () => {
    const fx = opencodeFixture(OC_TESTED)
    const probe = okProbe(OC_TESTED)
    const invalidated: HarnessId[] = []
    const installer = installerFor(fx, OC_TESTED, {
      probe: probe.probe,
      invalidate: (id) => invalidated.push(id)
    })
    const result = await installer.installHarness('opencode', 'tested')
    expect(result).toEqual({
      status: 'installed',
      id: 'opencode',
      version: OC_TESTED,
      verified: 'reviewed'
    })

    const dir = path.join(store, 'opencode', OC_TESTED)
    expect(fs.readdirSync(dir).sort()).toEqual([exe('opencode'), 'install.json'].sort())
    expect(fs.readFileSync(path.join(dir, exe('opencode')))).toEqual(fx.bin)
    expect(readInstallRecord('opencode', OC_TESTED)).toMatchObject({ verified: 'reviewed' })
    expect(storeState()).toEqual({
      versions: [`opencode/${OC_TESTED}`],
      staging: [],
      trash: []
    })
    // `--version` was asked of the staged binary, before it was published.
    expect(probe.calls).toHaveLength(1)
    expect(probe.calls[0].command).toContain(STAGING_DIR)
    expect(invalidated).toEqual(['opencode'])
  })

  it('installs another version as publisher-verified (npm integrity only)', async () => {
    const version = untested(OC_TESTED)
    // The reviewed digests are for some other build; they do not apply.
    const fx = opencodeFixture(version, {
      reviewedIntegrity: 'sha512-AAAA',
      reviewedBinary: 'b'.repeat(64)
    })
    const result = await installerFor(fx, version).installHarness('opencode', version)
    expect(result).toEqual({ status: 'installed', id: 'opencode', version, verified: 'publisher' })
  })

  it.each([
    [
      'the reviewed tarball integrity',
      { reviewedIntegrity: 'sha512-AAAA' },
      /does not match the reviewed sha512-AAAA/
    ],
    [
      'the reviewed binary SHA-256',
      { reviewedBinary: 'b'.repeat(64) },
      /binary SHA-256 \w+ does not match the reviewed b{64}/
    ],
    ["npm's integrity", { npmIntegrity: 'sha512-BBBB' }, /does not match npm's sha512-BBBB/]
  ])('fails when %s does not match, leaving nothing behind', async (_label, opts, reason) => {
    const fx = opencodeFixture(OC_TESTED, opts)
    const result = await installerFor(fx, OC_TESTED).installHarness('opencode', 'tested')
    expect(result.status).toBe('failed')
    expect(result.status === 'failed' && result.reason).toMatch(reason)
    expect(storeState()).toEqual({ versions: [], staging: [], trash: [] })
  })

  it('refuses a tarball URL off the registry', async () => {
    const fx = opencodeFixture(OC_TESTED)
    fx.f.routes.set(`https://registry.npmjs.org/${OC_PKG}/${OC_TESTED}`, {
      body: JSON.stringify({ dist: { tarball: 'https://evil.test/x.tgz', integrity: 'sha512-A' } })
    })
    const result = await installerFor(fx, OC_TESTED).installHarness('opencode', 'tested')
    expect(result.status === 'failed' && result.reason).toMatch(
      /outside https:\/\/registry\.npmjs\.org/
    )
    expect(fx.f.calls).not.toContain('https://evil.test/x.tgz')
  })

  it('fails when --version reports another version, or does not run', async () => {
    const fx = opencodeFixture(OC_TESTED)
    const wrong = await installerFor(fx, OC_TESTED, {
      probe: async () => ({ status: 'ok', version: '1.0.0' })
    }).installHarness('opencode', 'tested')
    expect(wrong.status === 'failed' && wrong.reason).toBe(
      `the downloaded opencode reports version 1.0.0, expected ${OC_TESTED}`
    )
    const broken = await installerFor(fx, OC_TESTED, {
      probe: async () => ({ status: 'failed', reason: 'could not start: EACCES' })
    }).installHarness('opencode', 'tested')
    expect(broken.status === 'failed' && broken.reason).toMatch(
      /did not run: could not start: EACCES/
    )
    expect(storeState()).toEqual({ versions: [], staging: [], trash: [] })
  })

  it('fails when the download is over the cap', async () => {
    const fx = opencodeFixture(OC_TESTED)
    const result = await installerFor(fx, OC_TESTED, { maxDownloadBytes: 64 }).installHarness(
      'opencode',
      'tested'
    )
    expect(result.status === 'failed' && result.reason).toMatch(/over the 64 byte limit/)
    expect(storeState()).toEqual({ versions: [], staging: [], trash: [] })
  })

  it('refuses versions outside [floor, ceiling) and non-versions without a request', async () => {
    const fx = opencodeFixture(OC_TESTED)
    const installer = installerFor(fx, OC_TESTED)
    const m = harnessManifest('opencode')
    for (const [version, reason] of [
      [m.ceiling, /not supported/],
      [`${m.ceiling.split('.')[0]}.0.0-beta.1`, /not supported/],
      ['0.0.1', /older than/],
      ['../../x', /not a version/]
    ] as const) {
      const result = await installer.installHarness('opencode', version)
      expect(result.status === 'failed' && result.reason).toMatch(reason)
    }
    expect(fx.f.calls).toEqual([])
  })

  it('installs `latest` as the upstream version it names', async () => {
    const version = untested(OC_TESTED)
    const fx = opencodeFixture(version)
    const result = await installerFor(fx, version, {
      latestVersion: async () => version
    }).installHarness('opencode', 'latest')
    expect(result).toMatchObject({ status: 'installed', version, verified: 'publisher' })
    const none = await installerFor(fx, version, {
      latestVersion: async () => null
    }).installHarness('opencode', 'latest')
    expect(none.status === 'failed' && none.reason).toBe(
      'Could not find the latest opencode release'
    )
  })

  it('reports each phase, and download progress', async () => {
    const fx = opencodeFixture(OC_TESTED)
    const installer = installerFor(fx, OC_TESTED)
    const seen: InstallProgress[] = []
    installer.onInstallProgress((p) => seen.push(p))
    await installer.installHarness('opencode', 'tested')
    const phases = seen.map((p) => p.phase).filter((p, i, all) => all[i - 1] !== p)
    expect(phases).toEqual([
      'resolving',
      'downloading',
      'verifying',
      'extracting',
      'verifying',
      'checking',
      'done'
    ])
    expect(Math.max(...seen.map((p) => p.receivedBytes ?? 0))).toBeGreaterThan(0)
    expect(installer.activeInstalls()).toEqual([])
  })

  it('satisfies an already valid install without downloading', async () => {
    const fx = opencodeFixture(OC_TESTED)
    await installerFor(fx, OC_TESTED).installHarness('opencode', 'tested')
    const calls = fx.f.calls.length
    const again = await installerFor(fx, OC_TESTED).installHarness('opencode', 'tested')
    expect(again).toEqual({
      status: 'installed',
      id: 'opencode',
      version: OC_TESTED,
      verified: 'reviewed'
    })
    expect(fx.f.calls.length).toBe(calls)
  })

  it('moves an invalid version directory aside and installs in its place', async () => {
    const dir = path.join(store, 'opencode', OC_TESTED)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'leftover'), 'partial')
    const fx = opencodeFixture(OC_TESTED)
    const result = await installerFor(fx, OC_TESTED).installHarness('opencode', 'tested')
    expect(result.status).toBe('installed')
    expect(fs.existsSync(path.join(dir, 'leftover'))).toBe(false)
    expect(readInstallRecord('opencode', OC_TESTED)).not.toBeNull()
    expect(storeState().trash).toEqual([])
  })

  it('shares one download between concurrent requests for the same version', async () => {
    const fx = opencodeFixture(OC_TESTED)
    const installer = installerFor(fx, OC_TESTED)
    const [a, b] = await Promise.all([
      installer.installHarness('opencode', 'tested'),
      installer.installHarness('opencode', OC_TESTED)
    ])
    expect(a).toEqual(b)
    expect(a.status).toBe('installed')
    expect(fx.f.calls.filter((u) => u.endsWith('.tgz'))).toHaveLength(1)
  })

  it('cancels on abort and removes its staging area', async () => {
    const fx = opencodeFixture(OC_TESTED)
    const controller = new AbortController()
    const tarballUrl = `https://registry.npmjs.org/${OC_PKG}/-/${OC_PKG}-${OC_TESTED}.tgz`
    // Abort once the first bytes are in the staging area.
    fx.f.routes.set(
      tarballUrl,
      hangingBody(fx.tarball.subarray(0, 10), () => setTimeout(() => controller.abort(), 10))
    )
    const installer = installerFor(fx, OC_TESTED)
    const result = await installer.installHarness('opencode', 'tested', {
      signal: controller.signal
    })
    expect(result).toEqual({
      status: 'failed',
      id: 'opencode',
      version: OC_TESTED,
      reason: 'The install was cancelled'
    })
    await vi.waitFor(() => expect(installer.activeInstalls()).toEqual([]))
    expect(storeState()).toEqual({ versions: [], staging: [], trash: [] })
  })

  it('keeps a shared install running while one caller without a signal still waits', async () => {
    const fx = opencodeFixture(OC_TESTED)
    const controller = new AbortController()
    const installer = installerFor(fx, OC_TESTED)
    const cancelledCall = installer.installHarness('opencode', 'tested', {
      signal: controller.signal
    })
    const patientCall = installer.installHarness('opencode', 'tested')
    controller.abort()
    expect(await cancelledCall).toMatchObject({
      status: 'failed',
      reason: 'The install was cancelled'
    })
    expect(await patientCall).toMatchObject({ status: 'installed', verified: 'reviewed' })
  })

  it('is what the resolver runs afterwards for a managed/tested selection', async () => {
    const fx = opencodeFixture(OC_TESTED)
    // The real invalidation, as in the app.
    const installer = installerFor(fx, OC_TESTED, { invalidate: (id) => invalidateHarness(id) })
    // Nothing is bundled (ADR-082 §8): before the install, nothing runs.
    expect(resolveHarness('opencode').path).toBeNull()
    await installer.installHarness('opencode', 'tested')
    const dir = path.join(store, 'opencode', OC_TESTED)
    expect(resolveHarness('opencode')).toMatchObject({
      source: 'managed',
      version: OC_TESTED,
      path: path.join(dir, exe('opencode'))
    })
    // The resolution touched `last-used` for retention.
    expect(fs.existsSync(path.join(dir, LAST_USED_FILE))).toBe(true)
  })
})

// ── pi ────────────────────────────────────────────────────────────────────────

const PI_KEY = piPlatformKey(process.platform, process.arch)
const PI_TESTED = harnessManifest('pi').tested
const piBase = (v: string): string => `https://github.com/earendil-works/pi/releases/download/v${v}`
const cdn = (name: string): string =>
  `https://release-assets.githubusercontent.com/github-production-release-asset/1/${name}?sig=s`

function piFixture(
  version: string,
  opts: {
    kind?: 'zip' | 'tar.gz'
    archive?: Buffer
    reviewed?: string
    sums?: string
    redirectHost?: string
  } = {}
): { f: FakeFetch; manifest: HarnessManifest } {
  const kind = opts.kind ?? 'zip'
  const asset = `pi-test-x64.${kind}`
  const archive =
    opts.archive ??
    (kind === 'zip'
      ? zip([
          { name: exe('pi'), body: 'pi binary', unixMode: 0o100755 },
          { name: 'theme/dark.json', body: '{}' },
          { name: 'package.json', body: '{}' }
        ])
      : tgz([
          tarEntry('pi/', '', { type: '5', mode: 0o755 }),
          tarEntry(`pi/${exe('pi')}`, 'pi binary', { mode: 0o755 }),
          tarEntry('pi/theme/dark.json', '{}')
        ]))
  const digest = sha256(archive)
  const cdnHost = opts.redirectHost ?? 'https://release-assets.githubusercontent.com'
  const assetCdn = `${cdnHost}/github-production-release-asset/1/${asset}?sig=s`
  const f = fakeFetch({
    [`${piBase(version)}/SHA256SUMS`]: { redirect: cdn('SHA256SUMS') },
    [cdn('SHA256SUMS')]: {
      body: opts.sums ?? `${'0'.repeat(64)}  pi-other.zip\n${digest}  ${asset}\n`
    },
    [`${piBase(version)}/${asset}`]: { redirect: assetCdn },
    [assetCdn]: { body: archive }
  })
  const manifest = withPlatforms('pi', {
    [PI_KEY]: { asset, archiveSha256: opts.reviewed ?? digest }
  })
  return { f, manifest }
}

describe('pi', () => {
  it.each(['zip', 'tar.gz'] as const)(
    'installs the tested version from a %s as reviewed, keeping the whole payload',
    async (kind) => {
      const fx = piFixture(PI_TESTED, { kind })
      const probe = okProbe(PI_TESTED)
      const result = await installerFor(fx, PI_TESTED, { probe: probe.probe }).installHarness(
        'pi',
        'tested'
      )
      expect(result).toEqual({
        status: 'installed',
        id: 'pi',
        version: PI_TESTED,
        verified: 'reviewed'
      })
      const dir = path.join(store, 'pi', PI_TESTED)
      const nested = kind === 'tar.gz' ? 'pi' : ''
      expect(fs.existsSync(path.join(dir, nested, 'theme', 'dark.json'))).toBe(true)
      expect(probe.calls[0].command.endsWith(path.join(nested, exe('pi')))).toBe(true)
      // The resolver finds pi flat or nested.
      invalidateHarness('pi')
      expect(resolveHarness('pi')).toMatchObject({
        source: 'managed',
        path: path.join(dir, nested, exe('pi'))
      })
    }
  )

  it('installs another version against SHA256SUMS only', async () => {
    const version = untested(PI_TESTED)
    const fx = piFixture(version, { reviewed: 'c'.repeat(64) })
    const result = await installerFor(fx, version).installHarness('pi', version)
    expect(result).toMatchObject({ status: 'installed', verified: 'publisher' })
  })

  it('fails when the reviewed digest does not match, though SHA256SUMS does', async () => {
    const fx = piFixture(PI_TESTED, { reviewed: 'c'.repeat(64) })
    const result = await installerFor(fx, PI_TESTED).installHarness('pi', 'tested')
    expect(result.status === 'failed' && result.reason).toMatch(/does not match the reviewed c{64}/)
    expect(storeState()).toEqual({ versions: [], staging: [], trash: [] })
  })

  it('fails when SHA256SUMS disagrees or does not list the asset', async () => {
    const mismatch = piFixture(PI_TESTED, { sums: `${'d'.repeat(64)}  pi-test-x64.zip\n` })
    const r1 = await installerFor(mismatch, PI_TESTED).installHarness('pi', 'tested')
    expect(r1.status === 'failed' && r1.reason).toMatch(/does not match SHA256SUMS/)
    const unlisted = piFixture(PI_TESTED, { sums: `${'d'.repeat(64)}  pi-test-x64.zip.sig\n` })
    const r2 = await installerFor(unlisted, PI_TESTED).installHarness('pi', 'tested')
    expect(r2.status === 'failed' && r2.reason).toMatch(/does not list pi-test-x64\.zip/)
    expect(storeState()).toEqual({ versions: [], staging: [], trash: [] })
  })

  it('refuses a redirect to a host that is not GitHub’s asset CDN', async () => {
    const fx = piFixture(PI_TESTED, { redirectHost: 'https://objects.evil.test' })
    const result = await installerFor(fx, PI_TESTED).installHarness('pi', 'tested')
    expect(result.status === 'failed' && result.reason).toMatch(
      /redirected to https:\/\/objects\.evil\.test, which is not an allowed host/
    )
    expect(fx.f.calls.some((u) => u.includes('evil.test'))).toBe(false)
    expect(storeState()).toEqual({ versions: [], staging: [], trash: [] })
  })

  it.each([
    [
      'a traversal',
      zip([
        { name: exe('pi'), body: 'x' },
        { name: '../../escape', body: 'x' }
      ])
    ],
    [
      'an absolute path',
      zip([
        { name: exe('pi'), body: 'x' },
        { name: '/escape', body: 'x' }
      ])
    ],
    [
      'a symlink',
      zip([
        { name: exe('pi'), body: 'x' },
        { name: 'l', body: '/', unixMode: 0o120777 }
      ])
    ]
  ])('refuses an archive with %s, even with a matching digest', async (_label, archive) => {
    const fx = piFixture(PI_TESTED, { archive })
    const result = await installerFor(fx, PI_TESTED).installHarness('pi', 'tested')
    expect(result.status).toBe('failed')
    expect(storeState()).toEqual({ versions: [], staging: [], trash: [] })
    expect(fs.existsSync(path.join(store, 'escape'))).toBe(false)
    expect(fs.existsSync(path.join(tmp, 'escape'))).toBe(false)
  })
})

// ── Codex ─────────────────────────────────────────────────────────────────────

const CODEX = harnessManifest('codex')
const CODEX_HOST = Object.hasOwn(CODEX.platforms, HOST)

function codexFixture(
  opts: { archiveSha?: string; binarySha?: string; licenseSha?: string; extraMember?: boolean } = {}
): { f: FakeFetch; manifest: HarnessManifest } {
  const members = {
    [exe('codex')]: 'codex-test-member',
    [exe('codex-code-mode-host')]: 'host-test-member'
  }
  const binaries: Record<string, unknown> = {}
  const routes: Record<string, { body: Buffer | string } | { redirect: string }> = {}
  for (const [name, member] of Object.entries(members)) {
    const body = Buffer.from(`${name} body`)
    const entries = [tarEntry(member, body, { mode: 0o755 })]
    if (opts.extraMember) entries.push(tarEntry('extra', 'x'))
    const archive = tgz(entries)
    binaries[name] = {
      member,
      archiveSha256: opts.archiveSha ?? sha256(archive),
      binarySha256: opts.binarySha ?? sha256(body)
    }
    const url = `https://github.com/openai/codex/releases/download/rust-v${CODEX.tested}/${member}.tar.gz`
    routes[url] = { redirect: cdn(`${member}.tar.gz`) }
    routes[cdn(`${member}.tar.gz`)] = { body: archive }
  }
  const license = 'Apache License'
  routes[(CODEX as unknown as { license: string }).license] = { body: license }
  const manifest = {
    ...CODEX,
    licenseSha256: opts.licenseSha ?? sha256(license),
    platforms: { [HOST]: { binaries } }
  } as HarnessManifest
  return { f: fakeFetch(routes), manifest }
}

describe.skipIf(!CODEX_HOST)('Codex', () => {
  it('installs both binaries and the LICENSE, reviewed', async () => {
    const fx = codexFixture()
    const probe = okProbe(CODEX.tested)
    const result = await installerFor(fx, CODEX.tested, { probe: probe.probe }).installHarness(
      'codex',
      'tested'
    )
    expect(result).toEqual({
      status: 'installed',
      id: 'codex',
      version: CODEX.tested,
      verified: 'reviewed'
    })
    const dir = path.join(store, 'codex', CODEX.tested)
    expect(fs.readdirSync(dir).sort()).toEqual(
      [exe('codex'), exe('codex-code-mode-host'), 'LICENSE', 'install.json'].sort()
    )
    expect(probe.calls[0].command.endsWith(exe('codex'))).toBe(true)
  })

  it('refuses any version but the pin, without a request', async () => {
    const fx = codexFixture()
    const installer = installerFor(fx, CODEX.tested, {
      latestVersion: async () => untested(CODEX.tested)
    })
    for (const version of ['latest', untested(CODEX.tested)]) {
      const result = await installer.installHarness('codex', version)
      expect(result.status === 'failed' && result.reason).toMatch(/locked to/)
    }
    expect(fx.f.calls).toEqual([])
  })

  it.each([
    [
      'archive digest',
      { archiveSha: 'e'.repeat(64) },
      /tar\.gz SHA-256 \w+ does not match the reviewed e{64}/
    ],
    ['binary digest', { binarySha: 'e'.repeat(64) }, /does not match the reviewed e{64}/],
    ['LICENSE digest', { licenseSha: 'e'.repeat(64) }, /LICENSE SHA-256/]
  ])('fails on a mismatched %s, leaving nothing behind', async (_label, opts, reason) => {
    const fx = codexFixture(opts)
    const result = await installerFor(fx, CODEX.tested).installHarness('codex', 'tested')
    expect(result.status === 'failed' && result.reason).toMatch(reason)
    expect(storeState()).toEqual({ versions: [], staging: [], trash: [] })
  })

  it('refuses an archive with more than its one member', async () => {
    const fx = codexFixture({ extraMember: true })
    const result = await installerFor(fx, CODEX.tested).installHarness('codex', 'tested')
    expect(result.status === 'failed' && result.reason).toMatch(/does not hold exactly/)
  })
})

describe('Claude Code', () => {
  it('has no managed copy to install', async () => {
    const installer = createInstaller({ fetch: async () => fakeFetch().fetch })
    expect(await installer.installHarness('claude', 'tested')).toEqual({
      status: 'failed',
      id: 'claude',
      version: 'tested',
      reason: 'Claude Code has no ClaudeUI-managed copy'
    })
  })
})

describe('concurrency', () => {
  it.skipIf(!OC_KEY)('runs at most the cap at once; the rest wait', async () => {
    const versions = [OC_TESTED, untested(OC_TESTED), `${untested(OC_TESTED)}9`]
    const all = fakeFetch()
    let active = 0
    let peak = 0
    for (const v of versions) {
      for (const [url, route] of opencodeFixture(v).f.routes) {
        const { body } = route as { body: Buffer | string }
        all.routes.set(url, async () => {
          active++
          peak = Math.max(peak, active)
          await new Promise((r) => setTimeout(r, 20))
          active--
          return new Response(new Uint8Array(Buffer.from(body)))
        })
      }
    }
    const tested = opencodeFixture(OC_TESTED).manifest
    const installer = createInstaller({
      fetch: async () => all.fetch,
      manifest: (id) => (id === 'opencode' ? tested : harnessManifest(id)),
      probe: async (_id, launch) => ({
        status: 'ok',
        version: versions.find((v) => launch.command.includes(`opencode-${v}-`)) ?? '?'
      }),
      invalidate: () => {},
      maxConcurrent: 1
    })
    const results = await Promise.all(versions.map((v) => installer.installHarness('opencode', v)))
    expect(results.map((r) => r.status)).toEqual(['installed', 'installed', 'installed'])
    expect(peak).toBe(1)
    expect(storeState().versions).toHaveLength(3)
  })
})

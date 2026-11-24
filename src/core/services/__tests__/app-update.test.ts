/**
 * @vitest-environment node
 *
 * ClaudeUI's update service (auto-update design §3) against a fake host, a fake
 * `fetch` answering a fake GitHub, a fake clock and fake timers. Downloads land
 * in a temp directory, the state file too. Nothing touches the network or the
 * real `~/.claude/ui`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { BuildInfo, DevBuildInfo } from '../../../shared/build-info'
import { UPDATE_MANIFEST_FILE, UPDATE_MANIFEST_SIG_FILE } from '../../../shared/update-manifest'
import type { AppUpdateHost } from '../../host'
import { fakeFetch, hangingBody, type Route } from '../../harness/install/__tests__/fixtures'
import { RELEASES_URL } from '../app-update-feed'
import {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  SETTINGS_CHECK_DELAY_MS,
  createAppUpdater,
  effectiveChannel,
  parseAppUpdateState,
  type AppUpdateSettings,
  type AppUpdater,
  type AppUpdaterTimers
} from '../app-update'
import {
  archiveFor,
  assetName,
  downloadUrl,
  makeKey,
  manifestFor,
  releaseJson,
  signed,
  type TestKey
} from './app-update-fixtures'
import type { UpdateManifest } from '../../../shared/update-manifest'
import type { AppUpdateRebuildProgress } from '../../../shared/types/app-update'

vi.mock('../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

const KEY = makeKey()
const OTHER_KEY = makeKey('other')
const START = Date.parse('2026-11-24T00:00:00.000Z')

function releaseBuild(version: string): BuildInfo {
  return {
    schema: 1,
    kind: 'release',
    version,
    channel: version.includes('-') ? 'pre-release' : 'stable',
    git: {
      describe: `v${version}-0-gabc1234`,
      baseTag: `v${version}`,
      ahead: 0,
      commit: 'abc1234def',
      dirty: false,
      branch: null
    },
    builtAt: '2026-11-01T00:00:00.000Z'
  }
}

function localBuild(baseTag: string | null): BuildInfo {
  return {
    schema: 1,
    kind: 'local',
    version: '1.0.0',
    git: {
      describe: null,
      baseTag,
      ahead: 3,
      commit: 'fedcba9',
      dirty: true,
      branch: 'feat/x'
    },
    sourcePath: '/work/src/ClaudeUI',
    builtAt: '2026-11-01T00:00:00.000Z'
  }
}

// ── A fake GitHub ─────────────────────────────────────────────────────────────

interface Published {
  version: string
  archive?: Buffer
  manifest?: Partial<UpdateManifest>
  key?: TestKey
  assetRoute?: Route
}

/** The routes for a release list holding `releases`, newest first or not. */
function github(...releases: Published[]): Record<string, Route> {
  const routes: Record<string, Route> = {
    [RELEASES_URL]: { body: JSON.stringify(releases.map((r) => releaseJson(r.version))) }
  }
  for (const r of releases) {
    const archive = r.archive ?? archiveFor(r.version)
    const pair = signed(manifestFor(r.version, r.manifest ?? {}, archive), r.key ?? KEY)
    routes[downloadUrl(r.version, UPDATE_MANIFEST_FILE)] = { body: pair.manifestBytes }
    routes[downloadUrl(r.version, UPDATE_MANIFEST_SIG_FILE)] = { body: pair.sigText }
    routes[downloadUrl(r.version, assetName(r.version))] = r.assetRoute ?? { body: archive }
  }
  return routes
}

// ── Fake timers ───────────────────────────────────────────────────────────────

function fakeTimers(): {
  timers: AppUpdaterTimers
  live: Map<number, { fn: () => void; ms: number; every: boolean }>
  fire(ms: number): void
} {
  let next = 1
  const live = new Map<number, { fn: () => void; ms: number; every: boolean }>()
  const add = (fn: () => void, ms: number, every: boolean): number => {
    const id = next++
    live.set(id, { fn, ms, every })
    return id
  }
  return {
    live,
    timers: {
      setTimeout: (fn, ms) => add(fn, ms, false),
      clearTimeout: (h) => void live.delete(h as number),
      setInterval: (fn, ms) => add(fn, ms, true),
      clearInterval: (h) => void live.delete(h as number)
    },
    fire(ms) {
      for (const [id, t] of [...live]) {
        if (t.ms !== ms) continue
        if (!t.every) live.delete(id)
        t.fn()
      }
    }
  }
}

// ── The rig ───────────────────────────────────────────────────────────────────

let root: string
let downloadsDir: string
let statePath: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeui-app-update-'))
  downloadsDir = path.join(root, 'updates')
  statePath = path.join(root, 'app-update.json')
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

type FakeHost = AppUpdateHost & {
  stage: ReturnType<typeof vi.fn>
  isStaged: ReturnType<typeof vi.fn>
  apply: ReturnType<typeof vi.fn>
  eligibility: ReturnType<typeof vi.fn>
}

function fakeHost(info: BuildInfo | DevBuildInfo, patch: Partial<AppUpdateHost> = {}): FakeHost {
  return {
    buildInfo: () => info,
    target: () => 'desktop-darwin-arm64',
    eligibility: vi.fn(async () => ({ ok: true as const })),
    downloadsDir: () => downloadsDir,
    stage: vi.fn(async (_archive: string, version: string) => ({ stagedId: `staged-${version}` })),
    isStaged: vi.fn(async () => true),
    apply: vi.fn(async () => {}),
    ...patch
  } as FakeHost
}

interface Rig {
  updater: AppUpdater
  host: FakeHost
  calls: string[]
  routes: Map<string, Route>
  timers: ReturnType<typeof fakeTimers>
  clock: { t: number }
  settings: AppUpdateSettings
  changes: () => number
}

function rig(
  opts: {
    info?: BuildInfo | DevBuildInfo
    host?: Partial<AppUpdateHost> | null
    routes?: Record<string, Route>
    settings?: Partial<AppUpdateSettings>
    free?: number | null
  } = {}
): Rig {
  const f = fakeFetch(opts.routes ?? {})
  const timers = fakeTimers()
  const clock = { t: START }
  const settings: AppUpdateSettings = { channel: 'auto', mode: 'auto', ...opts.settings }
  const host = fakeHost(opts.info ?? releaseBuild('1.0.0'), opts.host ?? {})
  const updater = createAppUpdater({
    host: () => (opts.host === null ? null : host),
    fetch: async () => f.fetch,
    now: () => clock.t,
    timers: timers.timers,
    settings: () => settings,
    statePath: () => statePath,
    keys: [KEY.key],
    freeBytes: async () => (opts.free === undefined ? 1e12 : opts.free)
  })
  let changes = 0
  updater.onChanged(() => void changes++)
  return {
    updater,
    host,
    calls: f.calls,
    routes: f.routes,
    timers,
    clock,
    settings,
    changes: () => changes
  }
}

const archivePath = (version: string): string =>
  path.join(downloadsDir, version, assetName(version))

const readState = (): unknown => JSON.parse(fs.readFileSync(statePath, 'utf8'))

/** Resolves once a download has written its first bytes. */
function firstBytes(updater: AppUpdater): Promise<void> {
  return new Promise((resolve) => {
    const off = updater.onChanged(() => {
      if ((updater.view().download.received ?? 0) > 0) {
        off()
        resolve()
      }
    })
  })
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

describe('effectiveChannel', () => {
  it('follows a release build, and a local build by its base tag', () => {
    expect(effectiveChannel('auto', releaseBuild('1.0.0'))).toBe('stable')
    expect(effectiveChannel('auto', releaseBuild('1.0.0-pre.3'))).toBe('pre-release')
    expect(effectiveChannel('auto', localBuild('v1.0.0-pre.13'))).toBe('pre-release')
    expect(effectiveChannel('auto', localBuild('v1.0.0'))).toBe('stable')
    expect(effectiveChannel('auto', localBuild(null))).toBe('stable')
  })

  it('takes an explicit choice as it is', () => {
    expect(effectiveChannel('stable', releaseBuild('1.0.0-pre.3'))).toBe('stable')
    expect(effectiveChannel('pre-release', releaseBuild('1.0.0'))).toBe('pre-release')
  })
})

describe('parseAppUpdateState', () => {
  it('keeps what it can trust and drops the rest', () => {
    expect(
      parseAppUpdateState({
        schema: 1,
        skippedVersion: '1.2.0',
        staged: { version: '1.1.0', stagedId: 'x' }
      })
    ).toEqual({ skippedVersion: '1.2.0', staged: { version: '1.1.0', stagedId: 'x' } })
    expect(parseAppUpdateState({ schema: 2, skippedVersion: '1.2.0' })).toEqual({})
    expect(
      parseAppUpdateState({
        schema: 1,
        skippedVersion: '../1',
        staged: { version: '1.1.0', stagedId: '' }
      })
    ).toEqual({})
    expect(parseAppUpdateState(null)).toEqual({})
  })
})

// ── When nothing is checked ───────────────────────────────────────────────────

describe('no checks', () => {
  it('in mode off: no timer and no request, even on Check now', async () => {
    const r = rig({ routes: github({ version: '1.1.0' }), settings: { mode: 'off' } })
    r.updater.start()
    expect(r.timers.live.size).toBe(0)
    await r.updater.check('user')
    expect(r.calls).toEqual([])
    expect(r.updater.view().settings.mode).toBe('off')
  })

  it.each([
    ['a dev run', { kind: 'dev' } as DevBuildInfo],
    ['an untagged local build', localBuild(null)]
  ])('for %s', async (_label, info) => {
    const r = rig({ info, routes: github({ version: '1.1.0' }) })
    r.updater.start()
    r.timers.fire(FIRST_CHECK_DELAY_MS)
    await r.updater.check('user')
    await r.updater.idle()
    expect(r.calls).toEqual([])
    expect(r.updater.view().current.comparisonVersion).toBeNull()
  })

  it('without a host seam: unsupported, no timers, no requests, no file', async () => {
    const r = rig({ host: null, routes: github({ version: '1.1.0' }) })
    r.updater.start()
    expect(r.timers.live.size).toBe(0)
    await r.updater.check('user')
    expect(r.calls).toEqual([])
    const view = await r.updater.state()
    expect(view).toMatchObject({
      supported: false,
      current: { kind: 'dev', version: null, comparisonVersion: null },
      eligibility: { ok: false },
      download: { phase: 'idle' }
    })
    await expect(r.updater.download()).rejects.toThrow(/cannot update itself/)
    await expect(r.updater.apply()).rejects.toThrow(/cannot update itself/)
    expect(fs.existsSync(statePath)).toBe(false)
  })

  it('without a host seam does not even read the state file', async () => {
    fs.writeFileSync(statePath, JSON.stringify({ schema: 1, skippedVersion: '1.1.0' }))
    const r = rig({ host: null })
    r.updater.start()
    expect((await r.updater.state()).skippedVersion).toBeUndefined()
  })

  it('a host that throws breaks neither start (boot) nor a check', async () => {
    const r = rig({
      host: {
        buildInfo: () => {
          throw new Error('no build info')
        }
      }
    })
    expect(() => r.updater.start()).not.toThrow()
    await expect(r.updater.check('user')).resolves.toBeUndefined()
    expect(r.calls).toEqual([])
    expect(r.updater.view().current.kind).toBe('dev')

    const broken = rig({
      host: {
        target: () => {
          throw new Error('no target')
        }
      }
    })
    expect(() => broken.updater.start()).not.toThrow()
    expect(broken.updater.view().supported).toBe(false)
  })

  it('without a target for this host: unsupported', async () => {
    const r = rig({ host: { target: () => null }, routes: github({ version: '1.1.0' }) })
    r.updater.start()
    await r.updater.check('user')
    expect(r.calls).toEqual([])
    expect(r.updater.view().supported).toBe(false)
  })
})

// ── Check, download, stage ────────────────────────────────────────────────────

describe('mode auto', () => {
  it('checks 30 s after start, then downloads, verifies and stages on its own', async () => {
    const r = rig({ routes: github({ version: '1.1.0' }, { version: '1.0.5' }) })
    r.updater.start()
    expect([...r.timers.live.values()].map((t) => [t.ms, t.every]).sort()).toEqual([
      [CHECK_INTERVAL_MS, true],
      [FIRST_CHECK_DELAY_MS, false]
    ])
    expect(r.calls).toEqual([])

    r.timers.fire(FIRST_CHECK_DELAY_MS)
    await r.updater.idle()

    expect(r.calls[0]).toBe(RELEASES_URL)
    expect(r.calls).toContain(downloadUrl('1.1.0', assetName('1.1.0')))
    expect(r.calls).not.toContain(downloadUrl('1.0.5', UPDATE_MANIFEST_FILE))
    expect(r.host.stage).toHaveBeenCalledWith(archivePath('1.1.0'), '1.1.0')
    expect(fs.readFileSync(archivePath('1.1.0')).equals(archiveFor('1.1.0'))).toBe(true)
    const view = r.updater.view()
    expect(view).toMatchObject({
      supported: true,
      current: { kind: 'release', version: '1.0.0', comparisonVersion: '1.0.0', channel: 'stable' },
      eligibility: { ok: true },
      settings: { channel: 'auto', effectiveChannel: 'stable', mode: 'auto' },
      check: { running: false, lastCheckedAt: '2026-11-24T00:00:00.000Z' },
      available: {
        version: '1.1.0',
        tag: 'v1.1.0',
        notesUrl: 'https://github.com/wellofspirit/ClaudeUI/releases/tag/v1.1.0',
        size: archiveFor('1.1.0').length,
        claudeCodeVersion: '2.1.341',
        publishedAt: '2026-11-20T10:00:00.000Z'
      },
      download: { phase: 'staged', version: '1.1.0' }
    })
    expect(view.check.error).toBeUndefined()
    expect(readState()).toEqual({
      schema: 1,
      staged: { version: '1.1.0', stagedId: 'staged-1.1.0' }
    })
    expect(r.changes()).toBeGreaterThan(0)
  })

  it('checks again every six hours, and a check that finds the staged version downloads nothing', async () => {
    const r = rig({ routes: github({ version: '1.1.0' }) })
    r.updater.start()
    r.timers.fire(FIRST_CHECK_DELAY_MS)
    await r.updater.idle()
    const asked = r.calls.length
    r.timers.fire(CHECK_INTERVAL_MS)
    await r.updater.idle()
    expect(r.calls.filter((u) => u === RELEASES_URL)).toHaveLength(2)
    expect(r.calls.filter((u) => u.endsWith('.zip'))).toHaveLength(1)
    expect(r.calls.length).toBeGreaterThan(asked)
    expect(r.host.stage).toHaveBeenCalledTimes(1)
  })

  it('downloads nothing while the host says the update cannot be applied here', async () => {
    const r = rig({
      routes: github({ version: '1.1.0' }),
      host: { eligibility: async () => ({ ok: false, reason: "Can't update here" }) }
    })
    r.updater.start()
    await r.updater.check('user')
    await r.updater.idle()
    expect(r.calls.filter((u) => u.endsWith('.zip'))).toEqual([])
    expect(r.updater.view()).toMatchObject({
      eligibility: { ok: false, reason: "Can't update here" },
      available: { version: '1.1.0' },
      download: { phase: 'idle' }
    })
    await expect(r.updater.download()).rejects.toThrow("Can't update here")
  })

  it("carries an eligible host's notice into the view", async () => {
    const notice = 'Windows Firewall rules are per executable path; allow the port instead'
    const r = rig({
      routes: github({ version: '1.1.0' }),
      host: { eligibility: async () => ({ ok: true as const, notice }) }
    })
    expect((await r.updater.state()).eligibility).toEqual({ ok: true, notice })
  })

  it('reports download progress at most once a second', async () => {
    const archive = archiveFor('1.1.0')
    const chunks = [archive.subarray(0, 100), archive.subarray(100, 200), archive.subarray(200)]
    const r = rig({
      routes: github({
        version: '1.1.0',
        assetRoute: () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(c) {
                for (const chunk of chunks) c.enqueue(new Uint8Array(chunk))
                c.close()
              }
            })
          )
      })
    })
    const progress: number[] = []
    r.updater.onChanged(() => {
      const d = r.updater.view().download
      if (d.phase === 'downloading' && (d.received ?? 0) > 0) progress.push(d.received!)
    })
    r.updater.start()
    await r.updater.check('user')
    await r.updater.idle()
    expect(progress).toEqual([100])
    expect(r.updater.view().download.phase).toBe('staged')
  })
})

describe('mode ask', () => {
  it('finds the update but downloads only on download()', async () => {
    const r = rig({ routes: github({ version: '1.1.0' }), settings: { mode: 'ask' } })
    r.updater.start()
    await r.updater.check('user')
    await r.updater.idle()
    expect(r.calls.filter((u) => u.endsWith('.zip'))).toEqual([])
    expect(r.updater.view()).toMatchObject({
      available: { version: '1.1.0' },
      download: { phase: 'idle' }
    })

    await r.updater.download()
    await r.updater.idle()
    expect(r.updater.view().download).toEqual({ phase: 'staged', version: '1.1.0' })
    // Nothing more to fetch once staged.
    await r.updater.download()
    expect(r.calls.filter((u) => u.endsWith('.zip'))).toHaveLength(1)
  })

  it('refuses download() with nothing available', async () => {
    const r = rig({ routes: github(), settings: { mode: 'ask' } })
    r.updater.start()
    await r.updater.check('user')
    await expect(r.updater.download()).rejects.toThrow(/No update is available/)
  })
})

describe('a download that fails', () => {
  it('on a sha256 mismatch: failed, archive removed, nothing staged', async () => {
    const served = archiveFor('1.1.0')
    const forged = Buffer.from(served)
    forged[0] ^= 1
    const r = rig({
      routes: github({ version: '1.1.0', archive: served, assetRoute: { body: forged } })
    })
    r.updater.start()
    await r.updater.check('user')
    await r.updater.idle()
    expect(r.updater.view().download).toMatchObject({
      phase: 'failed',
      version: '1.1.0',
      error: expect.stringMatching(/sha256/)
    })
    expect(fs.existsSync(archivePath('1.1.0'))).toBe(false)
    expect(r.host.stage).not.toHaveBeenCalled()
    expect(fs.existsSync(statePath)).toBe(false)
  })

  it('on a size mismatch', async () => {
    const archive = archiveFor('1.1.0')
    const short = archive.subarray(0, archive.length - 10)
    const r = rig({ routes: github({ version: '1.1.0', archive, assetRoute: { body: short } }) })
    r.updater.start()
    await r.updater.check('user')
    await r.updater.idle()
    expect(r.updater.view().download).toMatchObject({
      phase: 'failed',
      error: expect.stringMatching(/bytes; the manifest says/)
    })
    expect(fs.existsSync(archivePath('1.1.0'))).toBe(false)
  })

  it('over the size the manifest names', async () => {
    const archive = archiveFor('1.1.0')
    const long = Buffer.concat([archive, Buffer.from('more')])
    const r = rig({ routes: github({ version: '1.1.0', archive, assetRoute: { body: long } }) })
    r.updater.start()
    await r.updater.check('user')
    await r.updater.idle()
    expect(r.updater.view().download).toMatchObject({
      phase: 'failed',
      error: expect.stringMatching(/byte limit/)
    })
    expect(fs.existsSync(archivePath('1.1.0'))).toBe(false)
  })

  it('without enough disk space, before fetching a byte', async () => {
    const size = archiveFor('1.1.0').length
    const r = rig({ routes: github({ version: '1.1.0' }), free: 3 * size - 1 })
    r.updater.start()
    await r.updater.check('user')
    await r.updater.idle()
    expect(r.updater.view().download).toMatchObject({
      phase: 'failed',
      error: 'Not enough disk space (needs about 0.1 GB)'
    })
    expect(r.calls.filter((u) => u.endsWith('.zip'))).toEqual([])
  })

  it('when staging fails, without a local path in the view', async () => {
    const r = rig({
      routes: github({ version: '1.1.0' }),
      host: {
        stage: async (archive: string) => {
          throw new Error(`could not extract ${archive}`)
        }
      }
    })
    r.updater.start()
    await r.updater.check('user')
    await r.updater.idle()
    const view = r.updater.view()
    expect(view.download).toMatchObject({ phase: 'failed', error: expect.any(String) })
    expect(JSON.stringify(view)).not.toContain(root)
    expect(fs.existsSync(archivePath('1.1.0'))).toBe(false)
  })
})

describe('the view', () => {
  it('carries no local path, not even a local build source path', async () => {
    const r = rig({ info: localBuild('v1.0.0'), routes: github({ version: '1.1.0' }) })
    r.updater.start()
    await r.updater.check('user')
    await r.updater.idle()
    const view = await r.updater.state()
    expect(view.current).toEqual({
      kind: 'local',
      version: '1.0.0',
      comparisonVersion: '1.0.0',
      commit: 'fedcba9',
      dirty: true,
      ahead: 3
    })
    const text = JSON.stringify(view)
    expect(text).not.toContain(root)
    expect(text).not.toContain('/work/src')
  })
})

describe('cleanup after staging', () => {
  it("deletes only older versions' release archives, never other files", async () => {
    const put = (rel: string): void => {
      fs.mkdirSync(path.dirname(path.join(downloadsDir, rel)), { recursive: true })
      fs.writeFileSync(path.join(downloadsDir, rel), 'x')
    }
    put('1.0.5/ClaudeUI-1.0.5-mac-arm64.zip')
    put('1.0.4/ClaudeUI-1.0.4-mac-arm64.zip')
    put('1.0.4/keep.txt')
    put('notes/ClaudeUI-0.1.0-mac-arm64.zip')
    put('ClaudeUI-0.2.0-mac-arm64.zip')
    const r = rig({ routes: github({ version: '1.1.0' }) })
    r.updater.start()
    await r.updater.check('user')
    await r.updater.idle()
    expect(r.updater.view().download.phase).toBe('staged')
    expect(fs.existsSync(path.join(downloadsDir, '1.0.5'))).toBe(false)
    expect(fs.existsSync(path.join(downloadsDir, '1.0.4/ClaudeUI-1.0.4-mac-arm64.zip'))).toBe(false)
    expect(fs.existsSync(path.join(downloadsDir, '1.0.4/keep.txt'))).toBe(true)
    expect(fs.existsSync(path.join(downloadsDir, 'notes/ClaudeUI-0.1.0-mac-arm64.zip'))).toBe(true)
    expect(fs.existsSync(path.join(downloadsDir, 'ClaudeUI-0.2.0-mac-arm64.zip'))).toBe(true)
    expect(fs.existsSync(archivePath('1.1.0'))).toBe(true)
  })

  it('replaces a stale partial of the same version', async () => {
    fs.mkdirSync(path.join(downloadsDir, '1.1.0'), { recursive: true })
    fs.writeFileSync(archivePath('1.1.0'), 'half a zip')
    const r = rig({ routes: github({ version: '1.1.0' }) })
    r.updater.start()
    await r.updater.check('user')
    await r.updater.idle()
    expect(r.updater.view().download.phase).toBe('staged')
    expect(fs.readFileSync(archivePath('1.1.0')).equals(archiveFor('1.1.0'))).toBe(true)
  })
})

// ── Checks that fail ──────────────────────────────────────────────────────────

describe('check failures', () => {
  it('a refused manifest keeps the previous update and shows why', async () => {
    const r = rig({ routes: github({ version: '1.1.0' }), settings: { mode: 'ask' } })
    r.updater.start()
    await r.updater.check('user')
    const checkedAt = r.updater.view().check.lastCheckedAt
    for (const [url, route] of Object.entries(
      github({ version: '1.2.0', key: OTHER_KEY }, { version: '1.1.0' })
    ))
      r.routes.set(url, route)
    r.clock.t += 60_000
    await r.updater.check('user')
    expect(r.updater.view()).toMatchObject({
      available: { version: '1.1.0' },
      check: {
        running: false,
        lastCheckedAt: checkedAt,
        error: '1.2.0 was refused: the update manifest signature does not verify under a pinned key'
      }
    })
  })

  it('refuses everything while no signing key is pinned', async () => {
    const f = fakeFetch(github({ version: '1.1.0' }))
    const updater = createAppUpdater({
      host: () => fakeHost(releaseBuild('1.0.0')),
      fetch: async () => f.fetch,
      now: () => START,
      timers: fakeTimers().timers,
      settings: () => ({ channel: 'auto', mode: 'auto' }),
      statePath: () => statePath,
      keys: [],
      freeBytes: async () => 1e12
    })
    updater.start()
    await updater.check('user')
    await updater.idle()
    expect(updater.view().available).toBeUndefined()
    expect(updater.view().check.error).toMatch(/no update signing key is pinned/)
    expect(f.calls.filter((u) => u.endsWith('.zip'))).toEqual([])
  })

  it('a rate limit holds every check until the reset GitHub names', async () => {
    const reset = START / 1000 + 600
    const r = rig({
      routes: {
        ...github({ version: '1.1.0' }),
        [RELEASES_URL]: {
          status: 403,
          body: '{"message":"API rate limit exceeded"}',
          headers: { 'x-ratelimit-reset': String(reset), 'x-ratelimit-remaining': '0' }
        }
      },
      settings: { mode: 'ask' }
    })
    r.updater.start()
    await r.updater.check('user')
    expect(r.updater.view().check.error).toBe(
      'GitHub rate limit; next check after 2026-11-24T00:10:00.000Z'
    )
    expect(r.calls).toEqual([RELEASES_URL])

    r.clock.t += 300_000
    await r.updater.check('user')
    r.timers.fire(CHECK_INTERVAL_MS)
    await r.updater.idle()
    expect(r.calls).toEqual([RELEASES_URL])

    r.clock.t += 301_000
    r.routes.set(RELEASES_URL, { body: JSON.stringify([releaseJson('1.1.0')]) })
    await r.updater.check('user')
    expect(r.calls.filter((u) => u === RELEASES_URL)).toHaveLength(2)
    expect(r.updater.view()).toMatchObject({ available: { version: '1.1.0' } })
    expect(r.updater.view().check.error).toBeUndefined()
  })

  it('a rate limit with no reset time holds for an hour', async () => {
    const r = rig({ routes: { [RELEASES_URL]: { status: 429, body: '' } } })
    r.updater.start()
    await r.updater.check('user')
    expect(r.updater.view().check.error).toBe(
      'GitHub rate limit; next check after 2026-11-24T01:00:00.000Z'
    )
  })

  it('a second check joins the first', async () => {
    let answer: (r: Response) => void = () => {}
    const r = rig({
      routes: {
        ...github({ version: '1.1.0' }),
        [RELEASES_URL]: () => new Promise<Response>((resolve) => (answer = resolve))
      },
      settings: { mode: 'ask' }
    })
    r.updater.start()
    const first = r.updater.check('user')
    const second = r.updater.check('timer')
    expect(second).toBe(first)
    await vi.waitFor(() => expect(r.calls).toEqual([RELEASES_URL]))
    expect(r.updater.view().check.running).toBe(true)
    answer(new Response(JSON.stringify([releaseJson('1.1.0')])))
    await first
    expect(r.calls.filter((u) => u === RELEASES_URL)).toHaveLength(1)
    expect(r.updater.view()).toMatchObject({
      check: { running: false },
      available: { version: '1.1.0' }
    })
  })
})

// ── Skip, stop, apply ─────────────────────────────────────────────────────────

describe('skip', () => {
  it('hides the version, stops its download, persists, and a newer one is offered', async () => {
    const r = rig({ routes: github({ version: '1.1.0', assetRoute: hangingBody('first bytes') }) })
    r.updater.start()
    const started = firstBytes(r.updater)
    await r.updater.check('user')
    await started
    expect(fs.existsSync(archivePath('1.1.0'))).toBe(true)

    await r.updater.skip('1.1.0')
    await r.updater.idle()
    expect(r.updater.view()).toMatchObject({ skippedVersion: '1.1.0', download: { phase: 'idle' } })
    expect(r.updater.view().available).toBeUndefined()
    expect(fs.existsSync(archivePath('1.1.0'))).toBe(false)
    expect(readState()).toEqual({ schema: 1, skippedVersion: '1.1.0' })
    expect(r.host.stage).not.toHaveBeenCalled()

    // A check that finds only the skipped version offers nothing, and fetches no manifest.
    const before = r.calls.length
    await r.updater.check('user')
    expect(r.calls.slice(before)).toEqual([RELEASES_URL])
    expect(r.updater.view().available).toBeUndefined()

    for (const [url, route] of Object.entries(github({ version: '1.2.0' }, { version: '1.1.0' })))
      r.routes.set(url, route)
    await r.updater.check('user')
    await r.updater.idle()
    expect(r.updater.view()).toMatchObject({
      skippedVersion: '1.1.0',
      available: { version: '1.2.0' },
      download: { phase: 'staged', version: '1.2.0' }
    })
  })

  it('forgets a staged download of the skipped version', async () => {
    const r = rig({ routes: github({ version: '1.1.0' }) })
    r.updater.start()
    await r.updater.check('user')
    await r.updater.idle()
    expect(r.updater.view().download.phase).toBe('staged')
    await r.updater.skip('1.1.0')
    expect(r.updater.view().download).toEqual({ phase: 'idle' })
    expect(readState()).toEqual({ schema: 1, skippedVersion: '1.1.0' })
    await expect(r.updater.apply()).rejects.toThrow(/No update is staged/)
  })

  it('refuses a malformed version', async () => {
    const r = rig()
    await expect(r.updater.skip('../../etc')).rejects.toThrow(/looks like 1\.2\.3/)
    expect(fs.existsSync(statePath)).toBe(false)
  })
})

describe('stop', () => {
  it('clears the timers and aborts a running download, removing its partial', async () => {
    const r = rig({ routes: github({ version: '1.1.0', assetRoute: hangingBody('first bytes') }) })
    r.updater.start()
    const started = firstBytes(r.updater)
    await r.updater.check('user')
    await started
    r.updater.stop()
    await r.updater.idle()
    expect(r.timers.live.size).toBe(0)
    expect(r.updater.view().download).toEqual({ phase: 'idle' })
    expect(fs.existsSync(archivePath('1.1.0'))).toBe(false)
    const before = r.calls.length
    await r.updater.check('user')
    expect(r.calls.length).toBe(before)
  })
})

describe('apply', () => {
  it('is refused unless an update is staged', async () => {
    const r = rig({ routes: github({ version: '1.1.0' }), settings: { mode: 'ask' } })
    r.updater.start()
    await expect(r.updater.apply()).rejects.toThrow(/No update is staged/)
    await r.updater.check('user')
    await expect(r.updater.apply()).rejects.toThrow(/No update is staged/)
    expect(r.host.apply).not.toHaveBeenCalled()
  })

  it('hands the staged build to the host', async () => {
    const r = rig({ routes: github({ version: '1.1.0' }) })
    r.updater.start()
    await r.updater.check('user')
    await r.updater.idle()
    await r.updater.apply()
    expect(r.host.apply).toHaveBeenCalledWith('staged-1.1.0', '1.1.0')
  })

  it('is refused while the host says it cannot be applied', async () => {
    const r = rig({ routes: github({ version: '1.1.0' }) })
    r.updater.start()
    await r.updater.check('user')
    await r.updater.idle()
    r.host.eligibility.mockResolvedValue({ ok: false, reason: 'read-only volume' })
    await expect(r.updater.apply()).rejects.toThrow('read-only volume')
    expect(r.host.apply).not.toHaveBeenCalled()
  })
})

// ── After a restart ───────────────────────────────────────────────────────────

describe('a persisted staged update', () => {
  const persist = (state: unknown): void => fs.writeFileSync(statePath, JSON.stringify(state))

  it('is reused while the host says it is still staged', async () => {
    persist({ schema: 1, staged: { version: '1.1.0', stagedId: 'abc' } })
    const r = rig()
    r.updater.start()
    await r.updater.idle()
    expect(r.host.isStaged).toHaveBeenCalledWith('abc', '1.1.0')
    expect(r.updater.view().download).toEqual({ phase: 'staged', version: '1.1.0' })
    await r.updater.apply()
    expect(r.host.apply).toHaveBeenCalledWith('abc', '1.1.0')
  })

  it('is forgotten when the host no longer has it', async () => {
    persist({ schema: 1, skippedVersion: '0.9.0', staged: { version: '1.1.0', stagedId: 'abc' } })
    const r = rig({ host: { isStaged: async () => false } })
    r.updater.start()
    await r.updater.idle()
    expect(r.updater.view().download).toEqual({ phase: 'idle' })
    expect(readState()).toEqual({ schema: 1, skippedVersion: '0.9.0' })
  })

  it('is forgotten when it is not newer than the running build (the update happened)', async () => {
    persist({ schema: 1, staged: { version: '1.1.0', stagedId: 'abc' } })
    const r = rig({ info: releaseBuild('1.1.0') })
    r.updater.start()
    await r.updater.idle()
    expect(r.host.isStaged).not.toHaveBeenCalled()
    expect(r.updater.view().download).toEqual({ phase: 'idle' })
    expect(readState()).toEqual({ schema: 1 })
  })

  it('an unreadable state file is empty', async () => {
    fs.writeFileSync(statePath, '{ not json')
    const r = rig({ routes: github({ version: '1.1.0' }), settings: { mode: 'ask' } })
    r.updater.start()
    await r.updater.check('user')
    await r.updater.idle()
    expect(r.updater.view()).toMatchObject({ available: { version: '1.1.0' } })
    expect(r.updater.view().skippedVersion).toBeUndefined()
  })
})

// ── Settings ──────────────────────────────────────────────────────────────────

describe('settingsChanged', () => {
  it('is a no-op before start', () => {
    const r = rig()
    r.updater.settingsChanged()
    expect(r.timers.live.size).toBe(0)
  })

  it('mode off stops the timers; back on arms them and checks soon', async () => {
    const r = rig({ routes: github({ version: '1.1.0' }), settings: { mode: 'ask' } })
    r.updater.start()
    expect(r.timers.live.size).toBe(2)
    r.settings.mode = 'off'
    r.updater.settingsChanged()
    expect(r.timers.live.size).toBe(0)
    expect(r.updater.view().settings.mode).toBe('off')

    r.settings.mode = 'ask'
    r.updater.settingsChanged()
    expect([...r.timers.live.values()].map((t) => t.ms).sort((a, b) => a - b)).toEqual([
      SETTINGS_CHECK_DELAY_MS,
      FIRST_CHECK_DELAY_MS,
      CHECK_INTERVAL_MS
    ])
    r.timers.fire(SETTINGS_CHECK_DELAY_MS)
    await r.updater.idle()
    expect(r.calls).toContain(RELEASES_URL)
  })

  it('an unchanged setting does nothing', () => {
    const r = rig({ settings: { mode: 'ask' } })
    r.updater.start()
    const changes = r.changes()
    r.updater.settingsChanged()
    expect(r.changes()).toBe(changes)
    expect(r.timers.live.size).toBe(2)
  })

  it('switching to stable drops a pre-release offer at once, and never downgrades', async () => {
    const r = rig({
      info: releaseBuild('1.0.0-pre.1'),
      routes: github({ version: '1.0.0-pre.2' }),
      settings: { mode: 'ask' }
    })
    r.updater.start()
    await r.updater.check('user')
    expect(r.updater.view()).toMatchObject({
      settings: { effectiveChannel: 'pre-release' },
      available: { version: '1.0.0-pre.2' }
    })
    r.settings.channel = 'stable'
    r.updater.settingsChanged()
    expect(r.updater.view().settings.effectiveChannel).toBe('stable')
    expect(r.updater.view().available).toBeUndefined()
    r.timers.fire(SETTINGS_CHECK_DELAY_MS)
    await r.updater.idle()
    expect(r.updater.view().available).toBeUndefined()
  })

  it('an unknown mode (a hand edit) downloads nothing by itself', async () => {
    const r = rig({
      routes: github({ version: '1.1.0' }),
      settings: { mode: 'sometimes' as never }
    })
    r.updater.start()
    await r.updater.check('user')
    await r.updater.idle()
    expect(r.updater.view()).toMatchObject({
      settings: { mode: 'ask' },
      available: { version: '1.1.0' },
      download: { phase: 'idle' }
    })
  })
})

// ── Local rebuild ─────────────────────────────────────────────────────────────

describe('rebuild', () => {
  const TREE = { name: 'main checkout', branch: 'main', commit: 'abc1234', dirty: 2 }
  const TREE_ID = '0123456789abcdef'
  const cancelled = (): Error => Object.assign(new Error('cancelled'), { name: 'RebuildCancelled' })

  /** A host whose rebuild the test drives: progress, then done or failed. */
  function rebuildHost(over: Partial<AppUpdateHost> = {}): {
    patch: Partial<AppUpdateHost>
    progress: (p: AppUpdateRebuildProgress) => void
    finish: (v: { version: string; commit: string | null }) => void
    fail: (err: unknown) => void
  } {
    let onProgress: (p: AppUpdateRebuildProgress) => void = () => {}
    let finish: (v: { version: string; commit: string | null }) => void = () => {}
    let fail: (err: unknown) => void = () => {}
    const patch: Partial<AppUpdateHost> = {
      rebuildAvailable: () => true,
      trees: vi.fn(async () => [{ id: TREE_ID, ...TREE }]),
      rebuild: vi.fn(async (_treeId: string, cb: (p: AppUpdateRebuildProgress) => void) => {
        onProgress = cb
        const done = new Promise<{ version: string; commit: string | null }>((res, rej) => {
          finish = res
          fail = rej
        })
        return { tree: TREE, done }
      }),
      cancelRebuild: vi.fn(async () => fail(cancelled())),
      applyRebuild: vi.fn(async () => {}),
      ...over
    }
    return {
      patch,
      progress: (p) => onProgress(p),
      finish: (v) => finish(v),
      fail: (e) => fail(e)
    }
  }

  const STAGES: AppUpdateRebuildProgress['stages'] = [
    { label: 'typecheck ‖ electron-vite build', state: 'running', elapsedMs: 10 },
    { label: 'stamp build-info', state: 'pending' }
  ]

  it('a host without rebuilds shows none and lists no trees', async () => {
    const r = rig()
    expect(r.updater.view().rebuildAvailable).toBe(false)
    expect('rebuild' in r.updater.view()).toBe(false)
    await expect(r.updater.trees()).resolves.toEqual([])
    await expect(r.updater.rebuild(TREE_ID)).rejects.toThrow(/cannot rebuild/)
    expect(createAppUpdater({ host: () => null }).view().rebuildAvailable).toBe(false)
  })

  it('shows rebuildAvailable as the host says, and a host that throws as unavailable', async () => {
    const h = rebuildHost()
    const r = rig({ host: h.patch })
    expect(r.updater.view()).toMatchObject({ rebuildAvailable: true, rebuild: { phase: 'idle' } })
    await expect(r.updater.trees()).resolves.toEqual([{ id: TREE_ID, ...TREE }])
    const throwing = rig({
      host: {
        ...h.patch,
        rebuildAvailable: () => {
          throw new Error('boom')
        }
      }
    })
    expect(throwing.updater.view().rebuildAvailable).toBe(false)
  })

  it('refuses a malformed tree id without asking the host', async () => {
    const h = rebuildHost()
    const r = rig({ host: h.patch })
    for (const id of ['', '/Users/x/ClaudeUI', '0123', 'zzzzzzzzzzzzzzzz', 7 as never])
      await expect(r.updater.rebuild(id)).rejects.toThrow(/Pick a source tree/)
    expect(h.patch.rebuild).not.toHaveBeenCalled()
  })

  it('a pre-check refusal is thrown to the caller and leaves the view as it was', async () => {
    const r = rig({
      host: rebuildHost({
        rebuild: vi.fn(async () => {
          throw new Error(
            `Dependencies changed: run bun install in ClaudeUI first (${os.homedir()})`
          )
        })
      }).patch
    })
    await expect(r.updater.rebuild(TREE_ID)).rejects.toThrow('Dependencies changed')
    await expect(r.updater.rebuild(TREE_ID)).rejects.not.toThrow(os.homedir())
    expect(r.updater.view().rebuild).toEqual({ phase: 'idle' })
  })

  it('building → built: stages and the last line follow, then the version and commit', async () => {
    const h = rebuildHost()
    const r = rig({ host: h.patch })
    await r.updater.rebuild(TREE_ID)
    expect(h.patch.rebuild).toHaveBeenCalledWith(TREE_ID, expect.any(Function))
    expect(r.updater.view().rebuild).toMatchObject({
      phase: 'building',
      tree: TREE,
      stages: [],
      startedAt: new Date(START).toISOString()
    })
    h.progress({ stages: STAGES, lastLine: 'vite v6 building' })
    expect(r.updater.view().rebuild).toMatchObject({
      phase: 'building',
      stages: STAGES,
      lastLine: 'vite v6 building'
    })
    await expect(r.updater.rebuild(TREE_ID)).rejects.toThrow(/already running/)
    h.finish({ version: '1.0.0', commit: 'abc1234' })
    await r.updater.idle()
    const view = r.updater.view().rebuild!
    expect(view).toMatchObject({
      phase: 'built',
      tree: TREE,
      built: { version: '1.0.0', commit: 'abc1234' }
    })
    expect(view.stages!.every((s) => s.state === 'done')).toBe(true)
    expect(view.error).toBeUndefined()
  })

  it('emits a stage change at once and the last line at most once a second', async () => {
    const h = rebuildHost()
    const r = rig({ host: h.patch })
    await r.updater.rebuild(TREE_ID)
    const before = r.changes()
    h.progress({ stages: STAGES, lastLine: 'a' })
    expect(r.changes()).toBe(before + 1)
    h.progress({ stages: STAGES, lastLine: 'b' })
    h.progress({ stages: STAGES, lastLine: 'c' })
    expect(r.changes()).toBe(before + 1)
    expect(r.updater.view().rebuild!.lastLine).toBe('c')
    r.clock.t += 1_000
    h.progress({ stages: STAGES, lastLine: 'd' })
    expect(r.changes()).toBe(before + 2)
    h.progress({
      stages: [
        { ...STAGES[0], state: 'done' },
        { ...STAGES[1], state: 'running' }
      ]
    })
    expect(r.changes()).toBe(before + 3)
  })

  it('a failed build shows the reason, keeping its stages and last line', async () => {
    const h = rebuildHost()
    const r = rig({ host: h.patch })
    await r.updater.rebuild(TREE_ID)
    h.progress({ stages: STAGES, lastLine: 'error TS2322' })
    h.fail(new Error('The build failed at typecheck (exit 1)'))
    await r.updater.idle()
    expect(r.updater.view().rebuild).toMatchObject({
      phase: 'failed',
      tree: TREE,
      stages: STAGES,
      lastLine: 'error TS2322',
      error: 'The build failed at typecheck (exit 1)'
    })
    await expect(r.updater.apply('rebuild')).rejects.toThrow(/No rebuild is ready/)
  })

  it('cancel asks the host and goes back to idle; with nothing running it does nothing', async () => {
    const h = rebuildHost()
    const r = rig({ host: h.patch })
    await r.updater.cancelRebuild()
    expect(h.patch.cancelRebuild).not.toHaveBeenCalled()
    await r.updater.rebuild(TREE_ID)
    await r.updater.cancelRebuild()
    await r.updater.idle()
    expect(h.patch.cancelRebuild).toHaveBeenCalledTimes(1)
    expect(r.updater.view().rebuild).toEqual({ phase: 'idle' })
  })

  it('stop() stops a running rebuild (its process group would outlive the quit)', async () => {
    const h = rebuildHost()
    const r = rig({ host: h.patch })
    await r.updater.rebuild(TREE_ID)
    r.updater.stop()
    await r.updater.idle()
    expect(h.patch.cancelRebuild).toHaveBeenCalledTimes(1)
  })

  it('stop() asks a host that can stop rebuilds for good, even with none building yet', async () => {
    const stopRebuild = vi.fn(async () => {})
    const h = rebuildHost({ stopRebuild })
    const r = rig({ host: h.patch })
    r.updater.stop()
    expect(stopRebuild).toHaveBeenCalledTimes(1)
    expect(h.patch.cancelRebuild).not.toHaveBeenCalled()
    await expect(r.updater.rebuild(TREE_ID)).rejects.toThrow(/stopping/)
  })

  it("apply('rebuild') hands the built rebuild to the host; only once built, only when eligible", async () => {
    const h = rebuildHost()
    const r = rig({ host: h.patch })
    await expect(r.updater.apply('rebuild')).rejects.toThrow(/No rebuild is ready/)
    await r.updater.rebuild(TREE_ID)
    await expect(r.updater.apply('rebuild')).rejects.toThrow(/No rebuild is ready/)
    h.finish({ version: '1.0.0', commit: null })
    await r.updater.idle()
    r.host.eligibility.mockResolvedValueOnce({ ok: false, reason: 'read-only volume' })
    await expect(r.updater.apply('rebuild')).rejects.toThrow('read-only volume')
    expect(h.patch.applyRebuild).not.toHaveBeenCalled()
    await r.updater.apply('rebuild')
    expect(h.patch.applyRebuild).toHaveBeenCalledTimes(1)
    expect(r.host.apply).not.toHaveBeenCalled()
  })

  it('apply refuses an unknown source', async () => {
    const r = rig({ host: rebuildHost().patch })
    await expect(r.updater.apply('elsewhere' as never)).rejects.toThrow(/Unknown update source/)
  })

  it('a rebuild started after a failed one replaces it', async () => {
    const h = rebuildHost()
    const r = rig({ host: h.patch })
    await r.updater.rebuild(TREE_ID)
    h.fail(new Error('first failed'))
    await r.updater.idle()
    await r.updater.rebuild(TREE_ID)
    expect(r.updater.view().rebuild).toMatchObject({ phase: 'building' })
    expect(r.updater.view().rebuild!.error).toBeUndefined()
    h.finish({ version: '1.0.1', commit: 'def5678' })
    await r.updater.idle()
    expect(r.updater.view().rebuild).toMatchObject({ phase: 'built', built: { version: '1.0.1' } })
  })
})

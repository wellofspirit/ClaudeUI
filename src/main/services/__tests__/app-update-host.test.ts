/**
 * @vitest-environment node
 *
 * The desktop `AppUpdateHost` against a fake install in a temp folder (laid out
 * for the host's platform) and a fake relaunch service: what it hands the
 * relaunch machinery, which staged ids it accepts, the rebuild source rules,
 * and the boot sweep's use of the update state file. Nothing touches a real
 * install or the real `~/.claude/ui`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

vi.mock('../../../core/services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

import type { BuildInfo, DevBuildInfo } from '../../../shared/build-info'
import { INSTALL_MARKER_PRODUCT } from '../../../shared/install-marker'
import type { Exec } from '../app-update/exec'
import {
  createDesktopAppUpdateHost,
  desktopTarget,
  type DesktopAppUpdateDeps
} from '../app-update-host'
import type { RelaunchService } from '../relaunch/relaunch-service'
import { treeIdFor } from '../rebuild/trees'
import { FAKE_BUILD } from '../rebuild/__tests__/fake-build'
import { zip } from '../../../core/harness/install/__tests__/fixtures'

const HOST: 'darwin' | 'win32' = process.platform === 'win32' ? 'win32' : 'darwin'
const ENTRIES = HOST === 'darwin' ? [] : ['ClaudeUI.exe', 'resources']
const markerJson = (version: string): string =>
  JSON.stringify({
    schema: 1,
    product: INSTALL_MARKER_PRODUCT,
    kind: 'desktop',
    entries: ENTRIES,
    version
  })

let root: string
let home: string
let parent: string
let install: string
let execPath: string
let base: string

function build(dir: string, version: string): string {
  if (HOST === 'darwin') {
    fs.mkdirSync(path.join(dir, 'Contents', 'MacOS'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'Contents', 'Resources'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'Contents', 'MacOS', 'ClaudeUI'), 'exe')
    fs.writeFileSync(
      path.join(dir, 'Contents', 'Resources', 'claudeui-install.json'),
      markerJson(version)
    )
  } else {
    fs.mkdirSync(path.join(dir, 'resources'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'ClaudeUI.exe'), 'exe')
    fs.writeFileSync(path.join(dir, 'resources', 'claudeui-install.json'), markerJson(version))
  }
  return dir
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'app-update-host-')))
  home = path.join(root, 'home')
  fs.mkdirSync(home)
  parent = path.join(root, 'Apps')
  base = HOST === 'darwin' ? 'ClaudeUI.app' : 'ClaudeUI'
  install = build(path.join(parent, base), '1.0.0')
  execPath =
    HOST === 'darwin'
      ? path.join(install, 'Contents', 'MacOS', 'ClaudeUI')
      : path.join(install, 'ClaudeUI.exe')
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

const RELEASE: BuildInfo = {
  schema: 1,
  kind: 'release',
  version: '1.0.0',
  channel: 'stable',
  git: {
    describe: null,
    baseTag: 'v1.0.0',
    ahead: 0,
    commit: 'abc1234',
    dirty: false,
    branch: null
  },
  builtAt: '2026-11-01T00:00:00.000Z'
}

function relaunchFake(): RelaunchService & { requestRelaunch: ReturnType<typeof vi.fn> } {
  return {
    availability: () => ({ available: true }),
    eligible: () => ({ available: true }),
    requestRelaunch: vi.fn(async () => {}),
    relaunchInProgress: () => false,
    lastResult: () => null,
    reportHealthy: async () => {},
    takeRestore: () => null
  } as RelaunchService & { requestRelaunch: ReturnType<typeof vi.fn> }
}

function host(over: Partial<DesktopAppUpdateDeps> = {}) {
  const relaunch = relaunchFake()
  const h = createDesktopAppUpdateHost({
    platform: HOST,
    arch: HOST === 'darwin' ? 'arm64' : 'x64',
    execPath,
    appPath: path.join(root, 'app.asar'),
    relaunch: () => relaunch,
    sourceSetting: () => undefined,
    home,
    singleInstance: true,
    buildInfo: () => RELEASE,
    statePath: () => path.join(home, '.claude', 'ui', 'app-update.json'),
    exec: async () => {
      throw new Error('no tool in this test')
    },
    ...over
  })
  return { h, relaunch }
}

const stagedName = (version: string, t8 = 'abcdef01'): string => `.${base}.update-${version}-${t8}`

describe('desktopTarget', () => {
  it('maps the two published desktop builds, and nothing else', () => {
    expect(desktopTarget('darwin', 'arm64')).toBe('desktop-darwin-arm64')
    expect(desktopTarget('win32', 'x64')).toBe('desktop-win32-x64')
    expect(desktopTarget('darwin', 'x64')).toBeNull()
    expect(desktopTarget('win32', 'arm64')).toBeNull()
    expect(desktopTarget('linux', 'x64')).toBeNull()
  })
})

describe('the release seam', () => {
  it('reports the build, the target, eligibility and the downloads dir under home', async () => {
    const { h } = host()
    expect(h.buildInfo()).toBe(RELEASE)
    expect(h.target()).toBe(HOST === 'darwin' ? 'desktop-darwin-arm64' : 'desktop-win32-x64')
    await expect(h.eligibility()).resolves.toEqual({ ok: true })
    expect(h.downloadsDir()).toBe(path.join(home, '.claude', 'ui', 'updates', 'desktop'))
  })

  it('an install without its marker is not eligible, and nothing can be staged or applied', async () => {
    const res =
      HOST === 'darwin'
        ? path.join(install, 'Contents', 'Resources')
        : path.join(install, 'resources')
    fs.rmSync(path.join(res, 'claudeui-install.json'))
    const { h, relaunch } = host()
    await expect(h.eligibility()).resolves.toMatchObject({ ok: false })
    await expect(h.stage(path.join(root, 'x.zip'), '2.0.0')).rejects.toThrow(/install marker/)
    await expect(h.apply(stagedName('2.0.0'), '2.0.0')).rejects.toThrow(/install marker/)
    expect(relaunch.requestRelaunch).not.toHaveBeenCalled()
  })

  it("isStaged: only this install's staging names, present, with that version", async () => {
    build(path.join(parent, stagedName('2.0.0')), '2.0.0')
    const { h } = host()
    await expect(h.isStaged(stagedName('2.0.0'), '2.0.0')).resolves.toBe(true)
    await expect(h.isStaged(stagedName('2.0.0'), '2.0.1')).resolves.toBe(false)
    await expect(h.isStaged(stagedName('3.0.0'), '3.0.0')).resolves.toBe(false)
    for (const id of [
      `.${base}.old-2.0.0-abcdef01`,
      `../${stagedName('2.0.0')}`,
      path.join(parent, stagedName('2.0.0')),
      base
    ])
      await expect(h.isStaged(id, '2.0.0'), id).resolves.toBe(false)
  })

  it('apply hands the staged folder to the relaunch service as a release swap', async () => {
    const { h, relaunch } = host()
    await h.apply(stagedName('2.0.0'), '2.0.0')
    expect(relaunch.requestRelaunch).toHaveBeenCalledWith({
      mode: 'swap',
      stagedPath: path.join(parent, stagedName('2.0.0')),
      toVersion: '2.0.0',
      source: 'release'
    })
  })

  it('apply refuses an id that is not a staging name, before the relaunch service hears of it', async () => {
    const { h, relaunch } = host()
    for (const id of [`.${base}.failed-2.0.0-abcdef01`, `../../etc`, path.join(root, 'evil')])
      await expect(h.apply(id, '2.0.0')).rejects.toThrow(/not one ClaudeUI staged/)
    expect(relaunch.requestRelaunch).not.toHaveBeenCalled()
  })

  it('apply while the relaunch service is not configured yet says so', async () => {
    const { h } = host({ relaunch: () => null })
    await expect(h.apply(stagedName('2.0.0'), '2.0.0')).rejects.toThrow(/still starting/)
  })

  it.skipIf(HOST !== 'darwin')(
    "stage returns the staging folder's name (macOS, scripted ditto)",
    async () => {
      const ditto: Exec = async (_file, args) => {
        build(path.join(args[4], 'ClaudeUI.app'), '2.0.0')
        return { code: 0, stdout: '', stderr: '' }
      }
      const { h } = host({
        exec: ditto,
        stage: {
          newToken: () => 'abcdef01'.repeat(4),
          checkSignature: async () => ({ ok: true, identity: 'adhoc' })
        }
      })
      const archive = path.join(root, 'x.zip')
      fs.writeFileSync(archive, zip([{ name: 'ClaudeUI.app/Contents/MacOS/ClaudeUI', body: 'x' }]))
      await expect(h.stage(archive, '2.0.0')).resolves.toEqual({
        stagedId: stagedName('2.0.0')
      })
      await expect(h.isStaged(stagedName('2.0.0'), '2.0.0')).resolves.toBe(true)
      expect(fs.readdirSync(parent).filter((n) => n.startsWith('.'))).toEqual([stagedName('2.0.0')])
    }
  )
})

describe('rebuilds', () => {
  const local = (sourcePath: string): BuildInfo => ({
    ...RELEASE,
    kind: 'local',
    channel: undefined,
    sourcePath
  })

  it("available with a source checkout that exists: the setting, else a local build's own", () => {
    const repo = path.join(root, 'ClaudeUI')
    fs.mkdirSync(repo)
    expect(host().h.rebuildAvailable!()).toBe(false)
    expect(host({ sourceSetting: () => repo }).h.rebuildAvailable!()).toBe(true)
    expect(host({ sourceSetting: () => path.join(root, 'missing') }).h.rebuildAvailable!()).toBe(
      false
    )
    expect(host({ sourceSetting: () => 'relative/path' }).h.rebuildAvailable!()).toBe(false)
    expect(host({ buildInfo: () => local(repo) }).h.rebuildAvailable!()).toBe(true)
    expect(
      host({ buildInfo: (): BuildInfo | DevBuildInfo => ({ kind: 'dev' }) }).h.rebuildAvailable!()
    ).toBe(false)
    expect(host({ platform: 'linux' }).h.rebuildAvailable!()).toBe(false)
  })

  it('none where no desktop build is published (an Intel Mac, Windows on Arm): with a reason', async () => {
    const repo = path.join(root, 'ClaudeUI')
    fs.mkdirSync(repo)
    for (const [platform, arch] of [
      ['darwin', 'x64'],
      ['win32', 'arm64']
    ]) {
      const { h } = host({ platform, arch, sourceSetting: () => repo })
      expect(h.rebuildAvailable!()).toBe(false)
      await expect(h.trees!()).resolves.toEqual([])
      await expect(h.rebuild!('0123456789abcdef', () => {})).rejects.toThrow(
        new RegExp(`no desktop build for ${platform}-${arch}`)
      )
    }
  })

  it('a rebuild refused for an unwritable install folder says why without the folder', async () => {
    const { h } = host({
      probes: {
        canWriteDir: () => false,
        readFile: (f) => fs.readFileSync(f, 'utf8'),
        readdir: (d) => fs.readdirSync(d)
      },
      rebuilder: {
        listTrees: async () => [
          { id: '0123456789abcdef', path: root, name: 't', branch: 'b', commit: 'c', dirty: 0 }
        ],
        precheck: () => null,
        findBun: () => path.join(root, 'bun')
      }
    })
    const err = await h.rebuild!('0123456789abcdef', () => {}).then(
      () => null,
      (e: Error) => e
    )
    expect(err!.message).toMatch(
      /^Can't update here: the folder that holds ClaudeUI is not writable/
    )
    expect(err!.message).not.toContain(root)
  })

  it('lists the trees of the source checkout, without paths', async () => {
    const repo = path.join(root, 'ClaudeUI')
    fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true })
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'claudui' }))
    fs.writeFileSync(path.join(repo, 'scripts', 'build.mjs'), '')
    const git: Exec = async (_file, args) =>
      args.includes('worktree')
        ? {
            code: 0,
            stdout: `worktree ${repo}\nHEAD abcdef1234567\nbranch refs/heads/main\n\n`,
            stderr: ''
          }
        : { code: 0, stdout: '?? a\n', stderr: '' }
    const { h } = host({ sourceSetting: () => repo, exec: git })
    const trees = await h.trees!()
    expect(trees).toEqual([
      { id: treeIdFor(repo), name: 'main checkout', branch: 'main', commit: 'abcdef1', dirty: 1 }
    ])
    expect(JSON.stringify(trees)).not.toContain(root)
    await expect(host().h.trees!()).resolves.toEqual([])
  })

  it('applyRebuild: nothing built is refused; a built one goes to the relaunch service as a rebuild swap', async () => {
    const { h: idle } = host()
    await expect(idle.applyRebuild!()).rejects.toThrow(/No rebuild is ready/)

    const tree = path.join(root, 'tree')
    fs.mkdirSync(tree)
    const script = path.join(root, 'fake-build.cjs')
    fs.writeFileSync(script, FAKE_BUILD)
    const { h, relaunch } = host({
      rebuilder: {
        listTrees: async () => [
          { id: '0123456789abcdef', path: tree, name: 't', branch: 'b', commit: 'c', dirty: 0 }
        ],
        precheck: () => null,
        findBun: () => path.join(root, 'bun'),
        env: () => ({
          ...process.env,
          FAKE_BUILD_MODE: 'ok',
          FAKE_PLATFORM: HOST,
          FAKE_VERSION: '1.0.0',
          FAKE_MARKER: markerJson('1.0.0')
        }),
        spawnBuild: ((_f: string, _a: string[], opts: Parameters<typeof spawn>[2]) =>
          spawn(process.execPath, [script], opts)) as never,
        copyApp: async (from, to) => fs.cpSync(from, to, { recursive: true, errorOnExist: true })
      }
    })
    const started = await h.rebuild!('0123456789abcdef', () => {})
    expect(h.rebuildBusy()).toMatch(/rebuild is running/)
    await expect(started.done).resolves.toMatchObject({ version: '1.0.0' })
    expect(h.rebuildBusy()).toBeNull()
    await h.applyRebuild!()
    const call = relaunch.requestRelaunch.mock.calls[0][0]
    expect(call).toMatchObject({ mode: 'swap', toVersion: '1.0.0', source: 'rebuild' })
    expect(path.dirname(call.stagedPath)).toBe(parent)
    expect(path.basename(call.stagedPath)).toMatch(
      new RegExp(`^\\.${base.replace('.', '\\.')}\\.update-1\\.0\\.0-`)
    )
  })
})

describe('bootCleanup', () => {
  it('is skipped while single-instance enforcement is off (another copy may run from a sibling)', () => {
    const stale = build(path.join(parent, stagedName('2.1.0', 'bbbbbbbb')), '2.1.0')
    host({ singleInstance: false }).h.bootCleanup()
    host({ singleInstance: undefined }).h.bootCleanup()
    expect(fs.existsSync(stale)).toBe(true)
    host().h.bootCleanup()
    expect(fs.existsSync(stale)).toBe(false)
  })

  it('keeps the staged update the state file names and sweeps the rest', () => {
    const named = build(path.join(parent, stagedName('2.0.0', 'aaaaaaaa')), '2.0.0')
    const stale = build(path.join(parent, stagedName('2.1.0', 'bbbbbbbb')), '2.1.0')
    const statePath = path.join(home, '.claude', 'ui', 'app-update.json')
    fs.mkdirSync(path.dirname(statePath), { recursive: true })
    fs.writeFileSync(
      statePath,
      JSON.stringify({ schema: 1, staged: { version: '2.0.0', stagedId: path.basename(named) } })
    )
    host().h.bootCleanup()
    expect(fs.existsSync(named)).toBe(true)
    expect(fs.existsSync(stale)).toBe(false)
    expect(fs.existsSync(install)).toBe(true)
  })

  it('with no state file every staging leftover goes; an ineligible install sweeps nothing', () => {
    const stale = build(path.join(parent, stagedName('2.1.0', 'bbbbbbbb')), '2.1.0')
    const res =
      HOST === 'darwin'
        ? path.join(install, 'Contents', 'Resources')
        : path.join(install, 'resources')
    const markerFile = path.join(res, 'claudeui-install.json')
    const saved = fs.readFileSync(markerFile)
    fs.rmSync(markerFile)
    host().h.bootCleanup()
    expect(fs.existsSync(stale)).toBe(true)
    fs.writeFileSync(markerFile, saved)
    host().h.bootCleanup()
    expect(fs.existsSync(stale)).toBe(false)
  })
})

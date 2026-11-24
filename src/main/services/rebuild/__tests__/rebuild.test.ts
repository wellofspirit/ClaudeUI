/**
 * @vitest-environment node
 *
 * A local rebuild (`rebuild/rebuild.ts`): the pre-checks against temp trees,
 * `bun` lookup and the child environment, and the runner end to end with a
 * fake build command (a node script that prints what `scripts/build.mjs`
 * prints and writes a marked app into CLAUDEUI_BUILD_OUT). The install and its
 * siblings live in a temp folder laid out for the host's platform.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

vi.mock('../../../../core/services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

import { INSTALL_MARKER_PRODUCT } from '../../../../shared/install-marker'
import type { AppUpdateRebuildProgress } from '../../../../shared/types/app-update'
import { checkStagedBuild } from '../../app-update/stage'
import {
  createRebuilder,
  findBun,
  precheckTree,
  rebuildEnv,
  scrubIdentity,
  type RebuilderDeps
} from '../rebuild'
import type { SourceTree } from '../trees'
import { FAKE_BUILD } from './fake-build'

const HOST: 'darwin' | 'win32' = process.platform === 'win32' ? 'win32' : 'darwin'
const ENTRIES = HOST === 'darwin' ? [] : ['ClaudeUI.exe', 'resources']
const marker = (version: string): string =>
  JSON.stringify({
    schema: 1,
    product: INSTALL_MARKER_PRODUCT,
    kind: 'desktop',
    entries: ENTRIES,
    version
  })

let root: string
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-')))
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

// ── Pre-checks ────────────────────────────────────────────────────────────────

describe('precheckTree', () => {
  /** A ClaudeUI tree that passes, then broken one way at a time. */
  function tree(
    name: string,
    opts: {
      targets?: string
      pin?: string | null
      vendored?: string | null
      lock?: string
      modules?: 'own' | 'none' | { linkTo: string }
    } = {}
  ): string {
    const dir = path.join(root, name)
    fs.mkdirSync(path.join(dir, 'scripts', 'lib'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'scripts', 'lib', 'build-targets.mjs'),
      opts.targets ?? "export const t = { 'build:stage': [] }"
    )
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'claudui',
        ...(opts.pin === null ? {} : { claudeCliVersion: opts.pin ?? '2.1.330' })
      })
    )
    if (opts.vendored !== null) {
      fs.mkdirSync(path.join(dir, 'vendor', 'claude-cli'), { recursive: true })
      fs.writeFileSync(
        path.join(dir, 'vendor', 'claude-cli', 'version.json'),
        JSON.stringify({ version: opts.vendored ?? '2.1.330' })
      )
    }
    fs.writeFileSync(path.join(dir, 'bun.lock'), opts.lock ?? 'lock v1')
    const modules = opts.modules ?? 'own'
    if (modules === 'own') fs.mkdirSync(path.join(dir, 'node_modules'))
    else if (modules !== 'none')
      fs.symlinkSync(
        path.join(modules.linkTo, 'node_modules'),
        path.join(dir, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir'
      )
    return dir
  }

  it('passes a tree with its own node_modules', () => {
    expect(precheckTree(tree('ok'))).toBeNull()
  })

  it('a worktree linked to the main checkout passes while the lockfiles match', () => {
    const main = tree('ClaudeUI')
    expect(precheckTree(tree('wt', { modules: { linkTo: main } }))).toBeNull()
  })

  it("and is refused once its bun.lock differs from the main checkout's", () => {
    const main = tree('ClaudeUI', { lock: 'lock v2' })
    expect(precheckTree(tree('wt', { modules: { linkTo: main } }))).toBe(
      'Dependencies changed: run bun install in ClaudeUI first'
    )
  })

  it.each<[string, Parameters<typeof tree>[1], RegExp]>([
    ['old build scripts', { targets: "export const t = { 'build:mac': [] }" }, /predate rebuilds/],
    ['no Claude Code pin', { pin: null }, /does not pin a Claude Code version/],
    ['no vendored Claude Code', { vendored: null }, /vendor\/claude-cli is missing/],
    [
      'a vendored Claude Code other than the pin',
      { vendored: '2.1.329' },
      /pins Claude Code 2\.1\.330, but vendor\/claude-cli holds 2\.1\.329/
    ],
    ['no node_modules', { modules: 'none' }, /node_modules is missing/]
  ])('refuses %s, saying why', (_name, opts, reason) => {
    const dir = tree('t', opts)
    const why = precheckTree(dir)
    expect(why).toMatch(reason)
    expect(why).not.toContain(root)
  })
})

describe('findBun', () => {
  const p = HOST === 'win32' ? path.win32 : path.posix
  const exe = HOST === 'win32' ? 'bun.exe' : 'bun'

  it('takes the first bun on PATH, then its usual homes', () => {
    const bin = p.join(root, 'bin')
    const home = p.join(root, 'home')
    const files = new Set([p.join(bin, exe), p.join(home, '.bun', 'bin', exe)])
    const isFile = (f: string): boolean => files.has(f)
    expect(findBun({ PATH: `relative${p.delimiter}${bin}` }, HOST, home, isFile)).toBe(
      p.join(bin, exe)
    )
    expect(findBun({ PATH: '' }, HOST, home, isFile)).toBe(p.join(home, '.bun', 'bin', exe))
    expect(findBun({}, HOST, p.join(root, 'nobody'), () => false)).toBeNull()
  })

  it('reads a Windows Path key whatever its case', () => {
    const bin = 'C:\\Users\\me\\.bun\\bin'
    expect(
      findBun({ Path: bin }, 'win32', 'C:\\Users\\nobody', (f) => f === `${bin}\\bun.exe`)
    ).toBe(`${bin}\\bun.exe`)
  })
})

describe('rebuildEnv', () => {
  it('puts bun first on PATH, sets the output and no colour, drops what would change the build', () => {
    const env = rebuildEnv(
      {
        PATH: '/usr/bin',
        HOME: '/home/me',
        CLAUDEUI_CLI_VENDOR_DIR: '/scratch',
        CLAUDEUI_BUILD_KIND: 'release',
        CLAUDEUI_RELEASE_CHANNEL: 'stable',
        ELECTRON_RUN_AS_NODE: '1',
        FORCE_COLOR: '1'
      },
      '/opt/bun/bin/bun',
      '/out/rebuild-0123abcd',
      'darwin'
    )
    expect(env).toEqual({
      PATH: '/opt/bun/bin:/usr/bin',
      HOME: '/home/me',
      CLAUDEUI_BUILD_OUT: '/out/rebuild-0123abcd',
      FORCE_COLOR: '0'
    })
  })

  it('on Windows matches keys case-insensitively', () => {
    const env = rebuildEnv(
      { Path: 'C:\\Windows', claudeui_build_kind: 'release' },
      'C:\\bun\\bun.exe',
      'C:\\out',
      'win32'
    )
    expect(env.Path).toBe('C:\\bun;C:\\Windows')
    expect(env.PATH).toBeUndefined()
    expect(env.claudeui_build_kind).toBeUndefined()
  })
})

// ── The runner ────────────────────────────────────────────────────────────────

describe('createRebuilder', () => {
  let install: string
  let downloads: string
  let state: string
  let treeDir: string
  let script: string
  let TREE: SourceTree

  beforeEach(() => {
    const parent = path.join(root, 'Apps')
    install = path.join(parent, HOST === 'darwin' ? 'ClaudeUI.app' : 'ClaudeUI')
    const res =
      HOST === 'darwin'
        ? path.join(install, 'Contents', 'Resources')
        : path.join(install, 'resources')
    fs.mkdirSync(res, { recursive: true })
    fs.writeFileSync(path.join(res, 'claudeui-install.json'), marker('1.0.0'))
    downloads = path.join(root, 'updates', 'desktop')
    state = path.join(root, 'relaunch')
    treeDir = path.join(root, 'tree')
    fs.mkdirSync(treeDir)
    script = path.join(root, 'fake-build.cjs')
    fs.writeFileSync(script, FAKE_BUILD)
    TREE = {
      id: '0123456789abcdef',
      path: treeDir,
      name: 'main checkout',
      branch: 'main',
      commit: 'abc1234',
      dirty: 0
    }
  })

  const siblings = (): string[] =>
    fs.readdirSync(path.dirname(install)).filter((n) => n.startsWith('.'))

  function rig(
    mode: string,
    over: Partial<RebuilderDeps> = {},
    extraEnv: Record<string, string> = {}
  ) {
    // The build runs the fake script whatever bun and args it is given (asserted below).
    const spawnBuild = vi.fn((_file: string, _args: string[], opts: Parameters<typeof spawn>[2]) =>
      spawn(process.execPath, [script], opts)
    )
    const killGroup = vi.fn((pid: number, signal: NodeJS.Signals) => process.kill(-pid, signal))
    const killTree = vi.fn((pid: number) => process.kill(pid))
    const progress: AppUpdateRebuildProgress[] = []
    const onCreated = vi.fn()
    const onReleased = vi.fn()
    const rebuilder = createRebuilder({
      platform: HOST,
      install: () => ({ ok: true, path: install }),
      stateDir: state,
      downloadsDir: downloads,
      listTrees: async () => [TREE],
      relaunchBusy: () => false,
      exec: async () => {
        throw new Error('no tool in this test')
      },
      findBun: () => path.join(root, 'bin', HOST === 'win32' ? 'bun.exe' : 'bun'),
      env: () => ({
        ...process.env,
        FAKE_BUILD_MODE: mode,
        FAKE_PLATFORM: HOST,
        FAKE_VERSION: '1.0.0',
        FAKE_MARKER: marker('1.0.0'),
        ...extraEnv
      }),
      spawnBuild: spawnBuild as unknown as RebuilderDeps['spawnBuild'],
      copyApp: async (from, to) => fs.cpSync(from, to, { recursive: true, errorOnExist: true }),
      killGroup,
      killTree,
      precheck: () => null,
      newT8: () => '0123abcd',
      onCreated,
      onReleased,
      ...over
    })
    return {
      rebuilder,
      spawnBuild,
      killGroup,
      killTree,
      progress,
      onCreated,
      onReleased,
      start: () => rebuilder.start(TREE.id, (p) => progress.push(p))
    }
  }

  const outDir = (): string => path.join(downloads, 'rebuild-0123abcd')

  it('builds in the tree, stages the built app beside the install, and cleans up its output', async () => {
    const r = rig('ok')
    const started = await r.start()
    expect(started.tree).toEqual({
      name: 'main checkout',
      branch: 'main',
      commit: 'abc1234',
      dirty: 0
    })
    expect(JSON.stringify(started.tree)).not.toContain(root)
    expect(r.rebuilder.busy()).toMatch(/rebuild is running/)
    const [file, args, opts] = r.spawnBuild.mock.calls[0]
    expect(file).toBe(path.join(root, 'bin', HOST === 'win32' ? 'bun.exe' : 'bun'))
    expect(args).toEqual(['scripts/build.mjs', 'build:stage', '-v'])
    expect(opts).toMatchObject({ cwd: treeDir, detached: HOST !== 'win32' })
    expect(opts!.env!.CLAUDEUI_BUILD_OUT).toBe(outDir())
    expect(opts!.env!.FORCE_COLOR).toBe('0')

    await expect(started.done).resolves.toEqual({ version: '1.0.0', commit: 'feedfac' })
    const built = r.rebuilder.built()!
    expect(built).toMatchObject({ version: '1.0.0', commit: 'feedfac', treeName: 'main checkout' })
    expect(path.dirname(built.stagedPath)).toBe(path.dirname(install))
    expect(path.basename(built.stagedPath)).toMatch(
      new RegExp(
        `^\\.${path.basename(install).replace('.', '\\.')}\\.update-1\\.0\\.0-[0-9a-f]{8}$`
      )
    )
    expect(checkStagedBuild(built.stagedPath, HOST, '1.0.0').ok).toBe(true)
    expect(siblings()).toEqual([path.basename(built.stagedPath)])
    // The output folder went through the downloads gate; the log stays.
    expect(fs.existsSync(outDir())).toBe(false)
    expect(fs.readFileSync(`${outDir()}.log`, 'utf8')).toContain('build:stage ✓')
    expect(r.onCreated).toHaveBeenCalledWith(outDir())
    expect(r.onCreated).toHaveBeenCalledWith(built.stagedPath)
    expect(r.onReleased).toHaveBeenCalledWith(outDir())
    expect(r.rebuilder.busy()).toBeNull()
    // Progress: the stages as printed, then all done.
    const last = r.progress.at(-1)!
    expect(last.stages.map((s) => s.state)).toEqual(['done', 'done', 'done', 'done'])
    expect(last.stages[0].label).toBe('typecheck:node ‖ typecheck:web ‖ electron-vite build')
    expect(last.lastLine).toBe('build:stage ✓ (4 stages, 0.1s)')
  })

  it('a failed build: the reason names the stage, nothing is staged, the output is removed', async () => {
    const r = rig('fail')
    const started = await r.start()
    await expect(started.done).rejects.toThrow('The build failed at stamp build-info (exit 3)')
    expect(siblings()).toEqual([])
    expect(fs.existsSync(outDir())).toBe(false)
    expect(r.rebuilder.built()).toBeNull()
    expect(r.rebuilder.busy()).toBeNull()
    // The last line had the output folder in it: replaced.
    const lines = r.progress.map((p) => p.lastLine ?? '').join('\n')
    expect(lines).not.toContain(root)
  })

  it('a build without an install marker is not staged', async () => {
    const r = rig('unmarked')
    const started = await r.start()
    await expect(started.done).rejects.toThrow(/did not produce a ClaudeUI/)
    expect(siblings()).toEqual([])
    expect(fs.existsSync(outDir())).toBe(false)
  })

  it('cancel stops the build by its process group (pid), never by name, and cleans up', async () => {
    const r = rig('hang')
    const started = await r.start()
    const pidFile = path.join(treeDir, 'pid')
    while (!fs.existsSync(pidFile)) await new Promise((res) => setTimeout(res, 20))
    await r.rebuilder.cancel()
    await expect(started.done).rejects.toMatchObject({ name: 'RebuildCancelled' })
    const pid = r.spawnBuild.mock.results[0].value.pid as number
    if (HOST === 'win32') expect(r.killTree).toHaveBeenCalledWith(pid)
    else expect(r.killGroup).toHaveBeenCalledWith(pid, 'SIGTERM')
    expect(fs.existsSync(outDir())).toBe(false)
    expect(siblings()).toEqual([])
    expect(r.rebuilder.busy()).toBeNull()
  })

  it.skipIf(HOST === 'win32')(
    'a build that ignores SIGTERM gets SIGKILL after the grace period',
    async () => {
      const r = rig('stubborn', { cancelGraceMs: 200 })
      const started = await r.start()
      const pidFile = path.join(treeDir, 'pid')
      while (!fs.existsSync(pidFile)) await new Promise((res) => setTimeout(res, 20))
      await r.rebuilder.cancel()
      await expect(started.done).rejects.toMatchObject({ name: 'RebuildCancelled' })
      const pid = r.spawnBuild.mock.results[0].value.pid as number
      expect(r.killGroup.mock.calls).toEqual([
        [pid, 'SIGTERM'],
        [pid, 'SIGKILL']
      ])
    }
  )

  it('cancel with nothing running does nothing', async () => {
    const r = rig('ok')
    await r.rebuilder.cancel()
    expect(r.killGroup).not.toHaveBeenCalled()
    expect(r.killTree).not.toHaveBeenCalled()
  })

  it('one at a time', async () => {
    const r = rig('hang')
    const started = await r.start()
    await expect(r.start()).rejects.toThrow(/already running/)
    await r.rebuilder.cancel()
    await expect(started.done).rejects.toMatchObject({ name: 'RebuildCancelled' })
  })

  it.each<[string, Partial<RebuilderDeps>, RegExp]>([
    ['a relaunch in flight', { relaunchBusy: () => true }, /relaunch is in progress/],
    ['a tree the host does not list', { listTrees: async () => [] }, /not one ClaudeUI lists/],
    [
      'a pre-check',
      { precheck: () => 'Dependencies changed: run bun install in ClaudeUI first' },
      /Dependencies changed/
    ],
    ['no bun', { findBun: () => null }, /bun was not found/],
    [
      'an install that cannot be updated',
      { install: () => ({ ok: false, reason: 'not writable' }) },
      /not writable/
    ]
  ])('refuses before building: %s', async (_name, over, reason) => {
    const r = rig('ok', over)
    await expect(r.start()).rejects.toThrow(reason)
    expect(r.spawnBuild).not.toHaveBeenCalled()
    expect(fs.existsSync(downloads) ? fs.readdirSync(downloads) : []).toEqual([])
    expect(r.rebuilder.busy()).toBeNull()
  })

  it('a new rebuild replaces the one built before it', async () => {
    let t8 = 0
    const r = rig('ok', { newT8: () => `0000000${++t8}` })
    const first = await r.start()
    await first.done
    const previous = r.rebuilder.built()!.stagedPath
    const second = await r.start()
    expect(fs.existsSync(previous)).toBe(false)
    expect(r.rebuilder.built()).toBeNull()
    await second.done
    expect(siblings()).toEqual([path.basename(r.rebuilder.built()!.stagedPath)])
  })

  it('stages through the extract container: the copy lands in it, then is renamed; nothing else stays', async () => {
    const copied: string[] = []
    const r = rig('ok', {
      copyApp: async (from, to) => {
        copied.push(to)
        fs.cpSync(from, to, { recursive: true, errorOnExist: true })
      }
    })
    const started = await r.start()
    await started.done
    const staged = r.rebuilder.built()!.stagedPath
    const t8 = staged.slice(-8)
    const base = path.basename(install)
    expect(copied).toEqual([
      path.join(
        path.dirname(install),
        `.${base}.extract-1.0.0-${t8}`,
        HOST === 'darwin' ? 'ClaudeUI.app' : 'app'
      )
    ])
    expect(siblings()).toEqual([path.basename(staged)])
  })

  it('a copy that fails part-way (no marker yet) is removed by its staging record', async () => {
    const r = rig('ok', {
      copyApp: async (_from, to) => {
        fs.mkdirSync(path.join(to, 'half'), { recursive: true })
        fs.writeFileSync(path.join(to, 'half', 'f'), 'x')
        throw new Error('disk full')
      }
    })
    const started = await r.start()
    await expect(started.done).rejects.toThrow('disk full')
    expect(siblings()).toEqual([])
    expect(fs.existsSync(outDir())).toBe(false)
    expect(r.rebuilder.built()).toBeNull()
  })

  it('stop() while the pre-checks run: the build is never spawned, and nothing starts afterwards', async () => {
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    const r = rig('ok', {
      listTrees: async () => {
        await gate
        return [TREE]
      }
    })
    const starting = r.start()
    await r.rebuilder.stop()
    release()
    await expect(starting).rejects.toThrow(/quitting/)
    expect(r.spawnBuild).not.toHaveBeenCalled()
    expect(fs.existsSync(outDir())).toBe(false)
    expect(r.rebuilder.busy()).toBeNull()
    await expect(r.start()).rejects.toThrow(/quitting/)
    expect(r.spawnBuild).not.toHaveBeenCalled()
  })

  it('stop() while building cancels it like cancel() does', async () => {
    const r = rig('hang')
    const started = await r.start()
    const pidFile = path.join(treeDir, 'pid')
    while (!fs.existsSync(pidFile)) await new Promise((res) => setTimeout(res, 20))
    await r.rebuilder.stop()
    await expect(started.done).rejects.toMatchObject({ name: 'RebuildCancelled' })
    expect(HOST === 'win32' ? r.killTree : r.killGroup).toHaveBeenCalled()
    expect(siblings()).toEqual([])
  })

  it('errors a client sees carry no local path', async () => {
    const parent = path.dirname(install)
    const refused = rig('ok', {
      install: () => ({
        ok: false,
        reason: `Can't update here: ${parent} is not writable`,
        path: install
      })
    })
    const err = await refused.start().then(
      () => null,
      (e: Error) => e
    )
    expect(err!.message).toBe("Can't update here: … is not writable")
    const failing = rig('ok', {
      copyApp: async () => {
        throw new Error(`EACCES: permission denied, mkdir '${parent}/x' (${os.homedir()})`)
      }
    })
    const started = await failing.start()
    const failure = await started.done.then(
      () => null,
      (e: Error) => e
    )
    expect(failure!.message).not.toContain(parent)
    expect(failure!.message).not.toContain(os.homedir())
  })

  it.skipIf(HOST === 'win32')('the signing identity never reaches a progress line', async () => {
    const out = outDir()
    const r = rig(
      'ok',
      {},
      {
        MAC_SIGN_IDENTITY: 'Developer ID Application: Someone (TEAM123)',
        FAKE_SAY: `$ codesign --force --deep --sign Developer ID Application: Someone (TEAM123) ${out}/mac-arm64/ClaudeUI.app`
      }
    )
    const started = await r.start()
    await started.done
    const lines = r.progress.map((p) => p.lastLine ?? '')
    expect(lines).toContain(
      '$ codesign --force --deep --sign <identity> …/rebuild-0123abcd/mac-arm64/ClaudeUI.app'
    )
    expect(lines.join('\n')).not.toContain('Someone')
  })
})

describe('scrubIdentity', () => {
  it('replaces what follows --sign up to the path, even unquoted with spaces', () => {
    expect(
      scrubIdentity(
        '$ codesign --force --deep --sign ClaudeUI Dev …/rebuild-0123abcd/mac-arm64/ClaudeUI.app'
      )
    ).toBe('$ codesign --force --deep --sign <identity> …/rebuild-0123abcd/mac-arm64/ClaudeUI.app')
    expect(scrubIdentity('codesign --sign "My Cert" ~/x.app')).toBe(
      'codesign --sign <identity> ~/x.app'
    )
    expect(scrubIdentity('codesign --sign Dev')).toBe('codesign --sign <identity>')
  })

  it('replaces the known identity anywhere, and codesign / electron-builder identity fields', () => {
    expect(scrubIdentity('signed by ClaudeUI Dev today', 'ClaudeUI Dev')).toBe(
      'signed by <identity> today'
    )
    expect(scrubIdentity('Authority=Developer ID Application: X (T1)')).toBe('Authority=<identity>')
    expect(scrubIdentity('TeamIdentifier=T1')).toBe('TeamIdentifier=<identity>')
    expect(
      scrubIdentity(
        '  • signing file=…/ClaudeUI.app platform=darwin type=distribution identityName=Developer ID Application: X (T1) identityHash=ABCDEF provisioningProfile=none'
      )
    ).toBe(
      '  • signing file=…/ClaudeUI.app platform=darwin type=distribution identityName=<identity> identityHash=<identity> provisioningProfile=none'
    )
  })

  it('leaves an ad-hoc dash and ordinary lines alone', () => {
    expect(scrubIdentity('vite v6 building', '-')).toBe('vite v6 building')
  })
})

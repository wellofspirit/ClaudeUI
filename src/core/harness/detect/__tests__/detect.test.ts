/**
 * @vitest-environment node
 *
 * The detection pipeline end to end over temp-directory layouts, with the
 * `--version` and `node --version` runners stubbed: de-duplication,
 * classification (ADR-082 §3), pi's node, Codex's host, and
 * `bestSystemInstall`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { DetectedInstall, HarnessDetection } from '../../../../shared/harness-types'
import { harnessManifest } from '../../manifests'
import { bestSystemInstall, detectHarness, detectHarnesses, type DetectDeps } from '../detect'
import type { RunFn, RunResult } from '../run'
import { fingerprintOf } from '../fs-util'
import { cmdShim, writeNative, writePackage, writeText } from './layout'

/** Tested manifest versions: what a "tested" install reports. */
const CLAUDE_TESTED = harnessManifest('claude').tested
const OPENCODE_TESTED = harnessManifest('opencode').tested
const CODEX_TESTED = harnessManifest('codex').tested
const PI_TESTED = harnessManifest('pi').tested

const WIN = process.platform === 'win32'
const EXE = WIN ? '.exe' : ''
let tmp: string
let home: string

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'detect-pipeline-')))
  home = path.join(tmp, 'home')
  fs.mkdirSync(home)
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

const ok = (stdout: string): RunResult => ({ stdout, code: 0, timedOut: false })

/** Deps confined to the temp dir; `answers` maps an executable to its `--version` stdout. */
function depsFor(answers: Record<string, string>, extra: Partial<DetectDeps> = {}): DetectDeps {
  const probeRun = vi.fn<RunFn>(async (command) =>
    command in answers ? ok(answers[command]) : { stdout: '', code: 1, timedOut: false }
  )
  return {
    env: {
      APPDATA: path.join(home, 'AppData', 'Roaming'),
      LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
      ProgramData: path.join(tmp, 'ProgramData'),
      HOMEBREW_PREFIX: path.join(tmp, 'brew'),
      PNPM_HOME: path.join(tmp, 'pnpm')
    },
    homedir: home,
    pathEntries: [],
    probeRun,
    electron: null,
    nodeCache: new Map(),
    tmpdir: tmp,
    now: () => new Date('2026-09-30T00:00:00.000Z'),
    ...extra
  }
}

/** Only the installs the fixtures made (a CI host may have real ones under /usr/local). */
function mine(detection: HarnessDetection): DetectedInstall[] {
  return detection.installs.filter((i) => i.realPath.startsWith(tmp))
}

describe('classification', () => {
  it('labels the Claude Code 2.1.198 on PATH too old, and says why', async () => {
    const bin = writeNative(path.join(tmp, 'bin', `claude${EXE}`))
    const detection = await detectHarness(
      'claude',
      depsFor({ [bin]: '2.1.198 (Claude Code)\n' }, { pathEntries: [path.dirname(bin)] })
    )
    expect(detection.detectedAt).toBe('2026-09-30T00:00:00.000Z')
    const [install] = mine(detection)
    expect(install).toMatchObject({
      id: 'claude',
      displayPath: bin,
      realPath: bin,
      installKind: 'path',
      launch: { command: bin, args: [] },
      version: '2.1.198',
      verdict: 'too-old',
      reason: `Claude Code 2.1.198 is older than ${harnessManifest('claude').floor}, the oldest ClaudeUI supports`
    })
    expect(install.fingerprint).toEqual({
      path: bin,
      size: fs.statSync(bin).size,
      mtimeMs: fs.statSync(bin).mtimeMs
    })
    expect(bestSystemInstall(detection)).toBeNull()
  })

  // 2.x prints `opencode v<version>`; 1.x printed the bare version.
  it.each([
    [OPENCODE_TESTED, `opencode v${OPENCODE_TESTED}`, 'tested'],
    ['2.99.0', 'opencode v2.99.0', 'untested'],
    ['1.18.34', '1.18.34', 'too-old'],
    ['3.0.0', 'opencode v3.0.0', 'incompatible']
  ])('opencode %s is %s', async (version, stdout, verdict) => {
    const bin = writeNative(path.join(home, '.opencode', 'bin', `opencode${EXE}`))
    const [install] = mine(await detectHarness('opencode', depsFor({ [bin]: `${stdout}\n` })))
    expect(install).toMatchObject({ version, verdict, installKind: 'native-installer' })
  })

  it('labels a 1.x opencode too old as the previous line, not a broken build', async () => {
    const bin = writeNative(path.join(tmp, 'bin', `opencode${EXE}`))
    const [install] = mine(
      await detectHarness(
        'opencode',
        depsFor({ [bin]: '1.18.34\n' }, { pathEntries: [path.dirname(bin)] })
      )
    )
    const floor = harnessManifest('opencode').floor
    expect(install).toMatchObject({
      version: '1.18.34',
      verdict: 'too-old',
      reason: `opencode 1.18.34 is from the 1.x line; ClaudeUI uses opencode 2.x (${floor} or newer)`
    })
  })

  it("opencode's `local` (either line) is incompatible; a probe that fails is failed", async () => {
    const local = writeNative(path.join(home, '.opencode', 'bin', `opencode${EXE}`))
    const [a] = mine(await detectHarness('opencode', depsFor({ [local]: 'local\n' })))
    expect(a).toMatchObject({ version: null, verdict: 'incompatible' })
    const [v2] = mine(await detectHarness('opencode', depsFor({ [local]: 'opencode vlocal\n' })))
    expect(v2).toMatchObject({ version: null, verdict: 'incompatible' })
    const [b] = mine(await detectHarness('opencode', depsFor({})))
    expect(b).toMatchObject({
      version: null,
      verdict: 'failed',
      reason: '--version exited with code 1'
    })
  })
})

describe('de-duplication', () => {
  it('reports one install for a PATH shim and the package behind it, shown by the shim', async () => {
    const prefix = path.join(tmp, 'npm')
    const pkg = writePackage(
      path.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code'),
      { name: '@anthropic-ai/claude-code', version: CLAUDE_TESTED },
      { 'bin/claude.exe': 'native' }
    )
    const shim = writeText(
      path.join(prefix, 'claude.cmd'),
      cmdShim('node_modules/@anthropic-ai/claude-code/bin/claude.exe', false)
    )
    const exe = path.join(pkg, 'bin', 'claude.exe')
    // The same prefix is both on PATH (the shim) and an npm global root (a node lives there).
    writeNative(path.join(prefix, 'node.exe'))
    const deps = depsFor({ [exe]: `${CLAUDE_TESTED} (Claude Code)` }, { pathEntries: [prefix] })
    // Force the `.cmd` to be the PATH hit on every host.
    deps.platform = 'win32'
    deps.env = { ...deps.env, APPDATA: path.join(tmp, 'nowhere') }
    const installs = mine(await detectHarness('claude', deps))
    expect(installs).toHaveLength(1)
    expect(installs[0]).toMatchObject({ displayPath: shim, realPath: exe, verdict: 'tested' })
  })
})

describe('Codex', () => {
  it('needs codex-code-mode-host beside it', async () => {
    const dir = path.join(home, '.codex', 'packages', 'standalone', 'current', 'bin')
    const bin = writeNative(path.join(dir, `codex${EXE}`))
    const answers = { [bin]: `codex-cli ${CODEX_TESTED}\n` }
    const [without] = mine(await detectHarness('codex', depsFor(answers)))
    expect(without).toMatchObject({
      version: CODEX_TESTED,
      verdict: 'unsupported',
      reason: 'codex-code-mode-host not found beside it'
    })
    writeNative(path.join(dir, `codex-code-mode-host${EXE}`))
    const [withHost] = mine(await detectHarness('codex', depsFor(answers)))
    expect(withHost).toMatchObject({
      version: CODEX_TESTED,
      verdict: 'tested',
      installKind: 'standalone'
    })
  })
})

describe('pi', () => {
  const PI = '@earendil-works/pi-coding-agent'

  function npmPi(): { cli: string; shimDir: string } {
    const prefix = path.join(tmp, 'npm')
    const pkg = writePackage(
      path.join(prefix, 'node_modules', ...PI.split('/')),
      { name: PI, version: PI_TESTED },
      { 'dist/bundle/cli.js': '#!/usr/bin/env node\n' }
    )
    writeText(path.join(prefix, 'pi.cmd'), cmdShim(`node_modules/${PI}/dist/bundle/cli.js`, true))
    return { cli: path.join(pkg, 'dist', 'bundle', 'cli.js'), shimDir: prefix }
  }

  it('runs cli.js under the node beside the shim and probes it that way', async () => {
    const { cli, shimDir } = npmPi()
    const node = writeNative(path.join(shimDir, 'node.exe'))
    const run = vi.fn<RunFn>(async () => ok('v24.1.0\n'))
    const probeRun = vi.fn<RunFn>(async (command, args) =>
      command === node && args[0] === cli
        ? ok(`${PI_TESTED}\n`)
        : { stdout: '', code: 1, timedOut: false }
    )
    const deps = depsFor({}, { run, probeRun, pathEntries: [shimDir], platform: 'win32' })
    const [install] = mine(await detectHarness('pi', deps))
    expect(install).toMatchObject({
      realPath: cli,
      launch: { command: node, args: [cli] },
      node: { path: node, version: '24.1.0' },
      version: PI_TESTED,
      verdict: 'tested'
    })
    expect(install.fingerprint.path).toBe(cli)
    // The node is fingerprinted too, so the resolver notices it change.
    expect(install.nodeFingerprint).toEqual(fingerprintOf(node))
  })

  it('reports Electron as the node when nothing suitable is installed', async () => {
    const { cli, shimDir } = npmPi()
    const electron = { execPath: path.join(tmp, 'ClaudeUI.exe'), nodeVersion: '24.18.1' }
    const probeRun = vi.fn<RunFn>(async (_c, _a, options) =>
      options.env?.ELECTRON_RUN_AS_NODE === '1'
        ? ok(`${PI_TESTED}\n`)
        : { stdout: '', code: 1, timedOut: false }
    )
    const deps = depsFor({}, { probeRun, electron, pathEntries: [shimDir], platform: 'win32' })
    const [install] = mine(await detectHarness('pi', deps))
    expect(install).toMatchObject({
      launch: {
        command: electron.execPath,
        args: [cli],
        env: { ELECTRON_RUN_AS_NODE: '1', CLAUDEUI_PI_ELECTRON_NODE: '1' }
      },
      node: { kind: 'electron', version: '24.18.1' },
      verdict: 'tested'
    })
    expect(install).not.toHaveProperty('nodeFingerprint')
  })

  function managedPi(): { root: string; cli: string; nodeBin: string; dataHome: string } {
    const root = path.join(home, '.pi', 'agent', 'install')
    writeText(
      path.join(root, 'managed-install.json'),
      JSON.stringify({ kind: 'pi-managed-install', schemaVersion: 1, layout: 'releases-v1' })
    )
    writeText(path.join(root, 'current-version'), '0.87.1\n')
    const pkg = writePackage(
      path.join(root, 'releases', '0.87.1', 'node_modules', ...PI.split('/')),
      { name: PI, version: '0.87.1' },
      { 'dist/bundle/cli.js': '#!/usr/bin/env node\n' }
    )
    const dataHome = path.join(tmp, 'data')
    return {
      root,
      cli: path.join(pkg, 'dist', 'bundle', 'cli.js'),
      nodeBin: path.join(dataHome, 'pi-node', 'current', 'bin'),
      dataHome
    }
  }

  it("puts pi.dev's pi-node first on PATH when it is the node chosen", async () => {
    const { root, cli, nodeBin, dataHome } = managedPi()
    const node = writeNative(path.join(nodeBin, `node${EXE}`))
    const run = vi.fn<RunFn>(async () => ok('v24.1.0\n'))
    const probeRun = vi.fn<RunFn>(async () => ok('0.87.1\n'))
    const deps = depsFor({}, { run, probeRun })
    deps.env = { ...deps.env, XDG_DATA_HOME: dataHome, PATH: '/detection/time/path' }
    const [install] = mine(await detectHarness('pi', deps))
    expect(install.launch).toEqual({
      command: node,
      args: [cli],
      env: { PI_MANAGED_INSTALL_ROOT: root },
      pathPrepend: [nodeBin]
    })
  })

  it('leaves pi-node off PATH when it is too old and another node runs pi', async () => {
    const { cli, nodeBin, dataHome } = managedPi()
    const oldNode = writeNative(path.join(nodeBin, `node${EXE}`))
    const pathDir = path.join(tmp, 'usr', 'bin')
    const good = writeNative(path.join(pathDir, `node${EXE}`))
    const run = vi.fn<RunFn>(async (command) => ok(command === oldNode ? 'v18.0.0\n' : 'v24.1.0\n'))
    const probeRun = vi.fn<RunFn>(async () => ok('0.87.1\n'))
    const deps = depsFor({}, { run, probeRun, pathEntries: [pathDir] })
    deps.env = { ...deps.env, XDG_DATA_HOME: dataHome }
    const [install] = mine(await detectHarness('pi', deps))
    expect(install.launch?.command).toBe(good)
    expect(install.launch?.args).toEqual([cli])
    expect(install.launch).not.toHaveProperty('pathPrepend')
  })

  it('is unsupported without a suitable node or Electron', async () => {
    const { shimDir } = npmPi()
    const probeRun = vi.fn<RunFn>()
    const deps = depsFor({}, { probeRun, pathEntries: [shimDir], platform: 'win32' })
    const [install] = mine(await detectHarness('pi', deps))
    expect(install).toMatchObject({
      launch: null,
      verdict: 'unsupported',
      reason: 'pi needs Node 22.19 or newer'
    })
    expect(probeRun).not.toHaveBeenCalled()
  })
})

describe('detectHarnesses', () => {
  it('detects every harness, one probe at a time when asked', async () => {
    const claude = writeNative(path.join(tmp, 'bin', `claude${EXE}`))
    const opencode = writeNative(path.join(tmp, 'bin', `opencode${EXE}`))
    let active = 0
    let peak = 0
    const probeRun = vi.fn<RunFn>(async (command) => {
      peak = Math.max(peak, ++active)
      await new Promise((r) => setTimeout(r, 5))
      active--
      return ok(
        command === claude ? `${CLAUDE_TESTED} (Claude Code)` : `opencode v${OPENCODE_TESTED}`
      )
    })
    const deps = depsFor({}, { probeRun, pathEntries: [path.join(tmp, 'bin')], concurrency: 1 })
    const detections = await detectHarnesses(undefined, deps)
    expect(detections.map((d) => d.id)).toEqual(['claude', 'opencode', 'pi', 'codex'])
    expect(mine(detections[0])[0]).toMatchObject({ realPath: claude, verdict: 'tested' })
    expect(mine(detections[1])[0]).toMatchObject({ realPath: opencode, verdict: 'tested' })
    expect(peak).toBe(1)
  })
})

describe('bestSystemInstall', () => {
  function install(version: string | null, verdict: DetectedInstall['verdict']): DetectedInstall {
    return {
      id: 'opencode',
      displayPath: `/p/${version}-${verdict}`,
      realPath: `/p/${version}-${verdict}`,
      launch: { command: `/p/${version}`, args: [] },
      installKind: 'path',
      version,
      verdict,
      fingerprint: { path: '/p', size: 1, mtimeMs: 1 }
    }
  }
  const detection = (installs: DetectedInstall[]): HarnessDetection => ({
    id: 'opencode',
    detectedAt: '',
    installs
  })

  it('picks the newest usable install', () => {
    const best = bestSystemInstall(
      detection([
        install('1.18.32', 'tested'),
        install('1.19.0', 'untested'),
        install('2.0.0', 'incompatible'),
        install(null, 'failed'),
        install('1.20.0', 'unsupported')
      ])
    )
    expect(best?.version).toBe('1.19.0')
  })

  it('prefers tested at the same version', () => {
    const tested = install('1.18.32', 'tested')
    expect(bestSystemInstall(detection([install('1.18.32', 'untested'), tested]))).toBe(tested)
  })

  it('is null when nothing is usable', () => {
    expect(bestSystemInstall(detection([install('1.0.0', 'too-old')]))).toBeNull()
  })
})

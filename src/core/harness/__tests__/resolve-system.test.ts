/**
 * @vitest-environment node
 *
 * A System selection through the resolver (ADR-082 §2-3): the detection cache
 * is read, never trusted blindly, and a missing or stale cache asks for a
 * background re-detection instead of probing on the spot. Real temp files
 * stand in for the installs; the cache is written where the resolver reads
 * it (the test home the setup file redirects to).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const electronCtl = vi.hoisted(() => ({
  current: null as { execPath: string; nodeVersion: string } | null
}))
vi.mock('../detect/node-choice', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../detect/node-choice')>()),
  currentElectron: () => electronCtl.current
}))

import type {
  DetectedInstall,
  HarnessDetection,
  HarnessesConfig,
  HarnessId
} from '../../../shared/harness-types'
import { setHostIsPackaged, setHostPaths } from '../../host'
import { getCliVersion, harnessHasPatch } from '../../sdk/harness'
import { locateBunClaude } from '../../sdk/locate'
import { locatePiDisplayPath } from '../../pi/pi-locate'
import { harnessDetectionPath, saveDetectionCache } from '../detect/detection-cache'
import { fingerprintOf } from '../detect/fs-util'
import { withLaunch } from '../launch'
import { harnessManifest } from '../manifests'
import {
  harnessEnvVar,
  harnessUnavailableMessage,
  invalidateHarness,
  resolveHarness,
  setDetectionRequester
} from '../resolve'
import { harnessesConfigPath } from '../selection-store'
import { HARNESS_STORE_ENV } from '../store'
import { fakeHarnessInstall } from '../../../test/helpers/fake-harness'

const EXE = process.platform === 'win32' ? '.exe' : ''
const CLAUDE_TESTED = harnessManifest('claude').tested
const PI_TESTED = harnessManifest('pi').tested

let tmp: string
let requested: HarnessId[]
const savedEnv: Record<string, string | undefined> = {}

function writeSelections(selections: HarnessesConfig['selections']): void {
  fs.mkdirSync(path.dirname(harnessesConfigPath()), { recursive: true })
  fs.writeFileSync(harnessesConfigPath(), JSON.stringify({ selections }))
}

function file(rel: string, content = 'x'): string {
  const p = path.join(tmp, ...rel.split('/'))
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
  return p
}

function detection(id: HarnessId, installs: DetectedInstall[]): HarnessDetection {
  return { id, detectedAt: '2026-09-30T00:00:00.000Z', installs }
}

/** A native System install as detection writes it, fingerprinted now. */
function nativeInstall(
  id: HarnessId,
  version: string,
  overrides: Partial<DetectedInstall> = {}
): DetectedInstall {
  const real = file(`system/${id}-${version}/${id}${EXE}`)
  return {
    id,
    displayPath: real,
    realPath: real,
    launch: { command: real, args: [] },
    installKind: 'path',
    version,
    verdict: 'tested',
    fingerprint: fingerprintOf(real),
    ...overrides
  }
}

/** A System pi from npm, run by a node on disk. */
function piOnNode(overrides: Partial<DetectedInstall> = {}): DetectedInstall {
  const cli = file('npm/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js')
  const node = file(`node/bin/node${EXE}`, 'node')
  return {
    id: 'pi',
    displayPath: file('npm/pi.cmd'),
    realPath: cli,
    launch: { command: node, args: [cli] },
    installKind: 'npm',
    version: PI_TESTED,
    verdict: 'tested',
    fingerprint: fingerprintOf(cli),
    node: { path: node, version: '24.1.0' },
    nodeFingerprint: fingerprintOf(node),
    ...overrides
  }
}

/** A System pi from npm, run by Electron's own Node. */
function piOnElectron(overrides: Partial<DetectedInstall> = {}): DetectedInstall {
  const cli = file('npm/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js')
  return {
    id: 'pi',
    displayPath: file('npm/pi.cmd'),
    realPath: cli,
    launch: {
      command: path.join(tmp, 'OldClaudeUI', `ClaudeUI${EXE}`),
      args: [cli],
      env: { ELECTRON_RUN_AS_NODE: '1', CLAUDEUI_PI_ELECTRON_NODE: '1' }
    },
    installKind: 'npm',
    version: PI_TESTED,
    verdict: 'tested',
    fingerprint: fingerprintOf(cli),
    node: { kind: 'electron', version: '24.1.0' },
    ...overrides
  }
}

/** Move a file's mtime, as an upgrade in place would. */
function touch(p: string): void {
  const later = new Date(Date.now() + 120_000)
  fs.utimesSync(p, later, later)
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-system-')))
  setHostPaths({ getAppPath: () => path.join(tmp, 'app') })
  for (const id of ['claude', 'opencode', 'pi', 'codex'] as const) {
    savedEnv[id] = process.env[harnessEnvVar(id)]
    delete process.env[harnessEnvVar(id)]
  }
  savedEnv.store = process.env[HARNESS_STORE_ENV]
  process.env[HARNESS_STORE_ENV] = path.join(tmp, 'store')
  fs.rmSync(harnessesConfigPath(), { force: true })
  fs.rmSync(harnessDetectionPath(), { force: true })
  requested = []
  setDetectionRequester((id) => requested.push(id))
  electronCtl.current = null
  invalidateHarness()
})

afterEach(() => {
  setDetectionRequester(null)
  setHostPaths(null)
  for (const [id, value] of Object.entries(savedEnv)) {
    const name = id === 'store' ? HARNESS_STORE_ENV : harnessEnvVar(id as HarnessId)
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  fs.rmSync(harnessesConfigPath(), { force: true })
  fs.rmSync(harnessDetectionPath(), { force: true })
  fs.rmSync(tmp, { recursive: true, force: true })
  invalidateHarness()
})

describe('a usable System install', () => {
  it('runs a fresh, consistent native install as itself, with its detected version', () => {
    const install = nativeInstall('opencode', harnessManifest('opencode').tested)
    saveDetectionCache([detection('opencode', [install])])
    writeSelections({ opencode: { source: 'system' } })

    expect(resolveHarness('opencode')).toEqual({
      id: 'opencode',
      path: install.realPath,
      launch: { command: install.realPath, args: [] },
      dir: path.dirname(install.realPath),
      source: 'system',
      version: install.version,
      displayPath: install.displayPath
    })
    expect(requested).toEqual([])
  })

  it('runs pi as <node> <cli.js>, with the launcher env and its node dir before the site PATH', () => {
    const base = piOnNode()
    const node = (base.node as { path: string }).path
    const install = piOnNode({
      launch: {
        command: node,
        args: [base.realPath],
        env: { PI_MANAGED_INSTALL_ROOT: path.join(tmp, 'npm') },
        pathPrepend: [path.dirname(node)]
      }
    })
    saveDetectionCache([detection('pi', [install])])
    writeSelections({ pi: { source: 'system' } })

    const resolved = resolveHarness('pi')
    expect(resolved).toMatchObject({
      source: 'system',
      path: install.realPath,
      // The shim the user would run, not the `cli.js` node runs.
      displayPath: install.displayPath,
      version: PI_TESTED,
      launch: {
        command: node,
        args: [install.realPath],
        env: { PI_MANAGED_INSTALL_ROOT: path.join(tmp, 'npm') },
        pathPrepend: [path.dirname(node)]
      }
    })
    const composed = withLaunch(resolved.launch!, ['--mode', 'rpc'], { PATH: '/site/bin' }, 'linux')
    expect(composed.args).toEqual([install.realPath, '--mode', 'rpc'])
    expect(composed.env?.PATH).toBe(`${path.dirname(node)}:/site/bin`)
  })

  it("`pi:binary-path` names the System pi's shim, not the cli.js node runs", () => {
    const install = piOnNode()
    saveDetectionCache([detection('pi', [install])])
    writeSelections({ pi: { source: 'system' } })
    expect(locatePiDisplayPath()).toBe(install.displayPath)
    // What spawns is still the script, under node.
    expect(resolveHarness('pi').path).toBe(install.realPath)
  })

  it('`pi:binary-path` is the executable itself for every other source', () => {
    const dir = fakeHarnessInstall(path.join(tmp, 'store'), 'pi', PI_TESTED)
    const bin = path.join(dir, `pi${EXE}`)
    expect(locatePiDisplayPath()).toBe(bin)
    expect(resolveHarness('pi').displayPath).toBeUndefined()
  })

  it('picks the newest usable install, as bestSystemInstall does', () => {
    // Newer than the pin, so it stays usable whatever the floor is (floor = tested).
    const [major, minor, patch] = CLAUDE_TESTED.split('.').map(Number)
    const newer = nativeInstall('claude', `${major}.${minor}.${patch + 1}`, { verdict: 'untested' })
    const tested = nativeInstall('claude', CLAUDE_TESTED)
    saveDetectionCache([detection('claude', [tested, newer])])
    writeSelections({ claude: { source: 'system' } })
    expect(resolveHarness('claude').path).toBe(newer.realPath)
  })
})

// Only Claude Code falls back (to its bundled copy); opencode, pi and Codex are
// not bundled (ADR-082 §8), so an unusable System choice resolves to nothing,
// even with ClaudeUI's own copy installed.
describe('an unusable System install', () => {
  function managedOpencode(): void {
    fakeHarnessInstall(path.join(tmp, 'store'), 'opencode', harnessManifest('opencode').tested)
  }

  it('before detection has run, and asks for one', () => {
    managedOpencode()
    writeSelections({ opencode: { source: 'system' } })
    expect(resolveHarness('opencode')).toMatchObject({
      path: null,
      source: 'system',
      reason: 'System detection has not run yet'
    })
    expect(requested).toEqual(['opencode'])
    // Cached like any resolution: asking again neither re-reads nor re-asks.
    resolveHarness('opencode')
    expect(requested).toEqual(['opencode'])
  })

  it('when the install changed since detection (stale fingerprint), and asks for a re-detection', () => {
    const install = nativeInstall('opencode', harnessManifest('opencode').tested)
    saveDetectionCache([detection('opencode', [install])])
    writeSelections({ opencode: { source: 'system' } })
    touch(install.realPath)

    expect(resolveHarness('opencode')).toMatchObject({
      path: null,
      source: 'system',
      reason: 'System opencode changed since it was detected'
    })
    expect(requested).toEqual(['opencode'])
  })

  it('when the install is gone', () => {
    const install = nativeInstall('opencode', harnessManifest('opencode').tested)
    saveDetectionCache([detection('opencode', [install])])
    writeSelections({ opencode: { source: 'system' } })
    fs.rmSync(install.realPath)
    expect(resolveHarness('opencode').reason).toMatch(
      /^System opencode changed since it was detected/
    )
  })

  it.each<[string, (i: DetectedInstall) => DetectedInstall]>([
    [
      'a command other than the fingerprinted file',
      (i) => ({ ...i, launch: { command: file('evil/payload.exe'), args: [] } })
    ],
    [
      'leading arguments on a native launch',
      (i) => ({ ...i, launch: { ...i.launch!, args: ['-e', 'x'] } })
    ],
    [
      'environment on a native launch',
      (i) => ({ ...i, launch: { ...i.launch!, env: { NODE_OPTIONS: '--require x' } } })
    ],
    [
      'a fingerprint of a different file',
      (i) => ({ ...i, fingerprint: fingerprintOf(file('other/opencode.exe')) })
    ]
  ])('rejects a tampered cache: %s', (_label, tamper) => {
    saveDetectionCache([
      detection('opencode', [tamper(nativeInstall('opencode', harnessManifest('opencode').tested))])
    ])
    writeSelections({ opencode: { source: 'system' } })
    expect(resolveHarness('opencode')).toMatchObject({
      path: null,
      source: 'system',
      reason: "System opencode's detection record does not match the install"
    })
  })

  it.each<[string, (i: DetectedInstall) => DetectedInstall]>([
    [
      'a node other than the fingerprinted one',
      (i) => ({ ...i, launch: { ...i.launch!, command: file('evil/node') } })
    ],
    [
      'a script other than realPath',
      (i) => ({ ...i, launch: { ...i.launch!, args: [file('evil.js')] } })
    ],
    [
      'env beyond the launcher root',
      (i) => ({ ...i, launch: { ...i.launch!, env: { NODE_OPTIONS: '--require evil.js' } } })
    ],
    [
      'a launcher root the script is not under',
      (i) => ({
        ...i,
        launch: { ...i.launch!, env: { PI_MANAGED_INSTALL_ROOT: path.join(tmp, 'elsewhere') } }
      })
    ],
    [
      'a PATH directory other than the node',
      (i) => ({ ...i, launch: { ...i.launch!, pathPrepend: [path.join(tmp, 'evil')] } })
    ],
    ['no node fingerprint', (i) => ({ ...i, nodeFingerprint: undefined })]
  ])('rejects a tampered pi launch: %s', (_label, tamper) => {
    saveDetectionCache([detection('pi', [tamper(piOnNode())])])
    writeSelections({ pi: { source: 'system' } })
    expect(resolveHarness('pi')).toMatchObject({
      path: null,
      source: 'system',
      reason: expect.stringMatching(/^System pi's detection record does not match the install/)
    })
  })

  it("when pi's node is gone or changed", () => {
    const install = piOnNode()
    saveDetectionCache([detection('pi', [install])])
    writeSelections({ pi: { source: 'system' } })
    fs.rmSync((install.node as { path: string }).path)
    expect(resolveHarness('pi').reason).toMatch(/^System pi changed since it was detected/)
    expect(requested).toEqual(['pi'])
  })

  it('when the current manifest no longer accepts the cached version', () => {
    // Cached as untested; below this build's floor, so too old now.
    saveDetectionCache([
      detection('claude', [nativeInstall('claude', '2.1.270', { verdict: 'untested' })])
    ])
    writeSelections({ claude: { source: 'system' } })
    expect(resolveHarness('claude')).toMatchObject({
      source: 'bundled',
      // The fallback names why, in this build's terms (the cached reason was the old label's).
      reason: expect.stringMatching(
        new RegExp(
          `^No usable System Claude Code found: Claude Code 2\\.1\\.270 is older than ${harnessManifest('claude').floor.replaceAll('.', '\\.')}, the oldest ClaudeUI supports`
        )
      )
    })
    expect(requested).toEqual([])
  })

  it('never runs an install detection could not label runnable', () => {
    saveDetectionCache([
      detection('claude', [
        nativeInstall('claude', CLAUDE_TESTED, { verdict: 'failed', version: null })
      ])
    ])
    writeSelections({ claude: { source: 'system' } })
    expect(resolveHarness('claude').reason).toMatch(/^No usable System Claude Code found/)
  })
})

describe("pi on Electron's own Node", () => {
  it('ignores the cached command and runs this Electron, with ELECTRON_NODE_ENV', () => {
    electronCtl.current = {
      execPath: path.join(tmp, 'ClaudeUI', `ClaudeUI${EXE}`),
      nodeVersion: '24.6.0'
    }
    const install = piOnElectron()
    saveDetectionCache([detection('pi', [install])])
    writeSelections({ pi: { source: 'system' } })

    expect(resolveHarness('pi')).toMatchObject({
      source: 'system',
      launch: {
        command: electronCtl.current.execPath,
        args: [install.realPath],
        env: { ELECTRON_RUN_AS_NODE: '1', CLAUDEUI_PI_ELECTRON_NODE: '1' }
      }
    })
  })

  it('is unusable outside Electron (claudeui-server), without asking for a re-detection', () => {
    saveDetectionCache([detection('pi', [piOnElectron()])])
    writeSelections({ pi: { source: 'system' } })
    expect(resolveHarness('pi')).toMatchObject({
      path: null,
      source: 'system',
      reason: expect.stringMatching(
        /^No usable System pi found: the one detected runs on ClaudeUI's own Node/
      )
    })
    expect(requested).toEqual([])
  })

  it('falls to a pi on a disk node when not in Electron', () => {
    // Written first: both fixtures share one cli.js, and each fingerprints it.
    const onElectron = piOnElectron({ version: '0.99.0', verdict: 'untested' })
    const onNode = piOnNode()
    saveDetectionCache([detection('pi', [onElectron, onNode])])
    writeSelections({ pi: { source: 'system' } })
    expect(resolveHarness('pi').launch?.command).toBe((onNode.node as { path: string }).path)
  })

  it('rejects an Electron launch carrying a PATH prepend', () => {
    electronCtl.current = {
      execPath: path.join(tmp, 'ClaudeUI', `ClaudeUI${EXE}`),
      nodeVersion: '24.6.0'
    }
    const install = piOnElectron()
    saveDetectionCache([
      detection('pi', [
        { ...install, launch: { ...install.launch!, pathPrepend: [path.join(tmp, 'x')] } }
      ])
    ])
    writeSelections({ pi: { source: 'system' } })
    expect(resolveHarness('pi')).toMatchObject({ path: null, source: 'system' })
  })
})

describe('a System Claude Code', () => {
  it('reports the detected version and carries no patches (no version.json beside it)', () => {
    const install = nativeInstall('claude', CLAUDE_TESTED)
    saveDetectionCache([detection('claude', [install])])
    writeSelections({ claude: { source: 'system' } })

    expect(locateBunClaude()).toBe(install.realPath)
    expect(getCliVersion()).toBe(CLAUDE_TESTED)
    expect(harnessHasPatch('voice-server')).toBe(false)
    expect(harnessHasPatch('subagent-streaming')).toBe(false)
  })
})

describe('harnessUnavailableMessage', () => {
  it("surfaces the resolver's reason; installing ClaudeUI's copy would not help a System choice", () => {
    writeSelections({ pi: { source: 'system' } })
    expect(harnessUnavailableMessage('pi')).toBe('System detection has not run yet')
  })

  it('gives a packaged app only the reason', () => {
    setHostIsPackaged(() => true)
    try {
      writeSelections({ pi: { source: 'system' } })
      expect(harnessUnavailableMessage('pi')).toBe('System detection has not run yet')
    } finally {
      setHostIsPackaged(null)
    }
  })
})

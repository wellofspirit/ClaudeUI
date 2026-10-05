/**
 * @vitest-environment node
 *
 * The harness resolver (ADR-082): which executable runs for each harness.
 * Real temp directories stand in for the app root, the vendored Claude Code
 * payload and the managed store; `node:fs` is wrapped in pass-through spies
 * only so the cache test can prove a cached answer touches no filesystem at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const { SPIED } = vi.hoisted(() => ({
  SPIED: [
    'statSync',
    'lstatSync',
    'readFileSync',
    'readdirSync',
    'existsSync',
    'realpathSync',
    'accessSync'
  ] as const
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const spied: Record<string, unknown> = { ...actual }
  for (const name of SPIED) spied[name] = vi.fn(actual[name] as (...args: unknown[]) => unknown)
  return { ...spied, default: spied }
})

import { setHostPaths } from '../../host'
import {
  bundledClaudePath,
  bundledClaudeVersion,
  codexCodeModeHostPath,
  codexHostFor,
  codexHostSupported,
  engineInstalled,
  harnessAvailable,
  harnessEnvVar,
  harnessLaunch,
  harnessUnavailableMessage,
  invalidateHarness,
  onHarnessChanged,
  resolveHarness
} from '../resolve'
import { harnessManifest } from '../manifests'
import { harnessesConfigPath } from '../selection-store'
import { HARNESS_STORE_ENV } from '../store'
import type { HarnessesConfig, HarnessId } from '../../../shared/harness-types'
import {
  exeName,
  fakeHarnessInstall,
  writeHarnessPayload
} from '../../../test/helpers/fake-harness'

const ENV_VARS = ['claude', 'opencode', 'pi', 'codex'].map((id) => harnessEnvVar(id as HarnessId))
const TESTED = harnessManifest('opencode').tested
const PI_TESTED = harnessManifest('pi').tested
const CODEX_TESTED = harnessManifest('codex').tested
const UNBUNDLED = ['opencode', 'pi', 'codex'] as const

let tmp: string
let appRoot: string
let store: string
let appPath: string
const savedEnv: Record<string, string | undefined> = {}
const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

function vendorDir(id: HarnessId): string {
  return path.join(appRoot, 'vendor', `${id}-cli`)
}

function writeSelections(selections: HarnessesConfig['selections']): void {
  fs.mkdirSync(path.dirname(harnessesConfigPath()), { recursive: true })
  fs.writeFileSync(harnessesConfigPath(), JSON.stringify({ selections }))
}

function fsCalls(): number {
  return SPIED.reduce((n, name) => n + vi.mocked(fs[name] as () => unknown).mock.calls.length, 0)
}

function clearFsCalls(): void {
  for (const name of SPIED) vi.mocked(fs[name] as () => unknown).mockClear()
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-resolve-'))
  appRoot = path.join(tmp, 'app')
  store = path.join(tmp, 'store')
  appPath = appRoot
  setHostPaths({ getAppPath: () => appPath })
  for (const name of [...ENV_VARS, HARNESS_STORE_ENV]) savedEnv[name] = process.env[name]
  for (const name of ENV_VARS) delete process.env[name]
  process.env[HARNESS_STORE_ENV] = store
  fs.rmSync(harnessesConfigPath(), { force: true })
  warnSpy.mockClear()
  invalidateHarness()
})

afterEach(() => {
  setHostPaths(null)
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  fs.rmSync(harnessesConfigPath(), { force: true })
  fs.rmSync(tmp, { recursive: true, force: true })
  invalidateHarness()
})

describe('bundled: Claude Code only', () => {
  it('resolves the vendored copy in dev, with its version.json version', () => {
    const bin = writeHarnessPayload(vendorDir('claude'), 'claude', {
      versionJson: { version: '2.1.280' }
    })
    expect(resolveHarness('claude')).toEqual({
      id: 'claude',
      path: bin,
      launch: { command: bin, args: [] },
      dir: vendorDir('claude'),
      source: 'bundled',
      version: '2.1.280'
    })
    expect(bundledClaudeVersion()).toBe('2.1.280')
    expect(bundledClaudePath()).toBe(bin)
  })

  it('reads a payload without version.json as version null', () => {
    writeHarnessPayload(vendorDir('claude'), 'claude')
    expect(resolveHarness('claude').version).toBeNull()
    expect(bundledClaudeVersion()).toBeNull()
  })

  it.each([
    ['app.asar is the last segment', (resources: string) => path.join(resources, 'app.asar')],
    ['app.asar is an inner segment', (resources: string) => path.join(resources, 'app.asar', 'out')]
  ])('finds the packaged copy when %s', (_label, shape) => {
    const resources = path.join(tmp, 'Resources')
    appPath = shape(resources)
    const unpacked = writeHarnessPayload(
      path.join(resources, 'app.asar.unpacked', 'vendor', 'claude-cli'),
      'claude'
    )
    expect(resolveHarness('claude').path).toBe(unpacked)

    // extraResources beside app.asar wins over the unpacked fallback.
    const primary = writeHarnessPayload(path.join(resources, 'claude-cli'), 'claude')
    invalidateHarness()
    expect(resolveHarness('claude').path).toBe(primary)
  })

  it('treats a directory merely named like app.asar as a dev tree', () => {
    appRoot = path.join(tmp, 'my-app.asar-dev')
    appPath = appRoot
    const bin = writeHarnessPayload(vendorDir('claude'), 'claude')
    expect(resolveHarness('claude').path).toBe(bin)
  })

  it('skips a directory where the executable should be', () => {
    fs.mkdirSync(path.join(vendorDir('claude'), exeName('bun-claude')), { recursive: true })
    expect(resolveHarness('claude').path).toBeNull()
  })

  it('falls back to the bundled copy, with the reason, when its System choice is unusable', () => {
    const bin = writeHarnessPayload(vendorDir('claude'), 'claude')
    writeSelections({ claude: { source: 'system' } })
    expect(resolveHarness('claude')).toMatchObject({
      path: bin,
      source: 'bundled',
      reason: 'System detection has not run yet'
    })
  })
})

describe('opencode, pi and Codex are not bundled (ADR-082 §8)', () => {
  it.each(UNBUNDLED)('%s never resolves a vendored copy an old checkout left behind', (id) => {
    writeHarnessPayload(vendorDir(id), id, { versionJson: { version: '1.0.0' } })
    const resolved = resolveHarness(id)
    expect(resolved).toMatchObject({ path: null, launch: null, dir: null, source: 'managed' })
    expect(resolved.reason).toBe(
      `${id === 'codex' ? 'Codex' : id} ${harnessManifest(id).tested} is not installed`
    )
    expect(harnessAvailable(id)).toBe(false)
    expect(engineInstalled(id)).toBe(false)
  })

  it.each(UNBUNDLED)('%s never resolves a packaged copy either', (id) => {
    const resources = path.join(tmp, 'Resources')
    appPath = path.join(resources, 'app.asar')
    writeHarnessPayload(path.join(resources, `${id}-cli`), id)
    writeHarnessPayload(path.join(resources, 'app.asar.unpacked', 'vendor', `${id}-cli`), id)
    expect(resolveHarness(id).path).toBeNull()
  })

  it('a vendored copy does not stand in for a System choice that cannot be used', () => {
    writeHarnessPayload(vendorDir('opencode'), 'opencode')
    writeSelections({ opencode: { source: 'system' } })
    expect(resolveHarness('opencode')).toMatchObject({
      path: null,
      source: 'system',
      reason: 'System detection has not run yet'
    })
  })

  it('an old `bundled` selection reads as Tested from the store', () => {
    writeHarnessPayload(vendorDir('pi'), 'pi')
    writeSelections({ pi: { source: 'bundled' } })
    expect(resolveHarness('pi')).toMatchObject({
      path: null,
      source: 'managed',
      reason: `pi ${PI_TESTED} is not installed`
    })
    const dir = fakeHarnessInstall(store, 'pi', PI_TESTED)
    invalidateHarness('pi')
    expect(resolveHarness('pi')).toMatchObject({ dir, source: 'managed', version: PI_TESTED })
  })

  it('names the script that installs it in a development tree', () => {
    expect(harnessUnavailableMessage('opencode')).toBe(
      `opencode ${TESTED} is not installed (development: run \`bun run ensure-opencode\` to install it)`
    )
    expect(harnessUnavailableMessage('claude')).toBe(
      'Claude Code was not found in this ClaudeUI build (development: run `bun run ensure-cli` to vendor it)'
    )
  })
})

describe('missing everywhere', () => {
  it('resolves to a null path with a reason, never throwing', () => {
    const resolved = resolveHarness('claude')
    expect(resolved).toMatchObject({
      path: null,
      launch: null,
      dir: null,
      source: 'bundled',
      version: null
    })
    expect(resolved.reason).toBe('Claude Code was not found in this ClaudeUI build')
    expect(harnessAvailable('claude')).toBe(false)
  })

  it('says only why the selection cannot run for a harness that is not bundled', () => {
    expect(resolveHarness('opencode').reason).toBe(`opencode ${TESTED} is not installed`)
  })
})

describe('codex needs its code-mode host beside the executable', () => {
  it.skipIf(!codexHostSupported())('is available only with the host in the same directory', () => {
    const dir = path.join(store, 'codex', CODEX_TESTED)
    fakeHarnessInstall(store, 'codex', CODEX_TESTED, { codeModeHost: false })
    expect(resolveHarness('codex').path).not.toBeNull()
    expect(codexCodeModeHostPath()).toBeNull()
    expect(harnessAvailable('codex')).toBe(false)

    fakeHarnessInstall(store, 'codex', CODEX_TESTED)
    invalidateHarness('codex')
    // The resolver answers beside the CANONICAL executable: on macOS `os.tmpdir()`
    // is a symlink (`/var` → `/private/var`), so the expectation must be too.
    expect(codexCodeModeHostPath()).toBe(
      path.join(fs.realpathSync(dir), exeName('codex-code-mode-host'))
    )
    expect(harnessAvailable('codex')).toBe(true)
  })

  it.skipIf(!codexHostSupported())('applies the same rule to an env override', () => {
    fakeHarnessInstall(store, 'codex', CODEX_TESTED)
    const elsewhere = path.join(tmp, 'elsewhere')
    process.env[harnessEnvVar('codex')] = writeHarnessPayload(elsewhere, 'codex', {
      codeModeHost: false
    })
    expect(resolveHarness('codex').source).toBe('env')
    // The store's host does not count: it is not beside the codex that runs.
    expect(harnessAvailable('codex')).toBe(false)
  })

  it('never offers codex on a host without reviewed digests', () => {
    expect(codexHostSupported('win32', 'arm64')).toBe(false)
    expect(codexHostSupported('darwin', 'x64')).toBe(false)
  })
})

describe('env override', () => {
  it('wins over everything, resolved against the cwd, version from beside it', () => {
    fakeHarnessInstall(store, 'opencode', TESTED)
    const bin = writeHarnessPayload(path.join(tmp, 'custom'), 'opencode', {
      versionJson: { version: '9.9.9' }
    })
    process.env[harnessEnvVar('opencode')] = path.relative(process.cwd(), bin)
    expect(resolveHarness('opencode')).toMatchObject({
      path: bin,
      source: 'env',
      version: '9.9.9'
    })
    expect(resolveHarness('opencode').reason).toBeUndefined()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('falls through, warning once, when it names no file', () => {
    const dir = fakeHarnessInstall(store, 'pi', PI_TESTED)
    const missing = path.join(tmp, 'no-such', exeName('pi'))
    process.env[harnessEnvVar('pi')] = missing
    expect(resolveHarness('pi')).toMatchObject({ dir, source: 'managed' })
    invalidateHarness()
    expect(resolveHarness('pi').dir).toBe(dir)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0][0])).toContain(missing)
    expect(String(warnSpy.mock.calls[0][0])).toContain('CLAUDEUI_PI_CLI')
  })

  it('falls through when it names a directory', () => {
    const bundled = writeHarnessPayload(vendorDir('claude'), 'claude')
    process.env[harnessEnvVar('claude')] = tmp
    expect(resolveHarness('claude').path).toBe(bundled)
  })

  it('is re-read when the variable changes, without an invalidation', () => {
    const bundled = writeHarnessPayload(vendorDir('claude'), 'claude')
    expect(resolveHarness('claude').path).toBe(bundled)
    const custom = writeHarnessPayload(path.join(tmp, 'custom'), 'claude')
    process.env[harnessEnvVar('claude')] = custom
    expect(resolveHarness('claude').path).toBe(custom)
    delete process.env[harnessEnvVar('claude')]
    expect(resolveHarness('claude').path).toBe(bundled)
  })
})

describe('managed selection', () => {
  beforeEach(() => {
    // An old checkout's vendored copy of the very version: never a stand-in.
    writeHarnessPayload(vendorDir('opencode'), 'opencode', { versionJson: { version: TESTED } })
  })

  it('runs the tested version from the store by default', () => {
    const dir = fakeHarnessInstall(store, 'opencode', TESTED)
    expect(resolveHarness('opencode')).toEqual({
      id: 'opencode',
      path: path.join(dir, exeName('opencode')),
      launch: { command: path.join(dir, exeName('opencode')), args: [] },
      dir,
      source: 'managed',
      version: TESTED
    })
  })

  it('resolves to nothing, with the reason, when the tested version is not installed', () => {
    fakeHarnessInstall(store, 'opencode', '1.0.0')
    expect(resolveHarness('opencode')).toEqual({
      id: 'opencode',
      path: null,
      launch: null,
      dir: null,
      source: 'managed',
      version: null,
      reason: `opencode ${TESTED} is not installed`
    })
  })

  it('latest picks the newest valid install by semver', () => {
    fakeHarnessInstall(store, 'opencode', '1.2.0')
    fakeHarnessInstall(store, 'opencode', '1.10.0-beta.1')
    const newest = fakeHarnessInstall(store, 'opencode', '1.10.0')
    // Newer, but not an install: another host's record, and no record at all.
    fakeHarnessInstall(store, 'opencode', '2.0.0', { record: { arch: 'not-this-arch' } })
    fakeHarnessInstall(store, 'opencode', '3.0.0', { record: null })
    writeSelections({ opencode: { source: 'managed', version: 'latest' } })
    expect(resolveHarness('opencode')).toMatchObject({
      dir: newest,
      source: 'managed',
      version: '1.10.0'
    })
  })

  it('latest with nothing installed resolves to nothing, with a reason', () => {
    writeSelections({ opencode: { source: 'managed', version: 'latest' } })
    expect(resolveHarness('opencode')).toMatchObject({
      path: null,
      source: 'managed',
      reason: 'No version of opencode is installed'
    })
  })

  it('an explicit version runs exactly that version, or nothing, naming it', () => {
    const dir = fakeHarnessInstall(store, 'pi', '0.80.0', { nested: true })
    writeHarnessPayload(vendorDir('pi'), 'pi')
    writeSelections({ pi: { source: 'managed', version: '0.80.0' } })
    expect(resolveHarness('pi')).toMatchObject({
      path: path.join(dir, 'pi', exeName('pi')),
      dir: path.join(dir, 'pi'),
      source: 'managed',
      version: '0.80.0'
    })

    writeSelections({ pi: { source: 'managed', version: '0.81.0' } })
    invalidateHarness('pi')
    expect(resolveHarness('pi')).toMatchObject({
      path: null,
      source: 'managed',
      reason: 'pi 0.81.0 is not installed'
    })
  })

  it('finds pi flat in its version directory too (nested: above)', () => {
    const flat = fakeHarnessInstall(store, 'pi', PI_TESTED)
    expect(resolveHarness('pi').path).toBe(path.join(flat, exeName('pi')))
  })

  it('an install without its executable resolves to nothing, with a reason', () => {
    fakeHarnessInstall(store, 'opencode', TESTED, { noExecutable: true })
    expect(resolveHarness('opencode')).toMatchObject({
      path: null,
      source: 'managed',
      reason: `opencode ${TESTED} in ClaudeUI's store has no executable`
    })
  })

  it('Claude Code has no managed copy', () => {
    writeHarnessPayload(vendorDir('claude'), 'claude')
    writeSelections({ claude: { source: 'managed' } })
    expect(resolveHarness('claude')).toMatchObject({
      source: 'bundled',
      reason: 'Claude Code has no ClaudeUI-managed copy'
    })
  })
})

describe('system selection', () => {
  // The System source in depth: resolve-system.test.ts.
  it('resolves to nothing until detection has run', () => {
    writeSelections({ opencode: { source: 'system' } })
    expect(resolveHarness('opencode')).toMatchObject({
      path: null,
      source: 'system',
      reason: 'System detection has not run yet'
    })
  })
})

describe('caching', () => {
  it('answers a second time without touching the filesystem', () => {
    writeHarnessPayload(vendorDir('claude'), 'claude', { versionJson: { version: '1.0.0' } })
    fakeHarnessInstall(store, 'opencode', '1.0.0')
    fakeHarnessInstall(store, 'pi', PI_TESTED)
    fakeHarnessInstall(store, 'codex', CODEX_TESTED)
    writeSelections({ opencode: { source: 'managed', version: 'latest' } })
    for (const id of ['claude', 'opencode', 'pi', 'codex'] as const) {
      resolveHarness(id)
      harnessAvailable(id)
    }
    codexCodeModeHostPath()

    clearFsCalls()
    for (const id of ['claude', 'opencode', 'pi', 'codex'] as const) {
      resolveHarness(id)
      harnessAvailable(id)
      engineInstalled(id)
    }
    codexCodeModeHostPath()
    expect(fsCalls()).toBe(0)
  })

  it('keeps a stale answer until invalidated, then re-resolves and notifies', () => {
    expect(resolveHarness('opencode').path).toBeNull()
    const dir = fakeHarnessInstall(store, 'opencode', TESTED)
    // Installed behind the cache: not seen yet (the accepted staleness).
    expect(resolveHarness('opencode').path).toBeNull()

    const changed: HarnessId[] = []
    const off = onHarnessChanged((id) => changed.push(id))
    invalidateHarness('opencode')
    expect(changed).toEqual(['opencode'])
    expect(resolveHarness('opencode')).toMatchObject({ dir, source: 'managed' })

    invalidateHarness()
    expect(changed).toEqual(['opencode', 'claude', 'opencode', 'pi', 'codex'])
    off()
    invalidateHarness('pi')
    expect(changed).toHaveLength(5)
  })

  it('does not keep a resolution made before the host wired its app path', () => {
    // A module-level caller (the `usageFetcher` singleton) resolves before
    // `src/main/index.ts` reaches `setHostPaths`: the lookup falls back to the
    // cwd, which in a packaged app holds no `vendor/claude-cli`.
    const bin = writeHarnessPayload(vendorDir('claude'), 'claude')
    setHostPaths(null)
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(path.join(tmp, 'elsewhere'))
    try {
      expect(resolveHarness('claude').path).toBeNull()
    } finally {
      cwd.mockRestore()
    }
    setHostPaths({ getAppPath: () => appPath })
    expect(resolveHarness('claude')).toMatchObject({ path: bin, source: 'bundled' })
    expect(harnessAvailable('claude')).toBe(true)
  })

  it('returns a frozen resolution callers cannot corrupt', () => {
    expect(Object.isFrozen(resolveHarness('claude'))).toBe(true)
  })
})

describe('engineInstalled', () => {
  it('answers for every harness, claude included, and false for anything else', () => {
    expect(engineInstalled('claude')).toBe(false)
    writeHarnessPayload(vendorDir('claude'), 'claude')
    invalidateHarness()
    expect(engineInstalled('claude')).toBe(true)
    expect(engineInstalled('opencode')).toBe(false)
    fakeHarnessInstall(store, 'opencode', TESTED)
    invalidateHarness('opencode')
    expect(engineInstalled('opencode')).toBe(true)
    expect(engineInstalled('gemini')).toBe(false)
    expect(engineInstalled(undefined)).toBe(false)
  })
})

describe('launch', () => {
  it('is a native launch of the path for every source, and null with it', () => {
    const dir = fakeHarnessInstall(store, 'pi', PI_TESTED)
    expect(harnessLaunch('pi')).toEqual({ command: path.join(dir, exeName('pi')), args: [] })

    const custom = writeHarnessPayload(path.join(tmp, 'custom'), 'pi')
    process.env[harnessEnvVar('pi')] = custom
    expect(harnessLaunch('pi')).toEqual({ command: custom, args: [] })

    const bundled = writeHarnessPayload(vendorDir('claude'), 'claude')
    expect(harnessLaunch('claude')).toEqual({ command: bundled, args: [] })

    expect(harnessLaunch('opencode')).toBeNull()
    expect(resolveHarness('opencode').launch).toBeNull()
  })

  it('is frozen with the resolution', () => {
    fakeHarnessInstall(store, 'opencode', TESTED)
    const launch = harnessLaunch('opencode')!
    expect(Object.isFrozen(launch)).toBe(true)
    expect(Object.isFrozen(launch.args)).toBe(true)
    expect(resolveHarness('opencode').launch).toBe(launch)
  })
})

/**
 * Codex's own order (`install-context/src/lib.rs`, `code_mode_host_program`):
 * `codex-resources/` of a package layout, then the layout's `bin/` (or the
 * canonical exe dir without a layout), then the dir it was started from.
 */
describe('codexHostFor', () => {
  const HOST = exeName('codex-code-mode-host')

  /** `<tmp>/<name>/` with `codex-package.json` and the given files (empty). */
  function pkg(name: string, files: string[], metadata: object = {}): string {
    const root = path.join(tmp, name)
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, 'codex-package.json'), JSON.stringify(metadata))
    for (const file of files) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
      fs.writeFileSync(path.join(root, file), '')
    }
    return root
  }

  it('prefers codex-resources over bin in a package layout', () => {
    const root = pkg('p', [`bin/${exeName('codex')}`, `bin/${HOST}`, `codex-resources/${HOST}`])
    expect(codexHostFor(path.join(root, 'bin', exeName('codex')))).toBe(
      path.join(fs.realpathSync(root), 'codex-resources', HOST)
    )
  })

  it('falls back to the layout bin dir', () => {
    const root = pkg('p', [`bin/${exeName('codex')}`, `bin/${HOST}`, 'codex-resources/other'])
    expect(codexHostFor(path.join(root, 'bin', exeName('codex')))).toBe(
      path.join(fs.realpathSync(root), 'bin', HOST)
    )
  })

  it('ignores codex-resources without codex-package.json (no layout)', () => {
    const root = pkg('p', [`bin/${exeName('codex')}`, `codex-resources/${HOST}`])
    fs.rmSync(path.join(root, 'codex-package.json'))
    expect(codexHostFor(path.join(root, 'bin', exeName('codex')))).toBeNull()
    fs.writeFileSync(path.join(root, 'bin', HOST), '')
    expect(codexHostFor(path.join(root, 'bin', exeName('codex')))).toBe(
      path.join(fs.realpathSync(root), 'bin', HOST)
    )
  })

  it('maps an executable inside codex-resources to the package bin dir', () => {
    const root = pkg('p', [`codex-resources/${exeName('codex')}`, `bin/${HOST}`])
    expect(codexHostFor(path.join(root, 'codex-resources', exeName('codex')))).toBe(
      path.join(fs.realpathSync(root), 'bin', HOST)
    )
  })

  it('finds the host beside a plain executable (the vendored and managed layout)', () => {
    const bin = writeHarnessPayload(path.join(tmp, 'plain'), 'codex')
    expect(codexHostFor(bin)).toBe(path.join(fs.realpathSync(path.dirname(bin)), HOST))
    expect(
      codexHostFor(writeHarnessPayload(path.join(tmp, 'bare'), 'codex', { codeModeHost: false }))
    ).toBeNull()
  })

  it('resolves the layout through a linked directory, as Codex canonicalizes its exe', () => {
    const root = pkg('real', [`bin/${exeName('codex')}`, `codex-resources/${HOST}`])
    const link = path.join(tmp, 'linked-bin')
    fs.symlinkSync(path.join(root, 'bin'), link, 'junction')
    expect(codexHostFor(path.join(link, exeName('codex')))).toBe(
      path.join(fs.realpathSync(root), 'codex-resources', HOST)
    )
  })

  it.skipIf(process.platform === 'win32')(
    'last, looks beside the path it was started from (a symlinked executable)',
    () => {
      const root = pkg('real', [`bin/${exeName('codex')}`])
      const shimDir = path.join(tmp, 'shims')
      fs.mkdirSync(shimDir)
      const shim = path.join(shimDir, 'codex')
      fs.symlinkSync(path.join(root, 'bin', 'codex'), shim)
      expect(codexHostFor(shim)).toBeNull()
      fs.writeFileSync(path.join(shimDir, HOST), '')
      expect(codexHostFor(shim)).toBe(path.join(shimDir, HOST))
      fs.writeFileSync(path.join(root, 'bin', HOST), '')
      expect(codexHostFor(shim)).toBe(path.join(fs.realpathSync(root), 'bin', HOST))
    }
  )

  it.skipIf(process.platform !== 'win32')(
    "recognizes WinGet's flat package root only when the metadata names this executable",
    () => {
      const entry = 'codex-x86_64-pc-windows-msvc.exe'
      const root = pkg('winget', [entry, `codex-resources/${HOST}`], {
        layoutVersion: 1,
        entrypoint: entry
      })
      expect(codexHostFor(path.join(root, entry))).toBe(
        path.join(fs.realpathSync(root), 'codex-resources', HOST)
      )
      fs.writeFileSync(
        path.join(root, 'codex-package.json'),
        JSON.stringify({ layoutVersion: 1, entrypoint: 'other.exe' })
      )
      expect(codexHostFor(path.join(root, entry))).toBeNull()
    }
  )

  it.skipIf(!codexHostSupported())('is what harnessAvailable checks for the resolved codex', () => {
    const root = pkg('managed-like', [`bin/${exeName('codex')}`, `codex-resources/${HOST}`])
    process.env[harnessEnvVar('codex')] = path.join(root, 'bin', exeName('codex'))
    expect(codexCodeModeHostPath()).toBe(path.join(fs.realpathSync(root), 'codex-resources', HOST))
    expect(harnessAvailable('codex')).toBe(true)
  })
})

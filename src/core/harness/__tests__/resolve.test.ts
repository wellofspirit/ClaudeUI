/**
 * @vitest-environment node
 *
 * The harness resolver (ADR-082): which executable runs for each harness.
 * Real temp directories stand in for the app root, the vendored payloads and
 * the managed store; `node:fs` is wrapped in pass-through spies only so the
 * cache test can prove a cached answer touches no filesystem at all.
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
  codexCodeModeHostPath,
  codexHostFor,
  codexHostSupported,
  engineInstalled,
  harnessAvailable,
  harnessEnvVar,
  harnessLaunch,
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

describe('bundled', () => {
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
  })

  it('reads a payload without version.json as version null', () => {
    writeHarnessPayload(vendorDir('opencode'), 'opencode')
    expect(resolveHarness('opencode').version).toBeNull()
  })

  it.each([
    ['app.asar is the last segment', (resources: string) => path.join(resources, 'app.asar')],
    ['app.asar is an inner segment', (resources: string) => path.join(resources, 'app.asar', 'out')]
  ])('finds the packaged copy when %s', (_label, shape) => {
    const resources = path.join(tmp, 'Resources')
    appPath = shape(resources)
    const unpacked = writeHarnessPayload(
      path.join(resources, 'app.asar.unpacked', 'vendor', 'opencode-cli'),
      'opencode'
    )
    expect(resolveHarness('opencode').path).toBe(unpacked)

    // extraResources beside app.asar wins over the unpacked fallback.
    const primary = writeHarnessPayload(path.join(resources, 'opencode-cli'), 'opencode')
    invalidateHarness()
    expect(resolveHarness('opencode').path).toBe(primary)
  })

  it('treats a directory merely named like app.asar as a dev tree', () => {
    appRoot = path.join(tmp, 'my-app.asar-dev')
    appPath = appRoot
    const bin = writeHarnessPayload(vendorDir('pi'), 'pi')
    expect(resolveHarness('pi').path).toBe(bin)
  })

  it('finds pi flat or nested, reading the version at the payload root', () => {
    const nested = writeHarnessPayload(vendorDir('pi'), 'pi', {
      nested: true,
      versionJson: { version: '0.87.1' }
    })
    expect(resolveHarness('pi')).toMatchObject({
      path: nested,
      dir: path.join(vendorDir('pi'), 'pi'),
      version: '0.87.1'
    })

    const flat = writeHarnessPayload(vendorDir('pi'), 'pi')
    invalidateHarness('pi')
    expect(resolveHarness('pi').path).toBe(flat)
  })

  it('skips a directory where the executable should be', () => {
    fs.mkdirSync(path.join(vendorDir('opencode'), exeName('opencode')), { recursive: true })
    expect(resolveHarness('opencode').path).toBeNull()
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

  it('keeps the fallback reason alongside the missing one', () => {
    expect(resolveHarness('opencode').reason).toBe(
      `opencode ${TESTED} is not installed in ClaudeUI, and opencode was not found in this ClaudeUI build`
    )
  })
})

describe('codex needs its code-mode host beside the executable', () => {
  it.skipIf(!codexHostSupported())('is available only with the host in the same directory', () => {
    writeHarnessPayload(vendorDir('codex'), 'codex', { codeModeHost: false })
    expect(resolveHarness('codex').path).not.toBeNull()
    expect(codexCodeModeHostPath()).toBeNull()
    expect(harnessAvailable('codex')).toBe(false)

    writeHarnessPayload(vendorDir('codex'), 'codex')
    invalidateHarness('codex')
    expect(codexCodeModeHostPath()).toBe(
      path.join(vendorDir('codex'), exeName('codex-code-mode-host'))
    )
    expect(harnessAvailable('codex')).toBe(true)
  })

  it.skipIf(!codexHostSupported())('applies the same rule to an env override', () => {
    writeHarnessPayload(vendorDir('codex'), 'codex')
    const elsewhere = path.join(tmp, 'elsewhere')
    process.env[harnessEnvVar('codex')] = writeHarnessPayload(elsewhere, 'codex', {
      codeModeHost: false
    })
    expect(resolveHarness('codex').source).toBe('env')
    // The bundled host does not count: it is not beside the codex that runs.
    expect(harnessAvailable('codex')).toBe(false)
  })

  it('never offers codex on a host without reviewed digests', () => {
    expect(codexHostSupported('win32', 'arm64')).toBe(false)
    expect(codexHostSupported('darwin', 'x64')).toBe(false)
  })
})

describe('env override', () => {
  it('wins over everything, resolved against the cwd, version from beside it', () => {
    writeHarnessPayload(vendorDir('opencode'), 'opencode')
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
    const bundled = writeHarnessPayload(vendorDir('pi'), 'pi')
    const missing = path.join(tmp, 'no-such', exeName('pi'))
    process.env[harnessEnvVar('pi')] = missing
    expect(resolveHarness('pi')).toMatchObject({ path: bundled, source: 'bundled' })
    invalidateHarness()
    expect(resolveHarness('pi').path).toBe(bundled)
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

  it('falls back to bundled with a reason when the tested version is not installed', () => {
    fakeHarnessInstall(store, 'opencode', '1.0.0')
    expect(resolveHarness('opencode')).toMatchObject({
      path: path.join(vendorDir('opencode'), exeName('opencode')),
      source: 'bundled',
      version: TESTED,
      reason: `opencode ${TESTED} is not installed in ClaudeUI`
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

  it('latest with nothing installed falls back with a reason', () => {
    writeSelections({ opencode: { source: 'managed', version: 'latest' } })
    expect(resolveHarness('opencode')).toMatchObject({
      source: 'bundled',
      reason: 'No version of opencode is installed in ClaudeUI'
    })
  })

  it('an explicit version runs exactly that version, or falls back naming it', () => {
    const dir = fakeHarnessInstall(store, 'pi', '0.80.0', { nested: true })
    writeHarnessPayload(vendorDir('pi'), 'pi')
    writeSelections({ pi: { source: 'managed', version: '0.80.0' } })
    expect(resolveHarness('pi')).toMatchObject({
      path: path.join(dir, 'pi', exeName('pi')),
      source: 'managed',
      version: '0.80.0'
    })

    writeSelections({ pi: { source: 'managed', version: '0.81.0' } })
    invalidateHarness('pi')
    expect(resolveHarness('pi')).toMatchObject({
      source: 'bundled',
      reason: 'pi 0.81.0 is not installed in ClaudeUI'
    })
  })

  it('an install without its executable falls back with a reason', () => {
    fakeHarnessInstall(store, 'opencode', TESTED, { noExecutable: true })
    expect(resolveHarness('opencode')).toMatchObject({
      source: 'bundled',
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
  it('falls back to bundled until detection exists', () => {
    const bin = writeHarnessPayload(vendorDir('opencode'), 'opencode')
    writeSelections({ opencode: { source: 'system' } })
    expect(resolveHarness('opencode')).toMatchObject({
      path: bin,
      source: 'bundled',
      reason: 'System detection not available yet'
    })
  })
})

describe('caching', () => {
  it('answers a second time without touching the filesystem', () => {
    for (const id of ['claude', 'opencode', 'pi', 'codex'] as const) {
      writeHarnessPayload(vendorDir(id), id, { versionJson: { version: '1.0.0' } })
    }
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
    expect(engineInstalled('gemini')).toBe(false)
    expect(engineInstalled(undefined)).toBe(false)
  })
})

describe('launch', () => {
  it('is a native launch of the path for every source, and null with it', () => {
    const bundled = writeHarnessPayload(vendorDir('pi'), 'pi')
    expect(harnessLaunch('pi')).toEqual({ command: bundled, args: [] })

    const custom = writeHarnessPayload(path.join(tmp, 'custom'), 'pi')
    process.env[harnessEnvVar('pi')] = custom
    expect(harnessLaunch('pi')).toEqual({ command: custom, args: [] })

    const dir = fakeHarnessInstall(store, 'opencode', TESTED)
    expect(harnessLaunch('opencode')).toEqual({
      command: path.join(dir, exeName('opencode')),
      args: []
    })

    expect(harnessLaunch('claude')).toBeNull()
    expect(resolveHarness('claude').launch).toBeNull()
  })

  it('is frozen with the resolution', () => {
    writeHarnessPayload(vendorDir('opencode'), 'opencode')
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

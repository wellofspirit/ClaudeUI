/**
 * @vitest-environment node
 *
 * The harness manager's channels (ADR-082 arc 2, S4): `core/ipc/harness-commands.ts`,
 * run against the real harness modules under the test home the setup file
 * redirects to and a temp managed store (`CLAUDEUI_HARNESS_STORE`). Only the
 * network and process work is injected: the installer, upstream and the
 * detection scheduler.
 *
 * What this file guards:
 *  - the capability split: reads are `config`, every write `admin`, pinned so
 *    no edit can relabel one (ADR-082 §7);
 *  - the snapshot shows detected installs re-labelled against this build's
 *    manifest and never carries a launch, an environment or a fingerprint;
 *  - selections are validated per harness before they are saved;
 *  - install / cancel / detect are wired to the work they hand off;
 *  - invalidations and install progress go out as sync events;
 *  - no result carries an `ok` key (the transports' envelope marker).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const appendAuditLog = vi.hoisted(() => vi.fn())
vi.mock('../../../core/services/db', () => ({ appendAuditLog }))

import type {
  DetectedInstall,
  HarnessId,
  HarnessInstallResult,
  HarnessStateSnapshot,
  HarnessesConfig
} from '../../../shared/harness-types'
import { setHostPaths } from '../../../core/host'
import {
  AUTH_OFF_GRANTS,
  CommandRegistry,
  FULL_REMOTE_GRANTS,
  hostConnection,
  makeRemoteConnection,
  type CommandRegistration
} from '../../../core/ipc/command-registry'
import {
  HARNESS_CHANNELS,
  InstallRequests,
  harnessCommands,
  startHarnessEvents,
  validateHarnessSelection,
  type HarnessCommandDeps
} from '../../../core/ipc/harness-commands'
import {
  harnessDetectionPath,
  saveDetectionCache
} from '../../../core/harness/detect/detection-cache'
import { fingerprintOf } from '../../../core/harness/detect/fs-util'
import { harnessManifest } from '../../../core/harness/manifests'
import {
  harnessEnvVar,
  invalidateHarness,
  onHarnessChanged,
  resolveHarness
} from '../../../core/harness/resolve'
import { harnessesConfigPath, loadHarnessesConfig } from '../../../core/harness/selection-store'
import { HARNESS_STORE_ENV } from '../../../core/harness/store'
import { fakeHarnessInstall, writeHarnessPayload } from '../../../test/helpers/fake-harness'

const EXE = process.platform === 'win32' ? '.exe' : ''
const OPENCODE = harnessManifest('opencode')
const CODEX = harnessManifest('codex')
const CLAUDE = harnessManifest('claude')

let tmp: string
let store: string
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-commands-')))
  store = path.join(tmp, 'store')
  setHostPaths({ getAppPath: () => path.join(tmp, 'app') })
  savedEnv.store = process.env[HARNESS_STORE_ENV]
  process.env[HARNESS_STORE_ENV] = store
  for (const id of ['claude', 'opencode', 'pi', 'codex'] as const) {
    savedEnv[id] = process.env[harnessEnvVar(id)]
    delete process.env[harnessEnvVar(id)]
  }
  fs.rmSync(harnessesConfigPath(), { force: true })
  fs.rmSync(harnessDetectionPath(), { force: true })
  appendAuditLog.mockClear()
  invalidateHarness()
})

afterEach(() => {
  setHostPaths(null)
  if (savedEnv.store === undefined) delete process.env[HARNESS_STORE_ENV]
  else process.env[HARNESS_STORE_ENV] = savedEnv.store
  for (const id of ['claude', 'opencode', 'pi', 'codex'] as const) {
    if (savedEnv[id] === undefined) delete process.env[harnessEnvVar(id)]
    else process.env[harnessEnvVar(id)] = savedEnv[id]
  }
  fs.rmSync(harnessesConfigPath(), { force: true })
  fs.rmSync(harnessDetectionPath(), { force: true })
  fs.rmSync(tmp, { recursive: true, force: true })
  invalidateHarness()
})

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

/** A native System install as detection writes it, fingerprinted now. */
function nativeInstall(
  id: HarnessId,
  version: string,
  overrides: Partial<DetectedInstall> = {}
): DetectedInstall {
  const real = file(`system/${id}-${version}/${id}${EXE}`)
  return {
    id,
    displayPath: file(`shims/${id}-${version}`),
    realPath: real,
    launch: { command: real, args: [] },
    installKind: 'npm',
    version,
    verdict: 'tested',
    fingerprint: fingerprintOf(real),
    ...overrides
  }
}

/** Fresh declarations with every network / process dependency injected. */
function commands(deps: HarnessCommandDeps = {}): Array<Omit<CommandRegistration, 'transport'>> {
  return harnessCommands({
    activeInstalls: () => [],
    detectionStatus: () => ({ running: false }),
    latestVersion: async () => null,
    availableVersions: async () => [],
    requestDetection: async () => {},
    install: async (id, version) => ({ status: 'failed', id, version, reason: 'not in this test' }),
    requests: new InstallRequests(),
    ...deps
  })
}

/** A registry with the declarations on both transports, as production registers them. */
function registryOf(cmds = commands()): CommandRegistry {
  const registry = new CommandRegistry()
  for (const cmd of cmds) {
    registry.register({ ...cmd, transport: 'desktop' })
    registry.register({ ...cmd, transport: 'remote' })
  }
  return registry
}

function call(
  registry: CommandRegistry,
  channel: string,
  payload?: unknown,
  connection = hostConnection()
): Promise<unknown> {
  return registry.dispatch(channel, 'desktop', payload === undefined ? [] : [payload], connection)
}

/** Every key anywhere in a JSON-able value. */
function allKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) allKeys(v, out)
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k)
      allKeys(v, out)
    }
  }
  return out
}

describe('capabilities (ADR-082 §7)', () => {
  it('declares the reads `config` queries and every write an `admin` command, on both transports', () => {
    const registry = registryOf()
    const declared = Object.fromEntries(HARNESS_CHANNELS.map((c) => [c, registry.declaration(c)]))
    expect(declared).toEqual({
      'harness:state': expect.objectContaining({ capability: 'config', kind: 'query' }),
      'harness:versions': expect.objectContaining({ capability: 'config', kind: 'query' }),
      'harness:set-selection': expect.objectContaining({ capability: 'admin', kind: 'command' }),
      'harness:install': expect.objectContaining({ capability: 'admin', kind: 'command' }),
      'harness:install-cancel': expect.objectContaining({ capability: 'admin', kind: 'command' }),
      'harness:detect': expect.objectContaining({ capability: 'admin', kind: 'command' })
    })
    expect(registry.channels('remote')).toEqual([...HARNESS_CHANNELS].sort())
    expect(registry.channels('desktop')).toEqual([...HARNESS_CHANNELS].sort())
  })

  it('refuses a write to a base remote connection, and serves it to an admin one', async () => {
    const install = vi.fn(
      async (id: HarnessId, version: string): Promise<HarnessInstallResult> => ({
        status: 'installed',
        id,
        version,
        verified: 'reviewed'
      })
    )
    const registry = registryOf(commands({ install }))
    const base = makeRemoteConnection('none', null, AUTH_OFF_GRANTS)
    const admin = makeRemoteConnection('webauthn', 'phone', FULL_REMOTE_GRANTS)
    const args = [{ id: 'opencode', version: 'tested' }]

    for (const channel of ['harness:install', 'harness:set-selection', 'harness:detect']) {
      await expect(registry.dispatch(channel, 'remote', args, base)).rejects.toThrow(
        /Permission denied/
      )
    }
    expect(install).not.toHaveBeenCalled()
    // The reads are free on the base set.
    await expect(registry.dispatch('harness:state', 'remote', [], base)).resolves.toBeTruthy()

    await expect(
      registry.dispatch('harness:install', 'remote', args, admin)
    ).resolves.toMatchObject({ status: 'installed', id: 'opencode', version: OPENCODE.tested })
    // A write is audited under its declared capability.
    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'harness:install', capability: 'admin' })
    )
  })

  it('pins the writes: registering one as `config` throws', () => {
    const registry = new CommandRegistry()
    const install = commands().find((c) => c.channel === 'harness:install')!
    expect(() =>
      registry.register({ ...install, capability: 'config', transport: 'remote' })
    ).toThrow(/pinned to "admin"/)
  })
})

describe('harness:state', () => {
  it('reports each harness from the files, re-labelling detected installs against this manifest', async () => {
    writeHarnessPayload(path.join(tmp, 'app', 'vendor', 'claude-cli'), 'claude', {
      versionJson: { version: CLAUDE.tested }
    })
    fakeHarnessInstall(store, 'opencode', OPENCODE.tested)
    fakeHarnessInstall(store, 'opencode', '1.18.40', { record: { verified: 'publisher' } })
    fs.writeFileSync(path.join(store, 'opencode', OPENCODE.tested, 'last-used'), '')
    writeSelections({ opencode: { source: 'system', version: '1.18.40' } })
    // Detection called this `tested`; this build's floor says it is too old.
    const stale = nativeInstall('opencode', '1.0.0', { verdict: 'tested' })
    const unsupported = nativeInstall('opencode', OPENCODE.tested, {
      verdict: 'unsupported',
      reason: 'a version-manager shim',
      launch: null
    })
    const piOnNode = nativeInstall('pi', harnessManifest('pi').tested, {
      node: { path: file(`node/node${EXE}`), version: '24.1.0' }
    })
    saveDetectionCache([
      { id: 'opencode', detectedAt: '2026-09-30T00:00:00.000Z', installs: [stale, unsupported] },
      { id: 'pi', detectedAt: '2026-09-30T00:00:00.000Z', installs: [piOnNode] }
    ])

    const snapshot = (await call(registryOf(), 'harness:state')) as HarnessStateSnapshot
    const opencode = snapshot.harnesses.opencode

    expect(opencode.manifest).toEqual({
      tested: OPENCODE.tested,
      floor: OPENCODE.floor,
      ceiling: OPENCODE.ceiling
    })
    expect(opencode.selection).toEqual({ source: 'system', version: '1.18.40' })
    expect(opencode.system.detectedAt).toBe('2026-09-30T00:00:00.000Z')
    expect(opencode.system.installs.map((i) => [i.version, i.verdict])).toEqual([
      ['1.0.0', 'too-old'],
      [OPENCODE.tested, 'unsupported']
    ])
    expect(opencode.system.installs[1].reason).toBe('a version-manager shim')
    expect(opencode.system.choice).toEqual({
      kind: 'fallback',
      reason: 'No usable System opencode found: a version-manager shim'
    })
    // Falls back to the bundled copy, which this test app does not have.
    expect(opencode.resolved).toMatchObject({ source: 'bundled', path: null, available: false })
    expect(opencode.managed).toEqual([
      expect.objectContaining({ version: '1.18.40', verified: 'publisher' }),
      expect.objectContaining({ version: OPENCODE.tested, verified: 'reviewed' })
    ])
    expect(opencode.managed[0].lastUsed).toBeUndefined()
    expect(typeof opencode.managed[1].lastUsed).toBe('string')
    expect('bundledVersion' in opencode).toBe(false)

    expect(snapshot.harnesses.claude.bundledVersion).toBe(CLAUDE.tested)
    expect(snapshot.harnesses.claude.resolved).toMatchObject({
      source: 'bundled',
      version: CLAUDE.tested,
      available: true
    })
    expect(snapshot.harnesses.pi.system.installs[0].node).toEqual({
      kind: 'node',
      path: expect.stringContaining('node'),
      version: '24.1.0'
    })
    expect(snapshot.harnesses.codex.system).toEqual({
      detectedAt: null,
      installs: [],
      choice: { kind: 'fallback', reason: 'System detection has not run yet' }
    })
    expect(snapshot.detection).toEqual({ running: false })
    expect(snapshot.installs).toEqual([])
  })

  it('never leaks a launch, an environment, a real path or a fingerprint', async () => {
    const install = nativeInstall('opencode', OPENCODE.tested)
    const node = file(`node/node${EXE}`)
    const pi = nativeInstall('pi', harnessManifest('pi').tested, {
      launch: {
        command: node,
        args: [file('pi/cli.js')],
        env: { PI_MANAGED_INSTALL_ROOT: path.join(tmp, 'SECRETROOT') }
      },
      node: { path: node, version: '24.1.0' },
      nodeFingerprint: fingerprintOf(node)
    })
    saveDetectionCache([
      { id: 'opencode', detectedAt: '2026-09-30T00:00:00.000Z', installs: [install] },
      { id: 'pi', detectedAt: '2026-09-30T00:00:00.000Z', installs: [pi] }
    ])
    writeSelections({ opencode: { source: 'system' } })
    const snapshot = await call(registryOf(), 'harness:state')
    const keys = allKeys(snapshot)
    for (const secret of ['launch', 'env', 'fingerprint', 'nodeFingerprint', 'realPath']) {
      expect(keys.has(secret), `snapshot carries "${secret}"`).toBe(false)
    }
    expect(JSON.stringify(snapshot)).not.toContain('SECRETROOT')
    // What a System selection runs is named by its display path.
    const opencode = (snapshot as HarnessStateSnapshot).harnesses.opencode
    expect(opencode.system.choice).toEqual({
      kind: 'ok',
      displayPath: install.displayPath,
      version: OPENCODE.tested
    })
    expect(opencode.resolved).toMatchObject({
      source: 'system',
      displayPath: install.displayPath,
      available: true
    })
  })
})

describe('harness:set-selection', () => {
  it.each([
    ['claude', { source: 'managed' }, /Claude Code runs from bundled or system/],
    ['claude', { source: 'system', version: 'tested' }, /no version choice/],
    ['opencode', { source: 'bundled' }, /opencode runs from managed or system/],
    ['codex', { source: 'managed', version: 'latest' }, /locked to/],
    ['codex', { source: 'managed', version: '0.157.0' }, /locked to/],
    ['opencode', { source: 'managed', version: '1.0.0' }, /not supported/],
    ['opencode', { source: 'managed', version: OPENCODE.ceiling }, /not supported/],
    ['pi', { source: 'managed', version: '../../etc' }, /not supported/],
    ['pi', 'managed', /must be an object/]
  ])('refuses %s %j', async (id, selection, message) => {
    const registry = registryOf()
    await expect(call(registry, 'harness:set-selection', { id, selection })).rejects.toThrow(
      message
    )
    expect(fs.existsSync(harnessesConfigPath())).toBe(false)
  })

  it('refuses an unknown harness', async () => {
    await expect(
      call(registryOf(), 'harness:set-selection', { id: 'gemini', selection: {} })
    ).rejects.toThrow(/Unknown harness/)
  })

  it('saves a valid choice, invalidates that harness and returns its new state', async () => {
    const changed: HarnessId[] = []
    const off = onHarnessChanged((id) => changed.push(id))
    try {
      const entry = await call(registryOf(), 'harness:set-selection', {
        id: 'opencode',
        selection: { source: 'managed', version: '1.18.40' }
      })
      expect(loadHarnessesConfig().selections?.opencode).toEqual({
        source: 'managed',
        version: '1.18.40'
      })
      expect(changed).toEqual(['opencode'])
      expect(entry).toMatchObject({
        id: 'opencode',
        selection: { source: 'managed', version: '1.18.40' },
        resolved: {
          source: 'bundled',
          reason: expect.stringContaining('opencode 1.18.40 is not installed in ClaudeUI')
        }
      })
    } finally {
      off()
    }
  })

  it('switching to System keeps the ClaudeUI choice, so switching back restores it', async () => {
    const registry = registryOf()
    await call(registry, 'harness:set-selection', {
      id: 'pi',
      selection: { source: 'managed', version: 'latest' }
    })
    await call(registry, 'harness:set-selection', { id: 'pi', selection: { source: 'system' } })
    expect(loadHarnessesConfig().selections?.pi).toEqual({ source: 'system', version: 'latest' })
    await call(registry, 'harness:set-selection', { id: 'pi', selection: { source: 'managed' } })
    expect(loadHarnessesConfig().selections?.pi).toEqual({ source: 'managed', version: 'latest' })
  })

  it('a managed selection without a version is tested; Codex accepts only that', () => {
    expect(validateHarnessSelection('opencode', { source: 'managed' })).toEqual({
      source: 'managed',
      version: 'tested'
    })
    expect(validateHarnessSelection('codex', { source: 'managed', version: 'tested' })).toEqual({
      source: 'managed',
      version: 'tested'
    })
    expect(validateHarnessSelection('claude', { source: 'system' })).toEqual({ source: 'system' })
    // A kept version that is no longer valid is dropped rather than carried over.
    expect(
      validateHarnessSelection(
        'opencode',
        { source: 'system' },
        { source: 'managed', version: '0.1.0' }
      )
    ).toEqual({ source: 'system' })
    expect(CODEX.tested).toMatch(/^\d/)
  })
})

describe('harness:install and harness:install-cancel', () => {
  /** An install that runs until its signal aborts. */
  function blockingInstall(): {
    install: NonNullable<HarnessCommandDeps['install']>
    started: Promise<void>
    calls: Array<[HarnessId, string]>
  } {
    const calls: Array<[HarnessId, string]> = []
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const install: NonNullable<HarnessCommandDeps['install']> = (id, version, { signal }) => {
      calls.push([id, version])
      markStarted()
      return new Promise((resolve) => {
        signal.addEventListener('abort', () =>
          resolve({ status: 'failed', id, version, reason: 'The install was cancelled' })
        )
      })
    }
    return { install, started, calls }
  }

  it('hands the exact version to the installer and cancels it by harness and version', async () => {
    const { install, started, calls } = blockingInstall()
    const registry = registryOf(commands({ install }))
    const pending = call(registry, 'harness:install', { id: 'opencode', version: 'tested' })
    await started
    expect(calls).toEqual([['opencode', OPENCODE.tested]])

    // The progress pill knows only the exact version; `tested` finds it too.
    await expect(
      call(registry, 'harness:install-cancel', { id: 'opencode', version: OPENCODE.tested })
    ).resolves.toEqual({ status: 'cancelled', id: 'opencode', version: OPENCODE.tested })
    await expect(pending).resolves.toMatchObject({
      status: 'failed',
      reason: 'The install was cancelled'
    })
    // Nothing left to cancel.
    await expect(
      call(registry, 'harness:install-cancel', { id: 'opencode', version: 'tested' })
    ).resolves.toEqual({ status: 'not-running', id: 'opencode', version: OPENCODE.tested })
  })

  it('resolves `latest` through upstream first, so a cancel by exact version reaches it', async () => {
    const { install, started, calls } = blockingInstall()
    const registry = registryOf(commands({ install, latestVersion: async () => '0.99.0' }))
    const pending = call(registry, 'harness:install', { id: 'pi', version: 'latest' })
    await started
    expect(calls).toEqual([['pi', '0.99.0']])
    await expect(
      call(registry, 'harness:install-cancel', { id: 'pi', version: 'latest' })
    ).resolves.toMatchObject({ status: 'cancelled', version: '0.99.0' })
    await pending
  })

  it('refuses a version that is not one before anything is installed', async () => {
    const install = vi.fn()
    const registry = registryOf(commands({ install }))
    await expect(
      call(registry, 'harness:install', { id: 'opencode', version: '../x' })
    ).rejects.toThrow(/Invalid harness version/)
    await expect(
      call(registry, 'harness:install', { id: 'nope', version: 'tested' })
    ).rejects.toThrow(/Unknown harness/)
    expect(install).not.toHaveBeenCalled()
  })
})

describe('harness:detect and harness:versions', () => {
  it('runs a user detection for the named harnesses and answers the new state', async () => {
    const requestDetection = vi.fn(async () => {})
    const registry = registryOf(commands({ requestDetection }))
    const answer = (await call(registry, 'harness:detect', {
      ids: ['pi', 'pi', 'codex']
    })) as HarnessStateSnapshot
    expect(requestDetection).toHaveBeenCalledWith(['pi', 'codex'], 'user')
    expect(Object.keys(answer.harnesses).sort()).toEqual(['claude', 'codex', 'opencode', 'pi'])

    await call(registry, 'harness:detect', {})
    expect(requestDetection).toHaveBeenLastCalledWith(undefined, 'user')
    await expect(call(registry, 'harness:detect', { ids: ['gemini'] })).rejects.toThrow(
      /Invalid harness list/
    )
    await expect(call(registry, 'harness:detect', { ids: [] })).rejects.toThrow(
      /Invalid harness list/
    )
  })

  it('answers upstream versions, and that Claude Code has none', async () => {
    const registry = registryOf(
      commands({
        latestVersion: async () => '1.18.40',
        availableVersions: async () => ['1.18.40', OPENCODE.tested]
      })
    )
    await expect(call(registry, 'harness:versions', { id: 'opencode' })).resolves.toEqual({
      status: 'ok',
      id: 'opencode',
      latest: '1.18.40',
      available: ['1.18.40', OPENCODE.tested]
    })
    await expect(call(registry, 'harness:versions', { id: 'claude' })).resolves.toMatchObject({
      status: 'unsupported',
      id: 'claude'
    })
  })
})

describe('events (startHarnessEvents)', () => {
  it('sends harness:changed for each invalidated harness, until unsubscribed', () => {
    const emit = vi.fn()
    const stop = startHarnessEvents(emit)
    invalidateHarness('pi')
    expect(emit).toHaveBeenCalledWith('harness:changed', [{ id: 'pi' }])
    emit.mockClear()
    invalidateHarness()
    expect(emit.mock.calls).toEqual(
      ['claude', 'opencode', 'pi', 'codex'].map((id) => ['harness:changed', [{ id }]])
    )
    stop()
    emit.mockClear()
    invalidateHarness('pi')
    expect(emit).not.toHaveBeenCalled()
  })

  it("forwards the real installer's progress as harness:install-progress", async () => {
    // Already installed: the real installer answers without a download, and
    // still reports its phases.
    fakeHarnessInstall(store, 'opencode', OPENCODE.tested)
    const emit = vi.fn()
    const stop = startHarnessEvents(emit)
    try {
      const { installHarness } = await import('../../../core/harness/install/installer')
      await expect(installHarness('opencode', 'tested')).resolves.toMatchObject({
        status: 'installed'
      })
    } finally {
      stop()
    }
    const progress = emit.mock.calls.filter(([channel]) => channel === 'harness:install-progress')
    expect(progress.map(([, [p]]) => p.phase)).toEqual(['resolving', 'done'])
    expect(progress[0][1][0]).toMatchObject({ id: 'opencode', version: OPENCODE.tested })
  })

  it('a second start replaces the first, so each event goes out once', () => {
    const first = vi.fn()
    const second = vi.fn()
    startHarnessEvents(first)
    const stop = startHarnessEvents(second)
    try {
      invalidateHarness('opencode')
      expect(first).not.toHaveBeenCalled()
      expect(second).toHaveBeenCalledTimes(1)
    } finally {
      stop()
    }
  })

  it('an emitter that throws does not break the resolver', () => {
    const stop = startHarnessEvents(() => {
      throw new Error('no subscriber')
    })
    try {
      expect(() => invalidateHarness('codex')).not.toThrow()
      expect(resolveHarness('codex').id).toBe('codex')
    } finally {
      stop()
    }
  })
})

describe('no result carries an `ok` key (the transports read it as their envelope)', () => {
  it('holds for every channel and every result shape', async () => {
    fakeHarnessInstall(store, 'opencode', OPENCODE.tested)
    saveDetectionCache([
      {
        id: 'opencode',
        detectedAt: '2026-09-30T00:00:00.000Z',
        installs: [nativeInstall('opencode', OPENCODE.tested)]
      }
    ])
    writeSelections({ opencode: { source: 'system' } })
    let result: HarnessInstallResult = {
      status: 'installed',
      id: 'opencode',
      version: OPENCODE.tested,
      verified: 'reviewed'
    }
    const registry = registryOf(
      commands({
        install: async () => result,
        latestVersion: async () => OPENCODE.tested,
        availableVersions: async () => [OPENCODE.tested],
        activeInstalls: () => [{ id: 'pi', version: '0.99.0', phase: 'downloading' }]
      })
    )
    const answers: unknown[] = [
      await call(registry, 'harness:state'),
      await call(registry, 'harness:versions', { id: 'opencode' }),
      await call(registry, 'harness:versions', { id: 'claude' }),
      await call(registry, 'harness:set-selection', {
        id: 'opencode',
        selection: { source: 'system' }
      }),
      await call(registry, 'harness:install', { id: 'opencode', version: 'tested' }),
      await call(registry, 'harness:install-cancel', { id: 'opencode', version: 'tested' }),
      await call(registry, 'harness:detect', {})
    ]
    result = { status: 'failed', id: 'opencode', version: OPENCODE.tested, reason: 'x' }
    answers.push(await call(registry, 'harness:install', { id: 'opencode', version: 'tested' }))

    for (const answer of answers) {
      expect(allKeys(answer).has('ok'), JSON.stringify(answer)).toBe(false)
    }
    // The `ok` System choice is a value, and a discriminant, not a key.
    expect(JSON.stringify(answers[0])).toContain('"kind":"ok"')
  })
})

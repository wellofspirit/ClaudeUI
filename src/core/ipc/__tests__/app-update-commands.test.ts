/**
 * @vitest-environment node
 *
 * ClaudeUI's update channels (auto-update design §3): `core/ipc/app-update-commands.ts`
 * run through the real `CommandRegistry` on both transports with a fake updater
 * (the updater itself is `core/services/__tests__/app-update.test.ts`).
 *
 * What this file guards:
 *  - the capability split: the state read is `config`, the four writes `admin`,
 *    pinned so no edit can relabel one;
 *  - a base remote connection reads the state and is refused every write, an
 *    admin one is served, and a write is audited under its capability;
 *  - arguments, results, and that none carries an `ok` key;
 *  - `app-update:changed` is a classified replicated nudge, and the emitter
 *    forwards the updater's changes to the funnel exactly once.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const appendAuditLog = vi.hoisted(() => vi.fn())
vi.mock('../../services/db', () => ({ appendAuditLog }))

import type { AppUpdateView } from '../../../shared/types/app-update'
import {
  AUTH_OFF_GRANTS,
  CommandRegistry,
  FULL_REMOTE_GRANTS,
  PINNED_CAPABILITIES,
  hostConnection,
  makeRemoteConnection,
  type CommandRegistration
} from '../command-registry'
import {
  APP_UPDATE_CHANNELS,
  appUpdateCommands,
  startAppUpdateEvents
} from '../app-update-commands'
import { channelSpec } from '../../shared/sync/channels'
import type { AppUpdater } from '../../services/app-update'

const VIEW: AppUpdateView = {
  supported: true,
  current: { kind: 'release', version: '1.0.0', comparisonVersion: '1.0.0', channel: 'stable' },
  eligibility: { ok: true },
  settings: { channel: 'auto', effectiveChannel: 'stable', mode: 'auto' },
  check: { running: false },
  download: { phase: 'idle' }
}

const WRITES = ['app-update:check', 'app-update:download', 'app-update:skip', 'app-update:apply']

/** A scriptable updater: the commands only call these. */
function fakeUpdater(overrides: Partial<AppUpdater> = {}): AppUpdater & { fire: () => void } {
  const listeners = new Set<() => void>()
  return {
    start: vi.fn(),
    stop: vi.fn(),
    check: vi.fn(async () => {}),
    download: vi.fn(async () => {}),
    skip: vi.fn(async () => {}),
    apply: vi.fn(async () => {}),
    state: vi.fn(async () => VIEW),
    view: vi.fn(() => VIEW),
    settingsChanged: vi.fn(),
    onChanged: vi.fn((fn: () => void) => {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    }),
    idle: vi.fn(async () => {}),
    fire: () => {
      for (const fn of listeners) fn()
    },
    ...overrides
  }
}

function registryOf(updater: AppUpdater = fakeUpdater()): CommandRegistry {
  const registry = new CommandRegistry()
  const cmds: Array<Omit<CommandRegistration, 'transport'>> = appUpdateCommands({ updater })
  for (const cmd of cmds) {
    registry.register({ ...cmd, transport: 'desktop' })
    registry.register({ ...cmd, transport: 'remote' })
  }
  return registry
}

beforeEach(() => appendAuditLog.mockClear())

describe('capabilities', () => {
  it('declares the state a `config` query and the four writes `admin` commands, on both transports', () => {
    const registry = registryOf()
    expect(
      Object.fromEntries(APP_UPDATE_CHANNELS.map((c) => [c, registry.declaration(c)]))
    ).toEqual({
      'app-update:state': expect.objectContaining({ capability: 'config', kind: 'query' }),
      'app-update:check': expect.objectContaining({ capability: 'admin', kind: 'command' }),
      'app-update:download': expect.objectContaining({ capability: 'admin', kind: 'command' }),
      'app-update:skip': expect.objectContaining({ capability: 'admin', kind: 'command' }),
      'app-update:apply': expect.objectContaining({ capability: 'admin', kind: 'command' })
    })
    expect(registry.channels('remote')).toEqual([...APP_UPDATE_CHANNELS].sort())
    expect(registry.channels('desktop')).toEqual([...APP_UPDATE_CHANNELS].sort())
  })

  it.each(WRITES)('pins %s at `admin`: registering it as `config` or `chat` throws', (channel) => {
    expect(PINNED_CAPABILITIES[channel]).toBe('admin')
    const cmd = appUpdateCommands({ updater: fakeUpdater() }).find((c) => c.channel === channel)!
    for (const capability of ['chat', 'config'] as const) {
      expect(() =>
        new CommandRegistry().register({ ...cmd, capability, transport: 'remote' })
      ).toThrow(/pinned to "admin"/)
    }
  })

  it('lets a base remote connection read the state and refuses it every write', async () => {
    const updater = fakeUpdater()
    const registry = registryOf(updater)
    const base = makeRemoteConnection('none', null, AUTH_OFF_GRANTS)
    await expect(registry.dispatch('app-update:state', 'remote', [], base)).resolves.toEqual(VIEW)
    for (const channel of WRITES) {
      await expect(
        registry.dispatch(channel, 'remote', [{ version: '1.1.0' }], base)
      ).rejects.toThrow(/Permission denied/)
    }
    expect(updater.check).not.toHaveBeenCalled()
    expect(updater.download).not.toHaveBeenCalled()
    expect(updater.skip).not.toHaveBeenCalled()
    expect(updater.apply).not.toHaveBeenCalled()
  })

  it('serves an admin connection, and audits the write under its capability', async () => {
    const updater = fakeUpdater()
    const registry = registryOf(updater)
    const admin = makeRemoteConnection('webauthn', 'phone', FULL_REMOTE_GRANTS)
    await expect(registry.dispatch('app-update:apply', 'remote', [], admin)).resolves.toEqual({
      accepted: true
    })
    expect(updater.apply).toHaveBeenCalledTimes(1)
    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'app-update:apply', capability: 'admin' })
    )
  })
})

describe('results', () => {
  const call = (
    registry: CommandRegistry,
    channel: string,
    args: unknown[] = []
  ): Promise<unknown> => registry.dispatch(channel, 'desktop', args, hostConnection())

  it('answers the view after check, download and skip', async () => {
    const updater = fakeUpdater()
    const registry = registryOf(updater)
    await expect(call(registry, 'app-update:check')).resolves.toEqual(VIEW)
    expect(updater.check).toHaveBeenCalledWith('user')
    await expect(call(registry, 'app-update:download')).resolves.toEqual(VIEW)
    expect(updater.download).toHaveBeenCalledTimes(1)
    await expect(call(registry, 'app-update:skip', [{ version: '1.1.0' }])).resolves.toEqual(VIEW)
    expect(updater.skip).toHaveBeenCalledWith('1.1.0')
  })

  it('refuses a skip without a version string', async () => {
    const updater = fakeUpdater()
    const registry = registryOf(updater)
    for (const args of [[], [null], [{}], [{ version: 7 }]]) {
      await expect(call(registry, 'app-update:skip', args)).rejects.toThrow(/version is required/)
    }
    expect(updater.skip).not.toHaveBeenCalled()
  })

  it('surfaces a refusal as an error, not a result', async () => {
    const registry = registryOf(
      fakeUpdater({
        apply: vi.fn(async () => {
          throw new Error('No update is staged to apply')
        }),
        download: vi.fn(async () => {
          throw new Error('No update is available to download')
        })
      })
    )
    await expect(call(registry, 'app-update:apply')).rejects.toThrow(/No update is staged/)
    await expect(call(registry, 'app-update:download')).rejects.toThrow(/No update is available/)
  })

  it('never carries an `ok` key (the transports would take it for their envelope)', async () => {
    const registry = registryOf()
    for (const channel of APP_UPDATE_CHANNELS) {
      const result = await call(registry, channel, [{ version: '1.1.0' }])
      expect(Object.keys(result as object), channel).not.toContain('ok')
    }
  })
})

describe('app-update:changed', () => {
  it('is a replicated, non-canonical sync event', () => {
    expect(channelSpec('app-update:changed')).toMatchObject({
      cls: 'replicated',
      canonical: false
    })
  })

  it('forwards every updater change to the funnel, payload-free', () => {
    const updater = fakeUpdater()
    const emit = vi.fn()
    const stop = startAppUpdateEvents(emit, updater)
    updater.fire()
    updater.fire()
    expect(emit.mock.calls).toEqual([
      ['app-update:changed', []],
      ['app-update:changed', []]
    ])
    stop()
    updater.fire()
    expect(emit).toHaveBeenCalledTimes(2)
  })

  it('goes out once when started twice (a test that boots core twice)', () => {
    const first = fakeUpdater()
    const second = fakeUpdater()
    const emit = vi.fn()
    startAppUpdateEvents(emit, first)
    const stop = startAppUpdateEvents(emit, second)
    first.fire()
    second.fire()
    expect(emit).toHaveBeenCalledTimes(1)
    stop()
  })

  it('swallows an emitter that throws (no subscriber can take it at shutdown)', () => {
    const updater = fakeUpdater()
    const stop = startAppUpdateEvents(() => {
      throw new Error('shutting down')
    }, updater)
    expect(() => updater.fire()).not.toThrow()
    stop()
  })
})

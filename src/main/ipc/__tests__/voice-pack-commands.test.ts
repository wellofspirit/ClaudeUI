/**
 * @vitest-environment node
 *
 * The speech pack's channels (ADR-101 §6): `core/ipc/voice-pack-commands.ts` run
 * through the real `CommandRegistry` on both transports with a fake installer (the
 * installer itself is `core/voice/__tests__/pack-installer.test.ts`).
 *
 * What this file guards:
 *  - the capability split: the status read is `chat`, install / cancel / remove
 *    `admin`, the three pinned so no edit can relabel one;
 *  - a base remote connection reads the status and is refused every write, an
 *    admin one is served, and a write is audited under its capability;
 *  - result shapes, and that none carries an `ok` key (the transports' envelope);
 *  - `voice:pack-changed` is a classified replicated event, and the emitter
 *    forwards the installer's changes to the funnel exactly once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const appendAuditLog = vi.hoisted(() => vi.fn())
vi.mock('../../../core/services/db', () => ({ appendAuditLog }))

import type { VoicePackStatus } from '../../../shared/voice-pack'
import {
  AUTH_OFF_GRANTS,
  CommandRegistry,
  FULL_REMOTE_GRANTS,
  hostConnection,
  makeRemoteConnection,
  type CommandRegistration
} from '../../../core/ipc/command-registry'
import {
  VOICE_PACK_CHANNELS,
  startVoicePackEvents,
  voicePackCommands
} from '../../../core/ipc/voice-pack-commands'
import { channelSpec } from '../../../core/shared/sync/channels'
import {
  createVoicePackInstaller,
  type VoicePackInstaller
} from '../../../core/voice/pack-installer'
import { VOICE_STORE_ENV } from '../../../core/voice/pack-store'

const READY: VoicePackStatus = {
  state: 'ready',
  packId: 'p',
  label: 'Pack',
  approxBytes: 700_000_000
}

/** A scriptable installer: the commands only ever call these five methods. */
function fakeInstaller(overrides: Partial<VoicePackInstaller> = {}): VoicePackInstaller & {
  emit: (status: VoicePackStatus) => void
} {
  const listeners = new Set<(status: VoicePackStatus) => void>()
  return {
    status: vi.fn(() => READY),
    install: vi.fn(async () => ({ status: 'installed' as const })),
    cancel: vi.fn(() => true),
    remove: vi.fn(async () => ({ status: 'removed' as const })),
    onChange: vi.fn((fn) => {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    }),
    emit: (status) => {
      for (const fn of listeners) fn(status)
    },
    ...overrides
  }
}

function commands(
  installer: VoicePackInstaller = fakeInstaller()
): Array<Omit<CommandRegistration, 'transport'>> {
  return voicePackCommands({ installer })
}

/** The declarations on both transports, as production registers them. */
function registryOf(cmds = commands()): CommandRegistry {
  const registry = new CommandRegistry()
  for (const cmd of cmds) {
    registry.register({ ...cmd, transport: 'desktop' })
    registry.register({ ...cmd, transport: 'remote' })
  }
  return registry
}

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

beforeEach(() => appendAuditLog.mockClear())

describe('capabilities (ADR-101 §6)', () => {
  it('declares the status a `chat` query and the three writes `admin` commands, on both transports', () => {
    const registry = registryOf()
    const declared = Object.fromEntries(
      VOICE_PACK_CHANNELS.map((c) => [c, registry.declaration(c)])
    )
    expect(declared).toEqual({
      'voice:pack-status': expect.objectContaining({ capability: 'chat', kind: 'query' }),
      'voice:pack-install': expect.objectContaining({ capability: 'admin', kind: 'command' }),
      'voice:pack-install-cancel': expect.objectContaining({
        capability: 'admin',
        kind: 'command'
      }),
      'voice:pack-remove': expect.objectContaining({ capability: 'admin', kind: 'command' })
    })
    expect(registry.channels('remote')).toEqual([...VOICE_PACK_CHANNELS].sort())
    expect(registry.channels('desktop')).toEqual([...VOICE_PACK_CHANNELS].sort())
  })

  it.each(['voice:pack-install', 'voice:pack-install-cancel', 'voice:pack-remove'])(
    'pins %s: registering it as `chat` or `config` throws',
    (channel) => {
      const cmd = commands().find((c) => c.channel === channel)!
      for (const capability of ['chat', 'config'] as const) {
        expect(() =>
          new CommandRegistry().register({ ...cmd, capability, transport: 'remote' })
        ).toThrow(/pinned to "admin"/)
      }
    }
  )

  it('lets a base remote connection read the status and refuses it every write', async () => {
    const installer = fakeInstaller()
    const registry = registryOf(commands(installer))
    const base = makeRemoteConnection('none', null, AUTH_OFF_GRANTS)

    await expect(registry.dispatch('voice:pack-status', 'remote', [], base)).resolves.toEqual(READY)
    for (const channel of [
      'voice:pack-install',
      'voice:pack-install-cancel',
      'voice:pack-remove'
    ]) {
      await expect(registry.dispatch(channel, 'remote', [], base)).rejects.toThrow(
        /Permission denied/
      )
    }
    expect(installer.install).not.toHaveBeenCalled()
    expect(installer.cancel).not.toHaveBeenCalled()
    expect(installer.remove).not.toHaveBeenCalled()
  })

  it('serves an admin connection, and audits the write under its capability', async () => {
    const installer = fakeInstaller()
    const registry = registryOf(commands(installer))
    const admin = makeRemoteConnection('webauthn', 'phone', FULL_REMOTE_GRANTS)

    await expect(registry.dispatch('voice:pack-install', 'remote', [], admin)).resolves.toEqual({
      status: 'installed'
    })
    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'voice:pack-install', capability: 'admin' })
    )
  })
})

describe('results', () => {
  it('relays the installer: status, install, cancel and remove', async () => {
    const installer = fakeInstaller({
      install: vi.fn(async () => ({ status: 'failed' as const, message: 'no route to host' }))
    })
    const registry = registryOf(commands(installer))
    const call = (channel: string): Promise<unknown> =>
      registry.dispatch(channel, 'desktop', [], hostConnection())

    await expect(call('voice:pack-status')).resolves.toEqual(READY)
    await expect(call('voice:pack-install')).resolves.toEqual({
      status: 'failed',
      message: 'no route to host'
    })
    await expect(call('voice:pack-install-cancel')).resolves.toEqual({ status: 'cancelled' })
    ;(installer.cancel as ReturnType<typeof vi.fn>).mockReturnValue(false)
    await expect(call('voice:pack-install-cancel')).resolves.toEqual({ status: 'not-running' })
    await expect(call('voice:pack-remove')).resolves.toEqual({ status: 'removed' })
    ;(installer.remove as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'not-installed' })
    await expect(call('voice:pack-remove')).resolves.toEqual({ status: 'not-installed' })
  })

  it('surfaces a removal that cannot happen as an error, not a result', async () => {
    const installer = fakeInstaller({
      remove: vi.fn(async () => {
        throw new Error('The speech model is in use and cannot be removed (EPERM)')
      })
    })
    await expect(
      registryOf(commands(installer)).dispatch('voice:pack-remove', 'desktop', [], hostConnection())
    ).rejects.toThrow(/in use/)
  })

  it('never carries an `ok` key (the transports would take it for their envelope)', async () => {
    const registry = registryOf()
    for (const channel of VOICE_PACK_CHANNELS) {
      const result = await registry.dispatch(channel, 'desktop', [], hostConnection())
      expect(allKeys(result).has('ok'), channel).toBe(false)
    }
  })
})

describe('the real installer behind the status read', () => {
  let root: string
  let saved: string | undefined
  beforeEach(() => {
    saved = process.env[VOICE_STORE_ENV]
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeui-voice-cmd-'))
    process.env[VOICE_STORE_ENV] = root
  })
  afterEach(() => {
    if (saved === undefined) delete process.env[VOICE_STORE_ENV]
    else process.env[VOICE_STORE_ENV] = saved
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('answers from the empty store without touching the network or the worker', async () => {
    const suspend = vi.fn()
    const fetchFn = vi.fn()
    const installer = createVoicePackInstaller({ suspend, fetch: fetchFn })
    const status = (await registryOf(commands(installer)).dispatch(
      'voice:pack-status',
      'desktop',
      [],
      hostConnection()
    )) as VoicePackStatus
    // 'unsupported' on a CI host with no speech runtime, 'missing' everywhere else.
    expect(['missing', 'unsupported']).toContain(status.state)
    expect(status.approxBytes).toBe(700_000_000)
    expect(suspend).not.toHaveBeenCalled()
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('voice:pack-changed', () => {
  it('is a replicated, ringed, non-canonical sync event', () => {
    expect(channelSpec('voice:pack-changed')).toMatchObject({
      cls: 'replicated',
      ring: true,
      canonical: false
    })
  })

  it('forwards every installer change to the funnel with the whole status', () => {
    const installer = fakeInstaller()
    const emit = vi.fn()
    const stop = startVoicePackEvents(emit, installer)
    const installing: VoicePackStatus = {
      ...READY,
      state: 'installing',
      progress: { receivedBytes: 5, totalBytes: 10 }
    }
    installer.emit(installing)
    installer.emit(READY)
    expect(emit.mock.calls).toEqual([
      ['voice:pack-changed', [installing]],
      ['voice:pack-changed', [READY]]
    ])
    stop()
    installer.emit(READY)
    expect(emit).toHaveBeenCalledTimes(2)
  })

  it('goes out once when started twice (a test that boots core twice)', () => {
    const first = fakeInstaller()
    const second = fakeInstaller()
    const emit = vi.fn()
    startVoicePackEvents(emit, first)
    const stop = startVoicePackEvents(emit, second)
    first.emit(READY)
    second.emit(READY)
    expect(emit).toHaveBeenCalledTimes(1)
    stop()
  })

  it('swallows an emitter that throws (no subscriber can take it at shutdown)', () => {
    const installer = fakeInstaller()
    const stop = startVoicePackEvents(() => {
      throw new Error('shutting down')
    }, installer)
    expect(() => installer.emit(READY)).not.toThrow()
    stop()
  })
})

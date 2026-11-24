/**
 * @vitest-environment node
 *
 * The relaunch channels (`core/ipc/app-relaunch-commands.ts`) through the real
 * `CommandRegistry` on both transports, with a fake host relaunch:
 *  - `app:relaunch` is a pinned `admin` command; the three reads are `config`;
 *  - a base remote connection reads and is refused the restart; an admin one is served;
 *  - with no host relaunch (the server, S1) the restart refuses and availability says so;
 *  - no result carries an `ok` key (the transports' envelope).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const appendAuditLog = vi.hoisted(() => vi.fn())
vi.mock('../../services/db', () => ({ appendAuditLog }))

import {
  AUTH_OFF_GRANTS,
  CommandRegistry,
  FULL_REMOTE_GRANTS,
  makeRemoteConnection
} from '../command-registry'
import {
  APP_RELAUNCH_CHANNELS,
  RELAUNCH_UNAVAILABLE,
  appRelaunchCommands,
  type AppRelaunchDeps
} from '../app-relaunch-commands'
import type { HostRelaunch } from '../../host'

function fakeHost(over: Partial<HostRelaunch> = {}): HostRelaunch {
  return {
    availability: vi.fn(() => ({ available: true })),
    relaunch: vi.fn(async () => {}),
    lastResult: vi.fn(() => null),
    ...over
  }
}

function registryOf(deps: AppRelaunchDeps): CommandRegistry {
  const registry = new CommandRegistry()
  for (const cmd of appRelaunchCommands(deps)) {
    registry.register({ ...cmd, transport: 'desktop' })
    registry.register({ ...cmd, transport: 'remote' })
  }
  return registry
}

const impact = { workingSessions: 2, terminals: 1, remoteClients: 3 }
const base = makeRemoteConnection('none', null, AUTH_OFF_GRANTS)
const admin = makeRemoteConnection('webauthn', 'phone', FULL_REMOTE_GRANTS)

beforeEach(() => appendAuditLog.mockClear())

describe('capabilities', () => {
  it('declares the restart an admin command and the reads config queries, on both transports', () => {
    const registry = registryOf({ relaunch: () => fakeHost(), impact: () => impact })
    expect(
      Object.fromEntries(APP_RELAUNCH_CHANNELS.map((c) => [c, registry.declaration(c)]))
    ).toEqual({
      'app:relaunch': expect.objectContaining({ capability: 'admin', kind: 'command' }),
      'app:relaunch-availability': expect.objectContaining({ capability: 'config', kind: 'query' }),
      'app:restart-impact': expect.objectContaining({ capability: 'config', kind: 'query' }),
      'app:last-relaunch': expect.objectContaining({ capability: 'config', kind: 'query' })
    })
    expect(registry.channels('remote')).toEqual([...APP_RELAUNCH_CHANNELS].sort())
  })

  it('pins app:relaunch: registering it as config throws', () => {
    const cmd = appRelaunchCommands({ relaunch: () => null, impact: () => impact }).find(
      (c) => c.channel === 'app:relaunch'
    )!
    expect(() =>
      new CommandRegistry().register({ ...cmd, capability: 'config', transport: 'remote' })
    ).toThrow(/pinned to "admin"/)
  })

  it('a base connection reads but cannot restart; an admin one restarts, audited', async () => {
    const host = fakeHost()
    const registry = registryOf({ relaunch: () => host, impact: () => impact })
    await expect(registry.dispatch('app:restart-impact', 'remote', [], base)).resolves.toEqual(
      impact
    )
    await expect(
      registry.dispatch('app:relaunch-availability', 'remote', [], base)
    ).resolves.toEqual({
      available: true
    })
    await expect(registry.dispatch('app:relaunch', 'remote', [], base)).rejects.toThrow(
      /Permission denied/
    )
    expect(host.relaunch).not.toHaveBeenCalled()
    await expect(registry.dispatch('app:relaunch', 'remote', [], admin)).resolves.toEqual({
      accepted: true
    })
    expect(host.relaunch).toHaveBeenCalledTimes(1)
    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'app:relaunch', capability: 'admin' })
    )
  })
})

describe('behaviour', () => {
  it('with no host relaunch (the server), the restart refuses and availability says why', async () => {
    const registry = registryOf({ relaunch: () => null, impact: () => impact })
    await expect(registry.dispatch('app:relaunch', 'remote', [], admin)).rejects.toThrow(
      RELAUNCH_UNAVAILABLE
    )
    await expect(
      registry.dispatch('app:relaunch-availability', 'remote', [], admin)
    ).resolves.toEqual({
      available: false,
      reason: RELAUNCH_UNAVAILABLE
    })
    await expect(registry.dispatch('app:last-relaunch', 'remote', [], admin)).resolves.toBeNull()
  })

  it('an unavailable host refuses with its reason and does not relaunch', async () => {
    const host = fakeHost({ availability: () => ({ available: false, reason: 'no marker' }) })
    const registry = registryOf({ relaunch: () => host, impact: () => impact })
    await expect(registry.dispatch('app:relaunch', 'remote', [], admin)).rejects.toThrow(
      'no marker'
    )
    expect(host.relaunch).not.toHaveBeenCalled()
  })

  it("a host's refusal reaches the caller", async () => {
    const host = fakeHost({
      relaunch: async () => {
        throw new Error('Could not relaunch: the relaunch helper did not start within 5 s')
      }
    })
    const registry = registryOf({ relaunch: () => host, impact: () => impact })
    await expect(registry.dispatch('app:relaunch', 'remote', [], admin)).rejects.toThrow(
      /did not start/
    )
  })

  it('relays the last result and carries no ok key anywhere', async () => {
    const result = {
      token: 'a'.repeat(32),
      status: 'ok' as const,
      mode: 'relaunch' as const,
      fromVersion: '1',
      toVersion: '1',
      at: 1
    }
    const registry = registryOf({
      relaunch: () => fakeHost({ lastResult: () => result }),
      impact: () => impact
    })
    for (const channel of APP_RELAUNCH_CHANNELS) {
      const value = await registry.dispatch(channel, 'remote', [], admin)
      if (value && typeof value === 'object') expect('ok' in value).toBe(false)
    }
    await expect(registry.dispatch('app:last-relaunch', 'remote', [], admin)).resolves.toEqual(
      result
    )
  })
})

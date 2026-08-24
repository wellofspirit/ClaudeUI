/**
 * @vitest-environment node
 *
 * S1b — `automation:*` on the command registry.
 *
 * The port's whole point is that these ten channels stopped being raw
 * `ipcMain.handle` calls: they declare a capability, they are checked against
 * the caller's grants, the mutations produce audit rows, and both transports
 * serve them from ONE declaration. Each of those four is asserted here.
 *
 * The audit sink is mocked (as in `command-registry.test.ts`) so this stays a
 * pure unit test; the repository itself is covered in
 * `services/__tests__/db-audit-log.test.ts`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const appendAuditLog = vi.hoisted(() => vi.fn())
vi.mock('../../../core/services/db', () => ({ appendAuditLog }))

vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import { AUTOMATION_COMMANDS, setAutomationManager } from '../../../core/ipc/automation-commands'
import {
  CommandRegistry,
  makeRemoteConnection,
  AUTH_OFF_GRANTS,
  ENROLL_ONLY_GRANTS
} from '../../../core/ipc/command-registry'
import type { AutomationManager } from '../../../core/services/automation-manager'

const managerSpies = {
  list: vi.fn(() => [{ id: 'a1' }]),
  listRuns: vi.fn(() => [{ id: 'r1' }]),
  loadRunMessages: vi.fn(() => [{ role: 'assistant' }]),
  upsert: vi.fn(),
  delete: vi.fn(),
  toggle: vi.fn(),
  runNow: vi.fn(async () => {}),
  cancelRun: vi.fn(),
  sendMessage: vi.fn(),
  dismissRun: vi.fn()
}

/** A registry with the automation family on BOTH transports, as boot wires it. */
function registryWithAutomations(): CommandRegistry {
  const registry = new CommandRegistry()
  for (const cmd of AUTOMATION_COMMANDS) {
    registry.register({ ...cmd, transport: 'desktop' })
    registry.register({ ...cmd, transport: 'remote' })
  }
  return registry
}

/** An ordinary authenticated remote client (holds `config`). */
const granted = makeRemoteConnection('password', 'owner@example.com')
/** An enrollment link: `enroll` and nothing else. */
const ungranted = makeRemoteConnection('enroll-token', null, ENROLL_ONLY_GRANTS)

beforeEach(() => {
  appendAuditLog.mockClear()
  Object.values(managerSpies).forEach((fn) => fn.mockClear())
  setAutomationManager(managerSpies as unknown as AutomationManager)
})

describe('automation:* registration', () => {
  it('declares `config` for all ten, `query` for the three reads', () => {
    const registry = registryWithAutomations()
    expect(registry.channels('remote')).toEqual(registry.channels('desktop'))
    expect(registry.channels('remote')).toHaveLength(10)
    const reads = ['automation:list', 'automation:list-runs', 'automation:load-run-history']
    for (const channel of registry.channels('remote')) {
      const decl = registry.declaration(channel)!
      expect(decl.capability, channel).toBe('config')
      expect(decl.kind, channel).toBe(reads.includes(channel) ? 'query' : 'command')
      // `config` IS in the base grant set — the ruling, stated as an assertion:
      // an automation is host-side configuration, reachable by any authenticated
      // connection rather than gated behind the session-security `admin`.
      expect(AUTH_OFF_GRANTS.has(decl.capability), channel).toBe(true)
    }
  })

  it('one declaration serves both transports (registering it twice cannot drift)', () => {
    // The registry throws on a per-transport disagreement, so the fact that
    // `registryWithAutomations` completes IS the guarantee. Pin the shape that
    // makes it hold: both spreads come from the same frozen array.
    const registry = registryWithAutomations()
    for (const cmd of AUTOMATION_COMMANDS) {
      expect(registry.get(cmd.channel, 'desktop')!.handler).toBe(
        registry.get(cmd.channel, 'remote')!.handler
      )
    }
  })
})

describe('automation:* capability gating', () => {
  it('a `config`-holding remote connection may save; an enroll-only one may not', async () => {
    const registry = registryWithAutomations()
    await registry.dispatch('automation:save', 'remote', [{ id: 'nightly' }], granted)
    expect(managerSpies.upsert).toHaveBeenCalledWith({ id: 'nightly' })

    await expect(
      registry.dispatch('automation:save', 'remote', [{ id: 'nightly' }], ungranted)
    ).rejects.toThrow(/Permission denied: "automation:save" requires the "config" capability/)
    expect(managerSpies.upsert).toHaveBeenCalledTimes(1)
  })

  it('RED BEFORE S1b: with no registration the same dispatch is "Channel not available"', async () => {
    // The refusal shape every automation channel gave a remote client before this
    // series — not a permission error, because there was nothing registered to
    // have a permission ON. Kept as an explicit pin so "it fails either way"
    // cannot quietly become the excuse for un-registering them again.
    const bare = new CommandRegistry()
    await expect(
      bare.dispatch('automation:save', 'remote', [{ id: 'nightly' }], granted)
    ).rejects.toThrow('Channel not available: automation:save')
  })

  it('rejects a traversal id before the manager sees it (audit M-AU3)', async () => {
    const registry = registryWithAutomations()
    for (const [channel, args] of [
      ['automation:delete', ['../..']],
      ['automation:save', [{ id: '../evil' }]],
      ['automation:toggle', ['a/b', true]],
      ['automation:list-runs', ['..']],
      ['automation:load-run-history', ['ok-id', '../r']],
      ['automation:dismiss-run', ['../..', 'r1']],
      ['automation:send-message', ['a\\b', 'hi']]
    ] as Array<[string, unknown[]]>) {
      await expect(registry.dispatch(channel, 'remote', args, granted), channel).rejects.toThrow(
        /Invalid automation id/
      )
    }
    expect(managerSpies.delete).not.toHaveBeenCalled()
    expect(managerSpies.upsert).not.toHaveBeenCalled()
    expect(managerSpies.toggle).not.toHaveBeenCalled()
    expect(managerSpies.dismissRun).not.toHaveBeenCalled()
    expect(managerSpies.sendMessage).not.toHaveBeenCalled()
  })

  it('refuses cleanly when no automation manager is running on this host', async () => {
    setAutomationManager(null as unknown as AutomationManager)
    const registry = registryWithAutomations()
    await expect(registry.dispatch('automation:list', 'remote', [], granted)).rejects.toThrow(
      /Automations are not running on this host/
    )
  })
})

describe('automation:* audit', () => {
  it('a mutation writes an ordinary command-kind row', async () => {
    const registry = registryWithAutomations()
    await registry.dispatch('automation:toggle', 'remote', ['nightly', false], granted)
    expect(appendAuditLog).toHaveBeenCalledTimes(1)
    expect(appendAuditLog.mock.calls[0][0]).toMatchObject({
      channel: 'automation:toggle',
      capability: 'config',
      kind: 'command',
      method: 'password',
      label: 'owner@example.com',
      connectionId: granted.connectionId,
      outcome: 'ok',
      // Not session-scoped: an automation id is not a session routing id, so
      // declaring `sessionIdArg` would put a foreign id in this column.
      sessionId: null
    })
  })

  it('a failed mutation is audited as an error, and reads are not audited at all', async () => {
    const registry = registryWithAutomations()
    managerSpies.cancelRun.mockImplementationOnce(() => {
      throw new Error('no run')
    })
    await expect(
      registry.dispatch('automation:cancel', 'remote', ['nightly'], granted)
    ).rejects.toThrow('no run')
    expect(appendAuditLog.mock.calls[0][0]).toMatchObject({
      channel: 'automation:cancel',
      outcome: 'error'
    })

    appendAuditLog.mockClear()
    await registry.dispatch('automation:list', 'remote', [], granted)
    expect(appendAuditLog).not.toHaveBeenCalled()
  })

  it('run-now is still fire-and-forget (the dispatch does not await the run)', async () => {
    const registry = registryWithAutomations()
    let release: (() => void) | undefined
    managerSpies.runNow.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = resolve))
    )
    const start = Date.now()
    await registry.dispatch('automation:run-now', 'remote', ['nightly'], granted)
    expect(Date.now() - start).toBeLessThan(100)
    expect(managerSpies.runNow).toHaveBeenCalledWith('nightly')
    release?.()
  })
})

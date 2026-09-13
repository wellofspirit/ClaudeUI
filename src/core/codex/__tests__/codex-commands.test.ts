import { describe, expect, it, vi } from 'vitest'
import { codexCommands, CODEX_CHANNELS } from '../../ipc/codex-commands'
import { CommandRegistry, hostConnection } from '../../ipc/command-registry'
import type { SessionManager } from '../../services/session-manager'

vi.mock('../../auth/CodexAuthProvider', () => ({
  codexAuthProvider: {
    status: vi.fn(),
    loginStart: vi.fn(),
    loginStatus: vi.fn(),
    loginCancel: vi.fn()
  }
}))
vi.mock('../../services/db', () => ({ appendAuditLog: vi.fn() }))

function fixture(engineId = 'codex') {
  const session = {
    engineId,
    resolveCodexApproval: vi.fn()
  }
  const manager = {
    get: (id: string) => (id === 'native-root' ? session : undefined)
  } as unknown as SessionManager
  const registry = new CommandRegistry()
  for (const command of codexCommands(manager))
    for (const transport of ['desktop', 'remote'] as const)
      registry.register({ ...command, transport })
  return { session, registry }
}

describe('native command authorization', () => {
  it('registers exactly the native approval + auth channels', () => {
    const { registry } = fixture()
    // Model and effort now travel over the engine-neutral `session:set-model` /
    // `session:set-effort` commands, so no native settings channel survives.
    // ADR-068 §1 deleted the native device-code login from the product, and with
    // it the three `codex:login-*` channels; `codex:auth-status` stays as the
    // availability + model-count query.
    expect([...CODEX_CHANNELS]).toEqual(['session:codex-approval', 'codex:auth-status'])
    expect(registry.channels('remote')).toEqual([...CODEX_CHANNELS].sort())
  })

  it('answers native approvals with `chat`, and keeps the auth read behind `config`', async () => {
    const { registry, session } = fixture()
    const connection = { ...hostConnection(), grants: new Set(['chat'] as const) }
    await registry.dispatch(
      'session:codex-approval',
      'remote',
      ['native-root', 'pending', 'cancel'],
      connection
    )
    expect(session.resolveCodexApproval).toHaveBeenCalledExactlyOnceWith('pending', 'cancel')
    // A chat-only connection must not reach the account surface.
    await expect(registry.dispatch('codex:auth-status', 'remote', [], connection)).rejects.toThrow(
      'config'
    )
  })

  it.each(['desktop', 'remote'] as const)(
    'validates the native approval reply and engine on %s',
    async (transport) => {
      const { registry } = fixture()
      await expect(
        fixture('claude').registry.dispatch(
          'session:codex-approval',
          transport,
          ['native-root', 'pending', 'accept'],
          hostConnection()
        )
      ).rejects.toThrow('live Codex')
      await expect(
        registry.dispatch(
          'session:codex-approval',
          transport,
          ['native-root', 'pending', { acceptWithExecpolicyAmendment: {} }],
          hostConnection()
        )
      ).rejects.toThrow('Invalid')
      await expect(
        registry.dispatch('session:codex-approval', transport, [''], hostConnection())
      ).rejects.toThrow('routing ID')
    }
  )
})

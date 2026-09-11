import { describe, expect, it, vi } from 'vitest'
import { codexCommands } from '../../ipc/codex-commands'
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
    setCodexSettings: vi.fn(async () => {}),
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
  it('requires session-config for policy mutation, and chat for native approval replies', async () => {
    const { registry, session } = fixture()
    const connection = { ...hostConnection(), grants: new Set(['chat'] as const) }
    await expect(
      registry.dispatch(
        'session:codex-settings',
        'remote',
        ['native-root', { approvalPolicy: 'never' }],
        connection
      )
    ).rejects.toThrow('session-config')
    expect(session.setCodexSettings).not.toHaveBeenCalled()
    await registry.dispatch(
      'session:codex-approval',
      'remote',
      ['native-root', 'pending', 'cancel'],
      connection
    )
    expect(session.resolveCodexApproval).toHaveBeenCalledExactlyOnceWith('pending', 'cancel')
  })
  it.each(['desktop', 'remote'] as const)(
    'validates native schema and engine on %s',
    async (transport) => {
      const { registry, session } = fixture()
      for (const settings of [
        { approvalsReviewer: 'auto_review' },
        { permissionMode: 'auto' },
        { sandboxPolicy: { type: 'dangerFullAccess' } },
        { reset: true, approvalPolicy: 'never' },
        { effort: '' }
      ])
        await expect(
          registry.dispatch(
            'session:codex-settings',
            transport,
            ['native-root', settings],
            hostConnection()
          )
        ).rejects.toThrow('Unsupported')
      await registry.dispatch(
        'session:codex-settings',
        transport,
        ['native-root', { effort: 'ultra' }],
        hostConnection()
      )
      expect(session.setCodexSettings).toHaveBeenCalledExactlyOnceWith({ effort: 'ultra' })
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
    }
  )
})

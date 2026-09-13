import type { CommandRegistration } from './command-registry'
import type { SessionManager } from '../services/session-manager'
import { codexAuthProvider } from '../auth/CodexAuthProvider'
import type { CodexApprovalDecision } from '../../shared/codex-types'

export const CODEX_CHANNELS = ['session:codex-approval', 'codex:auth-status'] as const

export function codexCommands(
  manager: SessionManager
): Array<Omit<CommandRegistration, 'transport'>> {
  const session = (id: unknown) => {
    if (typeof id !== 'string' || !id || id.length > 512)
      throw new Error('Invalid Codex routing ID')
    const current = manager.get(id)
    if (current?.engineId !== 'codex') throw new Error('Command requires a live Codex session')
    return current
  }
  return [
    {
      channel: 'session:codex-approval',
      capability: 'chat',
      kind: 'command',
      sessionIdArg: 0,
      handler: (id: string, requestId: string, decision: CodexApprovalDecision) => {
        const current = session(id)
        if (
          typeof requestId !== 'string' ||
          requestId.length > 4096 ||
          !['accept', 'acceptForSession', 'decline', 'cancel'].includes(decision)
        )
          throw new Error('Invalid native approval reply')
        if (!current.resolveCodexApproval) throw new Error('Native approvals are unavailable')
        current.resolveCodexApproval(requestId, decision)
      }
    },
    {
      // Availability + model count only. The IDENTITY comes from the vault now
      // (ADR-068 §1) and is read through `provider-account:list`; the native
      // device-code channels this family used to carry are deleted with the UI.
      channel: 'codex:auth-status',
      capability: 'config',
      kind: 'query',
      handler: () => codexAuthProvider.status()
    }
  ]
}

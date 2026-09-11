import type { CommandRegistration } from './command-registry'
import type { SessionManager } from '../services/session-manager'
import { codexAuthProvider } from '../auth/CodexAuthProvider'
import { parseCodexSettings } from '../codex/settings'
import type { CodexApprovalDecision } from '../../shared/codex-types'

export const CODEX_CHANNELS = [
  'session:codex-settings',
  'session:codex-approval',
  'codex:auth-status',
  'codex:login-start',
  'codex:login-status',
  'codex:login-cancel'
] as const

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
      channel: 'session:codex-settings',
      capability: 'session-config',
      kind: 'command',
      sessionIdArg: 0,
      handler: async (id: string, settings: unknown) => {
        const current = session(id)
        if (!current.setCodexSettings) throw new Error('Native settings are unavailable')
        await current.setCodexSettings(parseCodexSettings(settings))
      }
    },
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
      channel: 'codex:auth-status',
      capability: 'config',
      kind: 'query',
      handler: () => codexAuthProvider.status()
    },
    {
      channel: 'codex:login-start',
      capability: 'config',
      kind: 'command',
      handler: () => codexAuthProvider.loginStart()
    },
    {
      channel: 'codex:login-status',
      capability: 'config',
      kind: 'query',
      handler: () => codexAuthProvider.loginStatus()
    },
    {
      channel: 'codex:login-cancel',
      capability: 'config',
      kind: 'command',
      handler: () => codexAuthProvider.loginCancel()
    }
  ]
}

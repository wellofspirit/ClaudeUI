import { homedir } from 'node:os'
import type { CommandRegistration } from './command-registry'
import type { SessionManager } from '../services/session-manager'
import { codexAuthProvider } from '../auth/CodexAuthProvider'
import { readCodexConfig, writeCodexConfig } from '../codex/codex-config'
import { collectClaudeMcpForCodex } from '../codex/codex-mcp-bridge'
import { codexRulesStatus, syncCodexRulesFile } from '../codex/rules-sync'
import type {
  CodexApprovalDecision,
  CodexConfigEdit,
  CodexConfigRead,
  CodexRulesStatus
} from '../../shared/codex-types'

export const CODEX_CHANNELS = [
  'session:codex-approval',
  'codex:auth-status',
  // ADR-068 §6 / Slice 5a. Codex's own `config.toml` is read and written through
  // the app-server, never parsed here; these two are the whole surface the
  // Engines › Codex page writes through, and `codex:recompile-rules` is the one
  // action on its Managed group.
  'codex-config:read',
  'codex-config:write',
  'codex:recompile-rules'
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
    },
    {
      // The Codex page's ONE read. Never throws: an absent binary or a broken
      // app-server is a STATE the page renders (the pi/opencode self-gating row
      // convention), not an error dialog.
      channel: 'codex-config:read',
      capability: 'config',
      kind: 'query',
      handler: async (): Promise<CodexConfigRead> => {
        const rules = codexRulesStatus()
        // USER scope, like the rule compiler: the page edits the user layer, so
        // the count it shows must not depend on which working directory happens
        // to be open.
        const collected = collectClaudeMcpForCodex(homedir())
        const mcp = { inherited: Object.keys(collected.servers).sort(), skipped: collected.skipped }
        try {
          return { config: await readCodexConfig(), rules, mcp }
        } catch (error) {
          return {
            config: null,
            rules,
            mcp,
            error: error instanceof Error ? error.message : 'Codex configuration is unavailable'
          }
        }
      }
    },
    {
      channel: 'codex-config:write',
      capability: 'config',
      kind: 'command',
      handler: (edits: CodexConfigEdit[], expectedVersion: string) => {
        // Perimeter validation: the key path is what addresses a TOML table, so
        // a non-string or an empty one must be refused before it reaches the
        // binary, and the batch is bounded so one call cannot be turned into an
        // unbounded rewrite of the user's file.
        if (!Array.isArray(edits) || edits.length === 0 || edits.length > 64)
          throw new Error('Invalid Codex config edit batch')
        for (const edit of edits) {
          if (
            !edit ||
            typeof edit !== 'object' ||
            typeof edit.keyPath !== 'string' ||
            edit.keyPath.length === 0 ||
            edit.keyPath.length > 512
          )
            throw new Error('Invalid Codex config key path')
        }
        if (typeof expectedVersion !== 'string' || expectedVersion.length === 0)
          throw new Error('Invalid Codex config version')
        return writeCodexConfig(edits, expectedVersion)
      }
    },
    {
      // Recompiles `$CODEX_HOME/rules/claudeui.rules` from the user's Claude
      // Bash rules and answers the fresh status. Forced: the reason to press
      // the button is that the file on disk is not what ClaudeUI wrote.
      channel: 'codex:recompile-rules',
      capability: 'config',
      kind: 'command',
      handler: (): CodexRulesStatus => {
        syncCodexRulesFile({ force: true })
        return codexRulesStatus()
      }
    }
  ]
}

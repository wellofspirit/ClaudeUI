/**
 * Which engine's tool names an approval's `toolName` is spelled in, and what to call it.
 *
 * A dispatch target's forwarded ask (ADR-033) carries the TARGET's tool name behind a
 * `dispatch:` prefix and names the target in `agent.subagentType` (`dispatch:<engine>`); every
 * other ask is spelled in the session's own engine. The card and the OS notification both
 * show the display name, never the wire spelling (`mcp__claude-ui-collab__dispatch_agent`,
 * `dispatch:hand_back`).
 */
import { ENGINE_META } from '../../../../../shared/engine-meta'
import { firstPartyDisplayName } from '../../../../../shared/first-party-tool-names'
import type { EngineId, PendingApproval } from '../../../../../shared/types'
import { engineToolMap } from './engine-tool-maps'

/** The ask's tool name without the dispatch forward's `dispatch:` prefix. */
export function wireAction(approval: Pick<PendingApproval, 'toolName'>): string {
  return approval.toolName.replace(/^dispatch:/, '')
}

/** The engine whose tool map reads this ask: the dispatched target's, else the session's. */
export function approvalEngine(
  approval: { agent?: { subagentType?: string } },
  sessionEngine: EngineId
): EngineId {
  const dispatched = approval.agent?.subagentType?.match(/^dispatch:(\w+)$/)?.[1]
  return dispatched && Object.hasOwn(ENGINE_META, dispatched)
    ? (dispatched as EngineId)
    : sessionEngine
}

/**
 * A third-party MCP tool as `server / tool`, from Claude's rule vocabulary `mcp__<server>__<tool>`
 * (the server ends at the FIRST `__` after the prefix: a tool name can contain `__`, a server's
 * cannot). Null for any other spelling.
 */
function thirdPartyMcpName(wire: string): string | null {
  if (!wire.startsWith('mcp__')) return null
  const rest = wire.slice('mcp__'.length)
  const cut = rest.indexOf('__')
  if (cut <= 0 || cut + 2 >= rest.length) return null
  return `${rest.slice(0, cut)} / ${rest.slice(cut + 2)}`
}

/**
 * The ask's action as a person reads it ("X-Agent", "Session · message", "Bash"). A first-party
 * tool takes its friendly label; a third-party MCP tool reads `server / tool` on every engine,
 * because an approval must say which tool it allows.
 */
export function approvalActionName(
  approval: { toolName: string; agent?: { subagentType?: string } },
  sessionEngine: EngineId
): string {
  const wire = wireAction(approval)
  const name = engineToolMap(approvalEngine(approval, sessionEngine)).displayName(wire)
  if (name !== wire && name !== 'MCP') return name
  // Whatever the engine's map made of it, ClaudeUI's own tools keep their labels.
  return firstPartyDisplayName(wire, 'mcp') ?? thirdPartyMcpName(wire) ?? name
}

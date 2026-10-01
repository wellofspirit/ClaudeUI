/**
 * Where host-run pi subagents' sessions live, and how a parent session finds
 * and removes them (ADR-088 §persistence).
 *
 * Every child is one directory, `~/.claude/ui/pi-subagents/<agentId>/`,
 * holding the child's appended system prompt (`system-prompt.md`) and pi's own
 * session file (`<ISO-ts>_<agentId>.jsonl`, written lazily once the first
 * assistant message exists — probe P1). Outside `~/.pi` on purpose: the
 * sidebar lists only `~/.pi/agent/sessions`, so a child is never shown (or
 * resumed) as a session of its own.
 *
 * The parent's link to a child is the `agent` tool result's
 * `details.cuiAgent.agentId`, which pi persists on the toolResult entry. That
 * id is model-influenced data read back from disk, so it is validated as a
 * uuid v4 BEFORE it ever reaches a `path.join` (no traversal through it).
 *
 * A leaf (fs/os/path, pi-protocol types, pi-delivery): pi-session-list.ts and
 * pi-subagents.ts import it, never the other way round.
 */
import { promises as fsp, readdirSync } from 'fs'
import { homedir } from 'os'
import path from 'path'
import type { PiSessionEntry } from './pi-protocol'
import { piAgentDeliveryDetails } from './pi-delivery'

/** `~/.claude/ui/pi-subagents` (the same per-user `~/.claude/ui` root the vault and the bridge use). */
export function piSubagentSessionsRoot(): string {
  return path.join(homedir(), '.claude', 'ui', 'pi-subagents')
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** A uuid v4 (what the manager mints); anything else is rejected before any path is built. */
export function isValidAgentId(id: unknown): id is string {
  return typeof id === 'string' && UUID_V4.test(id)
}

/** The child's session file (`*_<agentId>.jsonl` in its dir), or null. Never throws. */
export function childSessionFile(
  agentId: string,
  root: string = piSubagentSessionsRoot()
): string | null {
  if (!isValidAgentId(agentId)) return null
  const dir = path.join(root, agentId)
  try {
    const suffix = `_${agentId}.jsonl`
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(suffix))
      .sort()
    // One per child; should a resume ever have written a second, the newest
    // (ISO-timestamp prefix) is the live one.
    const file = files[files.length - 1]
    return file ? path.join(dir, file) : null
  } catch {
    return null
  }
}

/** One parent `agent` call and the child it ran. */
export interface PiAgentLink {
  /** The parent's `agent` tool call id — the key the child's messages render under. */
  toolUseId: string
  agentId: string
}

/** Every `agent` toolResult in `entries` whose `details.cuiAgent.agentId` is a valid id, in order. */
export function collectAgentIds(entries: readonly PiSessionEntry[]): PiAgentLink[] {
  const links: PiAgentLink[] = []
  for (const e of entries) {
    if (e.type !== 'message' || e.message.role !== 'toolResult') continue
    if (e.message.toolName !== 'agent') continue
    const cui = (e.message.details as { cuiAgent?: { agentId?: unknown } } | undefined)?.cuiAgent
    if (!isValidAgentId(cui?.agentId)) continue
    links.push({ toolUseId: e.message.toolCallId, agentId: cui.agentId })
  }
  return links
}

/** A depth-1 agent as the parent's history tells it (ADR-088 S3b, G7: the record rebuild). */
export interface PiAgentLinkRecord {
  agentId: string
  originToolUseId: string
  subagentType: string
  name?: string
  description?: string
  model?: string
  background?: boolean
  /** The last task notification's status for that call, else the tool result's own. */
  status?: string
  stoppedBy?: 'user' | 'agent' | 'interrupt' | 'dispose' | null
}

const STOP_REASONS = new Set(['user', 'agent', 'interrupt', 'dispose'])

/**
 * The parent's own `agent` links with what a resume needs: the host-written
 * `details.cuiAgent` of each toolResult, then the last task notification for
 * that call (its `details`, never its text — pi-delivery.ts). Only the
 * parent's entries: these are depth-1 agents (nested records are not rebuilt).
 */
export function collectAgentLinkRecords(entries: readonly PiSessionEntry[]): PiAgentLinkRecord[] {
  const byCall = new Map<string, PiAgentLinkRecord>()
  const s = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
  for (const e of entries) {
    if (e.type === 'message' && e.message.role === 'toolResult' && e.message.toolName === 'agent') {
      const cui = (e.message.details as { cuiAgent?: Record<string, unknown> } | undefined)
        ?.cuiAgent
      if (!cui || !isValidAgentId(cui.agentId) || typeof cui.subagentType !== 'string') continue
      const stoppedBy = s(cui.stoppedBy)
      byCall.set(e.message.toolCallId, {
        agentId: cui.agentId,
        originToolUseId: e.message.toolCallId,
        subagentType: cui.subagentType,
        ...(s(cui.name) ? { name: s(cui.name) } : {}),
        ...(s(cui.description) ? { description: s(cui.description) } : {}),
        ...(s(cui.model) ? { model: s(cui.model) } : {}),
        background: cui.background === true,
        ...(s(cui.status) ? { status: s(cui.status) } : {}),
        stoppedBy:
          stoppedBy && STOP_REASONS.has(stoppedBy)
            ? (stoppedBy as PiAgentLinkRecord['stoppedBy'])
            : null
      })
    } else if (e.type === 'custom_message') {
      const d = piAgentDeliveryDetails(e.customType, e.details)
      if (!d || d.kind !== 'task-notification') continue
      const link = byCall.get(d.toolUseId)
      if (!link || link.agentId !== d.agentId) continue
      link.status = typeof d.status === 'string' ? d.status : link.status
      link.stoppedBy =
        typeof d.stoppedBy === 'string' && STOP_REASONS.has(d.stoppedBy) ? d.stoppedBy : null
    }
  }
  return [...byCall.values()]
}

/**
 * Remove one child: its session file(s) and `system-prompt.md`, each by name,
 * then the (now empty) dir. Never recursive, never throws.
 */
export async function deleteChildSession(
  agentId: string,
  root: string = piSubagentSessionsRoot()
): Promise<void> {
  if (!isValidAgentId(agentId)) return
  const dir = path.join(root, agentId)
  let names: string[]
  try {
    names = await fsp.readdir(dir)
  } catch {
    return
  }
  const suffix = `_${agentId}.jsonl`
  for (const name of names) {
    if (name !== 'system-prompt.md' && !name.endsWith(suffix)) continue
    try {
      await fsp.unlink(path.join(dir, name))
    } catch {
      // Best-effort; the rmdir below then simply fails.
    }
  }
  try {
    await fsp.rmdir(dir)
  } catch {
    // Not empty (something we did not create) or already gone — leave it.
  }
}

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
 * A leaf (fs/os/path + pi-protocol types): pi-session-list.ts and
 * pi-subagents.ts import it, never the other way round.
 */
import { promises as fsp, readdirSync } from 'fs'
import { homedir } from 'os'
import path from 'path'
import type { PiSessionEntry } from './pi-protocol'

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

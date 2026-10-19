/**
 * Who made a tool call: the session's root agent, or a subagent below it.
 *
 * `canUseTool` carries `agentId`, but a mode that approves everything never calls
 * it, and an in-process MCP tool's `tools/call` carries only cli.js's
 * `claudecode/toolUseId`. So the session tools attribute a call from the stream:
 * cli.js writes the assistant frame holding a tool_use block before it runs the
 * tool, and a subagent's frames carry `parent_tool_use_id` / `agent_id`. This map
 * is filled from every inbound frame as it is read off the wire (ahead of the
 * session's own message loop, so it keeps stream order) and from `canUseTool`.
 *
 * A call that cannot be attributed is not guessed at: {@link ToolUseOwners.ownerOf}
 * waits briefly for the frame and then answers `unknown`, which the session tools
 * treat as a refusal.
 */

export type ToolCallOwner = 'root' | 'subagent' | 'unknown'

/** Longest wait for a frame that trails the tool call. */
export const OWNER_WAIT_MS = 250
const POLL_MS = 10
/** Entries kept; the oldest go first. A turn makes dozens of calls, not thousands. */
const MAX_ENTRIES = 4000

export class ToolUseOwners {
  /** tool_use id → is it a subagent's? */
  private readonly owners = new Map<string, boolean>()

  /**
   * Remember who owns a tool_use id. A subagent verdict is final: a later "root"
   * for the same id (a frame without the markers) never lifts it.
   */
  note(toolUseId: string, subagent: boolean): void {
    const known = this.owners.get(toolUseId)
    if (known === true) return
    this.owners.set(toolUseId, subagent)
    if (this.owners.size > MAX_ENTRIES) {
      this.owners.delete(this.owners.keys().next().value as string)
    }
  }

  /** Read an inbound stream frame for the tool_use blocks it announces. */
  noteFrame(frame: Record<string, unknown>): void {
    const subagent = !!frame.parent_tool_use_id || !!frame.agent_id || !!frame.teammate_id
    if (frame.type === 'assistant') {
      const content = (frame.message as { content?: unknown } | undefined)?.content
      if (!Array.isArray(content)) return
      for (const block of content) {
        const b = block as { type?: string; id?: unknown }
        if (b?.type === 'tool_use' && typeof b.id === 'string') this.note(b.id, subagent)
      }
    } else if (frame.type === 'stream_event') {
      const event = frame.event as
        { type?: string; content_block?: { type?: string; id?: unknown } } | undefined
      const block = event?.content_block
      if (event?.type === 'content_block_start' && block?.type === 'tool_use') {
        if (typeof block.id === 'string') this.note(block.id, subagent)
      }
    }
  }

  /** Who made this call, waiting up to `waitMs` for the frame that says. */
  async ownerOf(toolUseId: string | undefined, waitMs = OWNER_WAIT_MS): Promise<ToolCallOwner> {
    if (!toolUseId) return 'unknown'
    const deadline = Date.now() + waitMs
    for (;;) {
      const known = this.owners.get(toolUseId)
      if (known !== undefined) return known ? 'subagent' : 'root'
      if (Date.now() >= deadline) return 'unknown'
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
  }
}

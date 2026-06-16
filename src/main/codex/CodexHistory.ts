/**
 * Codex thread history loader.
 *
 * Spawns a short-lived codex app-server process via withCodexAppServer,
 * calls thread/read with includeTurns:true, maps the returned turns →
 * ChatMessage[], then kills the process.
 *
 * Used by the session:load-codex-history IPC handler as the Codex-side
 * alternative to parseSessionHistory (which reads Claude JSONL transcripts).
 *
 * Design notes:
 * - Does NOT set CODEX_HOME — forcing $HOME breaks auth (see memory note).
 * - Times out after 15 s if the process hangs or the server never responds.
 * - Always kills the child process via withCodexAppServer's finally block.
 * - Maps a subset of V2ThreadItem types to ChatMessage[]:
 *     userMessage       → role:'user' text block
 *     agentMessage      → role:'assistant' text block
 *     reasoning         → role:'assistant' thinking block
 *     commandExecution  → tool_use + tool_result pair (Shell)
 *     fileChange        → tool_use + tool_result pair (ApplyPatch)
 *     mcpToolCall       → tool_use + tool_result pair (server·tool)
 *     dynamicToolCall   → tool_use + tool_result pair (DynamicTool)
 *     other             → skipped (plan, hookPrompt, subAgentActivity, etc.)
 */

import { randomUUID } from 'node:crypto'
import { withCodexAppServer } from './codexQuery'
import type { ChatMessage, ContentBlock } from '../../shared/types'
import { logger } from '../services/logger'

// ---------------------------------------------------------------------------
// Item → ChatMessage mapping helpers
// ---------------------------------------------------------------------------

/** Map a userMessage item to a role:'user' ChatMessage. */
function mapUserMessage(item: Record<string, unknown>): ChatMessage {
  const itemId = typeof item.id === 'string' ? item.id : randomUUID()
  const content: ContentBlock[] = []
  const rawContent = item.content
  if (Array.isArray(rawContent)) {
    for (const c of rawContent) {
      const ci = c as Record<string, unknown>
      if (ci.type === 'text' && typeof ci.text === 'string') {
        content.push({ type: 'text', text: ci.text })
      }
      // image inputs could be added here in the future
    }
  }
  if (content.length === 0) content.push({ type: 'text', text: '' })
  return { id: itemId, role: 'user', content, timestamp: Date.now() }
}

/** Map an agentMessage item to a role:'assistant' text ChatMessage. */
function mapAgentMessage(item: Record<string, unknown>): ChatMessage {
  const itemId = typeof item.id === 'string' ? item.id : randomUUID()
  const text = typeof item.text === 'string' ? item.text : ''
  return {
    id: itemId,
    role: 'assistant',
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
  }
}

/** Map a reasoning item to a role:'assistant' thinking ChatMessage. */
function mapReasoningItem(item: Record<string, unknown>): ChatMessage {
  const itemId = typeof item.id === 'string' ? item.id : randomUUID()
  // reasoning.content is an array of strings in V2ThreadItem
  const parts = Array.isArray(item.content)
    ? (item.content as unknown[]).filter((s) => typeof s === 'string').join('\n')
    : ''
  return {
    id: itemId,
    role: 'assistant',
    content: [{ type: 'thinking', text: parts }],
    timestamp: Date.now(),
  }
}

/**
 * Map a tool item (commandExecution / fileChange / mcpToolCall / dynamicToolCall)
 * into a SINGLE role:'assistant' ChatMessage carrying both the tool_use block
 * and its tool_result block (same toolUseId, in that order).
 *
 * This matches how ClaudeUI represents tool results everywhere else:
 *   - Claude's JSONL parser pushes the tool_result block INTO the assistant
 *     message that holds the matching tool_use (session-history.ts ~756-778).
 *   - The live store does the same via appendToolResult.
 *   - MessageBubble pairs tool_use+tool_result by toolUseId within one assistant
 *     message; a standalone role:'user' message holding only a tool_result block
 *     renders as an empty bubble with no tool-card output.
 */
function mapToolItem(item: Record<string, unknown>): ChatMessage {
  const itemId = typeof item.id === 'string' ? item.id : randomUUID()
  const itemType = typeof item.type === 'string' ? item.type : 'unknown'

  // Derive tool name (same mapping as mapCodexEvent.ts's itemTypeToToolName)
  let toolName: string
  switch (itemType) {
    case 'commandExecution':
      toolName = 'Shell'
      break
    case 'fileChange':
      toolName = 'ApplyPatch'
      break
    case 'mcpToolCall':
      // Compound server·tool name mirrors live-session behaviour
      toolName =
        item.server && item.tool
          ? `${String(item.server)}·${String(item.tool)}`
          : 'McpTool'
      break
    case 'dynamicToolCall':
      toolName = typeof item.tool === 'string' ? item.tool : 'DynamicTool'
      break
    default:
      toolName = 'CodexTool'
  }

  // Build toolInput summary
  const toolInput: Record<string, unknown> = {}
  if (typeof item.command === 'string') toolInput.command = item.command
  if (typeof item.path === 'string') toolInput.path = item.path
  if (typeof item.query === 'string') toolInput.query = item.query
  if (typeof item.server === 'string') toolInput.server = item.server
  if (typeof item.tool === 'string') toolInput.tool = item.tool
  if (item.arguments !== undefined) toolInput.arguments = item.arguments

  // Derive tool result text
  const status = typeof item.status === 'string' ? item.status : ''
  const isError = status === 'failed' || status === 'declined' || status === 'error'

  let result = ''
  if (typeof item.aggregatedOutput === 'string' && item.aggregatedOutput.trim()) {
    result = item.aggregatedOutput
  } else if (typeof item.result === 'string') {
    result = item.result
  } else if (item.result !== undefined) {
    result = JSON.stringify(item.result)
  } else if (Array.isArray(item.changes)) {
    result = `Applied ${item.changes.length} change(s)`
  } else if (item.error !== undefined) {
    const e = item.error as Record<string, unknown> | null
    result = e && typeof e.message === 'string' ? e.message : JSON.stringify(e)
  } else {
    result = isError ? 'Failed' : 'Done'
  }

  return {
    id: itemId,
    role: 'assistant',
    content: [
      { type: 'tool_use', toolUseId: itemId, toolName, toolInput },
      { type: 'tool_result', toolUseId: itemId, toolResult: result, isError },
    ],
    timestamp: Date.now(),
  }
}

/** Map a single V2ThreadItem to zero or more ChatMessages. */
function mapThreadItem(item: Record<string, unknown>): ChatMessage[] {
  const itemType = typeof item.type === 'string' ? item.type : ''
  switch (itemType) {
    case 'userMessage':
      return [mapUserMessage(item)]
    case 'agentMessage':
      return [mapAgentMessage(item)]
    case 'reasoning':
      return [mapReasoningItem(item)]
    case 'commandExecution':
    case 'fileChange':
    case 'mcpToolCall':
    case 'dynamicToolCall':
      return [mapToolItem(item)]
    default:
      // plan, hookPrompt, subAgentActivity, webSearch, imageView, etc. — skip
      return []
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CodexHistoryResult {
  messages: ChatMessage[]
}

/**
 * Load the message history for a Codex thread by spawning a short-lived
 * app-server process and calling thread/read.
 *
 * @param threadId  The Codex thread UUID (= the session's persisted sessionId).
 * @param cwd       Working directory for the app-server spawn.
 * @param timeoutMs How long to wait for the process + RPC (default: 15 s).
 */
export async function loadCodexHistory(
  threadId: string,
  cwd: string,
  timeoutMs = 15_000
): Promise<CodexHistoryResult> {
  logger.debug('CodexHistory', `loading thread ${threadId}`)

  const response = await withCodexAppServer(
    cwd,
    (client) =>
      client.request('thread/read', {
        threadId,
        includeTurns: true,
      }),
    timeoutMs
  )

  // Map turns → ChatMessage[]
  const messages: ChatMessage[] = []
  const turns = response.thread?.turns ?? []
  for (const turn of turns) {
    const items = turn.items ?? []
    for (const item of items) {
      const mapped = mapThreadItem(item as Record<string, unknown>)
      messages.push(...mapped)
    }
  }

  logger.debug(
    'CodexHistory',
    `loaded ${messages.length} messages from ${turns.length} turns for thread ${threadId}`
  )

  return { messages }
}

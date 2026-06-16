/**
 * Pure mapping module: Codex app-server notifications → session:* IPC payloads.
 *
 * All functions here are pure (or near-pure with a small mutable assembly
 * state) so they can be unit-tested with canned frames without any process.
 * CodexSession wires client notifications to this mapper → this.send(...).
 *
 * Deliberately avoids Claude-specific tool names that trigger special UI paths
 * (Bash, Agent, Task, TodoWrite, ExitPlanMode, AskUserQuestion).
 */

import type { ChatMessage, ContentBlock, SessionResult, StatusLineData } from '../../shared/types'
import type { ServerNotificationParamsByMethod } from './protocol/methods'

// ---------------------------------------------------------------------------
// Assembly state (per-turn, mutable)
// ---------------------------------------------------------------------------

/**
 * Lightweight mutable state maintained across notifications within a single
 * turn. CodexSession creates one of these per turn.
 */
export interface CodexAssemblyState {
  /** Accumulated agentMessage text per item (for the final agentMessage emit). */
  itemText: Map<string, string>
  /**
   * Accumulated commandExecution output per item. Buffered (not streamed into
   * the assistant prose) so it lands in the tool-result/tool card on
   * item/completed, falling back to this when `aggregatedOutput` is absent.
   */
  commandOutput: Map<string, string>
  /** Start time (epoch ms) for the current turn — used in SessionResult. */
  turnStartMs: number
  /** Total tokens seen across the session (persists across turns). */
  totalInputTokens: number
  totalOutputTokens: number
  cachedInputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
}

export function makeAssemblyState(): CodexAssemblyState {
  return {
    itemText: new Map(),
    commandOutput: new Map(),
    turnStartMs: Date.now(),
    totalInputTokens: 0,
    totalOutputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  }
}

// ---------------------------------------------------------------------------
// Emitted event shapes
// ---------------------------------------------------------------------------

export type SessionStreamPayload = { type: 'text' | 'thinking'; text: string }
export type SessionToolResultPayload = { toolUseId: string; result: string; isError: boolean }

/** One or more IPC emissions produced by a single notification. */
export interface MappedEmissions {
  stream?: SessionStreamPayload
  message?: ChatMessage
  toolResult?: SessionToolResultPayload
  statusLine?: StatusLineData
  result?: SessionResult
  /** 'error' | 'warning' | null */
  alertKind?: 'error' | 'warning'
  alertText?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeToolUseChatMessage(
  itemId: string,
  toolName: string,
  toolInput: Record<string, unknown>
): ChatMessage {
  const block: ContentBlock = {
    type: 'tool_use',
    toolUseId: itemId,
    toolName,
    toolInput,
  }
  return {
    id: itemId,
    role: 'assistant',
    content: [block],
    timestamp: Date.now(),
  }
}

function makeTextChatMessage(itemId: string, text: string): ChatMessage {
  return {
    id: itemId,
    role: 'assistant',
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
  }
}

/**
 * Map a ThreadItem type string to a human-readable tool name that does NOT
 * collide with Claude-specific tool names (Bash, Agent, Task, TodoWrite, etc.).
 */
function itemTypeToToolName(itemType: string): string {
  switch (itemType) {
    case 'commandExecution':
      return 'Shell'
    case 'fileChange':
      return 'ApplyPatch'
    case 'mcpToolCall':
      return 'McpTool'
    case 'dynamicToolCall':
      return 'DynamicTool'
    case 'webSearch':
      return 'WebSearch'
    default:
      return 'CodexTool'
  }
}

/**
 * Extract a human-readable detail from an item (command, title, path, etc.)
 * for use as a toolInput field.
 */
function itemToToolInput(item: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  if (typeof item.command === 'string') result.command = item.command
  if (typeof item.title === 'string') result.title = item.title
  if (typeof item.path === 'string') result.path = item.path
  if (typeof item.query === 'string') result.query = item.query
  if (typeof item.server === 'string') result.server = item.server
  if (typeof item.tool === 'string') result.tool = item.tool
  // For mcpToolCall, combine server·tool into a compound tool name
  if (item.server && item.tool) {
    result.tool = `${item.server}·${item.tool}`
  }
  if (item.arguments !== undefined) result.arguments = item.arguments
  return result
}

/**
 * Extract tool output from a completed item (aggregatedOutput, result, etc.).
 *
 * `fallbackOutput` is the buffered commandExecution stdout/stderr accumulated
 * from outputDelta notifications; it is used only when the item itself carries
 * no `aggregatedOutput`, so streamed command output still reaches the tool card.
 */
function itemToToolOutput(
  item: Record<string, unknown>,
  fallbackOutput?: string
): { result: string; isError: boolean } {
  const status = typeof item.status === 'string' ? item.status : ''
  const isError = status === 'failed' || status === 'declined' || status === 'error'

  // Try various output fields in priority order
  if (typeof item.aggregatedOutput === 'string' && item.aggregatedOutput.trim()) {
    return { result: item.aggregatedOutput, isError }
  }
  if (fallbackOutput && fallbackOutput.trim()) {
    return { result: fallbackOutput, isError }
  }
  if (item.result !== undefined) {
    const r = typeof item.result === 'string' ? item.result : JSON.stringify(item.result)
    return { result: r, isError }
  }
  if (item.changes !== undefined) {
    const changes = item.changes as Array<unknown>
    return { result: `Applied ${Array.isArray(changes) ? changes.length : '?'} change(s)`, isError }
  }
  if (item.error !== undefined) {
    const e = item.error as Record<string, unknown> | null
    const msg = (e && typeof e.message === 'string') ? e.message : JSON.stringify(e)
    return { result: msg, isError: true }
  }
  return { result: isError ? 'Failed' : 'Done', isError }
}

// ---------------------------------------------------------------------------
// Public mapping functions
// ---------------------------------------------------------------------------

/**
 * Map item/agentMessage/delta → session:stream {type:'text'}
 */
export function mapAgentMessageDelta(
  params: ServerNotificationParamsByMethod['item/agentMessage/delta'],
  state: CodexAssemblyState
): MappedEmissions {
  const text = params.delta ?? ''
  // Accumulate for later final message
  const prev = state.itemText.get(params.itemId) ?? ''
  state.itemText.set(params.itemId, prev + text)
  return { stream: { type: 'text', text } }
}

/**
 * Map item/reasoning/textDelta → session:stream {type:'thinking'}
 */
export function mapReasoningTextDelta(
  params: ServerNotificationParamsByMethod['item/reasoning/textDelta'],
  _state: CodexAssemblyState
): MappedEmissions {
  return { stream: { type: 'thinking', text: params.delta ?? '' } }
}

/**
 * Map item/reasoning/summaryTextDelta → session:stream {type:'thinking'}
 */
export function mapReasoningSummaryTextDelta(
  params: ServerNotificationParamsByMethod['item/reasoning/summaryTextDelta'],
  _state: CodexAssemblyState
): MappedEmissions {
  return { stream: { type: 'thinking', text: params.delta ?? '' } }
}

/**
 * Map item/commandExecution/outputDelta — buffer the output keyed by itemId.
 * Emits NOTHING: command stdout/stderr belongs in the tool card (tool-result),
 * not the assistant prose bubble. The accumulated buffer is consumed by
 * mapItemCompleted when the item's `aggregatedOutput` is absent.
 */
export function mapCommandExecutionOutputDelta(
  params: ServerNotificationParamsByMethod['item/commandExecution/outputDelta'],
  state: CodexAssemblyState
): MappedEmissions {
  const prev = state.commandOutput.get(params.itemId) ?? ''
  state.commandOutput.set(params.itemId, prev + (params.delta ?? ''))
  return {}
}

/**
 * Map item/started notification.
 * - userMessage → suppress
 * - agentMessage → suppress (streaming builds it incrementally)
 * - commandExecution / fileChange / mcpToolCall / etc. → tool_use ChatMessage
 */
export function mapItemStarted(
  params: ServerNotificationParamsByMethod['item/started'],
  _state: CodexAssemblyState
): MappedEmissions {
  const item = params.item as Record<string, unknown>
  const itemType = typeof item.type === 'string' ? item.type : ''
  const itemId = typeof item.id === 'string' ? item.id : ''

  // Suppress user messages and agent messages (streaming handles the latter)
  if (itemType === 'userMessage' || itemType === 'agentMessage' || itemType === 'reasoning') {
    return {}
  }

  const toolName = itemTypeToToolName(itemType)
  const toolInput = itemToToolInput(item)

  // For mcpToolCall, override toolName with server·tool compound
  const finalToolName =
    itemType === 'mcpToolCall' && item.server && item.tool
      ? `${String(item.server)}·${String(item.tool)}`
      : toolName

  return { message: makeToolUseChatMessage(itemId, finalToolName, toolInput) }
}

/**
 * Map item/completed notification.
 * - userMessage → suppress
 * - agentMessage → final ChatMessage (text block, clears streaming)
 * - commandExecution / fileChange / mcpToolCall / etc. → tool-result
 */
export function mapItemCompleted(
  params: ServerNotificationParamsByMethod['item/completed'],
  state: CodexAssemblyState
): MappedEmissions {
  const item = params.item as Record<string, unknown>
  const itemType = typeof item.type === 'string' ? item.type : ''
  const itemId = typeof item.id === 'string' ? item.id : ''

  if (itemType === 'userMessage') {
    return {} // suppress
  }

  if (itemType === 'agentMessage') {
    // Emit the final assembled text; store upserts by id, clearing streamingText
    const accumulated = state.itemText.get(itemId) ?? (typeof item.text === 'string' ? item.text : '')
    state.itemText.delete(itemId)
    return { message: makeTextChatMessage(itemId, accumulated) }
  }

  // All other item types → tool-result. For commandExecution, fall back to the
  // buffered output deltas when the item carries no aggregatedOutput, then
  // release the buffer.
  const fallbackOutput = state.commandOutput.get(itemId)
  const { result, isError } = itemToToolOutput(item, fallbackOutput)
  if (fallbackOutput !== undefined) state.commandOutput.delete(itemId)
  return { toolResult: { toolUseId: itemId, result, isError } }
}

/**
 * Map thread/tokenUsage/updated → session:status-line
 */
export function mapTokenUsageUpdated(
  params: ServerNotificationParamsByMethod['thread/tokenUsage/updated'],
  state: CodexAssemblyState
): MappedEmissions {
  const usage = params.tokenUsage
  if (!usage) return {}

  // Accumulate totals into session state
  if (usage.last) {
    if (typeof usage.last.inputTokens === 'number') state.totalInputTokens += usage.last.inputTokens
    if (typeof usage.last.outputTokens === 'number') state.totalOutputTokens += usage.last.outputTokens
    if (typeof usage.last.cachedInputTokens === 'number') state.cachedInputTokens += usage.last.cachedInputTokens
    if (typeof usage.last.reasoningOutputTokens === 'number') state.reasoningOutputTokens += usage.last.reasoningOutputTokens
  }
  if (usage.total && typeof usage.total.totalTokens === 'number') {
    state.totalTokens = usage.total.totalTokens
  }

  const contextWindow = typeof usage.modelContextWindow === 'number' ? usage.modelContextWindow : 0

  const statusLine: StatusLineData = {
    totalCostUsd: 0, // Codex doesn't report USD cost
    totalDurationMs: Date.now() - state.turnStartMs,
    totalApiDurationMs: 0,
    totalInputTokens: state.totalInputTokens,
    totalOutputTokens: state.totalOutputTokens,
    cachedTokens: state.cachedInputTokens,
    totalTokens: state.totalTokens,
    contextWindowSize: contextWindow,
    usedPercentage: contextWindow > 0 ? (state.totalTokens / contextWindow) * 100 : null,
    remainingPercentage: contextWindow > 0 ? ((contextWindow - state.totalTokens) / contextWindow) * 100 : null,
  }

  return { statusLine }
}

/**
 * Map turn/completed → session:result + appropriate status
 */
export function mapTurnCompleted(
  params: ServerNotificationParamsByMethod['turn/completed'],
  state: CodexAssemblyState
): MappedEmissions {
  const turn = params.turn
  const status = typeof turn?.status === 'string' ? turn.status : 'completed'
  const error = turn?.error as { message?: string } | null | undefined

  const sessionResult: SessionResult = {
    totalCostUsd: 0,
    durationMs: Date.now() - state.turnStartMs,
    result: status,
    sessionId: null,
  }

  if (status === 'failed' && error?.message) {
    return {
      result: sessionResult,
      alertKind: 'error',
      alertText: error.message,
    }
  }

  return { result: sessionResult }
}

/**
 * Map error notification → session:warning or session:error
 */
export function mapErrorNotification(
  params: ServerNotificationParamsByMethod['error'],
  _state: CodexAssemblyState
): MappedEmissions {
  const message = params.error?.message ?? 'Unknown Codex error'
  const willRetry = typeof params.willRetry === 'boolean' ? params.willRetry : false

  return {
    alertKind: willRetry ? 'warning' : 'error',
    alertText: message,
  }
}

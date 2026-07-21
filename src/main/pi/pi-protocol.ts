/**
 * Hand-written minimal TS types for the pi `--mode rpc` wire protocol — only
 * the shapes ClaudeUI actually consumes. No runtime code: every export below
 * is a type/interface declared directly in this file, not a re-export.
 *
 * Sources (all version-pinned to package.json#piCliVersion, verified against
 * the real binary — see docs/protocol-pi/README.md for the M0 probe notes):
 *   - vendor/pi-cli/docs/rpc.md            — commands, responses, events
 *   - vendor/pi-cli/docs/session-format.md — on-disk session entry shapes
 *
 * Verified doc drift (v0.80.10 — docs/protocol-pi/README.md "Verified doc
 * drift" section):
 *   1. AssistantMessage.usage additionally carries `reasoning` + `totalTokens`.
 *   2. get_commands entries carry `sourceInfo` rather than flat path/location
 *      (see `PiCommandSourceInfo` below — wired in M2b).
 *   3. get_state with no configured model returns a placeholder Model object
 *      (`id/name/api/provider === "unknown"`), never `null`.
 */

// ---------------------------------------------------------------------------
// RPC command/response envelope (rpc.md "Protocol Overview" + "Error Handling")
// ---------------------------------------------------------------------------

/** Outgoing command. `id` is optional on the wire; PiRpcClient always assigns one. */
export interface PiRpcCommand {
  id?: string
  type: string
  [key: string]: unknown
}

/** `{type:"response", id?, command, success, data?, error?}` — one per request. */
export interface PiRpcResponse<T = unknown> {
  type: 'response'
  id?: string
  command: string
  success: boolean
  data?: T
  error?: string
}

// ---------------------------------------------------------------------------
// Model (rpc.md "Model" type — get_state.data.model / get_available_models.data.models / set_model.data)
// ---------------------------------------------------------------------------

export interface PiModel {
  id: string
  name: string
  api: string
  provider: string
  baseUrl: string
  reasoning: boolean
  /** e.g. ['text'] or ['text','image'] */
  input: string[]
  contextWindow: number
  maxTokens: number
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
  /**
   * Verified probe (2026-07-20, real binary): `get_available_models` carries
   * this per model. KEYS are the higher/edge thinking levels the model
   * recognizes (identity-mapped unless remapped, e.g. `minimal:'low'` =
   * "minimal is treated as low"). A model supports `xhigh` iff `'xhigh'` is a
   * key; supports `max` iff `'max'` is a key — see model-discovery.ts's
   * `effortLevelsFromModel`, the single derivation site. Optional: older/other
   * providers may omit it, and non-reasoning models carry no meaningful map.
   */
  thinkingLevelMap?: Record<string, string>
}

export interface PiGetStateData {
  /** Placeholder object (id/name/api/provider === 'unknown') when unconfigured — verified doc drift #3, never null. */
  model: PiModel
  thinkingLevel: string
  isStreaming: boolean
  isCompacting?: boolean
  sessionFile?: string
  sessionId?: string
  sessionName?: string
  messageCount?: number
  pendingMessageCount?: number
}

export interface PiGetAvailableModelsData {
  models: PiModel[]
}

export interface PiGetSessionStatsData {
  sessionFile?: string
  sessionId?: string
  cost: number
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
  // contextUsage intentionally omitted — unused in M1
}

/**
 * `get_last_assistant_text` (ADR-033 M4c — the cross-engine dispatch TARGET's
 * simplest reliable way to get a turn's final text, vs. accumulating `message`
 * MapperOutputs across the turn). Doc says `{"text": null}` when no assistant
 * messages exist yet; VERIFIED DOC DRIFT (M4c probe against v0.80.10): the
 * real response is `data: {}` (the `text` key is entirely ABSENT, not `null`)
 * in that case — callers must read `data?.text` defensively either way.
 */
export interface PiGetLastAssistantTextData {
  text?: string | null
}

// ---------------------------------------------------------------------------
// get_commands (rpc.md "get_commands" — M2b)
// ---------------------------------------------------------------------------

/**
 * Verified doc drift (docs/protocol-pi/README.md "Verified doc drift" #2):
 * entries carry `sourceInfo`, NOT the documented flat `path`/`location` fields.
 */
export interface PiCommandSourceInfo {
  path?: string
  source?: string
  scope?: string
  origin?: string
}

export interface PiCommandEntry {
  name: string
  description?: string
  source: 'extension' | 'prompt' | 'skill'
  sourceInfo?: PiCommandSourceInfo
}

export interface PiGetCommandsData {
  commands: PiCommandEntry[]
}

// ---------------------------------------------------------------------------
// Content blocks (session-format.md "Content Blocks")
// ---------------------------------------------------------------------------

export interface PiTextContent {
  type: 'text'
  text: string
}

export interface PiImageContent {
  type: 'image'
  /** base64-encoded */
  data: string
  mimeType: string
}

export interface PiThinkingContent {
  type: 'thinking'
  thinking: string
}

export interface PiToolCallContent {
  type: 'toolCall'
  id: string
  name: string
  arguments: Record<string, unknown>
}

export type PiAssistantContentBlock =
  | PiTextContent
  | PiThinkingContent
  | PiToolCallContent

// ---------------------------------------------------------------------------
// Messages (rpc.md "Types" + session-format.md "Base/Extended Message Types")
// ---------------------------------------------------------------------------

export interface PiUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** Verified doc drift #1 (v0.80.10) — rides the wire despite the shipped docs omitting it. */
  reasoning?: number
  /** Verified doc drift #1 (v0.80.10). */
  totalTokens?: number
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
}

export interface PiUserMessage {
  role: 'user'
  content: string | Array<PiTextContent | PiImageContent>
  timestamp: number
}

export type PiStopReason = 'stop' | 'length' | 'toolUse' | 'error' | 'aborted'

export interface PiAssistantMessage {
  role: 'assistant'
  content: PiAssistantContentBlock[]
  api: string
  provider: string
  model: string
  usage: PiUsage
  stopReason: PiStopReason
  errorMessage?: string
  timestamp: number
}

export interface PiToolResultMessage {
  role: 'toolResult'
  toolCallId: string
  toolName: string
  content: Array<PiTextContent | PiImageContent>
  /** Tool-specific metadata. edit's shape: `{diff, patch, firstChangedLine?}` (verified
   *  against pinned source `packages/coding-agent/src/core/tools/edit.ts`). */
  details?: { diff?: string; patch?: string; firstChangedLine?: number; [key: string]: unknown }
  isError: boolean
  timestamp: number
}

/**
 * `tool_execution_update.partialResult` shape (rpc.md "tool_execution_start /
 * tool_execution_update / tool_execution_end", verified) — the SAME
 * `{content, details}` shape a `PiToolResultMessage` carries, but ACCUMULATED
 * (replace-not-append) rather than final. `details` is loosely typed (only
 * `truncation`/`fullOutputPath` are documented; unconsumed in M2b).
 */
export interface PiToolExecutionPartialResult {
  content: Array<PiTextContent | PiImageContent>
  details?: { truncation?: unknown; fullOutputPath?: string | null; [key: string]: unknown }
}

export interface PiBashExecutionMessage {
  role: 'bashExecution'
  command: string
  output: string
  exitCode?: number
  cancelled: boolean
  truncated: boolean
  fullOutputPath?: string
  excludeFromContext?: boolean
  timestamp: number
}

/** AgentMessage union — custom/branchSummary/compactionSummary omitted (not consumed in M1). */
export type PiAgentMessage =
  | PiUserMessage
  | PiAssistantMessage
  | PiToolResultMessage
  | PiBashExecutionMessage

// ---------------------------------------------------------------------------
// Events (rpc.md "Events" — verified sequence in docs/protocol-pi/README.md)
// ---------------------------------------------------------------------------

export type PiAssistantStreamEventType =
  | 'start'
  | 'text_start'
  | 'text_delta'
  | 'text_end'
  | 'thinking_start'
  | 'thinking_delta'
  | 'thinking_end'
  | 'toolcall_start'
  | 'toolcall_delta'
  | 'toolcall_end'
  | 'done'
  | 'error'

export interface PiAssistantMessageEvent {
  type: PiAssistantStreamEventType
  contentIndex?: number
  delta?: string
  content?: string
  toolCall?: PiToolCallContent
  /** 'stop'|'length'|'toolUse' for `done`; 'aborted'|'error' for `error`. */
  reason?: string
  partial?: PiAssistantMessage
}

export interface PiCompactionResult {
  summary: string
  firstKeptEntryId: string
  tokensBefore: number
  estimatedTokensAfter: number
  details?: unknown
}

export type PiEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end'; messages: PiAgentMessage[]; willRetry: boolean }
  | { type: 'agent_settled' }
  | { type: 'turn_start' }
  | { type: 'turn_end'; message: PiAgentMessage; toolResults: PiToolResultMessage[] }
  | { type: 'message_start'; message: PiAgentMessage }
  | { type: 'message_update'; message: PiAgentMessage; assistantMessageEvent: PiAssistantMessageEvent }
  | { type: 'message_end'; message: PiAgentMessage }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | {
      type: 'tool_execution_update'
      toolCallId: string
      toolName: string
      args: Record<string, unknown>
      partialResult: PiToolExecutionPartialResult
    }
  | { type: 'tool_execution_end'; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: 'queue_update'; steering: string[]; followUp: string[] }
  | { type: 'compaction_start'; reason: 'manual' | 'threshold' | 'overflow' }
  | {
      type: 'compaction_end'
      reason: 'manual' | 'threshold' | 'overflow'
      result: PiCompactionResult | null
      aborted: boolean
      willRetry: boolean
      errorMessage?: string
    }
  | { type: 'auto_retry_start'; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: 'auto_retry_end'; success: boolean; attempt: number; finalError?: string }
  | { type: 'extension_error'; extensionPath: string; event: string; error: string }
  // Extension UI dialog request (M2 — the ClaudeUI approval bridge). Typed loosely;
  // M2 will narrow this when the bridge extension lands.
  | { type: 'extension_ui_request'; [key: string]: unknown }
  // Forward-compat catch-all so an unrecognised future event type still parses
  // as valid JSON input to the mapper (which maps it to `ignore`) instead of
  // being rejected by the type system.
  | { type: string; [key: string]: unknown }

// ---------------------------------------------------------------------------
// Session file entries (session-format.md "Entry Types")
// ---------------------------------------------------------------------------

export interface PiSessionHeader {
  type: 'session'
  version: number
  id: string
  timestamp: string
  cwd: string
  parentSession?: string
}

interface PiSessionEntryBase {
  id: string
  parentId: string | null
  timestamp: string
}

export type PiSessionEntry =
  | (PiSessionEntryBase & { type: 'message'; message: PiAgentMessage })
  | (PiSessionEntryBase & { type: 'model_change'; provider: string; modelId: string })
  | (PiSessionEntryBase & { type: 'thinking_level_change'; thinkingLevel: string })
  | (PiSessionEntryBase & {
      type: 'compaction'
      summary: string
      firstKeptEntryId: string
      tokensBefore: number
      details?: unknown
      fromHook?: boolean
    })
  | (PiSessionEntryBase & {
      type: 'branch_summary'
      fromId: string
      summary: string
      details?: unknown
      fromHook?: boolean
    })
  | (PiSessionEntryBase & { type: 'session_info'; name: string })
  | (PiSessionEntryBase & { type: 'label'; targetId: string; label?: string })
  | (PiSessionEntryBase & { type: 'custom'; customType: string; data?: unknown })
  | (PiSessionEntryBase & {
      type: 'custom_message'
      customType: string
      content: string | Array<PiTextContent | PiImageContent>
      display: boolean
      details?: unknown
    })

/**
 * Pure event mapper: `mapPiEvent(ev, state)` turns one pi RPC event into zero
 * or more engine-neutral `PiMapperOutput`s. Mirrors `src/main/opencode/event-mapper.ts`'s
 * shape (pure function, caller-owned state) with one difference: pi's events
 * carry NO stable message id and are strictly sequential per process (pi has
 * no server/subagent-interleaving concept in M1), so `state` only needs a
 * single in-flight message slot rather than a Map of accumulators.
 *
 * Event order relied on (verified — docs/protocol-pi/README.md):
 *   agent_start → turn_start → message_start(assistant) → message_update* →
 *   message_end(assistant) → tool_execution_* → message_end(role=toolResult) →
 *   turn_end → … → agent_end → agent_settled (the real turn-complete signal).
 */
import { v4 as uuid } from 'uuid'
import type { ChatMessage, ContentBlock, FileDiff } from '../../shared/types'
import type { PiAgentMessage, PiAssistantContentBlock, PiEvent, PiToolExecutionPartialResult } from './pi-protocol'

// ---------------------------------------------------------------------------
// Caller-owned state
// ---------------------------------------------------------------------------

export interface PiMapperState {
  /** Set on assistant message_start; cleared once its message_end lands. Lets
   *  message_update/message_end reuse the same synthesized ChatMessage id —
   *  pi's wire events carry no stable message id of their own. */
  currentMessageId: string | null
  /** Wall-clock run start (ms), set by the caller (PiSession) when a prompt is
   *  sent; read at agent_settled to compute `result.durationMs`. */
  startTimeMs: number
  /** Running total cost across assistant message_end events seen on THIS
   *  client-process lifetime (mirrors opencode's totalCostUsd ref). Reported
   *  verbatim in the `result` output — PiSession adds its seeded historical
   *  base on top when reporting totalCostUsd to the renderer (mirrors
   *  OpencodeSession's costBaseUsd/liveTotalCostUsd split). */
  totalCostUsd: number
  /** The pi backend's own session id (from `get_state`), set by the caller
   *  once known. Echoed verbatim into the `result` output at agent_settled. */
  sessionId: string | null
}

export function createPiMapperState(): PiMapperState {
  return { currentMessageId: null, startTimeMs: 0, totalCostUsd: 0, sessionId: null }
}

// ---------------------------------------------------------------------------
// Mapper output union
// ---------------------------------------------------------------------------

export interface PiUsageTokens {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** Reasoning/thinking tokens — mirrors opencode's MessageTokens.reasoning slot. */
  reasoning?: number
}

/**
 * One agent's status snapshot within a `subagent` tool's `cuiSubagent`
 * details payload (M5b — pi-subagent-source.ts's OWN streaming contract, not
 * the vendored example's `makeDetails`). `newMessages` is a DELTA — only the
 * child's raw pi messages appended since the PREVIOUS update for this exact
 * agent slot — so PiSession never needs to dedupe against what it already
 * forwarded as `session:subagent-message`/`session:subagent-tool-result`.
 */
export interface PiSubagentAgentUpdate {
  agent: string
  model?: string
  status: 'running' | 'done' | 'error'
  newMessages: PiAgentMessage[]
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number }
}

export interface PiSubagentUpdatePayload {
  v: 1
  agents: PiSubagentAgentUpdate[]
}

export type PiMapperOutput =
  | { kind: 'stream'; streamType: 'text' | 'thinking'; delta: string; messageId: string }
  | { kind: 'message'; message: ChatMessage }
  | { kind: 'tool_result'; toolUseId: string; result: string; isError: boolean; fileDiffs?: FileDiff[] }
  | { kind: 'usage'; provider: string; modelId: string; tokens: PiUsageTokens; costUsd: number; messageId: string }
  | { kind: 'result'; totalCostUsd: number; durationMs: number; sessionId: string | null }
  | { kind: 'error'; message: string }
  | { kind: 'bash_output'; toolUseId: string; output: string }
  // M5b — in-pi subagents (pi-subagent-source.ts). Carries the `subagent`
  // tool's `cuiSubagent` details, validated (never a raw pass-through of
  // extension-supplied data — see parseCuiSubagentPayload).
  | { kind: 'subagent_update'; toolUseId: string; payload: PiSubagentUpdatePayload }
  | { kind: 'ignore' }

// ---------------------------------------------------------------------------
// Mapper
// ---------------------------------------------------------------------------

/**
 * Pure function: map a single pi RPC event to zero or more MapperOutputs.
 * `state` is mutated in place (message-id bookkeeping, running cost total) —
 * "pure" here means no I/O and no hidden side channel, matching
 * opencode/event-mapper.ts's identical contract with its `accumulators` Map.
 */
export function mapPiEvent(ev: PiEvent, state: PiMapperState): PiMapperOutput[] {
  switch (ev.type) {
    case 'message_start': {
      const msg = (ev as Extract<PiEvent, { type: 'message_start' }>).message
      if (msg.role === 'assistant') {
        state.currentMessageId = uuid()
      }
      // user/bashExecution (and any other role) → ignore: the renderer already
      // renders the user's prompt optimistically; bashExecution messages never
      // reach the live event stream anyway (README.md "Behavior gotchas").
      return [{ kind: 'ignore' }]
    }

    case 'message_update': {
      const { message, assistantMessageEvent } = ev as Extract<PiEvent, { type: 'message_update' }>
      const messageId = ensureMessageId(state)

      if (assistantMessageEvent.type === 'text_delta' || assistantMessageEvent.type === 'thinking_delta') {
        const delta = assistantMessageEvent.delta ?? ''
        if (!delta) return [{ kind: 'ignore' }]
        return [
          {
            kind: 'stream',
            streamType: assistantMessageEvent.type === 'text_delta' ? 'text' : 'thinking',
            delta,
            messageId
          }
        ]
      }

      if (assistantMessageEvent.type === 'toolcall_end') {
        // The partial assistant message already carries everything generated
        // so far (including the just-completed tool call) — no per-part
        // accumulator needed, unlike opencode. Upsert-by-id makes this safe
        // to emit repeatedly (once per completed tool call in the turn).
        const content = message.role === 'assistant' ? message.content : []
        return [{ kind: 'message', message: buildPiChatMessage(messageId, content) }]
      }

      // start/text_start/text_end/thinking_start/thinking_end/toolcall_start/
      // toolcall_delta/done/error: no visible output needed in M1 — text/thinking
      // rendering is driven purely by the `stream` deltas above, and the terminal
      // state (success or error/aborted) is fully captured by the following
      // message_end event's stopReason.
      return [{ kind: 'ignore' }]
    }

    case 'message_end': {
      const msg = (ev as Extract<PiEvent, { type: 'message_end' }>).message

      if (msg.role === 'assistant') {
        const messageId = ensureMessageId(state)
        state.currentMessageId = null

        const message = buildPiChatMessage(messageId, msg.content)
        const cost = msg.usage.cost.total
        state.totalCostUsd += cost

        const outputs: PiMapperOutput[] = [
          { kind: 'message', message },
          {
            kind: 'usage',
            provider: msg.provider,
            modelId: msg.model,
            tokens: {
              input: msg.usage.input,
              output: msg.usage.output,
              cacheRead: msg.usage.cacheRead,
              cacheWrite: msg.usage.cacheWrite,
              ...(msg.usage.reasoning != null ? { reasoning: msg.usage.reasoning } : {})
            },
            costUsd: cost,
            messageId
          }
        ]
        return outputs
      }

      if (msg.role === 'toolResult') {
        const result = msg.content
          .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
          .map((b) => b.text)
          .join('')
        // M2: rich diff — pi's `edit` tool result carries a ready-made unified
        // diff at msg.details.patch, but (unlike opencode's apply_patch/edit)
        // it carries NO file path of its own (verified against pinned source
        // packages/coding-agent/src/core/tools/edit.ts — EditToolDetails is
        // `{diff, patch, firstChangedLine?}`, no path/file field). Resolving it
        // requires threading the ORIGINAL toolCall's `arguments.path` through
        // from the assistant message that preceded this toolResult, which this
        // pure per-event mapper doesn't have in scope. Deferred to M2;
        // PiEngineToolMap's fileEdit normalize falls back to path + empty
        // before/after (generic JSON view) until then.
        const outputs: PiMapperOutput[] = [{ kind: 'tool_result', toolUseId: msg.toolCallId, result, isError: msg.isError }]

        // M5b — the subagent tool's FINAL return `{content, details}` lands
        // here as this toolResult's `msg.details` (same carrier PiToolResultMessage
        // already uses for edit's diff/patch) rather than through another
        // `tool_execution_update` — the LAST live update during execution
        // already went out that path (see the `tool_execution_update` case
        // below); this covers the terminal one the model actually sees.
        if (msg.toolName === 'subagent') {
          const payload = parseCuiSubagentPayload(msg.details?.cuiSubagent)
          if (payload) outputs.push({ kind: 'subagent_update', toolUseId: msg.toolCallId, payload })
        }
        return outputs
      }

      // user/bashExecution message_end never occurs per the verified event
      // order (only assistant gets a message_start/end pair; toolResult only
      // gets message_end) — defensive ignore for forward-compat.
      return [{ kind: 'ignore' }]
    }

    case 'compaction_end': {
      const { result } = ev as Extract<PiEvent, { type: 'compaction_end' }>
      if (!result) return [{ kind: 'ignore' }] // aborted or failed — nothing to show
      const firstLine = result.summary.split('\n')[0] ?? ''
      const message: ChatMessage = {
        id: uuid(),
        role: 'system',
        content: [{ type: 'compact_separator', text: firstLine }],
        timestamp: Date.now()
      }
      return [{ kind: 'message', message }]
    }

    case 'agent_settled': {
      return [
        {
          kind: 'result',
          totalCostUsd: state.totalCostUsd,
          // startTimeMs === 0 means the caller never set it (e.g. a settle
          // with no preceding run() — shouldn't happen, but Date.now() - 0
          // would otherwise report a multi-decade "duration") — report 0
          // rather than a bogus near-epoch span.
          durationMs: state.startTimeMs > 0 ? Math.max(0, Date.now() - state.startTimeMs) : 0,
          sessionId: state.sessionId
        }
      ]
    }

    case 'extension_error': {
      const { error } = ev as Extract<PiEvent, { type: 'extension_error' }>
      return [{ kind: 'error', message: error }]
    }

    case 'tool_execution_update': {
      // Live bash output streaming (M2b) — mirrors opencode's live tool
      // output pattern (src/main/opencode/event-mapper.ts's own
      // state.metadata.output handling): only the `bash` tool republishes a
      // meaningful ACCUMULATED text preview here; every other tool's
      // partialResult (or one carrying no text content) is not surfaced in
      // M2b. Caller (PiSession) decides whether/how to throttle via
      // BashStreamGate — this mapper only extracts the text, unconditionally.
      const { toolCallId, toolName, partialResult } = ev as Extract<
        PiEvent,
        { type: 'tool_execution_update' }
      >
      // M5b — in-pi subagents (pi-subagent-source.ts): the `subagent` tool's
      // onUpdate({details: {cuiSubagent}}) payload surfaces VERBATIM as this
      // ACCUMULATED partialResult.details (probed wire fact, M5b kickoff spec)
      // — validated defensively (extension-supplied data) before ever
      // reaching PiSession; a malformed/absent shape is silently ignored
      // rather than crashing the mapper.
      if (toolName === 'subagent') {
        const payload = parseCuiSubagentPayload(partialResult?.details?.cuiSubagent)
        if (!payload) return [{ kind: 'ignore' }]
        return [{ kind: 'subagent_update', toolUseId: toolCallId, payload }]
      }
      if (toolName !== 'bash') return [{ kind: 'ignore' }]
      return [{ kind: 'bash_output', toolUseId: toolCallId, output: extractPartialResultText(partialResult) }]
    }

    // agent_start/agent_end, turn_start/turn_end, tool_execution_start/end
    // (start carries nothing new — the arguments are already in the
    // toolcall_end message_update above; end is fully covered by the
    // following toolResult message_end), queue_update, compaction_start,
    // auto_retry_*, extension_ui_request (M2), and any unrecognised future
    // event type.
    default:
      return [{ kind: 'ignore' }]
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get the in-flight message id, minting (and storing) one defensively if a
 *  message_start was somehow missed — keeps the upsert-by-id contract intact
 *  for any events that follow. */
function ensureMessageId(state: PiMapperState): string {
  if (!state.currentMessageId) state.currentMessageId = uuid()
  return state.currentMessageId
}

/**
 * Join the text blocks of a `tool_execution_update.partialResult` (the same
 * `{content: [{type,text}]}` shape as a toolResult message's content — see
 * the toolResult branch of `message_end` above). Non-text blocks (images) are
 * dropped; a malformed/empty shape yields ''.
 */
function extractPartialResultText(partialResult: PiToolExecutionPartialResult): string {
  if (!partialResult || !Array.isArray(partialResult.content)) return ''
  return partialResult.content
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

/**
 * Validate an unknown value as a `cuiSubagent` details payload (M5b) —
 * `v === 1` and a well-formed `agents` array, each entry with a string
 * `agent`, a recognized `status`, and a `newMessages` array (usage/model are
 * optional). Returns null on ANY structural mismatch — the mapper must never
 * crash on extension-supplied data (pi-subagent-source.ts is ClaudeUI's own
 * code today, but this boundary is treated as untrusted wire input, same
 * posture as every other partialResult/details field this file parses).
 */
function parseCuiSubagentPayload(value: unknown): PiSubagentUpdatePayload | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (v.v !== 1 || !Array.isArray(v.agents)) return null

  const agents: PiSubagentAgentUpdate[] = []
  for (const entry of v.agents) {
    if (!entry || typeof entry !== 'object') return null
    const e = entry as Record<string, unknown>
    if (typeof e.agent !== 'string') return null
    if (e.status !== 'running' && e.status !== 'done' && e.status !== 'error') return null
    if (!Array.isArray(e.newMessages)) return null
    agents.push({
      agent: e.agent,
      model: typeof e.model === 'string' ? e.model : undefined,
      status: e.status,
      newMessages: e.newMessages as PiAgentMessage[],
      usage: isPiSubagentUsage(e.usage) ? e.usage : undefined
    })
  }
  return { v: 1, agents }
}

function isPiSubagentUsage(
  value: unknown
): value is { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number } {
  if (!value || typeof value !== 'object') return false
  const u = value as Record<string, unknown>
  return (
    typeof u.input === 'number' &&
    typeof u.output === 'number' &&
    typeof u.cacheRead === 'number' &&
    typeof u.cacheWrite === 'number' &&
    typeof u.cost === 'number' &&
    typeof u.turns === 'number'
  )
}

/**
 * Map pi's AssistantMessage content blocks to ClaudeUI's ContentBlock[].
 * text → text, thinking → thinking (NOTE: wire field is `thinking`, not `text`),
 * toolCall → tool_use { toolUseId: id, toolName: name, toolInput: arguments }.
 */
export function buildPiChatMessage(messageId: string, content: PiAssistantContentBlock[]): ChatMessage {
  const blocks: ContentBlock[] = content.map((block): ContentBlock => {
    if (block.type === 'text') return { type: 'text', text: block.text }
    if (block.type === 'thinking') return { type: 'thinking', text: block.thinking }
    return {
      type: 'tool_use',
      toolUseId: block.id,
      toolName: block.name,
      toolInput: block.arguments
    }
  })
  return {
    id: messageId,
    role: 'assistant',
    content: blocks,
    timestamp: Date.now()
  }
}

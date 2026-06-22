import { v4 as uuid } from 'uuid'
import type { OpencodeEvent, QuestionInfo } from './protocol/types'
import type { ChatMessage, ContentBlock, PendingApproval, SessionResult, AskUserQuestion } from '../../shared/types'
import { suggestOpencodeAllowRule } from './permission-compiler'

// Phase 6: the 5c tool-name normalization hack (OPENCODE_TOOL_NAME_MAP /
// normalizeOpencodeToolName, which rewrote the hosted-tools plugin names to the
// canonical `mcp__claude-ui*` forms) is RETIRED. tool_use blocks now carry the
// engine's RAW tool name (e.g. `bash`, `render_mermaid`); the renderer's
// kind-keyed registry (OpencodeEngineToolMap.kindOf) maps them to diagram/mockup/
// command/etc. and the engine-agnostic kind bodies render them.

// ── Part accumulator ─────────────────────────────────────────────────────────

/**
 * Token counts as reported by opencode's message.updated info.tokens.
 * All fields are optional — opencode may not populate all of them.
 */
export interface MessageTokens {
  input?: number
  output?: number
  /** Reasoning/thinking tokens (maps to a cache-write slot in billing) */
  reasoning?: number
  cache?: {
    read?: number
    write?: number
  }
}

/**
 * Live state for an in-progress assistant message.
 * Parts arrive as snapshots (upsert by part.id).
 */
export interface MessageAccumulator {
  messageId: string
  /** Role of the message (from `message.updated`'s `info.role`). Defaults to
   *  'assistant' until a `message.updated` records it. opencode emits
   *  `message.part.updated` for the USER's own text too — we must not render
   *  those as assistant bubbles. */
  role?: 'user' | 'assistant' | 'system'
  /** Latest cumulative cost snapshot for this message (`info.cost`). opencode
   *  re-emits `message.updated` multiple times per turn with a CUMULATIVE cost,
   *  so we store-not-add and sum across messages to get the turn total. */
  cost?: number
  /** Latest cumulative token snapshot for this message (`info.tokens`). Same
   *  cumulative semantics as cost — store, do not add. */
  tokens?: MessageTokens
  /** Ordered part ids for block ordering. */
  partOrder: string[]
  /** Current snapshot per part.id */
  parts: Map<string, PartSnapshot>
}

export interface PartSnapshot {
  type: string
  text?: string
  toolName?: string
  callID?: string
  state?: ToolPartState
}

export interface ToolPartState {
  status?: string
  input?: Record<string, unknown>
  output?: string
  metadata?: Record<string, unknown>
  title?: string
}

// ── Mapper output types ───────────────────────────────────────────────────────

export type MapperOutput =
  | { kind: 'stream'; streamType: 'text' | 'thinking'; delta: string; messageId?: string }
  | { kind: 'message'; message: ChatMessage }
  | { kind: 'tool_result'; toolUseId: string; result: string; isError: boolean }
  | { kind: 'approval'; approval: PendingApproval }
  | { kind: 'result'; result: Pick<SessionResult, 'totalCostUsd' | 'durationMs' | 'result'> & { sessionId: string | null } }
  | { kind: 'cost_update'; totalCostUsd: number; messageId: string; tokens?: MessageTokens; engineCostUsd?: number }
  | { kind: 'error'; message: string }
  | { kind: 'ignore' }

// ── Mapper ────────────────────────────────────────────────────────────────────

/**
 * Pure function: map a single opencode SSE event to a MapperOutput.
 *
 * Stateful: `accumulators` is a Map keyed by messageId (the `msg_…` id from
 * message.updated / part.updated). The caller owns the map and passes it on
 * every call so this module stays pure and unit-testable.
 *
 * Cross-session filter: returns `{ kind: 'ignore' }` when the event's
 * `properties.sessionID` does not match `ownSessionId`.
 */
export function mapEvent(
  ev: OpencodeEvent,
  ownSessionId: string,
  accumulators: Map<string, MessageAccumulator>,
  startTimeMs: number,
  totalCostUsd: { value: number }
): MapperOutput {
  const props = ev.properties as Record<string, unknown>

  // Cross-session filter — CRITICAL: the shared server streams all sessions in the cwd
  const eventSessionId = props.sessionID as string | undefined
  if (eventSessionId && eventSessionId !== ownSessionId) {
    return { kind: 'ignore' }
  }

  switch (ev.type) {
    case 'message.part.delta': {
      const messageId = props.messageID as string | undefined
      const field = props.field as string | undefined
      const delta = props.delta as string | undefined
      if (!delta || (field !== 'text' && field !== 'reasoning')) return { kind: 'ignore' }
      // peek at the accumulator to know the part type; default to text
      let streamType: 'text' | 'thinking' = 'text'
      if (messageId) {
        const acc = accumulators.get(messageId)
        if (acc) {
          const partId = props.partID as string | undefined
          if (partId) {
            const snap = acc.parts.get(partId)
            if (snap?.type === 'reasoning') streamType = 'thinking'
          }
        }
      }
      return { kind: 'stream', streamType, delta, messageId }
    }

    case 'message.part.updated': {
      const part = props.part as Record<string, unknown> | undefined
      if (!part) return { kind: 'ignore' }

      const partId = part.id as string | undefined
      const messageId = (part.messageID ?? part.messageId) as string | undefined
      if (!partId || !messageId) return { kind: 'ignore' }

      const acc = ensureAccumulator(accumulators, messageId)
      const isNew = !acc.parts.has(partId)
      if (isNew) acc.partOrder.push(partId)

      const partType = part.type as string
      const snap: PartSnapshot = { type: partType }

      if (partType === 'text' || partType === 'reasoning') {
        snap.text = (part.text as string) ?? ''
      } else if (partType === 'tool') {
        snap.toolName = part.tool as string
        snap.callID = part.callID as string
        const state = part.state as ToolPartState | undefined
        snap.state = state
      }
      acc.parts.set(partId, snap)

      // opencode emits part.updated for the USER's own text part too. The
      // user message is already rendered optimistically by the renderer, so
      // skip user-role messages here. `message.updated` (carrying info.role)
      // always arrives before the message's part.updated, so acc.role is set.
      if (acc.role === 'user') return { kind: 'ignore' }

      // Build the ChatMessage from current accumulator state
      const message = buildChatMessage(messageId, acc)

      return { kind: 'message', message }
    }

    case 'permission.asked': {
      const id = props.id as string | undefined
      const permission = props.permission as string | undefined
      const tool = props.tool as { messageID?: string; callID?: string } | undefined
      if (!id || !permission) return { kind: 'ignore' }

      // Offer an "always allow" suggestion (Claude addRules form) so the dialog
      // can persist a rule for this tool/pattern. patterns carries the matched
      // argument(s) (command / path / subagent type). See ADR-022 write-back.
      const patterns = props.patterns as string[] | undefined
      const suggestion = suggestOpencodeAllowRule(permission, patterns)

      const approval: PendingApproval = {
        requestId: id,
        toolUseId: tool?.callID,
        toolName: permission,
        input: (props.metadata as Record<string, unknown>) ?? {},
        ...(suggestion ? { suggestions: [suggestion] } : {})
      }
      return { kind: 'approval', approval }
    }

    case 'session.idle': {
      const durationMs = Date.now() - startTimeMs
      return {
        kind: 'result',
        result: {
          totalCostUsd: totalCostUsd.value,
          durationMs,
          result: '',
          sessionId: ownSessionId
        }
      }
    }

    case 'session.error': {
      // Map opencode session.error → session:error.
      // ProviderAuthError surfaces as a re-login hint so the user knows to re-auth.
      // Wire shape (verified vs 1.17.9 /doc): properties.error =
      //   { name: 'ProviderAuthError'|'UnknownError'|…, data: { providerID?, message } }
      const err = props.error as { name?: string; data?: Record<string, unknown> } | undefined
      const name = err?.name
      const data = err?.data ?? {}
      let errorMsg: string
      if (name === 'ProviderAuthError') {
        const vendor = (data.providerID as string | undefined) ?? ''
        errorMsg = vendor
          ? `Authentication required for ${vendor}. Re-authorize in Settings › Vendors or run \`opencode auth login\` in a terminal.`
          : 'Authentication required. Re-authorize in Settings › Vendors or run `opencode auth login` in a terminal.'
      } else {
        errorMsg = (data.message as string | undefined) ?? 'An error occurred'
      }
      return { kind: 'error', message: errorMsg }
    }

    case 'message.updated': {
      const info = props.info as Record<string, unknown> | undefined
      if (!info) return { kind: 'ignore' }

      const infoId = (info.id as string | undefined) ?? messageIdFromProps(props)
      if (!infoId) return { kind: 'ignore' }

      const acc = ensureAccumulator(accumulators, infoId)

      // Record role FIRST (before any early-return) so part.updated can gate
      // on it. opencode always emits message.updated before that message's
      // part.updated.
      const role = info.role as 'user' | 'assistant' | 'system' | undefined
      if (role === 'user' || role === 'assistant' || role === 'system') acc.role = role

      // info.tokens is a per-message CUMULATIVE snapshot (store, do not add).
      // Shape (from opencode 1.17.9 /doc): { input, output, reasoning, cache: { read, write } }
      const rawTokens = info.tokens as Record<string, unknown> | undefined
      if (rawTokens) {
        const cacheRaw = rawTokens.cache as Record<string, unknown> | undefined
        acc.tokens = {
          input: typeof rawTokens.input === 'number' ? rawTokens.input : undefined,
          output: typeof rawTokens.output === 'number' ? rawTokens.output : undefined,
          reasoning: typeof rawTokens.reasoning === 'number' ? rawTokens.reasoning : undefined,
          cache: cacheRaw
            ? {
                read: typeof cacheRaw.read === 'number' ? cacheRaw.read : undefined,
                write: typeof cacheRaw.write === 'number' ? cacheRaw.write : undefined
              }
            : undefined
        }
      }

      // info.cost is a per-message CUMULATIVE snapshot that re-emits multiple
      // times per turn. Store (not add) it on the accumulator, then sum across
      // all messages so the turn total is correct and never double-counts.
      const cost = info.cost as number | undefined
      if (typeof cost === 'number') {
        const prev = acc.cost ?? 0
        acc.cost = cost
        if (cost !== prev) {
          totalCostUsd.value = sumAccumulatorCosts(accumulators)
          return {
            kind: 'cost_update',
            totalCostUsd: totalCostUsd.value,
            messageId: infoId,
            tokens: acc.tokens,
            engineCostUsd: cost
          }
        }
      }
      return { kind: 'ignore' }
    }

    case 'question.asked': {
      // The model is asking the user a structured question (opencode's analog of
      // Claude's AskUserQuestion tool). This is BLOCKING — the model suspends
      // until we reply or reject; an unanswered question hangs the turn.
      // Map to a PendingApproval with toolName:'AskUserQuestion' so the existing
      // AskUserQuestionBlock UI handles it engine-neutrally.
      const id = props.id as string | undefined
      const rawQuestions = props.questions as QuestionInfo[] | undefined
      const tool = props.tool as { messageID?: string; callID?: string } | undefined
      if (!id || !rawQuestions) return { kind: 'ignore' }

      const questions: AskUserQuestion[] = rawQuestions.map((q) => ({
        question: q.question,
        header: q.header,
        options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description })),
        multiSelect: !!q.multiple
      }))

      const approval: PendingApproval = {
        requestId: id,
        toolUseId: tool?.callID,
        toolName: 'AskUserQuestion',
        input: { questions }
      }
      return { kind: 'approval', approval }
    }

    case 'question.replied':
    case 'question.rejected':
      // Ack events — we originate the reply/reject from resolveApproval; the
      // server echo is redundant for a single client. Ignore silently.
      return { kind: 'ignore' }

    case 'command.executed':
      // Informational — the command's output has already streamed via the normal
      // message.updated / message.part.updated events. Completion is still marked
      // by session.idle, not this event. Nothing to do here. (Phase A note:
      // subtask command child-session events stay filtered until Phase D.)
      return { kind: 'ignore' }

    default:
      return { kind: 'ignore' }
  }
}

/** Get-or-create the accumulator for a messageId. */
function ensureAccumulator(
  accumulators: Map<string, MessageAccumulator>,
  messageId: string
): MessageAccumulator {
  let acc = accumulators.get(messageId)
  if (!acc) {
    acc = { messageId, partOrder: [], parts: new Map() }
    accumulators.set(messageId, acc)
  }
  return acc
}

/** Best-effort messageId from a message.updated event's properties. */
function messageIdFromProps(props: Record<string, unknown>): string | undefined {
  return (props.messageID ?? props.messageId) as string | undefined
}

/** Sum the cumulative per-message cost snapshots into a turn total. */
function sumAccumulatorCosts(accumulators: Map<string, MessageAccumulator>): number {
  let total = 0
  for (const acc of accumulators.values()) total += acc.cost ?? 0
  return total
}

/**
 * Build a ChatMessage from a MessageAccumulator snapshot.
 * Blocks are ordered by part insertion order; tool parts get tool_use blocks.
 */
export function buildChatMessage(messageId: string, acc: MessageAccumulator): ChatMessage {
  const content: ContentBlock[] = []

  for (const partId of acc.partOrder) {
    const snap = acc.parts.get(partId)
    if (!snap) continue

    if (snap.type === 'text') {
      content.push({ type: 'text', text: snap.text ?? '' })
    } else if (snap.type === 'reasoning') {
      content.push({ type: 'thinking', text: snap.text ?? '' })
    } else if (snap.type === 'tool') {
      const toolUseId = snap.callID ?? partId
      content.push({
        type: 'tool_use',
        toolUseId,
        // RAW opencode tool name — the renderer's OpencodeEngineToolMap classifies
        // it to a ToolKind (bash→command, render_mermaid→diagram, …). callID +
        // toolInput stay untouched (plugin arg names already match the bodies).
        toolName: snap.toolName ?? 'unknown',
        toolInput: snap.state?.input ?? {}
      })
    }
    // step-start/step-finish: ignored for now
  }

  return {
    id: messageId,
    role: acc.role ?? 'assistant',
    content,
    timestamp: Date.now()
  }
}

/**
 * Check if a tool part snapshot represents a newly completed tool invocation.
 * Returns the tool result data, or null if not applicable.
 */
export function extractToolResult(
  _partId: string,
  snap: PartSnapshot
): { toolUseId: string; result: string; isError: boolean } | null {
  if (snap.type !== 'tool') return null
  const status = snap.state?.status
  if (status !== 'completed' && status !== 'error') return null
  const toolUseId = snap.callID ?? _partId
  const rawOutput = snap.state?.output ?? (snap.state?.metadata as Record<string, unknown> | undefined)?.output
  const result = rawOutput !== undefined ? String(rawOutput) : ''
  return { toolUseId, result, isError: status === 'error' }
}

// Helper: generate a stable uuid for user messages
export function makeUserMessageId(): string {
  return uuid()
}

/**
 * Pure event mapper: `mapPiEvent(ev, state)` turns one pi RPC event into zero
 * or more engine-neutral `PiMapperOutput`s. Mirrors `src/main/opencode/event-mapper.ts`'s
 * shape (pure function, caller-owned state) with one difference: pi's events
 * carry NO stable message id and are strictly sequential per process (pi has
 * no server/subagent-interleaving concept in M1), so `state` needs only ONE
 * in-flight message slot rather than opencode's Map keyed by message id.
 *
 * Within that single slot the mapper DOES accumulate per content block: since
 * pi 0.84.0 `message_update` carries deltas only (no cumulative `message`, no
 * `assistantMessageEvent.partial`), so the mid-turn upsert must be assembled
 * from the `*_end` events keyed by `contentIndex` — see `PiMapperState.blocks`.
 *
 * Event order relied on (verified — docs/protocol-pi/README.md):
 *   agent_start → turn_start → message_start(assistant) → message_update* →
 *   message_end(assistant) → tool_execution_* → message_end(role=toolResult) →
 *   turn_end → … → agent_end → agent_settled (the real turn-complete signal).
 */
import { v4 as uuid } from 'uuid'
import type { ChatMessage, ContentBlock, FileDiff, ToolResultImage } from '../../shared/types'
import { isImageMediaType } from '../../shared/types'
import type {
  PiAgentMessage,
  PiAssistantContentBlock,
  PiAssistantMessage,
  PiEvent,
  PiImageContent,
  PiTextContent,
  PiToolExecutionPartialResult
} from './pi-protocol'

// ---------------------------------------------------------------------------
// Caller-owned state
// ---------------------------------------------------------------------------

export interface PiMapperState {
  /** Set on assistant message_start; cleared once its message_end lands. Lets
   *  message_update/message_end reuse the same synthesized ChatMessage id —
   *  pi's wire events carry no stable message id of their own. */
  currentMessageId: string | null
  /** Content blocks of the in-flight assistant message, keyed by the wire's
   *  `contentIndex`. Fed by `message_update`'s `text_end`/`thinking_end`/
   *  `toolcall_end` (pi 0.84+ sends no cumulative snapshot), read to build the
   *  mid-turn upsert. Reset with `currentMessageId` at both ends of the
   *  message's life so nothing bleeds into the next one. */
  blocks: Map<number, PiAssistantContentBlock>
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
  /** M2 rich diff — `toolCallId → input.path` for in-flight `edit`/`write` tool
   *  calls, captured from the ASSISTANT message's `tool_use` blocks (pi's
   *  toolResult carries no path of its own — see `buildPiEditFileDiffs`).
   *  Entries are consumed (deleted) by the matching toolResult in the SAME
   *  turn, so this stays bounded to one turn's edit/write calls; an aborted
   *  turn whose toolResult never arrives would leak its entry, but pi's
   *  verified event order always pairs them, so no guard is added for that
   *  theoretical case (per M2 kickoff spec). */
  pendingEditPaths: Map<string, string>
}

export function createPiMapperState(): PiMapperState {
  return {
    currentMessageId: null,
    blocks: new Map(),
    startTimeMs: 0,
    totalCostUsd: 0,
    sessionId: null,
    pendingEditPaths: new Map()
  }
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
  usage?: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    cost: number
    turns: number
  }
}

export interface PiSubagentUpdatePayload {
  v: 1
  agents: PiSubagentAgentUpdate[]
}

export type PiMapperOutput =
  | { kind: 'stream'; streamType: 'text' | 'thinking'; delta: string; messageId: string }
  | { kind: 'message'; message: ChatMessage }
  | {
      kind: 'tool_result'
      toolUseId: string
      result: string
      isError: boolean
      fileDiffs?: FileDiff[]
      /** Images the tool returned (pi `image` content blocks). Omitted when none. */
      images?: ToolResultImage[]
    }
  | {
      kind: 'usage'
      provider: string
      modelId: string
      tokens: PiUsageTokens
      costUsd: number
      messageId: string
    }
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
        state.blocks.clear()
      }
      // user/bashExecution (and any other role) → ignore: the renderer already
      // renders the user's prompt optimistically; bashExecution messages never
      // reach the live event stream anyway (README.md "Behavior gotchas").
      return [{ kind: 'ignore' }]
    }

    case 'message_update': {
      const { assistantMessageEvent: amEvent } = ev as Extract<PiEvent, { type: 'message_update' }>
      const messageId = ensureMessageId(state)

      if (amEvent.type === 'text_delta' || amEvent.type === 'thinking_delta') {
        const delta = amEvent.delta ?? ''
        if (!delta) return [{ kind: 'ignore' }]
        return [
          {
            kind: 'stream',
            streamType: amEvent.type === 'text_delta' ? 'text' : 'thinking',
            delta,
            messageId
          }
        ]
      }

      // The `*_end` events carry the block's FULL accumulated value, so each
      // simply overwrites its slot — no string concatenation, and replaying one
      // is idempotent.
      if (amEvent.type === 'text_end') {
        setPiBlock(state, amEvent.contentIndex, { type: 'text', text: amEvent.content ?? '' })
        return [{ kind: 'ignore' }]
      }

      if (amEvent.type === 'thinking_end') {
        setPiBlock(state, amEvent.contentIndex, {
          type: 'thinking',
          thinking: amEvent.content ?? ''
        })
        return [{ kind: 'ignore' }]
      }

      if (amEvent.type === 'toolcall_end') {
        // A completed tool call is the one mid-turn moment the renderer needs a
        // whole message for (the tool card can't be drawn from text deltas), so
        // this is where the accumulated blocks are published. Upsert-by-id makes
        // it safe to emit once per completed tool call in the turn; the
        // following message_end replaces the approximation wholesale.
        if (!amEvent.toolCall) return [{ kind: 'ignore' }]
        setPiBlock(state, amEvent.contentIndex, amEvent.toolCall)
        const content = orderedPiBlocks(state)
        recordPiEditToolPaths(state, content)
        return [{ kind: 'message', message: buildPiChatMessage(messageId, content) }]
      }

      // start/text_start/thinking_start/toolcall_start/toolcall_delta/done/
      // error: no visible output needed — text/thinking rendering is driven
      // purely by the `stream` deltas above, partial tool arguments are never
      // streamed, and the terminal state (success or error/aborted) is fully
      // captured by the following message_end event's stopReason.
      return [{ kind: 'ignore' }]
    }

    case 'message_end': {
      const msg = (ev as Extract<PiEvent, { type: 'message_end' }>).message

      if (msg.role === 'assistant') {
        const messageId = ensureMessageId(state)
        state.currentMessageId = null
        state.blocks.clear()
        recordPiEditToolPaths(state, msg.content)

        const message = buildPiChatMessage(messageId, msg.content)
        // `usage` is guarded defensively: an errored/aborted turn (M-PI2) may
        // carry a partial or absent usage snapshot, and this branch now runs for
        // those too.
        const usage = msg.usage as PiAssistantMessage['usage'] | undefined
        const cost = usage?.cost?.total ?? 0
        state.totalCostUsd += cost

        const outputs: PiMapperOutput[] = []

        // M-PI4: only surface a message that has content. An instant Esc-abort
        // ends the turn with an EMPTY assistant message; the persisted converter
        // (pi-session-list.ts `convertPiEntryMessage`) drops empty-content
        // assistant messages, so the LIVE stream must too — otherwise the
        // store's message array (which feeds POSITION-based pi fork anchoring in
        // fork-anchor.ts) drifts one ahead of the on-disk transcript and every
        // later fork silently drops the wrong turn.
        if (message.content.length > 0) {
          outputs.push({ kind: 'message', message })
        }

        if (usage) {
          outputs.push({
            kind: 'usage',
            provider: msg.provider,
            modelId: msg.model,
            tokens: {
              input: usage.input,
              output: usage.output,
              cacheRead: usage.cacheRead,
              cacheWrite: usage.cacheWrite,
              ...(usage.reasoning != null ? { reasoning: usage.reasoning } : {})
            },
            costUsd: cost,
            messageId
          })
        }

        // M-PI2: surface a failed turn (parity with Claude/opencode). pi ends an
        // errored turn — expired token, exhausted rate limit — with
        // stopReason:'error' and an errorMessage, previously swallowed into an
        // empty assistant message with no banner. 'aborted' is a user Stop, NOT
        // an error, so it never raises a banner.
        if (msg.stopReason === 'error') {
          outputs.push({
            kind: 'error',
            message: msg.errorMessage || 'pi reported a turn error'
          })
        }

        return outputs
      }

      if (msg.role === 'toolResult') {
        const result = piToolResultText(msg.content)
        // Images the tool RETURNED (pi's read on a .png, screenshot tools).
        // NOTE: only the FINAL result carries them through — the in-flight
        // `tool_execution_update` path (extractPartialResultText) stays
        // text-only by design, so a long-running image tool shows its image
        // once it completes.
        const images = piToolResultImages(msg.content)

        // M2: rich diff — pi's `edit` tool result carries a ready-made unified
        // diff at msg.details.patch, but (unlike opencode's apply_patch/edit)
        // it carries NO file path of its own (verified against the compiled
        // pi binary's dist/core/tools/edit.js execute(): returns
        // `details: { diff, patch, firstChangedLine }` where `patch` comes
        // from `generateUnifiedPatch` — a real createTwoFilesPatch unified
        // diff; `diff` is a custom line-numbered ASCII view, not what
        // FileDiff.patch wants). The path is threaded through from the
        // ORIGINAL toolCall's `arguments.path`, captured by
        // recordPiEditToolPaths above when the preceding assistant message
        // was built. Never fabricated: fileDiffs is only set when BOTH a path
        // was recorded for this exact toolCallId AND a non-empty
        // `details.patch` string is present (write's execute() always returns
        // `details: undefined`, so this never fires for write today).
        const path = state.pendingEditPaths.get(msg.toolCallId)
        state.pendingEditPaths.delete(msg.toolCallId)
        const fileDiffs = buildPiEditFileDiffs(msg.toolName, path, msg.details)

        const outputs: PiMapperOutput[] = [
          {
            kind: 'tool_result',
            toolUseId: msg.toolCallId,
            result,
            isError: msg.isError,
            ...(fileDiffs ? { fileDiffs } : {}),
            ...(images ? { images } : {})
          }
        ]

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
      return [
        {
          kind: 'bash_output',
          toolUseId: toolCallId,
          output: extractPartialResultText(partialResult)
        }
      ]
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
 * Store one completed content block of the in-flight assistant message.
 * `contentIndex` is documented and always present on the real wire, but a
 * malformed event must never crash the mapper — an absent/non-numeric index
 * appends past the current slots instead.
 */
function setPiBlock(
  state: PiMapperState,
  contentIndex: number | undefined,
  block: PiAssistantContentBlock
): void {
  const index = typeof contentIndex === 'number' ? contentIndex : state.blocks.size
  state.blocks.set(index, block)
}

/**
 * The in-flight message's blocks in wire order. Sorting rather than relying on
 * Map insertion order: a provider that interleaves blocks (finishing a later
 * one first) would otherwise render them out of order.
 */
function orderedPiBlocks(state: PiMapperState): PiAssistantContentBlock[] {
  return [...state.blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, block]) => block)
}

/**
 * M2 rich diff — record `{toolCallId → input.path}` for every `edit`/`write`
 * tool_use block in an assistant message's content. This is the ONLY place a
 * path is ever captured: pi's toolResult (message_end role==='toolResult')
 * carries no path of its own (see `buildPiEditFileDiffs`). Called from BOTH
 * sites that build an assistant message's content — message_update's
 * toolcall_end branch AND message_end's assistant branch — since either may
 * be the one visible to a given caller; upserting by toolCallId makes calling
 * it repeatedly for the same tool_use harmless.
 */
function recordPiEditToolPaths(state: PiMapperState, content: PiAssistantContentBlock[]): void {
  for (const block of content) {
    if (block.type !== 'toolCall') continue
    if (block.name !== 'edit' && block.name !== 'write') continue
    const path = block.arguments?.path
    if (typeof path === 'string' && path.length > 0) {
      state.pendingEditPaths.set(block.id, path)
    }
  }
}

/**
 * Build the `fileDiffs` array for a completed `edit` (or `write`, if it ever
 * carries a diff — see the toolResult branch's comment) toolResult. Never
 * fabricates: returns undefined unless BOTH a recorded `path` is given AND
 * `details.patch` is a non-empty string.
 *
 * additions/deletions are derived by counting `+`/`-` body lines in the
 * unified diff (skipping the `---`/`+++` file-header lines, which also start
 * with `-`/`+`) — pi's `patch` carries no ready-made counts the way
 * opencode's apply_patch/edit metadata does, but counting is cheap enough to
 * do unconditionally rather than omit.
 */
function buildPiEditFileDiffs(
  toolName: string,
  path: string | undefined,
  details:
    { diff?: string; patch?: string; firstChangedLine?: number; [key: string]: unknown } | undefined
): FileDiff[] | undefined {
  if (!path) return undefined
  const patch = details?.patch
  if (typeof patch !== 'string' || patch.length === 0) return undefined

  let additions = 0
  let deletions = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) additions++
    else if (line.startsWith('-')) deletions++
  }

  return [
    { path, patch, changeType: toolName === 'write' ? 'add' : 'update', additions, deletions }
  ]
}

/**
 * Join the text blocks of a pi toolResult's content. Exported because
 * `pi-session-list.ts` replays the SAME `PiToolResultMessage` shape off disk and
 * must produce the identical `toolResult` string as the live path.
 */
export function piToolResultText(content: Array<PiTextContent | PiImageContent>): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is PiTextContent => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

/**
 * Images a pi tool RETURNED, from its toolResult content blocks
 * (`PiImageContent`: `{type:'image', data:<base64>, mimeType}` — note the
 * camelCase `mimeType`, unlike Claude's nested `source.media_type`).
 *
 * `mimeType` is a free-form string on the wire, so it is filtered through
 * `IMAGE_MEDIA_TYPES`; pi carries no filename, so `fileName` is omitted.
 * Returns undefined (not []) when there is nothing to carry.
 *
 * Shared with the stored-replay path in pi-session-list.ts.
 */
export function piToolResultImages(
  content: Array<PiTextContent | PiImageContent>
): ToolResultImage[] | undefined {
  if (!Array.isArray(content)) return undefined
  const images: ToolResultImage[] = []
  for (const b of content) {
    if (b.type !== 'image') continue
    if (!isImageMediaType(b.mimeType) || !b.data) continue
    images.push({ mediaType: b.mimeType, base64Data: b.data })
  }
  return images.length > 0 ? images : undefined
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

function isPiSubagentUsage(value: unknown): value is {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
  turns: number
} {
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
export function buildPiChatMessage(
  messageId: string,
  content: PiAssistantContentBlock[]
): ChatMessage {
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

import type { ChatMessage, ContentBlock } from '../../shared/types'
import type { ItemStreamTarget } from '../shared/sync/item-stream'

type Owner = string | undefined

export interface ClaudeNativeStreamEvent {
  type?: string
  message?: { id?: string; content?: unknown }
  index?: number
  content_block?: Record<string, unknown>
  delta?: Record<string, unknown>
}

interface BlockState {
  block: ContentBlock
  opened: boolean
  stopped: boolean
  thinkingStartedAt?: number
}

interface MessageState {
  owner: Owner
  messageId: string
  timestamp: number
  blocks: BlockState[]
  terminalSealed?: boolean
  /** `message_delta`'s `stop_reason`; absent until one arrives (or never, when the stream is cut). */
  stopReason?: string | null
  /** tool_use ids some `assistant` snapshot of this message carried — calls cli.js really made. */
  confirmedToolUseIds: Set<string>
}

export interface ClaudeItemStreamSink {
  /** `startedAt` is the item's own start clock — thinking blocks only. */
  open(target: ItemStreamTarget, message: ChatMessage, startedAt?: number): void
  delta(target: ItemStreamTarget, chunk: string): void
  seal(target: ItemStreamTarget | undefined, message: ChatMessage, owner: Owner): void
  updateLocal(message: ChatMessage, owner: Owner): void
  /**
   * Publish the message to CLIENTS, outside the item lane.
   *
   * Only text and thinking blocks are items, so a `tool_use` block reaches a
   * client únicamente through the targetless seal at `message_stop` — which is
   * AFTER cli.js may already have run the tool. `session:tool-result` attaches by
   * scanning the transcript for the matching `tool_use`, so a result that
   * arrives before that seal finds nothing and is dropped for good: the card
   * spins for the rest of the session. Publishing the message when a
   * non-streaming block appears keeps "the call exists before its result" true
   * whatever the wire order, and shows the card the moment the call starts.
   */
  publish(message: ChatMessage, owner: Owner): void
  /**
   * Tool calls that were streamed but will never run, removed from the message
   * before its final seal. An output-limit cut (`stop_reason: "max_tokens"`) or
   * an interrupted stream leaves the half-streamed `tool_use` with no snapshot;
   * {@link publish} already put its `{}`-input scaffold on every client, and the
   * reducer's merges keep a block the final seal omits, so only an explicit
   * retraction removes it. Called at most once per message, before that seal.
   */
  retractToolUses(messageId: string, toolUseIds: string[], owner: Owner): void
}

/**
 * The tool_use id a `stream_event` frame belongs under, before any run
 * aliasing: `undefined` for the main agent, `null` for a sub-agent frame
 * nothing can place.
 *
 * A background agent that cli.js resumes on its own while the session is idle
 * (a child of its reported) runs with no `toolUseId` on its context, so Patch
 * E's frames carry no `parent_tool_use_id` — only `agent_id`. Its completed
 * snapshots still arrive under the ORIGIN Agent call's id (the relay reads the
 * agent's sidecar), so `originOf` must answer with that origin or the partials
 * and the snapshots land on different lanes. A frame with an `agent_id` is
 * never the main agent's: unplaceable, it is dropped rather than leaked onto
 * the root as a card that never gets its input or result.
 */
export function streamEventParent(
  frame: { parent_tool_use_id?: string | null; agent_id?: unknown },
  originOf: (agentId: string) => string | undefined
): string | undefined | null {
  if (frame.parent_tool_use_id) return frame.parent_tool_use_id
  const agentId = frame.agent_id
  if (typeof agentId !== 'string' || !agentId) return undefined
  return originOf(agentId) ?? null
}

const ownerKey = (owner: Owner): string => JSON.stringify(owner ?? null)
const messageKey = (owner: Owner, messageId: string): string =>
  JSON.stringify([owner ?? null, messageId])

function initialBlock(raw: Record<string, unknown>): ContentBlock {
  switch (raw.type) {
    case 'text':
      return { type: 'text', text: typeof raw.text === 'string' ? raw.text : '' }
    case 'thinking':
      return { type: 'thinking', text: typeof raw.thinking === 'string' ? raw.thinking : '' }
    case 'tool_use':
      return {
        type: 'tool_use',
        toolName: typeof raw.name === 'string' ? raw.name : '',
        toolInput:
          raw.input && typeof raw.input === 'object' ? (raw.input as Record<string, unknown>) : {},
        toolUseId: typeof raw.id === 'string' ? raw.id : ''
      }
    default:
      return { type: 'text', text: JSON.stringify(raw) }
  }
}

/** Claude stream-event lifecycle, isolated so headless dispatch can reuse it later. */
export class ClaudeItemStreamLifecycle {
  private readonly messages = new Map<string, MessageState>()
  private readonly invalidated = new Set<string>()

  constructor(private readonly sink: ClaudeItemStreamSink) {}

  handleEvent(event: ClaudeNativeStreamEvent, owner: Owner): void {
    const key = ownerKey(owner)
    if (event.type === 'message_start') {
      const messageId = event.message?.id
      if (!messageId || this.invalidated.has(messageKey(owner, messageId))) return
      const previous = this.messages.get(key)
      if (previous && previous.messageId !== messageId) this.finish(key, previous)
      this.messages.set(key, {
        owner,
        messageId,
        timestamp: Date.now(),
        blocks: [],
        confirmedToolUseIds: new Set()
      })
      return
    }

    const state = this.messages.get(key)
    if (!state) return
    if (
      state.terminalSealed &&
      (event.type === 'content_block_start' || event.type === 'content_block_delta')
    )
      return
    if (event.type === 'content_block_start') {
      if (
        !Number.isSafeInteger(event.index) ||
        event.index !== state.blocks.length ||
        !event.content_block
      )
        return
      const block = initialBlock(event.content_block)
      const entry: BlockState = { block, opened: false, stopped: false }
      state.blocks.push(entry)
      // A block the item lane does not carry (a tool_use) would otherwise be
      // invisible to clients until `message_stop`. Publish the message now, so
      // its result has something to attach to no matter when it lands.
      if (block.type !== 'text' && block.type !== 'thinking')
        this.sink.publish(this.message(state), state.owner)
      if ((block.type === 'text' || block.type === 'thinking') && block.text) {
        entry.opened = true
        if (block.type === 'thinking') entry.thinkingStartedAt = Date.now()
        this.sink.open(
          this.target(state, event.index, block.type),
          this.message(state),
          entry.thinkingStartedAt
        )
      }
      this.publishLocal(state)
      return
    }
    if (event.type === 'content_block_delta') {
      if (!Number.isSafeInteger(event.index) || !event.delta) return
      const block = state.blocks[event.index!]
      if (!block || block.stopped) return
      const delta = event.delta
      let kind: ItemStreamTarget['kind'] | undefined
      let chunk: string | undefined
      if (
        delta.type === 'text_delta' &&
        block.block.type === 'text' &&
        typeof delta.text === 'string'
      ) {
        kind = 'text'
        chunk = delta.text
      } else if (
        delta.type === 'thinking_delta' &&
        block.block.type === 'thinking' &&
        typeof delta.thinking === 'string'
      ) {
        kind = 'thinking'
        chunk = delta.thinking
        block.thinkingStartedAt ??= Date.now()
      }
      if (kind === undefined || !chunk) return
      const target = this.target(state, event.index!, kind)
      if (!block.opened) {
        block.opened = true
        // Undefined for a text block, which carries no item-local clock.
        this.sink.open(target, this.message(state), block.thinkingStartedAt)
      }
      this.sink.delta(target, chunk)
      if (block.block.type === 'text') {
        block.block = { ...block.block, text: block.block.text + chunk }
      } else if (block.block.type === 'thinking') {
        block.block = { ...block.block, text: block.block.text + chunk }
      }
      this.publishLocal(state)
      return
    }
    if (event.type === 'content_block_stop') {
      if (!Number.isSafeInteger(event.index)) return
      this.sealBlock(state, event.index!)
      return
    }
    if (event.type === 'message_delta') {
      const stopReason = event.delta?.stop_reason
      if (typeof stopReason === 'string' || stopReason === null) state.stopReason = stopReason
      return
    }
    if (event.type === 'message_stop') this.finish(key, state)
  }

  /**
   * Place an `assistant` snapshot onto the live block state.
   *
   * The one-block branch relies on cli.js emitting ONE single-block `assistant`
   * line per content block, sharing `message.id` and arriving after that
   * block's last delta but BEFORE its `content_block_stop` (verified on 2.1.268
   * — `docs/protocol-cc/05-stream-events.md` §5.9, guarded by
   * `src/integration/sdk-contract/stream-order.integration.test.ts`). If a
   * future cli.js changes that shape, the snapshot matches no block; `'none'`
   * then hands it back to the caller's ordinary message upsert instead of
   * swallowing it, and the later targetless seal merges over that upsert.
   */
  handleSnapshot(message: ChatMessage, owner: Owner): 'handled' | 'drop' | 'none' {
    if (this.invalidated.has(messageKey(owner, message.id))) return 'drop'
    const state = this.messages.get(ownerKey(owner))
    if (!state || state.messageId !== message.id) return 'none'
    // Before any placement can fail: a snapshot that falls through to the
    // caller's ordinary upsert still proves the call is real.
    for (const block of message.content) {
      if (block.type === 'tool_use') state.confirmedToolUseIds.add(block.toolUseId)
    }
    let replaced = false
    if (message.content.length === state.blocks.length) {
      message.content.forEach((block, index) => {
        if (this.replaceBlock(state.blocks[index], block)) replaced = true
      })
    } else if (message.content.length === 1) {
      const incoming = message.content[0]
      const index = state.blocks.findLastIndex(
        (entry) => (state.terminalSealed || !entry.stopped) && entry.block.type === incoming.type
      )
      if (index >= 0) replaced = this.replaceBlock(state.blocks[index], incoming)
    }
    if (!replaced) return 'none'
    this.publishLocal(state)
    // The snapshot is where a tool_use's real input arrives (`input_json_delta`
    // is not an item delta), so a client that already has the empty scaffold
    // needs this one too — again before any result can reference it.
    if (message.content.some((block) => block.type !== 'text' && block.type !== 'thinking')) {
      this.sink.publish(this.message(state), state.owner)
    }
    return 'handled'
  }

  sealOwner(owner: Owner, retainForNativeStop = false): void {
    const key = ownerKey(owner)
    const state = this.messages.get(key)
    if (state) this.finish(key, state, retainForNativeStop)
    if (owner !== undefined) return
    // The ROOT turn ended (handleResultMessage). Every `terminalSealed` child
    // state is already fully sealed and is only being kept for a native
    // `message_stop` that may never arrive — a background child whose parent
    // finishes first leaks one per turn otherwise. A straggler arriving after
    // this finds no state and is a no-op, which is the same outcome as the
    // guard it used to hit.
    for (const [childKey, child] of [...this.messages]) {
      if (child.terminalSealed) this.messages.delete(childKey)
    }
  }

  /** Retained per-owner states. Test seam for the terminal-sealed sweep below. */
  activeOwnerCount(): number {
    return this.messages.size
  }

  sealAll(): void {
    for (const [key, state] of [...this.messages]) this.finish(key, state)
  }

  retract(messageIds: readonly string[], owner: Owner = undefined): void {
    for (const id of messageIds) {
      this.invalidated.add(messageKey(owner, id))
      if (this.invalidated.size > 256)
        this.invalidated.delete(this.invalidated.values().next().value!)
    }
    for (const [key, state] of this.messages) {
      if (state.owner === owner && messageIds.includes(state.messageId)) this.messages.delete(key)
    }
  }

  private sealBlock(state: MessageState, index: number): void {
    const block = state.blocks[index]
    if (!block || block.stopped) return
    block.stopped = true
    if (!block.opened || (block.block.type !== 'text' && block.block.type !== 'thinking')) return
    if (block.block.type === 'thinking' && block.thinkingStartedAt !== undefined) {
      block.block = { ...block.block, durationMs: Date.now() - block.thinkingStartedAt }
    }
    const kind = block.block.type
    this.sink.seal(this.target(state, index, kind), this.message(state), state.owner)
    this.publishLocal(state)
  }

  private finish(key: string, state: MessageState, retainForNativeStop = false): void {
    if (state.blocks.length === 0) {
      this.messages.delete(key)
      return
    }
    // Item seals first, while every block still sits at its native index.
    for (let index = 0; index < state.blocks.length; index++) this.sealBlock(state, index)
    if (this.retractTruncatedToolUses(state) && state.blocks.length === 0) {
      // Nothing but the cut call: the retraction removed the message outright.
      this.messages.delete(key)
      return
    }
    const final = this.message(state)
    this.sink.seal(undefined, final, state.owner)
    this.sink.updateLocal(final, state.owner)
    if (retainForNativeStop) state.terminalSealed = true
    else this.messages.delete(key)
  }

  /**
   * Drop the tool calls that will never run, reporting them first. A message
   * that stopped for `"tool_use"` retracts nothing — its calls all run, and a
   * sub-agent's snapshot may legitimately lag `message_stop` (Patch E stream
   * events and the native relay's snapshots take different paths). Any other
   * outcome — `max_tokens`, `end_turn`, `refusal`, or no `stop_reason` at all
   * because the stream was cut — means a call no snapshot confirmed was
   * truncated mid-stream (`docs/protocol-cc/05-stream-events.md` §5.9).
   */
  private retractTruncatedToolUses(state: MessageState): boolean {
    if (state.stopReason === 'tool_use') return false
    const truncated = state.blocks.filter(
      (entry) =>
        entry.block.type === 'tool_use' && !state.confirmedToolUseIds.has(entry.block.toolUseId)
    )
    if (truncated.length === 0) return false
    const toolUseIds = truncated.map((entry) =>
      entry.block.type === 'tool_use' ? entry.block.toolUseId : ''
    )
    state.blocks = state.blocks.filter((entry) => !truncated.includes(entry))
    this.sink.retractToolUses(state.messageId, toolUseIds, state.owner)
    return true
  }

  /** True when the incoming block actually landed on `entry`. */
  private replaceBlock(entry: BlockState | undefined, incoming: ContentBlock): boolean {
    if (!entry || entry.block.type !== incoming.type) return false
    if (incoming.type === 'thinking' && entry.block.type === 'thinking') {
      entry.block = { ...incoming, durationMs: entry.block.durationMs }
    } else {
      entry.block = incoming
    }
    return true
  }

  private publishLocal(state: MessageState): void {
    this.sink.updateLocal(this.message(state), state.owner)
  }

  private message(state: MessageState): ChatMessage {
    return {
      id: state.messageId,
      role: 'assistant',
      content: state.blocks.map((entry) => entry.block),
      timestamp: state.timestamp
    }
  }

  private target(
    state: MessageState,
    blockIndex: number,
    kind: ItemStreamTarget['kind']
  ): ItemStreamTarget {
    return {
      messageId: state.messageId,
      blockIndex,
      kind,
      ...(state.owner ? { ownerToolUseId: state.owner } : {})
    }
  }
}

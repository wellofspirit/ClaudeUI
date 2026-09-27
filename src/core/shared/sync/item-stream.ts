/** Item-addressed volatile text. Lifecycle is reliable; only appends are lossy. */
import type { ChatMessage, ContentBlock } from '../../../shared/types'
import type { CanonicalSessionState, CanonicalState } from './state'

export interface ItemStreamTarget {
  messageId: string
  /** Stable content slot within the message established by open. */
  blockIndex: number
  kind: 'text' | 'thinking' | 'plan'
  ownerToolUseId?: string
}

export interface ActiveItemStream {
  target: ItemStreamTarget
  /** The reliable open's sequence, assigned by core. */
  generation: number
  value: string
  /**
   * When the ITEM started, as measured by the adapter that opened it. Set on
   * thinking opens only, so the renderer's live "Thinking for Ns" counts from
   * the thought, not from message creation (a thinking block that starts after
   * a tool call would otherwise be timed from the message's first byte).
   *
   * The reducer only ever COPIES this off the open payload — no clock runs in
   * `src/core/shared/sync/*`.
   */
  startedAt?: number
}

export type ItemStreams = Record<string, ActiveItemStream>

export interface ItemStreamOpen {
  target: ItemStreamTarget
  message: ChatMessage
  /** See {@link ActiveItemStream.startedAt}. Thinking opens only. */
  startedAt?: number
}

export interface ItemStreamSeal {
  /** Present for a field-only seal; absent for a message-wide seal. */
  target?: ItemStreamTarget
  message: ChatMessage
  ownerToolUseId?: string
}

export type ItemStreamFrame =
  | {
      type: 'item-stream'
      op: 'append'
      routingId: string
      atSeq: number
      target: ItemStreamTarget
      generation: number
      offset: number
      chunk: string
    }
  | { type: 'item-stream'; op: 'replace'; routingId: string; atSeq: number; streams: ItemStreams }

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const isNonNegativeSafeInteger = (v: unknown): v is number =>
  Number.isSafeInteger(v) && (v as number) >= 0
/** An adapter-measured epoch millisecond. Absent and invalid both mean "unset". */
const isStartedAt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0

/** Validate the collision-safe, block-addressed identity used on both lanes. */
export function isItemTarget(v: unknown): v is ItemStreamTarget {
  return (
    isRecord(v) &&
    typeof v.messageId === 'string' &&
    v.messageId !== '' &&
    isNonNegativeSafeInteger(v.blockIndex) &&
    ['text', 'thinking', 'plan'].includes(v.kind as string) &&
    (v.ownerToolUseId === undefined ||
      (typeof v.ownerToolUseId === 'string' && v.ownerToolUseId !== ''))
  )
}

/** JSON tuple encoding avoids collisions between opaque native ids. */
export function itemStreamKey(t: ItemStreamTarget): string {
  return JSON.stringify([t.ownerToolUseId ?? null, t.messageId, t.blockIndex, t.kind])
}

/** Validate untrusted transport frames before they can affect canonical state. */
export function isItemStreamFrame(v: unknown): v is ItemStreamFrame {
  if (
    !isRecord(v) ||
    v.type !== 'item-stream' ||
    typeof v.routingId !== 'string' ||
    !v.routingId ||
    !isNonNegativeSafeInteger(v.atSeq)
  )
    return false
  if (v.op === 'append')
    return (
      isItemTarget(v.target) &&
      isNonNegativeSafeInteger(v.generation) &&
      v.generation > 0 &&
      v.generation <= v.atSeq &&
      isNonNegativeSafeInteger(v.offset) &&
      typeof v.chunk === 'string'
    )
  return (
    v.op === 'replace' &&
    isRecord(v.streams) &&
    Object.entries(v.streams).every(
      ([key, s]) =>
        isRecord(s) &&
        isItemTarget(s.target) &&
        key === itemStreamKey(s.target) &&
        isNonNegativeSafeInteger(s.generation) &&
        s.generation > 0 &&
        s.generation <= (v.atSeq as number) &&
        typeof s.value === 'string' &&
        (s.startedAt === undefined || isStartedAt(s.startedAt))
    )
  )
}

function messagesOf(s: CanonicalSessionState, owner?: string): ChatMessage[] {
  return owner ? (s.subagentMessages[owner] ?? []) : s.messages
}

function valueOf(block: ContentBlock | undefined, kind: ItemStreamTarget['kind']): string | null {
  if (kind === 'plan')
    return block?.type === 'tool_use' &&
      block.toolName === 'plan' &&
      typeof block.toolInput?.plan === 'string'
      ? block.toolInput.plan
      : null
  return block?.type === kind && typeof block.text === 'string' ? block.text : null
}

function hasTarget(s: CanonicalSessionState, t: ItemStreamTarget): boolean {
  return (
    valueOf(
      messagesOf(s, t.ownerToolUseId).find((m) => m.id === t.messageId)?.content[t.blockIndex],
      t.kind
    ) !== null
  )
}

function upsert(
  s: CanonicalSessionState,
  message: ChatMessage,
  owner?: string
): CanonicalSessionState {
  const messages = messagesOf(s, owner)
  const index = messages.findIndex((m) => m.id === message.id)
  const merged =
    index < 0
      ? message
      : { ...message, content: mergeItemContent(messages[index].content, message.content, true) }
  const next =
    index < 0 ? [...messages, merged] : messages.map((m, i) => (i === index ? merged : m))
  return owner
    ? { ...s, subagentMessages: { ...s.subagentMessages, [owner]: next } }
    : { ...s, messages: next }
}

/**
 * Merge a native-indexed item scaffold without letting separately attached
 * results/reviews occupy a native block address. Native blocks keep the
 * incoming slot order; auxiliary blocks absent from the native snapshot trail
 * that scaffold in their existing order.
 */
export function mergeItemContent(
  oldBlocks: ContentBlock[],
  nativeBlocks: ContentBlock[],
  preserveExistingNativeSlots = false
): ContentBlock[] {
  const isAuxiliary = (block: ContentBlock): boolean =>
    block.type === 'tool_result' ||
    block.type === 'tool_review' ||
    block.type === 'permission_denial'
  const slots = nativeBlocks.map((incoming, index) => {
    const old = oldBlocks[index]
    if (preserveExistingNativeSlots && old && !isAuxiliary(old)) return old
    return incoming
  })
  if (preserveExistingNativeSlots) {
    for (let index = nativeBlocks.length; index < oldBlocks.length; index++) {
      if (!isAuxiliary(oldBlocks[index])) slots[index] = oldBlocks[index]
    }
  }
  const resultIds = new Set(
    nativeBlocks.filter((block) => block.type === 'tool_result').map((block) => block.toolUseId)
  )
  const reviewIds = new Set(
    nativeBlocks.filter((block) => block.type === 'tool_review').map((block) => block.reviewId)
  )
  const denialIds = new Set(
    nativeBlocks
      .filter((block) => block.type === 'permission_denial')
      .map((block) => block.denialId)
  )
  const auxiliary = oldBlocks.filter((block) => {
    if (block.type === 'tool_result') return !resultIds.has(block.toolUseId)
    if (block.type === 'tool_review') return !reviewIds.has(block.reviewId)
    if (block.type === 'permission_denial') return !denialIds.has(block.denialId)
    return false
  })
  return [...slots.filter(Boolean), ...auxiliary]
}

function isMessage(v: unknown): v is ChatMessage {
  return (
    isRecord(v) &&
    typeof v.id === 'string' &&
    v.role === 'assistant' &&
    typeof v.timestamp === 'number' &&
    Number.isFinite(v.timestamp) &&
    Array.isArray(v.content) &&
    v.content.every((b) => isRecord(b) && typeof b.type === 'string')
  )
}

/** Reliable lifecycle fold, shared by core and every replica. */
export function applyItemLifecycle(
  s: CanonicalSessionState,
  channel: string,
  data: unknown,
  seq: number,
  commit: (
    session: CanonicalSessionState,
    message: ChatMessage,
    ownerToolUseId: string | undefined,
    target: ItemStreamTarget | undefined
  ) => CanonicalSessionState
): CanonicalSessionState {
  if (!isRecord(data) || !isMessage(data.message)) return s
  if (channel === 'session:item-open') {
    if (!isItemTarget(data.target) || data.target.messageId !== data.message.id) return s
    const target = data.target
    const key = itemStreamKey(target)
    if (s.itemStreams[key]) return s
    // Opening another field must not move existing slots. Results/reviews can
    // arrive between opens, and the ordinary final-message merge prepends them.
    const existing = messagesOf(s, target.ownerToolUseId).find((m) => m.id === target.messageId)
    const scaffold = existing
      ? {
          ...existing,
          content: mergeItemContent(existing.content, data.message.content, true)
        }
      : data.message
    // A reopen continues from the preserved scaffold. Starting from the incoming
    // empty block would make the overlay replace committed partial text with only
    // the new tail.
    const value = valueOf(scaffold.content[target.blockIndex], target.kind)
    if (value === null) return s
    const next = upsert(s, scaffold, target.ownerToolUseId)
    // COPIED, never measured: an invalid value is dropped rather than repaired,
    // and the renderer falls back to the message timestamp exactly as before.
    const startedAt = isStartedAt(data.startedAt) ? data.startedAt : undefined
    return {
      ...next,
      itemStreamRevision: seq,
      itemStreams: {
        ...s.itemStreams,
        [key]: {
          target,
          generation: seq,
          value,
          ...(startedAt === undefined ? {} : { startedAt })
        }
      }
    }
  }
  if (
    channel !== 'session:item-seal' ||
    (data.ownerToolUseId !== undefined && typeof data.ownerToolUseId !== 'string')
  )
    return s
  const sealingTarget = data.target
  if (sealingTarget !== undefined) {
    if (
      !isItemTarget(sealingTarget) ||
      sealingTarget.messageId !== data.message.id ||
      sealingTarget.ownerToolUseId !== data.ownerToolUseId ||
      valueOf(data.message.content[sealingTarget.blockIndex], sealingTarget.kind) === null
    )
      return s
    // A targeted seal is still a resolved ChatMessage: its completed field must
    // occupy the addressed scaffold slot. Do not reinterpret a one-block payload
    // as belonging at a nonzero index; that would silently corrupt another field.
    // A missing active entry can mean a lost replace on a replica. Accept the
    // authoritative completion while its scaffold still exists. Retraction
    // removes that scaffold, so this bounded lifecycle check cannot resurrect it.
    const transcriptHasMessage = messagesOf(s, sealingTarget.ownerToolUseId).some(
      (message) => message.id === sealingTarget.messageId
    )
    if (!s.itemStreams[itemStreamKey(sealingTarget)] && !transcriptHasMessage) return s
  }
  const message = data.message
  const owner = data.ownerToolUseId as string | undefined
  const itemStreams = sealingTarget
    ? Object.fromEntries(
        Object.entries(s.itemStreams).filter(([key]) => key !== itemStreamKey(sealingTarget))
      )
    : Object.fromEntries(
        Object.entries(s.itemStreams).filter(
          ([, entry]) =>
            entry.target.messageId !== message.id || entry.target.ownerToolUseId !== owner
        )
      )
  return {
    ...commit(s, data.message, owner, sealingTarget),
    itemStreams,
    itemStreamRevision: seq
  }
}
/** Why a delta produced no frame. `no-open` is ordinary on a raced seal. */
export type ItemAppendDrop = 'no-open' | 'malformed'

export type ItemAppendResult =
  | { frame: Extract<ItemStreamFrame, { op: 'append' }>; reason?: undefined; target?: undefined }
  | { frame: null; reason: ItemAppendDrop; target: unknown }

/**
 * {@link itemAppendFrame} with the drop CLASSIFIED, so the host can log a
 * malformed payload (a producer bug) differently from a delta that lost its
 * race with the seal (expected).
 */
export function itemAppendResult(
  s: CanonicalState,
  routingId: string,
  data: unknown,
  atSeq: number
): ItemAppendResult {
  if (
    !isRecord(data) ||
    !isItemTarget(data.target) ||
    typeof data.chunk !== 'string' ||
    !data.chunk
  )
    return {
      frame: null,
      reason: 'malformed',
      target: isRecord(data) ? data.target : undefined
    }
  const stream = s.sessions[routingId]?.itemStreams[itemStreamKey(data.target)]
  if (!stream) return { frame: null, reason: 'no-open', target: data.target }
  return {
    frame: {
      type: 'item-stream',
      op: 'append',
      routingId,
      atSeq,
      target: stream.target,
      generation: stream.generation,
      // Wire offsets are JavaScript string lengths (UTF-16 code units), matching
      // the accumulation and every client-side comparison.
      offset: stream.value.length,
      chunk: data.chunk
    }
  }
}

export function itemAppendFrame(
  s: CanonicalState,
  routingId: string,
  data: unknown,
  atSeq: number
): ItemStreamFrame | null {
  return itemAppendResult(s, routingId, data, atSeq).frame
}

/** Apply a lossy append or an atomic active-set recovery frame. */
export function applyItemStreamFrame(
  state: CanonicalState,
  frame: ItemStreamFrame
): {
  state: CanonicalState
  result: 'applied' | 'mismatch' | 'unknown'
} {
  if (!isItemStreamFrame(frame)) return { state, result: 'unknown' }
  const session = state.sessions[frame.routingId]
  if (!session) return { state, result: 'unknown' }
  let itemStreams: ItemStreams
  if (frame.op === 'replace') {
    // A replay is valid only at or after the last lifecycle event already
    // folded. Reads never advance that reliable-event watermark.
    if (frame.atSeq < session.itemStreamRevision) return { state, result: 'mismatch' }
    // The replay replaces values, not lifecycle. All opens must already have
    // arrived over the reliable lane. Never resurrect a sealed item.
    for (const [key, stream] of Object.entries(frame.streams)) {
      if (
        session.itemStreams[key]?.generation !== stream.generation ||
        !hasTarget(session, stream.target)
      )
        return { state, result: 'mismatch' }
    }
    itemStreams = frame.streams
  } else {
    const key = itemStreamKey(frame.target)
    const stream = session.itemStreams[key]
    if (!stream || stream.generation !== frame.generation) return { state, result: 'unknown' }
    if (stream.value.length !== frame.offset) return { state, result: 'mismatch' }
    itemStreams = {
      ...session.itemStreams,
      [key]: { ...stream, value: stream.value + frame.chunk }
    }
  }
  return {
    result: 'applied',
    state: {
      ...state,
      sessions: { ...state.sessions, [frame.routingId]: { ...session, itemStreams } }
    }
  }
}
/** Render-time projection only: never stores a second transcript. */
export function overlayItemStreams(
  messages: ChatMessage[],
  streams: ItemStreams,
  owner?: string
): ChatMessage[] {
  const entries = Object.values(streams).filter((s) => s.target.ownerToolUseId === owner)
  if (!entries.length) return messages
  return messages.map((message) => {
    const active = entries.filter((s) => s.target.messageId === message.id)
    if (!active.length) return message
    const content = message.content.map((block, index) => {
      const stream = active.find((s) => s.target.blockIndex === index)
      if (!stream || valueOf(block, stream.target.kind) === null) return block
      return block.type === 'tool_use'
        ? { ...block, toolInput: { ...block.toolInput, plan: stream.value } }
        : { ...block, text: stream.value }
    })
    return { ...message, content }
  })
}

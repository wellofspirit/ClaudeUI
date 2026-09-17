/** Item-addressed volatile text. Lifecycle is reliable; only appends are lossy. */
import type { ChatMessage, ContentBlock } from '../../../shared/types'
import { mergeContentBlocks } from '../../../shared/content-blocks'
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
}

export type ItemStreams = Record<string, ActiveItemStream>

export interface ItemStreamOpen {
  target: ItemStreamTarget
  message: ChatMessage
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
        typeof s.value === 'string'
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
      : { ...message, content: mergeContentBlocks(messages[index].content, message.content) }
  const next =
    index < 0 ? [...messages, merged] : messages.map((m, i) => (i === index ? merged : m))
  return owner
    ? { ...s, subagentMessages: { ...s.subagentMessages, [owner]: next } }
    : { ...s, messages: next }
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
          content: [...existing.content, ...data.message.content.slice(existing.content.length)]
        }
      : data.message
    // A reopen continues from the preserved scaffold. Starting from the incoming
    // empty block would make the overlay replace committed partial text with only
    // the new tail.
    const value = valueOf(scaffold.content[target.blockIndex], target.kind)
    if (value === null) return s
    const next = upsert(s, scaffold, target.ownerToolUseId)
    return {
      ...next,
      itemStreamRevision: seq,
      itemStreams: { ...s.itemStreams, [key]: { target, generation: seq, value } }
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
export function itemAppendFrame(
  s: CanonicalState,
  routingId: string,
  data: unknown,
  atSeq: number
): ItemStreamFrame | null {
  if (
    !isRecord(data) ||
    !isItemTarget(data.target) ||
    typeof data.chunk !== 'string' ||
    !data.chunk
  )
    return null
  const stream = s.sessions[routingId]?.itemStreams[itemStreamKey(data.target)]
  if (!stream) return null
  return {
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

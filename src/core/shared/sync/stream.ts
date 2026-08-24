/**
 * The VOLATILE STREAM LANE — SyncCore phase 5 S1 (ADR-051 contract 3).
 *
 * Streaming text/thinking deltas leave the event system here. They are not
 * events: no ring entry, no seq, no cursor, no catchup, no reducer branch. They
 * ride their own frame family (`{type:'stream', streamId, turnId, offset,
 * chunk}`) on both transports, are delivered only to connections that asked for
 * them (`stream:watch`), and are never logged — the accumulation in canonical
 * state is the whole summary of a delta stream, so replaying one is pointless
 * and, at 5000 ring entries, actively destructive (one turn of tokens flushed
 * the ring and forced a `sync-full` on every reconnect).
 *
 * ## This module is the ONE interpretation
 *
 * {@link applyStreamFrame} is folded by core (canonical state) and by the client
 * replica (`renderer/src/stores/replica.ts`), exactly as `applyEvent` is for the
 * event lane. The streamId scheme, the frame validation and the offset/turnId
 * guard live here once, so the server, both clients and the tests cannot drift
 * about what a frame means.
 *
 * ## Why a frame can be refused, and why that is safe
 *
 * `offset` is the accumulated length of that stream BEFORE the chunk, so a frame
 * whose offset does not match the local length is a frame that cannot be placed:
 * applying it anyway would silently corrupt the text. It is a NO-OP that returns
 * `'mismatch'`, and the client's cure is to re-send its `stream:watch` set —
 * which replays the coalesced value of EVERY stream of that session at
 * `offset: 0`, empty ones included. **`offset: 0` onto a non-empty buffer is a
 * REPLACE by construction**, which is what makes replay-on-subscribe the
 * self-heal (the same shape `terminal:attach`'s `replay: true` uses for a PTY).
 * The empty frames are what let it correct a buffer canonical CLEARED — see
 * {@link streamReplayFrames}.
 *
 * `turnId` is a per-stream generation, bumped whenever the event lane clears that
 * stream's accumulation (a message seal, a retraction, a conversation clear), or
 * DROPPED where that clear also retires the key (a subagent's message upsert). It
 * is redundant TODAY — frames are FIFO within a socket, and a cleared stream has
 * length 0 so the next chunk arrives at offset 0 and replaces anyway — but
 * contract 3 names it, and a mismatch on it is treated exactly like an offset
 * mismatch, so it costs nothing and buys the invariant when a future lane
 * reorders or coalesces.
 *
 * Electron-free and I/O-free by construction (lint-fenced), like the rest of
 * `shared/sync/`.
 */

import type { CanonicalSessionState, CanonicalState } from './state'
import type { ReducerAux } from './reducer'

// ---------------------------------------------------------------------------
// The wire frame
// ---------------------------------------------------------------------------

/** Which of a session's two buffers a stream carries. */
export type StreamKind = 'text' | 'thinking'

/**
 * One stream delta on the wire. Identical on both transports (WebSocket and the
 * desktop `MessagePort`), because they share frame shapes by design.
 *
 * On a tunnel connection this rides the ordinary server→client encrypt path like
 * every other frame. It is NEVER written to the audit log or any log — the same
 * rule `term-data` carries (security.md §Audit).
 */
export interface StreamFrame {
  type: 'stream'
  streamId: string
  /** Generation of this stream's accumulation; see the module note. */
  turnId: number
  /** Accumulated length (JS string units) of the stream BEFORE `chunk`. */
  offset: number
  chunk: string
}

/**
 * One PASS-THROUGH emission on the wire — the lane's second flavor (phase 5 S2).
 *
 * The three TAILS (`session:bash-output`, `session:background-output`,
 * `automation:stream-event`) are volatile for exactly the reason the deltas are —
 * a noisy command emits thousands of them and every one used to take a ring seq —
 * but they are NOT text-offset streams: they carry counters and objects
 * (`{toolUseId, output, totalLines, totalBytes}`), replace rather than
 * accumulate, and have no canonical field to accumulate INTO. Forcing them into
 * {@link StreamFrame}'s model would mean inventing an accumulation nothing reads.
 *
 * So they ride the lane verbatim: the emission `(channel, args)` exactly as the
 * emitter sent it, filtered by the same per-connection watch set, never ringed,
 * never logged, encrypted on tunnels like every frame. The client dispatches it
 * into the SAME per-channel listener registry the event lane uses, so the
 * existing listeners keep working unchanged — only the transport moved.
 *
 * **Honest-lossy, by contract.** There is no offset, so there is no replay and no
 * refetch: a chunk that was dropped (pre-ready, backpressure, an unwatched
 * moment) is simply gone. That is safe because a tail is a PREVIEW — the durable
 * record is the event lane's `session:tool-result` / `automation:run-message`,
 * which always survives, is ringed, and is what a reconnecting client replays.
 */
export interface StreamEventFrame {
  type: 'stream-ev'
  channel: string
  args: unknown[]
}

/** Either flavor of the volatile lane. Both transports carry both. */
export type LaneFrame = StreamFrame | StreamEventFrame

/** Structural validation for an inbound pass-through frame (single source). */
export function isStreamEventFrame(value: unknown): value is StreamEventFrame {
  if (!value || typeof value !== 'object') return false
  const f = value as Record<string, unknown>
  return f.type === 'stream-ev' && typeof f.channel === 'string' && Array.isArray(f.args)
}

/**
 * Cap on a connection's watch set.
 *
 * The same reasoning as `MAX_POOL_INDEX` (sync-core.md §Terminal): the payload is
 * an array a remote client chooses the length of, and the server keeps it for the
 * socket's lifetime, so an unbounded one is a main-process memory bomb reachable
 * from a single frame. 32 is far above any real client — the UI watches ONE
 * session — and small enough that 100 sockets cost nothing. Applied to EACH set
 * of a `stream:watch` (sessions, automations) independently.
 */
export const MAX_STREAM_WATCH = 32

/**
 * Per-connection outbound budget for the stream lane (phase 5 S2).
 *
 * The same high-water mark the remote PTY uses
 * (`REMOTE_BACKPRESSURE_HIGH_WATER_BYTES`, pty-manager.ts) — a socket queueing a
 * megabyte is not keeping up, and the frames behind it are being generated at
 * token rate. The PTY answers by pausing the child; a stream lane cannot pause an
 * LLM, so it DROPS instead, and only on this lane:
 *
 *  - a text-stream frame drops safely because the next delivered frame's offset
 *    will not match and the client's re-watch replays the coalesced value (the S1
 *    cure, already built);
 *  - a tail frame drops safely because it is lossy by contract, and its durable
 *    record rides the event lane;
 *  - the EVENT lane is never dropped. A missing event is a permanent hole in a
 *    seq-ordered stream, which is what the ring and the cursor exist to prevent.
 */
export const STREAM_BACKPRESSURE_BYTES = 1024 * 1024

/**
 * Structural validation for an inbound frame. The single source both transports
 * and the tests use: a decoder that hand-rolled this check would be a second
 * answer to "is this a stream frame".
 */
export function isStreamFrame(value: unknown): value is StreamFrame {
  if (!value || typeof value !== 'object') return false
  const f = value as Record<string, unknown>
  return (
    f.type === 'stream' &&
    typeof f.streamId === 'string' &&
    f.streamId !== '' &&
    typeof f.turnId === 'number' &&
    Number.isInteger(f.turnId) &&
    typeof f.offset === 'number' &&
    Number.isInteger(f.offset) &&
    f.offset >= 0 &&
    typeof f.chunk === 'string'
  )
}

// ---------------------------------------------------------------------------
// Stream identity
// ---------------------------------------------------------------------------

/**
 * `<routingId>/text`, `<routingId>/thinking`,
 * `<routingId>/sub/<toolUseId>/text`, `<routingId>/sub/<toolUseId>/thinking`.
 *
 * The routing id leads so a watch set can be matched by its first segment
 * without parsing the rest.
 */
export function streamIdFor(routingId: string, kind: StreamKind, toolUseId?: string): string {
  return toolUseId ? `${routingId}/sub/${toolUseId}/${kind}` : `${routingId}/${kind}`
}

export interface ParsedStreamId {
  routingId: string
  kind: StreamKind
  /** Present iff this is a subagent stream. */
  toolUseId?: string
}

/**
 * Parse from the RIGHT. A routing id is opaque (a temp id, or an engine session
 * id), so the fixed structure is the tail, not the head.
 */
export function parseStreamId(streamId: string): ParsedStreamId | null {
  const parts = streamId.split('/')
  if (parts.length < 2) return null
  const kind = parts[parts.length - 1]
  if (kind !== 'text' && kind !== 'thinking') return null
  if (parts.length >= 4 && parts[parts.length - 3] === 'sub') {
    const toolUseId = parts[parts.length - 2]
    const routingId = parts.slice(0, parts.length - 3).join('/')
    if (!routingId || !toolUseId) return null
    return { routingId, kind, toolUseId }
  }
  const routingId = parts.slice(0, parts.length - 1).join('/')
  if (!routingId) return null
  return { routingId, kind }
}

/** The session a frame belongs to — what the per-connection watch set filters on. */
export function sessionIdOfStream(streamId: string): string | null {
  return parseStreamId(streamId)?.routingId ?? null
}

/**
 * What a connection has to be watching to receive a pass-through frame.
 *
 * Two scopes, because the tails answer to two different selections: the two
 * session tails belong to the session the client is looking at (the same set
 * `stream:watch`'s `sessionIds` already carries), and the automation tail belongs
 * to the automation surface.
 *
 * **`automation:stream-event` is scoped by AUTOMATION, not by run.** Its payload
 * is `{automationId, type, text}` and carries no run id — the renderer derives
 * "is this the run I am viewing" from its own store (`useAutomationEvents`'s
 * `viewingLiveStream`), which it can still do because every frame is delivered
 * verbatim. Minting a per-run identity here would mean inventing one the emitter
 * does not have. The coarser granularity is recorded in
 * docs/architecture/sync-channels.md rather than papered over.
 *
 * Returns null for a payload that names no scope — a malformed emission, which is
 * dropped rather than broadcast.
 */
export type LaneScope = { kind: 'session'; id: string } | { kind: 'automation'; id: string }

export function streamEventScopeOf(frame: StreamEventFrame): LaneScope | null {
  if (frame.channel === 'automation:stream-event') {
    const data = frame.args[0] as { automationId?: unknown } | undefined
    return typeof data?.automationId === 'string' && data.automationId !== ''
      ? { kind: 'automation', id: data.automationId }
      : null
  }
  // Every other pass-through channel is `session:*` and session-scoped by
  // position (`args[0] = routingId`), the wire encoding contract 2 defines.
  const routingId = frame.args[0]
  return typeof routingId === 'string' && routingId !== ''
    ? { kind: 'session', id: routingId }
    : null
}

// ---------------------------------------------------------------------------
// Generations (turnId)
// ---------------------------------------------------------------------------

export function streamTurnOf(aux: ReducerAux, streamId: string): number {
  return aux.streamTurn[streamId] ?? 0
}

/**
 * A stream's accumulation was cleared: start a new generation.
 *
 * Called from the EVENT-lane reducer branches that blank a streaming buffer
 * (message seal, retraction, conversation clear, disconnect, subagent upsert), so
 * the next frame core emits already carries the new turnId.
 */
export function bumpStreamTurn(aux: ReducerAux, streamId: string): void {
  aux.streamTurn[streamId] = streamTurnOf(aux, streamId) + 1
}

/**
 * Drop ONE stream's generation instead of bumping it.
 *
 * Used where the clear also retires the KEY — a subagent whose message upsert (or
 * whose parent going idle) blanked its buffers. Bumping there would accrete two
 * entries per toolUseId for the session's whole life, and toolUseIds are minted
 * per tool call.
 *
 * Sound because a missing key reads as generation 0 and BOTH folds drop it: the
 * clears live on the event lane, which every replica receives whether or not it
 * is watching. A later delta for the same toolUseId — a multi-turn subagent does
 * emit after its first message — is therefore computed against 0 on the host and
 * judged against 0 on the client, and its buffer is empty on both sides, so it
 * arrives at offset 0 and appends.
 */
export function dropStreamTurn(aux: ReducerAux, streamId: string): void {
  delete aux.streamTurn[streamId]
}

/** Drop every generation belonging to a session (an explicit removal). */
export function dropStreamTurns(aux: ReducerAux, routingId: string): void {
  const prefix = `${routingId}/`
  for (const key of Object.keys(aux.streamTurn)) {
    if (key.startsWith(prefix)) delete aux.streamTurn[key]
  }
}

/** Carry a session's generations across a rekey, so no frame looks stale. */
export function rekeyStreamTurns(aux: ReducerAux, oldId: string, newId: string): void {
  if (oldId === newId) return
  const prefix = `${oldId}/`
  for (const key of Object.keys(aux.streamTurn)) {
    if (!key.startsWith(prefix)) continue
    aux.streamTurn[`${newId}/${key.slice(prefix.length)}`] = aux.streamTurn[key]
    delete aux.streamTurn[key]
  }
}

// ---------------------------------------------------------------------------
// Reading / writing the accumulations
// ---------------------------------------------------------------------------

function readStream(session: CanonicalSessionState, p: ParsedStreamId): string {
  if (p.toolUseId) {
    return p.kind === 'thinking'
      ? (session.subagentStreamingThinking[p.toolUseId] ?? '')
      : (session.subagentStreamingText[p.toolUseId] ?? '')
  }
  return p.kind === 'thinking' ? session.streamingThinking : session.streamingText
}

function writeStream(
  session: CanonicalSessionState,
  p: ParsedStreamId,
  value: string
): Partial<CanonicalSessionState> {
  if (p.toolUseId) {
    return p.kind === 'thinking'
      ? {
          subagentStreamingThinking: { ...session.subagentStreamingThinking, [p.toolUseId]: value }
        }
      : { subagentStreamingText: { ...session.subagentStreamingText, [p.toolUseId]: value } }
  }
  return p.kind === 'thinking' ? { streamingThinking: value } : { streamingText: value }
}

function withSession(
  state: CanonicalState,
  routingId: string,
  patch: Partial<CanonicalSessionState>
): CanonicalState {
  const session = state.sessions[routingId]
  if (!session) return state
  return {
    ...state,
    sessions: { ...state.sessions, [routingId]: { ...session, ...patch } }
  }
}

// ---------------------------------------------------------------------------
// Emitter payload → frame
// ---------------------------------------------------------------------------

/**
 * Translate one volatile emission (`(routingId, delta)`, exactly what
 * `BaseSession.send` has always sent) into the frame the lane carries.
 *
 * Reads the CURRENT accumulation for the offset and the CURRENT generation for
 * the turnId, so it must be called before {@link applyStreamFrame}. Returns null
 * for a payload that names no stream — a malformed delta, or a delta for a
 * session canonical has never met, both of which the deleted reducer branches
 * treated as honest no-ops.
 */
export function streamFrameFrom(
  state: CanonicalState,
  aux: ReducerAux,
  channel: string,
  args: unknown[]
): StreamFrame | null {
  const routingId = typeof args[0] === 'string' ? args[0] : null
  if (!routingId) return null
  const data = args[1] as { type?: unknown; text?: unknown; toolUseId?: unknown } | undefined
  if (!data || typeof data.text !== 'string') return null
  const kind: StreamKind = data.type === 'thinking' ? 'thinking' : 'text'

  let streamId: string
  if (channel === 'session:subagent-stream') {
    if (typeof data.toolUseId !== 'string' || data.toolUseId === '') return null
    streamId = streamIdFor(routingId, kind, data.toolUseId)
  } else if (channel === 'session:stream') {
    streamId = streamIdFor(routingId, kind)
  } else {
    return null
  }

  const session = state.sessions[routingId]
  if (!session) return null
  const parsed = parseStreamId(streamId)!
  return {
    type: 'stream',
    streamId,
    turnId: streamTurnOf(aux, streamId),
    offset: readStream(session, parsed).length,
    chunk: data.text
  }
}

/**
 * Frame → the EMISSION shape the emitters use (`(channel, routingId, delta)`).
 *
 * The inverse of {@link streamFrameFrom}, and the only sanctioned one. It exists
 * for the in-process observers that were subscribers of these channels BEFORE
 * they left the event lane — the ADR-005 plugin bridge, and the engine tests'
 * stub window — so their contract is unchanged by a lane change they have no
 * part in. Clients never use it: they fold {@link applyStreamFrame}, which is
 * the whole point of the offsets.
 *
 * Lossless for its purpose: a frame carries exactly what the emitter sent plus
 * an offset, and a plugin's `session:stream` payload was never anything but
 * `{type, text}`.
 */
export function streamFrameToEmission(
  frame: StreamFrame
): { channel: string; routingId: string; data: Record<string, unknown> } | null {
  const parsed = parseStreamId(frame.streamId)
  if (!parsed) return null
  return parsed.toolUseId
    ? {
        channel: 'session:subagent-stream',
        routingId: parsed.routingId,
        data: { type: parsed.kind, toolUseId: parsed.toolUseId, text: frame.chunk }
      }
    : {
        channel: 'session:stream',
        routingId: parsed.routingId,
        data: { type: parsed.kind, text: frame.chunk }
      }
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

/**
 * The whole session's accumulations, as `offset: 0` REPLACE frames — **including
 * the empty ones**.
 *
 * This is what a `stream:watch` pushes immediately, and it is the lane's whole
 * self-heal: a client that reconnects re-watches (subscriptions are
 * per-connection and die with the socket), and a client that detects an
 * offset/turnId mismatch re-sends the same watch set.
 *
 * **Empty accumulations must be stated, not omitted.** A replay is a claim about
 * the SESSION, not about the streams that happen to be non-empty in it. Skipping
 * an empty one leaves a buffer canonical CLEARED uncorrectable by re-watching,
 * and that is reachable by ordinary use: watch a session mid-thinking-span,
 * switch away, its first text delta seals the span on canonical, switch back —
 * the replica keeps a phantom thinking block above the assistant text (and an
 * open span, so its ticker keeps running) until the next message seal. The
 * subagent form is one switch away, since subagent text supersedes its thinking
 * on every chunk.
 *
 * Bounded by real subagent use: one frame per session-level stream plus two per
 * toolUseId this session has actually streamed, and the maps are per-session.
 */
export function streamReplayFrames(
  state: CanonicalState,
  aux: ReducerAux,
  routingId: string
): StreamFrame[] {
  const session = state.sessions[routingId]
  if (!session) return []
  const frames: StreamFrame[] = []
  const push = (streamId: string, chunk: string): void => {
    frames.push({ type: 'stream', streamId, turnId: streamTurnOf(aux, streamId), offset: 0, chunk })
  }
  // TEXT BEFORE THINKING, and the order is load-bearing. A text frame landing on
  // an EMPTY local buffer takes the append path, which seals whatever thinking
  // span this replica believes is open. Replaying thinking first would hand that
  // seal the value it had just restored; replaying it second means the seal
  // happens against the stale buffer and the fresh thinking lands on top —
  // leaving exactly the (text, thinking) pair canonical holds.
  push(streamIdFor(routingId, 'text'), session.streamingText)
  push(streamIdFor(routingId, 'thinking'), session.streamingThinking)
  // Every toolUseId either map knows about — a subagent whose text was cleared
  // still has a key, and a subagent the replica holds stale content for is
  // exactly the one whose key canonical also has.
  const toolUseIds = new Set([
    ...Object.keys(session.subagentStreamingText),
    ...Object.keys(session.subagentStreamingThinking)
  ])
  for (const toolUseId of toolUseIds) {
    push(streamIdFor(routingId, 'text', toolUseId), session.subagentStreamingText[toolUseId] ?? '')
    push(
      streamIdFor(routingId, 'thinking', toolUseId),
      session.subagentStreamingThinking[toolUseId] ?? ''
    )
  }
  return frames
}

// ---------------------------------------------------------------------------
// applyStreamFrame — the ONE interpretation
// ---------------------------------------------------------------------------

export type StreamApplyResult =
  /** Folded into state. */
  | 'applied'
  /** Offset or generation did not match — nothing changed; re-watch to heal. */
  | 'mismatch'
  /** Malformed frame, or a session this replica does not know. Nothing changed. */
  | 'unknown'

export interface StreamApplyOutcome {
  state: CanonicalState
  result: StreamApplyResult
}

/**
 * Fold one stream frame into canonical state. Pure in the same sense
 * `applyEvent` is: no clock, no randomness, `aux` mutated in place.
 *
 * The thinking-span bookkeeping (`aux.thinkingOpen`) belongs here rather than in
 * the reducer, because the deltas are what open and seal a span: a thinking chunk
 * opens it, and the first APPENDED text chunk seals it (blanking the thinking
 * buffer and starting its next generation). A REPLACE frame is a statement about
 * its own stream only — it never seals the other one, or a replay of a thinking
 * buffer would be wiped by the text replay that follows it in the same burst.
 */
export function applyStreamFrame(
  state: CanonicalState,
  aux: ReducerAux,
  frame: StreamFrame
): StreamApplyOutcome {
  if (!isStreamFrame(frame)) return { state, result: 'unknown' }
  const parsed = parseStreamId(frame.streamId)
  if (!parsed) return { state, result: 'unknown' }
  const session = state.sessions[parsed.routingId]
  if (!session) return { state, result: 'unknown' }

  const current = readStream(session, parsed)
  if (frame.offset === 0) {
    // Offset 0 ADOPTS the sender's generation rather than checking it. Core is
    // authoritative about both, and a replica that folded the event lane for a
    // session it was NOT watching legitimately holds a different generation (the
    // text deltas never arrived, so the seals they imply never happened). Making
    // the frame conditional on agreeing about the number it exists to correct
    // would wedge exactly that client in a re-watch loop.
    aux.streamTurn[frame.streamId] = frame.turnId
  } else {
    if (frame.turnId !== streamTurnOf(aux, frame.streamId)) return { state, result: 'mismatch' }
    if (frame.offset !== current.length) return { state, result: 'mismatch' }
  }

  // A REPLACE is `offset: 0` onto a NON-EMPTY buffer — i.e. a replay correcting a
  // value this replica already has. `offset: 0` onto an empty buffer is just the
  // first chunk of a turn, and must carry the ordinary append semantics below (it
  // is what SEALS an open thinking span). Conflating the two would mean no turn's
  // first text delta ever sealed anything.
  const replace = frame.offset === 0 && current.length > 0
  const value = frame.offset === 0 ? frame.chunk : current + frame.chunk
  let patch = writeStream(session, parsed, value)
  // A replay states every stream, empty ones included, so most frames of a watch
  // land on a value the replica already holds. Track whether anything actually
  // moved: the projection is identity-diffed, and returning a fresh object for a
  // no-op would re-write (and re-render) the whole session entry per frame.
  let changed = value !== current

  if (parsed.kind === 'thinking') {
    if (!parsed.toolUseId) {
      // Derived, never guessed: "a span is open" IS "there is unsealed thinking
      // output", the same equivalence `auxFromCanonical` restores a snapshot from.
      // A replay carrying `''` is therefore what CLOSES a span the replica still
      // believes is open — the phantom-ticker half of the empty-frame fix.
      aux.thinkingOpen[parsed.routingId] = value !== ''
    }
  } else if (!replace) {
    const thinkingId = streamIdFor(parsed.routingId, 'thinking', parsed.toolUseId)
    if (parsed.toolUseId) {
      // A subagent's text output supersedes its thinking, on every chunk — the
      // rule the deleted `session:subagent-stream` branch applied unconditionally.
      if (session.subagentStreamingThinking[parsed.toolUseId]) {
        patch = {
          ...patch,
          subagentStreamingThinking: {
            ...session.subagentStreamingThinking,
            [parsed.toolUseId]: ''
          }
        }
        bumpStreamTurn(aux, thinkingId)
        changed = true
      }
    } else if (aux.thinkingOpen[parsed.routingId] === true) {
      patch = { ...patch, streamingThinking: '' }
      aux.thinkingOpen[parsed.routingId] = false
      bumpStreamTurn(aux, thinkingId)
      // OR, never assign: this branch must not clobber a `changed` the text
      // write above already earned, or that write would be silently discarded.
      changed = changed || session.streamingThinking !== ''
    }
  }

  if (!changed) return { state, result: 'applied' }
  return { state: withSession(state, parsed.routingId, patch), result: 'applied' }
}

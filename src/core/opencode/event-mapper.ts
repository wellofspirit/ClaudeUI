/**
 * opencode 2.x event feed → ClaudeUI's engine-neutral session stream (ADR-097
 * S4).
 *
 * One mapper per ClaudeUI chat. It follows the chat's own opencode session and
 * every subagent child linked under it, and ignores the rest of the feed (one
 * 2.x server serves every chat and directory, so foreign sessions are normal).
 * `map(event)` returns the outputs that event produces, in order; the session
 * dispatches them. The mapper does the bookkeeping — tool results,
 * child-task outcomes, idempotency — so the consumer is a switch.
 *
 * Content model (mirrors opencode's own projection, `core/src/session/
 * message-updater.ts`, so live and cold agree by construction):
 * - one assistant ChatMessage per STEP (`assistantMessageID`), timestamped
 *   with the step's `started`;
 * - its blocks in `*.started` order: text, thinking, tool_use. A text or
 *   thinking block is placed when it first has content, so an empty one
 *   (OpenAI's encrypted-only reasoning, an empty text start) never renders —
 *   the cold converter drops the same empty items;
 * - `text`/`reasoning` ordinals count per kind within a step (each kind has its
 *   own counter in `runner/publish-llm-event.ts`);
 * - tool results travel as `tool-result` outputs and the reducer appends them,
 *   as for every engine.
 *
 * Turn ends (ADR-090): `succeeded` → `result`; `failed` → `error` (or
 * `auth-required` for `provider.auth`); `interrupted` → `stopped` with its
 * reason. `reason:'shutdown'` after a REJECT in the same turn is a denial-ended
 * turn (`stopped/denied`: a reject without a message is a hard stop, ADR-097
 * §3), never a server shutdown nor a user stop.
 *
 * Reconnects: the feed has no replay (`opencode-event-stream.ts`). On
 * `connected {reconnected:true}` the consumer reads a {@link
 * OpencodeReconnectSnapshot} (`reconnect.ts`) and passes it to
 * `reconcile`, which emits what the gap hid and marks it handled, so the live
 * events that follow (which the read may already reflect) are applied
 * idempotently — by message id, tool call id, request/form id, inbox id and
 * the terminal event's idle-row id.
 */
import type {
  ChatMessage,
  ContentBlock,
  PendingApproval,
  PermissionDenialBlock,
  PermissionSuggestion,
  TaskNotification
} from '../../shared/types'
import type { ItemStreamOpen, ItemStreamSeal, ItemStreamTarget } from '../shared/sync/item-stream'
import type {
  Form_Info,
  Model_Ref,
  Permission_Request,
  SessionActive,
  Session_Inbox_Delivery,
  Session_Inbox_Info,
  Session_Message_Assistant,
  Session_Message_Info,
  Session_StructuredError,
  TokenUsage_Info,
  Tool_Content
} from './protocol-v2/openapi'
import type { EventOf, OpencodeEvent, SessionInboxItem } from './protocol-v2/events'
import { eventSessionID } from './protocol-v2/events'
import { reviewRationale } from '../shared/tool-review'
import {
  compactionChatMessage,
  formQuestions,
  formToolCall,
  messageIdFromEvent,
  type OpencodeFormField,
  type OpencodeToolResult,
  SHELL_TOOL_NAMES,
  subagentBackgrounded,
  subagentChildSession,
  SUBAGENT_TOOL_NAMES,
  toolFailureResult,
  toolInputRecord,
  toolSuccessResult,
  userChatMessage
} from './content'

// --- Outputs ----------------------------------------------------------------

/** Per-step metering: one per assistant message (step), own or child. */
export interface OpencodeStepUsage {
  readonly messageId: string
  /** The opencode session that ran the step (a child's own id for a subagent step). */
  readonly sessionId: string
  /** Set on a child step: the parent call it runs under. */
  readonly ownerToolUseId?: string
  readonly model?: Model_Ref
  readonly cost: number
  /** Per step, disjoint (opencode subtracts cache from input; reasoning sits beside output). */
  readonly tokens: TokenUsage_Info
  readonly finish?: string
}

/** Why a turn stopped without succeeding or failing (ADR-090). */
export type OpencodeStopReason =
  /** The user's Stop (`POST /interrupt`). */
  | 'user'
  /** A reject without a message ended it (its call failed `aborted`, then `interrupted{shutdown}`). */
  | 'denied'
  /** A form (question) cancelled without a message ended it, the same way. */
  | 'form-cancelled'
  /** The engine is shutting down; it resumes the turn on its next start. */
  | 'shutdown'
  | 'superseded'
  | 'inactivity'
  /** Read back after a reconnect: the stored `idle{interrupted}` row records no reason. */
  | 'unknown'

/** What a reply to an `approval` needs beyond `PendingApproval`. */
export interface OpencodeApprovalRoute {
  /** The session the request belongs to — a child's own id for a subagent ask. Replies go there. */
  readonly sessionID: string
  /** Present for a form (`form.created`): reply with `{answer: {<key>: value}}`. */
  readonly form?: { readonly formID: string; readonly fields: readonly OpencodeFormField[] }
}

export type OpencodeInboxChange =
  | {
      readonly change: 'enqueued'
      readonly inboxID: string
      readonly delivery: Session_Inbox_Delivery
      readonly item: SessionInboxItem
    }
  | { readonly change: 'delivered'; readonly inboxID: string }
  | { readonly change: 'cancelled'; readonly inboxID: string }
  | {
      readonly change: 'delivery-changed'
      readonly inboxID: string
      readonly delivery: Session_Inbox_Delivery
    }

export type OpencodeMapperOutput =
  /** The own session started executing (a prompt, a steer, a queued item, a compaction). */
  | { readonly kind: 'turn-start' }
  /** `session:item-open`; `open.target.ownerToolUseId` set for a child item. */
  | { readonly kind: 'item-open'; readonly open: ItemStreamOpen }
  /** `session:item-delta`. */
  | { readonly kind: 'item-delta'; readonly target: ItemStreamTarget; readonly chunk: string }
  /** `session:item-seal`. */
  | { readonly kind: 'item-seal'; readonly seal: ItemStreamSeal }
  /** `session:message` (own) / `session:subagent-message` (child, `ownerToolUseId`). */
  | { readonly kind: 'message'; readonly message: ChatMessage; readonly ownerToolUseId?: string }
  /** A user prompt reached the own session; its id is the inbox id (ClaudeUI's when it chose one). */
  | { readonly kind: 'user-message'; readonly inboxID: string; readonly message: ChatMessage }
  /** A tool's arguments streaming in (optional live rendering). */
  | {
      readonly kind: 'tool-input-delta'
      readonly toolUseId: string
      readonly delta: string
      readonly ownerToolUseId?: string
    }
  /** `session:tool-result` (own) / `session:subagent-tool-result` (child). */
  | {
      readonly kind: 'tool-result'
      readonly result: OpencodeToolResult
      readonly ownerToolUseId?: string
    }
  /** A deny RULE inside opencode refused the call with no ask (ADR-022). Host rejects send their own. */
  | {
      readonly kind: 'permission-denial'
      readonly toolUseId: string
      readonly denial: PermissionDenialBlock
      readonly ownerToolUseId?: string
    }
  /** A shell call is running: poll `GET /api/shell/{shellID}/output` for live output (2.x pushes none). */
  | {
      readonly kind: 'shell-started'
      readonly toolUseId: string
      readonly shellID: string
      readonly ownerToolUseId?: string
    }
  /** A subagent call started (or resumed) its child session; its events now route under `toolUseId`. */
  | {
      readonly kind: 'subagent-started'
      readonly toolUseId: string
      readonly childSessionId: string
      readonly ownerToolUseId?: string
    }
  /** The ONE terminal notification of a subagent call (foreground: its tool result; background: the child's end). */
  | { readonly kind: 'task-notification'; readonly notification: TaskNotification }
  | {
      readonly kind: 'approval'
      readonly approval: PendingApproval
      readonly route: OpencodeApprovalRoute
    }
  /** A request or form was settled (ours, a cascade, another client): retract its card. */
  | { readonly kind: 'approval-resolved'; readonly requestId: string }
  | { readonly kind: 'step-usage'; readonly usage: OpencodeStepUsage }
  /** Session-cumulative usage (includes title/compaction requests opencode ran). */
  | { readonly kind: 'session-usage'; readonly cost: number; readonly tokens: TokenUsage_Info }
  | {
      readonly kind: 'retry'
      readonly attempt: number
      /** Epoch ms of the next attempt. */
      readonly at: number
      readonly error: Session_StructuredError
    }
  | {
      readonly kind: 'compaction'
      readonly phase: 'started' | 'ended' | 'failed'
      readonly reason: 'auto' | 'manual'
      readonly error?: Session_StructuredError
      /** The compaction request's own usage (opencode bills it to the session; not context). */
      readonly usage?: {
        readonly cost: number
        readonly tokens: TokenUsage_Info
        readonly model?: Model_Ref
      }
      /** Set for a child's compaction (only its usage is reported). */
      readonly ownerToolUseId?: string
    }
  /**
   * Own-session usage no step or compaction carries (title generation),
   * from the session's cumulative. Counted in the headline like the rest.
   */
  | {
      readonly kind: 'overhead-usage'
      readonly cost: number
      readonly tokens: TokenUsage_Info
    }
  | ({ readonly kind: 'inbox' } & OpencodeInboxChange)
  | { readonly kind: 'session-renamed'; readonly title: string }
  | { readonly kind: 'model-selected'; readonly model: Model_Ref }
  | { readonly kind: 'agent-selected'; readonly agent: string }
  | { readonly kind: 'session-deleted' }
  | { readonly kind: 'result'; readonly sessionId: string; readonly durationMs: number }
  | {
      readonly kind: 'stopped'
      readonly sessionId: string
      readonly reason: OpencodeStopReason
      readonly durationMs: number
    }
  | {
      readonly kind: 'error'
      readonly sessionId: string
      readonly message: string
      readonly errorType: string
      readonly durationMs: number
    }
  | {
      readonly kind: 'auth-required'
      readonly sessionId: string
      /** opencode's provider id (`openai`, `openrouter`, …) of the model that failed. */
      readonly vendorId: string
      readonly message: string
      readonly durationMs: number
    }

/** What a reconnect re-reads (`reconnect.ts` builds it). */
export interface OpencodeReconnectSnapshot {
  /** Per followed session: the own one and every linked child. */
  readonly sessions: Readonly<
    Record<
      string,
      {
        readonly messages: readonly Session_Message_Info[]
        readonly permissions: readonly Permission_Request[]
        readonly forms: readonly Form_Info[]
        /** Own session only. */
        readonly inbox?: readonly Session_Inbox_Info[]
      }
    >
  >
  /** `GET /api/session/active`: absent means idle. */
  readonly active: Readonly<Record<string, SessionActive>>
}

export interface OpencodeEventMapperOptions {
  /** The ClaudeUI chat's opencode session. */
  readonly sessionID: string
  /** The session's model when known up front (names the vendor of a `provider.auth` failure). */
  readonly model?: Model_Ref
  /** The "always allow" suggestion for an own-session ask (S5 wires `suggestOpencodeAllowRule`). */
  readonly suggest?: (
    action: string,
    resources: readonly string[]
  ) => PermissionSuggestion | null | undefined
}

// --- State ------------------------------------------------------------------

interface ItemState {
  readonly kind: 'text' | 'reasoning' | 'tool'
  readonly ordinal?: number
  readonly toolId?: string
  text: string
  ended: boolean
  /** Block index in the message, once it has content (tools: at once). */
  index: number | null
  /** An item stream is open for it. */
  open: boolean
  /** Deltas were missed (reconnect): show nothing more until its `ended`. */
  gapped: boolean
  startedAt?: number
  durationMs?: number
}

interface MessageState {
  readonly id: string
  /**
   * The subagent call this (child) step ran under, fixed when the step is
   * first seen: a child resumed by a later call keeps its earlier steps under
   * the earlier call.
   */
  readonly owner?: string
  timestamp: number
  model?: Model_Ref
  readonly items: ItemState[]
  readonly blocks: ContentBlock[]
  metered: boolean
}

interface ToolState {
  readonly id: string
  name: string
  readonly message: MessageState
  input: Record<string, unknown>
  settled: boolean
  /** A permission ask was raised for this call (so a rejection is the host's, not a rule's). */
  asked: boolean
  shellID?: string
  childSession?: string
  /** When the call started (`tool.called`, = the stored part's `time.ran`). */
  startedAt?: number
}

interface SessionState {
  readonly id: string
  /** The parent call a child runs under; undefined for the own session. */
  owner?: string
  model?: Model_Ref
  running: boolean
  turnStartedAt?: number
  /**
   * Calls of the running execution the host declined WITHOUT a message: a
   * messageless reject (`DeclinedError`) or a messageless form cancel
   * (`QuestionTool.CancelledError`). Either dies as a self-interrupt that ends
   * the turn `interrupted{shutdown}` (`runner/step.ts`), and its tool fails
   * `aborted`; a reject or cancel WITH a message fails the tool with that
   * message and the turn goes on.
   */
  readonly declined: Map<string, 'denied' | 'form-cancelled'>
  /** Set when a declined call failed `aborted`: how a following `shutdown` end reads. */
  armedStop?: 'denied' | 'form-cancelled'
  /** A reconnect ended the turn without an idle row (shutdown): drop the late terminal event. */
  endedWithoutIdle: boolean
  /** Background child: its own end is the call's terminal notification. */
  background: boolean
  /** The terminal notification for the current call went out. */
  notified: boolean
  /** A child that ended before its call said it went to the background (the outcome waits for it). */
  endedAs?: TaskNotification['status']
  readonly messages: Map<string, MessageState>
  readonly tools: Map<string, ToolState>
  readonly idleSeen: Set<string>
  readonly usersSeen: Set<string>
  readonly compactionsSeen: Set<string>
  readonly inbox: Map<string, Session_Inbox_Delivery>
  readonly inboxItems: Map<string, SessionInboxItem>
  compactionId?: string
  compactionStartedAt?: number
  /**
   * The last compaction a re-read found settled: its live end may still
   * arrive without the start that names it (`compaction.ended` carries no id).
   */
  compactionFromRead?: string
  /** Compactions whose request usage went out (by compaction id). */
  readonly compactionsMetered: Set<string>
}

const PENDING_CHILD_BUFFER = 1_000

function newSession(id: string, owner?: string): SessionState {
  return {
    id,
    owner,
    running: false,
    declined: new Map(),
    endedWithoutIdle: false,
    background: false,
    notified: false,
    messages: new Map(),
    tools: new Map(),
    idleSeen: new Set(),
    usersSeen: new Set(),
    compactionsSeen: new Set(),
    compactionsMetered: new Set(),
    inbox: new Map(),
    inboxItems: new Map()
  }
}

type Out = OpencodeMapperOutput[]

interface Usage {
  readonly cost: number
  readonly tokens: TokenUsage_Info
}
const ZERO_USAGE: Usage = {
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    cost: a.cost + b.cost,
    tokens: {
      input: a.tokens.input + b.tokens.input,
      output: a.tokens.output + b.tokens.output,
      reasoning: a.tokens.reasoning + b.tokens.reasoning,
      cache: {
        read: a.tokens.cache.read + b.tokens.cache.read,
        write: a.tokens.cache.write + b.tokens.cache.write
      }
    }
  }
}

function subtractUsage(a: Usage, b: Usage): Usage {
  const neg = (u: Usage): Usage => ({
    cost: -u.cost,
    tokens: {
      input: -u.tokens.input,
      output: -u.tokens.output,
      reasoning: -u.tokens.reasoning,
      cache: { read: -u.tokens.cache.read, write: -u.tokens.cache.write }
    }
  })
  return addUsage(a, neg(b))
}

/** Field-wise max(0, x); undefined when nothing is left (cost below a nano-dollar, no token). */
function positivePart(u: Usage): Usage | undefined {
  const p = (x: number) => (x > 0 ? x : 0)
  const out: Usage = {
    cost: u.cost > 1e-9 ? u.cost : 0,
    tokens: {
      input: p(u.tokens.input),
      output: p(u.tokens.output),
      reasoning: p(u.tokens.reasoning),
      cache: { read: p(u.tokens.cache.read), write: p(u.tokens.cache.write) }
    }
  }
  const t = out.tokens
  return out.cost > 0 || t.input || t.output || t.reasoning || t.cache.read || t.cache.write
    ? out
    : undefined
}

/** Where a turn ending at `idle` began: its first row after the previous idle. */
function turnStart(
  rows: readonly Session_Message_Info[],
  idle: Extract<Session_Message_Info, { type: 'idle' }>
): number {
  const end = rows.indexOf(idle)
  let start = idle.time.created
  for (let i = end - 1; i >= 0 && rows[i].type !== 'idle'; i--) start = rows[i].time.created
  return start
}

function compactionUsage(
  cost: number | undefined,
  tokens: TokenUsage_Info | undefined,
  model?: Model_Ref
): { usage?: { cost: number; tokens: TokenUsage_Info; model?: Model_Ref } } {
  if (cost === undefined || tokens === undefined) return {}
  return { usage: { cost, tokens, ...(model ? { model } : {}) } }
}

// --- Mapper -----------------------------------------------------------------

export class OpencodeEventMapper {
  readonly sessionID: string
  private readonly own: SessionState
  /** Linked children (and grandchildren), by their own session id. */
  private readonly children = new Map<string, SessionState>()
  /** Announced (`session.created` with a followed parent) but not yet linked to a call. */
  private readonly pending = new Map<string, { parentID: string; buffer: OpencodeEvent[] }>()
  /** Every call that ran a child, in start order (a resumed child has several). */
  private readonly childCalls = new Map<string, { toolId: string; start?: number }[]>()
  /** Open approval cards: request/form id → the asking session and the call it is about. */
  private readonly approvals = new Map<string, { sessionID: string; callID?: string }>()
  private readonly suggest: OpencodeEventMapperOptions['suggest']
  /** `seed()` replays settled history: it must not follow every old child. */
  private seeding = false
  /** Rows from a re-read are being applied (provenance the feed would have told is unknown). */
  private reading = false
  /** Own-session usage already reported (see `emitOverhead`). */
  private accounted: Usage = ZERO_USAGE
  /** The own session's last cumulative usage (`session.usage.updated`). */
  private cumulative?: Usage

  constructor(options: OpencodeEventMapperOptions) {
    this.sessionID = options.sessionID
    this.own = newSession(options.sessionID)
    this.own.model = options.model
    this.suggest = options.suggest
  }

  /**
   * The sessions a reconnect must re-read: the own one, then every linked
   * child whose call has not settled (a settled child has nothing left to
   * say; it is still routed if a later call resumes it).
   */
  followedSessions(): string[] {
    const live = [...this.children.values()].filter((child) => child.running || !child.notified)
    return [this.sessionID, ...live.map((child) => child.id)]
  }

  /**
   * Forget every open approval/form without retracting anything (no
   * outputs): the host dropped its cards (a lost connection), so the next
   * re-read must announce the requests that are still pending again instead of
   * taking them as already shown.
   */
  forgetRequests(): void {
    this.approvals.clear()
  }

  /** True between the own session's `execution.started` and its end. */
  get running(): boolean {
    return this.own.running
  }

  // ── Live events ────────────────────────────────────────────────────────────

  map(event: OpencodeEvent): OpencodeMapperOutput[] {
    if (event.type === 'server.connected') return []
    const sessionID = eventSessionID(event)
    if (!sessionID) return []
    if (event.type === 'session.created') return this.announce(event)
    const session = this.sessionOf(sessionID)
    if (!session) {
      const pending = this.pending.get(sessionID)
      if (pending && pending.buffer.length < PENDING_CHILD_BUFFER) pending.buffer.push(event)
      return []
    }
    const out: Out = []
    this.apply(session, event, out)
    return out
  }

  private sessionOf(sessionID: string): SessionState | undefined {
    return sessionID === this.sessionID ? this.own : this.children.get(sessionID)
  }

  /** A child of a followed session was created: hold its events until a call links it. */
  private announce(event: EventOf<'session.created'>): Out {
    const { sessionID, parentID } = event.data
    if (sessionID === this.sessionID) {
      if (event.data.model) this.own.model = event.data.model
      return []
    }
    if (!parentID || !this.sessionOf(parentID) || this.children.has(sessionID)) return []
    if (!this.pending.has(sessionID)) this.pending.set(sessionID, { parentID, buffer: [] })
    return []
  }

  private apply(s: SessionState, event: OpencodeEvent, out: Out): void {
    const own = s === this.own
    switch (event.type) {
      case 'session.step.started': {
        const { assistantMessageID, model, started } = event.data
        const message = this.messageOf(s, assistantMessageID, started)
        message.timestamp = started
        message.model = model
        s.model = model
        return
      }
      case 'session.text.started':
      case 'session.reasoning.started': {
        const kind = event.type === 'session.text.started' ? 'text' : 'reasoning'
        const message = this.messageOf(s, event.data.assistantMessageID, event.created)
        if (!this.itemByOrdinal(message, kind, event.data.ordinal))
          message.items.push({
            kind,
            ordinal: event.data.ordinal,
            text: '',
            ended: false,
            index: null,
            open: false,
            gapped: false,
            ...(kind === 'reasoning' ? { startedAt: event.created } : {})
          })
        return
      }
      case 'session.text.delta':
      case 'session.reasoning.delta': {
        const kind = event.type === 'session.text.delta' ? 'text' : 'reasoning'
        const message = s.messages.get(event.data.assistantMessageID)
        const item = message && this.itemByOrdinal(message, kind, event.data.ordinal)
        // A delta of an item whose start we never saw (reconnect gap): wait for its end.
        if (!message || !item) {
          if (message)
            message.items.push({
              kind,
              ordinal: event.data.ordinal,
              text: '',
              ended: false,
              index: null,
              open: false,
              gapped: true
            })
          return
        }
        this.appendDelta(message, item, event.data.delta, out)
        return
      }
      case 'session.text.ended':
      case 'session.reasoning.ended': {
        const kind = event.type === 'session.text.ended' ? 'text' : 'reasoning'
        const message = this.messageOf(s, event.data.assistantMessageID, event.created)
        let item = this.itemByOrdinal(message, kind, event.data.ordinal)
        if (!item) {
          item = {
            kind,
            ordinal: event.data.ordinal,
            text: '',
            ended: false,
            index: null,
            open: false,
            gapped: false
          }
          message.items.push(item)
        }
        if (item.ended) return
        if (kind === 'reasoning' && item.startedAt !== undefined)
          item.durationMs = Math.max(0, event.created - item.startedAt)
        this.endItem(message, item, event.data.text, out)
        return
      }
      case 'session.tool.input.started': {
        const message = this.messageOf(s, event.data.assistantMessageID, event.created)
        this.toolOf(s, message, event.data.id, event.data.name, out)
        return
      }
      case 'session.tool.input.delta': {
        const tool = s.tools.get(event.data.id)
        if (!tool) return
        out.push({
          kind: 'tool-input-delta',
          toolUseId: event.data.id,
          delta: event.data.delta,
          ...this.ownerOf(tool.message)
        })
        return
      }
      case 'session.tool.input.ended':
        return
      case 'session.tool.called': {
        const message = this.messageOf(s, event.data.assistantMessageID, event.created)
        const tool = this.toolOf(s, message, event.data.id, undefined, out)
        tool.startedAt ??= event.created
        tool.input = toolInputRecord(event.data.input)
        this.setToolBlock(message, tool)
        out.push(this.messageOutput(message))
        return
      }
      case 'session.tool.progress': {
        const tool = s.tools.get(event.data.id)
        if (!tool) return
        this.toolProgress(tool, event.data.metadata, out)
        return
      }
      case 'session.tool.success': {
        const message = this.messageOf(s, event.data.assistantMessageID, event.created)
        const tool = this.toolOf(s, message, event.data.id, undefined, out)
        this.settleTool(
          s,
          tool,
          { ok: true, content: event.data.content, metadata: event.data.metadata },
          out
        )
        return
      }
      case 'session.tool.failed': {
        const message = this.messageOf(s, event.data.assistantMessageID, event.created)
        const tool = this.toolOf(s, message, event.data.id, undefined, out)
        this.settleTool(
          s,
          tool,
          {
            ok: false,
            error: event.data.error,
            content: event.data.content,
            metadata: event.data.metadata
          },
          out
        )
        return
      }
      case 'session.step.ended':
      case 'session.step.failed': {
        const message = s.messages.get(event.data.assistantMessageID)
        if (message) this.sealMessage(message, out)
        const { cost, tokens } = event.data
        if (message && cost !== undefined && tokens !== undefined)
          this.meter(
            s,
            message,
            { cost, tokens },
            event.type === 'session.step.ended' ? event.data.finish : 'error',
            out
          )
        return
      }
      case 'session.step.streamed':
        return
      case 'session.usage.updated':
        if (!own) return
        this.cumulative = { cost: event.data.cost, tokens: event.data.tokens }
        out.push({ kind: 'session-usage', cost: event.data.cost, tokens: event.data.tokens })
        // Mid-turn the steps are still landing; settle the remainder when quiet.
        if (!s.running) this.emitOverhead(out)
        return
      case 'session.execution.started':
        s.running = true
        s.turnStartedAt = event.created
        s.declined.clear()
        s.armedStop = undefined
        s.endedWithoutIdle = false
        if (own) out.push({ kind: 'turn-start' })
        return
      case 'session.execution.succeeded':
        this.endExecution(s, { outcome: 'succeeded' }, event.created, event.id, out)
        return
      case 'session.execution.failed':
        this.endExecution(
          s,
          { outcome: 'failed', error: event.data.error },
          event.created,
          event.id,
          out
        )
        return
      case 'session.execution.interrupted':
        this.endExecution(
          s,
          { outcome: 'interrupted', reason: event.data.reason },
          event.created,
          event.id,
          out
        )
        return
      case 'session.retry.scheduled':
        if (own)
          out.push({
            kind: 'retry',
            attempt: event.data.attempt,
            at: event.data.at,
            error: event.data.error
          })
        return
      case 'session.compaction.started': {
        s.compactionId = event.data.inputID ?? messageIdFromEvent(event.id)
        s.compactionStartedAt = event.created
        if (own) out.push({ kind: 'compaction', phase: 'started', reason: event.data.reason })
        return
      }
      case 'session.compaction.delta':
        return
      case 'session.compaction.ended':
        this.endCompaction(
          s,
          {
            phase: 'ended',
            reason: event.data.reason,
            summary: event.data.text,
            usage: compactionUsage(event.data.cost, event.data.tokens, event.data.model).usage
          },
          event.id,
          event.created,
          out
        )
        return
      case 'session.compaction.failed':
        this.endCompaction(
          s,
          {
            phase: 'failed',
            reason: event.data.reason,
            error: event.data.error,
            usage: compactionUsage(event.data.cost, event.data.tokens).usage
          },
          event.id,
          event.created,
          out
        )
        return
      case 'permission.asked':
        this.ask(s, event.data, out)
        return
      case 'permission.replied':
        if (event.data.reply === 'reject') this.declineCall(s, event.data.requestID, 'denied')
        this.resolve(event.data.requestID, out)
        return
      case 'form.created':
        this.askForm(s, event.data.form, out)
        return
      case 'form.cancelled':
        this.declineCall(s, event.data.id, 'form-cancelled')
        this.resolve(event.data.id, out)
        return
      case 'form.replied':
        this.resolve(event.data.id, out)
        return
      case 'session.inbox.enqueued': {
        if (!own) return
        const { inboxID, item } = event.data
        s.inboxItems.set(inboxID, item)
        if (s.inbox.has(inboxID)) return
        s.inbox.set(inboxID, item.delivery)
        out.push({ kind: 'inbox', change: 'enqueued', inboxID, delivery: item.delivery, item })
        return
      }
      case 'session.inbox.delivered': {
        if (!own) return
        const { inboxID } = event.data
        const known = s.inbox.delete(inboxID)
        const item = s.inboxItems.get(inboxID)
        s.inboxItems.delete(inboxID)
        if (known) out.push({ kind: 'inbox', change: 'delivered', inboxID })
        if (item?.type === 'user' && !s.usersSeen.has(inboxID)) {
          s.usersSeen.add(inboxID)
          const message = userChatMessage(inboxID, item.payload, event.created)
          if (message) out.push({ kind: 'user-message', inboxID, message })
        }
        return
      }
      case 'session.inbox.cancelled': {
        if (!own) return
        s.inboxItems.delete(event.data.inboxID)
        if (s.inbox.delete(event.data.inboxID))
          out.push({ kind: 'inbox', change: 'cancelled', inboxID: event.data.inboxID })
        return
      }
      case 'session.inbox.delivery.changed': {
        if (!own) return
        const { inboxID, delivery } = event.data
        if (s.inbox.get(inboxID) === delivery) return
        s.inbox.set(inboxID, delivery)
        out.push({ kind: 'inbox', change: 'delivery-changed', inboxID, delivery })
        return
      }
      case 'session.renamed':
        if (own) out.push({ kind: 'session-renamed', title: event.data.title })
        return
      case 'session.model.selected':
        s.model = event.data.model
        if (own) out.push({ kind: 'model-selected', model: event.data.model })
        return
      case 'session.agent.selected':
        if (own) out.push({ kind: 'agent-selected', agent: event.data.agent })
        return
      case 'session.deleted':
        if (own) out.push({ kind: 'session-deleted' })
        return
      default:
        return
    }
  }

  // ── Messages and items ─────────────────────────────────────────────────────

  private messageOf(
    s: SessionState,
    id: string,
    timestamp: number,
    owner: string | undefined = s.owner
  ): MessageState {
    let message = s.messages.get(id)
    if (!message) {
      message = {
        id,
        timestamp,
        items: [],
        blocks: [],
        metered: false,
        ...(owner ? { owner } : {})
      }
      s.messages.set(id, message)
    }
    return message
  }

  private itemByOrdinal(
    message: MessageState,
    kind: 'text' | 'reasoning',
    ordinal: number
  ): ItemState | undefined {
    return message.items.find((item) => item.kind === kind && item.ordinal === ordinal)
  }

  private snapshot(message: MessageState): ChatMessage {
    return {
      id: message.id,
      role: 'assistant',
      content: message.blocks.map((block) => ({ ...block })),
      timestamp: message.timestamp
    }
  }

  private ownerField(s: SessionState): { ownerToolUseId?: string } {
    return s.owner ? { ownerToolUseId: s.owner } : {}
  }

  private messageOutput(message: MessageState): OpencodeMapperOutput {
    return { kind: 'message', message: this.snapshot(message), ...this.ownerOf(message) }
  }

  private ownerOf(message: MessageState): { ownerToolUseId?: string } {
    return message.owner ? { ownerToolUseId: message.owner } : {}
  }

  /**
   * The call a child's step at `time` ran under: the last call of that child
   * that started at or before it (the cold converter splits a resumed child
   * the same way). Falls back to the current link.
   */
  private ownerAt(s: SessionState, time: number): string | undefined {
    const calls = this.childCalls.get(s.id) ?? []
    if (calls.length === 0 || calls.some((call) => call.start === undefined)) return s.owner
    let owner = calls[0].toolId
    for (const call of calls) if ((call.start as number) <= time) owner = call.toolId
    return owner
  }

  private target(message: MessageState, item: ItemState): ItemStreamTarget {
    return {
      messageId: message.id,
      blockIndex: item.index ?? 0,
      kind: item.kind === 'reasoning' ? 'thinking' : 'text',
      ...this.ownerOf(message)
    }
  }

  private textBlock(item: ItemState): ContentBlock {
    return item.kind === 'reasoning'
      ? {
          type: 'thinking',
          text: item.text,
          ...(item.ended && item.durationMs !== undefined ? { durationMs: item.durationMs } : {})
        }
      : { type: 'text', text: item.text }
  }

  private place(message: MessageState, item: ItemState): void {
    item.index = message.blocks.length
    message.blocks.push(this.textBlock(item))
  }

  private appendDelta(message: MessageState, item: ItemState, delta: string, out: Out): void {
    if (item.ended || item.gapped || !delta) return
    if (item.index === null) {
      // First content: place the block empty and open its stream on it.
      this.place(message, item)
      item.open = true
      out.push({
        kind: 'item-open',
        open: {
          target: this.target(message, item),
          message: this.snapshot(message),
          ...(item.kind === 'reasoning' && item.startedAt !== undefined
            ? { startedAt: item.startedAt }
            : {})
        }
      })
    } else if (!item.open) return
    item.text += delta
    message.blocks[item.index!] = this.textBlock(item)
    out.push({ kind: 'item-delta', target: this.target(message, item), chunk: delta })
  }

  /** `text` is authoritative (the `*.ended` payload, or the stored row). */
  private endItem(message: MessageState, item: ItemState, text: string, out: Out): void {
    item.text = text
    item.ended = true
    item.gapped = false
    if (item.index === null) {
      if (!text) return
      this.place(message, item)
      out.push(this.messageOutput(message))
      return
    }
    message.blocks[item.index] = this.textBlock(item)
    if (item.open) {
      item.open = false
      out.push({
        kind: 'item-seal',
        seal: {
          target: this.target(message, item),
          message: this.snapshot(message),
          ...this.ownerOf(message)
        }
      })
    } else out.push(this.messageOutput(message))
  }

  /** Close every stream still open in a message, on what it has (a safety net: `*.ended` normally does it). */
  private sealMessage(message: MessageState, out: Out): void {
    for (const item of message.items) {
      if (!item.open || item.index === null) continue
      item.open = false
      item.ended = true
      out.push({
        kind: 'item-seal',
        seal: {
          target: this.target(message, item),
          message: this.snapshot(message),
          ...this.ownerOf(message)
        }
      })
    }
  }

  private sealSession(s: SessionState, out: Out): void {
    for (const message of s.messages.values()) this.sealMessage(message, out)
  }

  // ── Tools ──────────────────────────────────────────────────────────────────

  private toolOf(
    s: SessionState,
    message: MessageState,
    id: string,
    name: string | undefined,
    out: Out
  ): ToolState {
    let tool = s.tools.get(id)
    if (tool) {
      if (name) tool.name = name
      return tool
    }
    tool = { id, name: name ?? 'unknown', message, input: {}, settled: false, asked: false }
    s.tools.set(id, tool)
    const item: ItemState = {
      kind: 'tool',
      toolId: id,
      text: '',
      ended: false,
      index: null,
      open: false,
      gapped: false
    }
    message.items.push(item)
    item.index = message.blocks.length
    message.blocks.push(this.toolBlock(tool))
    out.push(this.messageOutput(message))
    return tool
  }

  private toolBlock(tool: ToolState): ContentBlock {
    return {
      type: 'tool_use',
      toolUseId: tool.id,
      toolName: tool.name,
      toolInput: { ...tool.input }
    }
  }

  private setToolBlock(message: MessageState, tool: ToolState): void {
    const item = message.items.find((candidate) => candidate.toolId === tool.id)
    if (item?.index != null) message.blocks[item.index] = this.toolBlock(tool)
  }

  private toolProgress(
    tool: ToolState,
    metadata: { readonly [key: string]: unknown },
    out: Out
  ): void {
    if (SHELL_TOOL_NAMES.has(tool.name) && typeof metadata.shellID === 'string' && !tool.shellID) {
      tool.shellID = metadata.shellID
      out.push({
        kind: 'shell-started',
        toolUseId: tool.id,
        shellID: metadata.shellID,
        ...this.ownerOf(tool.message)
      })
    }
    const child = subagentChildSession(tool.name, metadata)
    if (child) this.linkChild(tool, child, out)
  }

  /** Route a child's events under the call that runs it (a resumed child re-links under the newer call). */
  private linkChild(tool: ToolState, childID: string, out: Out): void {
    if (tool.childSession === childID || this.seeding) return
    tool.childSession = childID
    const calls = this.childCalls.get(childID) ?? []
    if (!calls.some((call) => call.toolId === tool.id))
      calls.push({
        toolId: tool.id,
        ...(tool.startedAt !== undefined ? { start: tool.startedAt } : {})
      })
    if (calls.every((call) => call.start !== undefined))
      calls.sort((a, b) => (a.start as number) - (b.start as number))
    this.childCalls.set(childID, calls)
    let child = this.children.get(childID)
    if (child) {
      child.owner = tool.id
      child.background = false
      child.notified = false
      child.endedAs = undefined
    } else {
      child = newSession(childID, tool.id)
      this.children.set(childID, child)
    }
    out.push({
      kind: 'subagent-started',
      toolUseId: tool.id,
      childSessionId: childID,
      ...this.ownerOf(tool.message)
    })
    const pending = this.pending.get(childID)
    this.pending.delete(childID)
    for (const event of pending?.buffer ?? []) this.apply(child, event, out)
  }

  private settleTool(
    s: SessionState,
    tool: ToolState,
    outcome:
      | {
          ok: true
          content: readonly Tool_Content[]
          metadata?: { readonly [key: string]: unknown }
        }
      | {
          ok: false
          error: Session_StructuredError
          content?: readonly Tool_Content[]
          metadata?: { readonly [key: string]: unknown }
        },
    out: Out
  ): void {
    if (tool.settled) return
    tool.settled = true
    // A messageless decline: the call dies `aborted` and the turn ends `shutdown`.
    const declined = s.declined.get(tool.id)
    if (declined && !outcome.ok && outcome.error.type === 'aborted') s.armedStop = declined
    const result = outcome.ok
      ? toolSuccessResult(tool.id, tool.name, outcome.content, outcome.metadata)
      : toolFailureResult(tool.id, outcome.error, outcome.content, outcome.metadata)
    out.push({ kind: 'tool-result', result, ...this.ownerOf(tool.message) })
    // Rejected with no ask seen: a deny rule inside opencode. Not decidable from
    // a re-read (the ask may have been in the gap, answered by the host).
    const reason = outcome.ok ? undefined : reviewRationale(outcome.error.message)
    if (!outcome.ok && outcome.error.type === 'permission.rejected' && !tool.asked && !this.reading)
      out.push({
        kind: 'permission-denial',
        toolUseId: tool.id,
        denial: {
          type: 'permission_denial',
          toolUseId: tool.id,
          denialId: `opencode-rule:${tool.id}`,
          source: 'rule',
          ...(reason ? { reason } : {})
        },
        ...this.ownerOf(tool.message)
      })
    if (!SUBAGENT_TOOL_NAMES.has(tool.name)) return
    const childID =
      tool.childSession ??
      subagentChildSession(
        tool.name,
        outcome.metadata,
        outcome.ok ? result.result : outcome.error.message
      )
    if (!childID) return
    if (tool.childSession !== childID) this.linkChild(tool, childID, out)
    const child = this.children.get(childID)
    if (outcome.ok && subagentBackgrounded(outcome.metadata)) {
      // The child may already have ended (a near-instant run): its outcome is the notification.
      if (child?.endedAs && !child.running) this.notifyTask(childID, tool.id, child.endedAs, out)
      else if (child) child.background = true
      return
    }
    this.notifyTask(
      childID,
      tool.id,
      outcome.ok ? 'completed' : outcome.error.type === 'aborted' ? 'stopped' : 'failed',
      out
    )
  }

  private notifyTask(
    childID: string,
    toolUseId: string,
    status: TaskNotification['status'],
    out: Out
  ): void {
    const child = this.children.get(childID)
    if (child) {
      if (child.notified) return
      child.notified = true
      this.sealSession(child, out)
    }
    out.push({
      kind: 'task-notification',
      notification: { taskId: childID, toolUseId, status, outputFile: '', summary: '' }
    })
  }

  // ── Turn ends ──────────────────────────────────────────────────────────────

  private endExecution(
    s: SessionState,
    end:
      | { outcome: 'succeeded' }
      | { outcome: 'failed'; error: Session_StructuredError }
      | { outcome: 'interrupted'; reason: 'user' | 'shutdown' | 'superseded' | 'inactivity' },
    created: number,
    eventID: string,
    out: Out
  ): void {
    // A shutdown writes no idle row; every other end does, under this id. A
    // re-read already reported this end — unless a later live start re-armed
    // the turn (the read reflected a turn that started after the reconnect),
    // when the consumer, having seen that start, needs the end again.
    const idleId = messageIdFromEvent(eventID)
    if (s.idleSeen.has(idleId) && !s.running) return
    if (
      end.outcome === 'interrupted' &&
      end.reason === 'shutdown' &&
      s.endedWithoutIdle &&
      !s.running
    ) {
      s.endedWithoutIdle = false
      return
    }
    s.idleSeen.add(idleId)
    const durationMs = Math.max(0, created - (s.turnStartedAt ?? created))
    const reason: OpencodeStopReason | undefined =
      end.outcome !== 'interrupted'
        ? undefined
        : end.reason === 'shutdown' && s.armedStop
          ? s.armedStop
          : end.reason
    this.finishTurn(
      s,
      end.outcome,
      reason,
      end.outcome === 'failed' ? end.error : undefined,
      durationMs,
      out
    )
  }

  private finishTurn(
    s: SessionState,
    outcome: 'succeeded' | 'failed' | 'interrupted',
    reason: OpencodeStopReason | undefined,
    error: Session_StructuredError | undefined,
    durationMs: number,
    out: Out
  ): void {
    s.running = false
    s.declined.clear()
    s.armedStop = undefined
    s.turnStartedAt = undefined
    this.sealSession(s, out)
    // Nothing answers a card once its execution is over: an interrupt drops
    // pending permission asks with no `permission.replied` (core/src/permission.ts
    // assert: only `pending.delete`). A foreground child is interrupted with its
    // parent; a background one keeps running and keeps its cards.
    this.resolveAll(s.id, out)
    if (s === this.own)
      for (const child of this.children.values())
        if (!(child.background && child.running)) this.resolveAll(child.id, out)
    // A child announced under this session but never linked to a call will not be.
    for (const [childID, pending] of [...this.pending])
      if (pending.parentID === s.id) this.pending.delete(childID)
    if (s !== this.own) {
      const status: TaskNotification['status'] =
        outcome === 'succeeded' ? 'completed' : outcome === 'failed' ? 'failed' : 'stopped'
      // A background child's end is its call's one terminal notification; if the
      // call has not said it went to the background yet, the outcome waits for it.
      if (s.background && s.owner) this.notifyTask(s.id, s.owner, status, out)
      else s.endedAs = status
      return
    }
    this.emitOverhead(out)
    if (outcome === 'succeeded') out.push({ kind: 'result', sessionId: s.id, durationMs })
    else if (outcome === 'interrupted')
      out.push({ kind: 'stopped', sessionId: s.id, reason: reason ?? 'unknown', durationMs })
    else if (error?.type === 'provider.auth' && s.model?.providerID)
      out.push({
        kind: 'auth-required',
        sessionId: s.id,
        vendorId: s.model.providerID,
        message: error.message || 'Authentication required',
        durationMs
      })
    else
      out.push({
        kind: 'error',
        sessionId: s.id,
        message: error?.message || 'The opencode turn failed',
        errorType: error?.type ?? 'unknown',
        durationMs
      })
  }

  // ── Approvals ──────────────────────────────────────────────────────────────

  private ask(s: SessionState, request: Permission_Request, out: Out): void {
    if (this.approvals.has(request.id)) return
    const callID = request.source?.id
    this.approvals.set(request.id, { sessionID: s.id, ...(callID ? { callID } : {}) })
    const tool = callID ? s.tools.get(callID) : undefined
    if (tool) tool.asked = true
    const metadata = request.metadata ?? {}
    const input =
      tool && Object.keys(tool.input).length > 0
        ? { ...tool.input }
        : Object.keys(metadata).length > 0
          ? { ...metadata }
          : {}
    const suggestion =
      s === this.own ? this.suggest?.(request.action, request.resources) : undefined
    const approval: PendingApproval = {
      requestId: request.id,
      ...(callID ? { toolUseId: callID } : {}),
      toolName: request.action,
      input,
      ...(request.resources.length > 0 ? { patterns: [...request.resources] } : {}),
      ...(request.save && request.save.length > 0 ? { always: [...request.save] } : {}),
      ...(s.owner ? { subagent: { sessionId: s.id, parentToolUseId: s.owner } } : {}),
      ...(suggestion ? { suggestions: [suggestion] } : {})
    }
    out.push({ kind: 'approval', approval, route: { sessionID: s.id } })
  }

  private askForm(s: SessionState, form: Form_Info, out: Out): void {
    if (this.approvals.has(form.id)) return
    const callID = formToolCall(form)
    this.approvals.set(form.id, { sessionID: s.id, ...(callID ? { callID } : {}) })
    const { questions, fields } = formQuestions(form)
    out.push({
      kind: 'approval',
      approval: {
        requestId: form.id,
        ...(callID ? { toolUseId: callID } : {}),
        toolName: 'AskUserQuestion',
        input: { questions }
      },
      route: { sessionID: s.id, form: { formID: form.id, fields } }
    })
  }

  private resolve(requestId: string, out: Out): void {
    if (!this.approvals.delete(requestId)) return
    out.push({ kind: 'approval-resolved', requestId })
  }

  /**
   * A compaction ended or failed. The own session gets its separator row (a
   * completed one) and the phase; any session's compaction request is billed
   * once (`usage`, keyed by the compaction's id).
   */
  private endCompaction(
    s: SessionState,
    end: {
      phase: 'ended' | 'failed'
      reason: 'auto' | 'manual'
      summary?: string
      error?: Session_StructuredError
      usage?: { cost: number; tokens: TokenUsage_Info; model?: Model_Ref }
    },
    eventID: string | null,
    created: number,
    out: Out,
    rowId?: string
  ): void {
    const id =
      rowId ??
      s.compactionId ??
      s.compactionFromRead ??
      (eventID ? messageIdFromEvent(eventID) : `compaction-${created}`)
    const at = rowId ? created : (s.compactionStartedAt ?? created)
    if (!rowId) {
      s.compactionId = undefined
      s.compactionStartedAt = undefined
      s.compactionFromRead = undefined
    }
    const own = s === this.own
    if (own && end.phase === 'ended' && end.summary !== undefined && !s.compactionsSeen.has(id)) {
      s.compactionsSeen.add(id)
      out.push({ kind: 'message', message: compactionChatMessage(id, end.summary, at) })
    }
    const usage = end.usage && !s.compactionsMetered.has(id) ? end.usage : undefined
    if (usage) {
      s.compactionsMetered.add(id)
      if (own) this.account(usage)
    }
    if (!own && !usage) return
    out.push({
      kind: 'compaction',
      phase: end.phase,
      reason: end.reason,
      ...(end.error ? { error: end.error } : {}),
      ...(usage ? { usage } : {}),
      ...this.ownerField(s)
    })
  }

  /** Own-session usage reported so far (steps, compactions, overhead): the base of the next overhead. */
  private account(usage: { cost: number; tokens: TokenUsage_Info }): void {
    this.accounted = addUsage(this.accounted, usage)
  }

  /**
   * Usage opencode billed to the own session that no step or compaction
   * carries — its title generation (`session.usage.recorded {source:'title'}`
   * is folded into the session's cumulative, `session.usage.updated`, and
   * nowhere else). Emitted at quiet points (turn end, an update while idle)
   * as the positive part of cumulative − accounted.
   */
  private emitOverhead(out: Out): void {
    if (!this.cumulative) return
    const extra = positivePart(subtractUsage(this.cumulative, this.accounted))
    if (!extra) return
    this.account(extra)
    out.push({ kind: 'overhead-usage', cost: extra.cost, tokens: extra.tokens })
  }

  /** Retract every card a session still shows (its execution ended: nothing will answer them). */
  private resolveAll(sessionID: string, out: Out): void {
    for (const [id, entry] of [...this.approvals])
      if (entry.sessionID === sessionID) this.resolve(id, out)
  }

  /** A reject / cancel of a request: remember its call until the call settles. */
  private declineCall(s: SessionState, requestId: string, as: 'denied' | 'form-cancelled'): void {
    const callID = this.approvals.get(requestId)?.callID
    if (callID) s.declined.set(callID, as)
  }

  /** A step's usage, once per step. */
  private meter(
    s: SessionState,
    message: MessageState,
    usage: Usage,
    finish: string | undefined,
    out: Out
  ): void {
    if (message.metered) return
    message.metered = true
    if (s === this.own) this.account(usage)
    out.push({
      kind: 'step-usage',
      usage: this.stepUsage(s, message, usage.cost, usage.tokens, finish)
    })
  }

  private stepUsage(
    s: SessionState,
    message: MessageState,
    cost: number,
    tokens: TokenUsage_Info,
    finish: string | undefined
  ): OpencodeStepUsage {
    return {
      messageId: message.id,
      sessionId: s.id,
      ...this.ownerOf(message),
      ...((message.model ?? s.model) ? { model: message.model ?? s.model } : {}),
      cost,
      tokens,
      ...(finish ? { finish } : {})
    }
  }

  // ── Seeding and reconnect ──────────────────────────────────────────────────

  /**
   * Mark a session's stored history as already shown (a resumed chat replays
   * it from the cold converter), so nothing in it is emitted again when a
   * reconnect re-reads the same rows. No outputs.
   */
  seed(
    messages: readonly Session_Message_Info[],
    options: { sessionTotals?: { cost: number; tokens: TokenUsage_Info } } = {}
  ): void {
    this.seeding = true
    try {
      this.ingestRows(this.own, messages, [])
    } finally {
      this.seeding = false
    }
    // The cold status line counted the session's whole cumulative (title
    // generation included, `opencodeHistorySeed`): that is all accounted for.
    if (options.sessionTotals) this.accounted = options.sessionTotals
    for (const row of messages) if (row.type === 'idle') this.own.idleSeen.add(row.id)
  }

  /**
   * Emit what a feed gap hid, from a fresh read of state, and mark it
   * handled. Call on `connected {reconnected:true}`, before applying any
   * further event.
   */
  reconcile(snapshot: OpencodeReconnectSnapshot): OpencodeMapperOutput[] {
    const out: Out = []
    for (const s of [this.own, ...this.children.values()]) {
      const read = snapshot.sessions[s.id]
      if (!read) continue
      // Deltas from the gap are gone: an open stream shows nothing more until its end.
      for (const message of s.messages.values())
        for (const item of message.items) if (item.open) item.gapped = true
      const before = new Set(s.idleSeen)
      this.ingestRows(s, read.messages, out)
      this.reconcileRequests(s, read.permissions, read.forms, out)
      if (s === this.own) this.reconcileInbox(s, read.inbox ?? [], read.messages, out)
      this.reconcileRunning(s, read.messages, before, snapshot.active[s.id] !== undefined, out)
    }
    return out
  }

  private ingestRows(s: SessionState, rows: readonly Session_Message_Info[], out: Out): void {
    this.reading = true
    try {
      this.ingestRowsInner(s, rows, out)
    } finally {
      this.reading = false
    }
  }

  private ingestRowsInner(s: SessionState, rows: readonly Session_Message_Info[], out: Out): void {
    for (const row of rows) {
      switch (row.type) {
        case 'user':
          if (s !== this.own || s.usersSeen.has(row.id)) break
          s.usersSeen.add(row.id)
          {
            const message = userChatMessage(row.id, row, row.time.created)
            if (message) out.push({ kind: 'user-message', inboxID: row.id, message })
          }
          break
        case 'assistant':
          this.ingestAssistant(s, row, out)
          break
        case 'compaction':
          if (row.status === 'running') {
            // Its live end will need this id.
            s.compactionId = row.id
            s.compactionStartedAt = row.time.created
            break
          }
          if (s.compactionId === row.id) {
            s.compactionId = undefined
            s.compactionStartedAt = undefined
          }
          // Its live end (no id on the event) may still come: it is this one.
          s.compactionFromRead = row.id
          this.endCompaction(
            s,
            row.status === 'completed'
              ? {
                  phase: 'ended',
                  reason: row.reason,
                  summary: row.summary,
                  usage: compactionUsage(row.cost, row.tokens, row.model).usage
                }
              : {
                  phase: 'failed',
                  reason: row.reason,
                  error: row.error,
                  usage: compactionUsage(row.cost, row.tokens).usage
                },
            null,
            row.time.created,
            out,
            row.id
          )
          break
        default:
          break
      }
    }
  }

  private ingestAssistant(s: SessionState, row: Session_Message_Assistant, out: Out): void {
    const message = this.messageOf(
      s,
      row.id,
      row.time.created,
      s === this.own ? undefined : this.ownerAt(s, row.time.created)
    )
    message.timestamp = row.time.created
    message.model = row.model
    let changed = false
    const seen = { text: 0, reasoning: 0 }
    for (const part of row.content) {
      if (part.type === 'tool') {
        if (!s.tools.has(part.id)) changed = true
        // Its message goes out below, once (not one per new tool).
        const tool = this.toolOf(s, message, part.id, part.name, [])
        tool.startedAt ??= part.time?.ran ?? part.time?.created
        const input = toolInputRecord(part.state.input)
        if (Object.keys(input).length > 0 && JSON.stringify(input) !== JSON.stringify(tool.input)) {
          tool.input = input
          this.setToolBlock(message, tool)
          changed = true
        }
        if (part.state.status === 'streaming') continue
        // The tool_use must be on the wire before anything keyed to it.
        if (changed) {
          out.push(this.messageOutput(message))
          changed = false
        }
        if (part.state.status === 'running')
          // What progress said while we were away (the shell id, the child link).
          this.toolProgress(tool, part.state.metadata, out)
        else
          this.settleTool(
            s,
            tool,
            part.state.status === 'completed'
              ? { ok: true, content: part.state.content, metadata: part.state.metadata }
              : {
                  ok: false,
                  error: part.state.error,
                  content: part.state.content,
                  metadata: part.state.metadata
                },
            out
          )
        continue
      }
      const ordinal = seen[part.type]++
      let item = this.itemByOrdinal(message, part.type, ordinal)
      if (!item) {
        item = {
          kind: part.type,
          ordinal,
          text: '',
          ended: false,
          index: null,
          open: false,
          gapped: false,
          ...(part.type === 'reasoning' && part.time ? { startedAt: part.time.created } : {})
        }
        message.items.push(item)
      }
      // A stored text/reasoning is final once it has text (opencode stores the
      // `*.ended` text; an unfinished one is still ""), or a reasoning has its end time.
      const final =
        part.text !== '' || (part.type === 'reasoning' && part.time?.completed !== undefined)
      if (!final || item.ended) continue
      if (part.type === 'reasoning' && part.time?.completed !== undefined)
        item.durationMs = Math.max(0, part.time.completed - part.time.created)
      if (item.open) {
        this.endItem(message, item, part.text, out)
        continue
      }
      item.text = part.text
      item.ended = true
      item.gapped = false
      if (!part.text) continue
      if (item.index === null) this.place(message, item)
      else message.blocks[item.index] = this.textBlock(item)
      changed = true
    }
    if (changed) out.push(this.messageOutput(message))
    if (
      !message.metered &&
      row.time.completed !== undefined &&
      row.cost !== undefined &&
      row.tokens
    ) {
      this.meter(s, message, { cost: row.cost, tokens: row.tokens }, row.finish, out)
    }
  }

  private reconcileRequests(
    s: SessionState,
    permissions: readonly Permission_Request[],
    forms: readonly Form_Info[],
    out: Out
  ): void {
    const pending = new Set([...permissions.map((p) => p.id), ...forms.map((f) => f.id)])
    for (const [id, entry] of [...this.approvals])
      if (entry.sessionID === s.id && !pending.has(id)) this.resolve(id, out)
    for (const request of permissions) this.ask(s, request, out)
    for (const form of forms) this.askForm(s, form, out)
  }

  private reconcileInbox(
    s: SessionState,
    inbox: readonly Session_Inbox_Info[],
    rows: readonly Session_Message_Info[],
    out: Out
  ): void {
    const listed = new Map(inbox.map((item) => [item.id, item]))
    const delivered = new Set(rows.map((row) => row.id))
    for (const [inboxID] of [...s.inbox]) {
      if (listed.has(inboxID)) continue
      s.inbox.delete(inboxID)
      s.inboxItems.delete(inboxID)
      out.push({
        kind: 'inbox',
        change: delivered.has(inboxID) ? 'delivered' : 'cancelled',
        inboxID
      })
    }
    for (const item of inbox) {
      const known = s.inbox.get(item.id)
      if (known === undefined) {
        const entry = {
          type: item.type,
          payload: item.payload,
          delivery: item.delivery
        } as SessionInboxItem
        s.inbox.set(item.id, item.delivery)
        s.inboxItems.set(item.id, entry)
        out.push({
          kind: 'inbox',
          change: 'enqueued',
          inboxID: item.id,
          delivery: item.delivery,
          item: entry
        })
      } else if (known !== item.delivery) {
        s.inbox.set(item.id, item.delivery)
        out.push({
          kind: 'inbox',
          change: 'delivery-changed',
          inboxID: item.id,
          delivery: item.delivery
        })
      }
    }
  }

  /**
   * Turn state after a gap. `active` is read FIRST (`reconnect.ts`):
   * opencode writes the idle row inside the terminal publish, before the
   * execution leaves the active set, so "not active" means its idle row (if
   * the end writes one) is already in `rows`.
   */
  private reconcileRunning(
    s: SessionState,
    rows: readonly Session_Message_Info[],
    idleBefore: ReadonlySet<string>,
    active: boolean,
    out: Out
  ): void {
    const unseen = rows.filter(
      (row): row is Extract<Session_Message_Info, { type: 'idle' }> =>
        row.type === 'idle' && !idleBefore.has(row.id)
    )
    for (const row of unseen) s.idleSeen.add(row.id)
    const last = unseen.at(-1)
    if (last) {
      if (!s.running) {
        // A whole turn ran inside the gap.
        s.running = true
        s.turnStartedAt = turnStart(rows, last)
        if (s === this.own) out.push({ kind: 'turn-start' })
      }
      // The stored row keeps the outcome, not the error: take the step's, if one failed.
      const failedStep = rows
        .slice(0, rows.indexOf(last))
        .findLast(
          (row): row is Session_Message_Assistant =>
            row.type === 'assistant' && row.error !== undefined
        )
      this.finishTurn(
        s,
        last.outcome,
        last.outcome === 'interrupted' ? 'unknown' : undefined,
        last.outcome === 'failed' ? failedStep?.error : undefined,
        Math.max(0, last.time.created - (s.turnStartedAt ?? last.time.created)),
        out
      )
    }
    // Active, but the read ends on the idle just handled: the turn ended between the reads.
    const endedSinceActiveRead = last !== undefined && rows.at(-1) === last
    if (active && !endedSinceActiveRead) {
      if (!s.running) {
        s.running = true
        s.declined.clear()
        s.armedStop = undefined
        s.turnStartedAt = Date.now()
        if (s === this.own) out.push({ kind: 'turn-start' })
      }
      return
    }
    if (active || !s.running) return
    // Not running, and no idle row: an engine shutdown, or a messageless reject.
    s.endedWithoutIdle = true
    this.finishTurn(
      s,
      'interrupted',
      s.armedStop ?? 'shutdown',
      undefined,
      Math.max(0, Date.now() - (s.turnStartedAt ?? Date.now())),
      out
    )
  }
}

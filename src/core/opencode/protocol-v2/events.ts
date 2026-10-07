/**
 * opencode 2.x SSE events (`GET /api/event`) that ClaudeUI consumes — a
 * HAND-CURATED closure, not generated (ADR-097 §7).
 *
 * Why curated: the spec types every event as an opaque JSON string
 * (`V2EventEncoded`, also in the server's own `/openapi.json`). The payloads
 * exist only as Effect Schemas in upstream `packages/schema/src`, and turning
 * those into JSON would mean installing and running upstream's source tree.
 * So the shapes below are transcribed by hand, and wherever a payload IS a
 * spec component (TokenUsage.Info, Permission.Request, Form.Info, …) it is
 * referenced from `./openapi` and drifts with the generated file.
 *
 * Drift guard: `scripts/generate-opencode-protocol.mjs` pins the sha256 of
 * every upstream file transcribed here (`events.reviewed.json`). A pin bump
 * that touches any of them fails generate and check until this file is
 * re-reviewed and `--accept-events` records the new digests. Sources, at the
 * pinned tag: `packages/schema/src/{event,session-event,session-inbox,
 * permission,form,credential,provider,model,llm,location}.ts` and
 * `packages/protocol/src/groups/event.ts`.
 *
 * Only what ClaudeUI maps (spike §5 table) is listed. Anything else on the
 * feed (worktree.*, skill.updated, rpc.*, …) fails `isOpencodeEvent` and is
 * the consumer's to ignore.
 */
import type {
  Form_Answer,
  Form_Info,
  Model_Ref,
  Money_USD,
  Permission_Reply,
  Permission_Request,
  Permission_Ruleset,
  Session_Inbox_CompactionPayload,
  Session_Inbox_Delivery,
  Session_Inbox_MovePayload,
  Session_Inbox_SyntheticPayload,
  Session_Inbox_UserPayload,
  Session_Message_ProviderState,
  Session_Metadata,
  Session_ProviderContext,
  Session_StructuredError,
  TokenUsage_Info,
  Tool_Content
} from './openapi'

// --- Envelope (schema/src/event.ts `durable` / `ephemeral`) ----------------

/** `Location.Ref`: the event's location. */
export interface EventLocation {
  readonly directory: string
  readonly workspaceID?: string
}

/** Present on durable events only: their position in the aggregate's log. */
export interface DurableEnvelope {
  readonly aggregateID: string
  readonly seq: number
  readonly version: number
}

interface EnvelopeBase<Type extends string, Data> {
  /** `evt_…` */
  readonly id: string
  readonly type: Type
  readonly created: number
  readonly metadata?: { readonly [key: string]: unknown }
  readonly location?: EventLocation
  readonly data: Data
}

/** Persisted and replayable through history; carries `durable`. */
export type DurableEvent<Type extends string, Data> = EnvelopeBase<Type, Data> & {
  readonly durable: DurableEnvelope
}

/** Live only: missed for good when the feed is down (re-read state on reconnect). */
export type EphemeralEvent<Type extends string, Data> = EnvelopeBase<Type, Data> & {
  readonly durable?: never
}

/** Struct({}) on the wire. */
export type EmptyData = { readonly [key: string]: never }

// --- Shared payload pieces --------------------------------------------------

/** `llm.ts` FinishReason. */
export type FinishReason = 'stop' | 'length' | 'tool-calls' | 'content-filter' | 'error' | 'unknown'

/** `session-inbox.ts` Item: an inbox entry before it has an id. */
export type SessionInboxItem =
  | {
      readonly type: 'user'
      readonly payload: Session_Inbox_UserPayload
      readonly delivery: Session_Inbox_Delivery
    }
  | {
      readonly type: 'synthetic'
      readonly payload: Session_Inbox_SyntheticPayload
      readonly delivery: Session_Inbox_Delivery
    }
  | {
      readonly type: 'compaction'
      readonly payload: Session_Inbox_CompactionPayload
      readonly delivery: Session_Inbox_Delivery
    }
  | {
      readonly type: 'move'
      readonly payload: Session_Inbox_MovePayload
      readonly delivery: Session_Inbox_Delivery
    }

type Session = { readonly sessionID: string }
type Inbox = Session & { readonly inboxID: string }
type Assistant = Session & { readonly assistantMessageID: string }
type Part = Assistant & { readonly ordinal: number }
/** Tool events: `id` is the provider's tool-call id. */
type ToolRef = Assistant & { readonly id: string }
type ProviderState = { readonly state?: Session_Message_ProviderState }
type JsonRecord = { readonly [key: string]: unknown }

// --- Durable events (session-event.ts unless noted) -------------------------

export interface DurableEventData {
  'session.created': Session & {
    readonly projectID: string
    readonly location: EventLocation
    readonly subpath?: string
    /** Set on a subagent's child session. */
    readonly parentID?: string
    readonly slug: string
    readonly title?: string
    readonly agent?: string
    readonly model?: Model_Ref
    readonly metadata?: Session_Metadata
    readonly permissions?: Permission_Ruleset
    readonly version: string
  }
  'session.agent.selected': Session & { readonly agent: string; readonly previous?: string }
  'session.model.selected': Session & { readonly model: Model_Ref; readonly previous?: Model_Ref }
  'session.renamed': Session & { readonly title: string }
  'session.permissions': Session & { readonly permissions: Permission_Ruleset }
  'session.deleted': Session
  'session.inbox.enqueued': Inbox & { readonly item: SessionInboxItem }
  'session.inbox.delivered': Inbox
  'session.inbox.cancelled': Inbox
  'session.inbox.delivery.changed': Inbox & { readonly delivery: Session_Inbox_Delivery }
  'session.execution.started': Session
  'session.execution.succeeded': Session
  'session.execution.failed': Session & { readonly error: Session_StructuredError }
  /** A user stop is not an error (ADR-090). */
  'session.execution.interrupted': Session & {
    readonly reason: 'user' | 'shutdown' | 'superseded' | 'inactivity'
  }
  'session.step.started': Assistant & {
    readonly agent: string
    readonly model: Model_Ref
    readonly snapshot?: string
    /** Request dispatch time. */
    readonly started: number
  }
  'session.step.streamed': Assistant
  'session.step.ended': Assistant & {
    readonly finish: FinishReason
    readonly rawFinish?: string
    readonly providerState?: Session_Message_ProviderState
    readonly cost: Money_USD
    readonly tokens: TokenUsage_Info
    readonly snapshot?: string
    readonly files?: ReadonlyArray<string>
  }
  'session.step.failed': Assistant & {
    readonly error: Session_StructuredError
    readonly finish?: 'content-filter'
    readonly rawFinish?: string
    readonly providerState?: Session_Message_ProviderState
    readonly cost?: Money_USD
    readonly tokens?: TokenUsage_Info
    readonly snapshot?: string
    readonly files?: ReadonlyArray<string>
  }
  'session.text.started': Part
  'session.text.ended': Part & ProviderState & { readonly text: string }
  'session.reasoning.started': Part & ProviderState
  'session.reasoning.ended': Part & ProviderState & { readonly text: string }
  'session.tool.input.started': ToolRef & { readonly name: string }
  'session.tool.input.ended': ToolRef & { readonly text: string }
  'session.tool.called': ToolRef &
    ProviderState & {
      readonly input: JsonRecord
      readonly executed: boolean
    }
  'session.tool.success': ToolRef & {
    readonly content: readonly [Tool_Content, ...Tool_Content[]]
    readonly metadata?: JsonRecord
    readonly executed: boolean
    readonly resultState?: Session_Message_ProviderState
  }
  /** `error.type` is `permission.rejected` for a reject WITH a message or a deny rule, `aborted` without one. */
  'session.tool.failed': ToolRef & {
    readonly error: Session_StructuredError
    readonly content?: readonly [Tool_Content, ...Tool_Content[]]
    readonly metadata?: JsonRecord
    readonly executed: boolean
    readonly resultState?: Session_Message_ProviderState
  }
  'session.retry.scheduled': Assistant & {
    readonly attempt: number
    /** Epoch ms of the next attempt. */
    readonly at: number
    readonly error: Session_StructuredError
  }
  'session.compaction.started': Session & {
    readonly reason: 'auto' | 'manual'
    readonly recent: string
    readonly inputID?: string
  }
  'session.compaction.ended': Session & {
    readonly reason: 'auto' | 'manual'
    readonly model?: Model_Ref
    readonly providerState?: Session_Message_ProviderState
    readonly providerContext?: Session_ProviderContext
    readonly text: string
    readonly recent: string
    readonly cost?: Money_USD
    readonly tokens?: TokenUsage_Info
  }
  'session.compaction.failed': Session & {
    readonly reason: 'auto' | 'manual'
    readonly error: Session_StructuredError
    readonly inputID?: string
    readonly cost?: Money_USD
    readonly tokens?: TokenUsage_Info
  }
}

// --- Ephemeral events -------------------------------------------------------

export interface EphemeralEventData {
  /** Session-cumulative usage. */
  'session.usage.updated': Session & { readonly cost: Money_USD; readonly tokens: TokenUsage_Info }
  'session.text.delta': Part & { readonly delta: string }
  'session.reasoning.delta': Part & { readonly delta: string }
  'session.tool.input.delta': ToolRef & { readonly delta: string }
  /** Live replacement metadata; for `subagent`, `metadata.sessionID` names the child. */
  'session.tool.progress': ToolRef & { readonly metadata: JsonRecord }
  'session.compaction.delta': Session & { readonly text: string }
  /** permission.ts */
  'permission.asked': Permission_Request
  'permission.replied': Session & { readonly requestID: string; readonly reply: Permission_Reply }
  /** form.ts */
  'form.created': { readonly form: Form_Info }
  'form.replied': Session & { readonly id: string; readonly answer: Form_Answer }
  'form.cancelled': Session & { readonly id: string }
  /** credential.ts */
  'credential.updated': EmptyData
  'credential.switched': { readonly integrationID: string; readonly credentialID: string | null }
  /** provider.ts / model.ts */
  'provider.updated': EmptyData
  'model.updated': EmptyData
}

/**
 * The first frame of every subscription. protocol/src/groups/event.ts builds it
 * from the shared fields only, so it has no `created`.
 */
export interface ServerConnectedEvent {
  readonly id: string
  readonly type: 'server.connected'
  readonly created?: number
  readonly metadata?: { readonly [key: string]: unknown }
  readonly location?: { readonly directory: string }
  readonly data: EmptyData
}

export type OpencodeEvent =
  | ServerConnectedEvent
  | {
      [Type in keyof DurableEventData]: DurableEvent<Type, DurableEventData[Type]>
    }[keyof DurableEventData]
  | {
      [Type in keyof EphemeralEventData]: EphemeralEvent<Type, EphemeralEventData[Type]>
    }[keyof EphemeralEventData]

export type OpencodeEventType = OpencodeEvent['type']

export type EventOf<Type extends OpencodeEventType> = Extract<OpencodeEvent, { type: Type }>

/**
 * Every curated type and its durability (exhaustive by construction). Durable
 * ones survive a feed outage in history; ephemeral ones must be re-read as state.
 */
export const EVENT_DURABILITY: { readonly [Type in OpencodeEventType]: 'durable' | 'ephemeral' } = {
  'server.connected': 'ephemeral',
  'session.created': 'durable',
  'session.agent.selected': 'durable',
  'session.model.selected': 'durable',
  'session.renamed': 'durable',
  'session.permissions': 'durable',
  'session.deleted': 'durable',
  'session.inbox.enqueued': 'durable',
  'session.inbox.delivered': 'durable',
  'session.inbox.cancelled': 'durable',
  'session.inbox.delivery.changed': 'durable',
  'session.execution.started': 'durable',
  'session.execution.succeeded': 'durable',
  'session.execution.failed': 'durable',
  'session.execution.interrupted': 'durable',
  'session.step.started': 'durable',
  'session.step.streamed': 'durable',
  'session.step.ended': 'durable',
  'session.step.failed': 'durable',
  'session.text.started': 'durable',
  'session.text.ended': 'durable',
  'session.reasoning.started': 'durable',
  'session.reasoning.ended': 'durable',
  'session.tool.input.started': 'durable',
  'session.tool.input.ended': 'durable',
  'session.tool.called': 'durable',
  'session.tool.success': 'durable',
  'session.tool.failed': 'durable',
  'session.retry.scheduled': 'durable',
  'session.compaction.started': 'durable',
  'session.compaction.ended': 'durable',
  'session.compaction.failed': 'durable',
  'session.usage.updated': 'ephemeral',
  'session.text.delta': 'ephemeral',
  'session.reasoning.delta': 'ephemeral',
  'session.tool.input.delta': 'ephemeral',
  'session.tool.progress': 'ephemeral',
  'session.compaction.delta': 'ephemeral',
  'permission.asked': 'ephemeral',
  'permission.replied': 'ephemeral',
  'form.created': 'ephemeral',
  'form.replied': 'ephemeral',
  'form.cancelled': 'ephemeral',
  'credential.updated': 'ephemeral',
  'credential.switched': 'ephemeral',
  'provider.updated': 'ephemeral',
  'model.updated': 'ephemeral'
}

/** Narrows a parsed frame to the curated union; anything else is not ClaudeUI's concern. */
export function isOpencodeEvent(value: { readonly type?: unknown }): value is OpencodeEvent {
  return typeof value.type === 'string' && Object.hasOwn(EVENT_DURABILITY, value.type)
}

/** The session an event belongs to, when it has one (`form.created` nests it in `form`). */
export function eventSessionID(event: OpencodeEvent): string | undefined {
  if (event.type === 'form.created') return event.data.form.sessionID
  const data: object = event.data
  return 'sessionID' in data && typeof data.sessionID === 'string' ? data.sessionID : undefined
}

import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import type { HostWindowHandle } from '../host'
import { BaseSession } from '../providers/BaseSession'
import type { EngineSpawnOptions } from '../providers/ISession'
import type {
  ApprovalDecision,
  FileDiff,
  PendingApproval,
  PermissionSuggestion,
  QueuedItem,
  SessionStatus,
  ChatMessage,
  MeteringSnapshot
} from '../../shared/types'
import type {
  CodexApprovalDecision,
  CodexSessionState,
  CodexSettings
} from '../../shared/codex-types'
import { mergeContentBlocks } from '../../shared/content-blocks'
import { isImageMediaType } from '../../shared/types'
import { parseCodexSettings, savedCodexOverrides, codexSandboxPolicy } from './settings'
import type { AskForApproval } from './protocol/v2/AskForApproval'
import type { ApprovalsReviewer } from './protocol/v2/ApprovalsReviewer'
import type { SandboxMode } from './protocol/v2/SandboxMode'
import type { SandboxPolicy } from './protocol/v2/SandboxPolicy'
import {
  decideWithSource,
  mergedClaudeRulesFor,
  normalizeWhitespace,
  sessionAllowKey,
  type PermissionDecision,
  PI_TOOL_TO_CLAUDE_TOOL,
  PLAN_MODE_DENY_REASON
} from '../pi/permission-engine'
import { persistAllowSuggestions } from '../opencode/permission-compiler'
import type { ThreadSettings } from './protocol/v2/ThreadSettings'
import type { ThreadTokenUsage } from './protocol/v2/ThreadTokenUsage'
import { resolveCodexCapabilities } from '../../shared/model-capabilities'
import { CodexClient } from './CodexClient'
import { CodexTransportError, type CodexClientOptions } from './CodexAppServerClient'
import type { Model } from './protocol/v2/Model'
import type { JsonValue } from './protocol/serde_json/JsonValue'
import type { ThreadItem } from './protocol/v2/ThreadItem'
import type { UserInput } from './protocol/v2/UserInput'
import type { Turn } from './protocol/v2/Turn'
import type { CommandExecutionRequestApprovalParams } from './protocol/v2/CommandExecutionRequestApprovalParams'
import type { GuardianApprovalReviewAction } from './protocol/v2/GuardianApprovalReviewAction'
import type { ItemGuardianApprovalReviewCompletedNotification } from './protocol/v2/ItemGuardianApprovalReviewCompletedNotification'
import type { FileChangeRequestApprovalParams } from './protocol/v2/FileChangeRequestApprovalParams'
import type { ToolRequestUserInputParams } from './protocol/v2/ToolRequestUserInputParams'
import { assertCodexProvider, selectCodexModel } from './model-selection'
import { codexItemId, mapCodexDelta, mapCodexItem, type CodexMappedEvent } from './event-mapper'
import {
  CODEX_HOSTED_TOOL_NAMES,
  codexDynamicToolSpecs,
  runCodexHostedTool
} from './codex-hosted-tools'
import type { DynamicToolCallResponse } from './protocol/v2/DynamicToolCallResponse'
import type { DynamicToolCallOutputContentItem } from './protocol/v2/DynamicToolCallOutputContentItem'
import type { ToolResultContent } from '../sdk/types'
import { unwrapShellCommand } from './command-text'
import { BashStreamGate } from '../opencode/bash-stream-gate'
import {
  setSessionMeta,
  getCodexSessionOverrides,
  setCodexSessionOverrides,
  ensureCodexSessionOverrides
} from '../services/db'

const serverMethods = [
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/tool/requestUserInput',
  'item/permissions/requestApproval',
  // ClaudeUI's own hosted tools, offered on `thread/start` and called back here
  // (codex-hosted-tools.ts). Not an approval — it is the tool RUN itself.
  'item/tool/call'
] as const
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/**
 * AUTO-MODE VISIBILITY. Under `auto` the native `auto_review` guardian answers
 * every gated action itself: no approval request reaches this client, no thread
 * item is produced, and nothing in `thread/read` reconstructs the decision
 * afterwards (docs/codex-spike.md, "Native reviewer and judge-thread
 * probe (2026-09-11)", pinned by
 * src/integration/codex/codex-auto-review-probe.integration.test.ts). The
 * `item/autoApprovalReview/completed` notification is therefore the ONLY trace
 * a command or patch leaves, which is why it becomes a transcript row.
 *
 * Everything downstream of `review.rationale` treats it as UNTRUSTED: it is
 * model-authored text from a thread the user never sees, so it is
 * whitespace-collapsed (no forged second row), length-capped, and rendered as
 * plain text in the system bubble.
 */
const GUARDIAN_VERB: Record<string, string> = {
  approved: 'approved',
  denied: 'denied',
  timedOut: 'timed out reviewing',
  aborted: 'stopped reviewing',
  inProgress: 'did not finish reviewing'
}
const GUARDIAN_RATIONALE_LIMIT = 500
const GUARDIAN_ACTION_LIMIT = 200

const clip = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit - 1)}\u2026` : text

/** Human label for the reviewed action; commands are backticked, the rest read as prose. */
function guardianActionLabel(action: GuardianApprovalReviewAction): string {
  const short = (text: string): string => clip(normalizeWhitespace(text), GUARDIAN_ACTION_LIMIT)
  switch (action.type) {
    case 'command':
      // The wire carries Codex's own `<shell> -lc <script>` wrapper; the user
      // asked about the script, and a rule they wrote would name the script.
      return `\`${short(unwrapShellCommand(action.command))}\``
    case 'execve':
      return `\`${short((action.argv.length ? action.argv : [action.program]).join(' '))}\``
    case 'writeStdin':
      return 'input to a running command'
    case 'applyPatch':
      return `changes to ${short(action.files.join(', ')) || short(action.cwd)}`
    case 'networkAccess':
      return `network access to ${short(action.host)}:${action.port}`
    case 'mcpToolCall':
      return `MCP tool ${short(`${action.server}/${action.toolName}`)}`
    case 'requestPermissions':
      return 'a permissions request'
    default:
      return 'an action'
  }
}

/**
 * The three reviewed actions a denial override can express. `writeStdin`,
 * `networkAccess`, `mcpToolCall` and `requestPermissions` are deliberately out:
 * the first two have no declined thread item to hang a card on (a network review
 * carries `targetItemId: null` by design), and the last two are behind
 * under-development features this adapter does not enable.
 */
const OVERRIDABLE_ACTIONS = new Set(['command', 'execve', 'applyPatch'])

/**
 * The v2 notification carries a CAMEL-cased projection of the core's own
 * `GuardianAssessmentAction` (`app-server-protocol/src/protocol/v2/item.rs`,
 * `From<CoreGuardianAssessmentAction>`), but
 * `thread_approve_guardian_denied_action_inner` deserializes the CORE type,
 * which is `#[serde(tag = "type", rename_all = "snake_case")]`
 * (`protocol/src/approvals.rs`). So the tag is re-spelled, and so is the
 * `GuardianCommandSource` VALUE — camelCase `unifiedExec` there, snake_case
 * `unified_exec` here.
 */
function guardianDenialAction(action: GuardianApprovalReviewAction): JsonValue {
  const source = (value: string): string => (value === 'unifiedExec' ? 'unified_exec' : value)
  switch (action.type) {
    case 'command':
      // Echoed EXACTLY as received, login-shell wrapper included: the core
      // serializes this action straight back into the model's context, and a
      // command it cannot recognise is an approval for something else.
      return {
        type: 'command',
        source: source(action.source),
        command: action.command,
        cwd: action.cwd
      }
    case 'execve':
      return {
        type: 'execve',
        source: source(action.source),
        program: action.program,
        argv: action.argv,
        cwd: action.cwd
      }
    case 'applyPatch':
      return { type: 'apply_patch', cwd: action.cwd, files: action.files }
    default:
      throw new Error('Codex auto-review denial cannot be overridden')
  }
}

/**
 * The core `GuardianAssessmentEvent` rebuilt from the v2 notification. Every
 * field but `id`, `status` and `action` is `#[serde(default)]` upstream, and
 * `approve_guardian_denied_action` reads only `status` and `action`, but the
 * rest is echoed verbatim so the event stays a faithful record of the review
 * that produced it rather than a minimal stub.
 */
function guardianDenialEvent(
  notification: ItemGuardianApprovalReviewCompletedNotification
): JsonValue {
  const { review } = notification
  return {
    id: notification.reviewId,
    target_item_id: notification.targetItemId,
    turn_id: notification.turnId,
    started_at_ms: notification.startedAtMs,
    completed_at_ms: notification.completedAtMs,
    // `GuardianAssessmentStatus` is snake_case and the handler ignores every
    // value but this one (`core/src/session/handlers.rs`).
    status: 'denied',
    ...(review.riskLevel ? { risk_level: review.riskLevel } : {}),
    ...(review.userAuthorization ? { user_authorization: review.userAuthorization } : {}),
    ...(review.rationale ? { rationale: review.rationale } : {}),
    ...(notification.decisionSource ? { decision_source: notification.decisionSource } : {}),
    action: guardianDenialAction(notification.action)
  }
}

/** One flat sentence per decision — see GUARDIAN_VERB for the untrusted-text rules. */
export function guardianReviewText(
  notification: ItemGuardianApprovalReviewCompletedNotification
): string {
  const { review, action } = notification
  const verb = GUARDIAN_VERB[review.status] ?? 'reviewed'
  const risk = review.riskLevel ? ` (risk: ${review.riskLevel})` : ''
  const rationale = review.rationale
    ? ` ${clip(normalizeWhitespace(review.rationale), GUARDIAN_RATIONALE_LIMIT)}`
    : ''
  return `Codex auto-review ${verb} ${guardianActionLabel(action)}${risk}.${rationale}`
}

/**
 * `core/src/guardian/review.rs` is the ONLY emitter of `GuardianWarning`, in
 * exactly three places:
 *  - :709-717 `"Automatic approval review {approved|denied} (risk: {r},
 *    authorization: {a}): {rationale}"`, once per decision — a restatement of
 *    the review this adapter already rowed.
 *  - :590-597 the timeout rationale verbatim (set at :575), `"Automatic
 *    approval review timed out while evaluating the requested approval."`,
 *    which ALSO arrives as the completed review's `rationale`.
 *  - :298-307 the circuit breaker, `"Automatic approval review rejected too
 *    many approval requests for this turn (N consecutive, M in the last 50
 *    reviews); interrupting the turn."` — the only one that is not a duplicate,
 *    and the only signal that the turn was KILLED rather than finished.
 * So the first two are dropped and the third is both a row and an error.
 */
const GUARDIAN_DECISION_WARNING =
  /^Automatic approval review (?:approved|denied) \(risk: |^Automatic approval review timed out /
const GUARDIAN_BREAKER_WARNING =
  /^Automatic approval review rejected too many approval requests for this turn\b/

type Pending = {
  turnId: string
  choices: CodexApprovalDecision[]
  questions?: ToolRequestUserInputParams['questions']
  /** `sessionAllows` keys to add when a human answers `allowForSession`. */
  allowKeys: string[]
  settle: (value?: unknown) => void
}

/** Inline images are the only attachment Codex takes on either turn transport. */
type CodexAttachments = Array<{ mediaType: string; base64Data: string }>

/**
 * A `turn/steer` whose delivery the transport could not decide: the request was
 * written to the binary and then timed out, so the message may or may not be in
 * the model's context. Held, never resent, until the owning turn's own history
 * answers the question.
 */
type AmbiguousSteer = { turnId: string; clientUserMessageId: string }

/** One gated action inside a native request — one command, or one changed file. */
type Gated = { tool: string; input: Record<string, unknown>; path?: string }

/**
 * A denied guardian review the human can still reverse. It is NOT a `Pending`:
 * there is no server request parked behind it, nothing settles it, and
 * `finishTurn` must leave it alone — the injected approval only has to reach
 * Codex before the model's next turn, which is exactly when it expires.
 */
type GuardianOverride = {
  /** The card itself — kept so a repeated `tool_result` can re-arm it verbatim. */
  card: PendingApproval
  /** Core-shaped `GuardianAssessmentEvent`, ready to send back verbatim. */
  event: JsonValue
  /** Human label for the reviewed action, already backticked where it helps. */
  label: string
  /** Transcript row this override writes once Codex accepts it. */
  rowId: string
}

/**
 * Per-turn native policy. Codex EXECUTES, ClaudeUI DECIDES (ADR-066 slice 3):
 * every turn but `auto` runs `untrusted`, the one policy the pinned binary asks
 * before running anything (docs/codex-spike.md, "Native approval surface probe"
 * answer B), so every command and file change arrives as a server request for
 * ClaudeUI's own permission engine to answer. `auto` is the exception — it hands
 * review to Codex's native `auto_review` subagent under `on-request`, and only
 * what that subagent escalates reaches us, gated exactly like `default`.
 *
 * The sandbox is the containment floor, not the decision: an ACCEPTED command
 * runs unsandboxed on this wire regardless (same probe, "Other observations").
 */
const TURN_POLICY: Record<
  string,
  { approvalPolicy: AskForApproval; sandbox: SandboxMode; approvalsReviewer: ApprovalsReviewer }
> = {
  plan: { approvalPolicy: 'untrusted', sandbox: 'read-only', approvalsReviewer: 'user' },
  default: { approvalPolicy: 'untrusted', sandbox: 'workspace-write', approvalsReviewer: 'user' },
  acceptEdits: {
    approvalPolicy: 'untrusted',
    sandbox: 'workspace-write',
    approvalsReviewer: 'user'
  },
  auto: {
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write',
    approvalsReviewer: 'auto_review'
  }
}

/**
 * MCP-shaped handler output -> the native `contentItems` the app-server accepts.
 * Images travel as INLINE data URLs: `decode_response` rejects a remote image
 * URL outright (`REMOTE_IMAGE_URL_ERROR`). Anything else a handler could
 * theoretically return has no native counterpart and is dropped rather than
 * stringified into the model's context.
 */
function hostedContentItems(result: ToolResultContent): DynamicToolCallOutputContentItem[] {
  return result.content.flatMap((block): DynamicToolCallOutputContentItem[] => {
    if (block.type === 'text' && typeof block.text === 'string')
      return [{ type: 'inputText', text: block.text }]
    if (
      block.type === 'image' &&
      typeof block.data === 'string' &&
      typeof block.mimeType === 'string'
    )
      return [{ type: 'inputImage', imageUrl: `data:${block.mimeType};base64,${block.data}` }]
    return []
  })
}

/** One root owns one one-shot client. No native queue or child adoption. */
export class CodexSession extends BaseSession {
  readonly engineId = 'codex' as const
  readonly capabilities = resolveCodexCapabilities()
  private readonly client: CodexClient
  private readonly generation = randomUUID()
  private starting?: Promise<void>
  private closed = false
  private busy = false
  private sending = false
  private interruptRequested = false
  private settingsUpdating = false
  private deltas = new Map<string, ChatMessage>()
  private threadId: string | null = null
  private turnId: string | null = null
  private endedTurns = new Set<string>()
  private completedItems = new Map<string, string>()
  private catalog: Model[] = []
  private model?: string
  private effectiveModel?: string
  private effort?: string
  private native?: CodexSessionState
  private overrides: CodexSettings = {}
  private account: SessionStatus['account'] = null
  private permissionMode: string
  /** "Allow for this session" clicks, in the shared engine's key vocabulary. */
  private sessionAllows = new Set<string>()
  private pending = new Map<string, Pending>()
  /** Guardian-denial overrides by requestId — never `this.pending` (see the type). */
  private guardianOverrides = new Map<string, GuardianOverride>()
  /** Denials whose declined item has not been mapped yet, by that item's id. */
  private heldDenials = new Map<string, ItemGuardianApprovalReviewCompletedNotification>()
  /** Hosted-tool `callId`s already executed this process generation — one shot each. */
  private hostedCalls = new Set<string>()
  /** Queue items whose steer timed out ambiguously, by queue item id. */
  private ambiguousSteers = new Map<string, AmbiguousSteer>()
  /** Serializes queue boundaries — see {@link queueBoundary}. */
  private flushChain: Promise<void> = Promise.resolve()
  private output = new Map<string, string>()
  private bashGate = new BashStreamGate((toolUseId, output) =>
    this.send('session:bash-output', { toolUseId, output })
  )

  constructor(
    routingId: string,
    win: HostWindowHandle | null,
    cwd: string,
    private readonly options: EngineSpawnOptions = {},
    transport: Pick<CodexClientOptions, 'env' | 'requestTimeoutMs' | 'killGraceMs'> = {},
    createClient: (options: CodexClientOptions) => CodexClient = (options) =>
      new CodexClient(options)
  ) {
    super(routingId, win, cwd)
    this.model = options.model
    this.effort = options.effort
    this.permissionMode = options.permissionMode ?? 'default'
    this.client = createClient({
      ...transport,
      cwd,
      serverMethods,
      onNotification: (method, params) => this.notification(method, params),
      onServerRequest: (method, params, context) =>
        method === 'item/tool/call'
          ? this.hostedToolCall(params, context)
          : this.requestApproval(method, params, context),
      onDisconnect: (error) => this.disconnected(error)
    })
  }

  get willQueue(): boolean {
    return this.busy || this.sending || this.settingsUpdating
  }
  getSessionId(): string | null {
    return this.threadId
  }

  /** Codex takes inline images only, and only well-formed base64 of one. */
  private assertAttachments(attachments?: CodexAttachments): void {
    if (
      attachments?.some(
        (attachment) =>
          !isImageMediaType(attachment.mediaType) ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(attachment.base64Data)
      )
    )
      throw new Error('Codex accepts inline PNG/JPEG/GIF/WebP image attachments only')
  }

  /**
   * The one input mapping both transports use — `turn/start` and `turn/steer`
   * take the same `UserInput[]`, so a divergence here would be a queued message
   * that reaches the model differently from a typed one.
   */
  private turnInput(prompt: string, attachments?: CodexAttachments): UserInput[] {
    this.assertAttachments(attachments)
    return [
      { type: 'text', text: prompt, text_elements: [] },
      ...(attachments ?? []).map((attachment) => ({
        type: 'image' as const,
        url: `data:${attachment.mediaType};base64,${attachment.base64Data}`
      }))
    ]
  }

  /**
   * Hand ONE held item to Codex (ADR-053 on this engine's two transports).
   *
   * Mid-turn it is `turn/steer` with `expectedTurnId`, which injects the text
   * into the RUNNING turn — the native queue would start a different one, which
   * is why core keeps the queue of record. At idle it is the ordinary
   * `turn/start`, taken directly rather than through `handlers-core.sendPrompt`
   * because that path emits its own `session:user-message` and the queue path
   * must not (the `consumed` broadcast is what synthesizes the row).
   *
   * Either way the id travels as `steer-<itemId>`, so the native `userMessage`
   * comes back with that `clientId` and `mapCodexItem` turns it into a
   * `replacesMessageId` — identity, never text, so duplicates cannot collide.
   *
   * Never throws: {@link BaseSession.flushQueuedItems} reads delivery off the
   * item's own state, and an item left `queued` is one the next boundary retries.
   */
  protected override async forwardQueuedItem(item: QueuedItem): Promise<void> {
    if (this.closed || !this.threadId) return
    // Uncertain delivery is NOT a reason to send again — that is the one way to
    // double a message. It waits for `turn/completed` to settle it.
    if (this.ambiguousSteers.has(item.itemId)) return
    const clientUserMessageId = `steer-${item.itemId}`
    const turnId = this.turnId
    if (this.busy && turnId) {
      try {
        await this.client.request('turn/steer', {
          threadId: this.threadId,
          expectedTurnId: turnId,
          clientUserMessageId,
          input: this.turnInput(item.text, item.attachments)
        })
      } catch (error) {
        // An ambiguous timeout MAY have been delivered, so it is reconciled and
        // never resent. Anything else is a refusal the binary spelled out — an
        // `expectedTurnId` mismatch, a non-steerable (review/compact) turn, a
        // rejected input — so nothing was delivered, the item stays queued and
        // recallable, and the base loop stops here to retry at the next boundary.
        if (
          error instanceof CodexTransportError &&
          error.code === 'request-timeout' &&
          error.ambiguousDelivery
        )
          await this.reconcileSteer(item, { turnId, clientUserMessageId })
        return
      }
      // Acceptance is the response itself; the native user item may follow much
      // later, or (on an interrupted turn) not at all.
      if (this.queue.consumeById(item.itemId)) this.queue.emit()
      return
    }
    try {
      await this.run(item.text, item.attachments, clientUserMessageId)
    } catch {
      // `run()` already surfaced the failure (and disposed if it was fatal).
      return
    }
    if (this.queue.consumeById(item.itemId)) this.queue.emit()
  }

  /**
   * Ask the turn's own history whether an ambiguous steer landed. Consumes it
   * if so; otherwise parks it as unrecallable and unsent until the turn ends —
   * the honest middle state ADR-066 asks for, since the message may already be
   * in the model's context.
   */
  private async reconcileSteer(item: QueuedItem, steer: AmbiguousSteer): Promise<void> {
    if (await this.steerLanded(steer).catch(() => false)) {
      if (this.queue.consumeById(item.itemId)) this.queue.emit()
      return
    }
    // The owning turn has already ended, so the read above WAS the turn-end
    // reconciliation: nothing more can land, and the item is ordinary again.
    if (this.endedTurns.has(steer.turnId)) return
    this.ambiguousSteers.set(item.itemId, steer)
    this.send(
      'session:error',
      'Codex could not confirm a queued message reached the running turn. It is held, unsent, until the turn ends.'
    )
  }

  /**
   * Boundary signals are serialized on their OWN chain rather than fired blind.
   * Two reasons, both real here: a turn can end while its own steer is still on
   * the wire, and {@link BaseSession.flushQueuedItems}'s re-entrancy guard drops
   * an overlapping signal — which would strand the item, since a finished turn
   * emits no further boundary. Chaining also orders the turn-end reconciliation
   * AFTER the steer that may have gone ambiguous, so it reads for the right id.
   */
  private queueBoundary(endedTurnId?: string): void {
    this.flushChain = this.flushChain
      .then(() =>
        endedTurnId === undefined ? this.flushQueuedItems() : this.settleQueue(endedTurnId)
      )
      .catch(() => {})
  }

  /** Turn-end pass: settle what the timeout left open, then forward what is left. */
  private async settleQueue(turnId: string): Promise<void> {
    for (const [itemId, steer] of [...this.ambiguousSteers]) {
      if (steer.turnId !== turnId) continue
      // Dropped either way: the turn is over, so this is the last word on it.
      // A failed read counts as "not found" HERE only, where a resend is safe.
      this.ambiguousSteers.delete(itemId)
      if ((await this.steerLanded(steer).catch(() => false)) && this.queue.consumeById(itemId))
        this.queue.emit()
    }
    await this.flushQueuedItems()
  }

  /** Is there a `userMessage` in this turn carrying the steer's own client id? */
  private async steerLanded({ turnId, clientUserMessageId }: AmbiguousSteer): Promise<boolean> {
    let cursor: string | null = null
    for (let page = 0; page < 20; page++) {
      if (this.closed || !this.threadId) return false
      const result = await this.client.request('thread/items/list', {
        threadId: this.threadId,
        turnId,
        cursor,
        limit: 100,
        sortDirection: 'asc'
      })
      if (
        result.data.some(
          (entry) =>
            entry.item.type === 'userMessage' && entry.item.clientId === clientUserMessageId
        )
      )
        return true
      if (!result.nextCursor) return false
      cursor = result.nextCursor
    }
    return false
  }

  /**
   * Recall (ADR-053) is take-back of something core still holds. An ambiguous
   * steer is not that: the engine may already have it, so it cannot be offered
   * back as if it never left.
   */
  protected override async tryRecallQueuedItem(item: QueuedItem): Promise<boolean> {
    if (this.ambiguousSteers.has(item.itemId)) return false
    return super.tryRecallQueuedItem(item)
  }

  async run(
    prompt: string | null,
    attachments?: CodexAttachments,
    clientUserMessageId = `msg-${randomUUID()}`
  ): Promise<void> {
    if (this.closed) throw new Error('Codex session is disconnected')
    this.assertAttachments(attachments)
    if (this.willQueue && prompt !== null)
      throw new Error('Codex turn is already running; send this prompt through the queue')
    if (prompt !== null) {
      this.sending = true
      this.clearInactivityTimer()
      this.status('running')
    }
    try {
      if (!this.starting) this.starting = this.start()
      await this.starting
      if (this.closed) throw new Error('Codex session is disconnected')
      if (prompt === null) return
      this.busy = true
      this.clearInactivityTimer()
      this.status('running')
      const result = await this.client.request('turn/start', {
        threadId: this.threadId!,
        clientUserMessageId,
        input: this.turnInput(prompt, attachments),
        ...(this.model !== undefined ? { model: this.model } : {}),
        ...(this.effort !== undefined ? { effort: this.effort } : {}),
        ...this.turnPolicy()
      })
      if (this.closed) return
      // A guardian override is context injected for the model's NEXT turn. Once
      // that turn has started, an unanswered offer can no longer reach it.
      this.clearGuardianOverrides()
      if (!this.endedTurns.has(result.turn.id)) this.turnId = result.turn.id
      if (this.interruptRequested && this.turnId) await this.interrupt()
      if (result.turn.status !== 'inProgress') this.finishTurn(result.turn)
      // Native clientId reconciles the core-minted row with the persisted native item.
    } catch (error) {
      // A failed/ambiguous start must never become an automatic retry or native queued turn.
      if (!this.closed) {
        this.send('session:error', error instanceof Error ? error.message : 'Codex turn failed')
        this.dispose()
      }
      throw error
    } finally {
      if (prompt !== null) this.sending = false
    }
  }

  private async start(): Promise<void> {
    try {
      if (this.options.forkSession || this.options.resumeSessionAt)
        throw new Error('Codex fork is not implemented')
      const saved = this.options.resumeSessionId
        ? savedCodexOverrides(getCodexSessionOverrides(this.options.resumeSessionId))
        : {}
      this.overrides = { ...saved }
      if (this.model !== undefined) this.overrides.model = this.model
      else this.model = saved.model
      if (this.effort !== undefined) this.overrides.effort = this.effort
      else this.effort = saved.effort
      await this.client.start({
        clientInfo: { name: 'claudeui_session', title: 'Codex session', version: '1' },
        capabilities: { experimentalApi: true, requestAttestation: false }
      })
      const { config } = await this.client.request('config/read', {
        cwd: this.cwd,
        includeLayers: false
      })
      assertCodexProvider(config.model_provider)
      const account = (await this.client.request('account/read', { refreshToken: false })).account
      if (account?.type === 'chatgpt' || account?.type === 'apiKey')
        this.account = {
          engineId: 'codex',
          vendorId: 'openai',
          authState: 'authenticated',
          billingType: account.type === 'chatgpt' ? 'subscription' : 'apiKey'
        }
      const cursors = new Set<string>()
      let cursor: string | null = null
      for (let page = 0; ; page++) {
        if (page === 100) throw new Error('Codex catalog page limit')
        const result = await this.client.request('model/list', {
          cursor,
          limit: 100,
          includeHidden: false
        })
        this.catalog.push(...result.data)
        if (!result.nextCursor) break
        if (cursors.has(result.nextCursor)) throw new Error('Codex repeated catalog cursor')
        cursors.add(result.nextCursor)
        cursor = result.nextCursor
      }
      this.model =
        this.options.resumeSessionId && this.model === undefined
          ? undefined
          : selectCodexModel(this.catalog, config.model, this.model)
      this.validateEffort(this.effort)
      // The thread BASELINE must agree with the per-turn override, so a turn
      // that somehow starts without one (native queue, a future steer path)
      // still runs under this mode's policy rather than the user's config.
      const { approvalPolicy, sandbox, approvalsReviewer } = this.modePolicy()
      const params = {
        cwd: this.cwd,
        ...(this.model !== undefined ? { model: this.model } : {}),
        approvalPolicy,
        sandbox,
        approvalsReviewer
      }
      const response = this.options.resumeSessionId
        ? await this.client.request('thread/resume', {
            ...params,
            threadId: this.options.resumeSessionId
          })
        : await this.client.request('thread/start', {
            ...params,
            allowProviderModelFallback: false,
            historyMode: 'paginated',
            // START ONLY. `thread/resume` has no `dynamicTools` field, and it
            // needs none: the specs are written into the rollout's SessionMeta
            // at creation (`core/src/session/session.rs`, `CreateThreadParams
            // .dynamic_tools`) and a resume with an empty list restores them
            // from there (`core/src/session/mod.rs:721`).
            dynamicTools: codexDynamicToolSpecs()
          })
      if (this.closed) return
      assertCodexProvider(response.modelProvider)
      if (this.options.resumeSessionId && response.thread.id !== this.options.resumeSessionId)
        throw new Error('Codex resumed a different native thread')
      if (response.thread.parentThreadId)
        throw new Error('Native child threads must be controlled by their owning root')
      if (this.model !== undefined && response.model !== this.model)
        throw new Error('Codex silently changed the requested model')
      this.threadId = response.thread.id
      this.model = response.model
      this.effectiveModel = response.model
      this.capabilities.vision =
        this.catalog
          .find((entry) => entry.model === this.model)
          ?.inputModalities?.includes('image') ?? false
      this.native = {
        modelProvider: response.modelProvider,
        reasoningEffort: response.reasoningEffort,
        effortOptions: this.effortOptions()
      }
      this.capabilities.reasoning = { nativeEffort: { options: this.native.effortOptions } }
      setSessionMeta(this.threadId, {
        engineId: 'codex',
        model: { engineId: 'codex', vendorId: response.modelProvider, modelId: response.model }
      })
      ensureCodexSessionOverrides(this.threadId)
      this.status('idle')
      if (this.effort !== undefined)
        await this.client.request('thread/settings/update', {
          threadId: this.threadId,
          effort: this.effort
        })
      setCodexSessionOverrides(this.threadId, this.overrides)
      this.resetInactivityTimer()
    } catch (error) {
      if (!this.closed) {
        this.send('session:error', error instanceof Error ? error.message : 'Codex startup failed')
        this.dispose()
      }
      throw error
    }
  }

  private effortOptions(): Array<{ value: string; description: string }> {
    return (
      this.catalog
        .find((entry) => entry.model === this.model)
        ?.supportedReasoningEfforts.map((option) => ({
          value: option.reasoningEffort,
          description: option.description
        })) ?? []
    )
  }

  private validateEffort(effort?: string): void {
    const options = this.effortOptions()
    if (
      effort !== undefined &&
      options.length &&
      !options.some((option) => option.value === effort)
    )
      throw new Error('Codex reasoning effort is unavailable for the selected model')
  }

  async setModel(model: string): Promise<void> {
    await this.setCodexSettings({ model })
  }

  /**
   * The single funnel both native settings writes take — `setModel` and
   * `setEffort` are the only callers, and the only channels that reach them are
   * the engine-neutral `session:set-model` / `session:set-effort`.
   */
  async setCodexSettings(value: CodexSettings): Promise<void> {
    const settings = parseCodexSettings(value)
    if (!this.starting) {
      if (settings.model !== undefined) this.model = settings.model
      if (settings.effort !== undefined) this.effort = settings.effort
      this.starting = this.start()
    }
    await this.starting
    if (this.closed) throw new Error('Codex session is disconnected')
    if (this.settingsUpdating) throw new Error('Codex settings update is already pending')
    if (settings.model !== undefined) selectCodexModel(this.catalog, undefined, settings.model)
    const model = this.catalog.find((entry) => entry.model === (settings.model ?? this.model))
    if (
      settings.effort !== undefined &&
      model &&
      !model.supportedReasoningEfforts.some((option) => option.reasoningEffort === settings.effort)
    )
      throw new Error('Codex effort is unavailable for this model')
    this.settingsUpdating = true
    this.clearInactivityTimer()
    this.status('running')
    try {
      await this.client.request('thread/settings/update', {
        threadId: this.threadId!,
        ...settings
      })
      if (this.closed) throw new Error('Codex disconnected before settings could be saved')
      if (settings.model !== undefined) this.model = settings.model
      if (settings.effort !== undefined) this.effort = settings.effort
      const accepted = { ...this.overrides, ...settings }
      try {
        setCodexSessionOverrides(this.threadId!, accepted)
      } catch {
        throw new Error('Native settings were applied but could not be saved for reconnect')
      }
      this.overrides = accepted
      if (settings.model !== undefined)
        setSessionMeta(this.threadId!, {
          engineId: 'codex',
          model: {
            engineId: 'codex',
            vendorId: this.native!.modelProvider,
            modelId: settings.model
          }
        })
    } finally {
      this.settingsUpdating = false
      if (!this.closed) {
        this.status(this.busy ? 'running' : 'idle')
        if (!this.busy) this.resetInactivityTimer()
      }
    }
  }

  setEffort(effort: string): Promise<void> {
    this.validateEffort(effort)
    return this.setCodexSettings({ effort })
  }

  /**
   * Applies from the NEXT turn. A live turn is not re-policied mid-flight:
   * `turn/steer` is not implemented, and `thread/settings/update` acknowledges
   * out of band (docs/codex-spike.md answer F), so retro-fitting the running
   * turn would leave the mode and the in-flight approvals disagreeing.
   */
  async setPermissionMode(mode: string): Promise<void> {
    this.permissionMode = mode
    this.send('session:permission-mode', mode)
  }

  /** The native policy this session's shared mode maps onto. Unknown modes fail toward asking. */
  private modePolicy(): (typeof TURN_POLICY)[string] {
    return TURN_POLICY[this.permissionMode] ?? TURN_POLICY.default
  }

  private turnPolicy(): {
    approvalPolicy: AskForApproval
    sandboxPolicy: SandboxPolicy
    approvalsReviewer: ApprovalsReviewer
  } {
    const { approvalPolicy, sandbox, approvalsReviewer } = this.modePolicy()
    return { approvalPolicy, sandboxPolicy: codexSandboxPolicy(sandbox), approvalsReviewer }
  }

  async interrupt(): Promise<void> {
    if (this.sending && !this.threadId) {
      this.dispose()
      return
    }
    if (this.willQueue) this.interruptRequested = true
    if (this.threadId && this.turnId && !this.closed)
      try {
        this.interruptRequested = false
        await this.client.request('turn/interrupt', {
          threadId: this.threadId,
          turnId: this.turnId
        })
      } catch (error) {
        this.dispose()
        throw error
      }
  }

  cancel(): void {
    this.dispose()
  }
  dispose(): void {
    if (this.closed) return
    this.disconnected()
    this.client.dispose()
  }

  private disconnected(error?: CodexTransportError): void {
    if (this.closed) return
    this.closed = true
    this.busy = false
    this.sending = false
    this.turnId = null
    this.clearInactivityTimer()
    this.bashGate.cancelAll()
    this.output.clear()
    this.heldDenials.clear()
    this.ambiguousSteers.clear()
    for (const pending of [...this.pending.values()]) pending.settle()
    this.clearGuardianOverrides()
    // Nothing held can ever run now: the engine that would have taken it is
    // gone. Say so (ADR-053) rather than leaving items pending forever.
    this.recallQueuedOnEngineLoss()
    if (error && error.code !== 'disposed') this.send('session:error', error.message)
    this.status('disconnected')
  }

  private status(state: SessionStatus['state']): void {
    if (state === 'idle' && this.settingsUpdating) state = 'running'
    this.send('session:status', {
      ...this.baseStatusFields(),
      state,
      sessionId: this.threadId,
      model:
        this.effectiveModel && this.native
          ? { engineId: 'codex', vendorId: this.native.modelProvider, modelId: this.effectiveModel }
          : null,
      cwd: this.cwd,
      totalCostUsd: 0,
      account: this.account,
      ...(this.native ? { codex: { ...this.native, overrides: { ...this.overrides } } } : {})
    } satisfies SessionStatus)
  }

  private notification(method: string, value: unknown): void {
    if (this.closed || !record(value) || value.threadId !== this.threadId || !this.threadId) return
    if (method === 'turn/started' && record(value.turn) && typeof value.turn.id === 'string') {
      if (this.endedTurns.has(value.turn.id)) return
      this.turnId = value.turn.id
      this.busy = true
      this.status('running')
      if (this.interruptRequested) void this.interrupt().catch(() => {})
    } else if (method === 'thread/settings/updated' && record(value.threadSettings)) {
      const settings = value.threadSettings as ThreadSettings
      assertCodexProvider(settings.modelProvider)
      this.model = this.effectiveModel = settings.model
      this.capabilities.vision =
        this.catalog
          .find((entry) => entry.model === this.model)
          ?.inputModalities?.includes('image') ?? false
      this.effort = settings.effort ?? undefined
      this.native = {
        modelProvider: settings.modelProvider,
        reasoningEffort: settings.effort,
        effortOptions: this.effortOptions()
      }
      this.capabilities.reasoning = { nativeEffort: { options: this.native.effortOptions } }
      setSessionMeta(this.threadId, {
        engineId: 'codex',
        model: { engineId: 'codex', vendorId: settings.modelProvider, modelId: settings.model }
      })
      this.status(this.busy ? 'running' : 'idle')
    } else if (method === 'thread/tokenUsage/updated' && record(value.tokenUsage)) {
      const usage = value.tokenUsage as ThreadTokenUsage
      if (usage.total && usage.last)
        this.send('session:metering', {
          engineId: 'codex',
          vendorId: this.native?.modelProvider ?? 'openai',
          billingType: this.account?.billingType ?? 'unknown',
          tokens: {
            input: usage.total.inputTokens,
            output: usage.total.outputTokens,
            cacheRead: usage.total.cachedInputTokens,
            cacheWrite: usage.total.cacheWriteInputTokens,
            total: usage.total.totalTokens
          },
          equivalentCostUsd: null,
          contextWindow: { used: usage.last.totalTokens, size: usage.modelContextWindow ?? 0 }
        } satisfies MeteringSnapshot)
      if (usage.total && usage.last)
        this.send('session:status-line', {
          totalCostUsd: 0,
          totalDurationMs: 0,
          totalApiDurationMs: 0,
          totalInputTokens: usage.total.inputTokens,
          totalOutputTokens: usage.total.outputTokens,
          cachedTokens: usage.total.cachedInputTokens,
          totalTokens: usage.total.totalTokens,
          contextWindowSize: usage.modelContextWindow ?? 0,
          usedPercentage: usage.modelContextWindow
            ? (usage.last.totalTokens / usage.modelContextWindow) * 100
            : null,
          remainingPercentage: usage.modelContextWindow
            ? Math.max(0, 100 - (usage.last.totalTokens / usage.modelContextWindow) * 100)
            : null
        })
    } else if (method === 'turn/completed' && record(value.turn)) {
      this.finishTurn(value.turn as Turn)
    } else if (
      method === 'item/autoApprovalReview/completed' &&
      typeof value.turnId === 'string' &&
      typeof value.reviewId === 'string' &&
      record(value.review) &&
      record(value.action)
    ) {
      // `started` is deliberately dropped: it carries no verdict, and a row per
      // in-flight review would double every decision in the transcript.
      const notification = value as unknown as ItemGuardianApprovalReviewCompletedNotification
      this.guardianRow(
        codexItemId(this.threadId, value.turnId, value.reviewId),
        guardianReviewText(notification)
      )
      this.offerGuardianOverride(notification)
    } else if (method === 'guardianWarning' && typeof value.message === 'string') {
      const message = value.message
      if (GUARDIAN_DECISION_WARNING.test(message)) return
      const text = `Codex auto-review: ${clip(normalizeWhitespace(message), GUARDIAN_RATIONALE_LIMIT)}`
      // No turnId on the wire (GuardianWarningNotification carries threadId and
      // message only), so the live turn stands in and the message hash keeps
      // repeats of the same warning on one row.
      this.guardianRow(
        `codex:${JSON.stringify([
          this.threadId,
          this.turnId ?? 'thread',
          'guardianWarning',
          createHash('sha256').update(message).digest('hex').slice(0, 16)
        ])}`,
        text
      )
      // The breaker ABORTS the turn. Without an error the transcript just stops.
      if (GUARDIAN_BREAKER_WARNING.test(message)) this.send('session:error', text)
    } else if (typeof value.turnId === 'string' && !this.endedTurns.has(value.turnId)) {
      if (method === 'item/started' || method === 'item/completed') {
        if (!record(value.item) || typeof value.item.id !== 'string') return
        this.item(value.turnId, value.item as ThreadItem, method === 'item/completed')
        // ADR-053: a completed item is this engine's observable sub-turn
        // boundary — the moment a held message can join the running turn.
        // Deltas are not (a steer between two tokens is not a boundary).
        if (method === 'item/completed') this.queueBoundary()
      } else if (typeof value.itemId === 'string' && typeof value.delta === 'string') {
        for (const event of mapCodexDelta(method, {
          threadId: this.threadId,
          turnId: value.turnId,
          itemId: value.itemId,
          delta: value.delta
        })) {
          if (event.kind === 'stream') {
            const id = codexItemId(this.threadId, value.turnId, value.itemId)
            if (this.completedItems.has(id)) continue
            const previous = this.deltas.get(id)
            const block = previous?.content[0]
            const text =
              (block && (block.type === 'text' || block.type === 'thinking') ? block.text : '') +
              event.delta.text
            const message: ChatMessage = {
              id,
              role: 'assistant',
              timestamp: previous?.timestamp ?? Date.now(),
              content: [{ type: event.delta.type, text }]
            }
            this.deltas.set(id, message)
            this.dispatch({ kind: 'message', message })
          } else this.dispatch(event)
        }
      }
    }
  }

  /**
   * A guardian decision is NOT a thread item: it never enters `completedItems`
   * and `turn.items` never carries it, which is exactly what keeps
   * `finishTurn`'s authoritative replay from dropping the row it produced.
   */
  private guardianRow(id: string, text: string): void {
    const timestamp =
      this.messageHistory.find((message) => message.id === id)?.timestamp ?? Date.now()
    this.dispatch({
      kind: 'message',
      message: { id, role: 'system', content: [{ type: 'text', text }], timestamp }
    })
  }

  /**
   * A denial is the one review outcome a human may want to reverse, so it also
   * raises an approval bound to the DECLINED item's own id. No pop-up: the card
   * is already in the transcript (`MessageBubble` binds by `toolUseId`, and
   * `FloatingApproval` only floats what no block matched), so the offer can be
   * taken or ignored without blocking anything.
   *
   * The review and its target item race — a real denial run emits the review
   * BEFORE the target's `item/completed` — so a denial is HELD until that item
   * has completed and `item()` raises it. Waiting for completion is not
   * cosmetic: every client drops a pending approval when a `tool_result` for
   * its `toolUseId` arrives (ADR-038's belt-and-suspenders rule, applied in
   * `sync/reducer.ts`), and a declined item's result is exactly that, so a card
   * raised any earlier is wiped the moment the denial reaches the transcript.
   */
  private offerGuardianOverride(
    notification: ItemGuardianApprovalReviewCompletedNotification
  ): void {
    const { review, action, targetItemId, turnId, reviewId } = notification
    if (
      !this.threadId ||
      review.status !== 'denied' ||
      typeof targetItemId !== 'string' ||
      !OVERRIDABLE_ACTIONS.has(action.type)
    )
      return
    const toolUseId = codexItemId(this.threadId, turnId, targetItemId)
    const requestId = `codex-guardian:${this.generation}:${toolUseId}:${reviewId}`
    // Codex repeats a completed review on the authoritative replay path; one
    // denial is one offer.
    if (this.guardianOverrides.has(requestId)) return
    const tool = this.messageHistory
      .flatMap((message) => message.content)
      .find((block) => block.type === 'tool_use' && block.toolUseId === toolUseId)
    if (tool?.type !== 'tool_use' || !this.completedItems.has(toolUseId)) {
      this.heldDenials.set(toolUseId, notification)
      return
    }
    this.heldDenials.delete(toolUseId)
    // The reviewer's rationale is untrusted model text from a thread the user
    // never saw: collapsed and capped exactly as the transcript row treats it.
    const rationale = review.rationale
      ? ` ${clip(normalizeWhitespace(review.rationale), GUARDIAN_RATIONALE_LIMIT)}`
      : ''
    const card: PendingApproval = {
      requestId,
      toolUseId,
      toolName: tool.toolName,
      input: tool.toolInput ?? {},
      decisionReason: `Codex auto-review denied this action.${rationale}`,
      // No `suggestions`: a standing rule cannot express "let this one through",
      // and under `auto` a ClaudeUI allow rule is never consulted anyway.
      codex: { guardianOverride: true }
    }
    this.guardianOverrides.set(requestId, {
      card,
      event: guardianDenialEvent(notification),
      label: guardianActionLabel(action),
      rowId: `${codexItemId(this.threadId, turnId, reviewId)}:override`
    })
    this.send('session:approval-request', card)
  }

  /**
   * Put back a card the incoming `tool_result` is about to remove. Only the
   * authoritative turn replay can reach this (a corrected result for an item
   * that already completed); the first result for a declined item is emitted
   * before its override is raised at all.
   */
  private rearmGuardianOverrides(toolUseId: string): void {
    for (const [requestId, override] of this.guardianOverrides) {
      if (override.card.toolUseId !== toolUseId) continue
      // Dismiss first: `session:approval-request` APPENDS, so a bare re-send
      // would show the same denial twice.
      this.send('session:approval-dismiss', { requestId })
      this.send('session:approval-request', override.card)
    }
  }

  /** Forget one override and mirror that to every view (ADR-038 emission duty). */
  private dismissGuardianOverride(requestId: string): void {
    if (!this.guardianOverrides.delete(requestId)) return
    this.send('session:approval-dismiss', { requestId })
  }

  private clearGuardianOverrides(): void {
    for (const requestId of [...this.guardianOverrides.keys()])
      this.dismissGuardianOverride(requestId)
  }

  private finishTurn(turn: Turn): void {
    if (!this.threadId || typeof turn.id !== 'string' || this.endedTurns.has(turn.id)) return
    for (const item of turn.items ?? []) this.item(turn.id, item, true, true)
    this.endedTurns.add(turn.id)
    this.client.abortServerRequests(this.threadId, turn.id)
    for (const pending of [...this.pending.values()]) {
      if (pending.turnId === turn.id) pending.settle()
    }
    // A denial whose declined item never arrived (it cannot arrive after the
    // authoritative replay above) has nothing to bind to. Raised overrides are
    // deliberately NOT touched: they outlive the turn that produced them.
    for (const [id, held] of [...this.heldDenials])
      if (held.turnId === turn.id) this.heldDenials.delete(id)
    if (this.turnId === turn.id || this.turnId === null) {
      this.turnId = null
      this.busy = false
      this.interruptRequested = false
      this.deltas.clear()
      this.bashGate.cancelAll()
      this.output.clear()
      if (turn.error)
        this.send(
          'session:error',
          'Codex turn failed. Check native account status and settings; no credentials were changed.'
        )
      this.status('idle')
      this.resetInactivityTimer()
    }
    // Turn end is the other boundary, and the only place an ambiguous steer can
    // be settled: the turn's history is now final.
    this.queueBoundary(turn.id)
  }

  private item(turnId: string, item: ThreadItem, completed: boolean, authoritative = false): void {
    const id = codexItemId(this.threadId!, turnId, item.id)
    const fingerprint = completed
      ? createHash('sha256').update(JSON.stringify(item)).digest('hex')
      : undefined
    if (
      this.completedItems.has(id) &&
      (!authoritative || this.completedItems.get(id) === fingerprint)
    )
      return
    if (fingerprint !== undefined) this.completedItems.set(id, fingerprint)
    const timestamp =
      this.messageHistory.find((message) => message.id === id)?.timestamp ?? Date.now()
    for (const event of mapCodexItem(this.threadId!, turnId, item, completed, timestamp))
      this.dispatch(event)
    // The tool_use block a held denial was waiting for may have just landed.
    const held = this.heldDenials.get(id)
    if (held) this.offerGuardianOverride(held)
  }

  private dispatch(event: CodexMappedEvent): void {
    switch (event.kind) {
      case 'stream':
        this.send('session:stream', event.delta)
        break
      case 'message': {
        const index = this.messageHistory.findIndex((message) => message.id === event.message.id)
        if (index < 0) this.messageHistory.push(event.message)
        else
          this.messageHistory[index] = {
            ...event.message,
            content: mergeContentBlocks(this.messageHistory[index].content, event.message.content)
          }
        this.send('session:message', event.message)
        break
      }
      case 'commandDelta': {
        const output = ((this.output.get(event.toolUseId) ?? '') + event.delta).slice(-256_000)
        this.output.set(event.toolUseId, output)
        this.bashGate.update(event.toolUseId, output)
        break
      }
      case 'toolResult':
        this.bashGate.cancel(event.toolUseId)
        this.output.delete(event.toolUseId)
        this.messageHistory = this.messageHistory.map((message) => {
          if (
            !message.content.some(
              (block) => block.type === 'tool_use' && block.toolUseId === event.toolUseId
            )
          )
            return message
          return {
            ...message,
            content: [
              ...message.content.filter(
                (block) => block.type !== 'tool_result' || block.toolUseId !== event.toolUseId
              ),
              {
                type: 'tool_result',
                toolUseId: event.toolUseId,
                toolResult: event.result,
                isError: event.isError,
                ...(event.fileDiffs ? { fileDiffs: event.fileDiffs } : {})
              }
            ]
          }
        })
        this.send('session:tool-result', {
          toolUseId: event.toolUseId,
          result: event.result,
          isError: event.isError,
          ...(event.fileDiffs ? { fileDiffs: event.fileDiffs } : {})
        })
        this.rearmGuardianOverrides(event.toolUseId)
        break
    }
  }

  /**
   * Run one ClaudeUI-hosted tool for the model (`item/tool/call`). This is NOT
   * an approval: answering it EXECUTES something, which is why every check
   * below fails closed by REJECTING the request rather than replying politely —
   * the app-server turns a rejected request into its own `success: false`
   * anyway (`app-server/src/dynamic_tools.rs` `fallback_response`), so a forged
   * or replayed call costs the model one failed tool call and nothing else.
   *
   * The `callId` is one-shot for the life of this session object: a repeated
   * one is refused, never re-executed, so a call the binary re-sends (or a
   * response the transport lost) cannot write a second mockup to disk.
   *
   * `namespace` must be null — these three are registered as bare functions, so
   * a namespaced call is not ours.
   *
   * The verdict comes from the SAME shared engine every other tool goes
   * through. Today it can only answer `allow` for these three (the hosted
   * auto-allow rung of `decideWithSource` sits above every rung but deny, and
   * no Claude rule string maps to the `diagram`/`mockup` kinds), but the call
   * is made anyway so a future ladder change reaches Codex too — and anything
   * but `allow` refuses with the reason as the tool's own output, which is the
   * only channel that tells the model why.
   */
  private async hostedToolCall(
    value: unknown,
    context: Parameters<NonNullable<CodexClientOptions['onServerRequest']>>[2]
  ): Promise<DynamicToolCallResponse> {
    if (
      this.closed ||
      context.signal.aborted ||
      !record(value) ||
      value.threadId !== this.threadId ||
      typeof value.turnId !== 'string' ||
      value.turnId !== this.turnId ||
      this.endedTurns.has(value.turnId) ||
      typeof value.callId !== 'string' ||
      value.namespace != null ||
      typeof value.tool !== 'string' ||
      !CODEX_HOSTED_TOOL_NAMES.has(value.tool)
    )
      throw new Error('Codex hosted tool call has no live owning root turn')
    const id = codexItemId(this.threadId!, value.turnId, value.callId)
    if (this.hostedCalls.has(id)) throw new Error('Duplicate Codex hosted tool call')
    this.hostedCalls.add(id)
    const args = record(value.arguments) ? value.arguments : undefined
    const verdict = args
      ? this.gate([{ tool: value.tool, input: args }])
      : {
          decision: 'deny' as PermissionDecision,
          reason: 'Hosted tool arguments must be an object'
        }
    if (verdict.decision !== 'allow') {
      const reason = verdict.reason ?? `${value.tool} was not approved`
      this.send('session:error', reason)
      return { contentItems: [{ type: 'inputText', text: reason }], success: false }
    }
    const result = await runCodexHostedTool(value.tool, args!, this.cwd, context.signal)
    // The turn ended (or the session went) while the handler ran: the core has
    // already completed the item as `failed`, so a reply now would be answering
    // a call nobody is waiting for.
    if (this.closed || context.signal.aborted)
      throw new Error('Codex hosted tool call was cancelled before it finished')
    return { contentItems: hostedContentItems(result), success: !result.isError }
  }

  private requestApproval(
    method: string,
    value: unknown,
    context: Parameters<NonNullable<CodexClientOptions['onServerRequest']>>[2]
  ): Promise<unknown> {
    if (
      this.closed ||
      context.signal.aborted ||
      !record(value) ||
      value.threadId !== this.threadId ||
      typeof value.turnId !== 'string' ||
      value.turnId !== this.turnId ||
      typeof value.itemId !== 'string' ||
      this.endedTurns.has(value.turnId)
    )
      return Promise.reject(new Error('Codex request has no live owning root turn'))
    const requestId = `codex-approval:${this.generation}:${codexItemId(this.threadId!, value.turnId, value.itemId)}:${JSON.stringify(context.id)}`
    if (this.pending.has(requestId)) return Promise.reject(new Error('Duplicate Codex approval'))
    if (method === 'item/permissions/requestApproval') {
      this.send(
        'session:error',
        'Native permission-profile grants are not enabled. This request was denied without granting additional permissions.'
      )
      return Promise.resolve({ permissions: {}, scope: 'turn' })
    }
    let choices: CodexApprovalDecision[] = []
    let questions: ToolRequestUserInputParams['questions'] | undefined
    let gated: Gated[] | undefined
    const card: PendingApproval = {
      requestId,
      toolUseId: codexItemId(this.threadId!, value.turnId, value.itemId),
      toolName: '',
      input: {}
    }
    if (method === 'item/commandExecution/requestApproval') {
      const params = value as CommandExecutionRequestApprovalParams
      const rawCommand = params.command ?? ''
      // Codex wraps every model command in the user's login shell, so the wire
      // string is `/bin/zsh -lc <script>`. Gating that verbatim would make a
      // `Bash(rm -rf:*)` deny rule dead on this engine and would suggest
      // `Bash(/bin/zsh -lc ...:*)`, a rule matching nothing on any other one.
      const command = unwrapShellCommand(rawCommand)
      card.toolName = 'commandExecution'
      // `commandActions` is display-only (docs/codex-spike.md answer A: it
      // cannot even separate `pwd` from `echo hi`), so the command STRING is
      // what gets gated and what a suggested rule is built from.
      card.input = {
        command,
        // Only when it differs — the transcript stays truthful about what Codex
        // will actually exec without the card growing a redundant field on the
        // (Execve-bridge) requests that arrive unwrapped already.
        ...(command === rawCommand ? {} : { rawCommand }),
        cwd: params.cwd ?? ''
      }
      card.decisionReason = params.reason ?? undefined
      // NEVER suggest a rule for an empty command: `Bash(:*)` is a prefix rule
      // that matches every command ever run. An approval with no command string
      // (e.g. a `writeStdin` kind) gets no persistable suggestion — it still
      // asks, it just cannot be turned into a standing rule.
      const normalized = normalizeWhitespace(command)
      if (normalized) card.suggestions = this.buildApprovalSuggestions('bash', `${normalized}:*`)
      gated = [{ tool: 'bash', input: { command } }]
    } else if (method === 'item/fileChange/requestApproval') {
      const params = value as FileChangeRequestApprovalParams
      card.toolName = 'fileChange'
      // The request itself carries no changes (FileChangeRequestApprovalParams
      // is threadId/turnId/itemId/startedAtMs/reason/grantRoot only — probe:
      // "no `availableDecisions`, no `kind` and no `grantRoot` at all"), so the
      // paths come from the fileChange ITEM already mapped into the transcript.
      const tool = this.messageHistory
        .flatMap((message) => message.content)
        .find((block) => block.type === 'tool_use' && block.toolUseId === card.toolUseId)
      const files: FileDiff[] =
        tool?.type === 'tool_use' && Array.isArray(tool.toolInput?.files)
          ? (tool.toolInput!.files as FileDiff[])
          : []
      card.input = { files }
      card.decisionReason = params.reason ?? undefined
      if (files.length) card.suggestions = this.buildApprovalSuggestions('edit')
      gated = files.map((file) => ({
        // `add` is a Write, every other change type (update/move/delete) edits
        // a file that already exists — mirrors Claude's own Write/Edit split.
        tool: file.changeType === 'add' ? 'write' : 'edit',
        input: { path: file.path },
        path: file.path
      }))
    } else if (method === 'item/tool/requestUserInput') {
      const params = value as ToolRequestUserInputParams
      if (
        !Array.isArray(params.questions) ||
        params.questions.some((question) => question.isSecret)
      ) {
        this.send(
          'session:error',
          'Native secret question declined: secure secret entry is not supported. No answer was sent.'
        )
        return Promise.resolve({ answers: {} })
      }
      questions = params.questions
      card.toolName = 'requestUserInput'
      card.input = {
        questions: questions.map((question) => ({
          question: question.question,
          header: question.header,
          options: question.options ?? [],
          multiSelect: false
        }))
      }
      choices = ['cancel']
      card.codex = {
        routingId: this.routingId,
        decisions: choices,
        questions: questions.map((question) => ({
          id: question.id,
          question: question.question,
          header: question.header,
          options: question.options ?? [],
          allowOther: question.isOther
        }))
      }
    } else return Promise.reject(new Error('Unsupported Codex server request'))

    if (gated) {
      const verdict = this.gate(gated)
      if (verdict.decision === 'allow') return Promise.resolve({ decision: 'accept' })
      if (verdict.decision === 'deny') {
        // The native reply carries a decision and nothing else — neither
        // response type has a reason field — so a denial is invisible to both
        // the model and the user unless we say it out loud here.
        this.send('session:error', verdict.reason!)
        // `decline` is honoured on both paths despite never appearing in
        // `availableDecisions` (docs/codex-spike.md, "Other observations"), so
        // the advertised list is deliberately not consulted.
        return Promise.resolve({ decision: 'decline' })
      }
    }
    const allowKeys = (gated ?? []).map((entry) => sessionAllowKey(entry.tool, entry.input))
    return new Promise((resolve, reject) => {
      const abort = (): void => settle()
      const settle = (reply?: unknown): void => {
        if (!this.pending.delete(requestId)) return
        context.signal.removeEventListener('abort', abort)
        this.send('session:approval-dismiss', { requestId })
        if (reply === undefined) reject(new Error('Codex approval cancelled'))
        else resolve(reply)
      }
      this.pending.set(requestId, {
        turnId: value.turnId as string,
        choices: [...choices],
        questions,
        allowKeys,
        settle
      })
      context.signal.addEventListener('abort', abort, { once: true })
      this.send('session:approval-request', card)
    })
  }

  /**
   * Run the shared, engine-neutral permission engine over every action one
   * native request covers, and collapse the verdicts: any deny denies, else any
   * ask asks, else allow. A request with NOTHING resolvable to gate asks —
   * never allows.
   *
   * `auto` gates as `default`: under `auto_review` the native subagent has
   * already approved everything it was willing to, so whatever still reaches
   * this client is precisely what it escalated, and escalations belong to the
   * human, not to `acceptEdits`' silent base.
   */
  private gate(gated: Gated[]): { decision: PermissionDecision; reason?: string } {
    if (gated.length === 0) return { decision: 'ask' }
    const ctx = {
      mode: this.permissionMode === 'auto' ? 'default' : this.permissionMode,
      rules: mergedClaudeRulesFor(this.cwd),
      sessionAllows: this.sessionAllows,
      cwd: this.cwd
    }
    let decision: PermissionDecision = 'allow'
    for (const entry of gated) {
      const verdict = decideWithSource(entry.tool, entry.input, ctx)
      let step = verdict.decision
      // Composition-seam narrowing, NOT a change to the ladder: `acceptEdits`'
      // mode base allows fileEdit/fileWrite unconditionally, which for Codex
      // would silently auto-apply a patch anywhere on disk. Codex's own
      // workspaceWrite sandbox draws the line at the workspace and asks up
      // front for anything outside it, so a mode-base allow for a path outside
      // cwd is downgraded to a human ask. A user rule that named the path still
      // wins — only `source: 'mode-base'` verdicts are touched.
      if (
        step === 'allow' &&
        verdict.source === 'mode-base' &&
        entry.path !== undefined &&
        !this.insideWorkspace(entry.path)
      )
        step = 'ask'
      if (step === 'deny')
        return {
          decision: 'deny',
          reason:
            verdict.source === 'deny-rule' && verdict.rule
              ? `Denied by permission rule: ${verdict.rule}`
              : this.permissionMode === 'plan'
                ? PLAN_MODE_DENY_REASON
                : 'Denied by permission rules'
        }
      if (step === 'ask') decision = 'ask'
    }
    return { decision }
  }

  private insideWorkspace(target: string): boolean {
    const relative = path.relative(this.cwd, path.resolve(this.cwd, target))
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
  }

  /**
   * The three "always allow" destinations for this request, mirroring
   * `PiSession.buildApprovalSuggestions`: bash gets a PREFIX rule (the whole
   * command plus a trailing glob, which round-trips through the engine's bash
   * prefix matcher), a file change gets a bare `Edit` rule.
   */
  private buildApprovalSuggestions(tool: string, ruleContent?: string): PermissionSuggestion[] {
    const rule = {
      toolName: PI_TOOL_TO_CLAUDE_TOOL[tool],
      ...(ruleContent ? { ruleContent } : {})
    }
    return (['userSettings', 'projectSettings', 'localSettings'] as const).map((destination) => ({
      type: 'addRules',
      behavior: 'allow',
      destination,
      rules: [rule]
    }))
  }

  /** Native question cards only — their one reply is `cancel`. */
  resolveCodexApproval(requestId: string, decision: CodexApprovalDecision): void {
    const pending = this.pending.get(requestId)
    if (!pending?.questions || !pending.choices.includes(decision))
      throw new Error('Stale or unoffered Codex approval decision')
    pending.settle({ answers: {} })
  }

  /**
   * "Approve anyway" on a guardian denial. Nothing is re-run: the core
   * serializes `{action, outcome: "allowed"}` into a user-context fragment and
   * injects it WITHOUT starting a turn (`core/src/session/handlers.rs`
   * `approve_guardian_denied_action`), so the model sees the approval on its
   * next turn and may retry the action itself. The card is dismissed either way
   * — it is answered once, and a refusal is reported rather than retried.
   */
  private resolveGuardianOverride(
    requestId: string,
    override: GuardianOverride,
    decision: ApprovalDecision
  ): void {
    if (decision === 'allowForSession')
      throw new Error('Stale or unoffered Codex approval decision')
    this.dismissGuardianOverride(requestId)
    if (decision !== 'allow' || !this.threadId) return
    void this.client
      .request('thread/approveGuardianDeniedAction', {
        threadId: this.threadId,
        event: override.event
      })
      .then(() =>
        this.guardianRow(
          override.rowId,
          `You approved ${override.label} over Codex's auto-review. Codex will see this on its next turn and may retry.`
        )
      )
      .catch((error) =>
        this.send(
          'session:error',
          `Codex did not accept the auto-review override: ${error instanceof Error ? error.message : 'native request failed'}`
        )
      )
  }

  resolveApproval(
    requestId: string,
    decision: ApprovalDecision,
    answers?: Record<string, string>,
    updatedPermissions?: PermissionSuggestion[]
  ): void {
    const override = this.guardianOverrides.get(requestId)
    if (override) return this.resolveGuardianOverride(requestId, override, decision)
    const pending = this.pending.get(requestId)
    if (!pending) throw new Error('Stale or unknown Codex approval')
    if (pending.questions) {
      if (decision !== 'allow' || !answers)
        throw new Error('Codex questions require explicit answers')
      const nativeAnswers: Record<string, { answers: string[] }> = Object.create(null)
      for (const question of pending.questions) {
        const duplicateText =
          pending.questions.filter((entry) => entry.question === question.question).length > 1
        const answer =
          answers[question.id] ?? (duplicateText ? undefined : answers[question.question])
        if (typeof answer !== 'string') throw new Error('Missing Codex question answer')
        if (
          question.options?.length &&
          !question.isOther &&
          !question.options.some((option) => option.label === answer)
        )
          throw new Error('Codex question answer is not an offered choice')
        nativeAnswers[question.id] = { answers: [answer] }
      }
      pending.settle({ answers: nativeAnswers })
      return
    }
    if (decision === 'allowForSession')
      for (const key of pending.allowKeys) this.sessionAllows.add(key)
    pending.settle({ decision: decision === 'deny' ? 'decline' : 'accept' })
    // No rules cache to invalidate here: `gate()` re-reads the merged rules per
    // request, so a newly persisted rule is honoured on the very next approval.
    if (updatedPermissions && updatedPermissions.length > 0)
      persistAllowSuggestions(updatedPermissions, this.cwd, 'CodexSession')
  }
}

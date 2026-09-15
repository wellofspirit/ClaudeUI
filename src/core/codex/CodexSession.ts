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
  MeteringSnapshot,
  TaskNotification
} from '../../shared/types'
import type {
  CodexApprovalDecision,
  CodexSessionState,
  CodexSettings
} from '../../shared/codex-types'
import { mergeContentBlocks } from '../../shared/content-blocks'
import { parseCodexSettings, savedCodexOverrides } from './settings'
import {
  assertCodexAttachments,
  codexModePolicy,
  codexTurnInput,
  codexTurnPolicy,
  type CodexAttachments,
  type CodexModePolicy
} from './codex-turn-policy'
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
import type { TokenUsageBreakdown } from './protocol/v2/TokenUsageBreakdown'
import { resolveCodexCapabilities } from '../../shared/model-capabilities'
import { CodexTransportError, type CodexClientOptions } from './CodexAppServerClient'
import {
  codexHostRegistry,
  type CodexHostHandle,
  type CodexHostSource,
  type CodexServerRequestContext,
  type CodexThreadConnection,
  type CodexThreadOwner
} from './CodexHost'
import { CODEX_AUTH_PROVIDER_ID, type CodexAuthHook } from './codex-auth-hook'
import { chatgptRateLimits } from './chatgpt-rate-limits'
import { collectClaudeMcpForCodex, type CodexMcpServerEntry } from './codex-mcp-bridge'
import {
  MCP_ELICITATION_ACCEPT,
  MCP_ELICITATION_DECLINE,
  mcpRuleToolName,
  readMcpToolApproval
} from './mcp-elicitation'
import type { RateLimitSnapshot } from './protocol/v2/RateLimitSnapshot'
import type { Model } from './protocol/v2/Model'
import type { JsonValue } from './protocol/serde_json/JsonValue'
import type { ThreadItem } from './protocol/v2/ThreadItem'
import type { Turn } from './protocol/v2/Turn'
import type { CommandExecutionRequestApprovalParams } from './protocol/v2/CommandExecutionRequestApprovalParams'
import type { GuardianApprovalReviewAction } from './protocol/v2/GuardianApprovalReviewAction'
import type { ItemGuardianApprovalReviewCompletedNotification } from './protocol/v2/ItemGuardianApprovalReviewCompletedNotification'
import type { FileChangeRequestApprovalParams } from './protocol/v2/FileChangeRequestApprovalParams'
import type { ToolRequestUserInputParams } from './protocol/v2/ToolRequestUserInputParams'
import type { CollabAgentStatus } from './protocol/v2/CollabAgentStatus'
import { assertCodexProvider, selectCodexModel } from './model-selection'
import {
  codexItemId,
  mapCodexDelta,
  mapCodexItem,
  subAgentActivityResult,
  type CodexMappedEvent
} from './event-mapper'
import {
  CODEX_HOSTED_TOOL_NAMES,
  codexDynamicToolSpecs,
  runCodexHostedTool
} from './codex-hosted-tools'
import {
  crossEngineDispatcher,
  crossEngineDispatchAvailable
} from '../services/cross-engine-dispatcher'
import type { DispatchContext, DispatchRequest } from '../services/cross-engine-dispatcher'
import type { DynamicToolCallResponse } from './protocol/v2/DynamicToolCallResponse'
import type { DynamicToolCallOutputContentItem } from './protocol/v2/DynamicToolCallOutputContentItem'
import type { ToolResultContent } from '../sdk/types'
import { unwrapShellCommand } from './command-text'
import { equivalentCostUsd } from '../../shared/pricing'
import { BashStreamGate } from '../opencode/bash-stream-gate'
import {
  setSessionMeta,
  getCodexSessionOverrides,
  setCodexSessionOverrides,
  ensureCodexSessionOverrides,
  registerCodexFork
} from '../services/db'

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/**
 * Why a re-pin can be refused outright (ADR-069 §2, H2 Landed).
 *
 * One process holds one ChatGPT identity, so moving this session's thread to
 * another account means leaving this host — and the thread's writer lock is only
 * released when that process exits or unloads the thread a minute after its last
 * subscriber leaves. With another session on the host, closing it to free the
 * lock would take that session down for this one's pin.
 */
const PIN_BLOCKED = "Another session is using this account's Codex process; re-pin after it closes."

/**
 * Host knobs plus the ChatGPT identity this session runs as.
 *
 * `auth` is deliberately absent by default: a session built without one asks for
 * a host with NO identity (ADR-069 §1's `native` bucket), which injects nothing
 * and never reads the vault — that is what lets the real-binary integration
 * suite drive sessions against a scripted localhost provider with no access to a
 * developer's credentials. `register-engines.ts` is the composition root that
 * supplies the real hook. Since ADR-069 the hook does not travel to the process:
 * the HOST owns injection and the refresh, and this one answers only the vault
 * questions a pin has to ask ({@link CodexAuthHook.hasAccount}).
 */
export type CodexSessionTransport = Pick<
  CodexClientOptions,
  'env' | 'requestTimeoutMs' | 'killGraceMs'
> & { auth?: CodexAuthHook | null }

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
 * What a hosted tool call that will never come back is left holding.
 *
 * `[Request interrupted by user for tool use]` is cli.js's OWN tombstone for a
 * tool call Esc cut short (the literal is in `vendor/claude-cli/cli.js`, and
 * `claude-session.ts`'s `stopTask` names it), reused verbatim so a stopped
 * Codex card reads exactly like a stopped Claude one. Nothing renders off the
 * TEXT — `ToolCard`'s error state is `result.isError` alone — so the second
 * string costs nothing and avoids blaming a user for a stop they did not ask
 * for.
 */
const INTERRUPTED_HOSTED_TOOL = '[Request interrupted by user for tool use]'
/** The same tombstone for a stop nobody asked for: a failed turn, a lost transport. */
const STOPPED_HOSTED_TOOL = '[Request stopped before the tool use finished]'

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
  /**
   * The native reply for this request type, given the human's verdict. Every
   * `requestApproval` request answers `{ decision }`;
   * `mcpServer/elicitation/request` answers `{ action, content }` instead, so
   * the SHAPE travels with the parked request rather than being re-derived
   * where the card is answered.
   */
  reply: (accepted: boolean) => unknown
  settle: (value?: unknown) => void
}

/**
 * One native child thread this root spawned through its collab tools, and the
 * parent `tool_use` its transcript hangs off (ADR-066 slice F).
 *
 * Children are NOT sessions: the user never drives one directly, so nothing
 * here is a routing id or a queue. The app-server attaches every initialized
 * connection to every thread the manager creates
 * (`app-server/src/lib.rs` ~1174 `try_attach_thread_listener`), which is the
 * only reason a child's notifications reach this client at all.
 */
type CodexChild = {
  /** The `collabAgentToolCall` tool_use id every subagent event is keyed by. */
  parentToolUseId: string
  /** The child's own active turn, for `turn/interrupt`. Null when idle. */
  turnId: string | null
  /** The child's last agent message, which becomes the task notification's summary. */
  summary: string
  /** Stable observation timestamps for the child's items, by mapped message id. */
  timestamps: Map<string, number>
  startedAt: number
  toolUses: number
  /** The child thread's own cumulative token totals, added to the root's meter. */
  usage: TokenUsageBreakdown | null
  /** A terminal `session:task-notification` is emitted exactly once. */
  notified: boolean
  /**
   * This child's last observed status, in Codex's own vocabulary.
   *
   * Written on the same transitions the core derives `AgentStatus` from
   * (`core/src/agent/status.rs` `agent_status_from_event`): turn start →
   * running, turn end → completed/errored/interrupted, teardown → shutdown.
   * Last write wins, so the close always has the final say.
   */
  state: CollabAgentStatus
}

/** Agent states that end a child's card, mapped onto the neutral task status. */
const CHILD_TERMINAL_STATUS: Record<string, TaskNotification['status']> = {
  completed: 'completed',
  errored: 'failed',
  notFound: 'failed',
  shutdown: 'stopped',
  interrupted: 'stopped'
}

/** The inverse, for the status a closed child reports on a later `wait` card. */
const CHILD_CLOSED_STATE: Record<TaskNotification['status'], CollabAgentStatus> = {
  completed: 'completed',
  failed: 'errored',
  stopped: 'shutdown'
}

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

/**
 * One root is one THREAD on its account's host (ADR-069 §2). No process of its
 * own, no native queue, no child adoption.
 */
export class CodexSession extends BaseSession {
  readonly engineId = 'codex' as const
  readonly capabilities = resolveCodexCapabilities()
  /** Where this session's registry leases come from. The singleton in production. */
  private readonly hosts: CodexHostSource
  /** The env/timeout knobs every `acquire` for this session carries. */
  private readonly hostTransport: Omit<CodexSessionTransport, 'auth'>
  /** This session's view of its host, or null before `start()` / after teardown. */
  private connection: CodexThreadConnection | null = null
  /**
   * The vault account this session ASKED its host for (null = follow active),
   * as opposed to {@link injectedAccountId}, which is what the host's process
   * actually holds. Kept so a failed re-pin can go back to the host it left.
   */
  private hostAccountId: string | null = null
  /**
   * The HOST generation this session's parked approvals and one-shot hosted
   * calls are scoped to (ADR-069 §2). It used to be a per-session UUID standing
   * in for "this process"; the process is now shared and outlives no resume, so
   * the honest scope is the host start — an answer minted on the previous one is
   * refused after a host death exactly as a previous process's was.
   */
  private generation = 0
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
  /**
   * The NATIVE half of `SessionStatus.codex`. `overrides` and `pinnedAccountId`
   * are ClaudeUI's own and are folded in by {@link status}, so they are omitted
   * here rather than kept in two places that could disagree.
   */
  private native?: Omit<CodexSessionState, 'overrides' | 'pinnedAccountId'>
  private overrides: CodexSettings = {}
  private account: SessionStatus['account'] = null
  /**
   * The hook that owns this process's ChatGPT identity (ADR-068 §1), or null
   * when the caller wired none — in which case the process runs on whatever
   * Codex's own store holds and nothing here touches the vault.
   */
  private readonly auth: CodexAuthHook | null
  /** The VAULT account id this process was injected with, or null. */
  private injectedAccountId: string | null = null
  /**
   * A pin accepted while a turn was running, waiting for the next turn boundary
   * (ADR-068 §2 — the same "applies from the next turn" rule
   * {@link setPermissionMode} follows, for the same reason: re-pointing the
   * identity mid-turn would bill half a conversation to another subscription).
   *
   * Also carries a pin chosen BEFORE the process starts, which `start()` folds
   * into the overrides in the same place it folds an explicit model or effort.
   *
   * `undefined` means nothing is pending; `null` is a pending "follow the active
   * account", which is why this is not just `string | null`.
   */
  private pendingAccountId: string | null | undefined
  private permissionMode: string
  /** "Allow for this session" clicks, in the shared engine's key vocabulary. */
  private sessionAllows = new Set<string>()
  private pending = new Map<string, Pending>()
  /** Guardian-denial overrides by requestId — never `this.pending` (see the type). */
  private guardianOverrides = new Map<string, GuardianOverride>()
  /** Denials whose declined item has not been mapped yet, by that item's id. */
  private heldDenials = new Map<string, ItemGuardianApprovalReviewCompletedNotification>()
  /** Hosted-tool `callId`s already executed by THIS session object — one shot each. */
  private hostedCalls = new Set<string>()
  /**
   * Cross-engine dispatches currently awaiting `crossEngineDispatcher.dispatch`,
   * by the dispatching `tool_use` id (ADR-033 M3 — mirrors
   * `PiSession.inFlightDispatchIds`). Held from BEFORE the await starts until
   * it settles either way, so an interrupt or a transport loss racing that
   * exact instant still finds the id to stop. The abort signal on the owning
   * `item/tool/call` covers a turn that simply ENDS (`abortServerRequests`);
   * this set is what an Esc-interrupt and a disconnect reach for, neither of
   * which touches the request's signal.
   */
  private inFlightDispatchIds = new Set<string>()
  /** Queue items whose steer timed out ambiguously, by queue item id. */
  private ambiguousSteers = new Map<string, AmbiguousSteer>()
  /** Serializes queue boundaries — see {@link queueBoundary}. */
  private flushChain: Promise<void> = Promise.resolve()
  /**
   * The inherited Claude MCP table this thread was opened with (ADR-068 §5),
   * read ONCE in `start()` and replayed by {@link threadParams} so a resume onto
   * another host reopens the thread with the same servers.
   */
  private mcpServers?: Record<string, CodexMcpServerEntry>
  /** Native child threads by their own thread id (ADR-066 slice F). */
  private children = new Map<string, CodexChild>()
  /** One "nested agents are not rendered" error per session, not per spawn. */
  private nestedAgentWarned = false
  /** The root's own last token totals — the base every child's usage adds to. */
  private rootUsage: ThreadTokenUsage | null = null
  /** Last computed API-rate equivalent of this session's tokens; null = unpriced. */
  private equivalentCostUsd: number | null = null
  private output = new Map<string, string>()
  private bashGate = new BashStreamGate((toolUseId, output) =>
    this.send('session:bash-output', { toolUseId, output })
  )

  /**
   * What the host delivers to this thread. A plain object rather than methods on
   * the class so the routing stays private: nothing outside this file can push a
   * notification, an approval or a disconnect into a session.
   */
  private readonly owner: CodexThreadOwner = {
    onNotification: (method, params) => this.notification(method, params),
    onServerRequest: (method, params, context) => this.serverRequest(method, params, context),
    onDisconnect: (error) => this.disconnected(error),
    onAuthRequired: (accountId) => this.authRequired(accountId)
  }

  constructor(
    routingId: string,
    win: HostWindowHandle | null,
    cwd: string,
    private readonly options: EngineSpawnOptions = {},
    transport: CodexSessionTransport = {},
    hosts: CodexHostSource = codexHostRegistry
  ) {
    super(routingId, win, cwd)
    const { auth = null, ...hostTransport } = transport
    this.auth = auth
    this.hosts = hosts
    this.hostTransport = hostTransport
    // ADR-030/ADR-033: the STATIC flag says this engine can HOST dispatch_agent;
    // the honest per-session value additionally requires a target engine to
    // exist. ANDed once here (rather than behind a getter, as pi does) because
    // `capabilities` is a mutable field this class writes into as the native
    // model resolves — a getter would silently drop those writes.
    this.capabilities.crossEngineDispatch &&= crossEngineDispatchAvailable('codex')
    this.model = options.model
    this.effort = options.effort
    this.permissionMode = options.permissionMode ?? 'default'
  }

  /**
   * The live connection, or a throw. Every caller is already inside a flow that
   * surfaces an error (a turn, a settings write, a pin), and a session with no
   * connection is a session that has not started or has been torn down — the
   * same state `this.closed` describes.
   */
  private get wire(): CodexThreadConnection {
    if (!this.connection) throw new Error('Codex session is disconnected')
    return this.connection
  }

  /** The server requests this thread answers. The refresh is the host's own. */
  private serverRequest(
    method: string,
    params: unknown,
    context: CodexServerRequestContext
  ): Promise<unknown> {
    return method === 'item/tool/call'
      ? this.hostedToolCall(params, context)
      : method === 'mcpServer/elicitation/request'
        ? this.mcpElicitation(params, context)
        : this.requestApproval(method, params, context)
  }

  /**
   * The vault cannot refresh this host's ChatGPT credential (ADR-068 §1).
   *
   * Rung by the HOST, once per attached session, because the hook belongs to the
   * process now: every session on it runs on the credential that just failed
   * (ADR-069 §8), so every one of them has to say so.
   */
  private authRequired(accountId: string | null): void {
    if (this.closed) return
    this.send('session:auth-required', {
      providerId: CODEX_AUTH_PROVIDER_ID,
      ...(accountId ? { accountId } : {})
    })
    this.send(
      'session:error',
      'ChatGPT sign-in expired; sign in again from Settings › Models & providers'
    )
  }

  get willQueue(): boolean {
    return this.busy || this.sending || this.settingsUpdating
  }
  getSessionId(): string | null {
    return this.threadId
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
        await this.wire.request('turn/steer', {
          threadId: this.threadId,
          expectedTurnId: turnId,
          clientUserMessageId,
          input: codexTurnInput(item.text, item.attachments)
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
      const result = await this.wire.request('thread/items/list', {
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
    assertCodexAttachments(attachments)
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
      // The turn BOUNDARY is where a pin taken mid-turn lands (ADR-068 §2), so
      // the login is on the wire before `turn/start` and this turn actually runs
      // under the account the user picked.
      await this.applyPendingPin()
      if (this.closed) throw new Error('Codex session is disconnected')
      const result = await this.wire.request('turn/start', {
        threadId: this.threadId!,
        clientUserMessageId,
        input: codexTurnInput(prompt, attachments),
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
      // Codex has ONE branching verb and its granularity is the turn, so the
      // two shapes it has no answer for are refused up front rather than
      // silently becoming a fork or a plain resume.
      const source = this.options.resumeSessionId
      const lastTurnId = this.options.resumeSessionAt
      const branch =
        this.options.forkSession && source && lastTurnId ? { threadId: source, lastTurnId } : null
      if (this.options.forkSession && !branch)
        throw new Error('Codex branching needs a turn anchor on an existing thread')
      if (lastTurnId && !this.options.forkSession)
        throw new Error('Codex resume-at is not supported; branch the turn instead')
      const saved = this.options.resumeSessionId
        ? savedCodexOverrides(getCodexSessionOverrides(this.options.resumeSessionId))
        : {}
      this.overrides = { ...saved }
      if (this.model !== undefined) this.overrides.model = this.model
      else this.model = saved.model
      if (this.effort !== undefined) this.overrides.effort = this.effort
      else this.effort = saved.effort
      // A pin chosen BEFORE the first turn (the picker on a session that has not
      // spawned yet) wins over the inherited one, exactly as an explicit model or
      // effort does above — `this.overrides` is rebuilt here, so a pin written
      // straight into it would be discarded.
      if (this.pendingAccountId !== undefined) {
        this.overrides.accountId = this.pendingAccountId
        this.pendingAccountId = undefined
      }
      await this.resolveSavedPin()
      // The host is already injected with this identity when `attach` returns
      // (ADR-068 §1's "nothing can send a turn under the previous one", now a
      // property of the PROCESS rather than of this session's own handshake), so
      // every request below — the config read, the catalog, the thread — runs as
      // the account the user picked.
      await this.attachHost(this.pinnedAccountId())
      // Every other await in `start()` is followed by a closed check; this one
      // is where a stop landing during the spawn arrives.
      if (this.closed) return
      const { config } = await this.wire.request('config/read', {
        cwd: this.cwd,
        includeLayers: false
      })
      assertCodexProvider(config.model_provider)
      await this.readAccount()
      const cursors = new Set<string>()
      let cursor: string | null = null
      for (let page = 0; ; page++) {
        if (page === 100) throw new Error('Codex catalog page limit')
        const result = await this.wire.request('model/list', {
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
      // The shared Claude MCP list, translated into Codex's own `mcp_servers`
      // shape and delivered as the per-thread override (ADR-068 §5). It rides on
      // `params`, so start, resume and fork cannot drift apart. Read ONCE, here:
      // a `.mcp.json` edited later applies to the next session, which is what the
      // settings row says. The override MERGES into whatever the user declared in
      // `config.toml` (probed against 0.154.0), so native entries — including the
      // OAuth servers Claude's shape cannot express — keep working alongside.
      const inheritedMcp = collectClaudeMcpForCodex(this.cwd)
      this.mcpServers = inheritedMcp.servers
      if (inheritedMcp.skipped.length > 0)
        // `start()` runs at most once per session (`this.starting` latches it),
        // so this is the one warning ADR-068 §5 asks for.
        this.send(
          'session:warning',
          `SSE MCP servers are not supported by Codex: ${inheritedMcp.skipped.join(', ')}`
        )
      const params = this.threadParams()
      const response = branch
        ? // Copies the source THROUGH `lastTurnId` into a NEW thread and leaves
          // the source untouched. No `dynamicTools` field and none needed: the
          // hosted-tool specs come back from the source rollout's SessionMeta on
          // a fork exactly as on a resume (`history/src/lib.rs`
          // `get_dynamic_tools`, arm `Forked`). `excludeTurns` keeps the reply
          // metadata-only; the branch's transcript is read back through the
          // ordinary history path.
          await this.wire.request('thread/fork', { ...params, ...branch, excludeTurns: true })
        : this.options.resumeSessionId
          ? await this.wire.request('thread/resume', {
              ...params,
              threadId: this.options.resumeSessionId
            })
          : await this.wire.request('thread/start', {
              ...params,
              allowProviderModelFallback: false,
              historyMode: 'paginated',
              // START ONLY. `thread/resume` has no `dynamicTools` field, and it
              // needs none: the specs are written into the rollout's SessionMeta
              // at creation (`core/src/session/session.rs`, `CreateThreadParams
              // .dynamic_tools`) and a resume with an empty list restores them
              // from there (`core/src/session/mod.rs:721`).
              dynamicTools: codexDynamicToolSpecs(this.capabilities.crossEngineDispatch)
            })
      if (this.closed) return
      assertCodexProvider(response.modelProvider)
      // A branch must be a NEW thread rooted at the source; a resume must be the
      // same thread. `forkedFromId` is the fork's own lineage and `parentThreadId`
      // stays null on it — that field marks a native SUBAGENT child, which no
      // fork is (`core/src/thread_manager.rs` never sets it on the fork path).
      if (branch) {
        if (response.thread.forkedFromId !== branch.threadId)
          throw new Error('Codex forked a different native thread')
      } else if (
        this.options.resumeSessionId &&
        response.thread.id !== this.options.resumeSessionId
      )
        throw new Error('Codex resumed a different native thread')
      if (response.thread.parentThreadId)
        throw new Error('Native child threads must be controlled by their owning root')
      if (this.model !== undefined && response.model !== this.model)
        throw new Error('Codex silently changed the requested model')
      this.threadId = response.thread.id
      // From here on this session takes delivery of everything stamped with the
      // thread id — and of nothing else (ADR-069 §2). Held notifications from a
      // child that started before its spawn item landed are replayed as each
      // child is claimed, in `registerChild`.
      this.wire.claim(this.threadId)
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
      // A fork is invisible to `thread/list` forever (ADR-066), so the sidebar
      // can only find this branch again if we say it exists. Registered HERE,
      // at the one moment its id is known to be a fork's — `listCodexSessions`
      // reads exactly these ids instead of re-probing every session_meta row.
      if (branch) registerCodexFork(this.threadId, branch.threadId)
      this.status('idle')
      if (this.effort !== undefined)
        await this.wire.request('thread/settings/update', {
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

  /**
   * The per-thread envelope every `thread/start`, `thread/resume` and
   * `thread/fork` carries.
   *
   * Rebuilt per call from the CURRENT mode and model rather than captured at
   * start, because a re-pin resumes the thread on another host and must not
   * reopen it under the policy or the model it had when it first opened
   * (`setPermissionMode` and `thread/settings/update` both move these).
   */
  private threadParams(): {
    cwd: string
    model?: string
    approvalPolicy: CodexModePolicy['approvalPolicy']
    sandbox: CodexModePolicy['sandbox']
    approvalsReviewer: CodexModePolicy['approvalsReviewer']
    config?: { mcp_servers: Record<string, CodexMcpServerEntry> }
  } {
    // The thread BASELINE must agree with the per-turn override, so a turn that
    // somehow starts without one (native queue, a future steer path) still runs
    // under this mode's policy rather than the user's config.
    const { approvalPolicy, sandbox, approvalsReviewer } = this.modePolicy()
    return {
      cwd: this.cwd,
      ...(this.model !== undefined ? { model: this.model } : {}),
      approvalPolicy,
      sandbox,
      approvalsReviewer,
      // Absent, not empty: an empty table is still an override, and the no-MCP
      // user must reach the binary exactly as before ADR-068 §5.
      ...(this.mcpServers && Object.keys(this.mcpServers).length > 0
        ? { config: { mcp_servers: this.mcpServers } }
        : {})
    }
  }

  /**
   * Attach to the host for one ChatGPT identity (ADR-069 §1/§2).
   *
   * The LEASE is dropped immediately: `attach` retains the host for as long as
   * this session is on it, and holding a read lease as well would only mean two
   * counters saying the same thing. A session with no auth hook asks for no
   * identity at all, which is the uninjected host and the one path that never
   * reads the vault.
   */
  private async attachHost(accountId: string | null): Promise<void> {
    const handle = await this.hosts.acquire({
      ...this.hostTransport,
      cwd: this.cwd,
      label: 'session',
      ...(this.auth ? { identity: { accountId } } : {})
    })
    // A host start is the one await in this session's life that outlives a
    // `dispose()` with nothing to cancel it: `disconnected()` detaches a
    // connection that does not exist yet, and attaching afterwards would retain
    // the host for a session nobody can reach — forever, since only a detach
    // ever releases it — and let `start()` go on to open a native thread that is
    // never claimed and never unsubscribed.
    if (this.closed) {
      handle.release()
      throw new Error('Codex session is disconnected')
    }
    try {
      this.connection = handle.host.attach(this.owner)
    } finally {
      handle.release()
    }
    this.hostAccountId = accountId
    this.generation = this.connection.generation
    // Null when nothing was injected: the process runs on Codex's own login and
    // the account is derived from `account/read` exactly as before ADR-069.
    this.injectedAccountId = this.connection.injectedAccountId
  }

  /** Whose subscription this session bills, for the status line and usage rows. */
  private async readAccount(): Promise<void> {
    const account = (await this.wire.request('account/read', { refreshToken: false })).account
    if (this.closed) return
    if (this.injectedAccountId) {
      // An injected process IS the vault's subscription, whatever `account/read`
      // makes of the token: the email it reports is parsed from the very JWT we
      // sent. `accountId` is the VAULT account id, which is what usage rows and
      // the per-session pin attribute to.
      this.account = {
        engineId: 'codex',
        vendorId: 'openai',
        authState: 'authenticated',
        billingType: 'subscription',
        ...(account?.type === 'chatgpt' && account.email ? { label: account.email } : {}),
        accountId: this.injectedAccountId
      }
    } else if (account?.type === 'chatgpt' || account?.type === 'apiKey')
      this.account = {
        engineId: 'codex',
        vendorId: 'openai',
        authState: 'authenticated',
        billingType: account.type === 'chatgpt' ? 'subscription' : 'apiKey'
      }
  }

  /**
   * Put this session's EXISTING thread on the host for `accountId`.
   *
   * `thread/resume` rather than a re-injection: one process holds one ChatGPT
   * identity (ADR-068 §1) and it is shared now, so re-pointing it would move
   * every other session on it too. The thread's own history is on disk, and a
   * resume is what carries it across — the same move a `disconnected` session
   * makes on its next prompt.
   */
  private async takeThread(accountId: string | null): Promise<void> {
    await this.attachHost(accountId)
    if (!this.threadId) return
    const response = await this.wire.request('thread/resume', {
      ...this.threadParams(),
      threadId: this.threadId
    })
    if (response.thread.id !== this.threadId)
      throw new Error('Codex resumed a different native thread')
    this.wire.claim(this.threadId)
  }

  /**
   * Leave the host this session is on, interrupting anything still running.
   *
   * A thread stays LOADED in the process that opened it until the binary unloads
   * it (60 s after its last subscriber leaves,
   * `app-server/src/request_processors/thread_lifecycle.rs`), and a loaded
   * thread's writer lock is what refuses every other process's `thread/resume`
   * with `-32600 already has an active writer` (upstream's own
   * `thread_resume.rs` test). So a host this session has just vacated and that
   * nobody else is using is closed HERE rather than left to idle out: its lock
   * is exactly what would refuse the resume on the next host.
   */
  private async leaveHost(): Promise<void> {
    const connection = this.connection
    if (!connection) return
    const turnId = this.turnId
    if (this.threadId && turnId)
      await connection
        .request('turn/interrupt', { threadId: this.threadId, turnId })
        .catch(() => {})
    // Everything scoped to the host being left goes with it. A parked approval,
    // a guardian override and an outstanding hosted call all carry ids minted
    // under the OLD host generation, and the server requests behind them died
    // with the connection — answering one against the new host would apply a
    // human's verdict to a review nobody is waiting for any more. Same duties
    // `disconnected()` performs, for the same reason, one host earlier.
    this.failUnresolvedHostedCalls(INTERRUPTED_HOSTED_TOOL, turnId)
    for (const pending of [...this.pending.values()]) pending.settle()
    this.clearGuardianOverrides()
    this.heldDenials.clear()
    this.connection = null
    this.turnId = null
    connection.detach()
    // The thread stays LOADED in that process until the binary unloads it (60 s
    // after its last subscriber leaves), and a loaded thread's writer lock
    // refuses every other process's `thread/resume` (`-32600 already has an
    // active writer`, upstream's own `thread_resume.rs`). So the vacated host is
    // closed now rather than left to idle — unless another OWNER is on it, which
    // `applyPin` refuses before it gets this far. READ leases are deliberately
    // not consulted: a read that loses its host fails once and the next one
    // starts a fresh one, which is ADR-069 §5's designed behaviour, and waiting
    // for the 30-second sidebar poll's lease to drop would make a re-pin fail at
    // random.
    if (!connection.host.owners) connection.host.close('host-vacated')
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
   * The single funnel both NATIVE settings writes take — `setModel` and
   * `setEffort` are the only callers, and the only channels that reach them are
   * the engine-neutral `session:set-model` / `session:set-effort`.
   *
   * `accountId` shares the overrides ROW but is not a native thread setting: it
   * decides which token the process is injected with, and `thread/settings/update`
   * has no field for it. {@link setAccount} owns it; sending it here would put a
   * ClaudeUI-only key on the native wire, so it is refused rather than silently
   * dropped.
   */
  async setCodexSettings(value: CodexSettings): Promise<void> {
    const settings = parseCodexSettings(value)
    if ('accountId' in settings)
      throw new Error('The ChatGPT account pin is set through session:set-account')
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
      await this.wire.request('thread/settings/update', {
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

  // -------------------------------------------------------------------------
  // The per-session ChatGPT pin (ADR-068 §2)
  // -------------------------------------------------------------------------

  /** The vault account this session is pinned to, or null when it follows active. */
  private pinnedAccountId(): string | null {
    return this.overrides.accountId ?? null
  }

  /**
   * Pin this session to one stored ChatGPT account, or `null` to follow the
   * ACTIVE one (ADR-068 §2).
   *
   * Order matters and is deliberate: VALIDATE first (an id the vault does not
   * hold is refused and nothing is written — ADR-059's rule applied to
   * accounts), then persist, then apply.
   *
   * Applying splits on whether a turn is running, exactly as
   * {@link setPermissionMode} does. Idle: re-inject NOW on the live client —
   * `account/login/start {chatgptAuthTokens}` is the one login Codex still
   * accepts while external auth is active — then re-read `account/read` so the
   * label follows the identity. Busy: hold the pin and apply it at the next turn
   * boundary, because a turn that changed subscription halfway through would
   * bill two accounts for one conversation.
   */
  async setAccount(accountId: string | null): Promise<void> {
    if (!this.capabilities.auth.perSessionAccount)
      throw new Error('This engine does not support per-session accounts')
    if (this.closed) throw new Error('Codex session is disconnected')
    if (!this.auth)
      throw new Error('This Codex session does not manage its ChatGPT account through ClaudeUI')
    if (accountId !== null && !(await this.auth.hasAccount(accountId)))
      throw new Error('That ChatGPT account is no longer stored in ClaudeUI')
    // Nothing has started yet. Hold the choice for `start()` — which rebuilds
    // `this.overrides` from the saved row and would drop a write made here — and
    // then START, exactly as `setCodexSettings` does for a pre-spawn model or
    // effort. Merely parking it would leave the picker reading "Active · …"
    // until the first prompt happened to spawn the process, so the session would
    // silently disagree with what the user just chose. `start()` does the rest:
    // it folds the pin, injects that account, persists the overrides row and
    // emits the status that carries `codex.pinnedAccountId`.
    if (!this.starting) {
      this.pendingAccountId = accountId
      this.starting = this.start()
      await this.starting
      if (this.closed) throw new Error('Codex session is disconnected')
      return
    }
    await this.starting
    if (this.closed) throw new Error('Codex session is disconnected')
    if (this.busy || this.sending) {
      // The move happens at the next turn boundary, where `applyPendingPin`
      // makes the same refusal check — by then another session may have come or
      // gone, so asking now would answer for the wrong moment.
      await this.persistPin(accountId)
      this.pendingAccountId = accountId
      this.status('running')
      return
    }
    // Refused BEFORE anything is written: a pin that cannot be applied must not
    // be left in the overrides row, where it would say the session runs on an
    // account it does not.
    const target = await this.planPin(accountId).catch((error: unknown) => {
      this.send('session:error', error instanceof Error ? error.message : PIN_BLOCKED)
      throw error
    })
    try {
      await this.persistPin(accountId)
    } catch (error) {
      target.release()
      throw error
    }
    this.pendingAccountId = undefined
    await this.applyPin(accountId, target)
  }

  /**
   * Acquire the host this pin wants and decide whether the thread may move.
   *
   * It may not while another SESSION is attached to the host being left: the
   * thread's writer lock is released only when the process holding it exits or
   * unloads the thread (about a minute after its last subscriber leaves), and
   * closing a host other sessions are working on to make one pin land is not a
   * trade anyone would choose. Migrating those sessions with it is ADR-069 §4's
   * recycle, which is H3.
   */
  private async planPin(accountId: string | null): Promise<CodexHostHandle> {
    const target = await this.hosts.acquire({
      ...this.hostTransport,
      cwd: this.cwd,
      label: 'session',
      identity: { accountId }
    })
    const current = this.connection?.host
    if (current && target.host !== current && current.owners > 1) {
      target.release()
      throw new Error(PIN_BLOCKED)
    }
    return target
  }

  /** Write the pin into the overrides row beside model and effort. */
  private async persistPin(accountId: string | null): Promise<void> {
    const accepted = parseCodexSettings({ ...this.overrides, accountId })
    try {
      setCodexSessionOverrides(this.threadId!, accepted)
    } catch {
      throw new Error('The account pin could not be saved for reconnect')
    }
    this.overrides = accepted
  }

  /**
   * Move this session onto the host for `accountId` and refresh the attribution
   * (ADR-069 §2/§4).
   *
   * Before ADR-069 this was one `account/login/start` on the session's OWN
   * process. A host is shared, so re-pointing its identity would move every
   * other session on it: the move is now the THREAD's — interrupt, leave the old
   * host, resume on the target's.
   *
   * Two hosts can be the same process (a session that follows the active account
   * and one pinned to that same id land on one host), and that case must not
   * churn a thread at all, so the target is acquired FIRST and compared.
   *
   * A refusal — a managed workspace policy, or a thread the previous host still
   * holds the writer lock for — propagates with its own message after this
   * session has been put back on the host it came from: never a silent
   * substitution, and never a session left with no host at all. A move that
   * cannot be made at all is refused by {@link planPin} before anything moves.
   */
  private async applyPin(accountId: string | null, planned?: CodexHostHandle): Promise<void> {
    if (!this.auth) return
    const previous = this.hostAccountId
    // `setAccount` has already planned (and refused) an idle move; the turn
    // boundary has not, so it plans here and its refusal reaches the user
    // through `applyPendingPin`'s own `session:error`.
    const target = planned ?? (await this.planPin(accountId))
    const sameHost = this.connection?.host === target.host
    target.release()
    if (sameHost) {
      this.hostAccountId = accountId
      this.injectedAccountId = this.connection!.injectedAccountId
      await this.readAccount()
      if (this.closed) return
      this.status(this.busy ? 'running' : 'idle')
      return
    }
    await this.leaveHost()
    try {
      await this.takeThread(accountId)
    } catch (error) {
      this.connection?.detach()
      this.connection = null
      await this.takeThread(previous).catch(() =>
        this.disconnected(new CodexTransportError('host-move-failed'))
      )
      throw error
    }
    await this.readAccount()
    if (this.closed) return
    this.status(this.busy ? 'running' : 'idle')
  }

  /**
   * Apply a pin taken mid-turn, at the NEXT turn boundary — called from
   * {@link run} before `turn/start`, so the login is on the wire first and the
   * turn genuinely runs under the account the user chose.
   *
   * A failure here is reported and dropped rather than thrown: the pin is
   * already persisted (the next process start honours it) and refusing to send
   * the turn at all would be a worse answer than sending it on the identity the
   * process already holds.
   */
  private async applyPendingPin(): Promise<void> {
    if (this.pendingAccountId === undefined || !this.auth) return
    const accountId = this.pendingAccountId
    this.pendingAccountId = undefined
    try {
      await this.applyPin(accountId)
    } catch (error) {
      this.send(
        'session:error',
        error instanceof Error
          ? `The ChatGPT account for this session could not be changed: ${error.message}`
          : 'The ChatGPT account for this session could not be changed'
      )
    }
  }

  /**
   * Resolve the pin a resume or fork inherited, BEFORE the handshake injects.
   *
   * A pinned account that no longer exists does not silently become the active
   * one: the pin is cleared in the overrides and the user is told once
   * (ADR-059's no-silent-fallback rule, applied to accounts).
   */
  private async resolveSavedPin(): Promise<void> {
    const pin = this.overrides.accountId
    if (!this.auth || typeof pin !== 'string') return
    if (await this.auth.hasAccount(pin).catch(() => true)) return
    delete this.overrides.accountId
    this.send(
      'session:error',
      'The pinned ChatGPT account was removed; this session now follows the active account.'
    )
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
  private modePolicy(): CodexModePolicy {
    return codexModePolicy(this.permissionMode)
  }

  private turnPolicy(): ReturnType<typeof codexTurnPolicy> {
    return codexTurnPolicy(this.permissionMode)
  }

  async interrupt(): Promise<void> {
    // `turn/interrupt` ends the NATIVE turn; it cannot reach a cross-engine
    // dispatch this turn started, which is a plain promise awaiting the
    // dispatcher. Turn-scoped stop (the same call TaskCard's Stop button
    // makes), NOT disposeFor: an interrupt ends this turn, it does not tear
    // down a target a later turn may continue. Idempotent — a dispatch that
    // already settled is simply absent from the dispatcher's registry.
    this.stopInFlightDispatches()
    if (this.sending && !this.threadId) {
      this.dispose()
      return
    }
    if (this.willQueue) this.interruptRequested = true
    // A parent interrupt does NOT stop the children it spawned: `Op::Interrupt`
    // aborts the tasks of ONE session (`core/src/session/mod.rs`
    // `interrupt_task` -> `abort_all_tasks`), and the collab handlers have no
    // cascade. Each running child therefore needs its own `turn/interrupt`,
    // which the app-server accepts for any thread it can load
    // (`turn_processor.rs` `turn_interrupt_inner`). Fire-and-forget: that
    // request only answers once the child's `TurnAborted` arrives, and the
    // human's Stop must not wait on a child that ignores it.
    this.interruptChildren()
    if (this.threadId && this.turnId && !this.closed)
      try {
        this.interruptRequested = false
        await this.wire.request('turn/interrupt', {
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
  /**
   * Tear this session down. The PROCESS survives it (ADR-069 §2): what used to
   * be a kill is now an interrupt and a detach.
   *
   * The interrupt goes first and is fire-and-forget — `dispose()` is synchronous
   * on every caller's side and a turn left running on a shared host would keep
   * spending on a thread nobody is watching. Its children go the same way: the
   * app-server used to take them down with the process, and nothing else will.
   */
  dispose(): void {
    if (this.closed) return
    const connection = this.connection
    const threadId = this.threadId
    const turnId = this.turnId
    if (connection && threadId && turnId)
      void connection.request('turn/interrupt', { threadId, turnId }).catch(() => {})
    this.interruptChildren()
    this.disconnected()
  }

  private disconnected(error?: CodexTransportError): void {
    if (this.closed) return
    // Read before `turnId` is cleared below — the in-flight turn is what a
    // still-unanswered hosted call belongs to.
    const turnId = this.turnId
    this.closed = true
    this.busy = false
    this.sending = false
    this.turnId = null
    this.clearInactivityTimer()
    this.bashGate.cancelAll()
    this.output.clear()
    this.heldDenials.clear()
    this.ambiguousSteers.clear()
    // Same duty as the children below: a hosted call whose answer died with the
    // connection gets a result, not a spinner. A teardown is the user's own
    // Stop / close; a transport error is not, and says so.
    this.failUnresolvedHostedCalls(error ? STOPPED_HOSTED_TOOL : INTERRUPTED_HOSTED_TOOL, turnId)
    // Nothing is watching them any more: `dispose()` has already interrupted
    // each one and detaching drops their notifications, and a host death took
    // the whole process. Say so on each open card rather than leaving a spinner
    // forever.
    for (const [childThreadId, child] of this.children)
      this.finishChild(childThreadId, child, 'stopped')
    this.children.clear()
    for (const pending of [...this.pending.values()]) pending.settle()
    this.clearGuardianOverrides()
    // Nothing can consume a dispatch result any more: stop the turns, then
    // release the targets this session owns. `dispose()` funnels through here,
    // so this covers both an explicit teardown and a transport loss — and both
    // dispatcher calls are no-ops when this session never dispatched.
    this.stopInFlightDispatches()
    crossEngineDispatcher.disposeFor(this.routingId)
    // Nothing held can ever run now: the engine that would have taken it is
    // gone. Say so (ADR-053) rather than leaving items pending forever.
    this.recallQueuedOnEngineLoss()
    // `disposed` is this session's own teardown; `host-disposed` is app quit
    // closing every host (`codexHostRegistry.dispose()`), which is the same
    // thing one level up. Neither is news the user needs; every other code is a
    // host that went away under a live session (ADR-045/ADR-069 §5).
    if (error && error.code !== 'disposed' && error.code !== 'host-disposed')
      this.send('session:error', error.message)
    // Last, so the unsubscribes ride out after the cards are settled and after
    // `closed` is set: a notification racing this cannot reopen anything.
    this.connection?.detach()
    this.connection = null
    this.status('disconnected')
  }

  /** `turn/interrupt` every child that is mid-turn. Best effort, never awaited. */
  private interruptChildren(): void {
    if (this.closed) return
    for (const [childThreadId, child] of this.children) {
      const turnId = child.turnId
      if (!turnId) continue
      child.turnId = null
      // `connection?`, not `wire`: this runs on the teardown path too, where a
      // session that never finished starting has no connection to throw about.
      void this.connection
        ?.request('turn/interrupt', { threadId: childThreadId, turnId })
        .catch(() => {})
    }
  }

  /** Stop every dispatch this session still has in flight, scoped to it. */
  private stopInFlightDispatches(): void {
    for (const id of this.inFlightDispatchIds)
      crossEngineDispatcher.stopDispatch(id, this.routingId)
    this.inFlightDispatchIds.clear()
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
      // The same API-rate equivalent the status line carries (and the TopBar's
      // fallback until one arrives) — see `equivalentCost`. Before the first
      // `tokenUsage/updated` there is no equivalent yet, and the two reasons
      // for that are NOT the same statement: a PRICED model has spent a real,
      // known $0 so far (the zero-token equivalent), while an unpriced one —
      // or a thread whose model is not known yet — cannot be priced at all and
      // reports null, which the renderers show as "unknown" rather than free.
      totalCostUsd:
        this.equivalentCostUsd ??
        this.equivalentCost({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
      account: this.account,
      ...(this.native
        ? {
            codex: {
              ...this.native,
              overrides: { ...this.overrides },
              pinnedAccountId: this.pinnedAccountId()
            }
          }
        : {})
    } satisfies SessionStatus)
  }

  private notification(method: string, value: unknown): void {
    if (this.closed || !record(value)) return
    // ACCOUNT-level, not thread-level: `account/rateLimits/updated` carries no
    // `threadId` at all, so it has to be taken before the thread routing below
    // (which would otherwise hand it to `childNotification` as a foreign
    // thread). It is attributed to the account THIS process was injected with —
    // the only account whose usage this connection can be reporting (ADR-068 §2).
    if (method === 'account/rateLimits/updated') {
      if (this.injectedAccountId && record(value.rateLimits))
        chatgptRateLimits.record(
          this.injectedAccountId,
          value.rateLimits as RateLimitSnapshot,
          this.account?.label ? { email: this.account.label } : {}
        )
      return
    }
    if (!this.threadId) return
    // A foreign `threadId` reaching this session is one of its own CHILDREN: the
    // host routes a thread only to the owner that claimed it, and `registerChild`
    // is the only other place this session claims one (ADR-069 §2). A stranger's
    // thread never arrives at all.
    if (value.threadId !== this.threadId) return this.childNotification(method, value)
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
      this.rootUsage = value.tokenUsage as ThreadTokenUsage
      this.emitMetering()
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
    } else if (typeof value.turnId === 'string') {
      const ended = this.endedTurns.has(value.turnId)
      if (method === 'item/started' || method === 'item/completed') {
        if (!record(value.item) || typeof value.item.id !== 'string') return
        const item = value.item as ThreadItem
        // A child spawned without a blocking wait OUTLIVES the turn that
        // spawned it, and its completion is emitted raw into that same ended
        // turn (`core/src/agent/control.rs:244-280` stamps the parent turn id
        // whatever its state). Dropping it would leave the card spinning for
        // good, so sub-agent activity — and only that — is still honoured after
        // the turn's authoritative replay.
        if (ended && item.type !== 'subAgentActivity') return
        this.item(value.turnId, item, method === 'item/completed')
        // ADR-053: a completed item is this engine's observable sub-turn
        // boundary — the moment a held message can join the running turn.
        // Deltas are not (a steer between two tokens is not a boundary). An
        // ENDED turn has no boundary left to offer.
        if (method === 'item/completed' && !ended) this.queueBoundary()
      } else if (!ended && typeof value.itemId === 'string' && typeof value.delta === 'string') {
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
   * The API-rate equivalent of this session's cumulative tokens, or null when
   * the model has no published price (a hidden/preview catalog entry, or a
   * provider that is not OpenAI at all).
   *
   * The token mapping is Codex's, not Anthropic's, and the difference matters:
   * `TokenUsageBreakdown.inputTokens` is the TOTAL prompt, with
   * `cachedInputTokens` (cache hits) and `cacheWriteInputTokens` (tokens written
   * into the cache) as SUBSETS of it — that is the OpenAI Responses API's
   * `usage.input_tokens` / `input_tokens_details.{cached_tokens,
   * cache_write_tokens}`, copied field for field in
   * `codex-rs/codex-api/src/sse/responses.rs` (`impl From<ResponseCompletedUsage>
   * for TokenUsage`). Anthropic reports the three DISJOINT, which is why
   * `claude-session.ts` and `block-usage.ts` pass their input straight through.
   * So the billable base rate here is what is left after both subsets.
   *
   * `reasoningOutputTokens` is likewise a subset of `outputTokens`
   * (`output_tokens_details.reasoning_tokens`), so reasoning is already counted
   * once as output and must never be added again.
   */
  private equivalentCost(tokens: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
  }): number | null {
    if (!this.effectiveModel) return null
    return equivalentCostUsd(this.native?.modelProvider ?? 'openai', this.effectiveModel, {
      inputTokens: Math.max(0, tokens.input - tokens.cacheRead - tokens.cacheWrite),
      outputTokens: tokens.output,
      cacheWriteTokens: tokens.cacheWrite,
      // OpenAI publishes ONE cache-write rate; the 5m/1h split is Anthropic's.
      cacheWrite1hTokens: 0,
      cacheReadTokens: tokens.cacheRead
    })
  }

  /**
   * A cross-engine dispatch changed this session's spend (ADR-033 slice C).
   * BaseSession has no status-line builder, so each engine re-emits its own —
   * the same one-line override ClaudeSession and PiSession carry. Codex's line
   * is built from token usage, so a dispatch that lands before this thread has
   * reported any usage of its own shows up on the next `tokenUsage/updated`.
   */
  protected override onDispatchedCostsChanged(): void {
    this.emitMetering()
  }

  /**
   * The root's cumulative usage PLUS every child's, on the one meter the user
   * looks at. The two never double count: each thread emits its own
   * `thread/tokenUsage/updated` carrying its own cumulative totals for THAT
   * thread only (`app-server/src/bespoke_event_handling.rs`
   * `handle_token_count_event` stamps `conversation_id`), so summing the latest
   * snapshot per thread id is exactly the work this session paid for.
   *
   * The CONTEXT WINDOW stays the root's alone: a child has its own window, and
   * folding it in would misreport how close this thread is to compaction.
   */
  private emitMetering(): void {
    const usage = this.rootUsage
    if (!usage?.total || !usage.last) return
    const totals = [usage.total, ...[...this.children.values()].flatMap((c) => c.usage ?? [])]
    const sum = (pick: (entry: TokenUsageBreakdown) => number): number =>
      totals.reduce((carry, entry) => carry + pick(entry), 0)
    const input = sum((entry) => entry.inputTokens)
    const output = sum((entry) => entry.outputTokens)
    const cacheRead = sum((entry) => entry.cachedInputTokens)
    const cacheWrite = sum((entry) => entry.cacheWriteInputTokens)
    const total = sum((entry) => entry.totalTokens)
    this.equivalentCostUsd = this.equivalentCost({ input, output, cacheRead, cacheWrite })
    this.send('session:metering', {
      engineId: 'codex',
      vendorId: this.native?.modelProvider ?? 'openai',
      billingType: this.account?.billingType ?? 'unknown',
      tokens: { input, output, cacheRead, cacheWrite, total },
      equivalentCostUsd: this.equivalentCostUsd,
      contextWindow: { used: usage.last.totalTokens, size: usage.modelContextWindow ?? 0 }
    } satisfies MeteringSnapshot)
    this.send('session:status-line', {
      // The EQUIVALENT, not a real charge: a ChatGPT-subscription turn's true
      // USD cost is unknowable from here. The API-rate equivalent is what the
      // other engines show and the only honest figure available; an UNPRICED
      // model reports null (unknown), never zero — zero is reserved for "known
      // to be free" and the renderers render null as a placeholder.
      totalCostUsd: this.equivalentCostUsd,
      modelCosts: this.dispatchedCostEntries(),
      totalDurationMs: 0,
      totalApiDurationMs: 0,
      totalInputTokens: input,
      totalOutputTokens: output,
      cachedTokens: cacheRead,
      totalTokens: total,
      contextWindowSize: usage.modelContextWindow ?? 0,
      usedPercentage: usage.modelContextWindow
        ? (usage.last.totalTokens / usage.modelContextWindow) * 100
        : null,
      remainingPercentage: usage.modelContextWindow
        ? Math.max(0, 100 - (usage.last.totalTokens / usage.modelContextWindow) * 100)
        : null
    })
  }

  /**
   * A notification whose `threadId` is not this root's. It is a CHILD's, or it
   * is nothing to do with us.
   *
   * A child becomes known only when its spawning `collabAgentToolCall`
   * completes — that is the first (and, at 0.154.0, the ONLY) place its thread
   * id appears: the app-server emits `thread/started` on `thread/start`,
   * `thread/fork` and detached review alone, never for a spawned agent
   * (`ServerNotification::ThreadStarted` has exactly three emit sites in
   * `app-server/src/request_processors/`). The child is already running by
   * then, so anything it said in between is held BY THE HOST and replayed the
   * moment `registerChild` claims the thread — the hold moved there with
   * ADR-069 §2, because on a shared process the host is the only layer that can
   * see a notification for a thread no session has claimed yet.
   *
   * What reaches here is therefore always a thread this session claimed: its own
   * children. A stranger's is dropped by the demultiplexer and never arrives.
   */
  private childNotification(method: string, value: Record<string, unknown>): void {
    const threadId = value.threadId
    if (typeof threadId !== 'string' || !this.threadId) return
    const child = this.children.get(threadId)
    if (child) this.routeChild(child, threadId, method, value)
  }

  /** Bind one spawned thread to the card its transcript belongs under. */
  private registerChild(childThreadId: string, parentToolUseId: string): void {
    if (this.children.has(childThreadId) || childThreadId === this.threadId) return
    const child: CodexChild = {
      parentToolUseId,
      turnId: null,
      summary: '',
      timestamps: new Map(),
      startedAt: Date.now(),
      toolUses: 0,
      usage: null,
      notified: false,
      state: 'pendingInit'
    }
    this.children.set(childThreadId, child)
    // Registered BEFORE the claim: the host replays what it held for this thread
    // synchronously, and every one of those notifications routes through
    // `childNotification`, which has to find the child already bound.
    this.connection?.claim(childThreadId)
  }

  /** One known child's notification, on the engine-neutral subagent channels. */
  private routeChild(
    child: CodexChild,
    childThreadId: string,
    method: string,
    value: Record<string, unknown>
  ): void {
    if (method === 'turn/started' && record(value.turn) && typeof value.turn.id === 'string') {
      child.turnId = value.turn.id
      child.state = 'running'
      return
    }
    if (method === 'turn/completed' && record(value.turn)) {
      const turn = value.turn as Turn
      // The child's authoritative replay, exactly as the root's own turn end is
      // replayed — a corrected item reaches the transcript either way.
      for (const item of turn.items ?? []) this.childItem(child, childThreadId, turn.id, item, true)
      if (child.turnId === turn.id) child.turnId = null
      // Nothing can answer a question from a turn that ended.
      this.connection?.abortServerRequests(childThreadId, turn.id)
      for (const pending of [...this.pending.values()])
        if (pending.turnId === turn.id) pending.settle()
      // What this child will report on the next `wait` card, in the same
      // vocabulary the core's own `agent_status_from_event` uses.
      if (turn.status !== 'inProgress')
        child.state =
          turn.status === 'failed'
            ? 'errored'
            : turn.status === 'interrupted'
              ? 'interrupted'
              : 'completed'
      // A child that DIED closes its own card. On the v2 surface nothing else
      // will: a terminal `subAgentActivity` is only emitted for a child that
      // FINISHES, and `agentsStates` only ever reaches a v1 transcript, so a
      // failed or interrupted child would spin under its card until teardown.
      //
      // A `completed` turn is NOT terminal and must not close it — on v2 that
      // means "idle until the next message", and the parent routinely sends
      // another one.
      if ((turn.status === 'failed' || turn.status === 'interrupted') && !child.notified) {
        const failed = turn.status === 'failed'
        this.dispatch({
          kind: 'toolResult',
          toolUseId: child.parentToolUseId,
          result: failed ? 'Agent failed.' : 'Agent was interrupted.',
          isError: failed
        })
        this.finishChild(childThreadId, child, failed ? 'failed' : 'stopped')
      }
      return
    }
    if (method === 'thread/tokenUsage/updated' && record(value.tokenUsage)) {
      child.usage = (value.tokenUsage as ThreadTokenUsage).total
      this.emitMetering()
      return
    }
    if (typeof value.turnId !== 'string') return
    const turnId = value.turnId
    if (method === 'item/started' || method === 'item/completed') {
      if (!record(value.item) || typeof value.item.id !== 'string') return
      this.childItem(
        child,
        childThreadId,
        turnId,
        value.item as ThreadItem,
        method === 'item/completed'
      )
      return
    }
    if (typeof value.itemId !== 'string' || typeof value.delta !== 'string') return
    for (const event of mapCodexDelta(method, {
      threadId: childThreadId,
      turnId,
      itemId: value.itemId,
      delta: value.delta
    }))
      // `commandDelta` is deliberately dropped: `session:bash-output` is keyed
      // by the tool_use id of a block in the SESSION's transcript, and a child's
      // command block lives in the subagent transcript instead. The command's
      // aggregated output still lands with its `tool_result`.
      if (event.kind === 'stream')
        this.send('session:subagent-stream', {
          toolUseId: child.parentToolUseId,
          type: event.delta.type,
          text: event.delta.text
        })
  }

  /** One child thread item, mapped under its parent card's id. */
  private childItem(
    child: CodexChild,
    childThreadId: string,
    turnId: string,
    item: ThreadItem,
    completed: boolean
  ): void {
    const id = codexItemId(childThreadId, turnId, item.id)
    const fingerprint = completed
      ? createHash('sha256').update(JSON.stringify(item)).digest('hex')
      : undefined
    // The same map the root's items use: ids carry the thread, so they cannot
    // collide, and a replayed child item is deduped on the same rule.
    if (this.completedItems.get(id) === fingerprint && fingerprint !== undefined) return
    if (fingerprint !== undefined) this.completedItems.set(id, fingerprint)
    // A child that spawns its OWN child is refused rather than flattened: the
    // grandchild's transcript would have to interleave with its parent's under
    // one card, which reads as one agent contradicting itself. The native depth
    // limit already allows this shape, so say so once and drop the rest — the
    // grandchild is simply an unknown thread from here on.
    if (
      (item.type === 'collabAgentToolCall' && item.tool === 'spawnAgent') ||
      (item.type === 'subAgentActivity' && item.kind === 'started')
    ) {
      if (!this.nestedAgentWarned) {
        this.nestedAgentWarned = true
        this.send(
          'session:error',
          'A Codex agent spawned an agent of its own. Nested agents run natively but their transcripts are not shown.'
        )
      }
    }
    const timestamp = child.timestamps.get(id) ?? Date.now()
    child.timestamps.set(id, timestamp)
    for (const event of mapCodexItem(childThreadId, turnId, item, completed, timestamp)) {
      if (event.kind === 'message') {
        const text = event.message.content.find((block) => block.type === 'text')
        if (item.type === 'agentMessage' && text?.type === 'text') child.summary = text.text
        if (event.message.content.some((block) => block.type === 'tool_use')) child.toolUses++
        this.send('session:subagent-message', {
          toolUseId: child.parentToolUseId,
          message: event.message
        })
      } else if (event.kind === 'toolResult')
        this.send('session:subagent-tool-result', {
          toolUseId: child.parentToolUseId,
          toolResultToolUseId: event.toolUseId,
          result: event.result,
          isError: event.isError,
          ...(event.fileDiffs ? { fileDiffs: event.fileDiffs } : {})
        })
    }
  }

  /**
   * Close one child's card. Emitted ONCE per child, on the first terminal state
   * a collab call reports for it (`agentsStates`) or on teardown — never on the
   * child's own `turn/completed`, which only means "idle until the next
   * `send_input`" and would append a notification per turn.
   */
  private finishChild(
    childThreadId: string,
    child: CodexChild,
    status: TaskNotification['status']
  ): void {
    if (child.notified) return
    child.notified = true
    child.state = CHILD_CLOSED_STATE[status]
    this.send('session:task-notification', {
      taskId: childThreadId,
      toolUseId: child.parentToolUseId,
      status,
      outputFile: '',
      summary: child.summary.slice(0, 100),
      ...(child.usage
        ? {
            usage: {
              totalTokens: child.usage.totalTokens,
              toolUses: child.toolUses,
              durationMs: Date.now() - child.startedAt
            }
          }
        : {})
    } satisfies TaskNotification)
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

  /**
   * Tombstone every hosted tool call that has a `tool_use` row and no result.
   *
   * A `dynamicToolCall` the model started is completed by the BINARY on a turn
   * that ends normally, and `finishTurn`'s authoritative replay of `turn.items`
   * delivers that completion. An interrupted turn has no such item to replay:
   * the core drops a call that was still outstanding — it never reaches the
   * rollout either, so no read of any kind can bring it back (pinned against
   * the real binary by `codex-interrupted-tool.integration.test.ts`). The live
   * transcript is then a bare `tool_use`, and the card spins for good unless
   * the result the binary will never send is synthesized here.
   *
   * Only ever ADDITIVE: a `tool_use` that already has a `tool_result` is
   * skipped, so a result the replay did deliver is never overwritten and one
   * call is tombstoned once. Native `commandExecution` / `fileChange` items are
   * deliberately out of scope — the binary completes those itself on an
   * interrupt, so they are not orphaned in the first place.
   */
  private failUnresolvedHostedCalls(text: string, turnId: string | null): void {
    // `codexItemId` encodes [thread, turn, item] as JSON, so every id minted for
    // one turn shares the prefix an EMPTY item id produces, its own `""]` tail
    // dropped. Scoping matters: a late `turn/completed` for an earlier turn must
    // not tombstone a call the live turn is still running. A disconnect passes
    // no turn (nothing can run again) and sweeps the lot.
    const prefix =
      this.threadId && turnId ? codexItemId(this.threadId, turnId, '').replace(/""\]$/, '') : ''
    const blocks = this.messageHistory.flatMap((message) => message.content)
    const settled = new Set(
      blocks.flatMap((block) => (block.type === 'tool_result' ? [block.toolUseId] : []))
    )
    for (const block of blocks) {
      if (
        block.type !== 'tool_use' ||
        !block.toolUseId.startsWith(prefix) ||
        !CODEX_HOSTED_TOOL_NAMES.has(block.toolName) ||
        settled.has(block.toolUseId)
      )
        continue
      settled.add(block.toolUseId)
      this.dispatch({ kind: 'toolResult', toolUseId: block.toolUseId, result: text, isError: true })
    }
  }

  private finishTurn(turn: Turn): void {
    if (!this.threadId || typeof turn.id !== 'string' || this.endedTurns.has(turn.id)) return
    for (const item of turn.items ?? []) this.item(turn.id, item, true, true)
    // After the replay, never before it: what that did not complete never will.
    if (turn.status === 'interrupted' || turn.status === 'failed')
      this.failUnresolvedHostedCalls(
        turn.status === 'interrupted' ? INTERRUPTED_HOSTED_TOOL : STOPPED_HOSTED_TOOL,
        turn.id
      )
    this.endedTurns.add(turn.id)
    this.connection?.abortServerRequests(this.threadId, turn.id)
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
    if (item.type === 'collabAgentToolCall') {
      // `spawn_agent` is the ONLY collab call that mints a thread, so it is the
      // only one that binds a card: `wait`/`sendInput`/`closeAgent` name
      // children that already belong to an earlier spawn's transcript, and
      // rebinding them would split one agent's messages across two cards.
      if (item.tool === 'spawnAgent')
        for (const childThreadId of item.receiverThreadIds) this.registerChild(childThreadId, id)
      // EVERY collab call carries the current `agentsStates`, which is where a
      // child's terminal status actually shows up (`wait_agent` reporting
      // `completed`, `close_agent` reporting `shutdown`).
      for (const [childThreadId, state] of Object.entries(item.agentsStates ?? {})) {
        const child = this.children.get(childThreadId)
        const terminal = state?.status ? CHILD_TERMINAL_STATUS[state.status] : undefined
        if (child && terminal) this.finishChild(childThreadId, child, terminal)
      }
    }
    // The v2 surface's spawn/finish signal. `started` mints the card and binds
    // the child; every LATER activity carries its own item id (the call id of
    // whatever tool raised it, or a minted `subagent-completed-<turn>`), so the
    // card it belongs to can only be found through `agentThreadId`.
    if (item.type === 'subAgentActivity') {
      if (item.kind === 'started') this.registerChild(item.agentThreadId, id)
      else if (completed) {
        const child = this.children.get(item.agentThreadId)
        const result = subAgentActivityResult(item.kind)
        if (child && result !== undefined) {
          this.dispatch({
            kind: 'toolResult',
            toolUseId: child.parentToolUseId,
            result,
            isError: false
          })
          this.finishChild(
            item.agentThreadId,
            child,
            item.kind === 'completed' ? 'completed' : 'stopped'
          )
        }
      }
    }
    const timestamp =
      this.messageHistory.find((message) => message.id === id)?.timestamp ?? Date.now()
    for (const event of mapCodexItem(
      this.threadId!,
      turnId,
      this.withKnownAgents(item),
      completed,
      timestamp
    ))
      this.dispatch(event)
    // The tool_use block a held denial was waiting for may have just landed.
    const held = this.heldDenials.get(id)
    if (held) this.offerGuardianOverride(held)
  }

  /**
   * A `wait` collab call that names no agents, answered from this session's own
   * child registry.
   *
   * On the v2 surface the native `wait_agent` item arrives with an EMPTY
   * `receiverThreadIds` and `agentsStates` (v2 reports agent lifecycle through
   * `subAgentActivity` instead, and only the v1 tool populates those two
   * fields), so the card rendered null input and "No agent reported a state for
   * this call." — true of the payload, useless to the reader. This session
   * already knows every child it spawned and what each one last did, so it
   * fills them in. The mapper stays pure: it has no registry and must keep
   * rendering cold history exactly as the wire recorded it.
   *
   * Only ever ADDITIVE: a call that does name agents (every v1 one) passes
   * through untouched, and so does a `wait` on a session with no children.
   */
  private withKnownAgents(item: ThreadItem): ThreadItem {
    if (
      item.type !== 'collabAgentToolCall' ||
      item.tool !== 'wait' ||
      item.receiverThreadIds.length ||
      !this.children.size
    )
      return item
    return {
      ...item,
      receiverThreadIds: [...this.children.keys()],
      agentsStates: Object.fromEntries(
        [...this.children].map(([threadId, child]) => [
          threadId,
          { status: child.state, message: null }
        ])
      )
    }
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
   * through. For the hosted THREE it can only answer `allow` (the hosted
   * auto-allow rung of `decideWithSource` sits above every rung but deny, and
   * no Claude rule string maps to the `diagram`/`mockup` kinds), but the call
   * is made anyway so a future ladder change reaches Codex too — and anything
   * but `allow` refuses with the reason as the tool's own output, which is the
   * only channel that tells the model why. `dispatch_agent` is the one hosted
   * tool that is NOT auto-allowed, so its verdict genuinely varies and it owns
   * the `ask` path — see {@link dispatchAgent}.
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
    // Dispatch answers every verdict itself (deny/ask/allow) — the three below
    // stay fail-closed on anything but `allow`.
    if (value.tool === 'dispatch_agent')
      return this.dispatchAgent(id, value.turnId, args, verdict, context)
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

  /**
   * `dispatch_agent` (ADR-033, slice E) — Codex as a dispatch SOURCE. Codex as
   * a dispatch TARGET is a separate slice: the dispatcher has no Codex target
   * factory, so a `codex` target is refused by its own engine guard (as is
   * codex → codex, which is same-engine besides).
   *
   * Mirrors `PiSession.handleDispatchAgent` in spirit — identical validation,
   * identical `DispatchContext` construction, identical `[dispatch session_id:
   * …]` success suffix, so a Codex-sourced dispatch reads exactly like a
   * pi-sourced or Claude-sourced one — but imports nothing from pi and differs
   * in two ways the transport forces:
   *
   *  - `extra.signal` IS threaded through. pi's bridge is a POST body with no
   *    channel for an abort, but Codex's `item/tool/call` carries the
   *    app-server request's own signal, which `finishTurn` fires through
   *    `abortServerRequests`. The dispatcher races that signal against its own
   *    arms (`ctx.extra?.signal` → `{kind:'abort'}`), so an ended turn stops
   *    the dispatched target rather than leaving it editing files unwatched.
   *  - `toolUseId` is the call's `codexItemId`, which is EXACTLY the `tool_use`
   *    id the mapper emits for the `dynamicToolCall` item, so the dispatcher's
   *    subagent-stream / task-progress / task-notification events land on the
   *    card the model's own call rendered.
   *
   * Verdict handling: `deny` refuses with the engine's reason (plan mode, or a
   * user deny rule) as the tool's own output; `ask` parks the request behind a
   * human card bound to the same id and runs NOTHING until it is answered;
   * `allow` (a standing allow rule, or an earlier "allow for this session")
   * dispatches straight away.
   */
  private async dispatchAgent(
    toolUseId: string,
    turnId: string,
    args: Record<string, unknown> | undefined,
    verdict: { decision: PermissionDecision; reason?: string },
    context: Parameters<NonNullable<CodexClientOptions['onServerRequest']>>[2]
  ): Promise<DynamicToolCallResponse> {
    const refuse = (text: string): DynamicToolCallResponse => ({
      contentItems: [{ type: 'inputText', text }],
      success: false
    })
    if (verdict.decision === 'deny') {
      const reason = verdict.reason ?? 'dispatch_agent was not approved'
      this.send('session:error', reason)
      return refuse(reason)
    }
    // Shape first, card second: a call that cannot run either way is not worth
    // interrupting a human for. (`args` is only ever undefined on the deny
    // branch above, where the arguments were not an object at all.)
    const engine = args?.engine
    const prompt = args?.prompt
    if (
      (engine !== 'claude' && engine !== 'opencode' && engine !== 'pi') ||
      typeof prompt !== 'string'
    )
      return refuse(
        'dispatch_agent requires "engine" (one of "claude"|"opencode"|"pi") and a string "prompt".'
      )
    const req: DispatchRequest = {
      engine,
      prompt,
      model: typeof args?.model === 'string' ? args.model : undefined,
      sessionId: typeof args?.session_id === 'string' ? args.session_id : undefined
    }
    if (verdict.decision === 'ask') {
      const card: PendingApproval = {
        requestId: this.approvalRequestId(toolUseId, context.id),
        toolUseId,
        toolName: 'dispatch_agent',
        input: {
          engine: req.engine,
          prompt: req.prompt,
          ...(req.model !== undefined ? { model: req.model } : {}),
          ...(req.sessionId !== undefined ? { session_id: req.sessionId } : {})
        }
      }
      // `allowForSession` keys on the bare tool name, exactly as the shared
      // engine does for anything that is not bash — one "always" click covers
      // this session's later dispatches, whatever they target.
      const reply = await this.park(card, turnId, [sessionAllowKey('dispatch_agent', {})], context)
      if ((reply as { decision?: string }).decision !== 'accept')
        return refuse('dispatch_agent was declined by the user.')
    }
    const ctx: DispatchContext = {
      fromEngine: 'codex',
      fromRoutingId: this.routingId,
      cwd: this.cwd,
      // The user's OWN autonomy choice, un-narrowed: `gate()`'s auto→default
      // mapping governs what this client asks about, not what the dispatched
      // agent is allowed to do (the human just approved this dispatch anyway).
      autonomyMode: this.permissionMode,
      emit: (channel, data) => this.send(channel, data),
      addDispatchedCost: (engineId, modelId, costUsd) =>
        this.addDispatchedCost(engineId, modelId, costUsd),
      // A dispatch target bills the subscription THIS session runs on
      // (ADR-068 §2). Null when the session follows the active account, which is
      // also what every non-Codex caller sends.
      chatgptAccountId: this.pinnedAccountId(),
      toolUseId,
      extra: { signal: context.signal, sendNotification: async (): Promise<void> => {} }
    }
    this.inFlightDispatchIds.add(toolUseId)
    let result: Awaited<ReturnType<typeof crossEngineDispatcher.dispatch>>
    try {
      result = await crossEngineDispatcher.dispatch(req, ctx)
    } finally {
      this.inFlightDispatchIds.delete(toolUseId)
    }
    // Same end-of-turn check the hosted three make: the core has already
    // completed the item as `failed`, so a reply now answers nobody.
    if (this.closed || context.signal.aborted)
      throw new Error('Codex hosted tool call was cancelled before it finished')
    return {
      contentItems: [
        {
          type: 'inputText',
          text: result.isError
            ? result.text
            : `${result.text}\n\n[dispatch session_id: ${result.sessionId} — pass it as session_id to continue this agent]`
        }
      ],
      success: !result.isError
    }
  }

  /**
   * The requestId one server request's card is answered by. Scoped to this
   * process generation AND the native request id, so a replayed request can
   * never be answered by a card raised for an earlier one.
   */
  private approvalRequestId(toolUseId: string, requestId: unknown): string {
    return `codex-approval:${this.generation}:${toolUseId}:${JSON.stringify(requestId)}`
  }

  /**
   * Park one server request behind a human approval card: the card goes to the
   * renderer, this promise waits in `pending` until `resolveApproval` settles
   * it. Cancellation — turn end (`finishTurn`), disconnect, or the request's
   * own abort — settles with no reply, which REJECTS: the app-server turns a
   * rejected request into its own failure response, which is the honest answer
   * for a question nobody is waiting on any more.
   */
  private park(
    card: PendingApproval,
    turnId: string,
    allowKeys: string[],
    context: Parameters<NonNullable<CodexClientOptions['onServerRequest']>>[2],
    choices: CodexApprovalDecision[] = [],
    questions?: ToolRequestUserInputParams['questions'],
    reply: (accepted: boolean) => unknown = (accepted) => ({
      decision: accepted ? 'accept' : 'decline'
    })
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const abort = (): void => settle()
      const settle = (reply?: unknown): void => {
        if (!this.pending.delete(card.requestId)) return
        context.signal.removeEventListener('abort', abort)
        this.send('session:approval-dismiss', { requestId: card.requestId })
        if (reply === undefined) reject(new Error('Codex approval cancelled'))
        else resolve(reply)
      }
      this.pending.set(card.requestId, {
        turnId,
        choices: [...choices],
        questions,
        allowKeys,
        reply,
        settle
      })
      context.signal.addEventListener('abort', abort, { once: true })
      this.send('session:approval-request', card)
    })
  }

  /**
   * Answer `mcpServer/elicitation/request` — the one gate an MCP tool call has
   * on this wire (Slice 4b, ADR-067's "Codex executes; ClaudeUI decides").
   *
   * Codex has no MCP-specific approval request: `core/src/mcp_tool_call.rs`
   * sends a form elicitation before the tool runs and reads anything but
   * `accept` as `ReviewDecision::denied("user rejected MCP tool call")` — which
   * is what an unregistered method earned before this method existed, and why
   * every inherited MCP tool was unusable under the default mode.
   *
   * The verdict comes from the SAME evaluator and the same merged `~/.claude`
   * rules the command and file-change approvals use, under the tool name
   * Claude's own MCP rule vocabulary spells: `mcp__<server>__<tool>`. Allow
   * accepts, deny declines with a `session:error` naming the rule (neither
   * native reply carries a reason), ask raises the standard card whose
   * "always allow" suggestions and session-allow key are in that same
   * vocabulary. Codex's own persistence options are never echoed back.
   *
   * An elicitation that is NOT the tool approval is declined with one warning:
   * rendering arbitrary MCP forms is out of scope, and leaving the request
   * unanswered would stall the server that asked.
   */
  private mcpElicitation(
    value: unknown,
    context: Parameters<NonNullable<CodexClientOptions['onServerRequest']>>[2]
  ): Promise<unknown> {
    const child =
      record(value) && typeof value.threadId === 'string' && value.threadId !== this.threadId
        ? this.children.get(value.threadId)
        : undefined
    const ownThread = record(value) && value.threadId === this.threadId
    // `turnId` is NULLABLE here, unlike every `*/requestApproval` params type:
    // MCP models elicitation as a standalone server-to-client request and the
    // app-server only correlates a turn when it can. An uncorrelated one still
    // belongs to whatever turn this connection is running, which is the turn
    // the card has to be cancelled with.
    const turnId =
      record(value) && typeof value.turnId === 'string'
        ? value.turnId
        : child
          ? child.turnId
          : this.turnId
    if (
      this.closed ||
      context.signal.aborted ||
      !record(value) ||
      (!ownThread && !child) ||
      typeof turnId !== 'string' ||
      (child
        ? child.turnId !== null && child.turnId !== turnId
        : turnId !== this.turnId || this.endedTurns.has(turnId))
    )
      return Promise.reject(new Error('Codex request has no live owning root turn'))
    const approval = readMcpToolApproval(value)
    if (!approval) {
      const server = typeof value.serverName === 'string' ? value.serverName : 'An MCP server'
      this.send('session:warning', `${server} asked a question ClaudeUI cannot show yet`)
      return Promise.resolve(MCP_ELICITATION_DECLINE)
    }
    const toolName = mcpRuleToolName(approval.server, approval.tool)
    const verdict = this.gate([{ tool: toolName, input: {} }])
    if (verdict.decision === 'allow') return Promise.resolve(MCP_ELICITATION_ACCEPT)
    if (verdict.decision === 'deny') {
      this.send('session:error', verdict.reason!)
      return Promise.resolve(MCP_ELICITATION_DECLINE)
    }
    // The elicitation names no thread ITEM (the app-server's own TODO says core
    // cannot correlate one yet), so the card has no transcript row to bind to
    // and floats — actionable, just not inline. The native request id keeps it
    // unique within this process generation.
    const toolUseId = codexItemId(
      value.threadId as string,
      turnId,
      `mcp-elicitation-${JSON.stringify(context.id)}`
    )
    const requestId = this.approvalRequestId(toolUseId, context.id)
    if (this.pending.has(requestId)) return Promise.reject(new Error('Duplicate Codex approval'))
    const card: PendingApproval = {
      requestId,
      toolUseId,
      toolName,
      // Display only — `tool_params` is what the model passed, and nothing in
      // the ladder gates on an MCP tool's arguments.
      input: approval.params,
      suggestions: this.buildApprovalSuggestions(toolName)
    }
    return this.park(
      card,
      turnId,
      [sessionAllowKey(toolName, {})],
      context,
      [],
      undefined,
      (accepted) => (accepted ? MCP_ELICITATION_ACCEPT : MCP_ELICITATION_DECLINE)
    )
  }

  private requestApproval(
    method: string,
    value: unknown,
    context: Parameters<NonNullable<CodexClientOptions['onServerRequest']>>[2]
  ): Promise<unknown> {
    // A CHILD's approval is the human's to answer too: the child runs in this
    // root's process on this root's connection, and under `auto` nothing
    // reaches here at all (the native reviewer answers first) — so what does
    // arrive is precisely what was escalated, whoever raised it. The owning
    // turn is then the child's own, which the root's `turnId`/`endedTurns`
    // know nothing about.
    const child =
      record(value) && typeof value.threadId === 'string' && value.threadId !== this.threadId
        ? this.children.get(value.threadId)
        : undefined
    const ownThread = record(value) && value.threadId === this.threadId
    if (
      this.closed ||
      context.signal.aborted ||
      !record(value) ||
      (!ownThread && !child) ||
      typeof value.turnId !== 'string' ||
      typeof value.itemId !== 'string' ||
      (child
        ? child.turnId !== null && child.turnId !== value.turnId
        : value.turnId !== this.turnId || this.endedTurns.has(value.turnId))
    )
      return Promise.reject(new Error('Codex request has no live owning root turn'))
    const threadId = value.threadId as string
    const requestId = this.approvalRequestId(
      codexItemId(threadId, value.turnId, value.itemId),
      context.id
    )
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
      // The CHILD item's own id when a child raised it. Nothing in the
      // session's own transcript carries that id (the child's blocks live in
      // `subagentMessages`), so `useUnmatchedApprovals` finds no match and the
      // card floats — actionable, just not inline: `SubagentMessages` has no
      // approval binding of its own, and giving it one is a renderer change
      // this slice does not own.
      toolUseId: codexItemId(threadId, value.turnId, value.itemId),
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
    return this.park(card, value.turnId as string, allowKeys, context, choices, questions)
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
      // An MCP tool is ALREADY spelled in Claude's rule vocabulary
      // (`mcp__<server>__<tool>`), which is why it is passed through rather than
      // translated: the map only covers the seven names with a pi analogue.
      toolName: PI_TOOL_TO_CLAUDE_TOOL[tool] ?? tool,
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
    void this.wire
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
    pending.settle(pending.reply(decision !== 'deny'))
    // No rules cache to invalidate here: `gate()` re-reads the merged rules per
    // request, so a newly persisted rule is honoured on the very next approval.
    if (updatedPermissions && updatedPermissions.length > 0)
      persistAllowSuggestions(updatedPermissions, this.cwd, 'CodexSession')
  }
}

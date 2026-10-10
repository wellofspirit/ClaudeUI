/**
 * Auto-mode blocks the user can still approve after the fact (ADR-091 part 6)
 * — ONE ledger per ROOT session (BaseSession owns it), shared by the session's
 * own calls, its children (pi host-run agents at any depth, opencode task
 * children) and its pi/opencode dispatch targets (through
 * `DispatchContext.blockedCalls`).
 *
 * Every judge block is recorded here when it arrives, with the review it
 * carries. While a held card is up the entry is `held` and cannot be approved
 * from the review (the card is the place for that); every exit from the held
 * card settles it. Approving a settled entry:
 *
 * - records a ONE-SHOT, exact-match grant (`grantKey`, which includes the
 *   call's effective working directory): the next identical call by any agent
 *   of this session is allowed just before the judge would run
 *   (`JudgePipelineHooks.consumeGrant`) and the grant is spent. It lapses
 *   {@link BLOCK_GRANT_TTL_MS} after the click (dropped lazily). It is not a
 *   standing rule — memory only, never persisted, gone with the session, and
 *   it never matches a different input. The user's deny and ask rules run
 *   before the pipeline, so they still win; a HARD block is approvable too,
 *   since the click is the user reviewing the call directly. An entry with no
 *   key (Claude: cli.js owns that judge) grants nothing — the nudge is all;
 * - returns the call, so the session routes the nudge (`deliver`, else the
 *   root agent's prompt) and then {@link BlockedCallLedger.markApproved} re-sends
 *   the review marked {@link ToolReviewBlock.overriddenByUser} with where the
 *   nudge went, under a new `reviewId` (the reducer shows the last review, and
 *   it replicates like the first). The entry is gone, so a second Approve —
 *   the same call rendered on two surfaces — is a no-op.
 *
 * Approve anyway on a held card marks the review the same way, with no grant
 * and no nudge: that call runs as it is.
 */
import type { ToolReviewBlock } from '../../shared/types'
import { resolveTarget, shellCommandOf } from './shell-lexical'

export interface BlockedCall {
  toolName: string
  input: Record<string, unknown>
  /** The block's review — re-sent marked when the user approves it. */
  review: ToolReviewBlock
  /** {@link blockGrantKey} of the call; absent → no grant is possible (Claude). */
  grantKey?: string
  /** The agent that made the call (a subagent's or a dispatch target's label); absent → the root's own. */
  agentLabel?: string
  /** A dispatch target's session id, so the dispatching agent can send the call back to it. */
  dispatchSessionId?: string
  /**
   * The engine family's routing below the root (ADR-091 part 6): deliver the
   * nudge to the nearest LIVE agent on the path from the blocked agent up, and
   * return who took it (`"<label>"`); `null` → nobody below the root is live,
   * and the root agent gets {@link blockedCallNudge} as a user prompt.
   */
  deliver?: (call: BlockedCall) => string | null
}

/** Blocked calls remembered per session; the oldest is forgotten first. */
export const BLOCKED_CALLS_MAX = 200

/** How long an approval's grant waits for the retry it allows. */
export const BLOCK_GRANT_TTL_MS = 15 * 60 * 1000

/** Where a root-prompt nudge went, as the review says it ("Sent to …"). */
export const NUDGED_TO_MAIN_AGENT = 'the main agent'

/** The nudge's call summary cap (characters). */
const SUMMARY_MAX = 200

export class BlockedCallLedger {
  private readonly calls = new Map<string, { call: BlockedCall; held: boolean }>()
  /** Unspent grants by key: one expiry (epoch ms) per approval, oldest first. */
  private readonly grants = new Map<string, number[]>()

  constructor(
    private readonly sendReview: (toolUseId: string, review: ToolReviewBlock) => void,
    private readonly now: () => number = Date.now
  ) {}

  /** A judge block arrived. `held` while its card is up (see {@link settle}). */
  record(toolUseId: string, call: BlockedCall, held: boolean): void {
    this.calls.delete(toolUseId)
    this.calls.set(toolUseId, { call, held })
    if (this.calls.size > BLOCKED_CALLS_MAX) {
      const oldest = this.calls.keys().next().value
      if (oldest !== undefined) this.calls.delete(oldest)
    }
  }

  /** The held card left — kept, expired, interrupted or abandoned: approvable from the review now. */
  settle(toolUseId: string): void {
    const entry = this.calls.get(toolUseId)
    if (entry) entry.held = false
  }

  /** Approve anyway on the held card: the call runs as it is, so no grant and no nudge — only the marker. */
  approveHeld(toolUseId: string): void {
    const entry = this.calls.get(toolUseId)
    if (!entry) return
    this.calls.delete(toolUseId)
    this.markApproved(toolUseId, entry.call.review)
  }

  /**
   * Approve a settled block after the fact: grant it and hand back the call,
   * whose review the caller marks once the nudge is routed. `undefined` for an
   * unknown, already-approved or still-held call — the caller does nothing.
   */
  approve(toolUseId: string): BlockedCall | undefined {
    const entry = this.calls.get(toolUseId)
    if (!entry || entry.held) return undefined
    this.calls.delete(toolUseId)
    const key = entry.call.grantKey
    if (key !== undefined) {
      this.grants.set(key, [...this.live(key), this.now() + BLOCK_GRANT_TTL_MS])
    }
    return entry.call
  }

  /** Spend one unexpired grant for `key`. True → the call is allowed without the judge. */
  consumeGrant(key: string): boolean {
    const left = this.live(key)
    if (left.length === 0) {
      this.grants.delete(key)
      return false
    }
    left.shift()
    if (left.length === 0) this.grants.delete(key)
    else this.grants.set(key, left)
    return true
  }

  /** Re-send the review as approved by the user, with where the nudge went (if one was sent). */
  markApproved(toolUseId: string, review: ToolReviewBlock, nudgedTo?: string): void {
    this.sendReview(toolUseId, {
      ...review,
      reviewId: `${review.reviewId}:approved`,
      overriddenByUser: true,
      ...(nudgedTo ? { nudgedTo } : {})
    })
  }

  /** `key`'s unexpired grants (expired ones are dropped here, lazily). */
  private live(key: string): number[] {
    const now = this.now()
    return (this.grants.get(key) ?? []).filter((expiresAt) => expiresAt > now)
  }
}

/**
 * The exact-match key of a call (ADR-091 part 6): the engine whose vocabulary
 * `toolName`/`input` speak, the call's EFFECTIVE working directory (`cwd`, or
 * an opencode shell's `workdir` resolved against it — the same command in a
 * worktree is a different action), and the call itself. A shell command
 * compares the way pi's session-allow key does (`sessionAllowKey`:
 * whitespace-collapsed); any other call compares its WHOLE input (key order
 * ignored) — unlike a session allow, whose non-shell key is the bare tool
 * name, a grant must never cover a different input.
 */
export function blockGrantKey(
  engine: string,
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  honoursWorkdir = false
): string {
  const workdir = input.workdir
  const at =
    honoursWorkdir && typeof workdir === 'string' && workdir !== ''
      ? resolveTarget(cwd, workdir, process.platform).full
      : cwd
  const command = shellCommandOf(toolName, input)
  if (command !== null) return `${engine}\0${at}\0shell\0${collapse(command)}`
  return `${engine}\0${at}\0${toolName}\0${stableJson(input)}`
}

/**
 * The user prompt the ROOT agent is sent when no agent below it is live to
 * take the nudge (or the call was its own). It is the user's own word in the
 * transcript, so it also tells the judge's consent reading what the grant
 * already lets through.
 */
export function blockedCallNudge(call: BlockedCall): string {
  const label = cleanLabel(call.agentLabel)
  const head = `I approve the ${call.toolName} call auto mode blocked${label ? ` for the "${label}" subagent` : ''}${summaryPart(call)}. Run it again exactly as it was`
  if (!label) return `${head}.`
  if (call.dispatchSessionId) {
    return `${head} — yourself, or by dispatching it back to that agent (session_id "${call.dispatchSessionId}").`
  }
  return `${head} — yourself, or by sending it back to that subagent.`
}

/**
 * A nudge delivered to a live agent below the root, marked as ClaudeUI's on
 * the user's behalf: to the agent that made the call (`self`), or to a live
 * ancestor of a finished one.
 */
export function blockedCallDelivery(call: BlockedCall, self: boolean): string {
  if (self) {
    return `[ClaudeUI] The user approved your blocked ${call.toolName} call${summaryPart(call)}. Run it again exactly as it was.`
  }
  const label = cleanLabel(call.agentLabel)
  return (
    `[ClaudeUI] The user approved the ${call.toolName} call auto mode blocked` +
    `${label ? ` for the "${label}" subagent` : ''}${summaryPart(call)}. ` +
    'Run it again exactly as it was — yourself, or by sending it back to that subagent.'
  )
}

/**
 * A delivered nudge's envelope (pi children, pi dispatch targets). NOT an
 * `<agent-message>`: an agent picks its own `name`, so one named "user" could
 * mint that envelope, while agents can only send through `send_message`, which
 * always wraps them in one — a top-level notice is the host's alone. Never
 * consent to the judge either way (a delivery is a system row): the grant is
 * what lets the retry through.
 */
export function blockApprovalNotice(message: string): string {
  return `<claudeui-notice from="ClaudeUI, on the user's behalf">\n${message}\n</claudeui-notice>`
}

/**
 * The routing decision every engine family shares: the nearest LIVE agent on
 * the path from `start` (the blocked agent) up through `parentOf`, or `null`
 * when none is live — the root takes the nudge then. Never resumes anything.
 */
export function nearestLiveAgent<T>(
  start: T | null,
  parentOf: (agent: T) => T | null,
  isLive: (agent: T) => boolean
): T | null {
  const seen = new Set<T>()
  for (let at = start; at !== null && !seen.has(at); at = parentOf(at)) {
    seen.add(at)
    if (isLive(at)) return at
  }
  return null
}

/** One line naming what the call does: the command, else its target, else its input. */
export function blockedCallSummary(toolName: string, input: Record<string, unknown>): string {
  const command = shellCommandOf(toolName, input)
  let text = command ?? ''
  if (!text) {
    // …then a delegation's (pi `agent`, `dispatch_agent`, opencode `task`):
    // its description, else its prompt — never the whole input as JSON.
    for (const key of [
      'file_path',
      'filePath',
      'path',
      'url',
      'pattern',
      'query',
      'description',
      'prompt'
    ]) {
      const v = input[key]
      if (typeof v === 'string' && v.trim()) {
        text = v
        break
      }
    }
  }
  if (!text && Object.keys(input).length > 0) text = stableJson(input)
  text = collapse(text)
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX)}…` : text
}

function summaryPart(call: BlockedCall): string {
  const summary = blockedCallSummary(call.toolName, call.input)
  return summary ? `: ${summary}` : ''
}

/** A label inside the nudge's quotes: one line, no double quotes. */
function cleanLabel(label: string | undefined): string {
  return label ? collapse(label).replace(/"/g, "'") : ''
}

function collapse(s: string): string {
  return s.trim().replace(/\s+/g, ' ')
}

/** JSON with object keys sorted at every depth, so equal inputs give equal text. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v as Record<string, unknown>)
            .sort()
            .map((k) => [k, (v as Record<string, unknown>)[k]])
        )
      : v
  )
}

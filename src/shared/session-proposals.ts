/**
 * Session proposals (session tools, slice 1c-b, spec 6.2): a session an agent
 * proposes for the user to start. The proposal is a row in `session_proposal`; what
 * the clients see is a `proposal_card` block in the proposing session's transcript,
 * rewritten in place on every state change, so a card is true without any client
 * holding proposal state of its own.
 *
 * Shared by the host (`core/services/session-proposals.ts`), the card and the
 * tests, so the shape, the lifetime and the one rule for "expired" have one
 * definition.
 */
import type { EngineId } from './types'

/** A proposal lives a week; expiry is read from the clock when it is looked at, not by a timer. */
export const PROPOSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** Pending proposals one session may have; the oldest is withdrawn (reason `evicted`) past it. */
export const MAX_PENDING_PROPOSALS = 20
/** Rows kept per session; past it the oldest dismissed ones (evicted first) are deleted. */
export const MAX_STORED_PROPOSALS = 50

/** `p-` and eight hex digits. */
export const PROPOSAL_ID_PATTERN = /^p-[0-9a-f]{8}$/
export const isProposalId = (input: unknown): input is string =>
  typeof input === 'string' && PROPOSAL_ID_PATTERN.test(input)

/**
 * Where and how the proposed session will run, resolved when it was proposed (the
 * parent's engine, model, effort and mode filled in), so a click starts exactly
 * what the card showed whatever the parent has done since.
 */
export interface ProposalPlacement {
  engine: EngineId
  model?: string
  effort?: string
  permission_mode: string
  /** Absolute, in the same path style UI-created sessions use. */
  cwd: string
  /** A git worktree name to create for it, if the proposal asked for one. */
  worktree?: string
  /** The directory is outside the proposing session's own tree: starting it needs the click, and the card says so. */
  outside?: boolean
  wake_when_done?: boolean
}

export type ProposalState = 'pending' | 'started' | 'dismissed'

/** What the card shows. `expired` is a way of being `dismissed` (see {@link proposalDisplayState}). */
export type ProposalDisplayState = 'pending' | 'started' | 'dismissed' | 'expired'

export interface ProposalCardFields {
  state: ProposalState
  reason?: string
  expiresAt: number
}

/**
 * The state a card shows at `now`. A pending proposal past its expiry reads as
 * expired even before the host has written that down, so a card left open on a
 * client never offers a Start the host will refuse.
 */
export function proposalDisplayState(card: ProposalCardFields, now: number): ProposalDisplayState {
  if (card.state === 'started') return 'started'
  if (card.state === 'dismissed') return card.reason === 'expired' ? 'expired' : 'dismissed'
  return card.expiresAt <= now ? 'expired' : 'pending'
}

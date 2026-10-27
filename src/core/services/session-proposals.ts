/**
 * Session proposals on the host (session tools, slice 1c-b, spec 6.2): the rows,
 * their one lifetime rule, and the card that shows each in its proposer's transcript.
 *
 *  - A proposal is `pending` until it is `started` (a click, or the agent after the
 *    user said so) or `dismissed` (the user, the agent, eviction, expiry). A Start
 *    first CLAIMS it (`pending` → `starting`), so nothing else can close it while its
 *    session is being made; a failure puts it back to `pending`, success makes it
 *    `started`. The card shows `starting` as pending.
 *  - Expiry is lazy: nothing runs on a timer. Every read of a proposal compares its
 *    `expires_at` with the clock and, if it is past, settles it as dismissed with
 *    reason `expired` — and tells the clients, by rewriting the card. A card left
 *    open on a client also shows a pending proposal past its expiry as expired, so
 *    it never offers a Start the host will refuse.
 *  - A session keeps at most {@link MAX_PENDING_PROPOSALS} pending; a new one past
 *    that withdraws the oldest (reason `evicted`). It keeps at most
 *    {@link MAX_STORED_PROPOSALS} rows in all: past that the oldest dismissed ones go,
 *    evicted first, and an evicted proposal's card is not put back on a cold read.
 *  - The card is a `proposal_card` block with id `proposal-card-<id>`, emitted as a
 *    `session:message` into the proposer's transcript and REWRITTEN IN PLACE on every
 *    state change (a message with the same id replaces the old one). A cold read
 *    puts it back from the table (`withProposalCards`), like the session cards.
 *
 * Starting a proposal is `session-tools.ts`'s: it owns the spawn flow.
 */
import { randomBytes } from 'node:crypto'
import type { ChatMessage } from '../../shared/types'
import {
  MAX_PENDING_PROPOSALS,
  MAX_STORED_PROPOSALS,
  PROPOSAL_TTL_MS,
  type ProposalPlacement
} from '../../shared/session-proposals'
import {
  findSessionRef,
  getSessionProposal,
  insertSessionProposal,
  sessionProposalsByParent,
  settleSessionProposal,
  transitionSessionProposal,
  trimSessionProposals,
  type SessionProposalRow
} from './db'
import { resolveRef } from './session-links'
import { logger } from './logger'
import { emitEvent, syncCore } from './sync-host'

const LOG = 'SessionProposals'

export interface Proposal {
  id: string
  parentRef: string
  title: string
  prompt: string
  background: string
  placement: ProposalPlacement
  state: SessionProposalRow['state']
  createdAt: number
  expiresAt: number
  startedRef: string | null
  dismissReason: string | null
}

export const proposalCardId = (id: string): string => `proposal-card-${id}`

function parsed(row: SessionProposalRow): Proposal {
  return { ...row, placement: JSON.parse(row.placement) as ProposalPlacement }
}

function newProposalId(): string {
  return `p-${randomBytes(4).toString('hex')}`
}

/** The proposer's working directory, for the card to say when the placement differs from it. */
function parentCwdOf(parentRef: string): string {
  const parent = resolveRef(parentRef)
  if (!parent.ok) return ''
  const state = syncCore.getCanonicalState()
  const live = state.sessions[parent.id]
  if (live?.cwd) return live.cwd
  for (const group of state.directories) {
    if (group.sessions.some((s) => s.sessionId === parent.id)) return group.cwd
  }
  return ''
}

export function proposalCardMessage(p: Proposal): ChatMessage {
  return {
    id: proposalCardId(p.id),
    role: 'system',
    content: [
      {
        type: 'proposal_card',
        proposalId: p.id,
        title: p.title,
        prompt: p.prompt,
        background: p.background,
        placement: p.placement,
        parentCwd: parentCwdOf(p.parentRef),
        // `starting` is a pending proposal nobody else can close: the card shows pending.
        state: p.state === 'starting' ? 'pending' : p.state,
        ...(p.dismissReason ? { reason: p.dismissReason } : {}),
        expiresAt: p.expiresAt,
        ...(p.startedRef ? { startedRef: p.startedRef } : {})
      }
    ],
    timestamp: p.createdAt
  }
}

/** Put the proposal's card (or its new state) into the proposer's transcript on every client. */
export function emitProposalCard(p: Proposal): void {
  try {
    const parent = resolveRef(p.parentRef)
    if (!parent.ok) return
    emitEvent('session:message', [parent.id, proposalCardMessage(p)])
  } catch (err) {
    logger.warn(LOG, `could not update the card of ${p.id}: ${String(err)}`)
  }
}

/** Settle every pending proposal of `parentRef` whose time is up, and rewrite their cards. */
function expireDue(now: number, parentRef: string): void {
  for (const row of sessionProposalsByParent(parentRef, 'pending')) {
    if (row.expiresAt > now) continue
    if (settleSessionProposal(row.id, { state: 'dismissed', reason: 'expired' })) {
      const settled = getSessionProposal(row.id)
      if (settled) emitProposalCard(parsed(settled))
    }
  }
}

/**
 * One proposal as it is NOW: if it was pending and its time is up it is settled as
 * expired first. Undefined for an id that does not exist.
 */
export function readProposal(id: string, now: number = Date.now()): Proposal | undefined {
  let row = getSessionProposal(id)
  if (!row) return undefined
  // `starting` with nobody starting it is a launch the process did not outlive.
  if (row.state === 'starting' && !inFlight.has(id)) {
    transitionSessionProposal(id, 'starting', { state: 'pending' })
    row = getSessionProposal(id) ?? row
  }
  if (row.state === 'pending' && row.expiresAt <= now) {
    expireDue(now, row.parentRef)
    const settled = getSessionProposal(id)
    return settled ? parsed(settled) : undefined
  }
  return parsed(row)
}

/** A parent's still-pending proposals at `now`, oldest first. */
export function pendingProposalsOf(parentRef: string, now: number = Date.now()): Proposal[] {
  expireDue(now, parentRef)
  return sessionProposalsByParent(parentRef, 'pending').map(parsed)
}

export interface NewProposal {
  parentRef: string
  title: string
  prompt: string
  background: string
  placement: ProposalPlacement
  now?: number
}

/**
 * Record a proposal and put its card in the parent's transcript. A parent already
 * at {@link MAX_PENDING_PROPOSALS} loses its oldest pending one (reason `evicted`).
 */
export function createProposal(input: NewProposal): Proposal {
  const now = input.now ?? Date.now()
  const pending = pendingProposalsOf(input.parentRef, now)
  for (const old of pending.slice(0, Math.max(0, pending.length - MAX_PENDING_PROPOSALS + 1))) {
    dismissProposal(old.id, 'evicted', now)
  }
  const id = newProposalId()
  insertSessionProposal({
    id,
    parentRef: input.parentRef,
    title: input.title,
    prompt: input.prompt,
    background: input.background,
    placement: JSON.stringify(input.placement),
    createdAt: now,
    expiresAt: now + PROPOSAL_TTL_MS
  })
  trimSessionProposals(input.parentRef, MAX_STORED_PROPOSALS)
  const created = parsed(getSessionProposal(id) as SessionProposalRow)
  emitProposalCard(created)
  return created
}

/** Withdraw a pending proposal. False when it is gone or already settled. */
export function dismissProposal(id: string, reason: string, now: number = Date.now()): boolean {
  const row = getSessionProposal(id)
  if (!row) return false
  if (row.state === 'pending' && row.expiresAt <= now) {
    expireDue(now, row.parentRef)
    return false
  }
  if (!settleSessionProposal(id, { state: 'dismissed', reason })) return false
  emitProposalCard(parsed(getSessionProposal(id) as SessionProposalRow))
  return true
}

/** Proposals being started in this process (so a `starting` row left by a dead one can be told apart). */
const inFlight = new Set<string>()

/**
 * Win a pending proposal for a Start: `pending` → `starting`, or undefined when it
 * is not pending (any longer) — closed, expired, or already being started. Nothing
 * may be spawned unless this returned the proposal.
 */
export function claimProposal(id: string, now: number = Date.now()): Proposal | undefined {
  const current = readProposal(id, now)
  if (!current || current.state !== 'pending') return undefined
  if (!transitionSessionProposal(id, 'pending', { state: 'starting' })) return undefined
  inFlight.add(id)
  return { ...current, state: 'starting' }
}

/** A claimed Start did not make a session: put the proposal back, still offered. */
export function releaseProposal(id: string): void {
  inFlight.delete(id)
  transitionSessionProposal(id, 'starting', { state: 'pending' })
}

/** The claimed Start made `startedRef`: the proposal is started, and its card says so. */
export function finishProposal(id: string, startedRef: string): boolean {
  inFlight.delete(id)
  if (!transitionSessionProposal(id, 'starting', { state: 'started', startedRef })) return false
  emitProposalCard(parsed(getSessionProposal(id) as SessionProposalRow))
  return true
}

/**
 * A cold-loaded transcript with the proposer's cards put back, placed by when each
 * proposal was made (before the first message after it, else at the end), carrying
 * the state they are in now. Never throws: a history read must not fail because
 * the proposal table could not be read.
 */
export function withProposalCards(sessionId: string, messages: ChatMessage[]): ChatMessage[] {
  try {
    const parent = findSessionRef(sessionId)
    if (!parent) return messages
    expireDue(Date.now(), parent.ref)
    // A proposal that was only ever replaced by newer ones is not worth a card.
    const proposals = sessionProposalsByParent(parent.ref)
      .map(parsed)
      .filter((p) => p.dismissReason !== 'evicted')
    if (proposals.length === 0) return messages
    const out = messages.filter((m) => !proposals.some((p) => m.id === proposalCardId(p.id)))
    for (const p of proposals) {
      const card = proposalCardMessage(p)
      const at = out.findIndex((m) => m.timestamp > p.createdAt)
      out.splice(at === -1 ? out.length : at, 0, card)
    }
    return out
  } catch (err) {
    logger.warn(LOG, `could not add proposal cards to ${sessionId}: ${String(err)}`)
    return messages
  }
}

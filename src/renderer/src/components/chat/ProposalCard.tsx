/**
 * A session an agent proposed, in the proposing session's transcript (session
 * tools, slice 1c-b).
 *
 * `ProposalCardView` is presentational. `ProposalCard` is the container: the block
 * carries everything the card shows (the host rewrites it in place on every state
 * change), so the only live inputs are the clock — a pending proposal past its
 * expiry reads as expired without waiting for the host — and, once it has started,
 * the new session's row to open. A pending card offers two starts, "Start in this
 * group" and "Start as standalone work" (the proposal's own relation is the primary
 * one; the click decides), and Dismiss: the same commands on desktop and in the browser. Layout is flex-wrap with 32px-high targets and no viewport
 * units, so it holds at phone width inside the zoom (ADR-093).
 */
import { useEffect, useState } from 'react'
import type { ContentBlock } from '../../../../shared/types'
import {
  proposalDisplayState,
  proposalGrouped,
  type ProposalDisplayState,
  type ProposalPlacement
} from '../../../../shared/session-proposals'
import { useSessionStore } from '../../stores/session-store'
import { findSessionInfo } from '../../lib/session-history-load'
import { idOfRef, openSessionById } from '../../lib/session-links'
import { EngineLogo } from '../shared/EngineLogo'

type ProposalBlock = Extract<ContentBlock, { type: 'proposal_card' }>

const STATE_LABEL: Record<ProposalDisplayState, string> = {
  pending: 'Proposed',
  started: 'Started',
  dismissed: 'Dismissed',
  expired: 'Expired'
}

/** Why a proposal was dismissed, in the user's words. */
export function dismissalText(reason: string | undefined): string {
  if (!reason || reason === 'user') return 'Dismissed'
  if (reason === 'evicted') return 'Replaced by newer proposals'
  if (reason === 'expired') return 'Expired'
  if (reason === 'agent') return 'Withdrawn by the agent'
  if (reason.startsWith('agent: ')) return `Withdrawn by the agent: ${reason.slice(7)}`
  return `Dismissed: ${reason}`
}

/** "in 6 days", "in 5 hours", "in 12 minutes"; "soon" under a minute. */
export function expiryText(expiresAt: number, now: number): string {
  const ms = expiresAt - now
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'Expires soon'
  if (minutes < 60) return `Expires in ${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `Expires in ${hours} h`
  return `Expires in ${Math.ceil(hours / 24)} days`
}

/** A directory compared as the same one whichever slashes it was written with (a Windows desktop session carries backslashes). */
export function sameDirectory(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const slashed = p.replace(/\\/g, '/').replace(/\/+$/, '')
    return /^[A-Za-z]:/.test(slashed) ? slashed.toLowerCase() : slashed
  }
  return norm(a) === norm(b)
}

/**
 * The placement as a line: engine, model, effort, mode — and the directory when it is
 * not the proposer's. A directory outside the proposer's tree is not part of this line:
 * it is the one thing the click consents to, so the card says it separately.
 */
export function placementParts(placement: ProposalPlacement, parentCwd: string): string[] {
  const parts: string[] = [placement.engine]
  if (placement.model) parts.push(`model ${placement.model}`)
  if (placement.effort) parts.push(`effort ${placement.effort}`)
  parts.push(`${placement.permission_mode} mode`)
  if (placement.worktree) parts.push(`new worktree ${placement.worktree}`)
  if (placement.cwd && !placement.outside && !sameDirectory(placement.cwd, parentCwd)) {
    parts.push(placement.cwd)
  }
  return parts
}

export function ProposalCardView({
  proposalId,
  title,
  prompt,
  background,
  placement,
  parentCwd,
  state,
  reason,
  expiresAt,
  now,
  busy,
  startingGrouped,
  error,
  onStart,
  onDismiss,
  onOpen,
  openDisabledReason
}: {
  proposalId: string
  title: string
  prompt: string
  background: string
  placement: ProposalPlacement
  parentCwd: string
  state: ProposalDisplayState
  reason?: string
  expiresAt: number
  now: number
  /** A command is in flight: every button waits. */
  busy?: 'start' | 'dismiss' | null
  /** Which Start is in flight (true: in this group), so only that button says "Starting…". */
  startingGrouped?: boolean | null
  /** What the host said when a click did not work. */
  error?: string | null
  /** `grouped`: true joins the proposing session's group, false is standalone work. */
  onStart?: (grouped: boolean) => void
  onDismiss?: () => void
  /** Opens the session this started; absent when it has not started or has no row. */
  onOpen?: () => void
  openDisabledReason?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const settledLabel = state === 'dismissed' ? dismissalText(reason) : STATE_LABEL[state]
  const groupedPrimary = proposalGrouped(placement.relation)
  const startButtons = [
    { grouped: true, testid: 'ProposalCard.startGrouped', label: 'Start in this group' },
    { grouped: false, testid: 'ProposalCard.startStandalone', label: 'Start as standalone work' }
  ]
    .map((b) => ({ ...b, primary: b.grouped === groupedPrimary }))
    .sort((a, b) => Number(b.primary) - Number(a.primary))
  return (
    <div
      data-testid="ProposalCard"
      data-state={state}
      data-id={proposalId}
      className="rounded-lg border border-border bg-bg-secondary/40 px-3 py-2 animate-fade-in"
    >
      <div
        data-testid="ProposalCard.kind"
        className="text-[11px] text-text-muted flex items-center gap-1.5"
      >
        ✦ Proposed session
      </div>
      <div className="mt-1 flex items-center gap-2 flex-wrap">
        <span className="flex items-center gap-1.5 min-w-0 flex-1 basis-40">
          <EngineLogo engineId={placement.engine} size={11} className="shrink-0 opacity-80" />
          <span
            data-testid="ProposalCard.title"
            title={title}
            className="text-[13px] text-text-primary truncate"
          >
            {title}
          </span>
        </span>
        <span data-testid="ProposalCard.state" className="shrink-0 text-[12px] text-text-secondary">
          {settledLabel}
        </span>
      </div>
      <div
        data-testid="ProposalCard.placement"
        className="mt-1 text-[11px] text-text-muted break-words"
      >
        {placementParts(placement, parentCwd).join(' · ')}
      </div>
      {placement.outside && (
        <div
          data-testid="ProposalCard.outside"
          className="mt-1 text-[12px] text-text-primary break-words"
        >
          Outside the proposing session&apos;s folder: {placement.cwd}
        </div>
      )}
      <button
        type="button"
        data-testid="ProposalCard.toggleDetails"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="mt-1 min-h-8 text-[12px] text-text-secondary hover:text-text-primary cursor-pointer"
      >
        {open ? '▾ Hide brief' : '▸ Show brief'}
      </button>
      {open && (
        <div data-testid="ProposalCard.details" className="mt-1 space-y-2 text-[12px]">
          <div>
            <div className="text-[11px] text-text-muted">Task</div>
            <div
              data-testid="ProposalCard.prompt"
              className="whitespace-pre-wrap break-words text-text-primary"
            >
              {prompt}
            </div>
          </div>
          <div>
            <div className="text-[11px] text-text-muted">Background</div>
            <div
              data-testid="ProposalCard.background"
              className="whitespace-pre-wrap break-words text-text-secondary"
            >
              {background}
            </div>
          </div>
        </div>
      )}
      {state === 'pending' && (
        <div className="mt-1 text-[11px] text-text-muted" data-testid="ProposalCard.expiry">
          {expiryText(expiresAt, now)}
        </div>
      )}
      {error && (
        <div
          role="alert"
          data-testid="ProposalCard.error"
          className="mt-1 text-[12px] text-red-400"
        >
          {error}
        </div>
      )}
      <div className="mt-1 flex items-center gap-2 flex-wrap">
        {state === 'pending' && (
          <>
            {startButtons.map((b) => (
              <button
                key={b.testid}
                type="button"
                data-testid={b.testid}
                data-primary={b.primary}
                disabled={busy != null || !onStart}
                onClick={() => onStart?.(b.grouped)}
                className={
                  b.primary
                    ? 'shrink-0 min-h-8 text-[12px] font-medium rounded-md px-2.5 py-1 bg-accent text-bg-primary hover:bg-accent-hover transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-default disabled:hover:bg-accent'
                    : 'shrink-0 min-h-8 text-[12px] rounded-md px-2.5 py-1 border border-border text-text-secondary hover:text-text-primary transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-default'
                }
              >
                {busy === 'start' && startingGrouped === b.grouped ? 'Starting…' : b.label}
              </button>
            ))}
            <button
              type="button"
              data-testid="ProposalCard.dismiss"
              disabled={busy != null || !onDismiss}
              onClick={onDismiss}
              className="shrink-0 min-h-8 text-[12px] rounded-md px-2.5 py-1 border border-border text-text-secondary hover:text-text-primary transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-default"
            >
              Dismiss
            </button>
          </>
        )}
        {state === 'started' && (onOpen || openDisabledReason) && (
          <button
            type="button"
            data-testid="ProposalCard.open"
            onClick={onOpen}
            disabled={!onOpen}
            title={onOpen ? undefined : openDisabledReason}
            className="shrink-0 min-h-8 text-[12px] font-medium rounded-md px-2.5 py-1 bg-accent text-bg-primary hover:bg-accent-hover transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-default disabled:hover:bg-accent"
          >
            Open
          </button>
        )}
      </div>
    </div>
  )
}

/** The card wired to the two commands, the clock and the started session's row. */
export function ProposalCard({ block }: { block: ProposalBlock }): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState<'start' | 'dismiss' | null>(null)
  const [startingGrouped, setStartingGrouped] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  // A refusal belongs to the state it was about: drop it once the card moves on.
  useEffect(() => setError(null), [block.state])

  // Flip a pending card to expired the moment its time is up, with no host round trip.
  useEffect(() => {
    if (block.state !== 'pending') return
    const wait = block.expiresAt - Date.now()
    if (wait <= 0) return
    const timer = setTimeout(() => setNow(Date.now()), Math.min(wait + 50, 2_000_000_000))
    return () => clearTimeout(timer)
  }, [block.state, block.expiresAt])

  const childId = useSessionStore((s) =>
    block.startedRef ? idOfRef(s.sessionRefs, block.startedRef) : null
  )
  const hasRow = useSessionStore((s) =>
    childId
      ? s.sessions[childId] !== undefined || findSessionInfo(s.directories, childId) !== undefined
      : false
  )
  const state = proposalDisplayState(block, now)

  const run = async (which: 'start' | 'dismiss', grouped = false): Promise<void> => {
    setBusy(which)
    setStartingGrouped(which === 'start' ? grouped : null)
    setError(null)
    try {
      const result =
        which === 'start'
          ? await window.api.startSessionProposal(block.proposalId, grouped)
          : await window.api.dismissSessionProposal(block.proposalId)
      if (!result.success) setError(result.error ?? 'That did not work.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <ProposalCardView
      proposalId={block.proposalId}
      title={block.title}
      prompt={block.prompt}
      background={block.background}
      placement={block.placement}
      parentCwd={block.parentCwd}
      state={state}
      reason={block.reason}
      expiresAt={block.expiresAt}
      now={now}
      busy={busy}
      startingGrouped={startingGrouped}
      error={error}
      onStart={(grouped) => void run('start', grouped)}
      onDismiss={() => void run('dismiss')}
      onOpen={childId && hasRow ? () => void openSessionById(childId) : undefined}
      openDisabledReason={
        block.startedRef && !(childId && hasRow)
          ? 'This session is not in the sidebar, so there is nothing to open'
          : undefined
      }
    />
  )
}

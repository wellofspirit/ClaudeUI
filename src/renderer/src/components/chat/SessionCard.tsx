/**
 * A session started from this one (or handed off to by it): its card in the
 * originating session's transcript (session tools, slice 1b). It stays whether or not
 * the new session is grouped with this one.
 *
 * `SessionCardView` is presentational. `SessionCard` is the container: the block
 * carries only what is fixed (the child's ref, why it exists, the name and engine
 * it was given), so everything that changes — the child's current title, whether
 * it is working, waiting for the user or failed, whether the link still stands —
 * is read from the replicated store. A card therefore stays true without any
 * message being rewritten, on every client alike. Layout is flex-wrap with a
 * 32px-high target and no viewport units, so it holds at phone width inside the
 * zoom (ADR-093).
 */
import { useShallow } from 'zustand/react/shallow'
import type { ContentBlock } from '../../../../shared/types'
import { useSessionStore } from '../../stores/session-store'
import { EngineLogo } from '../shared/EngineLogo'
import { StatusDot, type SessionDotState } from '../Sidebar/StatusDot'
import { findSessionInfo } from '../../lib/session-history-load'
import { idOfRef, openSessionById, sessionTitleOf } from '../../lib/session-links'

type SessionCardBlock = Extract<ContentBlock, { type: 'session_card' }>

export type SessionCardState =
  'starting' | 'working' | 'idle' | 'needs-you' | 'failed' | 'ended' | 'unavailable' | 'unknown'

const STATE_LABEL: Record<SessionCardState, string> = {
  starting: 'Starting',
  working: 'Working',
  idle: 'Idle',
  'needs-you': 'Needs you',
  failed: 'Failed to start',
  ended: 'Ended',
  unavailable: 'Not in the sidebar',
  unknown: 'Not available'
}

const DOT: Record<SessionCardState, SessionDotState> = {
  starting: 'running',
  working: 'running',
  idle: 'idle',
  'needs-you': 'attention',
  failed: 'failed',
  ended: 'inactive',
  unavailable: 'inactive',
  unknown: 'inactive'
}

const KIND_LABEL: Record<SessionCardBlock['kind'], string> = {
  started: 'Started a session',
  handoff: 'Handed off to a new session'
}

export function SessionCardView({
  kind,
  title,
  engineId,
  state,
  childRef,
  onOpen,
  openDisabledReason
}: {
  kind: SessionCardBlock['kind']
  title: string
  /** Stored on the block: may name an engine this build no longer has. */
  engineId: string
  state: SessionCardState
  childRef: string
  /** Absent when there is nothing to open (the link failed, or this transcript is read-only). */
  onOpen?: () => void
  /** Why Open is disabled, when the child is named but cannot be opened (it has no sidebar row). */
  openDisabledReason?: string
}): React.JSX.Element {
  return (
    <div
      data-testid="SessionCard"
      data-state={state}
      data-kind={kind}
      data-id={childRef}
      className="rounded-lg border border-border bg-bg-secondary/40 px-3 py-2 animate-fade-in"
    >
      <div
        data-testid="SessionCard.kind"
        className="text-[11px] text-text-muted flex items-center gap-1.5"
      >
        {kind === 'handoff' ? '→' : '↳'} {KIND_LABEL[kind]}
      </div>
      <div className="mt-1 flex items-center gap-2 flex-wrap">
        <span className="flex items-center gap-1.5 min-w-0 flex-1 basis-40">
          <EngineLogo engineId={engineId} size={11} className="shrink-0 opacity-80" />
          <span
            data-testid="SessionCard.title"
            title={title}
            className="text-[13px] text-text-primary truncate"
          >
            {title}
          </span>
        </span>
        <span
          data-testid="SessionCard.state"
          className="shrink-0 flex items-center gap-1.5 text-[12px] text-text-secondary"
        >
          <StatusDot
            state={DOT[state]}
            runningSubagents={0}
            testid="SessionCard.dot"
            label={STATE_LABEL[state]}
          />
          {STATE_LABEL[state]}
        </span>
        {(onOpen || openDisabledReason) && (
          <button
            type="button"
            data-testid="SessionCard.open"
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

/** The card wired to the replicated link and the child's live session. */
export function SessionCard({ block }: { block: SessionCardBlock }): React.JSX.Element {
  // The title is the sidebar's once the child has one (a name the user gave it, the
  // listing's, or its first words); until then the name the session was started
  // with. So a card can read "Fix the flaky test" while the row still says "New session".
  const { childId, linkState, running, needsYou, title, hasRow } = useSessionStore(
    useShallow((s) => {
      const link = s.sessionLinks[block.childRef]
      const id = idOfRef(s.sessionRefs, block.childRef)
      const session = id ? s.sessions[id] : undefined
      return {
        childId: id,
        linkState: link?.state ?? null,
        running: session?.status.state === 'running',
        needsYou: (session?.pendingApprovals.length ?? 0) > 0,
        title: id ? sessionTitleOf(s, id) : '',
        hasRow: id
          ? session !== undefined || findSessionInfo(s.directories, id) !== undefined
          : false
      }
    })
  )
  let state: SessionCardState
  if (linkState === null) state = 'unknown'
  else if (!hasRow && (linkState === 'live' || linkState === 'starting')) state = 'unavailable'
  else if (linkState === 'live') state = needsYou ? 'needs-you' : running ? 'working' : 'idle'
  else state = linkState
  // Open needs a row to switch to; a failed start has nothing to open at all.
  const canOpen = childId !== null && hasRow && linkState !== 'failed'
  return (
    <SessionCardView
      kind={block.kind}
      title={title || block.title || `Session ${block.childRef}`}
      engineId={block.engineId}
      state={state}
      childRef={block.childRef}
      onOpen={canOpen ? () => void openSessionById(childId) : undefined}
      openDisabledReason={
        !canOpen && linkState !== null && linkState !== 'failed'
          ? 'This session is not in the sidebar, so there is nothing to open'
          : undefined
      }
    />
  )
}

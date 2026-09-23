/**
 * The composer's agent tab and its overlay (ADR-073).
 *
 * Positioned as the exact mirror of the permission-mode tab
 * (`InputBox/View.tsx`, `absolute bottom-full left-3`): opposite corner of the
 * same edge, same type scale, same rounding. That is what lets it cost ZERO
 * layout height — it sits in the gutter the composer already has above it — and
 * why it cannot collide with `Auto ⏵⏵` / `Plan` / `Accept Edits` even at phone
 * width. Nothing is permanently fixed above the input (owner ruling,
 * 2026-09-21).
 *
 * It expands UPWARD into a floating overlay, the way SlashCommandMenu and
 * FileMentionMenu already do, so opening the list never reflows the chat.
 *
 * Unlike the pill, it exists only while something is actually running.
 */
import { useEffect, useRef, useState } from 'react'
import { useActiveSession, useSessionStore } from '../../stores/session-store'
import { useAgentRoster } from '../../hooks/useAgentRoster'
import { formatElapsed } from '../chat/TaskCard'
import { AgentRosterList } from './AgentRosterList'

export function AgentTab(): React.JSX.Element | null {
  const enabled = useSessionStore((s) => s.settings.showAgentTab)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const openedTaskToolUseIds = useActiveSession((s) => s.openedTaskToolUseIds)
  const openTaskPanel = useSessionStore((s) => s.openTaskPanel)
  const roster = useAgentRoster()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  const { runningCount } = roster
  const visible = enabled && runningCount > 0

  // Escape and outside-click close it, like every other composer overlay.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    const onClick = (e: MouseEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('mousedown', onClick)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('mousedown', onClick)
    }
  }, [open])

  // The tab goes away the moment the last agent stops; so must the overlay.
  useEffect(() => {
    if (!visible && open) setOpen(false)
  }, [visible, open])

  if (!visible) return null

  // The longest-running agent's clock — the one number worth the width.
  const longest = roster.agents
    .concat(roster.shells)
    .filter((r) => r.isRunning && r.elapsedSeconds !== undefined)
    .reduce<number | undefined>(
      (max, r) => (max === undefined || r.elapsedSeconds! > max ? r.elapsedSeconds : max),
      undefined
    )

  const handleOpenAgent = (toolUseId: string): void => {
    if (activeSessionId) openTaskPanel(activeSessionId, toolUseId)
    setOpen(false)
  }

  return (
    <div ref={wrapRef} className="contents">
      {open && (
        <div
          data-testid="AgentOverlay"
          className="absolute bottom-full right-0 mb-[18px] w-[min(420px,calc(100vw-32px))] max-h-[260px] overflow-y-auto rounded-lg border border-border bg-bg-secondary shadow-2xl z-50 animate-fade-in"
        >
          <AgentRosterList
            roster={roster}
            selectedIds={openedTaskToolUseIds}
            onOpen={handleOpenAgent}
          />
        </div>
      )}
      <button
        data-testid="AgentTab"
        data-open={open}
        onClick={() => setOpen((o) => !o)}
        title={`${runningCount} agent${runningCount > 1 ? 's' : ''} running — click for the list`}
        className={`absolute bottom-full right-3 px-1.5 pt-0.5 pb-px rounded-t text-[9px] font-semibold tracking-wider uppercase border border-b-0 flex items-center gap-1 cursor-default transition-colors ${
          open
            ? 'border-accent/60 bg-accent/25 text-accent-hover'
            : 'border-accent/40 bg-accent/15 text-accent hover:bg-accent/20'
        }`}
      >
        <span className="relative flex h-1.5 w-1.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-70" />
          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-accent" />
        </span>
        <span data-testid="AgentTab.count">
          {runningCount} agent{runningCount > 1 ? 's' : ''}
        </span>
        {longest !== undefined && <span className="tabular-nums">· {formatElapsed(longest)}</span>}
      </button>
    </div>
  )
}

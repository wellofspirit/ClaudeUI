/**
 * The roster itself (ADR-073): a header that counts, a Running/All filter, and
 * the rows in two sections — agents, and the background shells that get lost to
 * scrolling for exactly the same reason (owner ruling, 2026-09-21).
 *
 * The list opens on Running: in a long session the finished rows are most of
 * it, and they bury the few that still matter. Each section folds, so one busy
 * kind cannot push the other out of reach.
 *
 * The filter and the folds are local component state on purpose. They are a way
 * of looking at the list for a moment, not a preference: persisting them would
 * eventually hide a finished agent from someone who had forgotten they set it.
 */
import { useState } from 'react'
import type { AgentRoster, AgentRosterRow } from '../../hooks/useAgentRoster'
import { AgentRow } from './AgentRow'

type SectionLabel = 'Agents' | 'Background shells'

function Section({
  label,
  rows,
  selectedIds,
  collapsed,
  onToggleCollapsed,
  onOpen
}: {
  label: SectionLabel
  rows: AgentRosterRow[]
  selectedIds: string[]
  collapsed: boolean
  onToggleCollapsed: () => void
  onOpen: (toolUseId: string) => void
}): React.JSX.Element | null {
  if (rows.length === 0) return null
  return (
    <div data-testid={`AgentRoster.section.${label}`} data-collapsed={collapsed}>
      <button
        data-testid={`AgentRoster.section.${label}.toggle`}
        onClick={onToggleCollapsed}
        aria-expanded={!collapsed}
        className="w-full flex items-center gap-1 px-2.5 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wide text-text-muted hover:text-text-secondary cursor-default transition-colors"
      >
        <svg
          width="8"
          height="8"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          className={`shrink-0 transition-transform ${collapsed ? '-rotate-90' : ''}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
        <span>{label}</span>
        <span className="tabular-nums normal-case">{rows.length}</span>
      </button>
      {!collapsed &&
        rows.map((row) => (
          <AgentRow
            key={row.toolUseId}
            row={row}
            selected={selectedIds.includes(row.toolUseId)}
            onOpen={onOpen}
          />
        ))}
    </div>
  )
}

export function AgentRosterList({
  roster,
  selectedIds,
  onOpen,
  emptyHint
}: {
  roster: AgentRoster
  /** Tool_use ids currently open in the panel — highlighted, not exclusive. */
  selectedIds: string[]
  onOpen: (toolUseId: string) => void
  emptyHint?: string
}): React.JSX.Element {
  const [runningOnly, setRunningOnly] = useState(true)
  const [collapsed, setCollapsed] = useState<ReadonlySet<SectionLabel>>(() => new Set())

  const toggleCollapsed = (label: SectionLabel): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })

  // An open row stays listed after it finishes: it is still on screen below,
  // and clicking its row again is how it gets put away.
  const keep = (rows: AgentRosterRow[]): AgentRosterRow[] =>
    runningOnly ? rows.filter((r) => r.isRunning || selectedIds.includes(r.toolUseId)) : rows
  const agents = keep(roster.agents)
  const shells = keep(roster.shells)
  const shown = agents.length + shells.length

  const filterButton = (running: boolean, label: string): React.JSX.Element => {
    const active = runningOnly === running
    return (
      <button
        data-testid={`AgentRoster.filter.${running ? 'running' : 'all'}`}
        onClick={() => setRunningOnly(running)}
        aria-pressed={active}
        className={`px-1.5 py-px cursor-default transition-colors ${
          active ? 'bg-bg-hover text-text-primary' : 'text-text-muted hover:text-text-secondary'
        }`}
      >
        {label}
      </button>
    )
  }

  return (
    <div data-testid="AgentRoster">
      {/* Sticky, so the counts and the filter survive scrolling a long list. */}
      <div className="sticky top-0 z-10 bg-bg-secondary flex items-center gap-2 px-2.5 py-1.5 border-b border-border">
        <span className="text-[11px] text-text-secondary flex-1 min-w-0 truncate">
          {roster.runningCount > 0 && (
            <span className="text-accent">{roster.runningCount} running</span>
          )}
          {roster.runningCount > 0 && ' · '}
          {roster.totalCount} total
        </span>
        <div className="flex items-center rounded-md border border-border overflow-hidden text-[10px] shrink-0">
          {filterButton(true, 'Running')}
          {filterButton(false, 'All')}
        </div>
      </div>

      {shown === 0 ? (
        <div data-testid="AgentRoster.empty" className="px-2.5 py-3 text-[11px] text-text-muted">
          {runningOnly ? (
            <>
              Nothing running right now.
              {roster.totalCount > 0 && (
                <>
                  {' '}
                  <button
                    data-testid="AgentRoster.empty.showAll"
                    onClick={() => setRunningOnly(false)}
                    className="text-accent hover:text-accent-hover cursor-default"
                  >
                    Show all {roster.totalCount}
                  </button>
                </>
              )}
            </>
          ) : (
            (emptyHint ?? 'No agents in this session.')
          )}
        </div>
      ) : (
        <>
          <Section
            label="Agents"
            rows={agents}
            selectedIds={selectedIds}
            collapsed={collapsed.has('Agents')}
            onToggleCollapsed={() => toggleCollapsed('Agents')}
            onOpen={onOpen}
          />
          <Section
            label="Background shells"
            rows={shells}
            selectedIds={selectedIds}
            collapsed={collapsed.has('Background shells')}
            onToggleCollapsed={() => toggleCollapsed('Background shells')}
            onOpen={onOpen}
          />
        </>
      )}
    </div>
  )
}

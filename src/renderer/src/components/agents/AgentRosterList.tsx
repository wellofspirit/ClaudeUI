/**
 * The roster itself (ADR-073): a header that counts, a Running/All filter, and
 * the rows in two sections — agents, and the background shells that get lost to
 * scrolling for exactly the same reason (owner ruling, 2026-09-21).
 *
 * The filter is local component state on purpose. It is a way of looking at the
 * list for a moment, not a preference: persisting it would eventually hide a
 * finished agent from someone who had forgotten they set it.
 */
import { useState } from 'react'
import type { AgentRoster, AgentRosterRow } from '../../hooks/useAgentRoster'
import { AgentRow } from './AgentRow'

function Section({
  label,
  rows,
  selectedIds,
  onOpen
}: {
  label: string
  rows: AgentRosterRow[]
  selectedIds: string[]
  onOpen: (toolUseId: string) => void
}): React.JSX.Element | null {
  if (rows.length === 0) return null
  return (
    <div data-testid={`AgentRoster.section.${label}`}>
      <div className="px-2.5 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wide text-text-muted">
        {label}
      </div>
      {rows.map((row) => (
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
  const [runningOnly, setRunningOnly] = useState(false)

  const keep = (rows: AgentRosterRow[]): AgentRosterRow[] =>
    runningOnly ? rows.filter((r) => r.isRunning) : rows
  const agents = keep(roster.agents)
  const shells = keep(roster.shells)
  const shown = agents.length + shells.length

  return (
    <div data-testid="AgentRoster">
      <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-border">
        <span className="text-[11px] text-text-secondary flex-1 min-w-0 truncate">
          {roster.runningCount > 0 && (
            <span className="text-accent">{roster.runningCount} running</span>
          )}
          {roster.runningCount > 0 && ' · '}
          {roster.totalCount} total
        </span>
        <div className="flex items-center rounded-md border border-border overflow-hidden text-[10px] shrink-0">
          <button
            data-testid="AgentRoster.filter.all"
            onClick={() => setRunningOnly(false)}
            aria-pressed={!runningOnly}
            className={`px-1.5 py-px cursor-default transition-colors ${
              runningOnly
                ? 'text-text-muted hover:text-text-secondary'
                : 'bg-bg-hover text-text-primary'
            }`}
          >
            All
          </button>
          <button
            data-testid="AgentRoster.filter.running"
            onClick={() => setRunningOnly(true)}
            aria-pressed={runningOnly}
            className={`px-1.5 py-px cursor-default transition-colors ${
              runningOnly
                ? 'bg-bg-hover text-text-primary'
                : 'text-text-muted hover:text-text-secondary'
            }`}
          >
            Running
          </button>
        </div>
      </div>

      {shown === 0 ? (
        <div data-testid="AgentRoster.empty" className="px-2.5 py-3 text-[11px] text-text-muted">
          {runningOnly ? 'Nothing running right now.' : (emptyHint ?? 'No agents in this session.')}
        </div>
      ) : (
        <>
          {/* One section only? Then its heading is noise — the roster IS that list. */}
          {agents.length > 0 && shells.length > 0 ? (
            <>
              <Section label="Agents" rows={agents} selectedIds={selectedIds} onOpen={onOpen} />
              <Section
                label="Background shells"
                rows={shells}
                selectedIds={selectedIds}
                onOpen={onOpen}
              />
            </>
          ) : (
            [...agents, ...shells].map((row) => (
              <AgentRow
                key={row.toolUseId}
                row={row}
                selected={selectedIds.includes(row.toolUseId)}
                onOpen={onOpen}
              />
            ))
          )}
        </>
      )}
    </div>
  )
}

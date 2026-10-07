/**
 * The roster itself (ADR-073): a header that counts, a Running/All filter, and
 * ONE tree of rows (§10). Agents and the background shells that get lost to
 * scrolling for exactly the same reason (owner ruling, 2026-09-21) share it: a
 * shell sits under the agent that launched it, and one the main session
 * launched sits at the top level. There are no sections to fold.
 *
 * The list opens on Running: in a long session the finished rows are most of
 * it, and they bury the few that still matter.
 *
 * The filter is local component state on purpose. It is a way of looking at the
 * list for a moment, not a preference: persisting it would eventually hide a
 * finished agent from someone who had forgotten they set it.
 *
 * A nested row sits under the agent that spawned it (ADR-073 §7). Under
 * Running, a finished ancestor of a running (or open) row is kept as dimmed
 * context, so an indented row never floats without its parent; context rows are
 * not counted. This is what keeps a shell reachable after the agent that
 * launched it has finished: the shell is running, so the agent stays. Every
 * listed shell is running or open, so the filter needs no rule of its own for
 * them.
 */
import { useState } from 'react'
import type { AgentRoster, AgentRosterRow } from '../../hooks/useAgentRoster'
import { AgentRow, type RowGuide } from './AgentRow'
import { rosterSummaryParts } from './roster-summary'

interface ListedRow {
  row: AgentRosterRow
  isContext: boolean
  guide?: RowGuide
}

/**
 * The rows the Running filter keeps: running or open ones, plus every ancestor
 * of those, marked as context unless it qualifies on its own.
 */
export function keepRunning(
  rows: readonly AgentRosterRow[],
  selectedIds: readonly string[]
): { row: AgentRosterRow; isContext: boolean }[] {
  const byId = new Map(rows.map((r) => [r.toolUseId, r]))
  const kept = new Set(
    rows.filter((r) => r.isRunning || selectedIds.includes(r.toolUseId)).map((r) => r.toolUseId)
  )
  const context = new Set<string>()
  for (const id of kept) {
    let parent = byId.get(id)?.parentToolUseId
    while (parent && !kept.has(parent) && !context.has(parent)) {
      context.add(parent)
      parent = byId.get(parent)?.parentToolUseId
    }
  }
  return rows
    .filter((r) => kept.has(r.toolUseId) || context.has(r.toolUseId))
    .map((row) => ({ row, isContext: context.has(row.toolUseId) }))
}

/**
 * Tree guides for the rows as listed (depth-first order). A row has a later
 * sibling when the next row at its depth or shallower is at its depth: in a
 * depth-first list anything between them is its own subtree.
 */
function withGuides(listed: { row: AgentRosterRow; isContext: boolean }[]): ListedRow[] {
  const laterSibling = listed.map(({ row }, i) => {
    for (let j = i + 1; j < listed.length; j++) {
      const d = listed[j].row.depth
      if (d <= row.depth) return d === row.depth
    }
    return false
  })
  // hasLaterSibling of the most recent row at each depth: the ancestors of the
  // current row, since the list is depth-first.
  const open: boolean[] = []
  return listed.map((item, i) => {
    const { depth } = item.row
    open[depth] = laterSibling[i]
    if (depth === 0) return item
    return { ...item, guide: { last: !laterSibling[i], through: open.slice(1, depth) } }
  })
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

  // An open row stays listed after it finishes: it is still on screen below,
  // and clicking its row again is how it gets put away.
  const listed = withGuides(
    runningOnly
      ? keepRunning(roster.rows, selectedIds)
      : roster.rows.map((row) => ({ row, isContext: false }))
  )
  const shown = listed.filter((l) => !l.isContext).length
  const summary = rosterSummaryParts(roster)

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
    // A named container: the metrics drop the current tool below 360px of ROSTER
    // width, which is the roster's own width and never the viewport's (§10).
    <div data-testid="AgentRoster" className="@container/roster">
      {/* Sticky, so the counts and the filter survive scrolling a long list. */}
      <div className="sticky top-0 z-10 bg-bg-secondary flex items-center gap-2 px-2.5 py-1.5 border-b border-border">
        <span
          data-testid="AgentRoster.summary"
          className="text-[11px] text-text-secondary flex-1 min-w-0 truncate"
        >
          {summary.running && <span className="text-accent">{summary.running}</span>}
          {summary.running && summary.total && ' · '}
          {summary.total}
          {!summary.running && !summary.total && 'No agents'}
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
        listed.map(({ row, isContext, guide }) => (
          <AgentRow
            key={row.toolUseId}
            row={row}
            selected={selectedIds.includes(row.toolUseId)}
            onOpen={onOpen}
            isContext={isContext}
            guide={guide}
          />
        ))
      )}
    </div>
  )
}

/**
 * The top bar's door to the agent roster (ADR-073).
 *
 * Mirrors `GitChangesPill` deliberately, including the part the tier system
 * cares about: it carries no tier class and has no `⋯` row, because like the
 * changes pill it is a panel's ONLY scroll-independent entry point. A card that
 * has scrolled out of the transcript used to leave the panel unreachable
 * entirely, which is the whole reason this exists.
 *
 * It outlives the work: visible while the session has spawned ANY agent, in a
 * muted form once they have all finished, so the history stays one click away
 * (owner ruling, 2026-09-21). The composer tab is the one that comes and goes.
 *
 * A dot and a bare number (ADR-073 §7, superseding the "N agents" label): the
 * running count (agents at every depth plus running shells) while anything
 * runs, so a lone background shell lights it too; otherwise the session's
 * agent total. The tooltip and `aria-label` say which.
 */
import { useActiveSession, useSessionStore } from '../../stores/session-store'
import { useAgentRoster } from '../../hooks/useAgentRoster'
import { rosterSummary } from './roster-summary'

export function AgentPill(): React.JSX.Element | null {
  const enabled = useSessionStore((s) => s.settings.showAgentPill)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const rightPanel = useActiveSession((s) => s.rightPanel)
  const toggleAgentsPanel = useSessionStore((s) => s.toggleAgentsPanel)
  const roster = useAgentRoster()
  const { runningCount, totalCount } = roster

  if (!enabled || (runningCount === 0 && totalCount === 0)) return null

  const isActive = rightPanel === 'task'
  const running = runningCount > 0
  const summary = rosterSummary(roster)

  return (
    <button
      data-testid="AgentPill"
      data-running={running}
      onClick={() => activeSessionId && toggleAgentsPanel(activeSessionId)}
      title={summary}
      aria-label={summary}
      className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] whitespace-nowrap transition-colors cursor-default border ${
        running
          ? 'border-accent/40 bg-accent/10 text-accent hover:bg-accent/20'
          : isActive
            ? 'border-transparent bg-bg-hover text-text-primary'
            : 'border-transparent text-text-muted hover:text-text-primary hover:bg-bg-hover'
      }`}
    >
      {running ? (
        <span className="relative flex h-1.5 w-1.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-70" />
          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-accent" />
        </span>
      ) : (
        <span className="h-1.5 w-1.5 rounded-full bg-text-muted" />
      )}
      <span data-testid="AgentPill.count" className="tabular-nums">
        {running ? runningCount : totalCount}
      </span>
    </button>
  )
}

import { useEffect } from 'react'
import type { Automation, AutomationRun } from '../../../../../shared/types'
import { formatDuration } from './utils'

export interface AutomationListViewProps {
  className?: string
  automations: Automation[]
  selectedAutomationId: string | null
  selectedRunId: string | null
  runs: Record<string, AutomationRun[] | undefined>
  expandedId: string | null
  onToggleExpand: (id: string) => void
  onCreate: () => void
  onSelect: (id: string) => void
  onSelectRun: (automationId: string, runId: string) => void
  onLoadRuns: (automationId: string) => void
}

export function AutomationListView({
  className,
  automations,
  selectedAutomationId,
  selectedRunId,
  runs,
  expandedId,
  onToggleExpand,
  onCreate,
  onSelect,
  onSelectRun,
  onLoadRuns,
}: AutomationListViewProps): React.JSX.Element {
  return (
    <div className={className}>
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border/20">
        <span className="text-xs font-semibold text-text-muted uppercase tracking-wider">Automations</span>
        <button
          onClick={onCreate}
          className="flex items-center gap-1 text-xs text-text-accent hover:text-text-primary transition-colors px-1.5 py-0.5 rounded hover:bg-bg-hover"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          New
        </button>
      </div>

      <div className="py-1">
        {automations.length === 0 && (
          <div className="px-3 py-8 text-center text-text-muted text-xs">
            No automations yet.
            <br />
            Click <b>+ New</b> to create one.
          </div>
        )}
        {automations.map((auto) => (
          <AutomationListItem
            key={auto.id}
            automation={auto}
            isSelected={auto.id === selectedAutomationId}
            expanded={expandedId === auto.id}
            runs={runs[auto.id]}
            selectedRunId={selectedRunId}
            onSelect={() => onSelect(auto.id)}
            onToggleExpand={() => onToggleExpand(auto.id)}
            onSelectRun={(runId) => onSelectRun(auto.id, runId)}
            onLoadRuns={() => onLoadRuns(auto.id)}
          />
        ))}
      </div>
    </div>
  )
}

function AutomationListItem({
  automation,
  isSelected,
  expanded,
  runs,
  selectedRunId,
  onSelect,
  onToggleExpand,
  onSelectRun,
  onLoadRuns,
}: {
  automation: Automation
  isSelected: boolean
  expanded: boolean
  runs: AutomationRun[] | undefined
  selectedRunId: string | null
  onSelect: () => void
  onToggleExpand: () => void
  onSelectRun: (runId: string) => void
  onLoadRuns: () => void
}): React.JSX.Element {
  // Escape valve: the View triggers a side-effect (onLoadRuns) when the
  // user expands a row. The IPC call itself lives in the FC — the View
  // only signals the trigger — but this is still a behavioral effect in
  // the View. Compare with BackgroundBashOutput: same pattern, same reason
  // (the trigger is bound to local UI state, not FC-owned state).
  useEffect(() => {
    if (expanded && !runs) {
      onLoadRuns()
    }
  }, [expanded, runs, onLoadRuns])

  const statusDot = automation.enabled ? 'bg-green-400' : 'bg-gray-400'
  const lastRunIcon = automation.lastRunStatus === 'success'
    ? '✅'
    : automation.lastRunStatus === 'error'
      ? '❌'
      : null

  return (
    <div>
      <div
        onClick={onSelect}
        className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer transition-colors text-sm ${
          isSelected ? 'bg-bg-hover text-text-primary' : 'text-text-secondary hover:bg-bg-hover/50'
        }`}
      >
        <button
          onClick={(e) => { e.stopPropagation(); onToggleExpand() }}
          className="p-0.5 hover:bg-bg-hover rounded shrink-0"
        >
          <svg
            width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
            className={`transition-transform ${expanded ? 'rotate-90' : ''}`}
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
        <div className={`w-2 h-2 rounded-full shrink-0 ${statusDot}`} />
        <span className="truncate flex-1 text-[13px]">{automation.name}</span>
        {lastRunIcon && <span className="text-xs shrink-0">{lastRunIcon}</span>}
      </div>

      {expanded && (
        <div className="ml-7 border-l border-border/20">
          {!runs || runs.length === 0 ? (
            <div className="px-3 py-2 text-xs text-text-muted">No runs yet</div>
          ) : (
            runs.slice(0, 20).map((run) => (
              <RunHistoryItem
                key={run.id}
                run={run}
                selected={selectedRunId === run.id}
                onClick={() => onSelectRun(run.id)}
              />
            ))
          )}
        </div>
      )}
    </div>
  )
}

function RunHistoryItem({
  run,
  selected,
  onClick
}: {
  run: AutomationRun
  selected: boolean
  onClick: () => void
}): React.JSX.Element {
  const statusIcon = run.status === 'success' ? '✅'
    : run.status === 'error' ? '❌'
    : '🔄'

  const time = new Date(run.startedAt).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })

  const duration = run.finishedAt
    ? formatDuration(run.finishedAt - run.startedAt)
    : 'running'

  const cost = run.totalCostUsd > 0
    ? `$${run.totalCostUsd.toFixed(4)}`
    : null

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-1.5 transition-colors ${
        selected ? 'bg-bg-hover text-text-primary' : 'text-text-muted hover:bg-bg-hover/50 hover:text-text-secondary'
      }`}
    >
      <span className="shrink-0">{statusIcon}</span>
      <span className="shrink-0">{time}</span>
      <span className="shrink-0 text-text-muted/60">{duration}</span>
      {cost && <span className="shrink-0 text-text-muted/60">{cost}</span>}
    </button>
  )
}

import type { Automation, AutomationRun } from '../../../../../shared/types'
import {
  computeNextRuns,
  formatScheduleHint,
  formatTimeDelta,
} from '../AutomationConfig/utils'

export interface AutomationListViewProps {
  className?: string
  automations: Automation[]
  selectedAutomationId: string | null
  runs: Record<string, AutomationRun[] | undefined>
  onCreate: () => void
  onSelect: (id: string) => void
}

export function AutomationListView({
  className,
  automations,
  selectedAutomationId,
  runs,
  onCreate,
  onSelect,
}: AutomationListViewProps): React.JSX.Element {
  const active = automations.filter((a) => a.enabled)
  const paused = automations.filter((a) => !a.enabled)

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

      <div className="py-2">
        {automations.length === 0 && (
          <div className="px-3 py-8 text-center text-text-muted text-xs">
            No automations yet.
            <br />
            Click <b>+ New</b> to create one.
          </div>
        )}

        {active.length > 0 && (
          <Group title={`Active · ${active.length}`}>
            {active.map((a) => (
              <ListItem
                key={a.id}
                automation={a}
                runs={runs[a.id]}
                isSelected={a.id === selectedAutomationId}
                onSelect={() => onSelect(a.id)}
              />
            ))}
          </Group>
        )}

        {paused.length > 0 && (
          <Group title={`Paused · ${paused.length}`}>
            {paused.map((a) => (
              <ListItem
                key={a.id}
                automation={a}
                runs={runs[a.id]}
                isSelected={a.id === selectedAutomationId}
                onSelect={() => onSelect(a.id)}
              />
            ))}
          </Group>
        )}
      </div>
    </div>
  )
}

function Group({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="mb-3 last:mb-0">
      <div className="px-3 py-1 text-[10px] font-semibold text-text-muted uppercase tracking-wider">{title}</div>
      {children}
    </div>
  )
}

function ListItem({
  automation,
  runs,
  isSelected,
  onSelect,
}: {
  automation: Automation
  runs: AutomationRun[] | undefined
  isSelected: boolean
  onSelect: () => void
}): React.JSX.Element {
  const dot = automation.enabled
    ? automation.lastRunStatus === 'error'
      ? 'bg-red-400'
      : 'bg-green-400'
    : 'bg-gray-500'
  const scheduleHint = formatScheduleHint(automation.schedule)
  const nextRun = computeNextRuns(automation.schedule, automation.lastRunAt, 1)[0]
  const nextIn = nextRun ? formatTimeDelta(nextRun.getTime() - Date.now()) : null

  const recent = (runs ?? []).slice(0, 12)
  const totalCost = (runs ?? []).reduce((sum, r) => sum + (r.totalCostUsd || 0), 0)
  const runCount = runs?.length ?? 0

  return (
    <button
      onClick={onSelect}
      className={`w-full text-left flex items-start gap-2.5 px-3 py-2 rounded-md border transition-colors ${
        isSelected
          ? 'bg-bg-hover/60 border-text-accent/30'
          : 'border-transparent text-text-secondary hover:bg-bg-hover/40'
      }`}
    >
      <span className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium truncate text-text-primary">{automation.name}</div>
        <div className="text-[11px] text-text-muted font-mono truncate">
          {scheduleHint}
          {nextIn && <> · {automation.enabled ? 'next in ' : 'in '}{nextIn}</>}
        </div>
        {recent.length > 0 && (
          <div className="flex items-center gap-2 mt-2">
            <Sparkline runs={recent} />
            <span className="text-[11px] text-text-muted">
              {runCount} run{runCount === 1 ? '' : 's'}
              {totalCost > 0 && <> · ${totalCost.toFixed(2)}</>}
            </span>
          </div>
        )}
      </div>
    </button>
  )
}

function Sparkline({ runs }: { runs: AutomationRun[] }): React.JSX.Element {
  // Most recent on the right: reverse the newest-first slice.
  const ordered = [...runs].reverse()
  const durations = ordered.map((r) => (r.finishedAt ?? Date.now()) - r.startedAt)
  const maxDur = Math.max(...durations, 1)

  return (
    <div className="flex items-end gap-[2px] h-3.5" aria-hidden>
      {ordered.map((r, i) => {
        const color =
          r.status === 'success' ? 'bg-green-400'
          : r.status === 'error' ? 'bg-red-400'
          : 'bg-blue-400'
        const h = 4 + Math.round(10 * (durations[i] / maxDur))
        return (
          <span
            key={r.id}
            className={`w-[3px] rounded-sm ${color}`}
            style={{ height: `${h}px` }}
          />
        )
      })}
    </div>
  )
}


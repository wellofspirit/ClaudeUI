import { useState, useEffect } from 'react'
import { v4 as uuid } from 'uuid'
import { useAutomationStore } from '../../stores/automation-store'
import type { Automation, AutomationRun } from '../../../../shared/types'

interface AutomationListProps {
  className?: string
}

export function AutomationList({ className }: AutomationListProps): React.JSX.Element {
  const automations = useAutomationStore((s) => s.automations)
  const selectedAutomationId = useAutomationStore((s) => s.selectedAutomationId)
  const selectAutomation = useAutomationStore((s) => s.selectAutomation)

  const handleCreate = (): void => {
    const newAutomation: Automation = {
      id: uuid(),
      name: 'New Automation',
      prompt: '',
      cwd: '',
      schedule: { type: 'interval', intervalMs: 3600000 },
      permissions: { allow: [], deny: [] },
      enabled: false,
      lastRunAt: null,
      lastRunStatus: null,
      createdAt: Date.now()
    }
    window.api.saveAutomation(newAutomation)
    selectAutomation(newAutomation.id)
  }

  return (
    <div className={className}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border/20">
        <span className="text-xs font-semibold text-text-muted uppercase tracking-wider">Automations</span>
        <button
          onClick={handleCreate}
          className="flex items-center gap-1 text-xs text-text-accent hover:text-text-primary transition-colors px-1.5 py-0.5 rounded hover:bg-bg-hover"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          New
        </button>
      </div>

      {/* List */}
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
            onSelect={() => selectAutomation(auto.id)}
          />
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// AutomationListItem
// ---------------------------------------------------------------------------

function AutomationListItem({
  automation,
  isSelected,
  onSelect
}: {
  automation: Automation
  isSelected: boolean
  onSelect: () => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const runs = useAutomationStore((s) => s.runs[automation.id])
  const selectRun = useAutomationStore((s) => s.selectRun)

  // Load runs when expanded
  useEffect(() => {
    if (expanded && !runs) {
      window.api.listAutomationRuns(automation.id).then((r) => {
        useAutomationStore.getState().setRuns(automation.id, r)
      })
    }
  }, [expanded, automation.id, runs])

  const statusDot = automation.enabled
    ? 'bg-green-400'
    : 'bg-gray-400'

  const lastRunIcon = automation.lastRunStatus === 'success'
    ? '✅'
    : automation.lastRunStatus === 'error'
      ? '❌'
      : null

  return (
    <div>
      {/* Main item */}
      <div
        onClick={onSelect}
        className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer transition-colors text-sm ${
          isSelected ? 'bg-bg-hover text-text-primary' : 'text-text-secondary hover:bg-bg-hover/50'
        }`}
      >
        {/* Expand arrow */}
        <button
          onClick={(e) => { e.stopPropagation(); setExpanded(!expanded) }}
          className="p-0.5 hover:bg-bg-hover rounded shrink-0"
        >
          <svg
            width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
            className={`transition-transform ${expanded ? 'rotate-90' : ''}`}
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>

        {/* Status dot */}
        <div className={`w-2 h-2 rounded-full shrink-0 ${statusDot}`} />

        {/* Name */}
        <span className="truncate flex-1 text-[13px]">{automation.name}</span>

        {/* Last run status */}
        {lastRunIcon && <span className="text-xs shrink-0">{lastRunIcon}</span>}
      </div>

      {/* Expanded run history */}
      {expanded && (
        <div className="ml-7 border-l border-border/20">
          {!runs || runs.length === 0 ? (
            <div className="px-3 py-2 text-xs text-text-muted">No runs yet</div>
          ) : (
            runs.slice(0, 20).map((run) => (
              <RunHistoryItem
                key={run.id}
                run={run}
                automationId={automation.id}
                onClick={() => selectRun(automation.id, run.id)}
              />
            ))
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// RunHistoryItem
// ---------------------------------------------------------------------------

function RunHistoryItem({
  run,
  onClick
}: {
  run: AutomationRun
  automationId: string
  onClick: () => void
}): React.JSX.Element {
  const selectedRunId = useAutomationStore((s) => s.selectedRunId)
  const isSelected = selectedRunId === run.id

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
        isSelected ? 'bg-bg-hover text-text-primary' : 'text-text-muted hover:bg-bg-hover/50 hover:text-text-secondary'
      }`}
    >
      <span className="shrink-0">{statusIcon}</span>
      <span className="shrink-0">{time}</span>
      <span className="shrink-0 text-text-muted/60">{duration}</span>
      {cost && <span className="shrink-0 text-text-muted/60">{cost}</span>}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSec = seconds % 60
  if (minutes < 60) return `${minutes}m${remainingSec > 0 ? ` ${remainingSec}s` : ''}`
  const hours = Math.floor(minutes / 60)
  const remainingMin = minutes % 60
  return `${hours}h${remainingMin > 0 ? ` ${remainingMin}m` : ''}`
}

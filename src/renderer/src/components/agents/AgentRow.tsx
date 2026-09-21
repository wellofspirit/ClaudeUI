/**
 * One line of the agent roster (ADR-073), shared by the panel's list and the
 * composer tab's overlay so the two can never disagree about what a row says.
 *
 * Deliberately has no notion of "unread": running and not-running is the whole
 * state model (owner ruling, 2026-09-21).
 */
import { useSessionStore, useActiveSession } from '../../stores/session-store'
import { formatElapsed, formatTokens } from '../chat/TaskCard'
import type { AgentRosterRow } from '../../hooks/useAgentRoster'

function StatusDot({ row }: { row: AgentRosterRow }): React.JSX.Element {
  if (row.isRunning) {
    return (
      <span
        data-testid="AgentRow.status"
        data-status="running"
        className="relative flex h-2 w-2 shrink-0"
      >
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-60" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-accent" />
      </span>
    )
  }
  return (
    <span
      data-testid="AgentRow.status"
      data-status={row.isError ? 'failed' : 'done'}
      className={`h-2 w-2 rounded-full shrink-0 ${row.isError ? 'bg-danger' : 'bg-success'}`}
    />
  )
}

export function AgentRow({
  row,
  selected,
  onOpen
}: {
  row: AgentRosterRow
  selected: boolean
  onOpen: (toolUseId: string) => void
}): React.JSX.Element {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const stoppingTaskIds = useActiveSession((s) => s.stoppingTaskIds)
  const setTaskStopping = useSessionStore((s) => s.setTaskStopping)
  const clearTaskStopping = useSessionStore((s) => s.clearTaskStopping)

  const isStopping = stoppingTaskIds.includes(row.toolUseId)

  const handleStop = async (e: React.MouseEvent): Promise<void> => {
    // The row itself opens the transcript; the button must not do both.
    e.stopPropagation()
    const rid = activeSessionId
    if (!rid || isStopping) return
    setTaskStopping(rid, row.toolUseId)
    const result = await window.api.stopTask(rid, row.toolUseId)
    if (!result.success) {
      window.api.logError('AgentRow', `Failed to stop task: ${result.error}`)
      clearTaskStopping(rid, row.toolUseId)
      return
    }
    setTimeout(() => clearTaskStopping(rid, row.toolUseId), 10000)
  }

  // Trailing metrics, most specific first. Elapsed is the only one every engine
  // can supply; tokens and the current tool are Claude's task_progress.
  const metrics = [
    row.lastToolName,
    row.elapsedSeconds !== undefined ? formatElapsed(row.elapsedSeconds) : undefined,
    row.usage?.totalTokens ? formatTokens(row.usage.totalTokens) : undefined
  ].filter(Boolean)

  return (
    <div
      data-testid="AgentRow"
      data-tool-use-id={row.toolUseId}
      data-running={row.isRunning}
      onClick={() => onOpen(row.toolUseId)}
      className={`flex items-center gap-2 px-2.5 py-1.5 cursor-default border-l-2 transition-colors ${
        selected ? 'bg-bg-input border-accent' : 'border-transparent hover:bg-bg-hover'
      } ${!row.isRunning && row.isError ? 'opacity-80' : ''}`}
    >
      <StatusDot row={row} />
      <span className="text-[12px] text-text-primary shrink-0 max-w-[140px] truncate">
        {row.name}
      </span>
      {row.badge && (
        <span className="text-[10px] font-mono px-1 py-px rounded bg-bg-tertiary text-text-secondary border border-border shrink-0">
          {row.badge}
        </span>
      )}
      {row.runIndex > 1 && (
        <span
          data-testid="AgentRow.resumed"
          className="text-[10px] font-mono px-1 py-px rounded bg-accent/10 text-accent border border-accent/25 shrink-0"
          title="This agent was sent a message after it finished, and ran again"
        >
          resumed ×{row.runIndex - 1}
        </span>
      )}
      <span className="text-[11px] text-text-secondary truncate flex-1 min-w-0">
        {row.description}
      </span>
      {metrics.length > 0 && (
        <span className="text-[10px] font-mono text-text-muted shrink-0 whitespace-nowrap">
          {metrics.join(' · ')}
        </span>
      )}
      {row.isRunning && (
        <button
          data-testid="AgentRow.stop"
          onClick={handleStop}
          disabled={isStopping}
          className="text-[10px] px-1.5 py-px rounded border border-border-bright text-text-muted hover:text-danger hover:border-danger transition-colors cursor-default shrink-0 disabled:opacity-50"
        >
          {isStopping ? 'Stopping' : 'Stop'}
        </button>
      )}
    </div>
  )
}

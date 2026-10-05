/**
 * One line of the agent roster (ADR-073), shared by the panel's list and the
 * composer tab's overlay so the two can never disagree about what a row says.
 *
 * Deliberately has no notion of "unread": running and not-running is the whole
 * state model (owner ruling, 2026-09-21).
 *
 * A nested agent is indented 14px per level under the agent that spawned it,
 * with a file-tree guide (ADR-073 §7). A context row is a finished ancestor
 * the Running filter keeps so a running row never floats without its parent:
 * dimmed, no Stop, still opens on click.
 *
 * One DOM, two shapes (ADR-073 §9), chosen by the roster's own width
 * (`@container/roster` in AgentRosterList) and never by the viewport. Wide, the
 * row is a single line in the order dot · name · badge · resumed · description ·
 * metrics · Stop, and it must never overflow: Stop and the metrics keep their
 * size, the description gives way first (down to a floor), then the badge, then
 * the name. Narrow (< 480px), the same elements regroup into two lines:
 * name · resumed · metrics over badge · description, with Stop centred at the
 * right. There the name keeps a floor and the metrics shorten before it does,
 * the badge stays whole and the description gives way, and under 400px the
 * metrics also leave out the current tool. Both shapes come from CSS alone; the
 * wide order is carried by `order-*`, which is also what puts each element on
 * its own narrow line in the right place.
 */
import { useEffect, useRef } from 'react'
import { useSessionStore, useActiveSession } from '../../stores/session-store'
import { formatElapsed, formatTokens } from '../chat/TaskCard'
import type { AgentRosterRow } from '../../hooks/useAgentRoster'

/** Indent per nesting level, on top of the row's own 10px (`px-2.5`). */
const INDENT_PX = 14
/**
 * A narrow roster's line: the wrapper is `display: contents` (its children sit
 * straight in the row's flex line) until the roster is narrower than 480px, then
 * a flex line of its own. Whole class names: Tailwind reads source text.
 */
const LINE =
  'contents @max-[480px]/roster:flex @max-[480px]/roster:items-center @max-[480px]/roster:gap-1.5 @max-[480px]/roster:min-w-0'

/** The x of a level's guide: the dot column of the row one level up. */
const guideLeft = (level: number): number => 13 + INDENT_PX * (level - 1)

/**
 * Where a nested row's tree guide runs. `last`: this row is its parent's last
 * listed child, so its elbow ends here. `through[k]`: the ancestor at depth
 * k + 1 has a later sibling, so that level's line passes this row.
 */
export interface RowGuide {
  last: boolean
  through: boolean[]
}

function TreeGuide({ depth, guide }: { depth: number; guide: RowGuide }): React.JSX.Element {
  return (
    <>
      {guide.through.map((continues, k) =>
        continues && k + 1 < depth ? (
          <span
            key={k}
            aria-hidden
            className="absolute top-0 bottom-0 border-l border-border-bright"
            style={{ left: guideLeft(k + 1) }}
          />
        ) : null
      )}
      <span
        aria-hidden
        data-testid="AgentRow.elbow"
        className="absolute top-0 h-1/2 w-2 border-l border-b border-border-bright rounded-bl"
        style={{ left: guideLeft(depth) }}
      />
      {!guide.last && (
        <span
          aria-hidden
          className="absolute top-1/2 bottom-0 border-l border-border-bright"
          style={{ left: guideLeft(depth) }}
        />
      )}
    </>
  )
}

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
  const [status, color] = row.isError
    ? ['failed', 'bg-danger']
    : row.isStopped
      ? ['stopped', 'bg-warning']
      : row.isLoaded
        ? ['loaded', 'bg-text-muted']
        : ['done', 'bg-success']
  return (
    <span
      data-testid="AgentRow.status"
      data-status={status}
      className={`h-2 w-2 rounded-full shrink-0 ${color}`}
    />
  )
}

export function AgentRow({
  row,
  selected,
  onOpen,
  isContext = false,
  guide
}: {
  row: AgentRosterRow
  selected: boolean
  onOpen: (toolUseId: string) => void
  /** A finished ancestor kept by the Running filter as the path to a running row. */
  isContext?: boolean
  /** The tree guide for a nested row; computed by the list, which sees the siblings. */
  guide?: RowGuide
}): React.JSX.Element {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const stoppingTaskIds = useActiveSession((s) => s.stoppingTaskIds)
  // A nested row may run by the legacy heuristic alone (an engine with no
  // lifecycle events). Stop needs a lifecycle record to target: without one,
  // Claude's stopTask falls back to interrupting the MAIN turn (ADR-073 §7).
  const hasLifecycle = useActiveSession((s) => !!s.activeTasks[row.toolUseId])
  const setTaskStopping = useSessionStore((s) => s.setTaskStopping)
  const clearTaskStopping = useSessionStore((s) => s.clearTaskStopping)

  const isStopping = stoppingTaskIds.includes(row.toolUseId)

  // Opening an entry caps the panel roster at 40%, which can leave the row
  // just clicked below the fold. Keep it in view, but only when it BECOMES
  // selected — a row that mounts selected is where the user already left it.
  const rowRef = useRef<HTMLDivElement>(null)
  const wasSelected = useRef(selected)
  useEffect(() => {
    if (selected && !wasSelected.current) rowRef.current?.scrollIntoView?.({ block: 'nearest' })
    wasSelected.current = selected
  }, [selected])

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
  // can supply; tokens and the current tool are Claude's task_progress. The tool
  // is rendered on its own so a very narrow roster can drop it.
  const figures = [
    row.elapsedSeconds !== undefined ? formatElapsed(row.elapsedSeconds) : undefined,
    row.usage?.totalTokens ? formatTokens(row.usage.totalTokens) : undefined
  ].filter(Boolean)
  const hasMetrics = !!row.lastToolName || figures.length > 0

  return (
    <div
      ref={rowRef}
      data-testid="AgentRow"
      data-tool-use-id={row.toolUseId}
      data-running={row.isRunning}
      data-depth={row.depth}
      {...(isContext ? { 'data-context': 'true' } : {})}
      title={isContext ? 'Shown as the path to a running agent' : undefined}
      onClick={() => onOpen(row.toolUseId)}
      style={row.depth > 0 ? { paddingLeft: 10 + INDENT_PX * row.depth } : undefined}
      className={`relative flex items-center gap-2 px-2.5 py-1.5 cursor-default border-l-2 transition-colors ${
        selected ? 'bg-bg-input border-accent' : 'border-transparent hover:bg-bg-hover'
      } ${isContext ? 'opacity-55' : !row.isRunning && row.isError ? 'opacity-80' : ''}`}
    >
      {row.depth > 0 && guide && <TreeGuide depth={row.depth} guide={guide} />}
      <StatusDot row={row} />
      <div className="contents @max-[480px]/roster:flex @max-[480px]/roster:flex-col @max-[480px]/roster:flex-1 @max-[480px]/roster:min-w-0 @max-[480px]/roster:gap-0.5">
        <div className={LINE}>
          <span
            data-testid="AgentRow.name"
            className="order-1 text-[12px] text-text-primary min-w-0 max-w-[140px] @max-[480px]/roster:max-w-none @max-[480px]/roster:min-w-[4.5rem] truncate"
          >
            {row.name}
          </span>
          {row.runIndex > 1 && (
            <span
              data-testid="AgentRow.resumed"
              className="order-3 text-[10px] font-mono px-1 py-px rounded bg-accent/10 text-accent border border-accent/25 shrink-0 whitespace-nowrap"
              title="This agent was sent a message after it finished, and ran again"
            >
              <span className="@max-[480px]/roster:hidden">resumed ×{row.runIndex - 1}</span>
              <span className="hidden @max-[480px]/roster:inline">↻{row.runIndex - 1}</span>
            </span>
          )}
          {hasMetrics && (
            <span
              data-testid="AgentRow.metrics"
              className="order-5 text-[10px] font-mono text-text-muted shrink-0 whitespace-nowrap @max-[480px]/roster:ml-auto @max-[480px]/roster:min-w-[3rem] @max-[480px]/roster:shrink-[10000] @max-[480px]/roster:truncate"
            >
              {row.lastToolName && (
                <span data-testid="AgentRow.metrics.tool" className="@max-[400px]/roster:hidden">
                  {row.lastToolName}
                  {figures.length > 0 ? ' · ' : ''}
                </span>
              )}
              {figures.join(' · ')}
            </span>
          )}
        </div>
        {(row.badge || row.description) && (
          <div className={LINE}>
            {row.badge && (
              <span
                data-testid="AgentRow.badge"
                className="order-2 text-[10px] font-mono px-1 py-px rounded bg-bg-tertiary text-text-secondary border border-border min-w-0 shrink-[10] truncate @max-[480px]/roster:shrink-0"
              >
                {row.badge}
              </span>
            )}
            <span
              data-testid="AgentRow.description"
              className="order-4 text-[11px] text-text-secondary truncate grow shrink-[10000] min-w-[3rem]"
            >
              {row.description}
            </span>
          </div>
        )}
      </div>
      {row.isRunning && !isContext && (row.depth === 0 || hasLifecycle) && (
        <button
          data-testid="AgentRow.stop"
          onClick={handleStop}
          disabled={isStopping}
          className="order-6 text-[10px] px-1.5 py-px @max-[480px]/roster:px-2 @max-[480px]/roster:py-1 rounded border border-border-bright text-text-muted hover:text-danger hover:border-danger transition-colors cursor-default shrink-0 disabled:opacity-50"
        >
          {isStopping ? 'Stopping' : 'Stop'}
        </button>
      )}
    </div>
  )
}

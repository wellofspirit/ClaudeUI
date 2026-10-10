/**
 * One line of the agent roster (ADR-073), shared by the panel's list and the
 * composer tab's overlay so the two can never disagree about what a row says.
 *
 * Deliberately has no notion of "unread": running and not-running is the whole
 * state model (owner ruling, 2026-09-21).
 *
 * A nested row is indented 14px per level under the agent that spawned it (a
 * shell: the agent that launched it), with a file-tree guide (ADR-073 §7). A
 * context row is a finished ancestor the Running filter keeps so a running row
 * never floats without its parent: dimmed, no Stop, still opens on click.
 *
 * One line at every width (§10). Left to right: guide · status dot · type
 * column · label · resumed chip · spacer · Stop (running only) · metrics. The
 * row has no description line: it was a static summary written at spawn time,
 * and it lives in the label's tooltip. The type is a 16px letter tile (ADR-094),
 * not a text badge, so it costs 16px of the line where the badge cost 60-140px,
 * and that is what made one line possible in the 420px overlay. The column is
 * 16px on every row (a default-type agent leaves it empty, a shell has a `$`) so
 * the labels line up. Stop sits inline BEFORE the metrics rather than in a
 * reserved column, so finished rows lose no width and the metrics end at the
 * same x on every row. Nothing on the line is taller than its 16px line height
 * (`leading-4`; Stop and the resumed chip are trimmed to fit), so a running row is
 * no taller than a finished one.
 *
 * When the line is too narrow, the stop button, dot, type column and resumed
 * chip never shrink; the metrics give way first (down to a 3rem floor), the
 * label last (down to 4.5rem, or 3rem under 300px of roster width, where a
 * deep row with a resumed chip and Stop does not fit otherwise). Below 360px of
 * roster width, which is the roster's own width and never the viewport's, the
 * metrics also drop the current tool. All of it is CSS: no JS measures anything.
 */
import { useEffect, useRef } from 'react'
import { useSessionStore, useActiveSession } from '../../stores/session-store'
import { formatElapsed, formatTokens, taskElapsedLabel, useTicker } from '../chat/TaskCard'
import { AgentTile, useAgentTile } from './AgentTypeTile'
import { agentRowLabel, type AgentRosterRow } from '../../hooks/useAgentRoster'

/** Indent per nesting level, on top of the row's own 10px (`px-2.5`). */
const INDENT_PX = 14
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
  const engineId = useActiveSession((s) => s.status.engineId)
  const tile = useAgentTile(engineId, row.type, row.dispatch)

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

  // A running shell's clock is live, counted from its lifecycle record's start:
  // nothing else ticks for a shell. Only that row opts into the interval.
  const liveClock = row.kind === 'shell' && row.isRunning && row.startedAt !== undefined
  const now = useTicker(liveClock)

  // Trailing metrics, most specific first. Elapsed is the only one every engine
  // can supply; tokens and the current tool are Claude's task_progress. The tool
  // is rendered on its own so a narrow roster can drop it.
  const elapsed = liveClock
    ? taskElapsedLabel({ isRunning: true, startedAt: row.startedAt, now })
    : row.elapsedSeconds !== undefined
      ? formatElapsed(row.elapsedSeconds)
      : undefined
  const figures = [
    elapsed,
    row.usage?.totalTokens ? formatTokens(row.usage.totalTokens) : undefined
  ].filter(Boolean)
  const hasMetrics = !!row.lastToolName || figures.length > 0

  const isShell = row.kind === 'shell'

  return (
    <div
      ref={rowRef}
      data-testid="AgentRow"
      data-kind={row.kind}
      data-tool-use-id={row.toolUseId}
      data-running={row.isRunning}
      data-depth={row.depth}
      {...(isContext ? { 'data-context': 'true' } : {})}
      title={isContext ? 'Shown as the path to something running' : undefined}
      onClick={() => onOpen(row.toolUseId)}
      style={row.depth > 0 ? { paddingLeft: 10 + INDENT_PX * row.depth } : undefined}
      className={`relative flex items-center gap-1.5 px-2.5 py-1 leading-4 cursor-default border-l-2 transition-colors ${
        selected ? 'bg-bg-input border-accent' : 'border-transparent hover:bg-bg-hover'
      } ${isContext ? 'opacity-55' : !row.isRunning && row.isError ? 'opacity-80' : ''}`}
    >
      {row.depth > 0 && guide && <TreeGuide depth={row.depth} guide={guide} />}
      <StatusDot row={row} />
      {isShell ? (
        <span
          data-testid="AgentRow.shellGlyph"
          title="Background shell"
          className="inline-flex items-center justify-center h-4 w-4 shrink-0 rounded border border-border font-mono text-[10px] leading-none font-bold text-text-muted select-none"
        >
          $
        </span>
      ) : tile ? (
        <AgentTile
          testId="AgentRow.typeTile"
          letter={tile.letter}
          colorId={tile.colorId}
          title={tile.title}
        />
      ) : (
        <span aria-hidden className="h-4 w-4 shrink-0" />
      )}
      <span
        data-testid="AgentRow.name"
        title={row.description || undefined}
        className={`min-w-[4.5rem] @max-[300px]/roster:min-w-[3rem] grow-0 shrink basis-auto truncate ${
          isShell
            ? 'font-mono text-[11px] text-text-secondary'
            : row.hasExplicitName
              ? 'text-[12px] text-text-primary'
              : 'text-[12px] text-text-secondary'
        }`}
      >
        {agentRowLabel(row)}
      </span>
      {row.runIndex > 1 && (
        <span
          data-testid="AgentRow.resumed"
          className="text-[10px] leading-3 font-mono px-1 py-px rounded bg-accent/10 text-accent border border-accent/25 shrink-0 whitespace-nowrap"
          title="This agent was sent a message after it finished, and ran again"
        >
          ↻{row.runIndex - 1}
        </span>
      )}
      <span aria-hidden className="grow shrink basis-0 min-w-0" />
      {row.isRunning && !isContext && (row.depth === 0 || hasLifecycle) && (
        <button
          data-testid="AgentRow.stop"
          onClick={handleStop}
          disabled={isStopping}
          className="text-[11px] px-2 py-px leading-[14px] rounded bg-danger/10 text-danger hover:bg-danger/20 transition-colors cursor-default shrink-0 disabled:opacity-50"
        >
          {isStopping ? 'Stopping' : 'Stop'}
        </button>
      )}
      {hasMetrics && (
        <span
          data-testid="AgentRow.metrics"
          className="text-[10px] font-mono text-text-muted text-right whitespace-nowrap grow-0 shrink-[10000] basis-auto min-w-[3rem] truncate"
        >
          {row.lastToolName && (
            <span data-testid="AgentRow.metrics.tool" className="@max-[360px]/roster:hidden">
              {row.lastToolName}
              {figures.length > 0 ? ' · ' : ''}
            </span>
          )}
          {figures.join(' · ')}
        </span>
      )}
    </div>
  )
}

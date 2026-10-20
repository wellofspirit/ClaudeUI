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
 * never floats without its parent: no Stop, still opens on click. No row is dimmed
 * for being finished or for being context: only the dot says how a row stands.
 *
 * One line at every width (§10). Left to right: guide · status dot · type
 * column · label · resumed chip · spacer · Stop (running only) · metrics. The
 * row has no description line: it was a static summary written at spawn time,
 * and it lives in the label's tooltip. The type is a 16px-high tile (ADR-094),
 * not a text badge, so it costs 36px of the line where the badge cost 60-140px,
 * and that is what made one line possible in the 420px overlay. Every agent has a
 * tile (the bot, and the type's letters after it; a default or untyped agent is
 * the bot alone), so the column is a fixed 36px slot, wide enough for the bot and
 * two letters, with the tile (or a shell's `$`) left-aligned in it: the labels
 * line up whatever the row shows, at every roster width: a narrow row gives the
 * name less room, never the tile. Stop sits inline BEFORE the metrics rather than in a
 * reserved column, so finished rows lose no width and the metrics end at the
 * same x on every row. Nothing on the line is taller than its 16px line height
 * (`leading-4`; Stop and the resumed chip are trimmed to fit), so a running row is
 * no taller than a finished one.
 *
 * When the line is too narrow, the stop button, dot, type column and resumed
 * chip never shrink; the metrics give way first (down to a 3rem floor), the
 * label last (down to 4.5rem, or 1rem under 300px of roster width, where a
 * deep row with a resumed chip and Stop, and the bot, does not fit otherwise).
 * Below 360px of
 * roster width, which is the roster's own width and never the viewport's, the
 * metrics also drop the current tool. All of it is CSS: no JS measures anything.
 */
import { useEffect, useRef } from 'react'
import { useSessionStore, useActiveSession } from '../../stores/session-store'
import { armStopPillFallback } from '../../lib/stop-pill'
import { formatElapsed, formatTokens, taskElapsedLabel, useTicker } from '../chat/TaskCard'
import { AGENT_TYPE_SLOT_CLASS, AgentTile, useAgentTile } from './AgentTypeTile'
import { StatusDot, type SessionDotState } from '../Sidebar/StatusDot'
import { ResumedBadge } from './ResumedBadge'
import { agentRowLabel, type AgentRosterRow } from '../../hooks/useAgentRoster'
import { engineToolMap } from '../chat/tool-registry/engine-tool-maps'
import { modelTier } from '../../../../shared/model-tier'
import { MODEL_TIER_TEXT_CLASS } from '../../lib/model-tier-class'

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

/** The roster's names for a row's state: `data-status`, and which state of the shared dot draws it. */
export type RowStatus =
  'running' | 'queued' | 'subagents' | 'failed' | 'stopped' | 'loaded' | 'done'

/**
 * A row's dot is the session dot's (`status-dot`, its ripple and colours), mapped:
 * the agent's own work in progress ripples green (`running`); its own run ended
 * but something it launched still runs (an agent, at any depth, or a background
 * shell: `runningDescendants`), steady green (`subagents`, drawn as the dot's
 * `idle`): it is alive in effect, and the title says how many; done, stopped by
 * the user and loaded from history steady muted (`inactive`; the title and
 * `data-status` tell them apart); failed steady red. A subagent is alive or dead,
 * never "idle but connected" like a session, so steady green is reserved for
 * "finished, but not yet over". There is no yellow: a stop is not a warning.
 *
 * A failed or stopped agent stays failed or stopped whatever runs below it:
 * how it ended is the more useful thing to read.
 */
export function rowStatus(
  row: Pick<
    AgentRosterRow,
    'isRunning' | 'isQueued' | 'isError' | 'isStopped' | 'isLoaded' | 'runningDescendants'
  >
): RowStatus {
  if (row.isRunning) return 'running'
  if (row.isQueued) return 'queued'
  if (row.isError) return 'failed'
  if (row.isStopped) return 'stopped'
  if (row.isLoaded) return 'loaded'
  if ((row.runningDescendants ?? 0) > 0) return 'subagents'
  return 'done'
}

const DOT_STATE: Record<RowStatus, SessionDotState> = {
  running: 'running',
  queued: 'inactive',
  subagents: 'idle',
  failed: 'failed',
  stopped: 'inactive',
  loaded: 'inactive',
  done: 'inactive'
}

const DOT_LABEL: Partial<Record<RowStatus, string>> = {
  queued: 'Queued',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
  loaded: 'Loaded from history'
}

function RowStatusDot({ row }: { row: AgentRosterRow }): React.JSX.Element {
  const status = rowStatus(row)
  const below = row.runningDescendants ?? 0
  // The dot's own `idle` words ("Idle") say nothing about an agent: it is done, and
  // this is how much still runs below it.
  const label = status === 'subagents' ? `Done · ${below} still running below` : DOT_LABEL[status]
  return (
    // An 8px box, as before, around the 6px dot: its ripple ring is absolute, so the
    // box is what the row's columns and the tree guides see.
    <span className="inline-flex h-2 w-2 shrink-0 items-center justify-center">
      <StatusDot
        testid="AgentRow.status"
        state={DOT_STATE[status]}
        status={status}
        runningSubagents={below}
        label={label}
      />
    </span>
  )
}

export function AgentRow({
  row,
  selected,
  onOpen,
  isContext = false,
  guide,
  knownTypes
}: {
  row: AgentRosterRow
  selected: boolean
  onOpen: (toolUseId: string) => void
  /** A finished ancestor kept by the Running filter as the path to a running row. */
  isContext?: boolean
  /** The tree guide for a nested row; computed by the list, which sees the siblings. */
  guide?: RowGuide
  /** Every agent type the roster shows: a shared prefix is dropped from the tile letter. */
  knownTypes?: readonly string[]
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
  const tile = useAgentTile(engineId, row.type, row.dispatch, knownTypes)
  // The agent's name takes the tier colour of the model it runs on (never a shell's).
  const tierColors = useSessionStore((s) => s.settings.agentModelTierColors)
  const tier = tierColors && row.kind === 'agent' ? modelTier(row.model) : undefined

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
    // A dispatch row is stopped through the dispatcher (it arms the stop for a call that has not
    // started); without the flag Claude's stopTask finds no task and interrupts the whole turn.
    const result = await window.api.stopTask(rid, row.toolUseId, row.dispatch !== undefined)
    if (!result.success) {
      window.api.logError('AgentRow', `Failed to stop task: ${result.error}`)
      clearTaskStopping(rid, row.toolUseId)
      return
    }
    armStopPillFallback(rid, row.toolUseId)
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
      }`}
    >
      {row.depth > 0 && guide && <TreeGuide depth={row.depth} guide={guide} />}
      <RowStatusDot row={row} />
      <span data-testid="AgentRow.typeSlot" className={AGENT_TYPE_SLOT_CLASS}>
        {isShell ? (
          <span
            data-testid="AgentRow.shellGlyph"
            title="Background shell"
            className="inline-flex items-center justify-center h-4 w-4 shrink-0 rounded border border-border font-mono text-[10px] leading-none font-bold text-text-muted select-none"
          >
            $
          </span>
        ) : (
          <AgentTile
            testId="AgentRow.typeTile"
            letter={tile.letter}
            colorId={tile.colorId}
            title={tile.title}
          />
        )}
      </span>
      <span
        data-testid="AgentRow.name"
        data-model-tier={tier}
        title={row.description || undefined}
        className={`min-w-[4.5rem] @max-[300px]/roster:min-w-[1rem] grow-0 shrink basis-auto truncate ${
          isShell
            ? 'font-mono text-[11px] text-text-secondary'
            : `text-[12px] ${
                tier
                  ? MODEL_TIER_TEXT_CLASS[tier]
                  : row.hasExplicitName
                    ? 'text-text-primary'
                    : 'text-text-secondary'
              }`
        }`}
      >
        {agentRowLabel(row)}
      </span>
      <ResumedBadge runIndex={row.runIndex} testId="AgentRow.resumed" />
      <span aria-hidden className="grow shrink basis-0 min-w-0" />
      {row.isQueued && (
        <span data-testid="AgentRow.queued" className="text-[10px] text-text-muted shrink-0">
          queued
        </span>
      )}
      {(row.isRunning || row.isQueued) &&
        !isContext &&
        (row.depth === 0 || hasLifecycle || row.isQueued) && (
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
              {engineToolMap(engineId).displayName(row.lastToolName)}
              {figures.length > 0 ? ' · ' : ''}
            </span>
          )}
          {figures.join(' · ')}
        </span>
      )}
    </div>
  )
}

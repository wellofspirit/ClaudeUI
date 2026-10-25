import { useState, useMemo, useEffect } from 'react'
import { overlayItemStreams } from '../../../../core/shared/sync/item-stream'
import { useSessionStore, useActiveSession } from '../../stores/session-store'
import { useStickToBottom } from '../../hooks/useStickToBottom'
import { MarkdownRenderer } from '../chat/MarkdownRenderer'
import { SubagentOutputBody, dispatchChildEngine } from '../chat/SubagentOutputBody'
import { HandbackReport, hasHandbackReport } from '../chat/HandbackReport'
import { TerminalView } from '../chat/TerminalView'
import { engineToolMap } from '../chat/tool-registry/engine-tool-maps'
import {
  deriveTaskState,
  dispatchEndNote,
  isDispatchToolName,
  isQueuedDispatchCall,
  latestNotification,
  taskFailureText
} from '../chat/task-state'
import { armStopPillFallback } from '../../lib/stop-pill'
import { findTaskBlocks } from './utils'
import { taskElapsedLabel, useTicker } from '../chat/TaskCard'
import { requestSubagentTranscript } from '../../lib/subagent-prefetch'
import { useSubagentPending } from '../../hooks/useSubagentPending'
import { taskHeaderLabel, type ToolView } from '../../../../shared/tool-kinds'
import type { EngineId } from '../../../../shared/types'

type TaskView = Extract<ToolView, { kind: 'task' }>

function BashOutputPanel({
  output,
  totalLines,
  totalBytes,
  isRunning
}: {
  output: string
  totalLines: number
  totalBytes: number
  isRunning: boolean
}): React.JSX.Element {
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center gap-2 mb-2 shrink-0">
        {isRunning && (
          <span className="w-3 h-3 rounded-full border-2 border-accent border-t-transparent animate-spin-slow" />
        )}
        <span className="text-[13px] text-text-muted">
          {isRunning ? 'Running...' : 'Completed'}
        </span>
        <span className="text-[10px] font-mono text-text-muted">
          {totalLines} lines ·{' '}
          {totalBytes > 1024 ? `${(totalBytes / 1024).toFixed(1)}KB` : `${totalBytes}B`}
        </span>
        {isRunning && <div className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />}
      </div>
      <TerminalView text={output} maxHeight="none" />
    </div>
  )
}

/**
 * The engine whose tool names fill `ownerToolUseId`'s transcript: a dispatch's
 * target, else the engine of whoever spawned that owner (walked up the nesting).
 * `fallback` is the active session's engine.
 */
function nestedCallEngine(
  ownerToolUseId: string,
  messages: Parameters<typeof findTaskBlocks>[0],
  subagentMsgs: NonNullable<Parameters<typeof findTaskBlocks>[2]>,
  fallback: EngineId,
  depth = 0
): EngineId {
  if (depth > 8) return fallback
  const {
    taskBlock,
    resultBlock,
    ownerToolUseId: grand
  } = findTaskBlocks(messages, ownerToolUseId, subagentMsgs)
  if (!taskBlock) return fallback
  const issuer = grand
    ? nestedCallEngine(grand, messages, subagentMsgs, fallback, depth + 1)
    : fallback
  const view = engineToolMap(issuer).normalize(
    'task',
    taskBlock.toolInput || {},
    resultBlock ?? undefined,
    taskBlock.toolName
  ) as TaskView
  return dispatchChildEngine(view) ?? issuer
}

/** The stand-in for a nested agent's entry while its parent's transcript is fetched (ADR-102 Arc 2). */
export function TaskEntryLoading(): React.JSX.Element {
  return (
    <div
      data-testid="TaskEntry.subagentLoading"
      className="flex items-center gap-2 px-4 py-3 text-[13px] text-text-muted"
    >
      <span className="w-3 h-3 rounded-full border-2 border-accent border-t-transparent animate-spin-slow" />
      <span>Loading…</span>
    </div>
  )
}

export function TaskEntry({ toolUseId }: { toolUseId: string }): React.JSX.Element | null {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const messages = useActiveSession((s) => s.messages)
  const taskProgressMap = useActiveSession((s) => s.taskProgressMap)
  const itemStreams = useActiveSession((s) => s.itemStreams)
  const subagentMsgs = useActiveSession((s) => s.subagentMessages)
  const bashOutput = useActiveSession((s) => s.bashOutputs[toolUseId])
  const removeTaskFromPanel = useSessionStore((s) => s.removeTaskFromPanel)
  const stoppingTaskIds = useActiveSession((s) => s.stoppingTaskIds)
  const setTaskStopping = useSessionStore((s) => s.setTaskStopping)
  const clearTaskStopping = useSessionStore((s) => s.clearTaskStopping)
  const taskNotifications = useActiveSession((s) => s.taskNotifications)
  const activeTasks = useActiveSession((s) => s.activeTasks)
  const engineId = useActiveSession((s) => s.status.engineId)
  const backgroundTasksEnabled = useActiveSession((s) => s.status.capabilities.backgroundTasks)
  const turnRunning = useActiveSession((s) => s.status.state === 'running')
  const [expanded, setExpanded] = useState(true)
  // The body is the scroller; the elements inside it are what grow. It only
  // exists while expanded, and which child holds the growing content depends on
  // the branch, so both are attached where they render.
  const { scrollerRef, contentRef, following, scrollToBottom } = useStickToBottom<HTMLDivElement>()

  // Nested-aware: a nested agent's call and result live in its parent's bucket,
  // while its own transcript is `subagentMsgs[toolUseId]` as for any agent.
  const { taskBlock, resultBlock, ownerToolUseId, siblings } = findTaskBlocks(
    messages,
    toolUseId,
    subagentMsgs
  )

  // Computed before the early return below (rules-of-hooks); empty while the
  // task block isn't present yet.
  const msgs = useMemo(
    () => overlayItemStreams(subagentMsgs[toolUseId] || [], itemStreams, toolUseId),
    [subagentMsgs, itemStreams, toolUseId]
  )

  // The content-first load leaves this agent's transcript on disk until it is needed
  // (ADR-102 Arc 2): the entry asks for it at once, and shows "Loading…" until it lands.
  const subagentPending = useSubagentPending(toolUseId) && msgs.length === 0
  useEffect(() => {
    if (expanded && subagentPending && activeSessionId)
      requestSubagentTranscript(activeSessionId, toolUseId)
  }, [expanded, subagentPending, activeSessionId, toolUseId])

  // A live record is running by construction here (isHistorical is false), so
  // its start alone decides whether the clock ticks.
  const startedAt = activeTasks[toolUseId]?.startedAt
  const now = useTicker(startedAt !== undefined)

  // All hooks above run unconditionally (rules-of-hooks); bail out only after
  // them when the task block isn't present in the message stream yet.
  if (!taskBlock) return null

  const input = taskBlock.toolInput || {}
  const hasSubagentOutput = msgs.length > 0
  // The engine that issued this task call: the session's, unless the call sits
  // in a dispatch child's transcript (a nested entry), whose tool names are the
  // child's engine's.
  const callEngine = ownerToolUseId
    ? nestedCallEngine(ownerToolUseId, messages, subagentMsgs, engineId)
    : engineId
  const isBash = engineToolMap(callEngine).kindOf(taskBlock.toolName) === 'command'
  // The engine's normalized view, with the result — the same reading TaskCard
  // and the roster use (pi decides background from the launch result), plus a
  // lifecycle record's own word.
  const taskView = engineToolMap(callEngine).normalize(
    'task',
    input,
    resultBlock ?? undefined,
    taskBlock.toolName
  ) as TaskView
  // The name the card shows: a dispatch's description is the X-Agent's own (its name or
  // "Dispatch: <engine>"), not the raw prompt the input carries.
  const description = isBash
    ? String(input.command || input.description || input.prompt || '')
    : taskView.description || taskView.prompt
  const isBackground =
    !!taskView.background ||
    activeTasks[toolUseId]?.isBackgrounded === true ||
    latestNotification(taskNotifications, toolUseId)?.isBackgrounded === true
  // The engine of THIS task's transcript: a dispatch's target, else the issuer's
  // (a native subagent runs on the engine that spawned it).
  const childEngine = dispatchChildEngine(taskView) ?? callEngine
  const progress = taskProgressMap[toolUseId]
  const hasResult = !!resultBlock
  const resultText =
    resultBlock?.toolResult?.replace(/<usage>[\s\S]*?<\/usage>/, '').trimEnd() || ''
  const bgNotification = latestNotification(taskNotifications, toolUseId)
  // The shared ADR-040 predicate — the panel is a live surface, so isHistorical
  // is false here by construction (a historical transcript's entries are opened
  // through the same panel but carry no activeTasks record either way).
  //
  // `isError` now follows the notification whenever there IS one, which is what
  // TaskCard has always done. The old `isBackground ? … : resultBlock?.isError`
  // form missed the case this whole arc is about: an async-launched agent has
  // `run_in_background` absent from its input (so isBackground is false) and an
  // immediate "launched successfully" tool_result (so `resultBlock.isError` is
  // false) — a FAILED one showed no failure badge in the panel at all.
  const hasActiveTask = !!activeTasks[toolUseId]
  // A dispatch call that has not started (the card says so too): not running, Stop kept.
  const queued = isQueuedDispatchCall({
    engineId: callEngine,
    turnRunning,
    content: siblings,
    block: taskBlock
  })
  const { isRunning, isQueued, isError, isStopped, isLoaded } = deriveTaskState({
    isHistorical: false,
    hasActiveTask,
    isBackground,
    hasResult,
    notification: bgNotification,
    resultIsError: resultBlock?.isError ?? false,
    queued
  })
  // The shared X-Agent test of the card (a tool name, so an engine this build does not know
  // is one too), and the two lines the body below cannot show for a background call.
  const isDispatch = isDispatchToolName(taskBlock.toolName)
  const hasHandback = hasHandbackReport(bgNotification)
  const failureSummary = taskFailureText({
    isError,
    resultIsError: resultBlock?.isError ?? false,
    resultText,
    showsOutput: hasSubagentOutput || subagentPending,
    isBackground
  })
  const endNote = dispatchEndNote({
    isDispatch,
    notification: bgNotification,
    settled: !isRunning && !isQueued,
    hasHandback,
    isBackground,
    resultText,
    failureShown: failureSummary !== ''
  })
  const elapsed = taskElapsedLabel({
    isRunning,
    startedAt,
    now,
    durationMs: bgNotification?.usage?.durationMs,
    progressSeconds: progress?.elapsedTimeSeconds
  })

  const statusBadge = isError ? (
    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-danger/10 text-danger shrink-0">
      failed
    </span>
  ) : isQueued ? (
    <span
      data-testid="TaskEntry.queued"
      className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-bg-hover text-text-muted shrink-0"
    >
      queued
    </span>
  ) : !isRunning ? (
    isStopped ? (
      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-warning/10 text-warning shrink-0">
        stopped
      </span>
    ) : isLoaded ? (
      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-bg-hover text-text-muted shrink-0">
        unfinished
      </span>
    ) : (
      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-success/10 text-success shrink-0">
        completed
      </span>
    )
  ) : (
    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-accent/10 text-accent shrink-0">
      running
    </span>
  )

  const isStopping = stoppingTaskIds.includes(toolUseId)
  // A nested call with no lifecycle record gives the engine nothing to stop:
  // Claude's stopTask would fall back to interrupting the main turn (ADR-073 §7).
  // A native task is stopped through the session, which only engines with background tasks
  // implement; a dispatch is stopped through the dispatcher.
  const canStop =
    (ownerToolUseId === null || hasActiveTask) && (isDispatch || backgroundTasksEnabled)

  const handleStopTask = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
    if (!activeSessionId) return
    setTaskStopping(activeSessionId, toolUseId)
    // A dispatch is stopped through the dispatcher, which arms the stop for a call that has
    // not started; without the flag Claude's stopTask finds no task and interrupts the turn.
    const result = await window.api.stopTask(activeSessionId, toolUseId, isDispatch)
    if (!result.success) {
      window.api.logError('TaskDetailPanel', `Failed to stop task: ${result.error}`)
      clearTaskStopping(activeSessionId, toolUseId)
      return
    }
    armStopPillFallback(activeSessionId, toolUseId)
  }

  return (
    <div
      data-testid="TaskEntry"
      data-id={toolUseId}
      className="flex flex-col min-h-0 h-full overflow-hidden"
    >
      <button
        data-testid="TaskEntry.toggle"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center px-4 h-10 shrink-0 gap-2 hover:bg-bg-hover transition-colors cursor-pointer"
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="text-text-secondary shrink-0 transition-transform duration-150"
          style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)' }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
        <span className="text-[13px] text-accent font-medium shrink-0">
          {isBash ? 'Bash' : taskHeaderLabel(taskView)}
        </span>
        <span className="text-[12px] text-text-primary truncate flex-1 text-left">
          {description}
        </span>
        {statusBadge}
        {elapsed !== undefined && (
          <span
            data-testid="TaskEntry.elapsed"
            className="text-[11px] text-text-muted font-mono shrink-0"
          >
            {elapsed}
          </span>
        )}
        {(isRunning || isQueued) && !isStopping && canStop && (
          <button
            data-testid="TaskEntry.stop"
            onClick={handleStopTask}
            className="text-[11px] px-2 py-0.5 rounded bg-danger/10 text-danger hover:bg-danger/20 transition-colors shrink-0"
          >
            Stop
          </button>
        )}
        {isStopping && (
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-warning/10 text-warning shrink-0">
            stopping...
          </span>
        )}
        <button
          data-testid="TaskEntry.close"
          onClick={(e) => {
            e.stopPropagation()
            activeSessionId && removeTaskFromPanel(activeSessionId, toolUseId)
          }}
          className="text-text-muted hover:text-text-primary transition-colors shrink-0 ml-1"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </button>

      {expanded && (
        <div className="relative flex-1 min-h-0">
          <div
            data-testid="TaskEntry.body"
            ref={scrollerRef}
            className="px-4 py-3 h-full overflow-y-auto flex flex-col"
          >
            {hasSubagentOutput ? (
              <div ref={contentRef}>
                <SubagentOutputBody
                  msgs={msgs}
                  isRunning={isRunning}
                  isBackground={isBackground}
                  elapsedLabel={elapsed}
                  size="md"
                  engineId={childEngine}
                />
              </div>
            ) : subagentPending ? (
              <div
                data-testid="TaskEntry.subagentLoading"
                className="flex items-center gap-2 text-[13px] text-text-muted"
              >
                <span className="w-3 h-3 rounded-full border-2 border-accent border-t-transparent animate-spin-slow" />
                <span>Loading…</span>
              </div>
            ) : isBash && bashOutput ? (
              <BashOutputPanel
                output={bashOutput.output}
                totalLines={bashOutput.totalLines}
                totalBytes={bashOutput.totalBytes}
                isRunning={isRunning}
              />
            ) : isBash && hasResult && resultText ? (
              <TerminalView text={resultText} maxHeight="none" />
            ) : hasResult && resultText && !isBackground && !hasHandback ? (
              <div ref={contentRef} className="text-[12px] text-text-primary/80 leading-[1.6]">
                <MarkdownRenderer content={resultText} />
              </div>
            ) : isRunning ? (
              <div className="flex items-center gap-2 text-[13px] text-text-muted">
                <span className="w-3 h-3 rounded-full border-2 border-accent border-t-transparent animate-spin-slow" />
                <span>{isBackground ? 'Running in background...' : 'Running...'}</span>
                {elapsed !== undefined && <span className="font-mono text-[11px]">{elapsed}</span>}
              </div>
            ) : null}
            {/* The report a SubagentHandback subagent delivered (or didn't). */}
            <HandbackReport
              notification={bgNotification}
              xAgent={isDispatch}
              className="mt-3 border-t border-border pt-3 shrink-0"
            />
            {failureSummary && (
              <div
                data-testid="TaskEntry.failureSummary"
                className="mt-3 border-t border-border pt-3 shrink-0 text-[12px] text-danger whitespace-pre-wrap break-words"
              >
                {failureSummary}
              </div>
            )}
            {endNote && (
              <div
                data-testid="TaskEntry.endNote"
                className="mt-3 border-t border-border pt-3 shrink-0 text-[12px] text-text-muted whitespace-pre-wrap break-words"
              >
                {endNote}
              </div>
            )}
          </div>
          {!following && (
            <button
              data-testid="TaskEntry.scrollToBottom"
              onClick={scrollToBottom}
              className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-bg-tertiary border border-border rounded-full p-1.5 shadow-md shadow-black/20 hover:bg-bg-hover transition-colors cursor-pointer z-10"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="text-text-secondary"
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
          )}
        </div>
      )}
    </div>
  )
}

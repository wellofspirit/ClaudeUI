import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useSessionStore, useActiveSession } from '../../stores/session-store'
import { MarkdownRenderer } from '../chat/MarkdownRenderer'
import { SubagentMessages } from '../chat/SubagentMessages'
import { TerminalView } from '../chat/TerminalView'
import { findTaskBlocks, formatElapsed } from './utils'

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

export function TaskEntry({ toolUseId }: { toolUseId: string }): React.JSX.Element | null {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const messages = useActiveSession((s) => s.messages)
  const taskProgressMap = useActiveSession((s) => s.taskProgressMap)
  const subagentMsgs = useActiveSession((s) => s.subagentMessages)
  const subagentText = useActiveSession((s) => s.subagentStreamingText)
  const subagentThinking = useActiveSession((s) => s.subagentStreamingThinking)
  const bashOutput = useActiveSession((s) => s.bashOutputs[toolUseId])
  const removeTaskFromPanel = useSessionStore((s) => s.removeTaskFromPanel)
  const stoppingTaskIds = useActiveSession((s) => s.stoppingTaskIds)
  const setTaskStopping = useSessionStore((s) => s.setTaskStopping)
  const clearTaskStopping = useSessionStore((s) => s.clearTaskStopping)
  const taskNotifications = useActiveSession((s) => s.taskNotifications)
  const [expanded, setExpanded] = useState(true)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [following, setFollowing] = useState(true)
  const isAutoScrolling = useRef(false)

  const { taskBlock, resultBlock } = findTaskBlocks(messages, toolUseId)

  // Referenced by the autoscroll effect below, so they must be computed before
  // it; they default to empty when the task block isn't present yet. `msgs` is
  // memoized so its identity is stable across renders (it's an effect dep).
  const msgs = useMemo(() => subagentMsgs[toolUseId] || [], [subagentMsgs, toolUseId])
  const streamText = subagentText[toolUseId] || ''
  const streamThinking = subagentThinking[toolUseId] || ''

  useEffect(() => {
    const el = bodyRef.current
    if (!el || !following) return
    isAutoScrolling.current = true
    el.scrollTop = el.scrollHeight
    requestAnimationFrame(() => {
      isAutoScrolling.current = false
    })
  }, [msgs, streamText, streamThinking, bashOutput, following])

  const handleScroll = useCallback(() => {
    if (isAutoScrolling.current) return
    const el = bodyRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    setFollowing(nearBottom)
  }, [])

  const scrollToBottom = useCallback(() => {
    const el = bodyRef.current
    if (!el) return
    isAutoScrolling.current = true
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    setFollowing(true)
    requestAnimationFrame(() => {
      isAutoScrolling.current = false
    })
  }, [])

  // All hooks above run unconditionally (rules-of-hooks); bail out only after
  // them when the task block isn't present in the message stream yet.
  if (!taskBlock) return null

  const input = taskBlock.toolInput || {}
  const description = String(input.description || input.prompt || '')
  const hasSubagentOutput = msgs.length > 0 || !!streamText || !!streamThinking
  const isBash = taskBlock?.toolName === 'Bash'
  const isBackground = !!input.run_in_background
  const progress = taskProgressMap[toolUseId]
  const elapsed = progress?.elapsedTimeSeconds
  const hasResult = !!resultBlock
  const resultText =
    resultBlock?.toolResult?.replace(/<usage>[\s\S]*?<\/usage>/, '').trimEnd() || ''
  const bgNotification = taskNotifications.find((n) => n.toolUseId === toolUseId)
  const isRunning = isBackground ? !bgNotification : !hasResult

  const isError = isBackground ? bgNotification?.status === 'failed' : resultBlock?.isError

  const statusBadge = isError ? (
    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-danger/10 text-danger shrink-0">
      failed
    </span>
  ) : !isRunning ? (
    bgNotification?.status === 'stopped' ? (
      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-warning/10 text-warning shrink-0">
        stopped
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

  const handleStopTask = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
    if (!activeSessionId) return
    setTaskStopping(activeSessionId, toolUseId)
    const result = await window.api.stopTask(activeSessionId, toolUseId)
    if (!result.success) {
      window.api.logError('TaskDetailPanel', `Failed to stop task: ${result.error}`)
      clearTaskStopping(activeSessionId, toolUseId)
      return
    }
    setTimeout(() => {
      const rid = useSessionStore.getState().activeSessionId
      if (rid) clearTaskStopping(rid, toolUseId)
    }, 10000)
  }

  return (
    <div data-testid="TaskEntry" data-id={toolUseId} className="flex flex-col min-h-0 h-full overflow-hidden">
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
          {isBash ? 'Bash' : 'Task'}
        </span>
        <span className="text-[12px] text-text-primary truncate flex-1 text-left">
          {isBash ? String(input.command || description) : description}
        </span>
        {statusBadge}
        {elapsed != null && (
          <span className="text-[11px] text-text-muted font-mono shrink-0">
            {formatElapsed(elapsed)}
          </span>
        )}
        {isRunning && !isStopping && (
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
            ref={bodyRef}
            onScroll={handleScroll}
            className="px-4 py-3 h-full overflow-y-auto flex flex-col"
          >
            {hasSubagentOutput ? (
              <div>
                {isRunning && isBackground && (
                  <div className="flex items-center gap-2 text-[13px] text-text-muted mb-2">
                    <span className="w-3 h-3 rounded-full border-2 border-accent border-t-transparent animate-spin-slow" />
                    <span>Running in background...</span>
                    {elapsed != null && (
                      <span className="font-mono text-[11px]">{formatElapsed(elapsed)}</span>
                    )}
                  </div>
                )}
                {streamThinking && (
                  <div className="text-[12px] text-text-secondary/60 italic mb-1.5">
                    {streamThinking.slice(-200)}
                  </div>
                )}
                {msgs.length > 0 && <SubagentMessages messages={msgs} maxHeight="none" />}
                {streamText && (
                  <div className="text-[12px] text-text-primary/80 leading-[1.6] mt-1">
                    <MarkdownRenderer content={streamText} />
                    <span className="inline-block w-[2px] h-[14px] bg-accent ml-0.5 align-middle animate-cursor-blink" />
                  </div>
                )}
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
            ) : hasResult && resultText && !isBackground ? (
              <div className="text-[12px] text-text-primary/80 leading-[1.6]">
                <MarkdownRenderer content={resultText} />
              </div>
            ) : isRunning ? (
              <div className="flex items-center gap-2 text-[13px] text-text-muted">
                <span className="w-3 h-3 rounded-full border-2 border-accent border-t-transparent animate-spin-slow" />
                <span>{isBackground ? 'Running in background...' : 'Running...'}</span>
                {elapsed != null && (
                  <span className="font-mono text-[11px]">{formatElapsed(elapsed)}</span>
                )}
              </div>
            ) : null}
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

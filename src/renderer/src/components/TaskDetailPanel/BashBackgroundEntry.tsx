import { useState, useRef, useEffect, useCallback } from 'react'
import { useSessionStore, useActiveSession } from '../../stores/session-store'
import { findTaskBlocks } from './utils'

export function BashBackgroundEntry({
  toolUseId
}: {
  toolUseId: string
}): React.JSX.Element | null {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const messages = useActiveSession((s) => s.messages)
  const taskNotifications = useActiveSession((s) => s.taskNotifications)
  const removeTaskFromPanel = useSessionStore((s) => s.removeTaskFromPanel)
  const bgOutput = useActiveSession((s) => s.backgroundOutputs[toolUseId])
  const watchBg = useSessionStore((s) => s.watchBackgroundOutput)
  const unwatchBg = useSessionStore((s) => s.unwatchBackgroundOutput)
  const stoppingTaskIds = useActiveSession((s) => s.stoppingTaskIds)
  const setTaskStopping = useSessionStore((s) => s.setTaskStopping)
  const clearTaskStopping = useSessionStore((s) => s.clearTaskStopping)
  const [expanded, setExpanded] = useState(true)
  const [prependedContent, setPrependedContent] = useState('')
  const [loadingMore, setLoadingMore] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [following, setFollowing] = useState(true)
  const isAutoScrolling = useRef(false)

  const { taskBlock } = findTaskBlocks(messages, toolUseId)

  // Watch on mount/expand, unwatch on unmount/collapse
  useEffect(() => {
    if (!expanded || !activeSessionId) return
    watchBg(activeSessionId, toolUseId)
    return () => {
      if (activeSessionId) unwatchBg(activeSessionId, toolUseId)
      setPrependedContent('')
    }
  }, [toolUseId, expanded, watchBg, unwatchBg, activeSessionId])

  useEffect(() => {
    const el = bodyRef.current
    if (!el || !following) return
    isAutoScrolling.current = true
    el.scrollTop = el.scrollHeight
    requestAnimationFrame(() => {
      isAutoScrolling.current = false
    })
  }, [bgOutput?.tail, following])

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

  const handleLoadEarlier = useCallback(async () => {
    if (!bgOutput || loadingMore || !activeSessionId) return
    const alreadyLoaded = prependedContent.length
    const tailLen = new TextEncoder().encode(bgOutput.tail).length
    const loaded = alreadyLoaded + tailLen
    if (loaded >= bgOutput.totalSize) return

    setLoadingMore(true)
    const chunkSize = 64 * 1024
    const offset = Math.max(0, bgOutput.totalSize - loaded - chunkSize)
    const length = Math.min(chunkSize, bgOutput.totalSize - loaded)
    const chunk = await window.api.readBackgroundRange(activeSessionId, toolUseId, offset, length)
    setPrependedContent((prev) => chunk + prev)
    setLoadingMore(false)
  }, [bgOutput, prependedContent, loadingMore, toolUseId, activeSessionId])

  // All hooks above run unconditionally (rules-of-hooks); bail out only after
  // them when the task block isn't present in the message stream yet.
  if (!taskBlock) return null

  const command = String(taskBlock.toolInput?.command || '')
  const bgNotification = taskNotifications.find((n) => n.toolUseId === toolUseId)
  const isRunning = !bgNotification
  const isError = bgNotification?.status === 'failed'

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

  const tailLen = bgOutput ? new TextEncoder().encode(bgOutput.tail).length : 0
  const hasMore = bgOutput ? bgOutput.totalSize > prependedContent.length + tailLen : false

  return (
    <div
      data-testid="BashBackgroundEntry"
      data-id={toolUseId}
      className="flex flex-col min-h-0 h-full overflow-hidden"
    >
      <button
        data-testid="BashBackgroundEntry.toggle"
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
        <span className="text-[13px] text-accent font-medium shrink-0">Bash</span>
        <span className="text-[12px] text-text-primary truncate flex-1 text-left font-mono">
          {command.slice(0, 60)}
        </span>
        {statusBadge}
        {isRunning && !isStopping && (
          <button
            data-testid="BashBackgroundEntry.stop"
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
          data-testid="BashBackgroundEntry.close"
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
          <div ref={bodyRef} onScroll={handleScroll} className="px-4 py-3 h-full overflow-y-auto">
            {isRunning && (
              <div className="flex items-center gap-2 text-[13px] text-text-muted mb-2">
                <span className="w-3 h-3 rounded-full border-2 border-accent border-t-transparent animate-spin-slow" />
                <span>Running in background...</span>
              </div>
            )}
            {hasMore && (
              <button
                data-testid="BashBackgroundEntry.loadEarlier"
                onClick={handleLoadEarlier}
                disabled={loadingMore}
                className="text-[11px] text-accent hover:underline cursor-pointer mb-1 disabled:opacity-50"
              >
                {loadingMore ? 'Loading...' : 'Load earlier output...'}
              </button>
            )}
            {bgOutput ? (
              <pre className="text-[12px] font-mono text-text-primary/70 bg-bg-primary rounded-md p-2 border border-border whitespace-pre-wrap break-words leading-[1.5]">
                {prependedContent}
                {bgOutput.tail}
              </pre>
            ) : isRunning ? (
              <div className="text-[12px] text-text-muted">Waiting for output...</div>
            ) : null}
          </div>
          {!following && (
            <button
              data-testid="BashBackgroundEntry.scrollToBottom"
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

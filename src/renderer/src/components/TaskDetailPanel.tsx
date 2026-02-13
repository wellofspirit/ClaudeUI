import { useState, useRef, useEffect, useCallback } from 'react'
import { useSessionStore, useActiveSession } from '../stores/session-store'
import { MarkdownRenderer } from './chat/MarkdownRenderer'
import { SubagentMessages } from './chat/SubagentMessages'
import type { ContentBlock } from '../../../shared/types'

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}m ${s}s`
}

function findTaskBlocks(
  messages: { role: string; content: ContentBlock[] }[],
  toolUseId: string
): { taskBlock: ContentBlock | null; resultBlock: ContentBlock | null } {
  let taskBlock: ContentBlock | null = null
  let resultBlock: ContentBlock | null = null
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    for (const b of msg.content) {
      if (b.type === 'tool_use' && b.toolUseId === toolUseId) taskBlock = b
      if (b.type === 'tool_result' && b.toolUseId === toolUseId) resultBlock = b
    }
  }
  return { taskBlock, resultBlock }
}

function TaskEntry({ toolUseId }: { toolUseId: string }): React.JSX.Element | null {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const messages = useActiveSession((s) => s.messages)
  const taskProgressMap = useActiveSession((s) => s.taskProgressMap)
  const subagentMsgs = useActiveSession((s) => s.subagentMessages)
  const subagentText = useActiveSession((s) => s.subagentStreamingText)
  const subagentThinking = useActiveSession((s) => s.subagentStreamingThinking)
  const removeTaskFromPanel = useSessionStore((s) => s.removeTaskFromPanel)
  const stoppingTaskIds = useActiveSession((s) => s.stoppingTaskIds)
  const setTaskStopping = useSessionStore((s) => s.setTaskStopping)
  const clearTaskStopping = useSessionStore((s) => s.clearTaskStopping)
  const taskNotifications = useActiveSession((s) => s.taskNotifications)
  const [expanded, setExpanded] = useState(true)

  const { taskBlock, resultBlock } = findTaskBlocks(messages, toolUseId)
  if (!taskBlock) return null

  const input = taskBlock.toolInput || {}
  const description = String(input.description || input.prompt || '')
  const msgs = subagentMsgs[toolUseId] || []
  const streamText = subagentText[toolUseId] || ''
  const streamThinking = subagentThinking[toolUseId] || ''
  const hasSubagentOutput = msgs.length > 0 || !!streamText || !!streamThinking
  const isBackground = !!input.run_in_background
  const progress = taskProgressMap[toolUseId]
  const elapsed = progress?.elapsedTimeSeconds
  const hasResult = !!resultBlock
  const resultText = resultBlock?.toolResult?.replace(/<usage>[\s\S]*?<\/usage>/, '').trimEnd() || ''
  const bgNotification = taskNotifications.find((n) => n.toolUseId === toolUseId)
  const isRunning = isBackground ? !bgNotification : !hasResult

  const isError = isBackground
    ? bgNotification?.status === 'failed'
    : resultBlock?.isError

  const bodyRef = useRef<HTMLDivElement>(null)
  const [following, setFollowing] = useState(true)
  const isAutoScrolling = useRef(false)

  // Auto-scroll when following — use instant scroll to avoid fighting with user
  useEffect(() => {
    const el = bodyRef.current
    if (!el || !following) return
    isAutoScrolling.current = true
    el.scrollTop = el.scrollHeight
    // Clear flag after browser paints
    requestAnimationFrame(() => { isAutoScrolling.current = false })
  }, [msgs, streamText, streamThinking, following])

  // Only react to user-initiated scroll events
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
    requestAnimationFrame(() => { isAutoScrolling.current = false })
  }, [])

  const statusBadge = isError ? (
    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-danger/10 text-danger shrink-0">failed</span>
  ) : !isRunning ? (
    bgNotification?.status === 'stopped' ? (
      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-warning/10 text-warning shrink-0">stopped</span>
    ) : (
      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-success/10 text-success shrink-0">completed</span>
    )
  ) : (
    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-accent/10 text-accent shrink-0">running</span>
  )

  const isStopping = stoppingTaskIds.includes(toolUseId)

  const handleStopTask = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
    if (!activeSessionId) return
    setTaskStopping(activeSessionId, toolUseId)
    const result = await window.api.stopTask(activeSessionId, toolUseId)

    if (!result.success) {
      console.error('Failed to stop task:', result.error)
      clearTaskStopping(activeSessionId, toolUseId)
      return
    }

    setTimeout(() => {
      const rid = useSessionStore.getState().activeSessionId
      if (rid) clearTaskStopping(rid, toolUseId)
    }, 10000)
  }

  return (
    <div className="border-b border-border">
      {/* Header — clickable to expand/collapse */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center px-4 h-10 gap-2 hover:bg-bg-hover transition-colors cursor-pointer"
      >
        <svg
          width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          className="text-text-secondary shrink-0 transition-transform duration-150"
          style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)' }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
        <span className="text-[13px] text-accent font-medium shrink-0">Task</span>
        <span className="text-[12px] text-text-primary truncate flex-1 text-left">{description}</span>
        {statusBadge}
        {elapsed != null && (
          <span className="text-[11px] text-text-muted font-mono shrink-0">{formatElapsed(elapsed)}</span>
        )}
        {isRunning && !isStopping && (
          <button
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
          onClick={(e) => { e.stopPropagation(); activeSessionId && removeTaskFromPanel(activeSessionId, toolUseId) }}
          className="text-text-muted hover:text-text-primary transition-colors shrink-0 ml-1"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </button>

      {/* Body */}
      {expanded && (
        <div className="relative">
        <div ref={bodyRef} onScroll={handleScroll} className="px-4 py-3 max-h-[60vh] overflow-y-auto">
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
                <div className="text-[12px] text-text-secondary/60 italic mb-1.5">{streamThinking.slice(-200)}</div>
              )}
              {msgs.length > 0 && <SubagentMessages messages={msgs} maxHeight="none" />}
              {streamText && (
                <div className="text-[12px] text-text-primary/80 leading-[1.6] mt-1">
                  <MarkdownRenderer content={streamText} />
                  <span className="inline-block w-[2px] h-[14px] bg-accent ml-0.5 align-middle animate-cursor-blink" />
                </div>
              )}
            </div>
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
        {/* Scroll-to-bottom button */}
        {!following && (
          <button
            onClick={scrollToBottom}
            className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-bg-tertiary border border-border rounded-full p-1.5 shadow-md shadow-black/20 hover:bg-bg-hover transition-colors cursor-pointer z-10"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-text-secondary">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        )}
        </div>
      )}
    </div>
  )
}

function BashBackgroundEntry({ toolUseId }: { toolUseId: string }): React.JSX.Element | null {
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

  const { taskBlock } = findTaskBlocks(messages, toolUseId)
  if (!taskBlock) return null

  const command = String(taskBlock.toolInput?.command || '')
  const bgNotification = taskNotifications.find((n) => n.toolUseId === toolUseId)
  const isRunning = !bgNotification
  const isError = bgNotification?.status === 'failed'

  const bodyRef = useRef<HTMLDivElement>(null)
  const [following, setFollowing] = useState(true)
  const isAutoScrolling = useRef(false)

  // Watch on mount/expand, unwatch on unmount/collapse (ref-counted)
  useEffect(() => {
    if (!expanded || !activeSessionId) return
    watchBg(activeSessionId, toolUseId)
    return () => {
      if (activeSessionId) unwatchBg(activeSessionId, toolUseId)
      setPrependedContent('')
    }
  }, [toolUseId, expanded, watchBg, unwatchBg, activeSessionId])

  // Auto-scroll
  useEffect(() => {
    const el = bodyRef.current
    if (!el || !following) return
    isAutoScrolling.current = true
    el.scrollTop = el.scrollHeight
    requestAnimationFrame(() => { isAutoScrolling.current = false })
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
    requestAnimationFrame(() => { isAutoScrolling.current = false })
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

  const statusBadge = isError ? (
    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-danger/10 text-danger shrink-0">failed</span>
  ) : !isRunning ? (
    bgNotification?.status === 'stopped' ? (
      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-warning/10 text-warning shrink-0">stopped</span>
    ) : (
      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-success/10 text-success shrink-0">completed</span>
    )
  ) : (
    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-accent/10 text-accent shrink-0">running</span>
  )

  const isStopping = stoppingTaskIds.includes(toolUseId)

  const handleStopTask = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
    if (!activeSessionId) return
    setTaskStopping(activeSessionId, toolUseId)
    const result = await window.api.stopTask(activeSessionId, toolUseId)

    if (!result.success) {
      console.error('Failed to stop task:', result.error)
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
    <div className="border-b border-border">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center px-4 h-10 gap-2 hover:bg-bg-hover transition-colors cursor-pointer"
      >
        <svg
          width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          className="text-text-secondary shrink-0 transition-transform duration-150"
          style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)' }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
        <span className="text-[13px] text-accent font-medium shrink-0">Bash</span>
        <span className="text-[12px] text-text-primary truncate flex-1 text-left font-mono">{command.slice(0, 60)}</span>
        {statusBadge}
        {isRunning && !isStopping && (
          <button
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
          onClick={(e) => { e.stopPropagation(); activeSessionId && removeTaskFromPanel(activeSessionId, toolUseId) }}
          className="text-text-muted hover:text-text-primary transition-colors shrink-0 ml-1"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </button>

      {expanded && (
        <div className="relative">
          <div ref={bodyRef} onScroll={handleScroll} className="px-4 py-3 max-h-[60vh] overflow-y-auto">
            {isRunning && (
              <div className="flex items-center gap-2 text-[13px] text-text-muted mb-2">
                <span className="w-3 h-3 rounded-full border-2 border-accent border-t-transparent animate-spin-slow" />
                <span>Running in background...</span>
              </div>
            )}
            {hasMore && (
              <button
                onClick={handleLoadEarlier}
                disabled={loadingMore}
                className="text-[11px] text-accent hover:underline cursor-pointer mb-1 disabled:opacity-50"
              >
                {loadingMore ? 'Loading...' : 'Load earlier output...'}
              </button>
            )}
            {bgOutput ? (
              <pre className="text-[12px] font-mono text-text-primary/70 bg-bg-primary rounded-md p-2 border border-border whitespace-pre-wrap break-words leading-[1.5]">
                {prependedContent}{bgOutput.tail}
              </pre>
            ) : isRunning ? (
              <div className="text-[12px] text-text-muted">Waiting for output...</div>
            ) : null}
          </div>
          {!following && (
            <button
              onClick={scrollToBottom}
              className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-bg-tertiary border border-border rounded-full p-1.5 shadow-md shadow-black/20 hover:bg-bg-hover transition-colors cursor-pointer z-10"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-text-secondary">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** Determine which entry component to render based on the tool type */
function PanelEntry({ toolUseId }: { toolUseId: string }): React.JSX.Element | null {
  const messages = useActiveSession((s) => s.messages)
  const { taskBlock } = findTaskBlocks(messages, toolUseId)
  if (!taskBlock) return null

  if (taskBlock.toolName === 'Bash' && taskBlock.toolInput?.run_in_background) {
    return <BashBackgroundEntry toolUseId={toolUseId} />
  }
  return <TaskEntry toolUseId={toolUseId} />
}

export function TaskDetailPanel(): React.JSX.Element | null {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const taskPanelOpen = useActiveSession((s) => s.taskPanelOpen)
  const openedTaskToolUseIds = useActiveSession((s) => s.openedTaskToolUseIds)
  const closeTaskPanel = useSessionStore((s) => s.closeTaskPanel)

  if (!taskPanelOpen || openedTaskToolUseIds.length === 0) return null

  return (
    <div className="w-[400px] shrink-0 border-l border-border bg-bg-secondary flex flex-col h-full">
      {/* Panel header */}
      <div className="shrink-0 flex items-center px-4 h-10 border-b border-border">
        <span className="text-[13px] text-text-secondary font-medium flex-1">Tasks</span>
        <button
          onClick={() => activeSessionId && closeTaskPanel(activeSessionId)}
          className="text-text-muted hover:text-text-primary transition-colors cursor-pointer"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Stacked entries */}
      <div className="flex-1 overflow-y-auto">
        {openedTaskToolUseIds.map((id) => (
          <PanelEntry key={id} toolUseId={id} />
        ))}
      </div>
    </div>
  )
}

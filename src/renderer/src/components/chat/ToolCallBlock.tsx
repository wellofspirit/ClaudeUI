import { memo, useState, useEffect, useRef, useCallback } from 'react'
import type { ContentBlock, PendingApproval } from '../../../../shared/types'
import { useSessionStore, useActiveSession } from '../../stores/session-store'
import { CodeView } from './CodeView'
import { DiffViewer } from './DiffViewer'
import { TerminalView } from './TerminalView'

interface Props {
  block: ContentBlock
  result?: ContentBlock
  approval?: PendingApproval
}

export const ToolCallBlock = memo(function ToolCallBlock({ block, result, approval }: Props): React.JSX.Element {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const removePendingApproval = useSessionStore((s) => s.removePendingApproval)
  const openTaskPanel = useSessionStore((s) => s.openTaskPanel)
  const stoppingTaskIds = useActiveSession((s) => s.stoppingTaskIds)
  const setTaskStopping = useSessionStore((s) => s.setTaskStopping)
  const clearTaskStopping = useSessionStore((s) => s.clearTaskStopping)
  const isHistorical = useActiveSession((s) => s.isHistorical)
  const expandToolCalls = useSessionStore((s) => s.settings.expandToolCalls)
  const expandReadResults = useSessionStore((s) => s.settings.expandReadResults)
  const hideToolInput = useSessionStore((s) => s.settings.hideToolInput)
  const [expanded, setExpanded] = useState(
    block.toolName === 'Read' ? expandToolCalls && expandReadResults : expandToolCalls
  )

  useEffect(() => {
    if (block.toolName === 'Read') {
      setExpanded(expandToolCalls && expandReadResults)
    } else {
      setExpanded(expandToolCalls)
    }
  }, [expandToolCalls, expandReadResults, block.toolName])

  const toolUseId = block.toolUseId || ''
  const isBackgroundBash = block.toolName === 'Bash' && !!block.toolInput?.run_in_background
  const taskNotifications = useActiveSession((s) => s.taskNotifications)
  const summary = getSummary(block)
  const hasResult = !!result
  const isPendingApproval = !isHistorical && !!approval

  // For background bash, "done" means we got a task_notification, not just a tool_result
  const bgNotification = isBackgroundBash ? taskNotifications.find((n) => n.toolUseId === toolUseId) : null
  const bgRunning = isBackgroundBash && !bgNotification && !isHistorical
  const bgError = isBackgroundBash && bgNotification?.status === 'failed'
  const isError = isBackgroundBash ? bgError : (result?.isError ?? false)
  const isSuccess = isBackgroundBash ? (!!bgNotification && !bgError) : (hasResult && !isError)
  // In historical mode, tools without results show as "loaded" (neutral state)
  const isLoaded = isHistorical && !hasResult && !isSuccess && !isError

  const handleApproval = async (decision: 'allow' | 'deny'): Promise<void> => {
    if (!approval || !activeSessionId) return
    await window.api.respondApproval(activeSessionId, approval.requestId, decision)
    removePendingApproval(activeSessionId, approval.requestId)
  }

  // Determine border color based on state
  const borderColor = isPendingApproval
    ? 'border-warning/40'
    : isError
      ? 'border-danger/30'
      : bgRunning
        ? 'border-accent/30'
        : isSuccess
          ? 'border-success/30'
          : 'border-border'

  const statusIcon = isPendingApproval ? (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-warning shrink-0">
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  ) : isError ? (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-danger shrink-0">
      <circle cx="12" cy="12" r="10" />
      <line x1="15" y1="9" x2="9" y2="15" />
      <line x1="9" y1="9" x2="15" y2="15" />
    </svg>
  ) : isSuccess ? (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-success shrink-0">
      <circle cx="12" cy="12" r="10" />
      <polyline points="8 12 11 15 16 9" />
    </svg>
  ) : isLoaded ? (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-text-muted shrink-0">
      <circle cx="12" cy="12" r="10" />
      <line x1="8" y1="12" x2="16" y2="12" />
    </svg>
  ) : bgRunning ? (
    <span className="w-3 h-3 rounded-full border-2 border-accent border-t-transparent shrink-0 animate-spin-slow" />
  ) : (
    <span className="w-3 h-3 rounded-full border-2 border-text-muted border-t-transparent shrink-0 animate-spin-slow" />
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

    // Set timeout to clear state if notification doesn't arrive within 10s
    setTimeout(() => {
      const rid = useSessionStore.getState().activeSessionId
      if (rid) clearTaskStopping(rid, toolUseId)
    }, 10000)
  }

  return (
    <div className={`rounded-lg ${borderColor === 'border-border' ? 'border' : 'border-2'} ${borderColor} bg-bg-secondary overflow-hidden`}>
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 h-9 text-[13px] hover:bg-bg-hover transition-colors cursor-pointer"
      >
        {statusIcon}
        <span className="font-mono font-medium text-accent">{block.toolName}</span>
        <span className="text-text-secondary truncate flex-1 text-left font-mono text-[12px]">{summary}</span>
        {isPendingApproval && (
          <span className="text-[11px] font-semibold text-warning uppercase tracking-wider mr-1">Permission</span>
        )}
        {isLoaded && (
          <span className="text-[10px] text-text-muted shrink-0">loaded</span>
        )}
        {bgRunning && !isStopping && !isHistorical && (
          <button
            onClick={handleStopTask}
            className="text-[11px] px-2 py-0.5 rounded bg-danger/10 text-danger hover:bg-danger/20 transition-colors shrink-0"
          >
            Stop
          </button>
        )}
        {isStopping && !isHistorical && (
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-warning/10 text-warning shrink-0">
            stopping...
          </span>
        )}
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`text-text-secondary transition-transform shrink-0 ${expanded ? 'rotate-180' : ''}`}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-border">
          {/* Input section — always show for Bash */}
          {(!hideToolInput || block.toolName === 'Bash') && (
            <div className="px-3 py-2.5">
              {!hideToolInput && (
                <div className="text-[11px] text-text-secondary uppercase tracking-wider mb-1.5">Input</div>
              )}
              <ToolInput block={block} />
            </div>
          )}

          {/* Result section (skip for background bash — live output shown separately) */}
          {hasResult && result.toolResult && !isBackgroundBash && (
            <div className={`px-3 py-2.5 ${hideToolInput && block.toolName !== 'Bash' ? '' : 'border-t border-border'}`}>
              {!hideToolInput && (
                <div className={`text-[11px] uppercase tracking-wider mb-1.5 ${isError ? 'text-danger' : 'text-success'}`}>
                  {isError ? 'Error' : 'Result'}
                </div>
              )}
              <ToolResult block={block} result={result} />
            </div>
          )}
        </div>
      )}

      {/* Background bash output */}
      {expanded && isBackgroundBash && (
        <BackgroundBashOutput toolUseId={toolUseId} />
      )}

      {/* Approval buttons */}
      {isPendingApproval && (
        <div className="flex border-t border-warning/20">
          <button
            onClick={() => handleApproval('deny')}
            className="flex-1 h-8 text-[12px] font-medium text-danger hover:bg-danger/5 transition-colors cursor-pointer"
          >
            Deny
          </button>
          <div className="w-px bg-warning/20" />
          <button
            onClick={() => handleApproval('allow')}
            className="flex-1 h-8 text-[12px] font-medium text-success hover:bg-success/5 transition-colors cursor-pointer"
          >
            Allow
          </button>
        </div>
      )}

      {/* Footer for background bash */}
      {isBackgroundBash && !isPendingApproval && (
        <div className="border-t border-border px-3 py-1.5 flex items-center gap-1.5">
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-warning/10 text-warning">background</span>
          <div className="flex-1" />
          <button
            onClick={() => activeSessionId && openTaskPanel(activeSessionId, toolUseId)}
            className="text-[11px] text-accent hover:underline cursor-pointer"
          >
            Open in panel
          </button>
        </div>
      )}
    </div>
  )
})

function BackgroundBashOutput({ toolUseId }: { toolUseId: string }): React.JSX.Element | null {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const bgOutput = useActiveSession((s) => s.backgroundOutputs[toolUseId])
  const watchBg = useSessionStore((s) => s.watchBackgroundOutput)
  const unwatchBg = useSessionStore((s) => s.unwatchBackgroundOutput)
  const [prependedContent, setPrependedContent] = useState('')
  const [loadingMore, setLoadingMore] = useState(false)
  const preRef = useRef<HTMLPreElement>(null)
  const isAutoScrolling = useRef(false)
  const [following, setFollowing] = useState(true)

  // Watch on mount, unwatch on unmount (ref-counted)
  useEffect(() => {
    if (!activeSessionId) return
    watchBg(activeSessionId, toolUseId)
    return () => { if (activeSessionId) unwatchBg(activeSessionId, toolUseId) }
  }, [toolUseId, activeSessionId, watchBg, unwatchBg])

  // Auto-scroll
  useEffect(() => {
    const el = preRef.current
    if (!el || !following) return
    isAutoScrolling.current = true
    el.scrollTop = el.scrollHeight
    requestAnimationFrame(() => { isAutoScrolling.current = false })
  }, [bgOutput?.tail, following])

  const handleScroll = useCallback(() => {
    if (isAutoScrolling.current) return
    const el = preRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    setFollowing(nearBottom)
  }, [])

  const handleLoadEarlier = useCallback(async () => {
    if (!bgOutput || loadingMore) return
    const alreadyLoaded = prependedContent.length
    const tailLen = new TextEncoder().encode(bgOutput.tail).length
    const loaded = alreadyLoaded + tailLen
    if (loaded >= bgOutput.totalSize) return

    setLoadingMore(true)
    const chunkSize = 64 * 1024
    const offset = Math.max(0, bgOutput.totalSize - loaded - chunkSize)
    const length = Math.min(chunkSize, bgOutput.totalSize - loaded)
    const rid = useSessionStore.getState().activeSessionId
    if (!rid) return
    const chunk = await window.api.readBackgroundRange(rid, toolUseId, offset, length)
    setPrependedContent((prev) => chunk + prev)
    setLoadingMore(false)
  }, [bgOutput, prependedContent, loadingMore, toolUseId])

  if (!bgOutput) return null

  const tailLen = new TextEncoder().encode(bgOutput.tail).length
  const hasMore = bgOutput.totalSize > prependedContent.length + tailLen

  return (
    <div className="border-t border-border px-3 py-2.5">
      <div className="text-[11px] text-text-secondary uppercase tracking-wider mb-1.5">Output</div>
      {hasMore && (
        <button
          onClick={handleLoadEarlier}
          disabled={loadingMore}
          className="text-[11px] text-accent hover:underline cursor-pointer mb-1 disabled:opacity-50"
        >
          {loadingMore ? 'Loading...' : 'Load earlier output...'}
        </button>
      )}
      <pre
        ref={preRef}
        onScroll={handleScroll}
        className="text-[12px] font-mono text-text-primary/70 bg-bg-primary rounded-md p-2 border border-border overflow-y-auto whitespace-pre-wrap break-words leading-[1.3]"
      >
        {prependedContent}{bgOutput.tail}
      </pre>
    </div>
  )
}

function ToolInput({ block }: { block: ContentBlock }): React.JSX.Element {
  const input = block.toolInput
  const toolName = block.toolName

  // Show command for Bash
  if (toolName === 'Bash' && input?.command) {
    return (
      <pre className="text-[12px] text-text-primary/70 font-mono whitespace-pre-wrap break-words max-h-32 overflow-y-auto leading-[1.3] bg-bg-primary rounded-md p-2 border border-border">
        $ {String(input.command)}
      </pre>
    )
  }

  // Show file path + old/new for Edit
  if (toolName === 'Edit' && input?.file_path) {
    return (
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] font-mono text-text-secondary">{shorten(String(input.file_path))}</span>
        {input.old_string != null && input.new_string != null && (
          <DiffViewer oldStr={String(input.old_string)} newStr={String(input.new_string)} fileName={String(input.file_path)} />
        )}
      </div>
    )
  }

  // Show file path for Read/Write
  if ((toolName === 'Read' || toolName === 'Write') && input?.file_path) {
    return (
      <span className="text-[11px] font-mono text-text-secondary">{shorten(String(input.file_path))}</span>
    )
  }

  // Default: JSON
  return (
    <pre className="text-[12px] text-text-primary/70 font-mono whitespace-pre-wrap break-words max-h-32 overflow-y-auto leading-[1.3] bg-bg-primary rounded-md p-2 border border-border">
      {JSON.stringify(input, null, 2)}
    </pre>
  )
}

function ToolResult({ block, result }: { block: ContentBlock; result: ContentBlock }): React.JSX.Element {
  const toolName = block.toolName
  const text = result.toolResult || ''
  const isError = result.isError

  // Write tool: show the content that was written (from input)
  if (toolName === 'Write' && block.toolInput?.content) {
    return <CodeView code={trunc(String(block.toolInput.content), 5000)} filePath={block.toolInput?.file_path ? String(block.toolInput.file_path) : undefined} />
  }

  // Edit tool: show diff with @git-diff-view
  if (toolName === 'Edit' && block.toolInput?.old_string != null && block.toolInput?.new_string != null) {
    return (
      <div className="overflow-y-auto">
        <DiffViewer
          oldStr={String(block.toolInput.old_string)}
          newStr={String(block.toolInput.new_string)}
          fileName={block.toolInput?.file_path ? String(block.toolInput.file_path) : undefined}
        />
      </div>
    )
  }

  // Read tool: show file content with syntax highlighting and line numbers
  if (toolName === 'Read' && !isError) {
    return <CodeView code={trunc(text, 5000)} filePath={block.toolInput?.file_path ? String(block.toolInput.file_path) : undefined} />
  }

  // Bash tool: show output with ANSI support
  if (toolName === 'Bash' && !isError) {
    return <TerminalView text={text} />
  }

  // Error: keep as styled pre
  if (isError) {
    return (
      <pre className="text-[12px] font-mono whitespace-pre-wrap break-words overflow-y-auto leading-[1.3] bg-bg-primary rounded-md p-2 border border-border text-danger">
        {trunc(text, 2000)}
      </pre>
    )
  }

  // Default: render with terminal (handles ANSI from Grep, Glob, etc.)
  return <TerminalView text={text} />
}


function getSummary(block: ContentBlock): string {
  const input = block.toolInput
  if (!input) return ''

  if (block.toolName === 'Read' && input.file_path) return shorten(String(input.file_path))
  if (block.toolName === 'Write' && input.file_path) return shorten(String(input.file_path))
  if (block.toolName === 'Edit' && input.file_path) return shorten(String(input.file_path))
  if (block.toolName === 'Bash' && input.command) return String(input.command)
  if (block.toolName === 'Glob' && input.pattern) return String(input.pattern)
  if (block.toolName === 'Grep' && input.pattern) return String(input.pattern)
  if (block.toolName === 'AskUserQuestion' && Array.isArray(input.questions)) {
    const n = input.questions.length
    return `${n} question${n !== 1 ? 's' : ''}`
  }
  if (block.toolName === 'TodoWrite' && Array.isArray(input.todos)) {
    const completed = input.todos.filter((t: Record<string, unknown>) => t.status === 'completed').length
    return `${completed}/${input.todos.length} tasks`
  }
  if (block.toolName === 'Task' && input.description) return String(input.description)

  return JSON.stringify(input)
}

function shorten(path: string): string {
  const parts = path.split('/')
  return parts.length <= 3 ? path : '.../' + parts.slice(-2).join('/')
}

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '...' : s
}

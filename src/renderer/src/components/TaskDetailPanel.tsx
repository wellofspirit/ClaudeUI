import { useState } from 'react'
import { useSessionStore } from '../stores/session-store'
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
  const messages = useSessionStore((s) => s.messages)
  const taskProgressMap = useSessionStore((s) => s.taskProgressMap)
  const subagentMsgs = useSessionStore((s) => s.subagentMessages)
  const subagentText = useSessionStore((s) => s.subagentStreamingText)
  const subagentThinking = useSessionStore((s) => s.subagentStreamingThinking)
  const removeTaskFromPanel = useSessionStore((s) => s.removeTaskFromPanel)
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
  // Background tasks get a tool_result immediately ("agent launched") but keep running until task_notification
  const taskNotifications = useSessionStore((s) => s.taskNotifications)
  const bgNotification = taskNotifications.find((n) => n.toolUseId === toolUseId)
  const isRunning = isBackground ? !bgNotification : !hasResult

  const isError = isBackground
    ? bgNotification?.status === 'failed'
    : resultBlock?.isError

  const statusBadge = isError ? (
    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-danger/10 text-danger shrink-0">failed</span>
  ) : !isRunning ? (
    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-success/10 text-success shrink-0">completed</span>
  ) : (
    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-accent/10 text-accent shrink-0">running</span>
  )

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
        <button
          onClick={(e) => { e.stopPropagation(); removeTaskFromPanel(toolUseId) }}
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
        <div className="px-4 py-3">
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
              {msgs.length > 0 && <SubagentMessages messages={msgs} maxHeight="400px" />}
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
      )}
    </div>
  )
}

export function TaskDetailPanel(): React.JSX.Element | null {
  const taskPanelOpen = useSessionStore((s) => s.taskPanelOpen)
  const openedTaskToolUseIds = useSessionStore((s) => s.openedTaskToolUseIds)
  const closeTaskPanel = useSessionStore((s) => s.closeTaskPanel)

  if (!taskPanelOpen || openedTaskToolUseIds.length === 0) return null

  return (
    <div className="w-[400px] shrink-0 border-l border-border bg-bg-secondary flex flex-col h-full">
      {/* Panel header */}
      <div className="shrink-0 flex items-center px-4 h-10 border-b border-border">
        <span className="text-[13px] text-text-secondary font-medium flex-1">Tasks</span>
        <button
          onClick={closeTaskPanel}
          className="text-text-muted hover:text-text-primary transition-colors cursor-pointer"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Stacked task entries */}
      <div className="flex-1 overflow-y-auto">
        {openedTaskToolUseIds.map((id) => (
          <TaskEntry key={id} toolUseId={id} />
        ))}
      </div>
    </div>
  )
}

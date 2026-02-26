import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useAutomationStore } from '../../stores/automation-store'
import { MessageBubble } from '../chat/MessageBubble'

export function AutomationRunHistory(): React.JSX.Element {
  const selectedAutomationId = useAutomationStore((s) => s.selectedAutomationId)
  const selectedRunId = useAutomationStore((s) => s.selectedRunId)
  const runs = useAutomationStore((s) => selectedAutomationId ? s.runs[selectedAutomationId] : undefined)
  const runMessages = useAutomationStore((s) => s.runMessages)
  const setRunMessages = useAutomationStore((s) => s.setRunMessages)
  const clearRunSelection = useAutomationStore((s) => s.clearRunSelection)
  const streamingText = useAutomationStore((s) => s.streamingText)
  const isRunProcessing = useAutomationStore((s) => s.isRunProcessing)

  const [inputText, setInputText] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  const run = runs?.find((r) => r.id === selectedRunId)

  // Load messages when run is selected
  useEffect(() => {
    if (!selectedAutomationId || !selectedRunId) return
    setRunMessages(null) // clear while loading
    useAutomationStore.getState().clearStreamingText()
    window.api.loadAutomationRunHistory(selectedAutomationId, selectedRunId).then((msgs) => {
      setRunMessages(msgs)
    })
  }, [selectedAutomationId, selectedRunId, setRunMessages])

  // Auto-scroll when new messages arrive or streaming text changes
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [runMessages?.length, streamingText])

  if (!run) {
    return <div className="flex-1 flex items-center justify-center text-text-muted text-sm">Run not found</div>
  }

  const isRunning = run.status === 'running'
  const canSend = isRunning && !isRunProcessing && inputText.trim().length > 0

  const handleSend = (): void => {
    const text = inputText.trim()
    if (!text || !selectedAutomationId || !isRunning) return
    setInputText('')
    window.api.sendAutomationMessage(selectedAutomationId, text)
  }

  const handleStop = (): void => {
    if (!selectedAutomationId || !selectedRunId) return
    // Try to abort the local run (works if this instance owns it)
    window.api.cancelAutomationRun(selectedAutomationId)
    // Also mark the run as stopped in runs.json (works for foreign/stale runs)
    window.api.dismissAutomationRun(selectedAutomationId, selectedRunId)
  }

  const statusIcon = run.status === 'success' ? '✅' : run.status === 'error' ? '❌' : '🔄'
  const duration = run.finishedAt
    ? `${((run.finishedAt - run.startedAt) / 1000).toFixed(0)}s`
    : 'running...'
  const time = new Date(run.startedAt).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-border/20 shrink-0">
        <button
          onClick={clearRunSelection}
          className="flex items-center gap-1 text-xs text-text-accent hover:text-text-primary transition-colors"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Back
        </button>
        <div className="flex-1" />
        <span className="text-xs text-text-muted">{time}</span>
        <span className="text-xs">{statusIcon}</span>
        <span className="text-xs text-text-muted">{duration}</span>
        {run.totalCostUsd > 0 && (
          <span className="text-xs text-text-muted">${run.totalCostUsd.toFixed(4)}</span>
        )}
        {isRunning && (
          <button
            onClick={handleStop}
            className="flex items-center gap-1 px-2 py-0.5 text-xs bg-red-500/10 border border-red-500/30 text-red-400 rounded-lg hover:bg-red-500/20 transition-colors"
          >
            <span className="text-[10px]">■</span>
            Stop
          </button>
        )}
      </div>

      {/* Error banner */}
      {run.error && (
        <div className="mx-4 mt-2 px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400">
          {run.error}
        </div>
      )}

      {/* Messages */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-4 py-3">
        {runMessages === null ? (
          <div className="flex items-center justify-center py-8 text-text-muted text-sm">
            Loading messages...
          </div>
        ) : runMessages.length === 0 && !streamingText ? (
          <div className="flex items-center justify-center py-8 text-text-muted text-sm">
            No messages recorded
          </div>
        ) : (
          <div className="space-y-3">
            {runMessages?.map((msg, idx) => (
              <MessageBubble
                key={msg.id || idx}
                message={msg}
                pendingApprovals={[]}
                isLastAssistant={false}
                thinkingStartedAt={null}
              />
            ))}

            {/* Streaming text */}
            {streamingText && (
              <div className="bg-bg-secondary/60 rounded-xl px-4 py-3 text-sm">
                <div className="prose prose-invert prose-sm max-w-none">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamingText}</ReactMarkdown>
                </div>
                <span className="inline-block w-2 h-4 bg-text-accent/60 animate-pulse ml-0.5" />
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input box — shown when run is active */}
      {isRunning && (
        <div className="border-t border-border/20 px-4 py-2 shrink-0">
          <div className="flex gap-2 items-end">
            <textarea
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  if (canSend) handleSend()
                }
              }}
              placeholder={isRunProcessing ? 'Waiting for response...' : 'Continue the conversation...'}
              className="flex-1 bg-bg-tertiary border border-border/40 rounded-lg px-3 py-1.5 text-sm text-text-primary outline-none focus:border-text-accent transition-colors resize-none"
              rows={1}
              disabled={isRunProcessing}
            />
            {isRunProcessing ? (
              <button
                onClick={handleStop}
                className="px-3 py-1.5 text-xs bg-red-500/10 border border-red-500/30 text-red-400 rounded-lg hover:bg-red-500/20 transition-colors shrink-0"
              >
                ■ Stop
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!inputText.trim()}
                className="px-3 py-1.5 text-xs bg-bg-tertiary border border-border/40 rounded-lg hover:bg-bg-hover transition-colors text-text-secondary disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
              >
                Send
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

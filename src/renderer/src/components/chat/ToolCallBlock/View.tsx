import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import type {
  ContentBlock,
  PendingApproval,
  PermissionMode,
  PermissionSuggestion,
  TaskNotification
} from '../../../../../shared/types'
import { useSessionStore, useActiveSession, type ThemeId } from '../../../stores/session-store'
import { resolveToolVisualState, TOOL_BORDER_CLASSES, getSummary, shorten, trunc } from './utils'
import { CodeView } from '../CodeView'
import { DiffViewer } from '../../../lib/diff'
import { TerminalView } from '../TerminalView'
import { MarkdownRenderer } from '../MarkdownRenderer'
import { AlwaysAllowSection } from '../PermissionSuggestions'
import { MermaidDiagram } from '../MermaidDiagram'
import { MockupPreviewCard } from '../MockupPreviewCard'
import { AnsiUp } from 'ansi_up'

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>
type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>

export interface BashOutputSlice {
  output: string
  totalLines: number
  totalBytes: number
}

export interface BgOutputSlice {
  tail: string
  totalSize: number
}

export interface ToolCallBlockViewProps {
  block: ToolUseBlock
  result?: ToolResultBlock
  approval?: PendingApproval
  isHistorical: boolean
  permissionMode: PermissionMode
  expandToolCalls: boolean
  expandReadResults: boolean
  hideToolInput: boolean
  theme: ThemeId
  isBackgroundBash: boolean
  bashOutput?: BashOutputSlice
  bgOutput?: BgOutputSlice
  bgNotification: TaskNotification | null
  isStopping: boolean
  isBackgrounding: boolean
  hasActiveSession: boolean
  onApproval: (
    decision: 'allow' | 'deny',
    selectedSuggestions?: PermissionSuggestion[]
  ) => Promise<void>
  onBackgroundTask: () => Promise<void>
  onStopTask: () => Promise<void>
  onOpenTaskPanel: () => void
}

export function ToolCallBlockView({
  block,
  result,
  approval,
  isHistorical,
  permissionMode,
  expandToolCalls,
  expandReadResults,
  hideToolInput,
  theme,
  isBackgroundBash,
  bashOutput,
  bgOutput,
  bgNotification,
  isStopping,
  isBackgrounding,
  hasActiveSession,
  onApproval,
  onBackgroundTask,
  onStopTask,
  onOpenTaskPanel
}: ToolCallBlockViewProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(
    block.toolName === 'Read' ? expandToolCalls && expandReadResults : expandToolCalls
  )
  const [checkedSuggestions, setCheckedSuggestions] = useState<boolean[]>(() =>
    (approval?.suggestions || []).map(() => false)
  )

  useEffect(() => {
    if (approval?.suggestions?.length) {
      setCheckedSuggestions(approval.suggestions.map(() => false))
    }
  }, [approval?.suggestions])

  useEffect(() => {
    if (block.toolName === 'Read') {
      setExpanded(expandToolCalls && expandReadResults)
    } else {
      setExpanded(expandToolCalls)
    }
  }, [expandToolCalls, expandReadResults, block.toolName])

  const toolUseId = block.toolUseId || ''

  useEffect(() => {
    if ((bashOutput || bgOutput) && !expanded) setExpanded(true)
  }, [bashOutput, bgOutput]) // eslint-disable-line react-hooks/exhaustive-deps

  const summary = getSummary(block)
  const hasResult = !!result
  const isPendingApproval = !isHistorical && !!approval
  const hasSuggestions = isPendingApproval && (approval?.suggestions?.length ?? 0) > 0

  const bgRunning = isBackgroundBash && !bgNotification && !isHistorical

  const visualState = resolveToolVisualState({
    toolName: block.toolName,
    hasResult,
    isHistorical,
    hasApproval: !!approval,
    isBackgroundBash,
    bgNotificationStatus: bgNotification?.status ?? null,
    resultIsError: result?.isError ?? false
  })
  const borderColor = TOOL_BORDER_CLASSES[visualState]
  const isError = visualState === 'error'
  const isSuccess = visualState === 'success'
  const isLoaded = visualState === 'loaded'
  const isForegroundBashRunning = visualState === 'running' && !isBackgroundBash

  const handleApprovalDecision = async (decision: 'allow' | 'deny'): Promise<void> => {
    if (!approval) return
    const selected =
      decision === 'allow' && approval.suggestions
        ? approval.suggestions.filter((_, i) => checkedSuggestions[i])
        : undefined
    await onApproval(decision, selected?.length ? selected : undefined)
  }

  const statusIcon = isPendingApproval ? (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="text-warning shrink-0"
    >
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  ) : isError ? (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="text-danger shrink-0"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="15" y1="9" x2="9" y2="15" />
      <line x1="9" y1="9" x2="15" y2="15" />
    </svg>
  ) : isSuccess ? (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="text-success shrink-0"
    >
      <circle cx="12" cy="12" r="10" />
      <polyline points="8 12 11 15 16 9" />
    </svg>
  ) : isLoaded ? (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="text-text-muted shrink-0"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="8" y1="12" x2="16" y2="12" />
    </svg>
  ) : bgRunning ? (
    <span className="w-3 h-3 rounded-full border-2 border-accent border-t-transparent shrink-0 animate-spin-slow" />
  ) : (
    <span className="w-3 h-3 rounded-full border-2 border-text-muted border-t-transparent shrink-0 animate-spin-slow" />
  )

  const isMermaid = block.toolName === 'mcp__claude-ui__render_mermaid'
  const isMockup =
    block.toolName === 'mcp__claude-ui-mockup__create_mockup' ||
    block.toolName === 'mcp__claude-ui-mockup__show_mockup'

  // Mermaid card
  if (isMermaid && block.toolInput?.source) {
    const mermaidTitle = block.toolInput.title ? String(block.toolInput.title) : undefined
    return (
      <div
        className={`rounded-lg ${borderColor === 'border-border' ? 'border' : 'border-2'} ${borderColor} bg-bg-secondary overflow-hidden`}
      >
        <div className="flex items-center gap-2 px-3 h-9 text-[13px]">
          {statusIcon}
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            className="text-accent shrink-0"
          >
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="8.5" y="14" width="7" height="7" rx="1" />
            <line x1="6.5" y1="10" x2="6.5" y2="14" />
            <line x1="17.5" y1="10" x2="17.5" y2="14" />
            <line x1="6.5" y1="14" x2="12" y2="14" />
            <line x1="17.5" y1="14" x2="12" y2="14" />
          </svg>
          <span className="font-medium text-text-primary">{mermaidTitle || 'Mermaid Diagram'}</span>
          <div className="flex-1" />
          {result?.isError && <span className="text-[11px] text-danger">Validation failed</span>}
        </div>
        <div className="border-t border-border px-3 py-2.5">
          <MermaidDiagram source={String(block.toolInput.source)} title={mermaidTitle} />
        </div>
        {isPendingApproval && (
          <div className="flex border-t border-warning/20">
            <button
              onClick={() => handleApprovalDecision('deny')}
              className="flex-1 h-8 text-[12px] font-medium text-danger hover:bg-danger/5 transition-colors cursor-pointer"
            >
              Deny
            </button>
            <div className="w-px bg-warning/20" />
            <button
              onClick={() => handleApprovalDecision('allow')}
              className="flex-1 h-8 text-[12px] font-medium text-success hover:bg-success/5 transition-colors cursor-pointer"
            >
              Allow
            </button>
          </div>
        )}
      </div>
    )
  }

  // Mockup card
  if (isMockup) {
    const mockupDirectory = block.toolInput?.directory
      ? String(block.toolInput.directory)
      : extractMockupDirectory(result)
    const mockupTitle = block.toolInput?.title ? String(block.toolInput.title) : undefined

    return (
      <div
        className={`rounded-lg ${borderColor === 'border-border' ? 'border' : 'border-2'} ${borderColor} bg-bg-secondary overflow-hidden`}
      >
        <div className="flex items-center gap-2 px-3 h-9 text-[13px]">
          {statusIcon}
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            className="text-accent shrink-0"
          >
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="3" y1="9" x2="21" y2="9" />
            <line x1="9" y1="9" x2="9" y2="21" />
          </svg>
          <span className="font-medium text-text-primary">{mockupTitle || 'UI Mockup'}</span>
          <div className="flex-1" />
          {result?.isError && <span className="text-[11px] text-danger">Failed</span>}
        </div>
        {mockupDirectory && !result?.isError && (
          <div className="border-t border-border px-3 py-2.5">
            <MockupPreviewCard directory={mockupDirectory} title={mockupTitle} />
          </div>
        )}
        {result?.isError && result.toolResult && (
          <div className="border-t border-border px-3 py-2 text-[12px] text-danger whitespace-pre-wrap">
            {result.toolResult}
          </div>
        )}
        {isPendingApproval && (
          <div className="flex border-t border-warning/20">
            <button
              onClick={() => handleApprovalDecision('deny')}
              className="flex-1 h-8 text-[12px] font-medium text-danger hover:bg-danger/5 transition-colors cursor-pointer"
            >
              Deny
            </button>
            <div className="w-px bg-warning/20" />
            <button
              onClick={() => handleApprovalDecision('allow')}
              className="flex-1 h-8 text-[12px] font-medium text-success hover:bg-success/5 transition-colors cursor-pointer"
            >
              Allow
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      className={`rounded-lg ${borderColor === 'border-border' ? 'border' : 'border-2'} ${borderColor} bg-bg-secondary overflow-hidden`}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 h-9 text-[13px] hover:bg-bg-hover transition-colors cursor-pointer"
      >
        {statusIcon}
        <span className="font-mono font-medium text-accent">{block.toolName}</span>
        <span className="text-text-secondary truncate flex-1 text-left font-mono text-[12px]">
          {summary}
        </span>
        {isPendingApproval && (
          <span className="text-[11px] font-semibold text-warning uppercase tracking-wider mr-1">
            Permission
          </span>
        )}
        {isLoaded && <span className="text-[10px] text-text-muted shrink-0">loaded</span>}
        {isForegroundBashRunning && !isBackgrounding && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onBackgroundTask()
            }}
            className="text-[11px] px-2 py-0.5 rounded bg-accent/10 text-accent hover:bg-accent/20 transition-colors shrink-0"
          >
            Send to background
          </button>
        )}
        {isBackgrounding && (
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-accent/10 text-accent shrink-0">
            sending to background…
          </span>
        )}
        {bgRunning && !isStopping && !isHistorical && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onStopTask()
            }}
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
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={`text-text-secondary transition-transform shrink-0 ${expanded ? 'rotate-180' : ''}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {expanded && (
        <div className="border-t border-border">
          {(!hideToolInput || block.toolName === 'Bash') && (
            <div className="px-3 py-2.5">
              {!hideToolInput && (
                <div className="text-[11px] text-text-secondary uppercase tracking-wider mb-1.5">
                  Input
                </div>
              )}
              <ToolInput block={block} />
            </div>
          )}

          {isForegroundBashRunning && bashOutput && !bgOutput && (
            <div className="border-t border-border">
              <LiveBashOutput
                output={bashOutput.output}
                totalLines={bashOutput.totalLines}
                totalBytes={bashOutput.totalBytes}
                theme={theme}
              />
            </div>
          )}

          {hasResult && result.toolResult && !isBackgroundBash && (
            <div
              className={`px-3 py-2.5 ${hideToolInput && block.toolName !== 'Bash' ? '' : 'border-t border-border'}`}
            >
              {!hideToolInput && (
                <div
                  className={`text-[11px] uppercase tracking-wider mb-1.5 ${isError ? 'text-danger' : 'text-success'}`}
                >
                  {isError ? 'Error' : 'Result'}
                </div>
              )}
              <ToolResult block={block} result={result} />
            </div>
          )}
        </div>
      )}

      {expanded && block.toolName === 'Bash' && (isBackgroundBash || isForegroundBashRunning) && (
        <BackgroundBashOutput toolUseId={toolUseId} />
      )}

      {isPendingApproval && (
        <>
          {(approval!.decisionReason || hasSuggestions) && (
            <div className="border-t border-warning/20 px-3 py-2">
              {approval!.decisionReason && (
                <p className="text-[11px] text-text-muted/70 leading-relaxed">
                  {approval!.decisionReason}
                </p>
              )}
              {hasSuggestions && (
                <AlwaysAllowSection
                  suggestions={approval!.suggestions!}
                  checkedSuggestions={checkedSuggestions}
                  onToggle={(i) =>
                    setCheckedSuggestions((prev) => prev.map((v, j) => (j === i ? !v : v)))
                  }
                  currentMode={permissionMode}
                />
              )}
            </div>
          )}
          <div className="flex border-t border-warning/20">
            <button
              onClick={() => handleApprovalDecision('deny')}
              className="flex-1 h-8 text-[12px] font-medium text-danger hover:bg-danger/5 transition-colors cursor-pointer"
            >
              Deny
            </button>
            <div className="w-px bg-warning/20" />
            <button
              onClick={() => handleApprovalDecision('allow')}
              className="flex-1 h-8 text-[12px] font-medium text-success hover:bg-success/5 transition-colors cursor-pointer"
            >
              Allow
            </button>
          </div>
        </>
      )}

      {isForegroundBashRunning && bashOutput && !isPendingApproval && (
        <div className="border-t border-border px-3 py-1.5 flex items-center gap-1.5">
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-accent/10 text-accent">
            streaming
          </span>
          <div className="flex-1" />
          <button
            onClick={() => hasActiveSession && onOpenTaskPanel()}
            className="text-[11px] text-accent hover:underline cursor-pointer"
          >
            Open in panel
          </button>
        </div>
      )}

      {isBackgroundBash && !isPendingApproval && (
        <div className="border-t border-border px-3 py-1.5 flex items-center gap-1.5">
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-warning/10 text-warning">
            background
          </span>
          <div className="flex-1" />
          <button
            onClick={() => hasActiveSession && onOpenTaskPanel()}
            className="text-[11px] text-accent hover:underline cursor-pointer"
          >
            Open in panel
          </button>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sub-components (stay in View file — they own their own local state / streams)
// ---------------------------------------------------------------------------

const liveAnsiUp = new AnsiUp()
liveAnsiUp.use_classes = false
liveAnsiUp.escape_html = true

function LiveBashOutput({
  output,
  totalLines,
  totalBytes,
  theme
}: {
  output: string
  totalLines: number
  totalBytes: number
  theme: ThemeId
}): React.JSX.Element {
  const preRef = useRef<HTMLPreElement>(null)
  const bg = theme === 'light' ? '#e8eaed' : theme === 'monokai' ? '#272822' : '#0d1117'
  const fg = theme === 'light' ? '#1a1d24' : theme === 'monokai' ? '#f8f8f2' : '#d1d5db'

  const html = useMemo(() => liveAnsiUp.ansi_to_html(output), [output])

  useEffect(() => {
    const el = preRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [html])

  return (
    <div className="px-3 py-2.5">
      <div className="flex items-center gap-2 mb-1.5">
        <div className="text-[11px] text-text-secondary uppercase tracking-wider">Live Output</div>
        <span className="text-[10px] font-mono text-text-muted">
          {totalLines} lines ·{' '}
          {totalBytes > 1024 ? `${(totalBytes / 1024).toFixed(1)}KB` : `${totalBytes}B`}
        </span>
        <div className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
      </div>
      <pre
        ref={preRef}
        className="text-[12px] font-mono whitespace-pre-wrap break-words leading-[1.3] rounded-md p-2 border border-border overflow-y-auto"
        style={{ background: bg, color: fg, maxHeight: 300 }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
}

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

  useEffect(() => {
    if (!activeSessionId) return
    watchBg(activeSessionId, toolUseId)
    return () => {
      if (activeSessionId) unwatchBg(activeSessionId, toolUseId)
    }
  }, [toolUseId, activeSessionId, watchBg, unwatchBg])

  useEffect(() => {
    const el = preRef.current
    if (!el || !following) return
    isAutoScrolling.current = true
    el.scrollTop = el.scrollHeight
    requestAnimationFrame(() => {
      isAutoScrolling.current = false
    })
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
        style={{ maxHeight: 10 * 12 * 1.3 + 16 }}
      >
        {prependedContent}
        {bgOutput.tail}
      </pre>
    </div>
  )
}

function ToolInput({ block }: { block: ToolUseBlock }): React.JSX.Element {
  const input = block.toolInput
  const toolName = block.toolName

  if (toolName === 'Bash' && input?.command) {
    return (
      <pre className="text-[12px] text-text-primary/70 font-mono whitespace-pre-wrap break-words max-h-32 overflow-y-auto leading-[1.3] bg-bg-primary rounded-md p-2 border border-border">
        $ {String(input.command)}
      </pre>
    )
  }

  if (toolName === 'Edit' && input?.file_path) {
    return (
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] font-mono text-text-secondary">
          {shorten(String(input.file_path))}
        </span>
        {input.old_string != null && input.new_string != null && (
          <DiffViewer
            oldStr={String(input.old_string)}
            newStr={String(input.new_string)}
            fileName={String(input.file_path)}
          />
        )}
      </div>
    )
  }

  if ((toolName === 'Read' || toolName === 'Write') && input?.file_path) {
    return (
      <span className="text-[11px] font-mono text-text-secondary">
        {shorten(String(input.file_path))}
      </span>
    )
  }

  return (
    <pre className="text-[12px] text-text-primary/70 font-mono whitespace-pre-wrap break-words max-h-32 overflow-y-auto leading-[1.3] bg-bg-primary rounded-md p-2 border border-border">
      {JSON.stringify(input, null, 2)}
    </pre>
  )
}

function ToolResult({
  block,
  result
}: {
  block: ToolUseBlock
  result: ToolResultBlock
}): React.JSX.Element {
  const toolName = block.toolName
  const text = result.toolResult
  const isError = result.isError

  if (toolName === 'Write' && block.toolInput?.content) {
    const content = trunc(String(block.toolInput.content), 5000)
    const filePath = block.toolInput?.file_path ? String(block.toolInput.file_path) : undefined
    return <WriteResult content={content} filePath={filePath} />
  }

  if (
    toolName === 'Edit' &&
    block.toolInput?.old_string != null &&
    block.toolInput?.new_string != null
  ) {
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

  if (toolName === 'Read' && !isError) {
    return (
      <CodeView
        code={trunc(text, 5000)}
        filePath={block.toolInput?.file_path ? String(block.toolInput.file_path) : undefined}
      />
    )
  }

  if (toolName === 'Bash' && !isError) {
    return <TerminalView text={text} />
  }

  if (isError) {
    return (
      <pre className="text-[12px] font-mono whitespace-pre-wrap break-words overflow-y-auto leading-[1.3] bg-bg-primary rounded-md p-2 border border-border text-danger">
        {trunc(text, 2000)}
      </pre>
    )
  }

  return <TerminalView text={text} />
}

function WriteResult({
  content,
  filePath
}: {
  content: string
  filePath?: string
}): React.JSX.Element {
  const isMarkdown = !!filePath && /\.(md|markdown)$/i.test(filePath)
  const [tab, setTab] = useState<'preview' | 'code'>(isMarkdown ? 'preview' : 'code')

  if (!isMarkdown) {
    return <CodeView code={content} filePath={filePath} />
  }

  return (
    <div>
      <div className="flex gap-1 mb-2">
        {(['preview', 'code'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`text-[11px] h-6 px-2 rounded transition-colors cursor-pointer capitalize ${
              tab === t
                ? 'bg-bg-hover text-text-primary'
                : 'text-text-muted hover:text-text-secondary'
            }`}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === 'preview' ? (
        <div className="text-[13px] text-text-primary leading-[1.6]">
          <MarkdownRenderer content={content} />
        </div>
      ) : (
        <CodeView code={content} filePath={filePath} />
      )}
    </div>
  )
}

function extractMockupDirectory(result?: ToolResultBlock): string | undefined {
  if (!result?.toolResult) return undefined
  const match = result.toolResult.match(/Directory:\s*(\S+)/)
  return match ? match[1] : undefined
}

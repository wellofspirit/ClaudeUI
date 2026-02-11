import { useState, useMemo } from 'react'
import type { ContentBlock } from '../../../../shared/types'
import { useSessionStore } from '../../stores/session-store'
import { MarkdownRenderer } from './MarkdownRenderer'

interface Props {
  block: ContentBlock
  result?: ContentBlock
}

interface ParsedUsage {
  totalTokens: number | null
  toolUses: number | null
  durationMs: number | null
}

const USAGE_RE = /<usage>\s*([\s\S]*?)\s*<\/usage>/

function parseUsage(text: string): { body: string; usage: ParsedUsage | null } {
  const match = text.match(USAGE_RE)
  if (!match) return { body: text, usage: null }

  const body = text.replace(USAGE_RE, '').trimEnd()
  const block = match[1]

  const get = (key: string): number | null => {
    const m = block.match(new RegExp(`${key}:\\s*(\\d+)`))
    return m ? Number(m[1]) : null
  }

  return {
    body,
    usage: {
      totalTokens: get('total_tokens'),
      toolUses: get('tool_uses'),
      durationMs: get('duration_ms')
    }
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const rem = Math.round(s % 60)
  return `${m}m ${rem}s`
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}m ${s}s`
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

export function TaskCard({ block, result }: Props): React.JSX.Element {
  const taskProgressMap = useSessionStore((s) => s.taskProgressMap)
  const openTaskPanel = useSessionStore((s) => s.openTaskPanel)
  const [expanded, setExpanded] = useState(false)

  const toolUseId = block.toolUseId || ''
  const input = block.toolInput || {}
  const hasResult = !!result
  const isError = result?.isError ?? false
  const isRunning = !hasResult

  const description = String(input.description || input.prompt || '').slice(0, 120)
  const subagentType = String(input.subagent_type || input.subagentType || '')
  const model = input.model ? String(input.model) : null
  const isBackground = !!input.run_in_background

  const progress = taskProgressMap[toolUseId]
  const elapsed = progress?.elapsedTimeSeconds

  const { body: resultBody, usage } = useMemo(
    () => parseUsage(result?.toolResult || ''),
    [result?.toolResult]
  )

  const borderColor = isRunning
    ? 'border-accent/30'
    : isError
      ? 'border-danger/30'
      : 'border-success/30'

  const statusIcon = isError ? (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-danger shrink-0">
      <circle cx="12" cy="12" r="10" />
      <line x1="15" y1="9" x2="9" y2="15" />
      <line x1="9" y1="9" x2="15" y2="15" />
    </svg>
  ) : hasResult ? (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-success shrink-0">
      <circle cx="12" cy="12" r="10" />
      <polyline points="8 12 11 15 16 9" />
    </svg>
  ) : (
    <span className="w-3 h-3 rounded-full border-2 border-accent border-t-transparent shrink-0 animate-spin-slow" />
  )

  return (
    <div className={`rounded-lg border ${borderColor} bg-bg-secondary overflow-hidden`}>
      {/* Header — always visible, clickable to expand/collapse */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 h-9 hover:bg-bg-hover transition-colors cursor-pointer"
      >
        {statusIcon}
        <span className="font-medium text-[13px] text-accent shrink-0">Task</span>
        <span className="text-text-secondary text-[12px] truncate flex-1 text-left">{description}</span>
        {elapsed != null && (
          <span className="text-[11px] text-text-muted font-mono shrink-0">{formatElapsed(elapsed)}</span>
        )}
        <svg
          width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          className="text-text-secondary shrink-0 transition-transform duration-150"
          style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)' }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {/* Collapsed footer */}
      {!expanded && (hasResult || isRunning) && (
        <div className="flex items-center px-3 pt-1 pb-2 gap-1.5">
          {subagentType && (
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-accent/10 text-accent">
              {subagentType}
            </span>
          )}
          {model && (
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-bg-tertiary text-text-secondary">
              {model}
            </span>
          )}
          {isBackground && (
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-warning/10 text-warning">
              background
            </span>
          )}
          {/* Usage stats inline when collapsed */}
          {usage && (
            <span className="text-[10px] font-mono text-text-secondary">
              {[
                usage.totalTokens != null && `${formatTokens(usage.totalTokens)} tokens`,
                usage.toolUses != null && `${usage.toolUses} tools`,
                usage.durationMs != null && formatDuration(usage.durationMs)
              ].filter(Boolean).join(' · ')}
            </span>
          )}
          <div className="flex-1" />
          <button
            onClick={() => openTaskPanel(toolUseId)}
            className="text-[11px] text-accent hover:underline cursor-pointer"
          >
            Open in panel
          </button>
        </div>
      )}

      {/* Expanded content */}
      {expanded && (
        <>
          {/* Result / running state */}
          <div className="border-t border-border">
            {resultBody ? (
              <div className="px-3 py-2 text-[12px] text-text-primary/70">
                <div className="leading-[1.5] max-h-[300px] overflow-y-auto">
                  <MarkdownRenderer content={resultBody} />
                </div>
              </div>
            ) : isRunning ? (
              <div className="px-3 py-2 flex items-center gap-2 text-[12px] text-text-muted">
                <span className="w-2.5 h-2.5 rounded-full border-[1.5px] border-accent border-t-transparent animate-spin-slow" />
                <span>Running...</span>
                {elapsed != null && (
                  <span className="font-mono text-[11px]">{formatElapsed(elapsed)}</span>
                )}
              </div>
            ) : null}
          </div>

          {/* Footer — badges + usage + open in panel */}
          {(hasResult || isRunning) && (
            <div className="border-t border-border px-3 py-1.5 flex items-center gap-1.5">
              {subagentType && (
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-accent/10 text-accent">
                  {subagentType}
                </span>
              )}
              {model && (
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-bg-tertiary text-text-secondary">
                  {model}
                </span>
              )}
              {isBackground && (
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-warning/10 text-warning">
                  background
                </span>
              )}
              {usage && (
                <span className="text-[10px] font-mono text-text-secondary ml-1">
                  {[
                    usage.totalTokens != null && `${formatTokens(usage.totalTokens)} tokens`,
                    usage.toolUses != null && `${usage.toolUses} tools`,
                    usage.durationMs != null && formatDuration(usage.durationMs)
                  ].filter(Boolean).join(' · ')}
                </span>
              )}
              <div className="flex-1" />
              <button
                onClick={() => openTaskPanel(toolUseId)}
                className="text-[11px] text-accent hover:underline cursor-pointer"
              >
                Open in panel
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

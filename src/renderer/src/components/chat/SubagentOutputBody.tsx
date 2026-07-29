import { useState } from 'react'
import type { ChatMessage } from '../../../../shared/types'
import { useSessionStore } from '../../stores/session-store'
import { MarkdownRenderer } from './MarkdownRenderer'
import { SubagentMessages } from './SubagentMessages'

interface Props {
  msgs: ChatMessage[]
  streamThinking: string
  streamText: string
  isRunning: boolean
  isBackground: boolean
  /** Pre-formatted elapsed label (each caller has its own formatElapsed — kept
   *  out of this shared component to avoid a cross-directory import). */
  elapsedLabel?: string
  /** Visual density: 'sm' for the compact inline TaskCard, 'md' for the
   *  full-height TaskDetailPanel entry. Purely cosmetic (text/spinner size). */
  size?: 'sm' | 'md'
}

const LIVE_THINKING_TAIL_CHARS = 200

/**
 * Live streaming-thinking preview. Mirrors chat/ThinkingBlock.tsx's toggle
 * semantics (seed once from settings.expandThinking, let the user override
 * for this instance) but for a growing raw-text buffer rather than a
 * finished, durationed block: collapsed shows a short tail as the summary
 * line itself; expanded shows the full buffer in a scrollable region.
 */
function LiveThinking({ text }: { text: string }): React.JSX.Element {
  const expandThinking = useSessionStore((s) => s.settings.expandThinking)
  const [expanded, setExpanded] = useState(expandThinking)

  return (
    <div data-testid="SubagentOutputBody.liveThinking" className="mb-1.5">
      <button
        type="button"
        data-testid="SubagentOutputBody.liveThinking.toggle"
        onClick={() => setExpanded(!expanded)}
        className="block w-full text-left text-[12px] text-text-secondary/60 italic cursor-pointer hover:text-text-secondary/80 select-none truncate"
      >
        {expanded ? 'Thinking...' : text.slice(-LIVE_THINKING_TAIL_CHARS)}
      </button>
      {expanded && (
        <div className="mt-1 text-[12px] text-text-secondary/60 italic whitespace-pre-wrap max-h-80 overflow-y-auto">
          {text}
        </div>
      )}
    </div>
  )
}

/**
 * Shared "expanded body" for a running/completed subagent task, used by both
 * TaskCard (chat view card) and TaskEntry (TaskDetailPanel panel view). Order
 * mirrors ChatPanel's main-view convention: accumulated message list, THEN
 * live thinking, THEN live streamed text — never the reverse.
 */
export function SubagentOutputBody({
  msgs,
  streamThinking,
  streamText,
  isRunning,
  isBackground,
  elapsedLabel,
  size = 'sm'
}: Props): React.JSX.Element {
  const isCompact = size === 'sm'

  return (
    <>
      {isRunning && isBackground && (
        <div
          className={`flex items-center gap-2 text-text-muted mb-2 ${isCompact ? 'text-[12px]' : 'text-[13px]'}`}
        >
          <span
            className={`rounded-full border-accent border-t-transparent animate-spin-slow ${
              isCompact ? 'w-2.5 h-2.5 border-[1.5px]' : 'w-3 h-3 border-2'
            }`}
          />
          <span>Running in background...</span>
          {elapsedLabel && <span className="font-mono text-[11px]">{elapsedLabel}</span>}
        </div>
      )}
      {msgs.length > 0 && <SubagentMessages messages={msgs} maxHeight="none" />}
      {streamThinking && <LiveThinking text={streamThinking} />}
      {streamText && (
        <div className="text-[12px] text-text-primary/80 leading-[1.6] mt-1">
          <MarkdownRenderer content={streamText} />
          <span className="inline-block w-[2px] h-[14px] bg-accent ml-0.5 align-middle animate-cursor-blink" />
        </div>
      )}
    </>
  )
}

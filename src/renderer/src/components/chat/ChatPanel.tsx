import { useRef, useEffect } from 'react'
import { useActiveSession, useSessionStore } from '../../stores/session-store'
import { MessageBubble } from './MessageBubble'
import { StreamingText } from './StreamingText'
import { ThinkingBlock } from './ThinkingBlock'
import { InputBox } from './InputBox'
import { TodoWidget } from '../TodoWidget'
import { FloatingApproval } from './FloatingApproval'
import { FloatingError } from './FloatingError'
import { WindowControls } from '../WindowControls'

export function ChatPanel(): React.JSX.Element {
  const messages = useActiveSession((s) => s.messages)
  const streamingText = useActiveSession((s) => s.streamingText)
  const streamingThinking = useActiveSession((s) => s.streamingThinking)
  const thinkingStartedAt = useActiveSession((s) => s.thinkingStartedAt)
  const pendingApprovals = useActiveSession((s) => s.pendingApprovals)
  const status = useActiveSession((s) => s.status)

  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Scroll to bottom when switching sessions
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [activeSessionId])

  // Auto-scroll on new content if near bottom
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 400
    if (isNearBottom) {
      setTimeout(() => el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }), 50)
    }
  }, [messages, streamingText, thinkingStartedAt, pendingApprovals])

  const hasContent = messages.length > 0 || !!streamingText || !!thinkingStartedAt
  const showEmptyScreen = !hasContent && status.state === 'idle'

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0 relative">
      {/* Top bar */}
      <TopBar hasContent={hasContent} cost={status.totalCostUsd} />

      {/* Main area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {showEmptyScreen ? (
          <div className="h-full flex items-center justify-center">
            <WelcomeState />
          </div>
        ) : !hasContent && status.state === 'running' ? (
          <div className="h-full flex items-center justify-center">
            <LoadingState />
          </div>
        ) : (
          <div className="max-w-[740px] mx-auto px-8 pt-5 pb-36 flex flex-col gap-5">
            {messages.map((msg) => (
              <MessageBubble key={msg.id} message={msg} />
            ))}
            {streamingText && <StreamingText />}
            {thinkingStartedAt && (
              <ThinkingBlock text={streamingThinking} isActive />
            )}
            {!streamingText && !thinkingStartedAt && status.state === 'running' && <TypingIndicator />}
          </div>
        )}
      </div>

      {/* Todo widget */}
      <TodoWidget />

      {/* Floating approval for sub-agent tool calls */}
      <FloatingApproval />

      {/* Floating error */}
      <FloatingError />

      {/* Input — fixed at bottom, centered */}
      <div className="absolute bottom-0 left-0 right-0 pointer-events-none">
        <div className="pointer-events-auto">
          <InputBox />
        </div>
      </div>
    </div>
  )
}

function TopBar({ hasContent, cost }: { hasContent: boolean; cost: number }): React.JSX.Element {
  const cwd = useActiveSession((s) => s.cwd)
  return (
    <div style={{ padding: '0 13px' }} className="shrink-0 h-12 flex items-center justify-between [-webkit-app-region:drag] border-b border-border">
      <span className="text-[13px] text-text-secondary font-normal [-webkit-app-region:no-drag]">
        {!cwd ? 'New thread' : hasContent ? 'Thread' : 'New thread'}
      </span>
      <div className="flex items-center gap-3 [-webkit-app-region:no-drag]">
        {cost > 0 && (
          <span className="text-[11px] text-text-muted font-mono">${cost.toFixed(4)}</span>
        )}
        <WindowControls />
      </div>
    </div>
  )
}

function WelcomeState(): React.JSX.Element {
  const cwd = useActiveSession((s) => s.cwd)

  return (
    <div className="flex flex-col items-center gap-4 -mt-16 animate-fade-in">
      {/* Icon */}
      <div style={{ width: 56, height: 56, borderRadius: 16 }} className="bg-bg-tertiary border border-border flex items-center justify-center">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-accent">
          <path d="M12 2L2 7l10 5 10-5-10-5z" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M2 17l10 5 10-5" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M2 12l10 5 10-5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>

      {/* Title */}
      <p className="text-[22px] text-text-secondary font-light tracking-tight">Let's build</p>

      {/* Current directory */}
      {cwd && (
        <span className="text-[15px] text-text-muted">
          {cwd.split(/[\\/]/).pop() || cwd}
        </span>
      )}
    </div>
  )
}

function LoadingState(): React.JSX.Element {
  return (
    <div className="flex items-center gap-2.5 -mt-16 animate-fade-in">
      <div className="flex gap-[3px]">
        {[0, 200, 400].map((delay) => (
          <span key={delay} className="w-[5px] h-[5px] rounded-full bg-accent" style={{ animation: 'pulse-dot 1.4s infinite', animationDelay: `${delay}ms` }} />
        ))}
      </div>
      <span className="text-[13px] text-text-muted">Thinking...</span>
    </div>
  )
}

function TypingIndicator(): React.JSX.Element {
  return (
    <div className="flex items-start animate-fade-in">
      <div className="bg-bg-tertiary rounded-2xl px-4 py-3 flex items-center gap-[5px]">
        {[0, 150, 300].map((delay) => (
          <span
            key={delay}
            className="w-[7px] h-[7px] rounded-full bg-text-muted"
            style={{ animation: 'typing-bounce 1.4s infinite', animationDelay: `${delay}ms` }}
          />
        ))}
      </div>
    </div>
  )
}

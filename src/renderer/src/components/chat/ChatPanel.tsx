import { useRef, useEffect, useState } from 'react'
import { useSessionStore } from '../../stores/session-store'
import { MessageBubble } from './MessageBubble'
import { StreamingText } from './StreamingText'
import { ThinkingBlock } from './ThinkingBlock'
import { InputBox } from './InputBox'
import { TodoWidget } from '../TodoWidget'
import { FloatingApproval } from './FloatingApproval'
import { WindowControls } from '../WindowControls'

export function ChatPanel(): React.JSX.Element {
  const messages = useSessionStore((s) => s.messages)
  const streamingText = useSessionStore((s) => s.streamingText)
  const streamingThinking = useSessionStore((s) => s.streamingThinking)
  const thinkingStartedAt = useSessionStore((s) => s.thinkingStartedAt)
  const pendingApprovals = useSessionStore((s) => s.pendingApprovals)
  const status = useSessionStore((s) => s.status)
  const error = useSessionStore((s) => s.error)
  const scrollRef = useRef<HTMLDivElement>(null)

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

      {/* Error banner + Input — fixed at bottom, centered */}
      <div className="absolute bottom-0 left-0 right-0 pointer-events-none">
        <div className="pointer-events-auto">
          {error && (
            <div className="px-5 pb-2">
              <div className="max-w-[740px] mx-auto text-[12px] text-danger bg-danger/5 border border-danger/15 rounded-lg px-3 py-2">
                {error}
              </div>
            </div>
          )}
          <InputBox />
        </div>
      </div>
    </div>
  )
}

function TopBar({ hasContent, cost }: { hasContent: boolean; cost: number }): React.JSX.Element {
  const cwd = useSessionStore((s) => s.cwd)
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
  const cwd = useSessionStore((s) => s.cwd)
  const recentDirs = useSessionStore((s) => s.recentDirs)
  const openDirectory = useSessionStore((s) => s.openDirectory)
  const [dropdownOpen, setDropdownOpen] = useState(false)

  const handlePickFolder = async (): Promise<void> => {
    setDropdownOpen(false)
    const folder = await window.api.pickFolder()
    if (folder) {
      await window.api.createSession(folder)
      openDirectory(folder)
    }
  }

  const handleSelectDir = async (dir: string): Promise<void> => {
    setDropdownOpen(false)
    await window.api.createSession(dir)
    openDirectory(dir)
  }

  const currentLabel = cwd
    ? cwd.split(/[\\/]/).pop() || cwd
    : 'Select a folder'

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

      {/* Directory dropdown */}
      <div className="relative">
        <button
          onClick={() => recentDirs.length > 0 ? setDropdownOpen(!dropdownOpen) : handlePickFolder()}
          className="flex items-center gap-1.5 text-[15px] text-text-muted hover:text-text-secondary transition-colors cursor-pointer"
        >
          <span>{currentLabel}</span>
          {recentDirs.length > 0 && (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          )}
        </button>

        {dropdownOpen && (
          <div className="absolute top-full mt-1 left-1/2 -translate-x-1/2 w-64 bg-bg-tertiary border border-border rounded-lg overflow-hidden shadow-lg shadow-black/30 z-10">
            {recentDirs.map((dir) => (
              <button
                key={dir}
                onClick={() => handleSelectDir(dir)}
                className="w-full flex items-center gap-2 px-3 h-8 text-[12px] text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer text-left"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="shrink-0 text-text-muted" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                </svg>
                <span className="truncate">{dir.split(/[\\/]/).pop() || dir}</span>
              </button>
            ))}
            <div className="border-t border-border">
              <button
                onClick={handlePickFolder}
                className="w-full flex items-center gap-2 px-3 h-8 text-[12px] text-text-muted hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="shrink-0" strokeLinecap="round">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                <span>Open another folder...</span>
              </button>
            </div>
          </div>
        )}
      </div>
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


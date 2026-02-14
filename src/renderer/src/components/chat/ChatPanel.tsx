import { useRef, useEffect, useState, useMemo, useCallback } from 'react'
import { v4 as uuid } from 'uuid'
import { useActiveSession, useSessionStore } from '../../stores/session-store'
import { MessageBubble } from './MessageBubble'
import { StreamingText } from './StreamingText'
import { ThinkingBlock } from './ThinkingBlock'
import { InputBox } from './InputBox'
import { TodoWidget } from '../TodoWidget'
import { FloatingApproval } from './FloatingApproval'
import { FloatingError } from './FloatingError'
import { WindowControls } from '../WindowControls'
import { useSidebarCollapsed } from '../SessionView'

export function ChatPanel(): React.JSX.Element {
  const messages = useActiveSession((s) => s.messages)
  const streamingText = useActiveSession((s) => s.streamingText)
  const streamingThinking = useActiveSession((s) => s.streamingThinking)
  const thinkingStartedAt = useActiveSession((s) => s.thinkingStartedAt)
  const pendingApprovals = useActiveSession((s) => s.pendingApprovals)
  const status = useActiveSession((s) => s.status)

  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [isAtBottom, setIsAtBottom] = useState(true)

  const checkAtBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setIsAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 100)
  }, [])

  // Track scroll position
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.addEventListener('scroll', checkAtBottom, { passive: true })
    return () => el.removeEventListener('scroll', checkAtBottom)
  }, [checkAtBottom])

  // Scroll to bottom when switching sessions
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    setIsAtBottom(true)
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

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [])

  const chatFontScale = useSessionStore((s) => s.settings.chatFontScale)
  const uiFontScale = useSessionStore((s) => s.settings.uiFontScale)
  const chatWidthMode = useSessionStore((s) => s.settings.chatWidthMode)
  const chatWidthPx = useSessionStore((s) => s.settings.chatWidthPx)
  const chatWidthPercent = useSessionStore((s) => s.settings.chatWidthPercent)
  const chatMaxWidth = chatWidthMode === 'px' ? `${chatWidthPx}px` : `${chatWidthPercent}%`
  // Chat area lives inside the UI-zoomed root, so compensate: divide out uiFontScale, apply chatFontScale
  const chatZoom = chatFontScale / uiFontScale
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
          <div style={{ ...(chatZoom !== 1 ? { zoom: chatZoom } : {}), maxWidth: chatMaxWidth }} className="mx-auto px-8 pt-5 pb-36 flex flex-col gap-5">
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
        {/* Go to bottom button */}
        {!isAtBottom && hasContent && (
          <div className="flex justify-center mb-1.5 pointer-events-auto">
            <button
              onClick={scrollToBottom}
              className="w-8 h-8 flex items-center justify-center rounded-full bg-bg-tertiary border border-border text-text-muted hover:text-text-primary hover:bg-bg-hover shadow-lg transition-all cursor-default animate-fade-in"
              title="Scroll to bottom"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
          </div>
        )}
        <div className="pointer-events-auto">
          <InputBox />
        </div>
      </div>
    </div>
  )
}

function TopBar({ hasContent, cost }: { hasContent: boolean; cost: number }): React.JSX.Element {
  const cwd = useActiveSession((s) => s.cwd)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const customTitle = useSessionStore((s) => activeSessionId ? s.customTitles[activeSessionId] : undefined)
  const { collapsed: sidebarCollapsed, toggle: toggleSidebar } = useSidebarCollapsed()
  const showWelcome = useSessionStore((s) => s.showWelcome)
  const isMac = window.api.platform === 'darwin'
  const leftPadding = sidebarCollapsed && isMac ? 148 : 13
  return (
    <div style={{ paddingLeft: leftPadding, paddingRight: 13 }} className="shrink-0 h-12 flex items-center justify-between [-webkit-app-region:drag] border-b border-border relative">
      <div className="flex items-center min-w-0">
        {sidebarCollapsed && (
          <div
            style={isMac ? { position: 'absolute', left: 82, top: '50%', transform: 'translateY(-50%)' } : { marginRight: 8 }}
            className="[-webkit-app-region:no-drag] flex items-center gap-1"
          >
            <button
              onClick={toggleSidebar}
              className="w-[26px] h-[26px] flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
              title="Show sidebar"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="M9 3v18" />
                <path d="M14 9l3 3-3 3" />
              </svg>
            </button>
            <button
              onClick={showWelcome}
              className="w-[26px] h-[26px] flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
              title="New session"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                <path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4z" />
              </svg>
            </button>
          </div>
        )}
        <span className="text-[13px] text-text-secondary font-normal [-webkit-app-region:no-drag] truncate">
          {!cwd ? 'New session' : hasContent ? (customTitle || 'Session') : 'New session'}
        </span>
      </div>
      <div className="flex items-center gap-3 [-webkit-app-region:no-drag]">
        {cwd && (
          <button
            onClick={() => window.api.openInVSCode(cwd)}
            className="group flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
            title="Open in VS Code"
          >
            <svg width="14" height="14" viewBox="0 0 100 100" fill="none" className="shrink-0 -mt-px transition-opacity">
              <mask id="vsc" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
                <path fillRule="evenodd" clipRule="evenodd" d="M70.912 99.317a6.223 6.223 0 004.96-.19l20.589-9.907A6.25 6.25 0 00100 83.587V16.413a6.25 6.25 0 00-3.539-5.633L75.872.873a6.226 6.226 0 00-7.109 1.318L29.355 38.044 12.187 25.02a4.162 4.162 0 00-5.318.27L1.382 30.308a4.168 4.168 0 00-.005 6.146L16.674 50 1.377 63.546a4.168 4.168 0 00.005 6.146l5.487 5.018a4.162 4.162 0 005.318.27l17.168-13.024 39.408 35.853a6.213 6.213 0 002.149 1.508zM75.015 27.3L45.11 50l29.906 22.7V27.3z" fill="#fff"/>
              </mask>
              <g mask="url(#vsc)">
                <path d="M96.461 10.796L75.857.873a6.23 6.23 0 00-7.108 1.318l-67.37 61.354a4.167 4.167 0 00.006 6.146l5.487 5.018a4.163 4.163 0 005.318.27L96.47 10.87l-.009-.073z" className="fill-current group-hover:fill-[#0065A9] transition-colors"/>
                <path d="M96.461 89.204L75.857 99.127a6.23 6.23 0 01-7.108-1.318L1.38 36.455a4.167 4.167 0 01.006-6.146l5.487-5.018a4.163 4.163 0 015.318-.27L96.47 89.13l-.009.073z" className="fill-current group-hover:fill-[#007ACC] transition-colors"/>
                <path d="M75.857 99.127a6.226 6.226 0 01-7.108-1.318C73.952 102.61 81.25 98.28 81.25 91.667V8.333c0-6.614-7.298-10.943-12.5-6.142a6.226 6.226 0 017.108-1.318l20.604 9.923A6.25 6.25 0 01100 16.43v67.14a6.25 6.25 0 01-3.538 5.634l-20.605 9.923z" className="fill-current group-hover:fill-[#1F9CF0] transition-colors"/>
              </g>
            </svg>
            <span>VSCode</span>
          </button>
        )}
        {cost > 0 && (
          <span className="text-[11px] text-text-muted font-mono">${cost.toFixed(4)}</span>
        )}
        <WindowControls />
      </div>
    </div>
  )
}

const WELCOME_PHRASES = [
  "Let's build",
  "What's the plan?",
  "Ready when you are",
  "Where to next?",
  "Let's ship it",
  "What shall we make?",
  "Got an idea?",
  "Let's get started",
  "What's on your mind?",
  "Time to create",
]

function WelcomeState(): React.JSX.Element {
  const cwd = useActiveSession((s) => s.cwd)
  const directories = useSessionStore((s) => s.directories)
  const createNewSession = useSessionStore((s) => s.createNewSession)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const [dropdownOpen, setDropdownOpen] = useState(false)

  // Pick a random phrase each time welcome view appears
  const phrase = useMemo(
    () => WELCOME_PHRASES[Math.floor(Math.random() * WELCOME_PHRASES.length)],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeSessionId]
  )

  const handleSelectDir = (dirCwd: string): void => {
    const routingId = uuid()
    createNewSession(routingId, dirCwd)
    setDropdownOpen(false)
  }

  const handleBrowse = async (): Promise<void> => {
    setDropdownOpen(false)
    const folder = await window.api.pickFolder()
    if (folder) {
      const routingId = uuid()
      createNewSession(routingId, folder)
    }
  }

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
      <p className="text-[22px] text-text-secondary font-light tracking-tight">{phrase}</p>

      {/* Directory dropdown */}
      {!cwd && (
        <div className="relative">
          <button
            onClick={() => setDropdownOpen(!dropdownOpen)}
            className="flex items-center gap-1 text-[14px] text-accent hover:text-accent/80 transition-colors cursor-default"
          >
            <span>Select a project folder</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="mt-px">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>

          {dropdownOpen && (
            <>
              {/* Backdrop */}
              <div className="fixed inset-0 z-10" onClick={() => setDropdownOpen(false)} />

              {/* Dropdown menu */}
              <div className="absolute top-full left-1/2 -translate-x-1/2 mt-1 w-72 max-h-64 overflow-y-auto rounded-lg bg-bg-tertiary border border-border shadow-lg z-20">
                {directories.map((group) => (
                  <button
                    key={group.projectKey || group.cwd}
                    onClick={() => handleSelectDir(group.cwd)}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-[13px] text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors text-left cursor-default"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-text-muted">
                      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                    </svg>
                    <div className="flex flex-col min-w-0">
                      <span className="truncate">{group.folderName}</span>
                      <span className="text-[11px] text-text-muted truncate">{group.cwd}</span>
                    </div>
                  </button>
                ))}

                {directories.length > 0 && <div className="border-t border-border" />}

                <button
                  onClick={handleBrowse}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-[13px] text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors text-left cursor-default"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="shrink-0 text-text-muted">
                    <circle cx="11" cy="11" r="8" />
                    <path d="M21 21l-4.35-4.35" />
                  </svg>
                  <span>Browse...</span>
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Current directory (when session already has one) */}
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

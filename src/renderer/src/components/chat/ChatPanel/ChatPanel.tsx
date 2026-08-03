import { useRef, useEffect, useState, useMemo, useCallback } from 'react'
import {
  useActiveSession,
  useSessionStore,
  useFocusedAgentData
} from '../../../stores/session-store'
import { MessageBubble } from '../MessageBubble'
import { StreamingText } from '../StreamingText'
import { ThinkingBlock } from '../ThinkingBlock'
import { InputBox } from '../InputBox'
import { TodoWidget } from '../../TodoWidget'
import { SentFilesWidget } from '../../SentFilesWidget'
import { FloatingApproval } from '../FloatingApproval'
import { BtwCard } from '../BtwCard'
import { FloatingError } from '../FloatingError'
import { VendorAuthRequiredCard } from '../VendorAuthRequiredCard'
import { AuthBanner } from '../AuthBanner'
import { SandboxViolationToast } from '../SandboxViolationToast'
import { useIsMobile } from '../../../hooks/useIsMobile'
import { TopBar } from './TopBar'
import { WelcomeState } from './WelcomeState'
import { QueuedMessageCard } from './QueuedMessageCard'
import { ChatSearchOverlay } from '../ChatSearch'

export function ChatPanel(): React.JSX.Element {
  const focusedData = useFocusedAgentData()
  const messages = focusedData.messages
  const hasStreamingText = !!focusedData.streamingText
  const streamingThinking = focusedData.streamingThinking
  const thinkingStartedAt = focusedData.thinkingStartedAt
  const pendingApprovals = useActiveSession((s) => s.pendingApprovals)
  const status = useActiveSession((s) => s.status)

  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [isAtBottom, setIsAtBottom] = useState(true)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  const shouldAutoScroll = useRef(true)
  const lastScrollTop = useRef(0)
  const isAutoScrolling = useRef(false)
  const wasNearBottom = useRef(true)

  const checkAtBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight

    if (!isAutoScrolling.current) {
      if (el.scrollTop < lastScrollTop.current - 10) {
        shouldAutoScroll.current = false
      } else if (distFromBottom < 100) {
        shouldAutoScroll.current = true
      }
    }
    lastScrollTop.current = el.scrollTop

    const nearBottom = distFromBottom < 100
    wasNearBottom.current = nearBottom
    setIsAtBottom(nearBottom)
  }, [])

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
    shouldAutoScroll.current = true
    setIsAtBottom(true)

    el.scrollTop = el.scrollHeight
    lastScrollTop.current = el.scrollTop

    const timers = [
      requestAnimationFrame(() => {
        if (el) {
          el.scrollTop = el.scrollHeight
          lastScrollTop.current = el.scrollTop
        }
      }),
      setTimeout(() => {
        requestAnimationFrame(() => {
          if (el) {
            el.scrollTop = el.scrollHeight
            lastScrollTop.current = el.scrollTop
          }
        })
      }, 80) as unknown as number
    ]
    return () => {
      cancelAnimationFrame(timers[0])
      clearTimeout(timers[1])
    }
  }, [activeSessionId])

  const smoothGuardRaf = useRef(0)
  const smoothGuardTimeout = useRef<ReturnType<typeof setTimeout>>(null)
  const doAutoScroll = useCallback((el: HTMLDivElement, smooth = true) => {
    isAutoScrolling.current = true
    cancelAnimationFrame(smoothGuardRaf.current)
    if (smoothGuardTimeout.current) clearTimeout(smoothGuardTimeout.current)
    if (smooth) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
      const clearGuard = (): void => {
        const dist = el.scrollHeight - el.scrollTop - el.clientHeight
        if (dist < 10) {
          isAutoScrolling.current = false
          lastScrollTop.current = el.scrollTop
          wasNearBottom.current = true
        } else {
          smoothGuardRaf.current = requestAnimationFrame(clearGuard)
        }
      }
      smoothGuardRaf.current = requestAnimationFrame(clearGuard)
      smoothGuardTimeout.current = setTimeout(() => {
        cancelAnimationFrame(smoothGuardRaf.current)
        isAutoScrolling.current = false
        lastScrollTop.current = el.scrollTop
        wasNearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100
      }, 500)
    } else {
      el.scrollTop = el.scrollHeight
      lastScrollTop.current = el.scrollTop
      wasNearBottom.current = true
      requestAnimationFrame(() => {
        isAutoScrolling.current = false
      })
    }
  }, [])

  // Universal auto-scroll via MutationObserver
  const scrollRafRef = useRef(0)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    const scheduleScroll = (): void => {
      cancelAnimationFrame(scrollRafRef.current)
      scrollRafRef.current = requestAnimationFrame(() => {
        if (!el) return
        const dist = el.scrollHeight - el.scrollTop - el.clientHeight
        setIsAtBottom(dist < 100)
        if (!shouldAutoScroll.current && wasNearBottom.current) {
          shouldAutoScroll.current = true
        }
        if (shouldAutoScroll.current) doAutoScroll(el, true)
      })
    }

    const observer = new MutationObserver(scheduleScroll)
    observer.observe(el, { childList: true, subtree: true, characterData: true })

    let lastScrollHeight = el.scrollHeight
    const resizeObserver = new ResizeObserver(() => {
      if (el.scrollHeight === lastScrollHeight) return
      lastScrollHeight = el.scrollHeight
      scheduleScroll()
    })
    resizeObserver.observe(el)

    return () => {
      observer.disconnect()
      resizeObserver.disconnect()
      cancelAnimationFrame(scrollRafRef.current)
    }
  }, [doAutoScroll])

  useEffect(() => {
    if (!activeSessionId) return
    const handler = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [activeSessionId])

  // Close search overlay when switching sessions
  useEffect(() => {
    setSearchOpen(false)
  }, [activeSessionId])

  useEffect(() => {
    if (searchOpen) {
      shouldAutoScroll.current = false
    }
  }, [searchOpen])

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    shouldAutoScroll.current = true
    doAutoScroll(el, true)
  }, [doAutoScroll])

  const chatFontScale = useSessionStore((s) => s.settings.chatFontScale)
  const uiFontScale = useSessionStore((s) => s.settings.uiFontScale)
  const chatWidthMode = useSessionStore((s) => s.settings.chatWidthMode)
  const chatWidthPx = useSessionStore((s) => s.settings.chatWidthPx)
  const chatWidthPercent = useSessionStore((s) => s.settings.chatWidthPercent)
  const isMobile = useIsMobile()
  const chatMaxWidth = isMobile
    ? '100%'
    : chatWidthMode === 'px'
      ? `${chatWidthPx}px`
      : `${chatWidthPercent}%`
  const chatZoom = chatFontScale / uiFontScale
  const hasContent = messages.length > 0 || hasStreamingText || !!thinkingStartedAt
  const showEmptyScreen = !hasContent && status.state === 'idle'

  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') return messages[i].id
    }
    return null
  }, [messages])

  return (
    <div data-testid="ChatPanel" className="flex-1 flex flex-col min-h-0 min-w-0 relative">
      <TopBar hasContent={hasContent} />
      <AuthBanner />

      <div className="flex-1 flex flex-col min-h-0 relative">
        <ChatSearchOverlay
          scrollRef={scrollRef}
          active={searchOpen}
          query={searchQuery}
          onQueryChange={setSearchQuery}
          onClose={() => setSearchOpen(false)}
        />
        <div className="h-8 bg-gradient-to-b from-bg-primary to-transparent pointer-events-none -mb-8 relative z-[1]" />

        <div ref={scrollRef} className="flex-1 overflow-y-auto chat-scroll mr-2">
          {showEmptyScreen ? (
            <div className="h-full flex items-center justify-center">
              <WelcomeState />
            </div>
          ) : !hasContent && status.state === 'running' ? (
            <div className="h-full flex items-center justify-center">
              <LoadingState />
            </div>
          ) : (
            <div
              style={{ ...(chatZoom !== 1 ? { zoom: chatZoom } : {}), maxWidth: chatMaxWidth }}
              className={`mx-auto pt-5 pb-6 flex flex-col gap-3 ${isMobile ? 'px-3' : 'px-8'}`}
            >
              {messages.map((msg) => (
                <div key={msg.id} className="cv-auto">
                  <MessageBubble
                    message={msg}
                    pendingApprovals={pendingApprovals}
                    isLastAssistant={msg.id === lastAssistantId}
                    thinkingStartedAt={thinkingStartedAt}
                  />
                </div>
              ))}
              <div className="flex flex-col gap-5">
                {hasStreamingText && <StreamingText />}
                {thinkingStartedAt && <ThinkingBlock text={streamingThinking} isActive />}
                {!hasStreamingText && !thinkingStartedAt && status.state === 'running' && (
                  <TypingIndicator />
                )}
              </div>
            </div>
          )}
        </div>

        <div className="h-8 bg-gradient-to-t from-bg-primary to-transparent pointer-events-none -mt-8 relative z-[1]" />

        <div className="relative z-[2]">
          {!isAtBottom && hasContent && (
            <div className="absolute -top-10 left-0 right-0 flex justify-center pointer-events-none z-[1]">
              <button
                data-testid="ChatPanel.scrollToBottom"
                onClick={scrollToBottom}
                className="pointer-events-auto w-8 h-8 flex items-center justify-center rounded-full bg-bg-tertiary border border-border text-text-muted hover:text-text-primary hover:bg-bg-hover shadow-lg transition-all cursor-default animate-fade-in"
                title="Scroll to bottom"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>
            </div>
          )}
          <QueuedMessageCard isMobile={isMobile} />
          <BtwCard isMobile={isMobile} />
          <InputBox />
        </div>
      </div>

      {/* Floating widget stack — each child renders null when it has nothing to
          show, so the gap only appears when both are live. Positioning lives
          here (not in the widgets) so the stack stays a single decision.
          Spans the panel (left-4/right-4) so the widgets' percentage widths
          resolve against the panel, not a shrink-wrapped box; pointer-events
          pass through the empty band, the widgets re-enable their own. */}
      <div className="absolute top-14 left-4 right-4 z-10 flex flex-col items-end gap-2 pointer-events-none">
        <TodoWidget />
        <SentFilesWidget />
      </div>
      <FloatingApproval />
      <VendorAuthRequiredCard />
      <FloatingError />
      <SandboxViolationToast />
    </div>
  )
}

// ── Presentational sub-components ───────────────────────────────────

function LoadingState(): React.JSX.Element {
  return (
    <div className="flex items-center gap-2.5 -mt-16 animate-fade-in">
      <div className="flex gap-[3px]">
        {[0, 200, 400].map((delay) => (
          <span
            key={delay}
            className="w-[5px] h-[5px] rounded-full bg-accent"
            style={{ animation: 'pulse-dot 1.4s infinite', animationDelay: `${delay}ms` }}
          />
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

import { useEffect, useLayoutEffect, useState, useMemo, useCallback } from 'react'
import { overlayItemStreams } from '../../../../../core/shared/sync/item-stream'
import {
  useActiveSession,
  useSessionStore,
  useFocusedAgentData
} from '../../../stores/session-store'
import { MessageBubble, TranscriptSessionProvider } from '../MessageBubble'
import { InputBox } from '../InputBox'
import { TodoWidget } from '../../TodoWidget'
import { SentFilesWidget } from '../../SentFilesWidget'
import { FloatingApproval } from '../FloatingApproval'
import { BtwCard } from '../BtwCard'
import { FloatingError } from '../FloatingError'
import { SandboxViolationToast } from '../SandboxViolationToast'
import { useIsMobile } from '../../../hooks/useIsMobile'
import { useStickToBottom } from '../../../hooks/useStickToBottom'
import { useSettledFlag } from '../../../hooks/useSettledFlag'
import {
  canUseFullscreenGesture,
  useFullscreenDoubleTap
} from '../../../hooks/useFullscreenDoubleTap'
import { ImageGalleryProvider } from '../../shared/ImageViewer'
import { DiagramGalleryProvider } from '../DiagramGallery'
import { TopBar } from './TopBar'
import { WelcomeState } from './WelcomeState'
import { reloadActiveTranscript } from '../../../lib/session-history-load'
import { QueuedMessageCard } from './QueuedMessageCard'
import { ChatSearchOverlay } from '../ChatSearch'
import { SEARCH_ANCHOR } from '../ChatSearch/search-scope'
import { bucketColumnWidth, defaultColumnWidth, type EstimateOptions } from './estimate-height'
import { useMessageHeightEstimator } from './use-message-height-estimator'

/** One-time discovery hint for the mobile-web double-tap fullscreen gesture. */
const FULLSCREEN_HINT_KEY = 'claudeui.hint.fullscreenDoubleTap'
/** The hint retires itself even if the user never acknowledges it. */
const FULLSCREEN_HINT_TIMEOUT_MS = 10_000
/**
 * How long "running, nothing streaming" must hold before the typing indicator
 * mounts. At the end of a turn the last item stream is removed one store commit
 * BEFORE `status.state` leaves 'running' (a 2-14 ms gap); mounting the ~27px
 * indicator row there makes the stick-to-bottom pin scroll to it, and the next
 * commit unmounts it and the view jumps back — a one-frame flicker. Any gap
 * between items is this short too; real "waiting for the model" lasts longer.
 */
const TYPING_INDICATOR_DELAY_MS = 150

function readFullscreenHintDismissed(): boolean {
  try {
    return window.localStorage.getItem(FULLSCREEN_HINT_KEY) === '1'
  } catch {
    // Private mode — show the hint, it just won't be remembered.
    return false
  }
}

function persistFullscreenHintDismissed(): void {
  try {
    window.localStorage.setItem(FULLSCREEN_HINT_KEY, '1')
  } catch {
    /* storage unavailable — the hint still stays hidden for this session */
  }
}

export function ChatPanel(): React.JSX.Element {
  const focusedData = useFocusedAgentData()
  const itemStreams = useActiveSession((s) => s.itemStreams)
  const messages = useMemo(
    () => overlayItemStreams(focusedData.messages, itemStreams),
    [focusedData.messages, itemStreams]
  )
  // The item's OWN start clock rides the open (`ActiveItemStream.startedAt`), so
  // a thinking block that begins after a tool call times from the thought rather
  // than from message creation. Absent for engines that do not measure it — the
  // bubble falls back to `message.timestamp`, the pre-existing behaviour.
  const activeThinkingByMessage = useMemo(() => {
    const slots = new Map<string, Array<{ index: number; startedAt?: number }>>()
    for (const stream of Object.values(itemStreams)) {
      if (stream.target.ownerToolUseId || stream.target.kind !== 'thinking') continue
      const current = slots.get(stream.target.messageId) ?? []
      current.push({ index: stream.target.blockIndex, startedAt: stream.startedAt })
      slots.set(stream.target.messageId, current)
    }
    return slots
  }, [itemStreams])
  const hasItemStreams = Object.values(itemStreams).some((s) => !s.target.ownerToolUseId)
  const pendingApprovals = useActiveSession((s) => s.pendingApprovals)
  const status = useActiveSession((s) => s.status)
  const showTypingIndicator = useSettledFlag(
    !hasItemStreams && status.state === 'running',
    TYPING_INDICATOR_DELAY_MS
  )
  const evicted = useActiveSession((s) => s.evicted)
  const transcriptLoadFailed = useActiveSession((s) => s.transcriptLoadFailed)

  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  // The find bar holds the view still: a search jump must not be pinned away
  // by a streaming turn.
  const {
    scrollerRef,
    contentRef: followContentRef,
    scrollerEl: scrollRef,
    isAtBottom,
    scrollToBottom,
    jumpToBottom,
    stopFollowing
  } = useStickToBottom<HTMLDivElement>({ paused: searchOpen })

  // Land at the bottom when switching sessions (and keep following from there).
  useLayoutEffect(() => {
    jumpToBottom()
  }, [activeSessionId, jumpToBottom])

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
    if (searchOpen) stopFollowing()
  }, [searchOpen, stopFollowing])

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
  const hasContent = messages.length > 0

  // What a never-rendered message is assumed to measure (`contain-intrinsic-size`,
  // see estimate-height.ts). The column is measured in the wrapper's own units from
  // the first message wrapper — the content div is padded and zoomed, a wrapper is
  // neither — and bucketed, so a window resize inside one bucket re-renders nothing.
  const [contentEl, setContentEl] = useState<HTMLElement | null>(null)
  const contentRef = useCallback(
    (el: HTMLElement | null) => {
      followContentRef(el)
      setContentEl(el)
    },
    [followContentRef]
  )
  const [measuredColumn, setMeasuredColumn] = useState<number | null>(null)
  useLayoutEffect(() => {
    if (!contentEl) return
    const measure = (): void => {
      const probe = contentEl.firstElementChild
      const width = probe instanceof HTMLElement ? probe.clientWidth : 0
      if (width > 0) setMeasuredColumn(bucketColumnWidth(width))
    }
    measure()
    // jsdom has no ResizeObserver.
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(contentEl)
    return () => observer.disconnect()
  }, [contentEl])
  const columnWidth =
    measuredColumn ?? defaultColumnWidth({ isMobile, mode: chatWidthMode, px: chatWidthPx })
  const expandToolCalls = useSessionStore((s) => s.settings.expandToolCalls)
  const expandReadResults = useSessionStore((s) => s.settings.expandReadResults)
  const expandThinking = useSessionStore((s) => s.settings.expandThinking)
  const hideToolInput = useSessionStore((s) => s.settings.hideToolInput)
  const toolOutputMaxChars = useSessionStore((s) => s.settings.toolOutputMaxChars)
  const engineId = useActiveSession((s) => s.status.engineId)
  const forkRow = useActiveSession((s) => s.status.capabilities.forkFromMessage)
  const estimateOptions = useMemo<EstimateOptions>(
    () => ({
      engineId,
      expandToolCalls,
      expandReadResults,
      expandThinking,
      hideToolInput,
      toolOutputMaxChars,
      forkRow
    }),
    [
      engineId,
      expandToolCalls,
      expandReadResults,
      expandThinking,
      hideToolInput,
      toolOutputMaxChars,
      forkRow
    ]
  )
  const estimateHeight = useMessageHeightEstimator(columnWidth, estimateOptions)
  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') return messages[i].id
    }
    return null
  }, [messages])
  // An evicted entry is empty because its transcript is not in memory, not because
  // the conversation is — the disk read that fills it is in flight or was
  // abandoned (ADR-087 §2). `WelcomeState` there would present an existing
  // conversation as a blank one with a live composer.
  const loadingTranscript = !hasContent && evicted
  const showEmptyScreen = !hasContent && !evicted && status.state === 'idle'

  // Mobile web only: double-tapping the chat toggles browser fullscreen (there
  // is no button — reclaiming the browser chrome is the whole point).
  const fullscreenGestureEnabled = canUseFullscreenGesture(isMobile)
  const [fullscreenHintDismissed, setFullscreenHintDismissed] = useState(
    readFullscreenHintDismissed
  )
  const dismissFullscreenHint = useCallback(() => {
    setFullscreenHintDismissed(true)
    persistFullscreenHintDismissed()
  }, [])
  useFullscreenDoubleTap(scrollRef, fullscreenGestureEnabled, dismissFullscreenHint)
  const showFullscreenHint = fullscreenGestureEnabled && !fullscreenHintDismissed
  useEffect(() => {
    if (!showFullscreenHint) return
    const id = setTimeout(dismissFullscreenHint, FULLSCREEN_HINT_TIMEOUT_MS)
    return () => clearTimeout(id)
  }, [showFullscreenHint, dismissFullscreenHint])

  return (
    <div data-testid="ChatPanel" className="flex-1 flex flex-col min-h-0 min-w-0 relative">
      <TopBar hasContent={hasContent} />

      <div className="flex-1 flex flex-col min-h-0 relative">
        <ChatSearchOverlay
          scrollRef={scrollRef}
          active={searchOpen}
          query={searchQuery}
          onQueryChange={setSearchQuery}
          onClose={() => setSearchOpen(false)}
        />
        <div className="h-8 bg-gradient-to-b from-bg-primary to-transparent pointer-events-none -mb-8 relative z-[1]" />

        <div
          data-testid="ChatPanel.scroll"
          ref={scrollerRef}
          className="flex-1 overflow-y-auto chat-scroll mr-2"
        >
          {showEmptyScreen ? (
            <div className="h-full flex items-center justify-center">
              <WelcomeState />
            </div>
          ) : loadingTranscript ? (
            transcriptLoadFailed ? (
              <div
                data-testid="TranscriptLoadFailed"
                className="h-full flex items-center justify-center"
              >
                <div className="flex items-center gap-3 -mt-16 animate-fade-in">
                  <span className="text-[13px] text-text-muted">
                    Couldn&apos;t load this conversation
                  </span>
                  <button
                    data-testid="TranscriptLoadFailed.retry"
                    onClick={() => {
                      if (activeSessionId) void reloadActiveTranscript(activeSessionId)
                    }}
                    className="text-[13px] text-accent hover:underline"
                  >
                    Retry
                  </button>
                </div>
              </div>
            ) : (
              <div
                data-testid="TranscriptLoading"
                className="h-full flex items-center justify-center"
              >
                <LoadingState label="Loading conversation..." />
              </div>
            )
          ) : !hasContent && status.state === 'running' ? (
            <div className="h-full flex items-center justify-center">
              <LoadingState />
            </div>
          ) : (
            <div
              ref={contentRef}
              style={{ ...(chatZoom !== 1 ? { zoom: chatZoom } : {}), maxWidth: chatMaxWidth }}
              className={`mx-auto pt-5 pb-6 flex flex-col gap-3 ${isMobile ? 'px-3' : 'px-8'}`}
            >
              {/* Both render fragments — no wrapper element, so the flex-column
                  layout of the message list is untouched. They own the two
                  full-screen viewers: a thumbnail click opens the image gallery,
                  expanding a diagram card opens the diagram gallery. */}
              {/* WHOSE transcript this is. A bubble that needs a session must
                  read it from here, not from `activeSessionId` — the same
                  component also replays automation-run history, where that
                  pointer names an unrelated chat. */}
              <TranscriptSessionProvider value={activeSessionId}>
                <ImageGalleryProvider messages={messages}>
                  <DiagramGalleryProvider messages={messages}>
                    {messages.map((msg) => {
                      const estimate = estimateHeight(msg)
                      return (
                        <div
                          key={msg.id}
                          className="cv-auto"
                          // Only a never-rendered message uses this: `auto` keeps the
                          // remembered size afterwards. data-est-h is for calibration.
                          style={{ containIntrinsicSize: `auto ${estimate}px` }}
                          data-est-h={estimate}
                          {...SEARCH_ANCHOR}
                        >
                          <MessageBubble
                            message={msg}
                            pendingApprovals={pendingApprovals}
                            isLastAssistant={msg.id === lastAssistantId}
                            activeThinking={activeThinkingByMessage.get(msg.id)}
                          />
                        </div>
                      )
                    })}
                  </DiagramGalleryProvider>
                </ImageGalleryProvider>
              </TranscriptSessionProvider>
              <div className="flex flex-col gap-5">
                {showTypingIndicator && <TypingIndicator />}
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
      {showFullscreenHint && (
        <div
          data-testid="FullscreenHint"
          className="absolute top-14 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 bg-bg-tertiary border border-border rounded-full px-3 py-1.5 text-[12px] text-text-secondary shadow-lg animate-fade-in"
        >
          <span>Double-tap the chat to toggle full screen</span>
          <button
            type="button"
            data-testid="FullscreenHint.dismiss"
            onClick={dismissFullscreenHint}
            aria-label="Dismiss hint"
            className="shrink-0 text-text-muted hover:text-text-primary transition-colors cursor-default"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M18 6L6 18" />
              <path d="M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
      <FloatingApproval />
      <ChatNoticeStack />
    </div>
  )
}

// ── Presentational sub-components ───────────────────────────────────

/**
 * The ONE owner of the chat's `top-12` notice slot (ADR-070 §4).
 *
 * `AuthRequiredRow`, `FloatingError` and `SandboxViolationToast` used to be
 * absolutely-positioned SIBLINGS, each rendering `absolute top-12 left-0 right-0
 * z-20` — same coordinates, same stacking order, painting over one another, so
 * which notice the user saw was DOM order rather than intent. The positioning,
 * the gutter and the reading width live here now and the leaves render just
 * their cards, which makes two live notices STACK instead of overlap.
 *
 * `pointer-events-none` on the container with `pointer-events-auto` on the cards
 * is kept exactly as it was: the slot sits over the transcript, so everything
 * but a card has to stay click-through.
 */
export function ChatNoticeStack(): React.JSX.Element {
  const isMobile = useIsMobile()
  return (
    <div
      data-testid="ChatNoticeStack"
      className="absolute top-12 left-0 right-0 z-20 pointer-events-none px-4 pt-2"
    >
      <div className={`${isMobile ? 'max-w-full' : 'max-w-[740px]'} mx-auto flex flex-col gap-2`}>
        <FloatingError />
        <SandboxViolationToast />
      </div>
    </div>
  )
}

function LoadingState({ label = 'Thinking...' }: { label?: string }): React.JSX.Element {
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
      <span className="text-[13px] text-text-muted">{label}</span>
    </div>
  )
}

function TypingIndicator(): React.JSX.Element {
  return (
    <div data-testid="ChatPanel.typingIndicator" className="flex items-start animate-fade-in">
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

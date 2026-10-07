/**
 * Bash streaming output sub-components — moved verbatim from
 * ToolCallBlock/View.tsx (behavior-preserving). They own their local state and
 * read the store by `toolUseId` (the non-negotiable streaming join key).
 *
 *  - LiveBashOutput: foreground bash live stream (driven by `bashOutputs[id]`).
 *  - BackgroundBashOutput: background bash tail (driven by `backgroundOutputs[id]`,
 *    with watch/unwatch + load-earlier paging).
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { AnsiUp } from 'ansi_up'
import { useSessionStore, useActiveSession, type ThemeId } from '../../../../stores/session-store'
import { useStickToBottom } from '../../../../hooks/useStickToBottom'
import { TOOL_OUTPUT_SCOPE } from '../../ChatSearch/search-scope'

export function LiveBashOutput({
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
  // The pre scrolls and has a fixed max-height: the wrapper inside it is what grows.
  const { scrollerRef, contentRef } = useStickToBottom<HTMLPreElement>()
  const bg = theme === 'light' ? '#e8eaed' : theme === 'monokai' ? '#272822' : '#0d1117'
  const fg = theme === 'light' ? '#1a1d24' : theme === 'monokai' ? '#f8f8f2' : '#d1d5db'

  // Fresh AnsiUp per conversion so SGR state can't bleed between bash tool cards
  // (a shared module-level instance carried color state across cards). The memo
  // holds the `{ __html }` object: React rewrites innerHTML whenever its identity
  // changes (see TerminalView).
  const html = useMemo(() => {
    const ansi = new AnsiUp()
    ansi.use_classes = false
    ansi.escape_html = true
    return { __html: ansi.ansi_to_html(output) }
  }, [output])

  return (
    <div data-testid="LiveBashOutput" {...TOOL_OUTPUT_SCOPE} className="px-3 py-2.5">
      <div className="flex items-center gap-2 mb-1.5">
        <div className="text-[11px] text-text-secondary uppercase tracking-wider">Live Output</div>
        <span className="text-[10px] font-mono text-text-muted">
          {totalLines} lines ·{' '}
          {totalBytes > 1024 ? `${(totalBytes / 1024).toFixed(1)}KB` : `${totalBytes}B`}
        </span>
        <div className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
      </div>
      <pre
        ref={scrollerRef}
        className="text-[12px] font-mono whitespace-pre-wrap break-words leading-[1.3] rounded-md p-2 border border-border overflow-y-auto"
        style={{ background: bg, color: fg, maxHeight: 300 }}
      >
        <div ref={contentRef} dangerouslySetInnerHTML={html} />
      </pre>
    </div>
  )
}

export function BackgroundBashOutput({
  toolUseId
}: {
  toolUseId: string
}): React.JSX.Element | null {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const bgOutput = useActiveSession((s) => s.backgroundOutputs[toolUseId])
  const watchBg = useSessionStore((s) => s.watchBackgroundOutput)
  const unwatchBg = useSessionStore((s) => s.unwatchBackgroundOutput)
  const [prependedContent, setPrependedContent] = useState('')
  const [loadingMore, setLoadingMore] = useState(false)
  const { scrollerRef, contentRef, stopFollowing } = useStickToBottom<HTMLPreElement>()

  useEffect(() => {
    if (!activeSessionId) return
    watchBg(activeSessionId, toolUseId)
    return () => {
      if (activeSessionId) unwatchBg(activeSessionId, toolUseId)
    }
  }, [toolUseId, activeSessionId, watchBg, unwatchBg])

  const handleLoadEarlier = useCallback(async () => {
    if (!bgOutput || loadingMore) return
    const alreadyLoaded = prependedContent.length
    const tailLen = new TextEncoder().encode(bgOutput.tail).length
    const loaded = alreadyLoaded + tailLen
    if (loaded >= bgOutput.totalSize) return

    setLoadingMore(true)
    // Earlier output lands ABOVE the tail; the user asked to read it, not to be
    // pinned back down to the end.
    stopFollowing()
    const chunkSize = 64 * 1024
    const offset = Math.max(0, bgOutput.totalSize - loaded - chunkSize)
    const length = Math.min(chunkSize, bgOutput.totalSize - loaded)
    const rid = useSessionStore.getState().activeSessionId
    if (!rid) return
    const chunk = await window.api.readBackgroundRange(rid, toolUseId, offset, length)
    setPrependedContent((prev) => chunk + prev)
    setLoadingMore(false)
  }, [bgOutput, prependedContent, loadingMore, toolUseId, stopFollowing])

  if (!bgOutput) return null

  const tailLen = new TextEncoder().encode(bgOutput.tail).length
  const hasMore = bgOutput.totalSize > prependedContent.length + tailLen

  return (
    <div
      data-testid="BackgroundBashOutput"
      {...TOOL_OUTPUT_SCOPE}
      className="border-t border-border px-3 py-2.5"
    >
      <div className="text-[11px] text-text-secondary uppercase tracking-wider mb-1.5">Output</div>
      {hasMore && (
        <button
          data-testid="BackgroundBashOutput.loadEarlier"
          onClick={handleLoadEarlier}
          disabled={loadingMore}
          className="text-[11px] text-accent hover:underline cursor-pointer mb-1 disabled:opacity-50"
        >
          {loadingMore ? 'Loading...' : 'Load earlier output...'}
        </button>
      )}
      <pre
        ref={scrollerRef}
        className="text-[12px] font-mono text-text-primary/70 bg-bg-primary rounded-md p-2 border border-border overflow-y-auto whitespace-pre-wrap break-words leading-[1.3]"
        style={{ maxHeight: 10 * 12 * 1.3 + 16 }}
      >
        <div ref={contentRef}>
          {prependedContent}
          {bgOutput.tail}
        </div>
      </pre>
    </div>
  )
}

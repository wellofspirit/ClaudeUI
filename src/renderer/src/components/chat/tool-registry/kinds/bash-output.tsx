/**
 * Bash streaming output sub-components — moved verbatim from
 * ToolCallBlock/View.tsx (behavior-preserving). They own their local state and
 * read the store by `toolUseId` (the non-negotiable streaming join key).
 *
 *  - LiveBashOutput: foreground bash live stream (driven by `bashOutputs[id]`).
 *  - BackgroundBashOutput: background bash tail (driven by `backgroundOutputs[id]`,
 *    with watch/unwatch + load-earlier paging).
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { AnsiUp } from 'ansi_up'
import { useSessionStore, useActiveSession, type ThemeId } from '../../../../stores/session-store'

const liveAnsiUp = new AnsiUp()
liveAnsiUp.use_classes = false
liveAnsiUp.escape_html = true

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

export function BackgroundBashOutput({ toolUseId }: { toolUseId: string }): React.JSX.Element | null {
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

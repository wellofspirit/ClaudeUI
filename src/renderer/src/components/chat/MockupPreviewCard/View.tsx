import React, { useEffect, useRef, useState } from 'react'
import { CodeView } from '../CodeView'

export interface MockupPreviewCardViewProps {
  directory: string
  title?: string
  html: string | null
  error: string | null
  src: string | null
  onExpand: () => void
  onCopyHtml: () => void
}

export function MockupPreviewCardView({
  directory,
  title,
  html,
  error,
  src,
  onExpand,
  onCopyHtml
}: MockupPreviewCardViewProps): React.JSX.Element {
  const [iframeHeight, setIframeHeight] = useState(300)
  const [tab, setTab] = useState<'preview' | 'code'>('preview')
  const iframeRef = useRef<HTMLIFrameElement>(null)

  // Auto-resize iframe to content height. Opaque-origin iframes block
  // contentDocument access — treat that case as a soft failure and keep
  // the default height.
  useEffect(() => {
    if (!iframeRef.current || !src) return

    const iframe = iframeRef.current
    const onLoad = (): void => {
      try {
        const body = iframe.contentDocument?.body
        if (body) {
          const h = Math.min(Math.max(body.scrollHeight, 100), 600)
          setIframeHeight(h)
        }
      } catch {
        // Cross-origin — can't access; keep default height
      }
    }

    iframe.addEventListener('load', onLoad)
    return () => iframe.removeEventListener('load', onLoad)
  }, [src])

  return (
    <div className="mt-1">
      {/* Header */}
      <div className="flex items-center gap-2 mb-1.5">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="text-accent shrink-0">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <line x1="3" y1="9" x2="21" y2="9" />
          <line x1="9" y1="9" x2="9" y2="21" />
        </svg>
        <span className="text-[13px] font-medium text-text-primary truncate">
          {title || 'UI Mockup'}
        </span>
        <span className="text-[11px] text-text-muted font-mono">{directory}</span>
        <div className="flex-1" />

        <button
          onClick={onCopyHtml}
          className="text-[11px] text-text-muted hover:text-text-secondary transition-colors cursor-pointer px-1.5 py-0.5 rounded hover:bg-bg-hover"
          title="Copy HTML"
        >
          Copy
        </button>

        <button
          onClick={onExpand}
          className="text-[11px] text-text-muted hover:text-text-secondary transition-colors cursor-pointer px-1.5 py-0.5 rounded hover:bg-bg-hover"
          title="Open in side panel"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="15 3 21 3 21 9" />
            <polyline points="9 21 3 21 3 15" />
            <line x1="21" y1="3" x2="14" y2="10" />
            <line x1="3" y1="21" x2="10" y2="14" />
          </svg>
        </button>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 mb-1.5">
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

      {/* Content — keep both panes mounted so tab switches don't remount the iframe (which causes a white flash on reload) */}
      {error ? (
        <div className="text-[12px] text-danger bg-danger/5 rounded-md px-3 py-2">
          {error}
        </div>
      ) : (
        <>
          <div style={{ display: tab === 'preview' ? 'block' : 'none' }}>
            {src ? (
              <div className="rounded-md border border-border overflow-hidden bg-white">
                <iframe
                  ref={iframeRef}
                  src={src}
                  sandbox=""
                  style={{ width: '100%', height: iframeHeight, border: 'none', display: 'block' }}
                  title={title || 'Mockup preview'}
                />
              </div>
            ) : (
              <div className="h-[100px] rounded-md border border-border flex items-center justify-center">
                <span className="text-[12px] text-text-muted">Loading mockup...</span>
              </div>
            )}
          </div>
          <div style={{ display: tab === 'code' ? 'block' : 'none' }}>
            <div className="max-h-[500px] overflow-auto">
              <CodeView code={html || 'Loading...'} filePath="index.html" />
            </div>
          </div>
        </>
      )}
    </div>
  )
}

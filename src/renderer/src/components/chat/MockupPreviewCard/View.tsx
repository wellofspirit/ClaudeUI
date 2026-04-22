import { forwardRef, useState } from 'react'
import { CodeView } from '../CodeView'

export interface MockupPreviewCardViewProps {
  title?: string
  html: string | null
  error: string | null
  src: string | null
  onExpand: () => void
  onCopyHtml: () => void
  onRefresh: () => void
}

export const MockupPreviewCardView = forwardRef<HTMLIFrameElement, MockupPreviewCardViewProps>(
  function MockupPreviewCardView(
    { title, html, error, src, onExpand, onCopyHtml, onRefresh },
    iframeRef
  ) {
    const [tab, setTab] = useState<'preview' | 'code'>('preview')

    return (
      <div className="mt-1">
        {/* Tab bar — the tool-call block above us already shows the mockup's
            name/directory, so this is the only row the card itself needs. */}
        <div className="flex items-center gap-1 mb-1.5">
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

          <div className="flex-1" />

          <button
            onClick={onCopyHtml}
            className="text-[11px] h-6 px-2 rounded text-text-muted hover:text-text-secondary transition-colors cursor-pointer hover:bg-bg-hover"
            title="Copy HTML"
          >
            Copy
          </button>

          <button
            onClick={onRefresh}
            className="h-6 w-6 flex items-center justify-center rounded text-text-muted hover:text-text-secondary transition-colors cursor-pointer hover:bg-bg-hover"
            title="Reload mockup"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
            </svg>
          </button>

          <button
            onClick={onExpand}
            className="h-6 w-6 flex items-center justify-center rounded text-text-muted hover:text-text-secondary transition-colors cursor-pointer hover:bg-bg-hover"
            title="Open in side panel"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <polyline points="15 3 21 3 21 9" />
              <polyline points="9 21 3 21 3 15" />
              <line x1="21" y1="3" x2="14" y2="10" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          </button>
        </div>

        {/* Content — keep both panes mounted so tab switches don't remount the iframe (which causes a white flash on reload) */}
        {error ? (
          <div className="text-[12px] text-danger bg-danger/5 rounded-md px-3 py-2">{error}</div>
        ) : (
          <>
            <div style={{ display: tab === 'preview' ? 'block' : 'none' }}>
              {src ? (
                // Fixed 16:9 aspect ratio — mockups that need more vertical
                // space stay scrollable inside the iframe; the card itself
                // stays a predictable size regardless of content height.
                <div
                  className="rounded-md border border-border overflow-hidden bg-white w-full"
                  style={{ aspectRatio: '16 / 9' }}
                >
                  <iframe
                    ref={iframeRef}
                    src={src}
                    sandbox="allow-scripts allow-same-origin"
                    referrerPolicy="no-referrer"
                    tabIndex={-1}
                    style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
                    title={title || 'Mockup preview'}
                  />
                </div>
              ) : (
                <div
                  className="rounded-md border border-border flex items-center justify-center w-full"
                  style={{ aspectRatio: '16 / 9' }}
                >
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
)

import { forwardRef, useState } from 'react'
import { CodeView } from '../chat/CodeView'
import { MockupConsoleDrawer } from './MockupConsoleDrawer'
import type { MockupLogEntry, MockupErrorEntry } from '../../hooks/useMockupBridge'

type DeviceFrame = 'mobile' | 'tablet' | 'desktop'

const DEVICE_WIDTHS: Record<DeviceFrame, number | '100%'> = {
  mobile: 375,
  tablet: 768,
  desktop: '100%'
}

export interface MockupPanelViewProps {
  style?: React.CSSProperties
  mockupTitle: string | null
  mockupDir: string | null
  html: string | null
  error: string | null
  src: string | null
  onClose: () => void
  onCopyHtml: () => void
  onRefresh: () => void
  onDarkModeChange: (dark: boolean) => void
  darkMode: boolean
  consoleLogs: MockupLogEntry[]
  consoleErrors: MockupErrorEntry[]
  consoleOpen: boolean
  onToggleConsole: () => void
  onClearConsole: () => void
}

export const MockupPanelView = forwardRef<HTMLIFrameElement, MockupPanelViewProps>(
  function MockupPanelView(
    {
      style,
      mockupTitle,
      mockupDir,
      html,
      error,
      src,
      onClose,
      onCopyHtml,
      onRefresh,
      onDarkModeChange,
      darkMode,
      consoleLogs,
      consoleErrors,
      consoleOpen,
      onToggleConsole,
      onClearConsole
    },
    iframeRef
  ) {
    const [device, setDevice] = useState<DeviceFrame>('desktop')
    const [tab, setTab] = useState<'preview' | 'code'>('preview')

    const iframeWidth = DEVICE_WIDTHS[device]

    return (
      <div style={style} className="h-full flex flex-col bg-bg-primary border-l border-border">
        {/* Header */}
        <div className="shrink-0 flex items-center gap-2 px-3 h-11 border-b border-border">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            className="text-accent shrink-0"
          >
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="3" y1="9" x2="21" y2="9" />
            <line x1="9" y1="9" x2="9" y2="21" />
          </svg>
          {/* Inner flex with items-baseline so the smaller monospace dir
              tag aligns with the title's text baseline, not with the vertical
              center of its own box (which drifts because font size + family
              differ). Outer row stays items-center for the icon/button. */}
          <div className="flex items-baseline gap-2 min-w-0">
            <span className="text-[13px] font-medium text-text-primary truncate">
              {mockupTitle || 'UI Mockup'}
            </span>
            {mockupDir && (
              <span className="text-[11px] text-text-muted font-mono">{mockupDir}</span>
            )}
          </div>
          <div className="flex-1" />

          <button
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
            title="Close"
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
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Toolbar */}
        <div className="shrink-0 flex items-center gap-2 px-3 h-9 border-b border-border">
          {(['preview', 'code'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`text-[11px] h-6 px-2 rounded transition-colors cursor-default capitalize ${
                tab === t
                  ? 'bg-bg-hover text-text-primary'
                  : 'text-text-muted hover:text-text-secondary hover:bg-bg-hover'
              }`}
            >
              {t}
            </button>
          ))}

          <div className="w-px h-4 bg-border" />

          {(['mobile', 'tablet', 'desktop'] as const).map((d) => (
            <button
              key={d}
              onClick={() => setDevice(d)}
              className={`text-[11px] h-6 px-2 rounded transition-colors cursor-default capitalize ${
                device === d
                  ? 'bg-bg-hover text-text-primary'
                  : 'text-text-muted hover:text-text-secondary hover:bg-bg-hover'
              }`}
              title={`${d} (${d === 'desktop' ? '100%' : DEVICE_WIDTHS[d] + 'px'})`}
            >
              {d === 'mobile' && (
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="inline mr-1"
                >
                  <rect x="5" y="2" width="14" height="20" rx="2" />
                  <line x1="12" y1="18" x2="12" y2="18" strokeLinecap="round" />
                </svg>
              )}
              {d === 'tablet' && (
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="inline mr-1"
                >
                  <rect x="4" y="2" width="16" height="20" rx="2" />
                  <line x1="12" y1="18" x2="12" y2="18" strokeLinecap="round" />
                </svg>
              )}
              {d === 'desktop' && (
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="inline mr-1"
                >
                  <rect x="2" y="3" width="20" height="14" rx="2" />
                  <line x1="8" y1="21" x2="16" y2="21" />
                  <line x1="12" y1="17" x2="12" y2="21" />
                </svg>
              )}
              {d}
            </button>
          ))}

          <div className="w-px h-4 bg-border" />

          <button
            onClick={() => onDarkModeChange(!darkMode)}
            className={`text-[11px] h-6 px-2 rounded transition-colors cursor-default ${
              darkMode
                ? 'bg-bg-hover text-text-primary'
                : 'text-text-muted hover:text-text-secondary hover:bg-bg-hover'
            }`}
            title="Toggle dark mode"
          >
            {darkMode ? 'Dark' : 'Light'}
          </button>

          <div className="flex-1" />

          <button
            onClick={onCopyHtml}
            className="text-[11px] h-6 px-2 rounded text-text-muted hover:text-text-secondary hover:bg-bg-hover transition-colors cursor-default"
            title="Copy HTML source"
          >
            Copy
          </button>

          <button
            onClick={onRefresh}
            className="h-6 w-6 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default"
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
        </div>

        {/* Content area — keep both panes mounted so tab switches don't remount the iframe (avoids white flash on reload) */}
        <div
          className="flex-1 min-h-0 overflow-auto justify-center p-4 bg-[#f5f5f5] dark:bg-[#1a1a1a]"
          style={{ display: tab === 'preview' ? 'flex' : 'none' }}
        >
          {error ? (
            <div className="text-[12px] text-danger self-start bg-danger/5 rounded-md px-3 py-2">
              {error}
            </div>
          ) : src ? (
            <div
              className="bg-white shadow-lg rounded-lg overflow-hidden transition-all duration-200"
              style={{
                width: iframeWidth === '100%' ? '100%' : iframeWidth,
                maxWidth: '100%',
                height: '100%'
              }}
            >
              <iframe
                ref={iframeRef}
                src={src}
                sandbox="allow-scripts allow-same-origin"
                referrerPolicy="no-referrer"
                tabIndex={-1}
                style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
                title={mockupTitle || 'Mockup preview'}
              />
            </div>
          ) : (
            <div className="flex items-center justify-center h-full">
              <span className="text-[12px] text-text-muted">Loading mockup...</span>
            </div>
          )}
        </div>
        <div
          className="flex-1 min-h-0 overflow-auto p-4"
          style={{ display: tab === 'code' ? 'block' : 'none' }}
        >
          <CodeView code={html || 'Loading...'} filePath="index.html" />
        </div>

        <MockupConsoleDrawer
          logs={consoleLogs}
          errors={consoleErrors}
          expanded={consoleOpen}
          onToggle={onToggleConsole}
          onClear={onClearConsole}
        />
      </div>
    )
  }
)

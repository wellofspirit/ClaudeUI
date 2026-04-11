import { useEffect, useState } from 'react'
import { useSessionStore } from '../../stores/session-store'
import { sanitizeSvg } from '../../utils/sanitize-svg'

interface PluginWebViewProps {
  pluginId: string
  onClose: () => void
}

export function PluginWebView({ pluginId, onClose }: PluginWebViewProps): React.JSX.Element {
  const pluginViews = useSessionStore((s) => s.pluginViews)
  const view = pluginViews.find((v) => v.pluginId === pluginId)
  const isMac = window.api.platform === 'darwin'
  const [preloadPath, setPreloadPath] = useState<string | null>(null)

  // Resolve the plugin preload path once
  useEffect(() => {
    window.api.getPluginPreloadPath().then(setPreloadPath).catch(() => {})
  }, [])

  // If plugin view was removed (e.g. plugin reloaded), fall back to chat
  useEffect(() => {
    if (!view) onClose()
  }, [view, onClose])

  if (!view) {
    return (
      <div className="flex flex-col h-full bg-bg-primary items-center justify-center text-text-muted">
        Plugin view not found
      </div>
    )
  }

  // Build the webview src URL with pluginId query param
  const srcUrl = `file://${view.htmlFile.replace(/\\/g, '/')}?pluginId=${encodeURIComponent(pluginId)}`

  return (
    <div className="flex flex-col h-full bg-bg-primary">
      {/* Header — matches AutomationView / UsageView pattern */}
      <div className="sticky top-0 z-10 bg-bg-primary/95 backdrop-blur-sm border-b border-border/30">
        <div className="flex items-center justify-between px-4 py-2.5" style={{ paddingTop: isMac ? 38 : 8 }}>
          <div className="flex items-center gap-2">
            {view.icon && sanitizeSvg(view.icon) ? (
              // eslint-disable-next-line react/no-danger
              <span className="text-text-accent" dangerouslySetInnerHTML={{ __html: sanitizeSvg(view.icon)! }} />
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-text-accent">
                <path d="M12 2L2 7l10 5 10-5-10-5z" />
                <path d="M2 17l10 5 10-5" />
                <path d="M2 12l10 5 10-5" />
              </svg>
            )}
            <span className="text-sm font-semibold text-text-primary">{view.label}</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-bg-hover text-text-muted hover:text-text-primary transition-colors"
            title="Close"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Webview container */}
      <div className="flex-1 min-h-0">
        {preloadPath ? (
          <webview
            src={srcUrl}
            preload={`file://${preloadPath.replace(/\\/g, '/')}`}
            nodeintegration={false}
            plugins={false}
            className="w-full h-full"
            style={{ display: 'flex', flex: 1 }}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-text-muted text-sm">
            Loading plugin...
          </div>
        )}
      </div>
    </div>
  )
}

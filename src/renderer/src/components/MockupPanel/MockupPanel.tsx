import { useState, useEffect, useCallback, useRef } from 'react'
import { onSyncEvent } from '../../../../shared/sync/client-registry'
import { useSessionStore, useActiveSession } from '../../stores/session-store'
import { useMockupBridge } from '../../hooks/useMockupBridge'
import {
  MOCKUP_IFRAME_SANDBOX,
  mockupExpectedOrigin,
  mockupReloadTarget
} from '../mockup-transport'
import { MockupPanelView } from './View'

interface Props {
  style?: React.CSSProperties
}

/**
 * FC for the right-panel mockup preview.
 * Iframe loads directly from `mockup-asset://` — dark mode is a URL query
 * param so the handler can rewrite the `<html>` tag server-side (scripts
 * can also do it, but the query param is cheaper). File changes bump a
 * version counter for cache bust.
 */
export function MockupPanel({ style }: Props): React.JSX.Element {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const closeMockupPanel = useSessionStore((s) => s.closeMockupPanel)
  const mockupDir = useActiveSession((s) => s.mockupDir)
  const mockupTitle = useActiveSession((s) => s.mockupTitle)
  const cwd = useActiveSession((s) => s.cwd)

  const [html, setHtml] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [darkMode, setDarkMode] = useState(false)
  const [version, setVersion] = useState(1)
  const [consoleOpen, setConsoleOpen] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)

  const loadHtml = useCallback(() => {
    if (!cwd || !mockupDir) return
    window.api
      .readMockupHtml(cwd, mockupDir)
      .then((content) => {
        setHtml(content)
        setError(null)
      })
      .catch((err: Error) => {
        setError(err.message || 'Failed to load mockup')
      })
  }, [cwd, mockupDir])

  useEffect(() => {
    loadHtml()
  }, [loadHtml])

  useEffect(() => {
    if (!cwd || !mockupDir) return

    window.api.watchMockup(cwd, mockupDir)

    const unsub = onSyncEvent('mockup:file-changed', (changedDir: string) => {
      if (changedDir === mockupDir) {
        loadHtml()
        setVersion((v) => v + 1)
      }
    })

    return () => {
      unsub()
      window.api.unwatchMockup(cwd, mockupDir)
    }
  }, [cwd, mockupDir, loadHtml])

  // `version` intentionally omitted from the URL — mutating iframe.src on
  // file change makes Chromium focus the iframe and scroll-anchor to it.
  // We trigger in-place reloads via postMessage instead (see effect below).
  // `dark` stays in the URL because dark mode needs a server-side HTML
  // rewrite to add `class="dark"` to <html>.
  const iframeSrc =
    cwd && mockupDir ? window.api.getMockupPreviewUrl(cwd, mockupDir, { dark: darkMode }) : null

  const { logs, errors, clearLogs } = useMockupBridge(
    iframeRef,
    mockupDir,
    version,
    mockupDir ? mockupExpectedOrigin(mockupDir) : undefined
  )

  // Trigger an in-place iframe reload on version bump — after the initial
  // load. First render uses the src attribute; subsequent file changes
  // postMessage-trigger a `location.reload()` inside the iframe.
  const prevVersionRef = useRef(version)
  useEffect(() => {
    if (prevVersionRef.current === version) return
    prevVersionRef.current = version
    if (!mockupDir) return
    const iframe = iframeRef.current
    if (!iframe?.contentWindow) return
    iframe.contentWindow.postMessage({ type: 'mockup:reload' }, mockupReloadTarget(mockupDir))
  }, [version, mockupDir])

  // Auto-pop the drawer when the error count grows (e.g. 0 → 1) so users
  // notice. Render-time setState guarded by equality on the previous count
  // — the sanctioned pattern for reacting to state changes without useEffect
  // cascades. See react.dev §"Storing information from previous renders".
  const [prevErrorCount, setPrevErrorCount] = useState(0)
  if (errors.length !== prevErrorCount) {
    const grew = errors.length > prevErrorCount
    setPrevErrorCount(errors.length)
    if (grew && !consoleOpen) setConsoleOpen(true)
  }

  const handleClose = (): void => {
    if (activeSessionId) closeMockupPanel(activeSessionId)
  }

  const handleCopyHtml = (): void => {
    if (html) navigator.clipboard.writeText(html).catch(() => {})
  }

  // Manual refresh — also reloads the HTML source so the Code tab stays in
  // sync. Bumping `version` drives the postMessage-reload effect above.
  const handleRefresh = (): void => {
    loadHtml()
    setVersion((v) => v + 1)
  }

  return (
    <MockupPanelView
      ref={iframeRef}
      style={style}
      mockupTitle={mockupTitle}
      mockupDir={mockupDir}
      html={html}
      error={error}
      src={iframeSrc}
      sandbox={MOCKUP_IFRAME_SANDBOX}
      onClose={handleClose}
      onCopyHtml={handleCopyHtml}
      onRefresh={handleRefresh}
      onDarkModeChange={setDarkMode}
      darkMode={darkMode}
      consoleLogs={logs}
      consoleErrors={errors}
      consoleOpen={consoleOpen}
      onToggleConsole={() => setConsoleOpen((v) => !v)}
      onClearConsole={clearLogs}
    />
  )
}

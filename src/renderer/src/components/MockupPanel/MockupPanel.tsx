import { useState, useEffect, useCallback, useRef } from 'react'
import { onSyncEvent } from '../../../../core/shared/sync/client-registry'
import { useSessionStore, useActiveSession } from '../../stores/session-store'
import { useMockupBridge } from '../../hooks/useMockupBridge'
import { useMockupReload } from '../../hooks/useMockupReload'
import { MOCKUP_IFRAME_SANDBOX, mockupExpectedOrigin } from '../mockup-transport'
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
  const [consoleOpen, setConsoleOpen] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const expectedOrigin = mockupDir ? mockupExpectedOrigin(mockupDir) : undefined
  const { reload, status, version, frameKey, onFrameLoad } = useMockupReload(
    iframeRef,
    mockupDir,
    expectedOrigin
  )

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
        reload()
      }
    })

    return () => {
      unsub()
      window.api.unwatchMockup(cwd, mockupDir)
    }
  }, [cwd, mockupDir, loadHtml, reload])

  // `version` intentionally omitted from the URL — mutating iframe.src on
  // file change makes Chromium focus the iframe and scroll-anchor to it.
  // We trigger in-place reloads via postMessage instead (see effect below).
  // `dark` stays in the URL because dark mode needs a server-side HTML
  // rewrite to add `class="dark"` to <html>.
  const iframeSrc =
    cwd && mockupDir ? window.api.getMockupPreviewUrl(cwd, mockupDir, { dark: darkMode }) : null

  const { logs, errors, clearLogs } = useMockupBridge(iframeRef, mockupDir, version, expectedOrigin)

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
  // sync, then reloads the iframe in place.
  const handleRefresh = (): void => {
    loadHtml()
    reload()
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
      reloadStatus={status}
      frameKey={frameKey}
      onFrameLoad={onFrameLoad}
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

import { useState, useEffect, useCallback } from 'react'
import { useSessionStore, useActiveSession } from '../../stores/session-store'
import { buildSrcdoc } from '../../lib/mockup-utils'
import { MockupPanelView } from './View'

interface Props {
  style?: React.CSSProperties
}

/**
 * FC for the right-panel mockup preview.
 * Handles IPC (read HTML, watch/unwatch), store access,
 * and delegates rendering to MockupPanelView.
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

  // Load HTML from disk
  const loadHtml = useCallback(() => {
    if (!cwd || !mockupDir) return
    window.api.readMockupHtml(cwd, mockupDir).then((content) => {
      setHtml(content)
      setError(null)
    }).catch((err: Error) => {
      setError(err.message || 'Failed to load mockup')
    })
  }, [cwd, mockupDir])

  // Initial load
  useEffect(() => {
    loadHtml()
  }, [loadHtml])

  // Watch for file changes and auto-reload
  useEffect(() => {
    if (!cwd || !mockupDir) return

    window.api.watchMockup(cwd, mockupDir)

    const unsub = window.api.onMockupFileChanged((changedDir: string) => {
      if (changedDir === mockupDir) loadHtml()
    })

    return () => {
      unsub()
      window.api.unwatchMockup(cwd, mockupDir)
    }
  }, [cwd, mockupDir, loadHtml])

  const srcdoc = html ? buildSrcdoc(html, darkMode) : null

  const handleClose = (): void => {
    if (activeSessionId) closeMockupPanel(activeSessionId)
  }

  const handleCopyHtml = (): void => {
    if (html) navigator.clipboard.writeText(html).catch(() => {})
  }

  return (
    <MockupPanelView
      style={style}
      mockupTitle={mockupTitle}
      mockupDir={mockupDir}
      html={html}
      error={error}
      srcdoc={srcdoc}
      onClose={handleClose}
      onCopyHtml={handleCopyHtml}
      onDarkModeChange={setDarkMode}
      darkMode={darkMode}
    />
  )
}

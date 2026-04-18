import { useState, useEffect, useCallback } from 'react'
import { useSessionStore, useActiveSession } from '../../stores/session-store'
import { buildMockupUrl } from '../../../../shared/mockup-url'
import { MockupPanelView } from './View'

interface Props {
  style?: React.CSSProperties
}

/**
 * FC for the right-panel mockup preview.
 * Iframe loads directly from `mockup-asset://` — dark mode is a URL query
 * param so the handler can rewrite the `<html>` tag server-side (scripts are
 * blocked by sandbox=""). File changes bump a version counter for cache bust.
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

  // HTML source is only used for the Code tab + Copy button.
  const loadHtml = useCallback(() => {
    if (!cwd || !mockupDir) return
    window.api.readMockupHtml(cwd, mockupDir).then((content) => {
      setHtml(content)
      setError(null)
    }).catch((err: Error) => {
      setError(err.message || 'Failed to load mockup')
    })
  }, [cwd, mockupDir])

  useEffect(() => {
    loadHtml()
  }, [loadHtml])

  useEffect(() => {
    if (!cwd || !mockupDir) return

    window.api.watchMockup(cwd, mockupDir)

    const unsub = window.api.onMockupFileChanged((changedDir: string) => {
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

  const iframeSrc =
    cwd && mockupDir ? buildMockupUrl(cwd, mockupDir, { dark: darkMode, version }) : null

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
      src={iframeSrc}
      onClose={handleClose}
      onCopyHtml={handleCopyHtml}
      onDarkModeChange={setDarkMode}
      darkMode={darkMode}
    />
  )
}

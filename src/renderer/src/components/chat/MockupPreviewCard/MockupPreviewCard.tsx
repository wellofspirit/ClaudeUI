import React, { memo, useCallback, useEffect, useState } from 'react'
import { useSessionStore } from '../../../stores/session-store'
import { buildSrcdoc } from '../../../lib/mockup-utils'
import { MockupPreviewCardView } from './View'

interface MockupPreviewCardProps {
  directory: string
  title?: string
}

/**
 * FC for the inline mockup preview card.
 * Handles IPC (read HTML, watch/unwatch), store access (cwd, openMockupPanel),
 * and delegates rendering to MockupPreviewCardView.
 */
export const MockupPreviewCard = memo(function MockupPreviewCard({
  directory,
  title
}: MockupPreviewCardProps): React.JSX.Element {
  const [html, setHtml] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const cwd = useSessionStore((s) => {
    const rid = s.activeSessionId
    return rid ? s.sessions[rid]?.cwd || '' : ''
  })
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const openMockupPanel = useSessionStore((s) => s.openMockupPanel)

  // Load HTML from disk
  const loadHtml = useCallback(() => {
    if (!cwd || !directory) return
    window.api.readMockupHtml(cwd, directory).then((content) => {
      setHtml(content)
      setError(null)
    }).catch((err: Error) => {
      setError(err.message || 'Failed to load mockup')
    })
  }, [cwd, directory])

  // Initial load
  useEffect(() => {
    loadHtml()
  }, [loadHtml])

  // Watch for file changes and auto-reload
  useEffect(() => {
    if (!cwd || !directory) return

    window.api.watchMockup(cwd, directory)

    const unsub = window.api.onMockupFileChanged((changedDir: string) => {
      if (changedDir === directory) loadHtml()
    })

    return () => {
      unsub()
      window.api.unwatchMockup(cwd, directory)
    }
  }, [cwd, directory, loadHtml])

  const srcdoc = html ? buildSrcdoc(html) : null

  const handleExpand = (): void => {
    if (activeSessionId) {
      openMockupPanel(activeSessionId, directory, title)
    }
  }

  const handleCopyHtml = (): void => {
    if (html) {
      navigator.clipboard.writeText(html).catch(() => {})
    }
  }

  return (
    <MockupPreviewCardView
      directory={directory}
      title={title}
      html={html}
      error={error}
      srcdoc={srcdoc}
      onExpand={handleExpand}
      onCopyHtml={handleCopyHtml}
    />
  )
})

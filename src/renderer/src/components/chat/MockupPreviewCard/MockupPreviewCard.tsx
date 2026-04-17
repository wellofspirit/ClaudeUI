import React, { memo, useCallback, useEffect, useState } from 'react'
import { useSessionStore } from '../../../stores/session-store'
import { buildMockupUrl } from '../../../../../shared/mockup-url'
import { MockupPreviewCardView } from './View'

interface MockupPreviewCardProps {
  directory: string
  title?: string
}

/**
 * FC for the inline mockup preview card.
 * The iframe loads directly from the `mockup-asset://` protocol, so we never
 * pass HTML through srcdoc. HTML is still read via IPC for the Code tab and
 * the Copy button. File changes bump a version counter → new src URL → iframe
 * reloads (and bypasses HTTP cache for that one reload).
 */
export const MockupPreviewCard = memo(function MockupPreviewCard({
  directory,
  title
}: MockupPreviewCardProps): React.JSX.Element {
  const [html, setHtml] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(1)

  const cwd = useSessionStore((s) => {
    const rid = s.activeSessionId
    return rid ? s.sessions[rid]?.cwd || '' : ''
  })
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const openMockupPanel = useSessionStore((s) => s.openMockupPanel)

  // HTML source is only needed for the Code tab + Copy button.
  const loadHtml = useCallback(() => {
    if (!cwd || !directory) return
    window.api.readMockupHtml(cwd, directory).then((content) => {
      setHtml(content)
      setError(null)
    }).catch((err: Error) => {
      setError(err.message || 'Failed to load mockup')
    })
  }, [cwd, directory])

  useEffect(() => {
    loadHtml()
  }, [loadHtml])

  // Watch for file changes: refresh the source, bump iframe version.
  useEffect(() => {
    if (!cwd || !directory) return

    window.api.watchMockup(cwd, directory)

    const unsub = window.api.onMockupFileChanged((changedDir: string) => {
      if (changedDir === directory) {
        loadHtml()
        setVersion((v) => v + 1)
      }
    })

    return () => {
      unsub()
      window.api.unwatchMockup(cwd, directory)
    }
  }, [cwd, directory, loadHtml])

  const iframeSrc = cwd && directory ? buildMockupUrl(cwd, directory, { version }) : null

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
      src={iframeSrc}
      onExpand={handleExpand}
      onCopyHtml={handleCopyHtml}
    />
  )
})

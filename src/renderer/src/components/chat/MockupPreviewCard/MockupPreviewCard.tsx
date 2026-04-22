import React, { memo, useCallback, useEffect, useRef, useState } from 'react'
import { useSessionStore } from '../../../stores/session-store'
import { buildMockupUrl, mockupOriginFor } from '../../../../../shared/mockup-url'
import { useMockupBridge } from '../../../hooks/useMockupBridge'
import { MockupPreviewCardView } from './View'

interface MockupPreviewCardProps {
  directory: string
  title?: string
}

/**
 * FC for the inline mockup preview card.
 * The iframe loads directly from the `mockup-asset://` protocol at a
 * per-mockup sub-origin. Scripts run inside that origin — the postMessage
 * bridge (useMockupBridge) drives auto-resize and collects console/errors
 * if the user opens the full panel.
 */
export const MockupPreviewCard = memo(function MockupPreviewCard({
  directory,
  title
}: MockupPreviewCardProps): React.JSX.Element {
  const [html, setHtml] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(1)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)

  const cwd = useSessionStore((s) => {
    const rid = s.activeSessionId
    return rid ? s.sessions[rid]?.cwd || '' : ''
  })
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const openMockupPanel = useSessionStore((s) => s.openMockupPanel)

  const loadHtml = useCallback(() => {
    if (!cwd || !directory) return
    window.api
      .readMockupHtml(cwd, directory)
      .then((content) => {
        setHtml(content)
        setError(null)
      })
      .catch((err: Error) => {
        setError(err.message || 'Failed to load mockup')
      })
  }, [cwd, directory])

  useEffect(() => {
    loadHtml()
  }, [loadHtml])

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

  // Intentionally omit `version` from the URL. Mutating the iframe's `src`
  // attribute causes Chromium to reload the iframe and focus it, scrolling
  // the chat container to bring it into view. Instead we keep `src` stable
  // and ask the iframe to reload itself via postMessage (see below).
  const iframeSrc =
    cwd && directory
      ? buildMockupUrl(cwd, directory, { parentOrigin: window.location.origin })
      : null

  // Keeps the bridge alive for console/error forwarding into the panel when
  // it's opened. The card itself uses a fixed 16:9 aspect ratio (see View),
  // so the reported height is intentionally ignored here.
  useMockupBridge(iframeRef, directory || null, version)

  // Trigger an in-place iframe reload on version bump — after the initial
  // load. First render uses the src attribute; subsequent file changes
  // postMessage-trigger a `location.reload()` inside the iframe.
  const prevVersionRef = useRef(version)
  useEffect(() => {
    if (prevVersionRef.current === version) return
    prevVersionRef.current = version
    if (!directory) return
    const iframe = iframeRef.current
    if (!iframe?.contentWindow) return
    iframe.contentWindow.postMessage({ type: 'mockup:reload' }, mockupOriginFor(directory))
  }, [version, directory])

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

  // Manual refresh — mirrors the file-change path: reload HTML source for
  // the Code tab and bump version, which drives the postMessage reload.
  const handleRefresh = (): void => {
    loadHtml()
    setVersion((v) => v + 1)
  }

  return (
    <MockupPreviewCardView
      ref={iframeRef}
      title={title}
      html={html}
      error={error}
      src={iframeSrc}
      onExpand={handleExpand}
      onCopyHtml={handleCopyHtml}
      onRefresh={handleRefresh}
    />
  )
})

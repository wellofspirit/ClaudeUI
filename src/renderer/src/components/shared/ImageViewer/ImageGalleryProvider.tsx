/**
 * ImageGalleryProvider — owns the chat-wide image gallery and the viewer it
 * opens.
 *
 * Mounted around a message list (ChatPanel and AutomationRunHistory both render
 * `MessageBubble`, so both wrap it). It derives the galleries from the messages
 * and hands descendants a single `openAttachment(messageId, index)` call, so a
 * thumbnail deep in the tree needs to know nothing about the viewer, the other
 * messages, or where it sits in the gallery.
 *
 * The context value is deliberately **identity-stable**: `MessageBubble` is
 * `memo`-wrapped, and a value that changed on every message update would make it
 * re-render every bubble on every streaming partial. The galleries are therefore
 * read through a ref inside a `useCallback(…, [])`.
 *
 * The default context is a no-op with `enabled: false`, so `MessageBubble`
 * renders fine unwrapped (in tests, or any future host that hasn't mounted this)
 * — the thumbnails simply aren't clickable.
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import type { ChatMessage } from '../../../../../shared/types'
import { ImageViewerOverlay, type ViewerTab } from './ImageViewerOverlay'
import {
  ATTACHMENTS_TAB_ID,
  ATTACHMENTS_TAB_LABEL,
  TOOL_RESULTS_TAB_ID,
  TOOL_RESULTS_TAB_LABEL,
  attachmentKey,
  deriveGalleries,
  type DerivedGalleries
} from './gallery'

export interface ImageGalleryContextValue {
  /**
   * Open the viewer on one attached image.
   *
   * @param messageId the message the thumbnail belongs to
   * @param indexWithinMessage index among that message's `image` blocks
   */
  openAttachment: (messageId: string, indexWithinMessage: number) => void
  /** False when no provider is mounted — hosts should render thumbnails inert. */
  enabled: boolean
}

const NO_GALLERY: ImageGalleryContextValue = {
  openAttachment: () => {},
  enabled: false
}

const ImageGalleryContext = createContext<ImageGalleryContextValue>(NO_GALLERY)

export function useImageGallery(): ImageGalleryContextValue {
  return useContext(ImageGalleryContext)
}

interface OpenState {
  tabId: string
  index: number
}

export function ImageGalleryProvider({
  messages,
  children
}: {
  messages: ChatMessage[]
  children: React.ReactNode
}): React.JSX.Element {
  const galleries = useMemo<DerivedGalleries>(() => deriveGalleries(messages), [messages])
  const [open, setOpen] = useState<OpenState | null>(null)

  // Read by the stable `openAttachment` below, which must not re-create itself
  // (and re-render every memoised MessageBubble) when a message arrives.
  const galleriesRef = useRef(galleries)
  galleriesRef.current = galleries

  const openAttachment = useCallback((messageId: string, indexWithinMessage: number): void => {
    const key = attachmentKey(messageId, indexWithinMessage)
    const index = galleriesRef.current.attachments.findIndex((e) => e.key === key)
    if (index < 0) return
    setOpen({ tabId: ATTACHMENTS_TAB_ID, index })
  }, [])

  const value = useMemo<ImageGalleryContextValue>(
    () => ({ openAttachment, enabled: true }),
    [openAttachment]
  )

  // Built only while the viewer is open — an empty gallery drops its tab inside
  // ImageViewerOverlay, so the "Tool results" tab appears exactly when it has
  // something in it.
  const tabs: ViewerTab[] = open
    ? [
        { id: ATTACHMENTS_TAB_ID, label: ATTACHMENTS_TAB_LABEL, images: galleries.attachments },
        { id: TOOL_RESULTS_TAB_ID, label: TOOL_RESULTS_TAB_LABEL, images: galleries.toolResults }
      ]
    : []

  return (
    <ImageGalleryContext.Provider value={value}>
      {children}
      {open && (
        <ImageViewerOverlay
          tabs={tabs}
          initialTabId={open.tabId}
          initialIndex={open.index}
          onClose={() => setOpen(null)}
        />
      )}
    </ImageGalleryContext.Provider>
  )
}

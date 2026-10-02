/**
 * BlobImage — an `<img>` for a transcript image held in the host's blob store
 * (ADR-087).
 *
 * Images reach the client as `{blobId, mediaType}` refs and are fetched on
 * demand. The chat list is NOT virtualized, so a thumbnail resolves only once it
 * comes near the viewport (300px, sticky once seen) — otherwise opening a
 * screenshot-heavy transcript would fire a fetch for every image in it. The chat
 * list scrolls inside a nested `overflow-y-auto` container, which `rootMargin`
 * alone does not reach (it only grows the implicit viewport root), so the margin
 * is also given as `scrollMargin`; an engine without that option ignores it and
 * falls back to "fetch once actually visible". Where `IntersectionObserver` does
 * not exist (jsdom) the image counts as visible immediately.
 *
 * Until the bytes land it holds a fixed-size box, so the strip does not jump
 * when they do; a blob the host no longer holds (LRU-evicted, a legal answer)
 * settles into the same box, quietly labelled, rather than collapsing to zero.
 * `data-state` mirrors {@link useBlobSrc}: idle / loading / ready / missing.
 */

import { useEffect, useRef, useState } from 'react'
import { useBlobSrc } from '../../hooks/useBlobSrc'

const NEAR_VIEWPORT_MARGIN = '300px'

function useNearViewport(ref: React.RefObject<HTMLElement | null>): boolean {
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    if (seen) return
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') {
      setSeen(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true)
          observer.disconnect()
        }
      },
      { rootMargin: NEAR_VIEWPORT_MARGIN, scrollMargin: NEAR_VIEWPORT_MARGIN }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref, seen])
  return seen
}

export function BlobImage({
  blobId,
  mediaType,
  alt,
  className,
  placeholderSize = 120
}: {
  blobId: string
  mediaType: string
  alt?: string
  /** Applied to the resolved `<img>`. */
  className?: string
  /** Edge of the square box shown while loading or unavailable, in px. */
  placeholderSize?: number
}): React.JSX.Element {
  const boxRef = useRef<HTMLSpanElement>(null)
  const visible = useNearViewport(boxRef)
  const { src, state } = useBlobSrc({ blobId, mediaType }, visible)

  if (state === 'ready' && src) {
    return (
      <img
        data-testid="BlobImage"
        data-id={blobId}
        data-state="ready"
        src={src}
        alt={alt}
        className={className}
      />
    )
  }

  const missing = state === 'missing'
  return (
    <span
      ref={boxRef}
      data-testid="BlobImage"
      data-id={blobId}
      data-state={state}
      role="img"
      aria-label={missing ? `${alt ?? 'Image'} (unavailable)` : alt}
      title={missing ? 'Image unavailable' : undefined}
      style={{ width: placeholderSize, height: placeholderSize }}
      className={`flex items-center justify-center rounded-lg border border-border bg-bg-hover ${
        missing ? '' : 'animate-pulse'
      }`}
    >
      {missing && <span className="px-1 text-[10px] text-text-muted">Unavailable</span>}
    </span>
  )
}

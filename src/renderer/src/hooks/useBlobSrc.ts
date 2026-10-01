import { useEffect, useState } from 'react'
import { isBlobKnownMissing, peekBlobSrc, resolveBlob } from '../lib/blob-cache'

export type BlobSrcState = 'idle' | 'loading' | 'ready' | 'missing'

/** First retry delay after a failed fetch; doubles per attempt up to {@link RETRY_MAX_MS}. */
export const RETRY_BASE_MS = 2_000
export const RETRY_MAX_MS = 30_000

const retryDelay = (attempt: number): number => Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS)

interface Resolution {
  /** Which blob this answer is for — a stale one is ignored on render. */
  blobId: string | null
  src: string | null
  state: BlobSrcState
}

function initial(ref: { blobId: string } | null, enabled: boolean): Resolution {
  if (!ref) return { blobId: null, src: null, state: 'idle' }
  const cached = peekBlobSrc(ref.blobId)
  if (cached !== null) return { blobId: ref.blobId, src: cached, state: 'ready' }
  if (isBlobKnownMissing(ref.blobId)) return { blobId: ref.blobId, src: null, state: 'missing' }
  return { blobId: ref.blobId, src: null, state: enabled ? 'loading' : 'idle' }
}

/**
 * Resolve a transcript `BlobRef` to a `data:` URI (ADR-087).
 *
 * `enabled: false` holds the fetch — `BlobImage` passes its viewport visibility
 * here, so a long transcript does not fetch every image the moment it opens. A
 * blob the cache already holds is `ready` on the FIRST render regardless, so a
 * remounted thumbnail never flashes its placeholder.
 *
 * A failed fetch (socket down, timeout) is NOT `missing`: nothing was learned
 * about the blob, and the chat list is not virtualized, so nothing would remount
 * the image to ask again. The state stays `loading` and the hook retries with
 * backoff for as long as it is mounted, enabled and showing this blob. `missing`
 * is the host's own answer and is final for the mount.
 */
export function useBlobSrc(
  ref: { blobId: string; mediaType: string } | null,
  enabled = true
): { src: string | null; state: BlobSrcState } {
  const blobId = ref?.blobId ?? null
  const mediaType = ref?.mediaType ?? ''
  const [resolution, setResolution] = useState<Resolution>(() => initial(ref, enabled))

  useEffect(() => {
    const next = initial(blobId ? { blobId } : null, enabled)
    setResolution(next)
    if (!blobId || !enabled || next.state !== 'loading') return
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let attempt = 0
    const ask = (): void => {
      void resolveBlob(blobId, mediaType).then((result) => {
        if (!live) return
        if (result.status === 'error') {
          timer = setTimeout(ask, retryDelay(attempt++))
          return
        }
        setResolution(
          result.status === 'ready'
            ? { blobId, src: result.src, state: 'ready' }
            : { blobId, src: null, state: 'missing' }
        )
      })
    }
    ask()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [blobId, mediaType, enabled])

  // Between a `blobId` change and the effect above, the state still describes
  // the previous blob; never hand that one out under the new id.
  if (resolution.blobId !== blobId) {
    const now = initial(ref, enabled)
    return { src: now.src, state: now.state }
  }
  return { src: resolution.src, state: resolution.state }
}

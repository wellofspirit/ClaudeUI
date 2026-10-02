/**
 * Client-side cache for transcript blobs (ADR-087).
 *
 * Images and documents reach a client as `BlobRef`s; the bytes come from the
 * host through `window.api.getBlob` (`blob:get`). That is an invoke on the
 * WebSocket / IPC lane rather than an HTTP route, so the browser's HTTP cache
 * cannot hold them — this module is that cache:
 *
 *  - **one fetch per blob in flight.** Two thumbnails of the same screenshot
 *    (the chat strip and the viewer, or a subagent repeating an image) share
 *    the promise;
 *  - **LRU bounded by size.** Entries are `data:` URIs, counted by string
 *    length — the base64 is what the renderer actually holds;
 *  - **"missing" is remembered, briefly.** The host answers `null` for an id
 *    its store evicted, and re-interns that blob the next time a transcript
 *    containing it is read — so a miss is cached for {@link MISSING_TTL_MS},
 *    never forever.
 */

/** Upper bound on the cached `data:` URIs, in characters of base64. */
export const BLOB_CACHE_MAX_BYTES = 128 * 1024 * 1024

/** How long a `null` answer is believed before the host is asked again. */
export const MISSING_TTL_MS = 60_000

/** Insertion order IS recency order: a hit deletes and re-inserts. */
const resolved = new Map<string, string>()
let resolvedChars = 0
const inFlight = new Map<string, Promise<BlobResolution>>()
const missingUntil = new Map<string, number>()
let maxChars = BLOB_CACHE_MAX_BYTES

/** A cached `data:` URI for this blob, synchronously — or null when it must be fetched. */
export function peekBlobSrc(blobId: string): string | null {
  const src = resolved.get(blobId)
  if (src === undefined) return null
  resolved.delete(blobId)
  resolved.set(blobId, src)
  return src
}

/** True while a recent `null` answer for this blob is still believed. */
export function isBlobKnownMissing(blobId: string): boolean {
  const until = missingUntil.get(blobId)
  if (until === undefined) return false
  if (Date.now() < until) return true
  missingUntil.delete(blobId)
  return false
}

/**
 * How a fetch ended. `missing` and `error` are different facts and callers must
 * not conflate them: `missing` is the host's answer (it does not hold the blob),
 * `error` is that the question never got an answer (socket down, timeout) —
 * which says nothing about the blob and is worth asking again.
 */
export type BlobResolution =
  { status: 'ready'; src: string } | { status: 'missing' } | { status: 'error' }

/**
 * Resolve a blob to a `data:` URI the renderer can put in an `<img src>`; never
 * throws or rejects. One request per blob in flight.
 */
export function resolveBlob(blobId: string, mediaType: string): Promise<BlobResolution> {
  const cached = peekBlobSrc(blobId)
  if (cached !== null) return Promise.resolve({ status: 'ready', src: cached })
  if (isBlobKnownMissing(blobId)) return Promise.resolve({ status: 'missing' })
  const pending = inFlight.get(blobId)
  if (pending) return pending

  const request = fetchBlob(blobId, mediaType).finally(() => inFlight.delete(blobId))
  inFlight.set(blobId, request)
  return request
}

/** {@link resolveBlob} for a caller that only wants the URI, or nothing (a prefetch). */
export async function resolveBlobSrc(blobId: string, mediaType: string): Promise<string | null> {
  const resolution = await resolveBlob(blobId, mediaType)
  return resolution.status === 'ready' ? resolution.src : null
}

async function fetchBlob(blobId: string, mediaType: string): Promise<BlobResolution> {
  let blob: { mediaType: string; base64Data: string } | null
  try {
    blob = await window.api.getBlob(blobId)
  } catch (err) {
    // A transport failure is not evidence the host lacks the blob, so it is not
    // remembered as missing — the caller retries.
    console.warn(`[blob-cache] blob:get failed for ${blobId}:`, err)
    return { status: 'error' }
  }
  if (!blob || typeof blob.base64Data !== 'string' || !blob.base64Data) {
    missingUntil.set(blobId, Date.now() + MISSING_TTL_MS)
    return { status: 'missing' }
  }
  // The REF's media type, not the store's: it is what the transcript said this
  // image is, which is what the inline `data:` URI always used.
  const src = `data:${mediaType};base64,${blob.base64Data}`
  remember(blobId, src)
  return { status: 'ready', src }
}

function remember(blobId: string, src: string): void {
  // A single blob larger than the whole cache is served but not kept.
  if (src.length > maxChars) return
  missingUntil.delete(blobId)
  resolvedChars -= resolved.get(blobId)?.length ?? 0
  resolved.set(blobId, src)
  resolvedChars += src.length
  for (const [id, entry] of resolved) {
    if (resolvedChars <= maxChars) break
    resolved.delete(id)
    resolvedChars -= entry.length
  }
}

/** Test seam: shrink the size bound so eviction is reachable without 128 MiB of fixtures. */
export function setBlobCacheLimitForTests(chars: number): void {
  maxChars = chars
}

/** Test seam: forget everything, and restore the size bound. */
export function resetBlobCacheForTests(): void {
  maxChars = BLOB_CACHE_MAX_BYTES
  resolved.clear()
  resolvedChars = 0
  inFlight.clear()
  missingUntil.clear()
}

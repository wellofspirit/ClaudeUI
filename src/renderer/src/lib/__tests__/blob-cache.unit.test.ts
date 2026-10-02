/**
 * Client-side blob cache (ADR-087): the one place transcript image bytes are
 * fetched, shared and bounded. `blob:get` is an invoke on the WebSocket / IPC
 * lane, so nothing below it (no HTTP cache) would otherwise de-dupe a repeat.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  BLOB_CACHE_MAX_BYTES,
  MISSING_TTL_MS,
  isBlobKnownMissing,
  peekBlobSrc,
  resetBlobCacheForTests,
  resolveBlob,
  resolveBlobSrc,
  setBlobCacheLimitForTests
} from '../blob-cache'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)

let getBlob: ReturnType<typeof vi.fn>

beforeEach(() => {
  resetBlobCacheForTests()
  getBlob = vi.fn(async (blobId: string) => ({
    mediaType: 'image/png',
    base64Data: `DATA-${blobId[0]}`
  }))
  window.api = { getBlob } as unknown as typeof window.api
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('resolveBlobSrc', () => {
  it('builds a data: URI from the ref media type and the fetched bytes', async () => {
    expect(await resolveBlobSrc(A, 'image/webp')).toBe('data:image/webp;base64,DATA-a')
  })

  it('shares one in-flight fetch between concurrent callers', async () => {
    const [x, y, z] = await Promise.all([
      resolveBlobSrc(A, 'image/png'),
      resolveBlobSrc(A, 'image/png'),
      resolveBlobSrc(A, 'image/png')
    ])
    expect(getBlob).toHaveBeenCalledTimes(1)
    expect([x, y, z]).toEqual(Array(3).fill('data:image/png;base64,DATA-a'))
  })

  it('answers a repeat from the cache, synchronously via peek', async () => {
    await resolveBlobSrc(A, 'image/png')
    expect(peekBlobSrc(A)).toBe('data:image/png;base64,DATA-a')
    await resolveBlobSrc(A, 'image/png')
    expect(getBlob).toHaveBeenCalledTimes(1)
  })

  it('evicts the least-recently-used entry when the size bound is exceeded', async () => {
    const one = 'data:image/png;base64,DATA-a'.length
    setBlobCacheLimitForTests(one * 2)

    await resolveBlobSrc(A, 'image/png')
    await resolveBlobSrc(B, 'image/png')
    expect(peekBlobSrc(A)).not.toBeNull() // a touch: B is now the oldest
    await resolveBlobSrc(C, 'image/png')

    expect(peekBlobSrc(B)).toBeNull()
    expect(peekBlobSrc(A)).not.toBeNull()
    expect(peekBlobSrc(C)).not.toBeNull()
  })

  it('serves, but does not keep, a single blob larger than the whole cache', async () => {
    setBlobCacheLimitForTests(10)
    expect(await resolveBlobSrc(A, 'image/png')).toBe('data:image/png;base64,DATA-a')
    expect(peekBlobSrc(A)).toBeNull()
  })

  it('caps the default bound at 128 MiB of base64', () => {
    expect(BLOB_CACHE_MAX_BYTES).toBe(128 * 1024 * 1024)
  })
})

describe('missing blobs', () => {
  it('remembers a null answer, and asks the host again once the TTL has passed', async () => {
    vi.useFakeTimers()
    getBlob.mockResolvedValue(null)

    expect(await resolveBlobSrc(A, 'image/png')).toBeNull()
    expect(isBlobKnownMissing(A)).toBe(true)
    expect(await resolveBlobSrc(A, 'image/png')).toBeNull()
    expect(getBlob).toHaveBeenCalledTimes(1)

    // The host re-interns a blob whenever a transcript containing it is re-read,
    // so "missing" must not be forever.
    vi.advanceTimersByTime(MISSING_TTL_MS + 1)
    expect(isBlobKnownMissing(A)).toBe(false)
    getBlob.mockResolvedValue({ mediaType: 'image/png', base64Data: 'BACK' })
    expect(await resolveBlobSrc(A, 'image/png')).toBe('data:image/png;base64,BACK')
    expect(getBlob).toHaveBeenCalledTimes(2)
  })

  it('treats an empty payload like a miss', async () => {
    getBlob.mockResolvedValue({ mediaType: 'image/png', base64Data: '' })
    expect(await resolveBlobSrc(A, 'image/png')).toBeNull()
    expect(isBlobKnownMissing(A)).toBe(true)
  })

  it('does not remember a transport failure as missing — the next mount asks again', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    getBlob.mockRejectedValueOnce(new Error('socket closed'))

    expect(await resolveBlobSrc(A, 'image/png')).toBeNull()
    expect(isBlobKnownMissing(A)).toBe(false)
    expect(await resolveBlobSrc(A, 'image/png')).toBe('data:image/png;base64,DATA-a')
  })

  it('a later success clears the miss', async () => {
    vi.useFakeTimers()
    getBlob.mockResolvedValueOnce(null)
    await resolveBlobSrc(A, 'image/png')
    vi.advanceTimersByTime(MISSING_TTL_MS + 1)
    await resolveBlobSrc(A, 'image/png')
    expect(isBlobKnownMissing(A)).toBe(false)
  })
})

describe('resolveBlob — ready, missing and error are different answers', () => {
  it('reports ready with the data: URI', async () => {
    expect(await resolveBlob(A, 'image/png')).toEqual({
      status: 'ready',
      src: 'data:image/png;base64,DATA-a'
    })
  })

  it('reports missing for the host answering null, and remembers it', async () => {
    getBlob.mockResolvedValue(null)
    expect(await resolveBlob(A, 'image/png')).toEqual({ status: 'missing' })
    expect(await resolveBlob(A, 'image/png')).toEqual({ status: 'missing' })
    expect(getBlob).toHaveBeenCalledTimes(1)
  })

  it('reports error for a failed fetch, never remembers it, and asks again next time', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    getBlob.mockRejectedValueOnce(new Error('Not connected'))

    expect(await resolveBlob(A, 'image/png')).toEqual({ status: 'error' })
    expect(isBlobKnownMissing(A)).toBe(false)
    expect(await resolveBlob(A, 'image/png')).toEqual({
      status: 'ready',
      src: 'data:image/png;base64,DATA-a'
    })
    expect(getBlob).toHaveBeenCalledTimes(2)
  })

  it('shares one in-flight failure between concurrent callers', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    getBlob.mockRejectedValue(new Error('Not connected'))
    const results = await Promise.all([resolveBlob(A, 'image/png'), resolveBlob(A, 'image/png')])
    expect(results).toEqual([{ status: 'error' }, { status: 'error' }])
    expect(getBlob).toHaveBeenCalledTimes(1)
  })
})

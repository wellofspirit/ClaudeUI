/**
 * useBlobSrc (ADR-087): resolve a transcript BlobRef to a data: URI without ever
 * handing out another blob's bytes, and without touching state after unmount.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useBlobSrc } from '../useBlobSrc'
import { resetBlobCacheForTests } from '../../lib/blob-cache'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)

type Answer = { mediaType: string; base64Data: string } | null
let getBlob: ReturnType<typeof vi.fn>
let pending: Array<{ blobId: string; settle: (answer: Answer) => void }>

beforeEach(() => {
  resetBlobCacheForTests()
  pending = []
  getBlob = vi.fn(
    (blobId: string) =>
      new Promise<Answer>((resolve) => {
        pending.push({ blobId, settle: resolve })
      })
  )
  window.api = { getBlob } as unknown as typeof window.api
})

const answer = (text: string): Answer => ({ mediaType: 'image/png', base64Data: text })

describe('useBlobSrc', () => {
  it('goes loading to ready', async () => {
    const { result } = renderHook(() => useBlobSrc({ blobId: A, mediaType: 'image/png' }))
    expect(result.current).toEqual({ src: null, state: 'loading' })

    await act(async () => pending[0].settle(answer('AAAA')))
    expect(result.current).toEqual({ src: 'data:image/png;base64,AAAA', state: 'ready' })
  })

  it('goes loading to missing when the host does not hold the blob', async () => {
    const { result } = renderHook(() => useBlobSrc({ blobId: A, mediaType: 'image/png' }))
    await act(async () => pending[0].settle(null))
    expect(result.current).toEqual({ src: null, state: 'missing' })
  })

  it('holds the fetch while disabled, and starts it when enabled', async () => {
    const { result, rerender } = renderHook(
      ({ enabled }) => useBlobSrc({ blobId: A, mediaType: 'image/png' }, enabled),
      { initialProps: { enabled: false } }
    )
    expect(result.current).toEqual({ src: null, state: 'idle' })
    expect(getBlob).not.toHaveBeenCalled()

    rerender({ enabled: true })
    await waitFor(() => expect(getBlob).toHaveBeenCalledTimes(1))
    await act(async () => pending[0].settle(answer('AAAA')))
    expect(result.current.state).toBe('ready')
  })

  it('is ready on the FIRST render for a blob the cache already holds (no placeholder flash)', async () => {
    const first = renderHook(() => useBlobSrc({ blobId: A, mediaType: 'image/png' }))
    await act(async () => pending[0].settle(answer('AAAA')))
    first.unmount()

    const second = renderHook(() => useBlobSrc({ blobId: A, mediaType: 'image/png' }))
    expect(second.result.current).toEqual({ src: 'data:image/png;base64,AAAA', state: 'ready' })
    expect(getBlob).toHaveBeenCalledTimes(1)
  })

  it('re-resolves when blobId changes, and never serves the old blob under the new id', async () => {
    const { result, rerender } = renderHook(
      ({ id }) => useBlobSrc({ blobId: id, mediaType: 'image/png' }),
      { initialProps: { id: A } }
    )
    await act(async () => pending[0].settle(answer('AAAA')))
    expect(result.current.src).toBe('data:image/png;base64,AAAA')

    rerender({ id: B })
    // Not ready yet — and above all not A's bytes.
    expect(result.current).toEqual({ src: null, state: 'loading' })
    await act(async () => pending[1].settle(answer('BBBB')))
    expect(result.current).toEqual({ src: 'data:image/png;base64,BBBB', state: 'ready' })
  })

  it('ignores a slow answer for the previous blob after the id changed', async () => {
    const { result, rerender } = renderHook(
      ({ id }) => useBlobSrc({ blobId: id, mediaType: 'image/png' }),
      { initialProps: { id: A } }
    )
    rerender({ id: B })

    // B answers first; A's late answer must not overwrite it.
    await act(async () => pending.find((p) => p.blobId === B)!.settle(answer('BBBB')))
    await act(async () => pending.find((p) => p.blobId === A)!.settle(answer('AAAA')))
    expect(result.current).toEqual({ src: 'data:image/png;base64,BBBB', state: 'ready' })
  })

  it('does not set state after unmount', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { unmount } = renderHook(() => useBlobSrc({ blobId: A, mediaType: 'image/png' }))
    unmount()
    await act(async () => pending[0].settle(answer('AAAA')))
    expect(error).not.toHaveBeenCalled()
    error.mockRestore()
  })

  it('is idle for a null ref', () => {
    const { result } = renderHook(() => useBlobSrc(null))
    expect(result.current).toEqual({ src: null, state: 'idle' })
    expect(getBlob).not.toHaveBeenCalled()
  })
})

/**
 * A fetch that FAILS (socket down while reconnecting, a 30 s invoke timeout) is
 * not the host saying it lacks the blob. The chat list is not virtualized, so
 * nothing remounts the image: the hook itself must keep asking.
 */
describe('useBlobSrc — retrying a failed fetch', () => {
  const OK = { mediaType: 'image/png', base64Data: 'AAAA' }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    getBlob = vi.fn()
    window.api = { getBlob } as unknown as typeof window.api
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  const advance = (ms: number): Promise<void> =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })

  it('stays loading through a rejected fetch and ends ready without a remount', async () => {
    getBlob.mockRejectedValueOnce(new Error('Not connected')).mockResolvedValue(OK)
    const { result } = renderHook(() => useBlobSrc({ blobId: A, mediaType: 'image/png' }))

    await advance(0)
    expect(getBlob).toHaveBeenCalledTimes(1)
    // Not "missing": that would be a permanent Unavailable for a transient failure.
    expect(result.current).toEqual({ src: null, state: 'loading' })

    await advance(1_999)
    expect(getBlob).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(getBlob).toHaveBeenCalledTimes(2)
    expect(result.current).toEqual({ src: 'data:image/png;base64,AAAA', state: 'ready' })
  })

  it('backs off 2 s, 4 s, 8 s, 16 s and then holds at 30 s', async () => {
    getBlob.mockRejectedValue(new Error('timed out'))
    const { result } = renderHook(() => useBlobSrc({ blobId: A, mediaType: 'image/png' }))
    await advance(0)
    expect(getBlob).toHaveBeenCalledTimes(1)

    for (const [delay, calls] of [
      [2_000, 2],
      [4_000, 3],
      [8_000, 4],
      [16_000, 5],
      [30_000, 6],
      [30_000, 7]
    ] as const) {
      await advance(delay - 1)
      expect(getBlob).toHaveBeenCalledTimes(calls - 1)
      await advance(1)
      expect(getBlob).toHaveBeenCalledTimes(calls)
    }
    expect(result.current).toEqual({ src: null, state: 'loading' })
  })

  it('does not retry a blob the host answered null for', async () => {
    getBlob.mockResolvedValue(null)
    const { result } = renderHook(() => useBlobSrc({ blobId: A, mediaType: 'image/png' }))
    await advance(0)
    expect(result.current).toEqual({ src: null, state: 'missing' })

    await advance(120_000)
    expect(getBlob).toHaveBeenCalledTimes(1)
    expect(result.current.state).toBe('missing')
  })

  it('cancels a pending retry on unmount: no fetch fires afterwards', async () => {
    getBlob.mockRejectedValue(new Error('Not connected'))
    const { unmount } = renderHook(() => useBlobSrc({ blobId: A, mediaType: 'image/png' }))
    await advance(0)
    expect(getBlob).toHaveBeenCalledTimes(1)

    unmount()
    await advance(120_000)
    expect(getBlob).toHaveBeenCalledTimes(1)
  })

  it('cancels a pending retry when the blob changes, and never sets the old blob on the new id', async () => {
    getBlob.mockImplementation(async (blobId: string) => {
      if (blobId === A) throw new Error('Not connected')
      return { mediaType: 'image/png', base64Data: 'BBBB' }
    })
    const { result, rerender } = renderHook(
      ({ id }) => useBlobSrc({ blobId: id, mediaType: 'image/png' }),
      { initialProps: { id: A } }
    )
    await advance(0)
    expect(getBlob).toHaveBeenCalledTimes(1)

    rerender({ id: B })
    await advance(0)
    expect(result.current).toEqual({ src: 'data:image/png;base64,BBBB', state: 'ready' })

    await advance(120_000)
    // A was asked once and never again; nothing overwrote B.
    expect(getBlob.mock.calls.filter(([id]) => id === A)).toHaveLength(1)
    expect(result.current).toEqual({ src: 'data:image/png;base64,BBBB', state: 'ready' })
  })

  it('cancels a pending retry when the hook is disabled, and resumes when re-enabled', async () => {
    getBlob.mockRejectedValueOnce(new Error('Not connected')).mockResolvedValue(OK)
    const { result, rerender } = renderHook(
      ({ enabled }) => useBlobSrc({ blobId: A, mediaType: 'image/png' }, enabled),
      { initialProps: { enabled: true } }
    )
    await advance(0)
    expect(getBlob).toHaveBeenCalledTimes(1)

    rerender({ enabled: false })
    await advance(120_000)
    expect(getBlob).toHaveBeenCalledTimes(1)
    expect(result.current.state).toBe('idle')

    rerender({ enabled: true })
    await advance(0)
    expect(result.current).toEqual({ src: 'data:image/png;base64,AAAA', state: 'ready' })
  })
})

/**
 * BlobImage (ADR-087): the `<img>` for a transcript image held in the host's
 * blob store. Placeholder until the bytes land, a quiet box when the host no
 * longer has them, one fetch per blob however many places show it, and no fetch
 * at all until it is near the viewport (the chat list is not virtualized).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import { BlobImage } from '../BlobImage'
import { resetBlobCacheForTests } from '../../../lib/blob-cache'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)

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
  vi.unstubAllGlobals()
})

describe('BlobImage', () => {
  it('shows a placeholder, then the resolved img with a data: URI', async () => {
    let settle!: () => void
    getBlob.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = () => resolve({ mediaType: 'image/png', base64Data: 'AAAA' })
        })
    )
    render(<BlobImage blobId={A} mediaType="image/png" alt="shot" className="thumb" />)

    const placeholder = screen.getByTestId('BlobImage')
    // A span, not a div: the thumbnail wraps it in a <button>, which only takes phrasing content.
    expect(placeholder.tagName).toBe('SPAN')
    expect(placeholder.getAttribute('data-state')).toBe('loading')
    expect(placeholder.getAttribute('data-id')).toBe(A)
    // A fixed box, so the strip does not jump when the bytes land.
    expect((placeholder as HTMLElement).style.width).toBe('120px')
    expect((placeholder as HTMLElement).style.height).toBe('120px')

    await act(async () => settle())
    const img = screen.getByTestId('BlobImage') as HTMLImageElement
    expect(img.tagName).toBe('IMG')
    expect(img.getAttribute('data-state')).toBe('ready')
    expect(img.src).toBe('data:image/png;base64,AAAA')
    expect(img.alt).toBe('shot')
    expect(img.className).toBe('thumb')
  })

  it('settles into a quiet "unavailable" box when the host no longer has the blob', async () => {
    getBlob.mockResolvedValue(null)
    render(<BlobImage blobId={A} mediaType="image/png" alt="shot" placeholderSize={80} />)

    await waitFor(() =>
      expect(screen.getByTestId('BlobImage').getAttribute('data-state')).toBe('missing')
    )
    const box = screen.getByTestId('BlobImage') as HTMLElement
    expect(box.tagName).toBe('SPAN')
    expect(box.style.width).toBe('80px')
    expect(box.textContent).toBe('Unavailable')
    expect(box.getAttribute('aria-label')).toBe('shot (unavailable)')
  })

  it('fetches ONCE for two components showing the same blob', async () => {
    render(
      <>
        <BlobImage blobId={A} mediaType="image/png" />
        <BlobImage blobId={A} mediaType="image/png" />
      </>
    )
    await waitFor(() =>
      expect(screen.getAllByTestId('BlobImage').map((el) => el.getAttribute('data-state'))).toEqual(
        ['ready', 'ready']
      )
    )
    expect(getBlob).toHaveBeenCalledTimes(1)
  })

  it('swaps to the new blob when blobId changes', async () => {
    const { rerender } = render(<BlobImage blobId={A} mediaType="image/png" />)
    await waitFor(() =>
      expect((screen.getByTestId('BlobImage') as HTMLImageElement).src).toBe(
        'data:image/png;base64,DATA-a'
      )
    )
    rerender(<BlobImage blobId={B} mediaType="image/png" />)
    await waitFor(() =>
      expect((screen.getByTestId('BlobImage') as HTMLImageElement).src).toBe(
        'data:image/png;base64,DATA-b'
      )
    )
  })

  describe('lazy resolution', () => {
    type Entry = { isIntersecting: boolean }
    let observers: Array<{
      callback: (entries: Entry[]) => void
      options: IntersectionObserverInit | undefined
      observe: ReturnType<typeof vi.fn>
      disconnect: ReturnType<typeof vi.fn>
    }>

    beforeEach(() => {
      observers = []
      class FakeIntersectionObserver {
        observe = vi.fn()
        disconnect = vi.fn()
        constructor(callback: (entries: Entry[]) => void, options?: IntersectionObserverInit) {
          observers.push({ callback, options, observe: this.observe, disconnect: this.disconnect })
        }
      }
      vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
    })

    it('does not fetch until the box is within 300px of the viewport, then stays resolved', async () => {
      render(<BlobImage blobId={A} mediaType="image/png" />)

      expect(getBlob).not.toHaveBeenCalled()
      expect(screen.getByTestId('BlobImage').getAttribute('data-state')).toBe('idle')
      expect(observers).toHaveLength(1)
      // `scrollMargin` is what reaches the chat list's nested scroll container.
      expect(observers[0].options).toEqual({ rootMargin: '300px', scrollMargin: '300px' })

      // Scrolling past without ever intersecting does nothing.
      act(() => observers[0].callback([{ isIntersecting: false }]))
      expect(getBlob).not.toHaveBeenCalled()

      act(() => observers[0].callback([{ isIntersecting: true }]))
      await waitFor(() =>
        expect(screen.getByTestId('BlobImage').getAttribute('data-state')).toBe('ready')
      )
      expect(getBlob).toHaveBeenCalledTimes(1)
      expect(observers[0].disconnect).toHaveBeenCalled()
    })

    it('renders a blob the cache already holds immediately, without waiting to be seen', async () => {
      const first = render(<BlobImage blobId={A} mediaType="image/png" />)
      act(() => observers[0].callback([{ isIntersecting: true }]))
      await waitFor(() =>
        expect(screen.getByTestId('BlobImage').getAttribute('data-state')).toBe('ready')
      )
      first.unmount()

      render(<BlobImage blobId={A} mediaType="image/png" />)
      expect(screen.getByTestId('BlobImage').getAttribute('data-state')).toBe('ready')
      expect(getBlob).toHaveBeenCalledTimes(1)
    })
  })
})

/**
 * Layer 2: Component test for SentFilesWidget.
 *
 * Reads `sentFiles` from the active session store slice; the only IPC it
 * touches is `window.api.openPath` / `showInFolder`, which are OPTIONAL on the
 * API surface (absent on the remote web client) — so their presence/absence is
 * part of what is asserted here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/react'
import { useSessionStore } from '../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { SentFilesWidget, resolveSentFilePath } from '../SentFilesWidget'
import type { SentFile } from '../../../../shared/types'

const ROUTE = 'route-sent-files'
const CWD = '/d/repo'

let nextPointerId = 100

/** ImageViewerOverlay resolves taps from pointer events, never from `click`. */
function tapViewer(el: Element): void {
  const pointerId = nextPointerId++
  fireEvent.pointerDown(el, { pointerId, clientX: 500, clientY: 400, button: 0 })
  fireEvent.pointerUp(el, { pointerId, clientX: 500, clientY: 400, button: 0 })
}

function makeFile(overrides: Partial<SentFile> = {}): SentFile {
  return { path: 'report.html', toolUseId: 'tu-1', ...overrides }
}

describe('SentFilesWidget', () => {
  let app: TestApp

  beforeEach(async () => {
    window.localStorage.clear()
    app = await bootTestApp()
    useSessionStore.getState().createNewSession(ROUTE, CWD)
    useSessionStore.setState({ activeSessionId: ROUTE })
  })

  afterEach(() => {
    // Drop the optional shell methods BEFORE teardown — teardown removes
    // window.api entirely, and touching it afterwards throws.
    if (window.api) {
      delete (window.api as unknown as Record<string, unknown>).openPath
      delete (window.api as unknown as Record<string, unknown>).showInFolder
      delete (window.api as unknown as Record<string, unknown>).getSentFilePreview
      ;(window.api as unknown as Record<string, unknown>).platform = process.platform
    }
    delete (window as unknown as Record<string, unknown>).__FILE_TOKEN__
    window.localStorage.clear()
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
  })

  it('renders nothing when no files were sent', () => {
    const { container } = render(<SentFilesWidget />)
    expect(container.firstChild).toBeNull()
  })

  it('renders the count and one row per file, newest first', () => {
    useSessionStore
      .getState()
      .setSentFiles(ROUTE, [
        makeFile({ path: 'a/old.txt', toolUseId: 'tu-a' }),
        makeFile({ path: 'b/new.txt', toolUseId: 'tu-b' })
      ])

    const { getByTestId, getAllByTestId } = render(<SentFilesWidget />)
    expect(getByTestId('SentFilesWidget')).toBeInTheDocument()
    expect(getByTestId('SentFilesWidget.toggle').textContent).toContain('Files')
    expect(getByTestId('SentFilesWidget.toggle').textContent).toContain('2')

    const rows = getAllByTestId('SentFilesWidget.row')
    expect(rows.map((r) => r.getAttribute('data-id'))).toEqual(['b/new.txt', 'a/old.txt'])
    // Basename is derived, not stored
    expect(rows[0].textContent).toContain('new.txt')
    expect(rows[0].textContent).not.toContain('b/')
  })

  it('expands each row individually', () => {
    useSessionStore
      .getState()
      .setSentFiles(ROUTE, [
        makeFile({ path: 'one.txt', toolUseId: 'tu-1', caption: 'first caption' }),
        makeFile({ path: 'two.txt', toolUseId: 'tu-2', caption: 'second caption' })
      ])

    const { getAllByTestId, container } = render(<SentFilesWidget />)
    expect(container.textContent).not.toContain('first caption')
    expect(container.textContent).not.toContain('second caption')

    // rows[0] is two.txt (newest first)
    fireEvent.click(getAllByTestId('SentFilesWidget.row')[0])
    expect(container.textContent).toContain('second caption')
    expect(container.textContent).not.toContain('first caption')

    fireEvent.click(getAllByTestId('SentFilesWidget.row')[1])
    expect(container.textContent).toContain('first caption')
    expect(container.textContent).toContain('second caption')

    // Toggling closed collapses only that row
    fireEvent.click(getAllByTestId('SentFilesWidget.row')[0])
    expect(container.textContent).not.toContain('second caption')
    expect(container.textContent).toContain('first caption')
  })

  it('Open calls api.openPath with the cwd-resolved absolute path', async () => {
    const openPath = vi.fn().mockResolvedValue({})
    ;(window.api as unknown as Record<string, unknown>).openPath = openPath
    useSessionStore.getState().setSentFiles(ROUTE, [makeFile({ path: 'out/report.html' })])

    const { getByTestId } = render(<SentFilesWidget />)
    fireEvent.click(getByTestId('SentFilesWidget.row'))
    fireEvent.click(getByTestId('SentFilesWidget.open'))

    await waitFor(() => expect(openPath).toHaveBeenCalledWith('/d/repo/out/report.html'))
  })

  it('passes an already-absolute path through untouched', async () => {
    const showInFolder = vi.fn().mockResolvedValue({})
    ;(window.api as unknown as Record<string, unknown>).showInFolder = showInFolder
    useSessionStore.getState().setSentFiles(ROUTE, [makeFile({ path: 'D:\\other\\x.png' })])

    const { getByTestId } = render(<SentFilesWidget />)
    fireEvent.click(getByTestId('SentFilesWidget.row'))
    fireEvent.click(getByTestId('SentFilesWidget.reveal'))

    await waitFor(() => expect(showInFolder).toHaveBeenCalledWith('D:\\other\\x.png'))
  })

  it('surfaces an openPath error inline in the row detail', async () => {
    ;(window.api as unknown as Record<string, unknown>).openPath = vi
      .fn()
      .mockResolvedValue({ error: 'File does not exist' })
    useSessionStore.getState().setSentFiles(ROUTE, [makeFile({ path: 'gone.txt' })])

    const { getByTestId, container } = render(<SentFilesWidget />)
    fireEvent.click(getByTestId('SentFilesWidget.row'))
    fireEvent.click(getByTestId('SentFilesWidget.open'))

    await waitFor(() => expect(container.textContent).toContain('File does not exist'))
  })

  it('shows the tool error on an errored row', () => {
    useSessionStore
      .getState()
      .setSentFiles(ROUTE, [makeFile({ path: 'nope.txt', error: 'File not found: nope.txt' })])

    const { getByTestId, container } = render(<SentFilesWidget />)
    fireEvent.click(getByTestId('SentFilesWidget.row'))
    expect(container.textContent).toContain('File not found: nope.txt')
  })

  it('hides the shell buttons when the api methods are absent (remote web client)', () => {
    useSessionStore.getState().setSentFiles(ROUTE, [makeFile()])
    const { getByTestId, queryByTestId } = render(<SentFilesWidget />)
    fireEvent.click(getByTestId('SentFilesWidget.row'))
    expect(queryByTestId('SentFilesWidget.open')).toBeNull()
    expect(queryByTestId('SentFilesWidget.reveal')).toBeNull()
  })

  // -------------------------------------------------------------------------
  // Image preview (ADR-043 §4)
  // -------------------------------------------------------------------------

  const setPreview = (fn: unknown): void => {
    ;(window.api as unknown as Record<string, unknown>).getSentFilePreview = fn
  }

  it('fetches a thumbnail lazily when an image row is first expanded', async () => {
    const getSentFilePreview = vi.fn().mockResolvedValue({ src: 'data:image/png;base64,AAAA' })
    setPreview(getSentFilePreview)
    useSessionStore.getState().setSentFiles(ROUTE, [makeFile({ path: 'out/shot.png' })])

    const { getByTestId, queryByTestId } = render(<SentFilesWidget />)
    // Nothing is fetched until the row is opened.
    expect(getSentFilePreview).not.toHaveBeenCalled()
    expect(queryByTestId('SentFilesWidget.thumb')).toBeNull()

    fireEvent.click(getByTestId('SentFilesWidget.row'))
    // (sessionKey, absolute path) — the web transport needs the routingId.
    expect(getSentFilePreview).toHaveBeenCalledWith(ROUTE, '/d/repo/out/shot.png')

    const thumb = (await waitFor(() => getByTestId('SentFilesWidget.thumb'))) as HTMLImageElement
    expect(thumb.src).toBe('data:image/png;base64,AAAA')

    // Collapsing and re-expanding must not re-fetch.
    fireEvent.click(getByTestId('SentFilesWidget.row'))
    fireEvent.click(getByTestId('SentFilesWidget.row'))
    expect(getSentFilePreview).toHaveBeenCalledTimes(1)
  })

  it('does not request a preview for non-image files', () => {
    const getSentFilePreview = vi.fn().mockResolvedValue({ src: 'data:x' })
    setPreview(getSentFilePreview)
    useSessionStore.getState().setSentFiles(ROUTE, [makeFile({ path: 'out/report.html' })])

    const { getByTestId, queryByTestId } = render(<SentFilesWidget />)
    fireEvent.click(getByTestId('SentFilesWidget.row'))
    expect(getSentFilePreview).not.toHaveBeenCalled()
    expect(queryByTestId('SentFilesWidget.thumb')).toBeNull()
  })

  it('shows a preview error inline and keeps the plain path row', async () => {
    setPreview(vi.fn().mockResolvedValue({ error: 'Image is too large to preview (max 10 MB)' }))
    useSessionStore.getState().setSentFiles(ROUTE, [makeFile({ path: 'big.png' })])

    const { getByTestId, queryByTestId, container } = render(<SentFilesWidget />)
    fireEvent.click(getByTestId('SentFilesWidget.row'))
    await waitFor(() => expect(container.textContent).toContain('too large to preview'))
    expect(queryByTestId('SentFilesWidget.thumb')).toBeNull()
    expect(container.textContent).toContain('/d/repo/big.png')
  })

  // The widget's own ad-hoc lightbox was replaced by the shared
  // ImageViewerOverlay, so these assert that component's testids now.
  it('opens and closes the shared image viewer from the thumbnail', async () => {
    setPreview(vi.fn().mockResolvedValue({ src: 'data:image/png;base64,BBBB' }))
    useSessionStore.getState().setSentFiles(ROUTE, [makeFile({ path: 'shot.png' })])

    const { getByTestId, queryByTestId } = render(<SentFilesWidget />)
    fireEvent.click(getByTestId('SentFilesWidget.row'))
    fireEvent.click(await waitFor(() => getByTestId('SentFilesWidget.thumb')))

    expect(getByTestId('ImageViewerOverlay')).toBeInTheDocument()
    expect((getByTestId('ImageViewerOverlay.image') as HTMLImageElement).src).toBe(
      'data:image/png;base64,BBBB'
    )
    // Tapping the image itself must not dismiss it.
    tapViewer(getByTestId('ImageViewerOverlay.image'))
    expect(queryByTestId('ImageViewerOverlay')).not.toBeNull()
    // A tap on the backdrop around the image closes (dismissal lives in the
    // pointer state machine, not in a click handler — see ImageViewerOverlay).
    tapViewer(getByTestId('ImageViewerOverlay.viewport'))
    expect(queryByTestId('ImageViewerOverlay')).toBeNull()

    // Escape closes too.
    fireEvent.click(getByTestId('SentFilesWidget.thumb'))
    expect(queryByTestId('ImageViewerOverlay')).not.toBeNull()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(queryByTestId('ImageViewerOverlay')).toBeNull()
  })

  it('pages the viewer across every sent file that has a loaded preview', async () => {
    setPreview(
      vi
        .fn()
        .mockImplementation((_session: string, path: string) =>
          Promise.resolve({ src: `data:image/png;base64,${path.endsWith('a.png') ? 'AAAA' : 'BBBB'}` })
        )
    )
    useSessionStore
      .getState()
      .setSentFiles(ROUTE, [
        makeFile({ path: 'a.png', toolUseId: 'tu-a' }),
        makeFile({ path: 'b.png', toolUseId: 'tu-b' })
      ])

    const { getAllByTestId, getByTestId } = render(<SentFilesWidget />)
    // Rows render newest-first, so the gallery is [b.png, a.png].
    fireEvent.click(getAllByTestId('SentFilesWidget.row')[0])
    fireEvent.click(getAllByTestId('SentFilesWidget.row')[1])
    await waitFor(() => expect(getAllByTestId('SentFilesWidget.thumb')).toHaveLength(2))

    fireEvent.click(getAllByTestId('SentFilesWidget.thumb')[1])
    expect(getByTestId('ImageViewerOverlay.counter').textContent).toBe('2 / 2')
    fireEvent.click(getByTestId('ImageViewerOverlay.prev'))
    expect(getByTestId('ImageViewerOverlay.counter').textContent).toBe('1 / 2')
    expect((getByTestId('ImageViewerOverlay.image') as HTMLImageElement).src).toBe(
      'data:image/png;base64,BBBB'
    )
  })

  // -------------------------------------------------------------------------
  // Remote download affordance (ADR-043 §5)
  // -------------------------------------------------------------------------

  it('shows a Download anchor on the web client once the file token arrives', () => {
    ;(window.api as unknown as Record<string, unknown>).platform = 'web'
    ;(window as unknown as Record<string, unknown>).__FILE_TOKEN__ = 'f'.repeat(64)
    useSessionStore.getState().setSentFiles(ROUTE, [makeFile({ path: 'out/report.html' })])

    const { getByTestId } = render(<SentFilesWidget />)
    fireEvent.click(getByTestId('SentFilesWidget.row'))
    const anchor = getByTestId('SentFilesWidget.download') as HTMLAnchorElement
    const url = new URL(anchor.href)
    expect(url.pathname).toBe('/sent-file')
    expect(url.searchParams.get('session')).toBe(ROUTE)
    expect(url.searchParams.get('token')).toBe('f'.repeat(64))
    expect(url.searchParams.get('inline')).toBeNull()
    expect(anchor.getAttribute('download')).toBe('report.html')
  })

  it('hides Download on the web client while the token is missing', () => {
    ;(window.api as unknown as Record<string, unknown>).platform = 'web'
    useSessionStore.getState().setSentFiles(ROUTE, [makeFile()])
    const { getByTestId, queryByTestId } = render(<SentFilesWidget />)
    fireEvent.click(getByTestId('SentFilesWidget.row'))
    expect(queryByTestId('SentFilesWidget.download')).toBeNull()
  })

  it('hides Download on the desktop even if a token somehow exists', () => {
    ;(window as unknown as Record<string, unknown>).__FILE_TOKEN__ = 'f'.repeat(64)
    useSessionStore.getState().setSentFiles(ROUTE, [makeFile()])
    const { getByTestId, queryByTestId } = render(<SentFilesWidget />)
    fireEvent.click(getByTestId('SentFilesWidget.row'))
    expect(queryByTestId('SentFilesWidget.download')).toBeNull()
  })

  // -------------------------------------------------------------------------
  // Draggability (ADR-043 §2) — the header is both the toggle and the handle.
  // -------------------------------------------------------------------------

  it('keeps header click-to-expand working and detaches only on a real drag', () => {
    useSessionStore.getState().setSentFiles(ROUTE, [makeFile({ caption: 'cap' })])
    const { getByTestId, container } = render(<SentFilesWidget />)
    const header = getByTestId('SentFilesWidget.toggle')

    fireEvent.pointerDown(header, { pointerId: 1, button: 0, clientX: 10, clientY: 10 })
    fireEvent.pointerUp(header, { pointerId: 1, clientX: 10, clientY: 10 })
    fireEvent.click(header)
    expect(getByTestId('SentFilesWidget').hasAttribute('data-dragged')).toBe(false)
    // Expanded: the body's max-height opened up.
    expect(container.innerHTML).toContain('max-height: 300px')

    fireEvent.pointerDown(header, { pointerId: 1, button: 0, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(header, { pointerId: 1, clientX: 10, clientY: 60 })
    fireEvent.pointerUp(header, { pointerId: 1, clientX: 10, clientY: 60 })
    fireEvent.click(header)

    const root = getByTestId('SentFilesWidget') as HTMLElement
    expect(root.getAttribute('data-dragged')).toBe('true')
    expect(root.style.position).toBe('fixed')
    // Still expanded — the drag must not have toggled it shut.
    expect(container.innerHTML).toContain('max-height: 300px')
  })
})

describe('resolveSentFilePath', () => {
  it('joins a relative path onto a POSIX cwd', () => {
    expect(resolveSentFilePath('/d/repo', 'out/a.txt')).toBe('/d/repo/out/a.txt')
  })

  it('strips a leading ./', () => {
    expect(resolveSentFilePath('/d/repo', './a.txt')).toBe('/d/repo/a.txt')
  })

  it('joins onto a Windows cwd using a backslash', () => {
    expect(resolveSentFilePath('D:\\repo', 'out\\a.txt')).toBe('D:\\repo\\out\\a.txt')
  })

  it('does not double the separator on a trailing-slash cwd', () => {
    expect(resolveSentFilePath('/d/repo/', 'a.txt')).toBe('/d/repo/a.txt')
  })

  it('leaves POSIX and Windows absolute paths alone', () => {
    expect(resolveSentFilePath('/d/repo', '/tmp/a.txt')).toBe('/tmp/a.txt')
    expect(resolveSentFilePath('/d/repo', 'C:/tmp/a.txt')).toBe('C:/tmp/a.txt')
    expect(resolveSentFilePath('/d/repo', 'C:\\tmp\\a.txt')).toBe('C:\\tmp\\a.txt')
  })

  it('returns the input when there is no cwd', () => {
    expect(resolveSentFilePath('', 'a.txt')).toBe('a.txt')
  })
})

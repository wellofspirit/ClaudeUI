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

function makeFile(overrides: Partial<SentFile> = {}): SentFile {
  return { path: 'report.html', toolUseId: 'tu-1', ...overrides }
}

describe('SentFilesWidget', () => {
  let app: TestApp

  beforeEach(async () => {
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
    }
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

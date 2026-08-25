/**
 * Layer 2: the inline directory browser that stands in for the native folder
 * dialog on the remote web client.
 *
 * What matters here is that the widget can only ever hand back a path the HOST
 * confirmed: the listing, the filtering and the confirm check all go through
 * the injected `listDir` (i.e. `file:list-dir` over the remote dispatcher), and
 * a path that does not resolve there must never reach `onConfirm` — otherwise
 * the web client would start a session in a directory that exists only on the
 * phone that typed it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { StrictMode } from 'react'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { DirectoryBrowserInput } from '../DirectoryBrowserInput'
import type { DirEntry } from '../../../../../shared/types'

// jsdom has no layout engine
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = (): void => {}

afterEach(cleanup)

// Mirrors listDirEntries(): POSIX resolvedPath with the trailing slash stripped,
// and the empty shape (resolvedPath: '') for anything unreadable.
const FS: Record<string, DirEntry[]> = {
  'D:/': [{ name: 'work', isDirectory: true }],
  'D:/work': [
    { name: 'ClaudeUI', isDirectory: true },
    { name: 'claude-memory', isDirectory: true },
    { name: 'notes.txt', isDirectory: false }
  ],
  'D:/work/ClaudeUI': [{ name: 'src', isDirectory: true }],
  'D:/work/claude-memory': [{ name: 'notes', isDirectory: true }]
}

type ListDir = (
  dirPath: string
) => Promise<{ entries: DirEntry[]; isRoot: boolean; resolvedPath: string }>

function makeListDir(): ReturnType<typeof vi.fn<ListDir>> {
  return vi.fn<ListDir>(async (dirPath: string) => {
    let key = dirPath.replace(/\\/g, '/')
    if (key.length > 1 && key.endsWith('/') && !key.endsWith(':/')) key = key.slice(0, -1)
    const entries = FS[key]
    if (!entries) return { entries: [], isRoot: false, resolvedPath: '' }
    return { entries, isRoot: key === 'D:/', resolvedPath: key.replace(/\/$/, '') }
  })
}

function renderBrowser(listDir = makeListDir()): {
  listDir: ReturnType<typeof vi.fn<ListDir>>
  onConfirm: ReturnType<typeof vi.fn>
  onCancel: ReturnType<typeof vi.fn>
  input: HTMLInputElement
} {
  const onConfirm = vi.fn()
  const onCancel = vi.fn()
  render(<DirectoryBrowserInput listDir={listDir} onConfirm={onConfirm} onCancel={onCancel} />)
  return {
    listDir,
    onConfirm,
    onCancel,
    input: screen.getByTestId('DirectoryBrowserInput.path') as HTMLInputElement
  }
}

const entryNames = (): string[] =>
  screen.queryAllByTestId('DirectoryBrowserInput.entry').map((e) => e.getAttribute('data-id') ?? '')

describe('DirectoryBrowserInput', () => {
  it('lists only directories of the typed absolute path, with a synthesized ".."', async () => {
    const { listDir } = renderBrowser()
    fireEvent.change(screen.getByTestId('DirectoryBrowserInput.path'), {
      target: { value: 'D:/work/' }
    })

    await waitFor(() => expect(entryNames()).toEqual(['..', 'ClaudeUI', 'claude-memory']))
    expect(listDir).toHaveBeenCalledWith('D:/work')
  })

  it('omits ".." at a filesystem root', async () => {
    renderBrowser()
    fireEvent.change(screen.getByTestId('DirectoryBrowserInput.path'), {
      target: { value: 'D:/' }
    })

    await waitFor(() => expect(entryNames()).toEqual(['work']))
  })

  it('filters entries by the trailing path segment', async () => {
    renderBrowser()
    fireEvent.change(screen.getByTestId('DirectoryBrowserInput.path'), {
      target: { value: 'D:/work/claude-' }
    })

    await waitFor(() => expect(entryNames()).toEqual(['claude-memory']))
  })

  it('never lists a relative path (nothing to resolve it against on the host)', async () => {
    const { listDir } = renderBrowser()
    fireEvent.change(screen.getByTestId('DirectoryBrowserInput.path'), {
      target: { value: 'work/' }
    })

    await waitFor(() => expect(entryNames()).toEqual([]))
    // The mount-time home seed is the only call the host ever sees.
    expect(listDir.mock.calls.map(([p]) => p)).toEqual([''])
  })

  it('opens on the host home directory instead of an empty box', async () => {
    // `listDirEntries('')` answers with the host's homedir. Without the seed the
    // widget rendered an input that listed nothing at all until the user typed
    // an absolute path — the "picker doesn't work" report.
    const listDir = vi.fn<ListDir>(async (dirPath: string) => {
      const key = dirPath === '' ? 'D:/work' : dirPath.replace(/\\/g, '/').replace(/(.)\/$/, '$1')
      const entries = FS[key]
      if (!entries) return { entries: [], isRoot: false, resolvedPath: '' }
      return { entries, isRoot: false, resolvedPath: key }
    })
    const { input } = renderBrowser(listDir)

    await waitFor(() => expect(input.value).toBe('D:/work/'))
    await waitFor(() => expect(entryNames()).toEqual(['..', 'ClaudeUI', 'claude-memory']))
    expect(listDir).toHaveBeenCalledWith('')
  })

  it('still seeds under StrictMode, whose double-invoked effect discards the first pass', async () => {
    const listDir = vi.fn<ListDir>(async (dirPath: string) => {
      const key = dirPath === '' ? 'D:/work' : dirPath.replace(/\\/g, '/')
      const entries = FS[key]
      if (!entries) return { entries: [], isRoot: false, resolvedPath: '' }
      return { entries, isRoot: false, resolvedPath: key }
    })
    render(
      <StrictMode>
        <DirectoryBrowserInput listDir={listDir} onConfirm={vi.fn()} onCancel={vi.fn()} />
      </StrictMode>
    )

    await waitFor(() =>
      expect((screen.getByTestId('DirectoryBrowserInput.path') as HTMLInputElement).value).toBe(
        'D:/work/'
      )
    )
  })

  it('stays empty and silent when the host cannot seed a home directory', async () => {
    const { input, listDir } = renderBrowser()

    await waitFor(() => expect(listDir).toHaveBeenCalledWith(''))
    expect(input.value).toBe('')
    expect(entryNames()).toEqual([])
    expect(screen.queryByTestId('DirectoryBrowserInput.error')).toBeNull()
  })

  it('does not overwrite a path typed before the seed resolves', async () => {
    let releaseSeed: (() => void) | undefined
    const listDir = vi.fn<ListDir>(async (dirPath: string) => {
      if (dirPath === '') {
        await new Promise<void>((resolve) => {
          releaseSeed = resolve
        })
        return { entries: FS['D:/work'], isRoot: false, resolvedPath: 'D:/work' }
      }
      const key = dirPath.replace(/\\/g, '/')
      const entries = FS[key]
      if (!entries) return { entries: [], isRoot: false, resolvedPath: '' }
      return { entries, isRoot: false, resolvedPath: key }
    })
    const { input } = renderBrowser(listDir)

    fireEvent.change(input, { target: { value: 'D:/work/ClaudeUI/' } })
    await waitFor(() => expect(releaseSeed).toBeDefined())
    releaseSeed!()

    await waitFor(() => expect(entryNames()).toEqual(['..', 'src']))
    expect(input.value).toBe('D:/work/ClaudeUI/')
  })

  it('descends into a clicked directory, then Enter confirms the host-resolved path', async () => {
    const { input, onConfirm } = renderBrowser()
    fireEvent.change(input, { target: { value: 'D:/work/' } })
    await waitFor(() => expect(entryNames()).toContain('ClaudeUI'))

    fireEvent.click(
      screen
        .getAllByTestId('DirectoryBrowserInput.entry')
        .find((e) => e.getAttribute('data-id') === 'ClaudeUI')!
    )
    expect(input.value).toBe('D:/work/ClaudeUI/')
    await waitFor(() => expect(entryNames()).toEqual(['..', 'src']))

    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('D:/work/ClaudeUI'))
  })

  it('Tab descends into the highlighted entry', async () => {
    const { input } = renderBrowser()
    fireEvent.change(input, { target: { value: 'D:/work/claude-' } })
    await waitFor(() => expect(entryNames()).toEqual(['claude-memory']))

    fireEvent.keyDown(input, { key: 'Tab' })
    expect(input.value).toBe('D:/work/claude-memory/')
    await waitFor(() => expect(entryNames()).toEqual(['..', 'notes']))
  })

  it('ArrowDown moves the highlight, and ".." walks back up to the parent', async () => {
    const { input } = renderBrowser()
    fireEvent.change(input, { target: { value: 'D:/work/ClaudeUI/' } })
    await waitFor(() => expect(entryNames()).toEqual(['..', 'src']))

    // highlight starts on '..' — Tab there walks up
    fireEvent.keyDown(input, { key: 'Tab' })
    expect(input.value).toBe('D:/work/')

    await waitFor(() => expect(entryNames()).toEqual(['..', 'ClaudeUI', 'claude-memory']))
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Tab' })
    expect(input.value).toBe('D:/work/ClaudeUI/')
    await waitFor(() => expect(entryNames()).toEqual(['..', 'src']))
  })

  it('Escape cancels', () => {
    const { input, onCancel, onConfirm } = renderBrowser()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('shows an inline error and does NOT confirm a path the host cannot list', async () => {
    const { input, onConfirm } = renderBrowser()
    fireEvent.change(input, { target: { value: 'D:/does-not-exist' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() =>
      expect(screen.getByTestId('DirectoryBrowserInput.error')).toHaveTextContent(
        'No such directory on the host'
      )
    )
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('confirms a path typed without a trailing separator', async () => {
    const { input, onConfirm } = renderBrowser()
    fireEvent.change(input, { target: { value: 'D:/work/ClaudeUI' } })
    fireEvent.click(screen.getByTestId('DirectoryBrowserInput.confirm'))

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('D:/work/ClaudeUI'))
  })

  it('keeps a drive root usable as a cwd (the handler strips its trailing slash)', async () => {
    const { input, onConfirm } = renderBrowser()
    fireEvent.change(input, { target: { value: 'D:/' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    // resolvedPath comes back as 'D:', which is CWD-relative on Windows
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('D:/'))
  })
})

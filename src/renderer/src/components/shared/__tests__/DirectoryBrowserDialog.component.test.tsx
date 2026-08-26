/**
 * Layer 2: the modal directory browser that stands in for the native folder
 * dialog on the remote web client (ADR-046, Option C).
 *
 * What matters here is that the dialog can only ever hand back a path the HOST
 * confirmed: the listing, the filtering and the confirm check all go through
 * the injected `listDir` (i.e. `file:list-dir` over the remote dispatcher), and
 * a path that does not resolve there must never reach `onConfirm` — otherwise
 * the web client would start a session in a directory that exists only on the
 * phone that typed it.
 *
 * The places rail is a second, weaker source of paths: `file:list-places` and
 * the caller's recents. A rail click NAVIGATES, so those paths go through the
 * same host confirmation as a typed one.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { StrictMode } from 'react'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { DirectoryBrowserDialog } from '../DirectoryBrowserDialog'
import type { DirEntry, ListPlacesResult } from '../../../../../shared/types'

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
type ListPlaces = () => Promise<ListPlacesResult>

function makeListDir(): ReturnType<typeof vi.fn<ListDir>> {
  return vi.fn<ListDir>(async (dirPath: string) => {
    let key = dirPath.replace(/\\/g, '/')
    if (key.length > 1 && key.endsWith('/') && !key.endsWith(':/')) key = key.slice(0, -1)
    const entries = FS[key]
    if (!entries) return { entries: [], isRoot: false, resolvedPath: '' }
    return { entries, isRoot: key === 'D:/', resolvedPath: key.replace(/\/$/, '') }
  })
}

const NO_PLACES: ListPlacesResult = { home: '', hostname: '', drives: [] }

function makeListPlaces(
  places: ListPlacesResult = NO_PLACES
): ReturnType<typeof vi.fn<ListPlaces>> {
  return vi.fn<ListPlaces>(async () => places)
}

interface RenderOpts {
  listDir?: ReturnType<typeof vi.fn<ListDir>>
  listPlaces?: ReturnType<typeof vi.fn<ListPlaces>>
  recents?: Array<{ cwd: string; folderName: string }>
  initialPath?: string
  confirmLabel?: string
}

function renderDialog(opts: RenderOpts = {}): {
  listDir: ReturnType<typeof vi.fn<ListDir>>
  listPlaces: ReturnType<typeof vi.fn<ListPlaces>>
  onConfirm: ReturnType<typeof vi.fn>
  onCancel: ReturnType<typeof vi.fn>
  input: HTMLInputElement
} {
  const listDir = opts.listDir ?? makeListDir()
  const listPlaces = opts.listPlaces ?? makeListPlaces()
  const onConfirm = vi.fn()
  const onCancel = vi.fn()
  render(
    <DirectoryBrowserDialog
      listDir={listDir}
      listPlaces={listPlaces}
      recents={opts.recents}
      initialPath={opts.initialPath}
      confirmLabel={opts.confirmLabel}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  )
  return {
    listDir,
    listPlaces,
    onConfirm,
    onCancel,
    input: screen.getByTestId('DirectoryBrowserDialog.path') as HTMLInputElement
  }
}

const idsOf = (testid: string): string[] =>
  screen.queryAllByTestId(testid).map((e) => e.getAttribute('data-id') ?? '')

const entryNames = (): string[] => idsOf('DirectoryBrowserDialog.entry')

describe('DirectoryBrowserDialog — browse pane', () => {
  it('lists only directories of the typed absolute path, with a synthesized ".."', async () => {
    const { listDir } = renderDialog()
    fireEvent.change(screen.getByTestId('DirectoryBrowserDialog.path'), {
      target: { value: 'D:/work/' }
    })

    await waitFor(() => expect(entryNames()).toEqual(['..', 'ClaudeUI', 'claude-memory']))
    expect(listDir).toHaveBeenCalledWith('D:/work')
  })

  it('omits ".." at a filesystem root', async () => {
    renderDialog()
    fireEvent.change(screen.getByTestId('DirectoryBrowserDialog.path'), {
      target: { value: 'D:/' }
    })

    await waitFor(() => expect(entryNames()).toEqual(['work']))
  })

  it('filters entries by the trailing path segment', async () => {
    renderDialog()
    fireEvent.change(screen.getByTestId('DirectoryBrowserDialog.path'), {
      target: { value: 'D:/work/claude-' }
    })

    await waitFor(() => expect(entryNames()).toEqual(['claude-memory']))
  })

  it('never lists a relative path (nothing to resolve it against on the host)', async () => {
    const { listDir } = renderDialog()
    fireEvent.change(screen.getByTestId('DirectoryBrowserDialog.path'), {
      target: { value: 'work/' }
    })

    await waitFor(() => expect(entryNames()).toEqual([]))
    // The mount-time home seed is the only call the host ever sees.
    expect(listDir.mock.calls.map(([p]) => p)).toEqual([''])
  })

  it('opens on the host home directory instead of an empty box', async () => {
    // `listDirEntries('')` answers with the host's homedir. Without the seed the
    // dialog rendered an input that listed nothing at all until the user typed
    // an absolute path — the "picker doesn't work" report.
    const listDir = vi.fn<ListDir>(async (dirPath: string) => {
      const key = dirPath === '' ? 'D:/work' : dirPath.replace(/\\/g, '/').replace(/(.)\/$/, '$1')
      const entries = FS[key]
      if (!entries) return { entries: [], isRoot: false, resolvedPath: '' }
      return { entries, isRoot: false, resolvedPath: key }
    })
    const { input } = renderDialog({ listDir })

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
        <DirectoryBrowserDialog
          listDir={listDir}
          listPlaces={makeListPlaces()}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />
      </StrictMode>
    )

    await waitFor(() =>
      expect((screen.getByTestId('DirectoryBrowserDialog.path') as HTMLInputElement).value).toBe(
        'D:/work/'
      )
    )
  })

  it('stays empty and silent when the host cannot seed a home directory', async () => {
    const { input, listDir } = renderDialog()

    await waitFor(() => expect(listDir).toHaveBeenCalledWith(''))
    expect(input.value).toBe('')
    expect(entryNames()).toEqual([])
    expect(screen.queryByTestId('DirectoryBrowserDialog.error')).toBeNull()
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
    const { input } = renderDialog({ listDir })

    fireEvent.change(input, { target: { value: 'D:/work/ClaudeUI/' } })
    await waitFor(() => expect(releaseSeed).toBeDefined())
    releaseSeed!()

    await waitFor(() => expect(entryNames()).toEqual(['..', 'src']))
    expect(input.value).toBe('D:/work/ClaudeUI/')
  })

  it('descends into a clicked directory, then Enter confirms the host-resolved path', async () => {
    const { input, onConfirm } = renderDialog()
    fireEvent.change(input, { target: { value: 'D:/work/' } })
    await waitFor(() => expect(entryNames()).toContain('ClaudeUI'))

    fireEvent.click(
      screen
        .getAllByTestId('DirectoryBrowserDialog.entry')
        .find((e) => e.getAttribute('data-id') === 'ClaudeUI')!
    )
    expect(input.value).toBe('D:/work/ClaudeUI/')
    await waitFor(() => expect(entryNames()).toEqual(['..', 'src']))

    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('D:/work/ClaudeUI'))
  })

  it('Tab descends into the highlighted entry', async () => {
    const { input } = renderDialog()
    fireEvent.change(input, { target: { value: 'D:/work/claude-' } })
    await waitFor(() => expect(entryNames()).toEqual(['claude-memory']))

    fireEvent.keyDown(input, { key: 'Tab' })
    expect(input.value).toBe('D:/work/claude-memory/')
    await waitFor(() => expect(entryNames()).toEqual(['..', 'notes']))
  })

  it('ArrowRight descends only from the end of the text', async () => {
    const { input } = renderDialog()
    fireEvent.change(input, { target: { value: 'D:/work/claude-' } })
    await waitFor(() => expect(entryNames()).toEqual(['claude-memory']))

    // Caret parked mid-string: ordinary caret movement, not a descend.
    input.setSelectionRange(2, 2)
    fireEvent.keyDown(input, { key: 'ArrowRight' })
    expect(input.value).toBe('D:/work/claude-')

    input.setSelectionRange(input.value.length, input.value.length)
    fireEvent.keyDown(input, { key: 'ArrowRight' })
    expect(input.value).toBe('D:/work/claude-memory/')
  })

  it('ArrowDown moves the highlight, and ".." walks back up to the parent', async () => {
    const { input } = renderDialog()
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

  it('shows an inline error and does NOT confirm a path the host cannot list', async () => {
    const { input, onConfirm } = renderDialog()
    fireEvent.change(input, { target: { value: 'D:/does-not-exist' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() =>
      expect(screen.getByTestId('DirectoryBrowserDialog.error')).toHaveTextContent(
        'No such directory on the host'
      )
    )
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('confirms a path typed without a trailing separator', async () => {
    const { input, onConfirm } = renderDialog()
    fireEvent.change(input, { target: { value: 'D:/work/ClaudeUI' } })
    fireEvent.click(screen.getByTestId('DirectoryBrowserDialog.confirm'))

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('D:/work/ClaudeUI'))
  })

  it('confirms once for a burst of Enters, not once per keystroke', async () => {
    // Over a slow remote link, key-repeat used to put several host checks in
    // flight and fire `onConfirm` on each resolution — in WelcomeState that is
    // one duplicate session per extra Enter.
    // Only the confirm check hangs; the seed and the directory listing answer
    // at once, so nothing but re-entrancy can park a second call here.
    const releases: Array<() => void> = []
    const listDir = vi.fn<ListDir>(async (dirPath: string) => {
      if (dirPath !== 'D:/work/ClaudeUI') return { entries: [], isRoot: false, resolvedPath: '' }
      await new Promise<void>((resolve) => {
        releases.push(resolve)
      })
      return { entries: [], isRoot: false, resolvedPath: 'D:/work/ClaudeUI' }
    })
    const { input, onConfirm } = renderDialog({ listDir })

    fireEvent.change(input, { target: { value: 'D:/work/ClaudeUI' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(releases.length).toBeGreaterThan(0))
    // Release EVERY parked check: an unlatched second one would confirm again.
    for (const release of releases) release()

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1))
    expect(onConfirm).toHaveBeenCalledWith('D:/work/ClaudeUI')
    // One confirm check reached the host, on top of the mount-time '' seed.
    expect(releases).toHaveLength(1)
    expect(listDir.mock.calls.filter(([p]) => p === 'D:/work/ClaudeUI')).toHaveLength(1)
  })

  it('keeps a drive root usable as a cwd (the handler strips its trailing slash)', async () => {
    const { input, onConfirm } = renderDialog()
    fireEvent.change(input, { target: { value: 'D:/' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    // resolvedPath comes back as 'D:', which is CWD-relative on Windows
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('D:/'))
  })

  it('previews what confirm would send, and disables it while there is nothing to send', async () => {
    const { input } = renderDialog()
    expect(screen.getByTestId('DirectoryBrowserDialog.confirm')).toBeDisabled()

    fireEvent.change(input, { target: { value: 'D:/work/ClaudeUI/' } })
    expect(screen.getByTestId('DirectoryBrowserDialog.confirm')).not.toBeDisabled()
    await waitFor(() =>
      expect(screen.getByTestId('DirectoryBrowserDialog')).toHaveTextContent('D:/work/ClaudeUI')
    )
  })

  it('labels the confirm button "Select" unless the caller says otherwise', () => {
    renderDialog()
    expect(screen.getByTestId('DirectoryBrowserDialog.confirm')).toHaveTextContent('Select')
    cleanup()

    renderDialog({ confirmLabel: 'Start' })
    expect(screen.getByTestId('DirectoryBrowserDialog.confirm')).toHaveTextContent('Start')
  })
})

describe('DirectoryBrowserDialog — dismissal', () => {
  it('Escape in the input cancels exactly once', () => {
    const { input, onCancel, onConfirm } = renderDialog()
    fireEvent.keyDown(input, { key: 'Escape' })
    // The dialog root listens for Escape too (for the rail and the buttons);
    // one keystroke must still be one cancel.
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('Escape from outside the input still cancels', () => {
    const { onCancel } = renderDialog({ recents: [{ cwd: 'D:/work', folderName: 'work' }] })
    fireEvent.keyDown(screen.getByTestId('DirectoryBrowserDialog.recent'), { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('a backdrop click cancels, a click inside the panel does not', () => {
    const { onCancel } = renderDialog()
    fireEvent.click(screen.getByTestId('DirectoryBrowserDialog.path'))
    expect(onCancel).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('DirectoryBrowserDialog'))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('the close button and Cancel both cancel', () => {
    const { onCancel } = renderDialog()
    fireEvent.click(screen.getByTestId('DirectoryBrowserDialog.close'))
    fireEvent.click(screen.getByTestId('DirectoryBrowserDialog.cancel'))
    expect(onCancel).toHaveBeenCalledTimes(2)
  })
})

describe('DirectoryBrowserDialog — places rail', () => {
  const PLACES: ListPlacesResult = {
    home: 'C:/Users/dev',
    hostname: 'daniel-pc',
    drives: ['C:/', 'D:/']
  }

  it('renders recents and host places, and names the host in the header', async () => {
    renderDialog({
      listPlaces: makeListPlaces(PLACES),
      recents: [
        { cwd: 'D:/work/ClaudeUI', folderName: 'ClaudeUI' },
        { cwd: 'D:/work/JudgEval', folderName: 'JudgEval' }
      ]
    })

    await waitFor(() =>
      expect(idsOf('DirectoryBrowserDialog.place')).toEqual(['C:/Users/dev', 'C:/', 'D:/'])
    )
    expect(idsOf('DirectoryBrowserDialog.recent')).toEqual(['D:/work/ClaudeUI', 'D:/work/JudgEval'])
    expect(screen.getByTestId('DirectoryBrowserDialog')).toHaveTextContent('on daniel-pc')
  })

  it('renders Home as a place when the host reported one', async () => {
    renderDialog({ listPlaces: makeListPlaces(PLACES) })

    await waitFor(() =>
      expect(idsOf('DirectoryBrowserDialog.place')).toEqual(['C:/Users/dev', 'C:/', 'D:/'])
    )
    expect(screen.getByTestId('DirectoryBrowserDialog')).toHaveTextContent('Home')
  })

  it('hides the rail entirely when there are no recents and the host answered nothing', async () => {
    const { listPlaces } = renderDialog()

    await waitFor(() => expect(listPlaces).toHaveBeenCalledTimes(1))
    expect(screen.queryAllByTestId('DirectoryBrowserDialog.recent')).toEqual([])
    expect(screen.queryAllByTestId('DirectoryBrowserDialog.place')).toEqual([])
    // No hostname either — the subtitle is omitted rather than rendered blank.
    expect(screen.getByTestId('DirectoryBrowserDialog')).not.toHaveTextContent('on ')
  })

  it('survives a host that cannot answer at all', async () => {
    const listPlaces = vi.fn<ListPlaces>(async () => {
      throw new Error('nope')
    })
    const { input } = renderDialog({ listPlaces })

    await waitFor(() => expect(listPlaces).toHaveBeenCalled())
    // The typed-path flow is untouched by a rail that never loaded.
    fireEvent.change(input, { target: { value: 'D:/work/' } })
    await waitFor(() => expect(entryNames()).toContain('ClaudeUI'))
  })

  it('a rail click navigates into the directory instead of confirming it', async () => {
    const { onConfirm, input } = renderDialog({
      recents: [{ cwd: 'D:/work/ClaudeUI', folderName: 'ClaudeUI' }]
    })

    fireEvent.click(screen.getByTestId('DirectoryBrowserDialog.recent'))

    expect(input.value).toBe('D:/work/ClaudeUI/')
    await waitFor(() => expect(entryNames()).toEqual(['..', 'src']))
    // Two clicks to start a session, never one — and the path still goes
    // through the host on confirm.
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('a drive place navigates to its root without doubling the separator', async () => {
    const { input } = renderDialog({ listPlaces: makeListPlaces(PLACES) })

    await waitFor(() => expect(idsOf('DirectoryBrowserDialog.place')).toContain('D:/'))
    fireEvent.click(
      screen
        .getAllByTestId('DirectoryBrowserDialog.place')
        .find((e) => e.getAttribute('data-id') === 'D:/')!
    )

    expect(input.value).toBe('D:/')
    await waitFor(() => expect(entryNames()).toEqual(['work']))
  })

  it('collapses recents that share a cwd to one row', () => {
    // Callers map the session store's `directories`, which is unique by
    // projectKey — two groups on one cwd would duplicate both the row and the
    // React key.
    renderDialog({
      recents: [
        { cwd: 'D:/work/ClaudeUI', folderName: 'ClaudeUI' },
        { cwd: 'D:/work/ClaudeUI', folderName: 'ClaudeUI (worktree)' },
        { cwd: 'D:/work/JudgEval', folderName: 'JudgEval' }
      ]
    })

    expect(idsOf('DirectoryBrowserDialog.recent')).toEqual(['D:/work/ClaudeUI', 'D:/work/JudgEval'])
    // First wins, so the row keeps the label the caller listed first.
    expect(screen.getAllByTestId('DirectoryBrowserDialog.recent')[0]).toHaveTextContent('ClaudeUI')
  })

  it('marks the rail entry the input is sitting on, whatever the separator style', async () => {
    renderDialog({
      recents: [
        { cwd: 'D:/work/ClaudeUI', folderName: 'ClaudeUI' },
        { cwd: 'D:/work/JudgEval', folderName: 'JudgEval' }
      ]
    })
    const active = (): string[] =>
      screen
        .getAllByTestId('DirectoryBrowserDialog.recent')
        .filter((e) => e.getAttribute('data-active') === 'true')
        .map((e) => e.getAttribute('data-id') ?? '')

    expect(active()).toEqual([])
    // Backslashes and a trailing separator are the same directory.
    fireEvent.change(screen.getByTestId('DirectoryBrowserDialog.path'), {
      target: { value: 'D:\\work\\ClaudeUI\\' }
    })
    expect(active()).toEqual(['D:/work/ClaudeUI'])
  })
})

describe('DirectoryBrowserDialog — initialPath', () => {
  it("opens on the caller's path and never lets the home seed overwrite it", async () => {
    const listDir = vi.fn<ListDir>(async (dirPath: string) => {
      const key = dirPath === '' ? 'D:/work' : dirPath.replace(/\\/g, '/')
      const entries = FS[key]
      if (!entries) return { entries: [], isRoot: false, resolvedPath: '' }
      return { entries, isRoot: false, resolvedPath: key }
    })
    const { input } = renderDialog({ listDir, initialPath: 'D:/work/ClaudeUI' })

    // Separator appended so the listing effect sees a directory, not a filter.
    expect(input.value).toBe('D:/work/ClaudeUI/')
    await waitFor(() => expect(entryNames()).toEqual(['..', 'src']))

    // The home seed resolves after the fact and must lose.
    await waitFor(() => expect(listDir).toHaveBeenCalledWith(''))
    expect(input.value).toBe('D:/work/ClaudeUI/')
  })

  it('keeps a Windows-style path in its own separator style', () => {
    const { input } = renderDialog({ initialPath: 'D:\\work\\ClaudeUI' })
    expect(input.value).toBe('D:\\work\\ClaudeUI\\')
  })

  it('does not double a separator the caller already supplied', () => {
    const { input } = renderDialog({ initialPath: 'D:/work/' })
    expect(input.value).toBe('D:/work/')
  })
})

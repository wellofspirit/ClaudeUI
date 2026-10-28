/**
 * Layer 2: the New Session directory picker, desktop vs. remote web client.
 *
 * On the web client `pickFolder()` resolves to null (no native dialog, and
 * `session:pick-folder` is permanently denylisted on the remote dispatcher), so
 * the "Browse..." row used to close the dropdown and do nothing at all — the
 * known-directories list was the only way into a session. Web therefore gets a
 * host browser over `file:list-dir` instead; desktop must keep the native
 * dialog untouched.
 *
 * That browser is a modal dialog now (ADR-046 Option C), not an inline panel
 * inside the 288px dropdown — so "browse" and "the dropdown is open" are two
 * independent states here, and the dropdown closes on the way in.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { StrictMode } from 'react'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import type { DirEntry, DirectoryGroup } from '../../../../../../shared/types'

// ── Store mock (WelcomeState only reads four slices) ─────────────────

const { store, active } = vi.hoisted(() => ({
  // The active session the welcome screen reads: no directory chosen yet by default.
  active: {
    cwd: '',
    pendingWorktree: null as null | {
      enabled: boolean
      name: string
      phase: 'idle' | 'creating' | 'failed'
      error?: string
    },
    isGitRepo: false,
    sdkActive: false
  },
  store: {
    directories: [] as DirectoryGroup[],
    createNewSession: vi.fn(),
    setPendingWorktree: vi.fn(),
    settings: { startInWorktree: false },
    activeSessionId: 'route-1',
    welcomeBrowseToken: 0
  }
}))

vi.mock('../../../../stores/session-store', () => ({
  useActiveSession: (selector: (s: typeof active) => unknown) => selector(active),
  useSessionStore: (selector: (s: typeof store) => unknown) => selector(store)
}))

import { WelcomeState } from '../WelcomeState'

// ── Host filesystem behind file:list-dir ─────────────────────────────

const FS: Record<string, DirEntry[]> = {
  'D:/work': [{ name: 'ClaudeUI', isDirectory: true }],
  'D:/work/ClaudeUI': [{ name: 'src', isDirectory: true }]
}

const KNOWN_DIR: DirectoryGroup = {
  cwd: 'D:/work/known',
  projectKey: 'D--work-known',
  folderName: 'known',
  sessions: []
}

function stubApi(platform: string): void {
  ;(window as unknown as { api: unknown }).api = {
    platform,
    // api-adapter.ts stubs pickFolder to null on web — there is no native dialog
    pickFolder: vi.fn(async () => (platform === 'web' ? null : 'D:/picked/by/dialog')),
    listDir: vi.fn(async (dirPath: string) => {
      const key = dirPath.replace(/\\/g, '/').replace(/\/$/, '')
      const entries = FS[key]
      if (!entries) return { entries: [], isRoot: false, resolvedPath: '' }
      return { entries, isRoot: false, resolvedPath: key }
    }),
    listPlaces: vi.fn(async () => ({ home: 'D:/work', hostname: 'host-pc', drives: ['D:/'] })),
    createWorktree: vi.fn(),
    logError: vi.fn()
  }
}

interface StubbedApi {
  pickFolder: ReturnType<typeof vi.fn>
  listDir: ReturnType<typeof vi.fn>
  listPlaces: ReturnType<typeof vi.fn>
}

const api = (): StubbedApi => (window as unknown as { api: StubbedApi }).api

function openDropdown(): void {
  fireEvent.click(screen.getByTestId('WelcomeState.selectDirectory'))
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(active, { cwd: '', pendingWorktree: null, isGitRepo: false, sdkActive: false })
  store.directories = [KNOWN_DIR]
  // 0 is below every token the sidebar can hand out, so nothing auto-browses.
  store.welcomeBrowseToken = 0
})

/**
 * `welcomeBrowseToken` is monotonic for the lifetime of the page, and the
 * consumer remembers the last one it acted on across mounts — so a test must
 * never reuse a token value an earlier test already consumed.
 */
let tokenSeq = 100
const nextBrowseToken = (): number => ++tokenSeq

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('WelcomeState — web client', () => {
  beforeEach(() => stubApi('web'))

  it('offers "Browse path..." instead of the no-op native "Browse..."', () => {
    render(<WelcomeState />)
    openDropdown()

    const browse = screen.getByTestId('WelcomeState.browse')
    expect(browse).toHaveTextContent('Browse path...')
    expect(browse).not.toHaveTextContent('Browse...')
  })

  it('browses the host and starts a session at the confirmed path', async () => {
    render(<WelcomeState />)
    openDropdown()
    // Located by text, not by the new testid: pre-fix this same row was the
    // native "Browse..." that resolved to null and started nothing.
    fireEvent.click(screen.getByText(/^Browse/))

    const input = screen.getByTestId('DirectoryBrowserDialog.path')
    fireEvent.change(input, { target: { value: 'D:/work/' } })
    await waitFor(() =>
      expect(screen.getAllByTestId('DirectoryBrowserDialog.entry').length).toBeGreaterThan(0)
    )

    fireEvent.change(input, { target: { value: 'D:/work/ClaudeUI' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() =>
      expect(store.createNewSession).toHaveBeenCalledWith(expect.any(String), 'D:/work/ClaudeUI')
    )
    expect(api().pickFolder).not.toHaveBeenCalled()
    expect(screen.queryByTestId('DirectoryBrowserDialog')).toBeNull()
  })

  it('does not start a session for a path the host cannot list', async () => {
    render(<WelcomeState />)
    openDropdown()
    fireEvent.click(screen.getByTestId('WelcomeState.browse'))

    const input = screen.getByTestId('DirectoryBrowserDialog.path')
    fireEvent.change(input, { target: { value: 'D:/typed/on/the/phone' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(screen.getByTestId('DirectoryBrowserDialog.error')).toBeTruthy())
    expect(store.createNewSession).not.toHaveBeenCalled()
    expect(screen.getByTestId('DirectoryBrowserDialog')).toBeTruthy()
  })

  it('closes the dropdown on the way into the dialog', () => {
    render(<WelcomeState />)
    openDropdown()
    expect(screen.getByTestId('WelcomeState.directory')).toBeTruthy()

    fireEvent.click(screen.getByTestId('WelcomeState.browse'))

    // The dialog is its own surface now — the 288px dropdown was only ever the
    // inline browser's container, and leaving it open would stack two lists.
    expect(screen.queryByTestId('WelcomeState.directory')).toBeNull()
    expect(screen.getByTestId('DirectoryBrowserDialog')).toBeTruthy()
  })

  it('carries the known directories into the dialog as its RECENT rail', () => {
    render(<WelcomeState />)
    openDropdown()
    fireEvent.click(screen.getByTestId('WelcomeState.browse'))

    const recents = screen.getAllByTestId('DirectoryBrowserDialog.recent')
    expect(recents.map((e) => e.getAttribute('data-id'))).toEqual([KNOWN_DIR.cwd])
  })

  it('Cancel closes the dialog and leaves the welcome screen usable', () => {
    render(<WelcomeState />)
    openDropdown()
    fireEvent.click(screen.getByTestId('WelcomeState.browse'))
    fireEvent.click(screen.getByTestId('DirectoryBrowserDialog.cancel'))

    expect(screen.queryByTestId('DirectoryBrowserDialog')).toBeNull()
    expect(store.createNewSession).not.toHaveBeenCalled()
    expect(screen.getByTestId('WelcomeState.selectDirectory')).toBeTruthy()
  })
})

/**
 * The sidebar's "New session" double-click has no native dialog to open on web,
 * so it shows the welcome screen and bumps `welcomeBrowseToken`. Whichever
 * WelcomeState is mounted when that lands — or mounts right after it, which is
 * the usual order — opens the host browser.
 */
describe('WelcomeState — sidebar browse request', () => {
  beforeEach(() => stubApi('web'))

  it('opens the browser when the request landed before it mounted', () => {
    store.welcomeBrowseToken = nextBrowseToken()
    render(<WelcomeState />)

    expect(screen.getByTestId('DirectoryBrowserDialog')).toBeTruthy()
    // Straight to the dialog — the dropdown is not part of this path at all.
    expect(screen.queryByTestId('WelcomeState.directory')).toBeNull()
  })

  it('opens the browser when the request arrives while it is already mounted', () => {
    const token = nextBrowseToken()
    const { rerender } = render(<WelcomeState />)
    expect(screen.queryByTestId('DirectoryBrowserDialog')).toBeNull()

    store.welcomeBrowseToken = token
    rerender(<WelcomeState />)

    expect(screen.getByTestId('DirectoryBrowserDialog')).toBeTruthy()
  })

  it('survives StrictMode, whose second effect pass sees the token already consumed', () => {
    store.welcomeBrowseToken = nextBrowseToken()
    render(
      <StrictMode>
        <WelcomeState />
      </StrictMode>
    )

    expect(screen.getByTestId('DirectoryBrowserDialog')).toBeTruthy()
  })

  it('does not re-open the browser on a later remount without a new request', () => {
    store.welcomeBrowseToken = nextBrowseToken()
    render(<WelcomeState />)
    expect(screen.getByTestId('DirectoryBrowserDialog')).toBeTruthy()

    // Every visit to the welcome screen remounts this component; only a NEW
    // request may re-open the browser.
    cleanup()
    render(<WelcomeState />)

    expect(screen.queryByTestId('DirectoryBrowserDialog')).toBeNull()
    expect(screen.getByTestId('WelcomeState.selectDirectory')).toBeTruthy()
  })
})

describe('WelcomeState — worktree choice before a directory is picked', () => {
  beforeEach(() => stubApi('win32'))

  it('creates no worktree itself: it hands the toggle and name to the new session', async () => {
    store.directories = [KNOWN_DIR]
    render(<WelcomeState />)
    fireEvent.click(screen.getByTestId('WelcomeState.worktreeToggle'))
    fireEvent.change(screen.getByTestId('WelcomeState.worktreeName'), {
      target: { value: 'my-tree' }
    })
    openDropdown()
    fireEvent.click(screen.getByTestId('WelcomeState.directory'))

    expect(store.createNewSession).toHaveBeenCalledWith(expect.any(String), KNOWN_DIR.cwd)
    expect(
      (window as unknown as { api: { createWorktree: ReturnType<typeof vi.fn> } }).api
        .createWorktree
    ).not.toHaveBeenCalled()
    expect(store.setPendingWorktree).toHaveBeenCalledWith(expect.any(String), {
      enabled: true,
      name: 'my-tree',
      nameTouched: true
    })
  })

  it('keeps a name typed before the directory was picked even if the toggle was never touched', () => {
    // The global default is on, so the toggle shows on and is left alone; only the name is typed.
    store.settings = { startInWorktree: true }
    store.directories = [KNOWN_DIR]
    render(<WelcomeState />)
    fireEvent.change(screen.getByTestId('WelcomeState.worktreeName'), {
      target: { value: 'my-tree' }
    })
    openDropdown()
    fireEvent.click(screen.getByTestId('WelcomeState.directory'))

    expect(store.setPendingWorktree).toHaveBeenCalledWith(expect.any(String), {
      name: 'my-tree',
      nameTouched: true
    })
    store.settings = { startInWorktree: false }
  })

  it('leaves the new session at its project default when the toggle was not touched', () => {
    store.directories = [KNOWN_DIR]
    render(<WelcomeState />)
    openDropdown()
    fireEvent.click(screen.getByTestId('WelcomeState.directory'))

    expect(store.createNewSession).toHaveBeenCalledTimes(1)
    expect(store.setPendingWorktree).not.toHaveBeenCalled()
  })
})

describe('WelcomeState — worktree toggle once a directory is chosen', () => {
  beforeEach(() => {
    stubApi('win32')
    Object.assign(active, {
      cwd: 'D:/work/known',
      pendingWorktree: { enabled: true, name: 'calm-river', phase: 'idle' },
      isGitRepo: true
    })
  })

  it('shows the toggle, the name and the hint for a git directory that has not spawned', () => {
    render(<WelcomeState />)
    expect(screen.getByTestId('WelcomeState.worktreeToggle').getAttribute('aria-checked')).toBe(
      'true'
    )
    expect(screen.getByTestId('WelcomeState.worktreeName')).toHaveValue('calm-river')
    expect(screen.getByTestId('WelcomeState.worktreeHint')).toBeTruthy()
  })

  it('toggling and typing write to the session, the typed name marked as touched', () => {
    render(<WelcomeState />)
    fireEvent.click(screen.getByTestId('WelcomeState.worktreeToggle'))
    expect(store.setPendingWorktree).toHaveBeenLastCalledWith('route-1', { enabled: false })

    fireEvent.change(screen.getByTestId('WelcomeState.worktreeName'), {
      target: { value: 'mine' }
    })
    expect(store.setPendingWorktree).toHaveBeenLastCalledWith('route-1', {
      name: 'mine',
      nameTouched: true
    })
  })

  it('hides the toggle for a directory that is not a git repository', () => {
    active.isGitRepo = false
    render(<WelcomeState />)
    expect(screen.queryByTestId('WelcomeState.worktreeToggle')).toBeNull()
  })

  it('hides the toggle once the session has spawned', () => {
    active.sdkActive = true
    render(<WelcomeState />)
    expect(screen.queryByTestId('WelcomeState.worktreeToggle')).toBeNull()
  })

  it('shows "Creating worktree…" in place of the toggle while it is being made', () => {
    active.pendingWorktree = { enabled: true, name: 'calm-river', phase: 'creating' }
    render(<WelcomeState />)
    expect(screen.getByTestId('WelcomeState.worktreeCreating')).toHaveTextContent(
      'Creating worktree…'
    )
    expect(screen.queryByTestId('WelcomeState.worktreeToggle')).toBeNull()
  })
})

describe('WelcomeState — desktop', () => {
  beforeEach(() => stubApi('win32'))

  it('keeps the native "Browse..." dialog', async () => {
    render(<WelcomeState />)
    openDropdown()

    expect(screen.getByTestId('WelcomeState.browse')).toHaveTextContent('Browse...')
    fireEvent.click(screen.getByTestId('WelcomeState.browse'))

    expect(api().pickFolder).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('DirectoryBrowserDialog')).toBeNull()
    await waitFor(() =>
      expect(store.createNewSession).toHaveBeenCalledWith(expect.any(String), 'D:/picked/by/dialog')
    )
  })
})

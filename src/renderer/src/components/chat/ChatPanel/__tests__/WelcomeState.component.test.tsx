/**
 * Layer 2: the New Session directory picker, desktop vs. remote web client.
 *
 * On the web client `pickFolder()` resolves to null (no native dialog, and
 * `session:pick-folder` is permanently denylisted on the remote dispatcher), so
 * the "Browse..." row used to close the dropdown and do nothing at all — the
 * known-directories list was the only way into a session. Web therefore gets an
 * inline browser over `file:list-dir` instead; desktop must keep the native
 * dialog untouched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import type { DirEntry, DirectoryGroup } from '../../../../../../shared/types'

// ── Store mock (WelcomeState only reads four slices) ─────────────────

const { store } = vi.hoisted(() => ({
  store: {
    directories: [] as DirectoryGroup[],
    createNewSession: vi.fn(),
    setWorktreeInfo: vi.fn(),
    activeSessionId: 'route-1'
  }
}))

vi.mock('../../../../stores/session-store', () => ({
  useActiveSession: (selector: (s: { cwd: string }) => unknown) => selector({ cwd: '' }),
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
    createWorktree: vi.fn(),
    logError: vi.fn()
  }
}

interface StubbedApi {
  pickFolder: ReturnType<typeof vi.fn>
  listDir: ReturnType<typeof vi.fn>
}

const api = (): StubbedApi => (window as unknown as { api: StubbedApi }).api

function openDropdown(): void {
  fireEvent.click(screen.getByTestId('WelcomeState.selectDirectory'))
}

beforeEach(() => {
  vi.clearAllMocks()
  store.directories = [KNOWN_DIR]
})

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

    const input = screen.getByTestId('DirectoryBrowserInput.path')
    fireEvent.change(input, { target: { value: 'D:/work/' } })
    await waitFor(() =>
      expect(screen.getAllByTestId('DirectoryBrowserInput.entry').length).toBeGreaterThan(0)
    )

    fireEvent.change(input, { target: { value: 'D:/work/ClaudeUI' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() =>
      expect(store.createNewSession).toHaveBeenCalledWith(expect.any(String), 'D:/work/ClaudeUI')
    )
    expect(api().pickFolder).not.toHaveBeenCalled()
    // the whole dropdown closes, same as picking a known directory
    expect(screen.queryByTestId('DirectoryBrowserInput')).toBeNull()
  })

  it('does not start a session for a path the host cannot list', async () => {
    render(<WelcomeState />)
    openDropdown()
    fireEvent.click(screen.getByTestId('WelcomeState.browse'))

    const input = screen.getByTestId('DirectoryBrowserInput.path')
    fireEvent.change(input, { target: { value: 'D:/typed/on/the/phone' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(screen.getByTestId('DirectoryBrowserInput.error')).toBeTruthy())
    expect(store.createNewSession).not.toHaveBeenCalled()
    expect(screen.getByTestId('DirectoryBrowserInput')).toBeTruthy()
  })

  it('keeps the known directories clickable while browsing', () => {
    render(<WelcomeState />)
    openDropdown()
    fireEvent.click(screen.getByTestId('WelcomeState.browse'))

    fireEvent.click(screen.getByTestId('WelcomeState.directory'))
    expect(store.createNewSession).toHaveBeenCalledWith(expect.any(String), KNOWN_DIR.cwd)
  })

  it('Cancel returns to the plain dropdown list', () => {
    render(<WelcomeState />)
    openDropdown()
    fireEvent.click(screen.getByTestId('WelcomeState.browse'))
    fireEvent.click(screen.getByTestId('DirectoryBrowserInput.cancel'))

    expect(screen.queryByTestId('DirectoryBrowserInput')).toBeNull()
    expect(screen.getByTestId('WelcomeState.browse')).toBeTruthy()
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
    expect(screen.queryByTestId('DirectoryBrowserInput')).toBeNull()
    await waitFor(() =>
      expect(store.createNewSession).toHaveBeenCalledWith(expect.any(String), 'D:/picked/by/dialog')
    )
  })
})

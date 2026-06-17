/**
 * Layer 2: Component tests for useFileMention hook.
 *
 * Tests the complex path-browsing and mention-insertion logic — open/close
 * transitions, keyboard navigation, directory traversal, file confirmation,
 * and backslash normalisation. Uses renderHook so we exercise real React
 * state without rendering any DOM elements.
 *
 * window.api.listDir is mocked to return a small, stable directory listing
 * so we can assert deterministically against filteredEntries.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useFileMention } from '../useFileMention'
import type { DirEntry } from '../../../../shared/types'

// ---------------------------------------------------------------------------
// window.api mock
// ---------------------------------------------------------------------------

const DEFAULT_ENTRIES: DirEntry[] = [
  { name: 'src', isDirectory: true },
  { name: 'README.md', isDirectory: false },
  { name: 'package.json', isDirectory: false }
]

function mockListDir(entries = DEFAULT_ENTRIES, isRoot = false, resolvedPath = '/project') {
  return vi.fn().mockResolvedValue({ entries, isRoot, resolvedPath })
}

beforeEach(() => {
  ;(globalThis as any).window = (globalThis as any).window ?? {}
  ;(globalThis as any).window.api = {
    ...((globalThis as any).window.api ?? {}),
    listDir: mockListDir()
  }
})

// ---------------------------------------------------------------------------
// Setup helper
// ---------------------------------------------------------------------------

function setup(opts?: {
  initialText?: string
  cwd?: string
  listDirMock?: ReturnType<typeof vi.fn>
}) {
  const { initialText = '', cwd = '/project', listDirMock } = opts ?? {}

  if (listDirMock) {
    ;(globalThis as any).window.api.listDir = listDirMock
  }

  const state = { text: initialText }
  const textareaRef = { current: null } as React.RefObject<HTMLTextAreaElement | null>

  const rendered = renderHook(() =>
    useFileMention({
      cwd,
      text: state.text,
      setText: (t: string) => {
        state.text = t
      },
      textareaRef
    })
  )

  const updateText = (t: string) => {
    state.text = t
    rendered.rerender()
  }

  return { rendered, state, updateText }
}

function makeKeyEvent(key: string): React.KeyboardEvent {
  return { key, preventDefault: () => {} } as unknown as React.KeyboardEvent
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe('useFileMention — initial state', () => {
  it('menu starts closed', () => {
    const { rendered } = setup()
    expect(rendered.result.current.fileMentionOpen).toBe(false)
  })

  it('index starts at 0', () => {
    const { rendered } = setup()
    expect(rendered.result.current.fileMentionIndex).toBe(0)
  })

  it('filteredEntries is empty when closed', () => {
    const { rendered } = setup()
    expect(rendered.result.current.filteredEntries).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// handleInputChange — open / close transitions
// ---------------------------------------------------------------------------

describe('useFileMention — handleInputChange open/close', () => {
  it('opens menu when "@" is at start of text', () => {
    const { rendered } = setup()
    act(() => {
      rendered.result.current.handleInputChange('@', 1)
    })
    expect(rendered.result.current.fileMentionOpen).toBe(true)
  })

  it('opens menu when "@" is preceded by a space', () => {
    const { rendered } = setup()
    act(() => {
      rendered.result.current.handleInputChange('hello @', 7)
    })
    expect(rendered.result.current.fileMentionOpen).toBe(true)
  })

  it('does NOT open menu when "@" is preceded by a non-whitespace char', () => {
    const { rendered } = setup()
    act(() => {
      rendered.result.current.handleInputChange('hello@', 6)
    })
    expect(rendered.result.current.fileMentionOpen).toBe(false)
  })

  it('does NOT open menu when cursor is not directly after "@"', () => {
    // cursor at position 5 but the @ is at position 6 — no trigger
    const { rendered } = setup()
    act(() => {
      rendered.result.current.handleInputChange('hello@world', 5)
    })
    expect(rendered.result.current.fileMentionOpen).toBe(false)
  })

  it('closes menu when cursor moves before the @ anchor', () => {
    const { rendered } = setup()
    // Open by typing @
    act(() => {
      rendered.result.current.handleInputChange('@', 1)
    })
    expect(rendered.result.current.fileMentionOpen).toBe(true)
    // Simulate cursor moving to position 0 (before anchor at 0)
    act(() => {
      rendered.result.current.handleInputChange('@', 0)
    })
    expect(rendered.result.current.fileMentionOpen).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// filteredEntries — .. prepend logic
// ---------------------------------------------------------------------------

describe('useFileMention — filteredEntries .. prepend', () => {
  it('prepends ".." entry when not at root', async () => {
    const { rendered } = setup({
      listDirMock: mockListDir(DEFAULT_ENTRIES, false, '/project')
    })
    act(() => {
      rendered.result.current.handleInputChange('@', 1)
    })

    await waitFor(() => {
      expect(rendered.result.current.filteredEntries.length).toBeGreaterThan(0)
    })

    expect(rendered.result.current.filteredEntries[0].name).toBe('..')
    expect(rendered.result.current.filteredEntries[0].isDirectory).toBe(true)
  })

  it('does NOT prepend ".." when at root', async () => {
    const { rendered } = setup({
      listDirMock: mockListDir(DEFAULT_ENTRIES, true, '/')
    })
    act(() => {
      rendered.result.current.handleInputChange('@', 1)
    })

    await waitFor(() => {
      expect(rendered.result.current.filteredEntries.length).toBeGreaterThan(0)
      expect(rendered.result.current.filteredEntries[0].name).not.toBe('..')
    })
  })
})

// ---------------------------------------------------------------------------
// handleKeyDown — navigation
// ---------------------------------------------------------------------------

describe('useFileMention — handleKeyDown navigation', () => {
  async function openAndLoad(opts?: Parameters<typeof setup>[0]) {
    const ctx = setup(opts)
    act(() => {
      ctx.rendered.result.current.handleInputChange('@', 1)
    })
    await waitFor(() => {
      expect(ctx.rendered.result.current.filteredEntries.length).toBeGreaterThan(0)
    })
    ctx.rendered.rerender()
    return ctx
  }

  it('ArrowDown advances index forward', async () => {
    const { rendered } = await openAndLoad()
    act(() => {
      rendered.result.current.handleKeyDown(makeKeyEvent('ArrowDown'))
    })
    expect(rendered.result.current.fileMentionIndex).toBe(1)
  })

  it('ArrowDown cycles back to 0 from last entry', async () => {
    const { rendered } = await openAndLoad()
    const total = rendered.result.current.filteredEntries.length
    for (let i = 0; i < total; i++) {
      act(() => {
        rendered.result.current.handleKeyDown(makeKeyEvent('ArrowDown'))
      })
    }
    expect(rendered.result.current.fileMentionIndex).toBe(0)
  })

  it('ArrowUp from 0 wraps to last index', async () => {
    const { rendered } = await openAndLoad()
    const total = rendered.result.current.filteredEntries.length
    act(() => {
      rendered.result.current.handleKeyDown(makeKeyEvent('ArrowUp'))
    })
    expect(rendered.result.current.fileMentionIndex).toBe(total - 1)
  })

  it('ArrowDown returns true (event consumed)', async () => {
    const { rendered } = await openAndLoad()
    let consumed = false
    act(() => {
      consumed = rendered.result.current.handleKeyDown(makeKeyEvent('ArrowDown'))
    })
    expect(consumed).toBe(true)
  })

  it('ArrowUp returns true (event consumed)', async () => {
    const { rendered } = await openAndLoad()
    let consumed = false
    act(() => {
      consumed = rendered.result.current.handleKeyDown(makeKeyEvent('ArrowUp'))
    })
    expect(consumed).toBe(true)
  })

  it('returns false when menu is closed', () => {
    const { rendered } = setup()
    let consumed = true
    act(() => {
      consumed = rendered.result.current.handleKeyDown(makeKeyEvent('ArrowDown'))
    })
    expect(consumed).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// handleKeyDown — Escape
// ---------------------------------------------------------------------------

describe('useFileMention — handleKeyDown Escape', () => {
  it('Escape closes menu', async () => {
    const { rendered } = setup()
    act(() => {
      rendered.result.current.handleInputChange('@', 1)
    })
    expect(rendered.result.current.fileMentionOpen).toBe(true)

    act(() => {
      rendered.result.current.handleKeyDown(makeKeyEvent('Escape'))
    })
    expect(rendered.result.current.fileMentionOpen).toBe(false)
  })

  it('Escape returns true even when no entries match', async () => {
    const { rendered } = setup({
      listDirMock: mockListDir([], false, '/project')
    })
    act(() => {
      rendered.result.current.handleInputChange('@', 1)
    })

    let consumed = false
    act(() => {
      consumed = rendered.result.current.handleKeyDown(makeKeyEvent('Escape'))
    })
    expect(consumed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// handleKeyDown — Enter/Tab on empty filteredEntries
// ---------------------------------------------------------------------------

describe('useFileMention — handleKeyDown with empty entries', () => {
  it('Enter on empty filteredEntries closes menu and returns true', async () => {
    const { rendered } = setup({
      listDirMock: vi
        .fn()
        .mockResolvedValue({ entries: [], isRoot: false, resolvedPath: '/project' })
    })
    act(() => {
      rendered.result.current.handleInputChange('@', 1)
    })

    // Apply a filter that yields no results by typing past the entries
    act(() => {
      rendered.result.current.handleInputChange('@zzz', 4)
    })

    // Wait for potential async updates to settle
    await waitFor(() => {
      // filteredEntries may be empty because query 'zzz' matches nothing
      // but they might still have the .. entry — navigate until empty
    })

    // Close via Enter while entries may be empty
    let consumed = false
    act(() => {
      consumed = rendered.result.current.handleKeyDown(makeKeyEvent('Enter'))
    })
    expect(consumed).toBe(true)
    expect(rendered.result.current.fileMentionOpen).toBe(false)
  })

  it('Tab on empty filteredEntries closes menu and returns true', async () => {
    const { rendered } = setup({
      listDirMock: vi.fn().mockResolvedValue({ entries: [], isRoot: true, resolvedPath: '/' })
    })
    act(() => {
      rendered.result.current.handleInputChange('@', 1)
    })

    await waitFor(() => {
      // entries loaded (empty list, root = true so no .. prepended)
      expect(rendered.result.current.filteredEntries).toHaveLength(0)
    })

    let consumed = false
    act(() => {
      consumed = rendered.result.current.handleKeyDown(makeKeyEvent('Tab'))
    })
    expect(consumed).toBe(true)
    expect(rendered.result.current.fileMentionOpen).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// handleConfirm
// ---------------------------------------------------------------------------

describe('useFileMention — handleConfirm', () => {
  it('confirms a file: inserts @filename and closes menu', async () => {
    const { rendered, state, updateText } = setup()
    // Simulate "@" typed at cursor 0 in empty input
    act(() => {
      rendered.result.current.handleInputChange('@', 1)
    })
    updateText('@')

    await waitFor(() => {
      expect(rendered.result.current.filteredEntries.length).toBeGreaterThan(0)
    })

    const fileEntry: DirEntry = { name: 'README.md', isDirectory: false }
    act(() => {
      rendered.result.current.handleConfirm(fileEntry)
    })

    expect(state.text).toBe('@README.md ')
    expect(rendered.result.current.fileMentionOpen).toBe(false)
  })

  it('wraps path containing spaces in double quotes', async () => {
    const spacedEntries: DirEntry[] = [{ name: 'my file.txt', isDirectory: false }]
    // isRoot: false keeps fileMentionDir empty; the hook builds fullPath as just
    // the entry name when no subdirectory has been navigated into.
    const { rendered, state, updateText } = setup({
      listDirMock: mockListDir(spacedEntries, false, '/project')
    })
    act(() => {
      rendered.result.current.handleInputChange('@', 1)
    })
    updateText('@')

    await waitFor(() => {
      expect(rendered.result.current.filteredEntries.length).toBeGreaterThan(0)
    })

    const fileEntry: DirEntry = { name: 'my file.txt', isDirectory: false }
    act(() => {
      rendered.result.current.handleConfirm(fileEntry)
    })

    expect(state.text).toBe('@"my file.txt" ')
    expect(rendered.result.current.fileMentionOpen).toBe(false)
  })

  it('resets index to 0 after confirm', async () => {
    const { rendered, updateText } = setup()
    act(() => {
      rendered.result.current.handleInputChange('@', 1)
    })
    updateText('@')

    await waitFor(() => {
      expect(rendered.result.current.filteredEntries.length).toBeGreaterThan(0)
    })

    rendered.rerender()
    act(() => {
      rendered.result.current.handleKeyDown(makeKeyEvent('ArrowDown'))
    })

    await waitFor(() => {
      expect(rendered.result.current.fileMentionIndex).toBe(1)
    })

    const fileEntry: DirEntry = { name: 'README.md', isDirectory: false }
    act(() => {
      rendered.result.current.handleConfirm(fileEntry)
    })
    expect(rendered.result.current.fileMentionIndex).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// handleNavigate
// ---------------------------------------------------------------------------

describe('useFileMention — handleNavigate', () => {
  it('navigating into a directory updates text with dir/', async () => {
    const { rendered, state, updateText } = setup()
    act(() => {
      rendered.result.current.handleInputChange('@', 1)
    })
    updateText('@')

    await waitFor(() => {
      expect(rendered.result.current.filteredEntries.length).toBeGreaterThan(0)
    })

    const dirEntry: DirEntry = { name: 'src', isDirectory: true }
    act(() => {
      rendered.result.current.handleNavigate(dirEntry)
    })
    expect(state.text).toBe('@src/')
  })

  it('handleNavigate with ".." on empty dir sets dir text to ".."', async () => {
    const { rendered, state, updateText } = setup()
    act(() => {
      rendered.result.current.handleInputChange('@', 1)
    })
    updateText('@')

    await waitFor(() => {
      expect(rendered.result.current.filteredEntries.length).toBeGreaterThan(0)
    })

    const up: DirEntry = { name: '..', isDirectory: true }
    act(() => {
      rendered.result.current.handleNavigate(up)
    })
    // dir was '' → navigating up sets dir to '..'
    expect(state.text).toBe('@../')
  })

  it('handleNavigate with ".." when dir is ".." sets dir to "../.."', async () => {
    const { rendered, state, updateText } = setup()
    act(() => {
      rendered.result.current.handleInputChange('@', 1)
    })
    updateText('@')

    await waitFor(() => {
      expect(rendered.result.current.filteredEntries.length).toBeGreaterThan(0)
    })

    const up: DirEntry = { name: '..', isDirectory: true }
    // First up: '' → '..'
    act(() => {
      rendered.result.current.handleNavigate(up)
    })
    updateText(state.text)
    // Simulate another up navigation — hook uses its own internal dir state
    act(() => {
      rendered.result.current.handleNavigate(up)
    })
    expect(state.text).toBe('@../../')
  })

  it('does not navigate into non-directory entries', async () => {
    const { rendered, state, updateText } = setup()
    act(() => {
      rendered.result.current.handleInputChange('@', 1)
    })
    updateText('@')

    await waitFor(() => {
      expect(rendered.result.current.filteredEntries.length).toBeGreaterThan(0)
    })

    const initialText = state.text
    const fileEntry: DirEntry = { name: 'README.md', isDirectory: false }
    act(() => {
      rendered.result.current.handleNavigate(fileEntry)
    })
    // handleNavigate returns early for non-directories — text unchanged
    expect(state.text).toBe(initialText)
  })
})

// ---------------------------------------------------------------------------
// close()
// ---------------------------------------------------------------------------

describe('useFileMention — close', () => {
  it('close() sets fileMentionOpen to false', async () => {
    const { rendered } = setup()
    act(() => {
      rendered.result.current.handleInputChange('@', 1)
    })
    expect(rendered.result.current.fileMentionOpen).toBe(true)

    act(() => {
      rendered.result.current.close()
    })
    expect(rendered.result.current.fileMentionOpen).toBe(false)
  })

  it('close() does not reset fileMentionIndex (index persists until next open)', async () => {
    // close() only resets open/anchor/dir — index is intentionally left as-is.
    // It is reset to 0 by handleConfirm, handleNavigate, and handleInputChange on open.
    const { rendered, updateText } = setup()
    act(() => {
      rendered.result.current.handleInputChange('@', 1)
    })
    updateText('@')

    await waitFor(() => {
      expect(rendered.result.current.filteredEntries.length).toBeGreaterThan(0)
    })

    rendered.rerender()
    act(() => {
      rendered.result.current.handleKeyDown(makeKeyEvent('ArrowDown'))
    })

    await waitFor(() => {
      expect(rendered.result.current.fileMentionIndex).toBe(1)
    })

    act(() => {
      rendered.result.current.close()
    })
    expect(rendered.result.current.fileMentionIndex).toBe(1)
  })

  it('close() clears filteredEntries (menu becomes closed)', () => {
    const { rendered } = setup()
    act(() => {
      rendered.result.current.handleInputChange('@', 1)
    })
    act(() => {
      rendered.result.current.close()
    })
    expect(rendered.result.current.filteredEntries).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Backslash normalisation
// ---------------------------------------------------------------------------

describe('useFileMention — backslash normalisation', () => {
  it('backslash in path segment is converted to forward slash', async () => {
    const { rendered, state } = setup()

    // Open the menu
    act(() => {
      rendered.result.current.handleInputChange('@', 1)
    })

    await waitFor(() => {
      expect(rendered.result.current.filteredEntries.length).toBeGreaterThan(0)
    })

    // Simulate user typing a backslash (e.g. on Windows paste): "@src\"
    act(() => {
      rendered.result.current.handleInputChange('@src\\', 5)
    })

    // The hook should have rewritten the text to use forward slash
    expect(state.text).toBe('@src/')
  })
})

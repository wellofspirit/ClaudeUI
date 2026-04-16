/**
 * Layer 2: Component tests for useSlashMenu hook.
 *
 * Tests pure decision-making logic — menu open/close transitions, keyboard
 * navigation, index cycling, filtering, and selection. Uses renderHook from
 * @testing-library/react so we exercise real React state without rendering
 * any DOM elements.
 */

import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSlashMenu } from '../useSlashMenu'
import type { SlashCommandInfo } from '../../../../shared/types'

const commands: SlashCommandInfo[] = [
  { name: '/commit', description: 'Commit changes' },
  { name: '/clear', description: 'Clear session' },
  { name: '/help', description: 'Get help' },
]

function makeKeyEvent(key: string): React.KeyboardEvent {
  return { key, preventDefault: () => {} } as unknown as React.KeyboardEvent
}

/**
 * Mounts the hook with an external text variable so we can observe the
 * setText side-effects and also pass updated text on re-renders.
 *
 * The returned `rerender` must be called (no args) after mutating `state.text`
 * to feed the new value into the hook (mimicking controlled input behaviour).
 */
function setup(initialText = '', cmds = commands) {
  const state = { text: initialText }
  const textareaRef = { current: null } as React.RefObject<HTMLTextAreaElement | null>

  const rendered = renderHook(() =>
    useSlashMenu({
      slashCommands: cmds,
      text: state.text,
      setText: (t: string) => { state.text = t },
      textareaRef,
    })
  )

  /** Helper: update external text then re-render the hook. */
  const updateText = (t: string) => {
    state.text = t
    rendered.rerender()
  }

  return { rendered, state, updateText }
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe('useSlashMenu — initial state', () => {
  it('menu starts closed', () => {
    const { rendered } = setup()
    expect(rendered.result.current.slashMenuOpen).toBe(false)
  })

  it('index starts at 0', () => {
    const { rendered } = setup()
    expect(rendered.result.current.slashMenuIndex).toBe(0)
  })

  it('filteredCommands is empty when closed', () => {
    const { rendered } = setup('/co')
    expect(rendered.result.current.filteredCommands).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// handleInputChange — open / close transitions
// ---------------------------------------------------------------------------

describe('useSlashMenu — handleInputChange', () => {
  it('handleInputChange("/") opens menu', () => {
    const { rendered } = setup()
    act(() => { rendered.result.current.handleInputChange('/') })
    expect(rendered.result.current.slashMenuOpen).toBe(true)
  })

  it('handleInputChange("/co") opens menu (no space)', () => {
    const { rendered } = setup()
    act(() => { rendered.result.current.handleInputChange('/co') })
    expect(rendered.result.current.slashMenuOpen).toBe(true)
  })

  it('handleInputChange resets index to 0 on open', () => {
    const { rendered } = setup()
    // First open and navigate to index 1
    act(() => { rendered.result.current.handleInputChange('/') })
    act(() => { rendered.result.current.handleKeyDown(makeKeyEvent('ArrowDown')) })
    expect(rendered.result.current.slashMenuIndex).toBe(1)
    // New input should reset index
    act(() => { rendered.result.current.handleInputChange('/co') })
    expect(rendered.result.current.slashMenuIndex).toBe(0)
  })

  it('handleInputChange("/commit ") closes menu (has space)', () => {
    const { rendered } = setup()
    act(() => { rendered.result.current.handleInputChange('/commit') })
    act(() => { rendered.result.current.handleInputChange('/commit ') })
    expect(rendered.result.current.slashMenuOpen).toBe(false)
  })

  it('handleInputChange("hello") keeps menu closed', () => {
    const { rendered } = setup()
    act(() => { rendered.result.current.handleInputChange('hello') })
    expect(rendered.result.current.slashMenuOpen).toBe(false)
  })

  it('handleInputChange("") keeps menu closed', () => {
    const { rendered } = setup()
    act(() => { rendered.result.current.handleInputChange('') })
    expect(rendered.result.current.slashMenuOpen).toBe(false)
  })

  it('handleInputChange closes menu that was previously open', () => {
    const { rendered } = setup()
    act(() => { rendered.result.current.handleInputChange('/') })
    expect(rendered.result.current.slashMenuOpen).toBe(true)
    act(() => { rendered.result.current.handleInputChange('hello') })
    expect(rendered.result.current.slashMenuOpen).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// slashFilter and filteredCommands
// ---------------------------------------------------------------------------

describe('useSlashMenu — slashFilter', () => {
  it('slashFilter returns empty string when menu is closed', () => {
    const { rendered, updateText } = setup()
    updateText('/co')
    // menu is closed, so slashFilter should be empty
    expect(rendered.result.current.slashFilter).toBe('')
  })

  it('slashFilter returns text after "/" when menu is open', () => {
    const { rendered, updateText } = setup()
    act(() => { rendered.result.current.handleInputChange('/co') })
    updateText('/co')
    expect(rendered.result.current.slashFilter).toBe('co')
  })

  it('slashFilter returns empty string for bare "/"', () => {
    const { rendered, updateText } = setup()
    act(() => { rendered.result.current.handleInputChange('/') })
    updateText('/')
    expect(rendered.result.current.slashFilter).toBe('')
  })
})

describe('useSlashMenu — filteredCommands', () => {
  it('filteredCommands filters by prefix: "/co" → only /commit', () => {
    const { rendered, updateText } = setup()
    act(() => { rendered.result.current.handleInputChange('/co') })
    updateText('/co')
    expect(rendered.result.current.filteredCommands).toHaveLength(1)
    expect(rendered.result.current.filteredCommands[0].name).toBe('/commit')
  })

  it('filteredCommands shows all commands for bare "/"', () => {
    const { rendered, updateText } = setup()
    act(() => { rendered.result.current.handleInputChange('/') })
    updateText('/')
    expect(rendered.result.current.filteredCommands).toHaveLength(commands.length)
  })

  it('filteredCommands returns empty array when menu is closed', () => {
    const { rendered, updateText } = setup()
    updateText('/cl')
    expect(rendered.result.current.filteredCommands).toHaveLength(0)
  })

  it('filteredCommands is case-insensitive', () => {
    const { rendered, updateText } = setup()
    act(() => { rendered.result.current.handleInputChange('/CO') })
    updateText('/CO')
    expect(rendered.result.current.filteredCommands).toHaveLength(1)
    expect(rendered.result.current.filteredCommands[0].name).toBe('/commit')
  })

  it('filteredCommands returns empty array for unmatched filter', () => {
    const { rendered, updateText } = setup()
    act(() => { rendered.result.current.handleInputChange('/xyz') })
    updateText('/xyz')
    expect(rendered.result.current.filteredCommands).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// handleKeyDown — navigation
// ---------------------------------------------------------------------------

describe('useSlashMenu — handleKeyDown navigation', () => {
  it('ArrowDown advances index forward (0→1)', () => {
    const { rendered, updateText } = setup()
    act(() => { rendered.result.current.handleInputChange('/') })
    updateText('/')

    act(() => { rendered.result.current.handleKeyDown(makeKeyEvent('ArrowDown')) })
    expect(rendered.result.current.slashMenuIndex).toBe(1)
  })

  it('ArrowDown cycles from last back to 0', () => {
    const { rendered, updateText } = setup()
    act(() => { rendered.result.current.handleInputChange('/') })
    updateText('/')

    // Advance to last index (commands.length - 1 = 2)
    for (let i = 0; i < commands.length - 1; i++) {
      act(() => { rendered.result.current.handleKeyDown(makeKeyEvent('ArrowDown')) })
    }
    expect(rendered.result.current.slashMenuIndex).toBe(commands.length - 1)

    act(() => { rendered.result.current.handleKeyDown(makeKeyEvent('ArrowDown')) })
    expect(rendered.result.current.slashMenuIndex).toBe(0)
  })

  it('ArrowUp from 0 wraps to last index', () => {
    const { rendered, updateText } = setup()
    act(() => { rendered.result.current.handleInputChange('/') })
    updateText('/')

    act(() => { rendered.result.current.handleKeyDown(makeKeyEvent('ArrowUp')) })
    expect(rendered.result.current.slashMenuIndex).toBe(commands.length - 1)
  })

  it('ArrowUp decrements index (2→1→0)', () => {
    const { rendered, updateText } = setup()
    act(() => { rendered.result.current.handleInputChange('/') })
    updateText('/')

    // Navigate to index 2
    act(() => { rendered.result.current.handleKeyDown(makeKeyEvent('ArrowDown')) })
    act(() => { rendered.result.current.handleKeyDown(makeKeyEvent('ArrowDown')) })
    expect(rendered.result.current.slashMenuIndex).toBe(2)

    act(() => { rendered.result.current.handleKeyDown(makeKeyEvent('ArrowUp')) })
    expect(rendered.result.current.slashMenuIndex).toBe(1)

    act(() => { rendered.result.current.handleKeyDown(makeKeyEvent('ArrowUp')) })
    expect(rendered.result.current.slashMenuIndex).toBe(0)
  })

  it('ArrowDown returns true (event consumed)', () => {
    const { rendered, updateText } = setup()
    act(() => { rendered.result.current.handleInputChange('/') })
    updateText('/')

    let consumed = false
    act(() => { consumed = rendered.result.current.handleKeyDown(makeKeyEvent('ArrowDown')) })
    expect(consumed).toBe(true)
  })

  it('ArrowUp returns true (event consumed)', () => {
    const { rendered, updateText } = setup()
    act(() => { rendered.result.current.handleInputChange('/') })
    updateText('/')

    let consumed = false
    act(() => { consumed = rendered.result.current.handleKeyDown(makeKeyEvent('ArrowUp')) })
    expect(consumed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// handleKeyDown — selection
// ---------------------------------------------------------------------------

describe('useSlashMenu — handleKeyDown selection', () => {
  it('Enter selects current command and closes menu', () => {
    const { rendered, state, updateText } = setup()
    act(() => { rendered.result.current.handleInputChange('/') })
    updateText('/')
    // index=0 → /commit
    act(() => { rendered.result.current.handleKeyDown(makeKeyEvent('Enter')) })
    expect(rendered.result.current.slashMenuOpen).toBe(false)
    expect(state.text).toBe('/commit ')
  })

  it('Tab selects current command and closes menu', () => {
    const { rendered, state, updateText } = setup()
    act(() => { rendered.result.current.handleInputChange('/') })
    updateText('/')
    // Navigate to index 1 → /clear
    act(() => { rendered.result.current.handleKeyDown(makeKeyEvent('ArrowDown')) })
    act(() => { rendered.result.current.handleKeyDown(makeKeyEvent('Tab')) })
    expect(rendered.result.current.slashMenuOpen).toBe(false)
    expect(state.text).toBe('/clear ')
  })

  it('Enter returns true (event consumed)', () => {
    const { rendered, updateText } = setup()
    act(() => { rendered.result.current.handleInputChange('/') })
    updateText('/')

    let consumed = false
    act(() => { consumed = rendered.result.current.handleKeyDown(makeKeyEvent('Enter')) })
    expect(consumed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// handleKeyDown — Escape
// ---------------------------------------------------------------------------

describe('useSlashMenu — handleKeyDown Escape', () => {
  it('Escape closes menu', () => {
    const { rendered, updateText } = setup()
    act(() => { rendered.result.current.handleInputChange('/') })
    updateText('/')
    act(() => { rendered.result.current.handleKeyDown(makeKeyEvent('Escape')) })
    expect(rendered.result.current.slashMenuOpen).toBe(false)
  })

  it('Escape returns true (event consumed)', () => {
    const { rendered, updateText } = setup()
    act(() => { rendered.result.current.handleInputChange('/') })
    updateText('/')

    let consumed = false
    act(() => { consumed = rendered.result.current.handleKeyDown(makeKeyEvent('Escape')) })
    expect(consumed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// handleKeyDown — guard conditions
// ---------------------------------------------------------------------------

describe('useSlashMenu — handleKeyDown guard conditions', () => {
  it('returns false when menu is closed', () => {
    const { rendered } = setup()
    let consumed = true
    act(() => { consumed = rendered.result.current.handleKeyDown(makeKeyEvent('ArrowDown')) })
    expect(consumed).toBe(false)
  })

  it('returns false for unrecognized keys when open', () => {
    const { rendered, updateText } = setup()
    act(() => { rendered.result.current.handleInputChange('/') })
    updateText('/')

    let consumed = true
    act(() => { consumed = rendered.result.current.handleKeyDown(makeKeyEvent('a')) })
    expect(consumed).toBe(false)
  })

  it('returns false when open but filteredCommands is empty', () => {
    const { rendered, updateText } = setup()
    act(() => { rendered.result.current.handleInputChange('/xyz') })
    updateText('/xyz')
    // filteredCommands will be [] because no command starts with /xyz
    let consumed = true
    act(() => { consumed = rendered.result.current.handleKeyDown(makeKeyEvent('ArrowDown')) })
    expect(consumed).toBe(false)
  })

  it('returns false for all navigation keys when commands list is empty', () => {
    const { rendered, updateText } = setup('', [])
    act(() => { rendered.result.current.handleInputChange('/') })
    updateText('/')

    for (const key of ['ArrowDown', 'ArrowUp', 'Enter', 'Tab']) {
      let consumed = true
      act(() => { consumed = rendered.result.current.handleKeyDown(makeKeyEvent(key)) })
      expect(consumed).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// handleSelect
// ---------------------------------------------------------------------------

describe('useSlashMenu — handleSelect', () => {
  it('sets text to name + space', () => {
    const { rendered, state } = setup()
    act(() => { rendered.result.current.handleSelect('/commit') })
    expect(state.text).toBe('/commit ')
  })

  it('closes menu after select', () => {
    const { rendered, updateText } = setup()
    act(() => { rendered.result.current.handleInputChange('/') })
    updateText('/')
    expect(rendered.result.current.slashMenuOpen).toBe(true)
    act(() => { rendered.result.current.handleSelect('/commit') })
    expect(rendered.result.current.slashMenuOpen).toBe(false)
  })

  it('resets index to 0 after select', () => {
    const { rendered, updateText } = setup()
    act(() => { rendered.result.current.handleInputChange('/') })
    updateText('/')
    act(() => { rendered.result.current.handleKeyDown(makeKeyEvent('ArrowDown')) })
    expect(rendered.result.current.slashMenuIndex).toBe(1)
    act(() => { rendered.result.current.handleSelect('/help') })
    expect(rendered.result.current.slashMenuIndex).toBe(0)
  })
})

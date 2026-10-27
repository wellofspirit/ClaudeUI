/**
 * D8: the project menu opens on right-click only, which iOS never fires. A ⋯ button on the project
 * header opens the same menu on touch screens; pointer devices never render it (no row width spent).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { DirectoryGroup } from '../../../../../shared/types'
import { DirectoryItem } from '../DirectoryItem'

const group: DirectoryGroup = {
  cwd: '/d/WorkPlace/demo',
  projectKey: '-d-workplace-demo',
  folderName: 'demo',
  sessions: []
}

function renderItem(over: Partial<Parameters<typeof DirectoryItem>[0]> = {}) {
  const props = {
    group,
    expanded: false,
    activeSessionId: null,
    onClick: vi.fn(),
    onDoubleClick: vi.fn(),
    onSessionClick: vi.fn(),
    onSessionDoubleClick: vi.fn(),
    onToggleWatch: vi.fn(),
    onViewWorktrees: vi.fn(),
    renamingKey: null,
    renamePrefix: 'dir',
    onStartRename: vi.fn(),
    onFinishRename: vi.fn(),
    onAutoRename: vi.fn(),
    onCancelRename: vi.fn(),
    onDelete: vi.fn(),
    ...over
  }
  render(<DirectoryItem {...props} />)
  return props
}

const button = (): HTMLElement => screen.getByTestId('DirectoryItem.menu')

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('DirectoryItem ⋯ button', () => {
  it('opens the same menu as a right-click, positioned from the button rect', () => {
    renderItem()
    vi.spyOn(button(), 'getBoundingClientRect').mockReturnValue({
      left: 200,
      top: 4,
      right: 220,
      bottom: 28,
      width: 20,
      height: 24,
      x: 200,
      y: 4,
      toJSON: () => ({})
    })
    expect(screen.queryByText('View worktrees')).toBeNull()

    fireEvent.click(button())

    expect(screen.getByText('View worktrees')).toBeTruthy()
    expect(screen.getByText('New session here')).toBeTruthy()
    const menu = screen.getByText('View worktrees').closest('.fixed') as HTMLElement
    expect(menu.style.left).toBe('200px')
    expect(menu.style.top).toBe('28px')
  })

  it('opens the menu with the keyboard (it is a real button) and exposes the state', () => {
    renderItem()
    expect(button().tagName).toBe('BUTTON')
    expect(button().getAttribute('aria-haspopup')).toBe('menu')
    expect(button().getAttribute('aria-expanded')).toBe('false')
    expect(button().getAttribute('aria-label')).toBe('Project menu')

    // jsdom turns Enter/Space on a focused button into a click only through userEvent; the
    // click is what the browser dispatches, so dispatch it as the keyboard would.
    button().focus()
    expect(document.activeElement).toBe(button())
    fireEvent.click(button(), { detail: 0 })

    expect(button().getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('View worktrees')).toBeTruthy()
  })

  it('clicking it again closes the menu (the outside-click handler does not eat the mousedown)', () => {
    renderItem()
    fireEvent.mouseDown(button())
    fireEvent.click(button())
    expect(screen.getByText('View worktrees')).toBeTruthy()

    fireEvent.mouseDown(button())
    fireEvent.click(button())
    expect(screen.queryByText('View worktrees')).toBeNull()
  })

  it('a menu entry works from the button-opened menu', () => {
    const props = renderItem()
    fireEvent.click(button())
    fireEvent.click(screen.getByText('View worktrees'))
    expect(props.onViewWorktrees).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('View worktrees')).toBeNull()
  })

  it('does not toggle the project or start a new session', () => {
    vi.useFakeTimers()
    const props = renderItem()
    fireEvent.click(button())
    fireEvent.doubleClick(button())
    vi.advanceTimersByTime(400)
    expect(props.onClick).not.toHaveBeenCalled()
    expect(props.onDoubleClick).not.toHaveBeenCalled()
  })

  it('takes no layout on pointer devices and shows only on touch screens', () => {
    renderItem()
    const cls = button().className.split(/\s+/)
    expect(cls).toContain('hidden')
    expect(cls).toContain('[@media(hover:none)]:flex')
    expect(cls).not.toContain('flex')
  })

  it('right-click still opens the menu', () => {
    renderItem()
    fireEvent.contextMenu(within(screen.getByTestId('DirectoryItem')).getByText('demo'))
    expect(screen.getByText('View worktrees')).toBeTruthy()
  })

  it('the opened menu is a role=menu of menuitems, matching aria-haspopup (N9)', () => {
    renderItem({ onHide: vi.fn() })
    fireEvent.click(button())
    const menu = screen.getByRole('menu')
    const items = within(menu).getAllByRole('menuitem')
    expect(items.map((i) => i.textContent)).toEqual([
      'View worktrees',
      'New session here',
      'Hide project',
      'Delete project...'
    ])
  })

  it('keeps a 32 px touch target (N10)', () => {
    renderItem()
    expect(button().className).toContain('w-8')
    expect(button().className).toContain('h-8')
  })
})

/**
 * Settings › Sessions & autonomy › Worktrees: the one global default for "Start new sessions in a
 * worktree". Off when unset; the toggle writes `true`, and removes the key to turn it off again.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../stores/session-store'
import { pageOf } from '../settings-pages'

vi.mock('electron', async () => await import('../../../../../test/stubs/electron-shim'))

afterEach(cleanup)

const group = (): ReturnType<typeof pageOf>['groups'][number] => {
  const found = pageOf('sessions').groups.find((g) => g.id === 'worktrees')
  if (!found) throw new Error('the Worktrees group is not on the Sessions page')
  return found
}

function mount(startInWorktree?: boolean): ReturnType<typeof vi.fn> {
  const update = vi.fn()
  const row = group().items![0].render as unknown as (
    settings: AppSettings,
    update: (p: Partial<AppSettings>) => void
  ) => React.JSX.Element
  render(row({ ...DEFAULT_SETTINGS, startInWorktree } as AppSettings, update))
  return update
}

describe('Start new sessions in a worktree setting', () => {
  it('is the first group on the Sessions page, with one row', () => {
    expect(pageOf('sessions').groups[0].id).toBe('worktrees')
    expect(group().label).toBe('Worktrees')
    expect(group().items).toHaveLength(1)
  })

  it('is off by default', () => {
    mount()
    expect(screen.getByTestId('SettingsStartInWorktree').getAttribute('aria-pressed')).toBe('false')
  })

  it('turns on by writing true, and off by removing the key', () => {
    const on = mount()
    fireEvent.click(screen.getByTestId('SettingsStartInWorktree'))
    expect(on).toHaveBeenCalledWith({ startInWorktree: true })
    cleanup()

    const off = mount(true)
    expect(screen.getByTestId('SettingsStartInWorktree').getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByTestId('SettingsStartInWorktree'))
    expect(off).toHaveBeenCalledWith({ startInWorktree: undefined })
  })
})

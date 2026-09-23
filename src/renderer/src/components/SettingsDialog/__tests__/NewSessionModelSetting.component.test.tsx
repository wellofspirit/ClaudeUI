/**
 * Models & providers › Default models › "New sessions start on" (providers-v3
 * slice 9). One engine-neutral item, reused at the top of every engine segment;
 * it writes `settings.newSessionModel`, and while the last pick wins each
 * engine's default-model row says so (`LastPickNote`).
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { PAGES } from '../settings-pages'
import { LastPickNote, NewSessionModelSetting } from '../NewSessionModelSetting'
import { useSessionStore, DEFAULT_SETTINGS } from '../../../stores/session-store'
import type { AppSettings } from '../../../stores/session-store'

afterEach(() => {
  cleanup()
  useSessionStore.setState((state) => ({
    settings: { ...state.settings, newSessionModel: undefined }
  }))
})

const option = (id: string): HTMLElement =>
  screen.getAllByTestId('NewSessionModelSetting.choice.option').find((el) => el.dataset.id === id)!

describe('"New sessions start on"', () => {
  it('heads EVERY engine segment of Default models, as one shared item', () => {
    const group = PAGES.find((page) => page.id === 'models')!.groups.find(
      (g) => g.id === 'defaults'
    )!
    const firsts = Object.entries(group.byEngine ?? {}).map(([engine, items]) => [
      engine,
      items![0]
    ])
    expect(firsts.map(([engine]) => engine)).toEqual(['claude', 'opencode', 'pi', 'codex'])
    const [first] = firsts.map(([, item]) => item)
    for (const [, item] of firsts) {
      // The SAME object on every segment — one row, not four copies.
      expect(item).toBe(first)
    }
    expect((first as { key: string }).key).toBe('newSessionModel')
  })

  it("reads absent as 'the last model I picked', and writes the choice", () => {
    const update = vi.fn()
    render(<NewSessionModelSetting settings={DEFAULT_SETTINGS} update={update} />)
    const row = screen.getByTestId('NewSessionModelSetting')
    expect(row).toHaveAttribute('data-id', 'newSessionModel')
    expect(row).toHaveTextContent('New sessions start on')
    expect(row).toHaveTextContent(
      "Per engine. The composer's model picker always changes the session you are in."
    )
    expect(option('last-picked')).toHaveAttribute('aria-pressed', 'true')
    expect(option('configured-default')).toHaveTextContent('The default below')

    fireEvent.click(option('configured-default'))
    expect(update).toHaveBeenCalledWith({ newSessionModel: 'configured-default' })
  })

  it('shows the saved choice', () => {
    const settings: AppSettings = { ...DEFAULT_SETTINGS, newSessionModel: 'configured-default' }
    render(<NewSessionModelSetting settings={settings} update={vi.fn()} />)
    expect(option('configured-default')).toHaveAttribute('aria-pressed', 'true')
  })

  it('the default-model rows say "used until you pick" only while the last pick wins', () => {
    render(<LastPickNote />)
    expect(screen.getByTestId('NewSessionModelSetting.lastPickNote')).toHaveTextContent(
      'Used until you pick a model in the composer.'
    )
    act(() => {
      useSessionStore.setState((state) => ({
        settings: { ...state.settings, newSessionModel: 'configured-default' }
      }))
    })
    expect(screen.queryByTestId('NewSessionModelSetting.lastPickNote')).not.toBeInTheDocument()
  })
})

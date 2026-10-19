/**
 * Settings › Sessions & autonomy › Session tools: the host-wide switch for the agent-facing
 * `session_*` tools. On when unset; the toggle writes `false` to turn it off and removes the
 * key to turn it back on, and the row says when it takes effect.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../stores/session-store'
import { pageOf } from '../settings-pages'

vi.mock('electron', async () => await import('../../../../../test/stubs/electron-shim'))

afterEach(cleanup)

const item = (): NonNullable<ReturnType<typeof pageOf>['groups'][number]['items']>[number] => {
  const group = pageOf('sessions').groups.find((g) => g.id === 'session-tools')
  const found = group?.items?.find((i) => i.key === 'sessionTools')
  if (!found) throw new Error('the Session tools item is not on the Sessions page')
  return found
}

function mount(sessionTools?: boolean): ReturnType<typeof vi.fn> {
  const update = vi.fn()
  // The row reads only the settings and `update`; the engine and vendor config are not its.
  const row = item().render as unknown as (
    settings: AppSettings,
    update: (p: Partial<AppSettings>) => void
  ) => React.JSX.Element
  render(row({ ...DEFAULT_SETTINGS, sessionTools } as AppSettings, update))
  return update
}

describe('Session tools setting', () => {
  it('is on by default, and says it applies to sessions started after a change', () => {
    mount()
    expect(screen.getByTestId('SettingsSessionTools').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('SettingsSessionTools').textContent).toMatch(
      /sessions started after/i
    )
  })

  it('turns off by writing false, and back on by removing the key', () => {
    const off = mount()
    fireEvent.click(screen.getByTestId('SettingsSessionTools'))
    expect(off).toHaveBeenCalledWith({ sessionTools: false })
    cleanup()

    const on = mount(false)
    expect(screen.getByTestId('SettingsSessionTools').getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(screen.getByTestId('SettingsSessionTools'))
    expect(on).toHaveBeenCalledWith({ sessionTools: undefined })
  })
})

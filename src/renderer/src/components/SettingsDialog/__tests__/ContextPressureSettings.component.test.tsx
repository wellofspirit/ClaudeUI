/**
 * Settings › Sessions & autonomy › Context pressure (session tools, slice 4): the mode and the
 * thresholds write through the ordinary settings update, the input is validated, and the
 * ceiling list shows where each open model compacts and flags thresholds past it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { EMPTY_SESSION_STATE, useSessionStore } from '../../../stores/session-store'
import type { AppSettings } from '../../../stores/session-store'
import type { EngineId, StatusLineData } from '../../../../../shared/types'
import { ContextPressureSettings } from '../ContextPressureSettings'
import { pageOf } from '../settings-pages'

vi.mock('electron', async () => await import('../../../../../test/stubs/electron-shim'))

let initial: ReturnType<typeof useSessionStore.getState>
beforeEach(() => {
  initial = useSessionStore.getState()
})
afterEach(() => {
  cleanup()
  useSessionStore.setState(initial, true)
})

function open(sessions: { id: string; engine: EngineId; model: string; size: number }[]): void {
  useSessionStore.setState({
    sessions: Object.fromEntries(
      sessions.map((s) => [
        s.id,
        {
          ...EMPTY_SESSION_STATE,
          selectedEngineId: s.engine,
          selectedModel: s.model,
          statusLine: { contextWindow: { used: 1000, size: s.size } } as StatusLineData
        }
      ])
    )
  })
}

function mount(contextPressure?: AppSettings['contextPressure']): ReturnType<typeof vi.fn> {
  const update = vi.fn()
  render(
    <ContextPressureSettings
      settings={{ ...(useSessionStore.getState().settings as AppSettings), contextPressure }}
      update={update}
    />
  )
  return update
}

const written = (update: ReturnType<typeof vi.fn>): unknown =>
  update.mock.calls[update.mock.calls.length - 1][0].contextPressure

describe('mode', () => {
  it('offers off, ask and automatic, defaulting to off', () => {
    mount()
    const options = screen.getAllByTestId('ContextPressureSettings.mode.option')
    expect(options.map((o) => o.getAttribute('data-id'))).toEqual(['off', 'ask', 'auto'])
    expect(options.map((o) => o.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false'])
  })

  it('writes the chosen mode and keeps the thresholds', () => {
    const update = mount({ mode: 'off', thresholds: [40, 80] })
    fireEvent.click(
      screen
        .getAllByTestId('ContextPressureSettings.mode.option')
        .find((o) => o.getAttribute('data-id') === 'auto') as HTMLElement
    )
    expect(written(update)).toEqual({ mode: 'auto', thresholds: [40, 80] })
  })

  it('a bad stored value reads as the default and Reset drops the key', () => {
    const update = mount({ mode: 'weird', thresholds: [] } as never)
    expect(screen.getAllByTestId('ContextPressureSettings.threshold')).toHaveLength(1)
    expect(screen.getByTestId('ContextPressureSettings.threshold').getAttribute('data-id')).toBe(
      '70'
    )
    fireEvent.click(screen.getByTestId('ContextPressureSettings.modeRow.reset'))
    expect(update).toHaveBeenCalledWith({ contextPressure: undefined })
  })
})

describe('thresholds', () => {
  const thresholds = (): string[] =>
    screen
      .getAllByTestId('ContextPressureSettings.threshold')
      .map((t) => t.getAttribute('data-id') as string)
  const type = (text: string): void => {
    fireEvent.change(screen.getByTestId('ContextPressureSettings.input'), {
      target: { value: text }
    })
    fireEvent.click(screen.getByTestId('ContextPressureSettings.add'))
  }

  it('adds one, sorted', () => {
    const update = mount({ mode: 'ask', thresholds: [50, 80] })
    type('65')
    expect(written(update)).toEqual({ mode: 'ask', thresholds: [50, 65, 80] })
  })

  it('refuses a value outside 10-95, a fraction, a duplicate and a fifth one, saying why', () => {
    const update = mount({ mode: 'ask', thresholds: [30, 50, 70, 80] })
    for (const bad of ['', 'abc', '9', '96', '40.5']) {
      type(bad)
      expect(screen.getByTestId('ContextPressureSettings.error').textContent).toMatch(
        /whole number from 10 to 95/
      )
    }
    type('50')
    expect(screen.getByTestId('ContextPressureSettings.error').textContent).toMatch(/already/)
    type('60')
    expect(screen.getByTestId('ContextPressureSettings.error').textContent).toMatch(/At most 4/)
    expect(update).not.toHaveBeenCalled()
  })

  it('removes one, but the last one stays', () => {
    const update = mount({ mode: 'ask', thresholds: [50, 80] })
    const remove = screen
      .getAllByTestId('ContextPressureSettings.remove')
      .find((b) => b.getAttribute('data-id') === '50') as HTMLElement
    fireEvent.click(remove)
    expect(written(update)).toEqual({ mode: 'ask', thresholds: [80] })
    cleanup()
    mount({ mode: 'ask', thresholds: [80] })
    expect(thresholds()).toEqual(['80'])
    expect(screen.getByTestId('ContextPressureSettings.remove')).toBeDisabled()
  })
})

describe('where each model compacts', () => {
  it('shows Claude 200k at 83 % and 1M at 96 %, and nothing known for the other engines', () => {
    open([
      { id: 'a', engine: 'claude', model: 'sonnet-4-5', size: 200_000 },
      { id: 'b', engine: 'claude', model: 'opus-5-5', size: 1_000_000 },
      { id: 'c', engine: 'pi', model: 'gpt-5', size: 400_000 }
    ])
    mount({ mode: 'ask', thresholds: [70] })
    const rows = screen.getAllByTestId('ContextPressureSettings.ceiling')
    expect(rows).toHaveLength(3)
    const values = rows.map(
      (r) => within(r).getByTestId('ContextPressureSettings.ceilingValue').textContent
    )
    expect(values).toEqual(['compacts at 83 %', 'compacts at 96 %', 'compaction point unknown'])
    expect(rows[0].textContent).toContain('200k window')
    expect(rows[1].textContent).toContain('1M window')
    expect(screen.queryByTestId('ContextPressureSettings.never')).toBeNull()
  })

  it('flags a threshold above the ceiling as never reached', () => {
    open([{ id: 'a', engine: 'claude', model: 'sonnet-4-5', size: 200_000 }])
    mount({ mode: 'auto', thresholds: [70, 90] })
    expect(screen.getByTestId('ContextPressureSettings.never').textContent).toBe(
      '90 % never reached: Claude compacts first.'
    )
  })

  it('invites opening a session when none reports a window', () => {
    open([{ id: 'a', engine: 'pi', model: 'x', size: 0 }])
    mount()
    expect(screen.getByTestId('ContextPressureSettings.ceilingEmpty')).toBeInTheDocument()
  })
})

describe('placement', () => {
  it('is a group of Sessions & autonomy', () => {
    const group = pageOf('sessions').groups.find((g) => g.id === 'context-pressure')
    expect(group?.items?.map((i) => i.key)).toEqual(['contextPressure'])
  })
})

/**
 * Settings › Engines › Claude Code › Auto mode: the toggle shows the replicated
 * `autoModeDisabledBySettings`, asks the host for the opposite value on click, never flips ahead of
 * the host's echo, and shows a refused write in the row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { pageOf } from '../settings-pages'
import { ClaudeDisableAutoModeSetting } from '../settings-controls'
import { seedLocalApp } from '../../../stores/replica'
import { resetReplicaSeam } from '@test/helpers/replica-seed'

vi.mock('electron', async () => await import('../../../../../test/stubs/electron-shim'))

const setClaudeDisableAutoMode = vi.fn<(disabled: boolean) => Promise<void>>()

beforeEach(() => {
  resetReplicaSeam()
  setClaudeDisableAutoMode.mockReset()
  ;(window as unknown as { api: unknown }).api = { setClaudeDisableAutoMode }
})
afterEach(cleanup)

const toggle = (): HTMLElement => screen.getByTestId('ClaudeDisableAutoMode.toggle')

describe('Claude page › Auto mode', () => {
  it('is its own group on the Claude page, right after Session behaviour, with no badge', () => {
    const groups = pageOf('claude').groups
    const i = groups.findIndex((g) => g.id === 'auto-mode')
    expect(groups[i - 1].id).toBe('session')
    expect(groups[i].appliesOn).toBeUndefined()
    expect(groups[i].storage).toBe('~/.claude/settings.json')
  })

  it('reflects the store value', () => {
    seedLocalApp({ autoModeDisabledBySettings: true })
    render(<ClaudeDisableAutoModeSetting />)
    expect(toggle().getAttribute('aria-pressed')).toBe('true')
    act(() => seedLocalApp({ autoModeDisabledBySettings: false }))
    expect(toggle().getAttribute('aria-pressed')).toBe('false')
  })

  it('a click asks for the opposite value and does not flip before the echo', async () => {
    seedLocalApp({ autoModeDisabledBySettings: false })
    setClaudeDisableAutoMode.mockResolvedValue(undefined)
    render(<ClaudeDisableAutoModeSetting />)
    fireEvent.click(toggle())
    expect(setClaudeDisableAutoMode).toHaveBeenCalledWith(true)
    await waitFor(() => expect(setClaudeDisableAutoMode).toHaveBeenCalledTimes(1))
    expect(toggle().getAttribute('aria-pressed')).toBe('false')
  })

  it('shows a rejection in the row and clears it after a later success', async () => {
    // As the desktop transport delivers a handler's throw; the row shows the handler's sentence.
    setClaudeDisableAutoMode.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'claude:set-disable-auto-mode': Error: settings.json is not valid JSON; fix or remove it, then try again"
      )
    )
    render(<ClaudeDisableAutoModeSetting />)
    fireEvent.click(toggle())
    expect((await screen.findByTestId('ClaudeDisableAutoMode.error')).textContent).toBe(
      'settings.json is not valid JSON; fix or remove it, then try again'
    )
    expect(toggle().getAttribute('aria-pressed')).toBe('false')

    setClaudeDisableAutoMode.mockResolvedValueOnce(undefined)
    fireEvent.click(toggle())
    await waitFor(() => expect(screen.queryByTestId('ClaudeDisableAutoMode.error')).toBeNull())
  })
})

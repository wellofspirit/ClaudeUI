/**
 * Layer 2: Component tests for AutonomyModePicker.
 *
 * The picker writes the ClaudeUI-owned `settings.defaultAutonomyMode`. That
 * write alone is inert for the current app run: `createNewSession` seeds each
 * session's mode from the STORE's `defaultPermissionMode`, which is hydrated
 * once at boot. So the picker must mirror its choice there too — otherwise
 * picking "Read-only (Plan)" does nothing until the app is restarted.
 *
 * It must NOT write `~/.claude/settings.json`: this setting governs opencode and
 * pi sessions as well, and changing it here should not alter how the user's bare
 * `claude` CLI behaves.
 *
 * It must also not overclaim: the copy has to say this applies to NEW sessions,
 * because running sessions keep the mode they spawned with (cli.js re-derives
 * rules on a settings change but never the mode).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { useSessionStore } from '../../../stores/session-store'
import { AutonomyModePicker } from '../settings-sections'

const saveClaudePermissions = vi.fn(async () => {})
const saveSettings = vi.fn()

beforeEach(() => {
  saveClaudePermissions.mockClear()
  saveSettings.mockClear()
  ;(globalThis as any).window.api = {
    loadClaudePermissions: vi.fn(async () => ({
      allow: [],
      deny: [],
      ask: [],
      additionalDirectories: [],
      defaultMode: undefined
    })),
    saveClaudePermissions,
    saveSettings
  }
  useSessionStore.setState({
    defaultPermissionMode: 'default',
    settings: { ...useSessionStore.getState().settings, defaultAutonomyMode: 'ask' }
  })
})

afterEach(cleanup)

describe('AutonomyModePicker', () => {
  it('reflects the ClaudeUI setting', () => {
    useSessionStore.setState({
      settings: { ...useSessionStore.getState().settings, defaultAutonomyMode: 'autoEdit' }
    })
    render(<AutonomyModePicker />)
    expect(screen.getByDisplayValue('autoEdit')).toHaveProperty('checked', true)
  })

  it('persists the pick as the ClaudeUI setting', async () => {
    render(<AutonomyModePicker />)
    fireEvent.click(screen.getByDisplayValue('plan'))
    await waitFor(() =>
      expect(useSessionStore.getState().settings.defaultAutonomyMode).toBe('plan')
    )
    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ defaultAutonomyMode: 'plan' })
    )
  })

  it('never writes Claude settings.json', async () => {
    render(<AutonomyModePicker />)
    fireEvent.click(screen.getByDisplayValue('full'))
    await waitFor(() => expect(useSessionStore.getState().defaultPermissionMode).toBe('auto'))
    expect(saveClaudePermissions).not.toHaveBeenCalled()
  })

  it('mirrors the choice into the store so new sessions pick it up this run', async () => {
    render(<AutonomyModePicker />)
    fireEvent.click(screen.getByDisplayValue('full'))
    await waitFor(() => expect(useSessionStore.getState().defaultPermissionMode).toBe('auto'))
  })

  it('says the setting applies to new sessions only', () => {
    render(<AutonomyModePicker />)
    const hint = screen.getByTestId('AutonomyModePicker').textContent ?? ''
    expect(hint).toContain('new sessions')
    expect(hint.toLowerCase()).toContain('running sessions')
  })
})

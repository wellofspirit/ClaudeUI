/**
 * Layer 2: Component tests for AutonomyModePicker.
 *
 * The picker writes `permissions.defaultMode` to ~/.claude/settings.json. That
 * write alone is inert for the current app run: `createNewSession` seeds each
 * session's mode from the STORE, which is hydrated once at boot. So the picker
 * must mirror its choice into `defaultPermissionMode` — otherwise picking
 * "Read-only (Plan)" does nothing until the app is restarted.
 *
 * It must also not overclaim: the copy has to say this applies to NEW sessions,
 * because running sessions keep the mode they spawned with (cli.js re-derives
 * rules on a settings change but never the mode).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import type { ClaudePermissions } from '../../../../../shared/types'
import { useSessionStore } from '../../../stores/session-store'
import { AutonomyModePicker } from '../settings-sections'

const saveClaudePermissions = vi.fn(async () => {})
let stored: ClaudePermissions

function perms(defaultMode?: string): ClaudePermissions {
  return { allow: [], deny: [], ask: [], additionalDirectories: [], defaultMode }
}

beforeEach(() => {
  stored = perms()
  saveClaudePermissions.mockClear()
  ;(globalThis as any).window.api = {
    loadClaudePermissions: vi.fn(async () => stored),
    saveClaudePermissions
  }
  useSessionStore.setState({ defaultPermissionMode: 'default' })
})

afterEach(cleanup)

async function renderPicker(): Promise<void> {
  render(<AutonomyModePicker />)
  await waitFor(() => expect(window.api.loadClaudePermissions).toHaveBeenCalled())
}

describe('AutonomyModePicker', () => {
  it('reflects the persisted defaultMode', async () => {
    stored = perms('acceptEdits')
    await renderPicker()
    await waitFor(() =>
      expect(screen.getByDisplayValue('autoEdit')).toHaveProperty('checked', true)
    )
  })

  it('persists the mapped PermissionMode', async () => {
    await renderPicker()
    fireEvent.click(screen.getByDisplayValue('plan'))
    await waitFor(() =>
      expect(saveClaudePermissions).toHaveBeenCalledWith(
        'user',
        expect.objectContaining({ defaultMode: 'plan' })
      )
    )
  })

  it('mirrors the choice into the store so new sessions pick it up this run', async () => {
    await renderPicker()
    fireEvent.click(screen.getByDisplayValue('full'))
    await waitFor(() => expect(useSessionStore.getState().defaultPermissionMode).toBe('auto'))
  })

  it('says the setting applies to new sessions only', async () => {
    await renderPicker()
    const hint = screen.getByTestId('AutonomyModePicker').textContent ?? ''
    expect(hint).toContain('new sessions')
    expect(hint.toLowerCase()).toContain('running sessions')
  })
})

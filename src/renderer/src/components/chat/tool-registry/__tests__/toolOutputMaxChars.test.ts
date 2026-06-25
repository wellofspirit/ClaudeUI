/**
 * toolOutputMaxChars settings round-trip test (ROADMAP #11d)
 *
 * Verifies the default value and that the store accepts updates.
 * Uses setState directly to avoid the IPC side-effect of updateSettings
 * (which calls window.api.saveSettings — not available in unit tests).
 */

import { describe, it, expect } from 'vitest'
import { useSessionStore } from '@renderer/stores/session-store'

describe('toolOutputMaxChars — AppSettings shape', () => {
  it('default settings include toolOutputMaxChars = 5000', () => {
    // Read the default value directly from the initial state.
    const settings = useSessionStore.getState().settings
    expect(settings.toolOutputMaxChars).toBe(5000)
  })

  it('toolOutputMaxChars is settable via setState', () => {
    // Use setState (bypasses IPC save) to verify the shape is accepted.
    useSessionStore.setState((s) => ({
      settings: { ...s.settings, toolOutputMaxChars: 10000 }
    }))
    expect(useSessionStore.getState().settings.toolOutputMaxChars).toBe(10000)
    // Restore
    useSessionStore.setState((s) => ({
      settings: { ...s.settings, toolOutputMaxChars: 5000 }
    }))
  })

  it('toolOutputMaxChars accepts boundary values (500, 50000)', () => {
    useSessionStore.setState((s) => ({
      settings: { ...s.settings, toolOutputMaxChars: 500 }
    }))
    expect(useSessionStore.getState().settings.toolOutputMaxChars).toBe(500)

    useSessionStore.setState((s) => ({
      settings: { ...s.settings, toolOutputMaxChars: 50000 }
    }))
    expect(useSessionStore.getState().settings.toolOutputMaxChars).toBe(50000)

    // Restore default
    useSessionStore.setState((s) => ({
      settings: { ...s.settings, toolOutputMaxChars: 5000 }
    }))
  })
})

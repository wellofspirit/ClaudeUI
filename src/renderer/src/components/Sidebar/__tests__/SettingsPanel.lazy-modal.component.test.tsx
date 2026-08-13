/**
 * Layer 2: Component test for SettingsPanel's lazy RemoteAccessModal boundary.
 *
 * The modal drags in qrcode plus its own tree, and its trigger is desktop-only —
 * on the web client those bytes are unreachable. So the modal must not enter the
 * module graph until the user actually opens it.
 *
 * The `modalLoaded` probe *is* the mock factory: vitest runs it on the first
 * import of '../../RemoteAccessModal', so flipping a flag there records when the
 * modal enters the graph. A static import in SettingsPanel.tsx would flip it
 * during this file's own import phase, failing the first assertion.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

// vi.hoisted so the probe exists before the hoisted vi.mock factory closes over it
const { modalLoaded } = vi.hoisted(() => ({ modalLoaded: { current: false } }))

vi.mock('../../SettingsDialog', () => ({
  SettingsDialog: () => null,
  SettingsToggle: () => null
}))
vi.mock('../UsagePanel', () => ({ UsageRing: () => null }))
vi.mock('../../RemoteAccessModal', () => {
  modalLoaded.current = true
  return { RemoteAccessModal: () => <div data-testid="RemoteAccessModal" /> }
})

import { SettingsPanel } from '../SettingsPanel'

describe('SettingsPanel — lazy RemoteAccessModal', () => {
  beforeEach(() => {
    // Non-web platform: the remote-access trigger is gated on it.
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      platform: 'darwin',
      getRemoteStatus: vi.fn(async () => null),
      onRemoteStatus: vi.fn(() => () => {})
    }
  })

  it('loads the modal only when the remote-access button is clicked', async () => {
    // A static import in SettingsPanel.tsx would already have run the factory.
    expect(modalLoaded.current).toBe(false)

    await act(async () => {
      render(<SettingsPanel />)
    })

    // Mounted and settled (status effect resolved) — still no modal module.
    expect(screen.getByTestId('SettingsPanel')).toBeInTheDocument()
    expect(modalLoaded.current).toBe(false)
    expect(screen.queryByTestId('RemoteAccessModal')).toBeNull()

    fireEvent.click(screen.getByTestId('SettingsPanel.remoteAccess'))

    // fallback={null}: nothing paints while the chunk is in flight.
    expect(screen.queryByTestId('RemoteAccessModal')).toBeNull()

    await waitFor(() => expect(screen.getByTestId('RemoteAccessModal')).toBeInTheDocument())
    expect(modalLoaded.current).toBe(true)
  })
})

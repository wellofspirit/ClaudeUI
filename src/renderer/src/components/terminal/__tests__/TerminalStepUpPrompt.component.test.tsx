import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TerminalStepUpPrompt } from '../TerminalStepUpPrompt'

const api = {
  terminalStepUp: vi.fn(),
  terminalStepUpPasskey: vi.fn()
}

describe('TerminalStepUpPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.terminalStepUp.mockResolvedValue({ ok: true })
    api.terminalStepUpPasskey.mockResolvedValue({ ok: true })
    ;(window as unknown as { api: typeof api }).api = api
  })
  afterEach(cleanup)

  it('leads with the PASSKEY when this connection can run one (ADR-052 decision 5)', async () => {
    const onGranted = vi.fn()
    render(<TerminalStepUpPrompt passkey onGranted={onGranted} />)
    const root = screen.getByTestId('TerminalStepUpPrompt')
    expect(root).toHaveAttribute('data-mode', 'passkey')
    // No password field is even mounted: the passkey is the factor that proves
    // a human, and a visible password box invites the weaker one by default.
    expect(screen.queryByTestId('TerminalStepUpPrompt.password')).toBeNull()

    fireEvent.click(screen.getByTestId('TerminalStepUpPrompt.passkey'))
    await waitFor(() => expect(api.terminalStepUpPasskey).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(onGranted).toHaveBeenCalledTimes(1))
    expect(api.terminalStepUp).not.toHaveBeenCalled()
  })

  it('leads with the PASSWORD when no passkey is possible here', async () => {
    const onGranted = vi.fn()
    render(<TerminalStepUpPrompt onGranted={onGranted} />)
    expect(screen.getByTestId('TerminalStepUpPrompt')).toHaveAttribute('data-mode', 'password')
    // Nothing to switch to, so the factor toggle is not offered either.
    expect(screen.queryByTestId('TerminalStepUpPrompt.switchFactor')).toBeNull()

    fireEvent.change(screen.getByTestId('TerminalStepUpPrompt.password'), {
      target: { value: 'hunter2hunter2' }
    })
    fireEvent.click(screen.getByTestId('TerminalStepUpPrompt.submit'))
    await waitFor(() => expect(api.terminalStepUp).toHaveBeenCalledWith('hunter2hunter2'))
    await waitFor(() => expect(onGranted).toHaveBeenCalled())
  })

  it('`passkey-unavailable` falls back to the password form with the reason', async () => {
    api.terminalStepUpPasskey.mockResolvedValue({
      ok: false,
      code: 'passkey-unavailable',
      error: 'No passkey is enrolled for this device.',
      retryable: false
    })
    render(<TerminalStepUpPrompt passkey onGranted={vi.fn()} />)
    fireEvent.click(screen.getByTestId('TerminalStepUpPrompt.passkey'))

    // GUARD: the client's `passkey` hint was wrong and the SERVER is the
    // authority — the prompt must move to the factor that can actually work,
    // not leave a dead button.
    await waitFor(() =>
      expect(screen.getByTestId('TerminalStepUpPrompt')).toHaveAttribute('data-mode', 'password')
    )
    expect(screen.getByTestId('TerminalStepUpPrompt.error')).toHaveTextContent(
      'No passkey is enrolled for this device.'
    )
    expect(screen.getByTestId('TerminalStepUpPrompt.password')).toBeInTheDocument()
  })

  it('`passkey-required` from the password path flips BACK to the ceremony', async () => {
    api.terminalStepUp.mockResolvedValue({
      ok: false,
      code: 'passkey-required',
      error: 'This server requires a passkey to unlock the terminal.',
      retryable: false
    })
    render(<TerminalStepUpPrompt passkey onGranted={vi.fn()} />)
    fireEvent.click(screen.getByTestId('TerminalStepUpPrompt.switchFactor'))
    fireEvent.change(screen.getByTestId('TerminalStepUpPrompt.password'), {
      target: { value: 'hunter2hunter2' }
    })
    fireEvent.click(screen.getByTestId('TerminalStepUpPrompt.submit'))

    // Re-prompting for a secret the policy will keep refusing is the failure
    // mode this branch exists to prevent.
    await waitFor(() =>
      expect(screen.getByTestId('TerminalStepUpPrompt')).toHaveAttribute('data-mode', 'passkey')
    )
    expect(screen.getByTestId('TerminalStepUpPrompt.error')).toHaveTextContent(
      /requires a passkey/i
    )
  })

  it('keeps throttle refusals inline and does NOT change factor', async () => {
    api.terminalStepUpPasskey.mockResolvedValue({
      ok: false,
      code: 'throttled',
      error: 'Too many attempts — wait a few minutes and try again.',
      retryable: false
    })
    render(<TerminalStepUpPrompt passkey onGranted={vi.fn()} />)
    fireEvent.click(screen.getByTestId('TerminalStepUpPrompt.passkey'))
    await waitFor(() =>
      expect(screen.getByTestId('TerminalStepUpPrompt.error')).toHaveTextContent(
        /Too many attempts/
      )
    )
    // A throttled key is throttled for BOTH factors (one shared budget), so
    // bouncing the user to the password form would just burn the other one too.
    expect(screen.getByTestId('TerminalStepUpPrompt')).toHaveAttribute('data-mode', 'passkey')
  })

  it('a thrown transport error renders inline instead of unmounting the prompt', async () => {
    api.terminalStepUpPasskey.mockRejectedValue(new Error('Not connected'))
    render(<TerminalStepUpPrompt passkey onGranted={vi.fn()} />)
    fireEvent.click(screen.getByTestId('TerminalStepUpPrompt.passkey'))
    await waitFor(() =>
      expect(screen.getByTestId('TerminalStepUpPrompt.error')).toHaveTextContent('Not connected')
    )
  })

  it('clears the password from state once the grant is armed', async () => {
    render(<TerminalStepUpPrompt onGranted={vi.fn()} />)
    const input = screen.getByTestId('TerminalStepUpPrompt.password')
    fireEvent.change(input, { target: { value: 'hunter2hunter2' } })
    fireEvent.click(screen.getByTestId('TerminalStepUpPrompt.submit'))
    // The proof lives server-side as a grant with a deadline; that is the only
    // thing that should outlive the ceremony.
    await waitFor(() => expect(input).toHaveValue(''))
  })
})

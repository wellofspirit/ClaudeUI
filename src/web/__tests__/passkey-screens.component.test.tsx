/**
 * Component tests for the web client's passkey surfaces (ADR-052 series 2):
 * the one-tap login, the `#enroll=` landing screen, the inline post-password
 * offer, and the `off`-mode banner.
 *
 * These are the SCREENS; the protocol they drive is covered in
 * `connection.passkey.test.ts`. What matters here is that each server outcome
 * reaches the user as something actionable rather than a raw code.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PasskeyLogin } from '../components/PasskeyLogin'
import { EnrollDevice } from '../components/EnrollDevice'
import {
  EnrollPrompt,
  dismissEnrollPrompt,
  enrollPromptDismissed
} from '../components/EnrollPrompt'
import { NoAuthBanner } from '../components/NoAuthBanner'

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

describe('PasskeyLogin', () => {
  it('is one tap with NO username field (discoverable credentials)', () => {
    render(<PasskeyLogin onSignIn={vi.fn(async () => {})} />)
    expect(screen.getByTestId('PasskeyLogin.submit')).toBeInTheDocument()
    // Single operator + discoverable credentials means the authenticator picks;
    // a username box would be a field with nothing to put in it.
    expect(document.querySelector('input')).toBeNull()
  })

  it('fires the ceremony on the tap and reports a refusal inline', async () => {
    const onSignIn = vi.fn(async () => {
      throw new Error('Passkey prompt was cancelled or timed out.')
    })
    render(<PasskeyLogin onSignIn={onSignIn} />)
    fireEvent.click(screen.getByTestId('PasskeyLogin.submit'))
    await waitFor(() => expect(onSignIn).toHaveBeenCalledTimes(1))
    expect(await screen.findByTestId('PasskeyLogin.error')).toHaveTextContent(/cancelled/i)
    // Still retryable — the button must come back, not stay disabled forever.
    expect(screen.getByTestId('PasskeyLogin.submit')).not.toBeDisabled()
  })

  it('offers the break-glass password only when there is one to fall back to', () => {
    const { unmount } = render(<PasskeyLogin onSignIn={vi.fn(async () => {})} />)
    expect(screen.queryByTestId('PasskeyLogin.usePassword')).toBeNull()
    unmount()

    const onUsePassword = vi.fn()
    render(<PasskeyLogin onSignIn={vi.fn(async () => {})} onUsePassword={onUsePassword} />)
    fireEvent.click(screen.getByTestId('PasskeyLogin.usePassword'))
    expect(onUsePassword).toHaveBeenCalled()
  })
})

describe('EnrollDevice', () => {
  it('registers with the typed nickname, trimmed to null when blank', async () => {
    const onEnroll = vi.fn(async () => {})
    render(<EnrollDevice onEnroll={onEnroll} />)
    fireEvent.click(screen.getByTestId('EnrollDevice.submit'))
    await waitFor(() => expect(onEnroll).toHaveBeenCalledWith(null))

    fireEvent.change(screen.getByTestId('EnrollDevice.nickname'), {
      target: { value: '  Work phone ' }
    })
    fireEvent.click(screen.getByTestId('EnrollDevice.submit'))
    await waitFor(() => expect(onEnroll).toHaveBeenLastCalledWith('Work phone'))
  })

  it('renders a used-up link as the screen error rather than a dead end', () => {
    render(
      <EnrollDevice
        onEnroll={vi.fn(async () => {})}
        error="Enrollment link is invalid or expired"
      />
    )
    expect(screen.getByTestId('EnrollDevice.error')).toHaveTextContent(/invalid or expired/i)
  })

  it('offers a way out ONLY when the link itself is definitively dead', () => {
    // A retryable ceremony failure still has a registered credential on this
    // socket worth finishing with — walking away there would abandon it.
    const { unmount } = render(
      <EnrollDevice onEnroll={vi.fn(async () => {})} error="That passkey did not verify" />
    )
    expect(screen.queryByTestId('EnrollDevice.leave')).toBeNull()
    unmount()

    const onLeave = vi.fn()
    render(
      <EnrollDevice
        onEnroll={vi.fn(async () => {})}
        error="Enrollment link is invalid or expired"
        onLeave={onLeave}
      />
    )
    fireEvent.click(screen.getByTestId('EnrollDevice.leave'))
    expect(onLeave).toHaveBeenCalled()
  })

  it('relabels the button as a retry once something has failed', () => {
    render(<EnrollDevice onEnroll={vi.fn(async () => {})} error="That did not verify" />)
    expect(screen.getByTestId('EnrollDevice.submit')).toHaveTextContent('Try again')
  })

  it('holds the button until the link has authenticated the socket', () => {
    // Pressing early would fail with a bare "Not connected", which reads like
    // the link is broken when it is merely early.
    render(<EnrollDevice onEnroll={vi.fn(async () => {})} ready={false} />)
    const button = screen.getByTestId('EnrollDevice.submit')
    expect(button).toBeDisabled()
    expect(button).toHaveTextContent('Connecting…')
  })
})

describe('EnrollPrompt', () => {
  it('is non-blocking and remembers a dismissal per device', () => {
    const onDismiss = vi.fn()
    render(<EnrollPrompt onEnroll={vi.fn(async () => {})} onDismiss={onDismiss} />)
    expect(enrollPromptDismissed()).toBe(false)
    fireEvent.click(screen.getByTestId('EnrollPrompt.dismiss'))
    expect(onDismiss).toHaveBeenCalled()

    dismissEnrollPrompt()
    expect(enrollPromptDismissed()).toBe(true)
  })

  it('turns the `enroll`-capability refusal into desktop guidance, not an error', async () => {
    // The IMPORTANT case: under effective-legacy a password connection holds no
    // `enroll` (stolen-password hardening), so the server says no and the user
    // needs to be told where the first passkey actually comes from.
    const onEnroll = vi.fn(async () => {
      throw new Error(
        'Permission denied: "webauthn:register-options" requires the "enroll" capability'
      )
    })
    render(<EnrollPrompt onEnroll={onEnroll} onDismiss={vi.fn()} />)
    fireEvent.click(screen.getByTestId('EnrollPrompt.enroll'))
    const guidance = await screen.findByTestId('EnrollPrompt.needsDesktop')
    expect(guidance).toHaveTextContent(/first passkey has to be set up from the desktop app/i)
    expect(screen.queryByTestId('EnrollPrompt.error')).toBeNull()
    // The button that cannot work is gone.
    expect(screen.queryByTestId('EnrollPrompt.enroll')).toBeNull()
  })

  it('shows other failures as errors and keeps the offer retryable', async () => {
    const onEnroll = vi.fn(async () => {
      throw new Error('The passkey prompt failed.')
    })
    render(<EnrollPrompt onEnroll={onEnroll} onDismiss={vi.fn()} />)
    fireEvent.click(screen.getByTestId('EnrollPrompt.enroll'))
    expect(await screen.findByTestId('EnrollPrompt.error')).toHaveTextContent(/prompt failed/i)
    expect(screen.getByTestId('EnrollPrompt.enroll')).not.toBeDisabled()
  })

  it('disappears once a passkey is enrolled', async () => {
    render(<EnrollPrompt onEnroll={vi.fn(async () => {})} onDismiss={vi.fn()} />)
    fireEvent.click(screen.getByTestId('EnrollPrompt.enroll'))
    await waitFor(() => expect(screen.queryByTestId('EnrollPrompt')).toBeNull())
  })
})

describe('NoAuthBanner', () => {
  it('is prominent and has no way to dismiss it (security.md hard requirement)', () => {
    render(<NoAuthBanner />)
    const banner = screen.getByTestId('NoAuthBanner')
    expect(banner).toHaveAttribute('role', 'alert')
    expect(banner).toHaveTextContent(/Remote authentication is OFF/i)
    expect(banner).toHaveTextContent(/full control of the desktop/i)
    // "Persistent … for as long as the mode is active" — a close button would
    // make the warning last exactly one click.
    expect(banner.querySelector('button')).toBeNull()
  })
})

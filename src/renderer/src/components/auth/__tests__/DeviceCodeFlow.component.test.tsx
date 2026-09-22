/**
 * The device-code panel (ADR-068 §3, Slice 7) on its own.
 *
 * `SignInDialog.component.test.tsx` pins WHEN this panel is chosen; this file
 * pins what it renders once it is: the link, the code, Copy, the expiry line and
 * the two exits. The interesting cases are the degraded ones — the host has not
 * answered yet, and a browser with no `navigator.clipboard` (every LAN client on
 * plain http), where the code must stay readable rather than the panel breaking.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DeviceCodeFlow, minutesUntil } from '../DeviceCodeFlow'

afterEach(cleanup)

const URL_ = 'https://auth.openai.com/codex/device'

describe('minutesUntil', () => {
  it('rounds to the nearest minute, floors at zero, and stays undefined before the host answers', () => {
    expect(minutesUntil(60_000, 0)).toBe(1)
    // A fifteen-minute code read "16 min" the moment it arrived under the old
    // ceiling, because the browser clock trailed the host by seconds.
    expect(minutesUntil(15 * 60_000 + 2_000, 0)).toBe(15)
    expect(minutesUntil(61_000, 0)).toBe(1)
    expect(minutesUntil(60_001, 60_000)).toBe(0)
    expect(minutesUntil(undefined, 0)).toBeUndefined()
    // A non-positive expiry is an ABSENT one, not an expired one: `0` is what a
    // host that reports no deadline sends, and treating it as a wall-clock
    // instant rendered "expires in 0 min" on a code that had just been issued.
    expect(minutesUntil(0, 60_000)).toBeUndefined()
    expect(minutesUntil(-1, 0)).toBeUndefined()
  })
})

describe('DeviceCodeFlow', () => {
  it('renders the link, the code, the wait with its expiry, and both exits', () => {
    render(
      <DeviceCodeFlow
        id="chatgpt"
        verificationUrl={URL_}
        userCode="ABCD-1234"
        expiresAt={Date.now() + 15 * 60_000}
        onCancel={vi.fn()}
        onPasteInstead={vi.fn()}
      />
    )
    const link = screen.getByTestId('DeviceCodeFlow.url')
    expect(link).toHaveAttribute('href', URL_)
    expect(link).toHaveAttribute('target', '_blank')
    // The vendor page has no business holding a handle on this one.
    expect(link.getAttribute('rel')).toContain('noopener')
    expect(screen.getByTestId('DeviceCodeFlow.code')).toHaveTextContent('ABCD-1234')
    // ADR-070 §5 rule 4: the expiry joined the waiting line instead of being a
    // sentence of its own. It is still there — a code with no expiry is a code
    // the user retypes forever.
    expect(screen.getByTestId('DeviceCodeFlow.waiting')).toHaveTextContent(
      'Waiting · expires in 15 min'
    )
    // The step captions are gone; one verb per row is the instruction.
    const panel = screen.getByTestId('DeviceCodeFlow')
    expect(panel).toHaveTextContent('OPEN')
    expect(panel).toHaveTextContent('ENTER')
    expect(panel).not.toHaveTextContent('Open this link on any device')
    expect(panel).not.toHaveTextContent('anything with a browser')
    expect(screen.getByTestId('DeviceCodeFlow.cancel')).toBeTruthy()
    expect(screen.getByTestId('DeviceCodeFlow.pasteInstead')).toBeTruthy()
    expect(screen.getByTestId('DeviceCodeFlow')).toHaveAttribute('data-id', 'chatgpt')
  })

  it('before the host answers: no link, a placeholder code, and Copy is disabled', () => {
    render(<DeviceCodeFlow busy onCancel={vi.fn()} onPasteInstead={vi.fn()} />)
    expect(screen.queryByTestId('DeviceCodeFlow.url')).toBeNull()
    expect(screen.getByTestId('DeviceCodeFlow.copy')).toBeDisabled()
    // The escape hatch locks too: it cancels the flow this start has not
    // registered yet, so a click here would leave a live device flow behind.
    expect(screen.getByTestId('DeviceCodeFlow.pasteInstead')).toBeDisabled()
    expect(screen.getByTestId('DeviceCodeFlow')).toHaveAttribute('data-ready', 'false')
    // The expiry is omitted rather than guessed at.
    expect(screen.getByTestId('DeviceCodeFlow.waiting').textContent).not.toContain('expires')
    expect(screen.getByTestId('DeviceCodeFlow.waiting').textContent).toBe('Waiting')
  })

  it('Copy writes the code and says so, without a token ever being involved', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText },
      configurable: true
    })
    render(<DeviceCodeFlow userCode="ABCD-1234" onCancel={vi.fn()} onPasteInstead={vi.fn()} />)
    fireEvent.click(screen.getByTestId('DeviceCodeFlow.copy'))
    expect(writeText).toHaveBeenCalledWith('ABCD-1234')
    await vi.waitFor(() =>
      expect(screen.getByTestId('DeviceCodeFlow.copy')).toHaveTextContent('Copied')
    )
  })

  it('survives a browser with no clipboard API — the code stays on screen to read out', () => {
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: undefined,
      configurable: true
    })
    render(<DeviceCodeFlow userCode="ABCD-1234" onCancel={vi.fn()} onPasteInstead={vi.fn()} />)
    expect(() => fireEvent.click(screen.getByTestId('DeviceCodeFlow.copy'))).not.toThrow()
    expect(screen.getByTestId('DeviceCodeFlow.code')).toHaveTextContent('ABCD-1234')
  })

  it('a host that reports no deadline gets no expiry line', () => {
    // `expiresAt: 0` is the shape the device-code start sends when it has no
    // deadline to report; keyed on `!== undefined`, it rendered as a wall-clock
    // instant in 1970 and the line read "expires in 0 min".
    render(
      <DeviceCodeFlow userCode="AB-12" expiresAt={0} onCancel={vi.fn()} onPasteInstead={vi.fn()} />
    )
    expect(screen.getByTestId('DeviceCodeFlow.waiting').textContent).toBe('Waiting')
  })

  it('the Copied timer is cleared when the panel unmounts', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText },
      configurable: true
    })
    const setSpy = vi.spyOn(globalThis, 'setTimeout')
    const { unmount } = render(
      <DeviceCodeFlow userCode="AB-12" onCancel={vi.fn()} onPasteInstead={vi.fn()} />
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('DeviceCodeFlow.copy'))
    })
    expect(screen.getByTestId('DeviceCodeFlow.copy')).toHaveTextContent('Copied')

    // The reset is scheduled on a promise continuation, so it outlives a panel
    // the user closed a moment after copying — and nothing was cancelling it.
    const index = setSpy.mock.calls.findIndex(([, ms]) => ms === 1500)
    expect(index).toBeGreaterThanOrEqual(0)
    const timer = setSpy.mock.results[index]?.value
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
    unmount()
    expect(clearSpy).toHaveBeenCalledWith(timer)
    setSpy.mockRestore()
    clearSpy.mockRestore()
  })

  it('the two exits call their handlers', () => {
    const onCancel = vi.fn()
    const onPasteInstead = vi.fn()
    render(<DeviceCodeFlow userCode="AB-12" onCancel={onCancel} onPasteInstead={onPasteInstead} />)
    // ADR-030's escape hatch keeps its handler under a shorter label.
    expect(screen.getByTestId('DeviceCodeFlow.pasteInstead')).toHaveTextContent(
      'Paste a URL instead'
    )
    fireEvent.click(screen.getByTestId('DeviceCodeFlow.cancel'))
    fireEvent.click(screen.getByTestId('DeviceCodeFlow.pasteInstead'))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onPasteInstead).toHaveBeenCalledTimes(1)
  })
})

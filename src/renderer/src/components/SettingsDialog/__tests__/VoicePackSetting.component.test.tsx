/**
 * Settings › Voice input › the on-device speech model and the live preview
 * (ADR-101 §6, §7): the state the row shows for each pack status, the button
 * each state offers, the two-click Remove, the refusal a remote client without
 * `admin` meets, and the per-client preview toggle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { VoicePackSetting, VoicePreviewSetting, VOICE_PREVIEW_HELP_TEXT } from '../VoicePackSetting'
import {
  applyVoicePackStatus,
  resetVoicePackStoreForTests
} from '../../../lib/voice/voice-pack-store'
import { CANCEL_GUARD_MS } from '../../../lib/voice/use-cancel-guard'
import { LIVE_PREVIEW_KEY, readLivePreview } from '../../../lib/voice/preview-preference'
import type { VoicePackState, VoicePackStatus } from '../../../../../shared/voice-pack'

const status = (state: VoicePackState, over: Partial<VoicePackStatus> = {}): VoicePackStatus => ({
  state,
  packId: 'parakeet-tdt-0.6b-v2-int8',
  label: 'Parakeet TDT 0.6B v2 (English)',
  approxBytes: 700_000_000,
  ...over
})

type Api = {
  voicePackStatus: ReturnType<typeof vi.fn>
  voicePackInstall: ReturnType<typeof vi.fn>
  voicePackInstallCancel: ReturnType<typeof vi.fn>
  voicePackRemove: ReturnType<typeof vi.fn>
}
let api: Api
/** What the host answers to `voice:pack-status` (the post-command re-read). */
let host: VoicePackStatus

beforeEach(() => {
  resetVoicePackStoreForTests()
  localStorage.clear()
  host = status('missing')
  api = {
    voicePackStatus: vi.fn(async () => host),
    voicePackInstall: vi.fn(async () => ({ status: 'installed' })),
    voicePackInstallCancel: vi.fn(async () => ({ status: 'cancelled' })),
    voicePackRemove: vi.fn(async () => ({ status: 'removed' }))
  }
  ;(window as unknown as { api: Api }).api = api
})
afterEach(() => {
  cleanup()
  resetVoicePackStoreForTests()
})

const state = (): HTMLElement => screen.getByTestId('VoicePackSetting.state')

/** The Cancel that replaces Install ignores a press for its first half second. */
async function pastCancelGuard(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, CANCEL_GUARD_MS + 20))
  })
}

async function renderRow(initial: VoicePackStatus): Promise<void> {
  host = initial
  render(<VoicePackSetting />)
  // The row reads the status when it mounts.
  await waitFor(() => expect(api.voicePackStatus).toHaveBeenCalled())
  await waitFor(() => expect(state()).not.toHaveTextContent('Checking'))
}

describe('VoicePackSetting — what each state shows', () => {
  it('missing: the size and an Install button', async () => {
    await renderRow(status('missing'))
    expect(screen.getByTestId('VoicePackSetting')).toBeInTheDocument()
    expect(screen.getByText('On-device speech model')).toBeInTheDocument()
    expect(state()).toHaveTextContent('Not installed (~700 MB)')
    expect(screen.getByTestId('VoicePackSetting.install')).toHaveTextContent('Install')
    expect(screen.queryByTestId('VoicePackSetting.cancel')).toBeNull()
    expect(screen.queryByTestId('VoicePackSetting.remove')).toBeNull()
  })

  it('shows the pack label in the description', async () => {
    await renderRow(status('missing'))
    expect(screen.getByTestId('VoicePackSetting')).toHaveTextContent(
      'Parakeet TDT 0.6B v2 (English)'
    )
  })

  it('installing: the percentage and a Cancel button, live from the replicated event', async () => {
    await renderRow(status('missing'))
    act(() =>
      applyVoicePackStatus(
        status('installing', { progress: { receivedBytes: 294_000_000, totalBytes: 700_000_000 } })
      )
    )
    expect(state()).toHaveTextContent('Downloading 42%')
    expect(state()).toHaveAttribute('data-state', 'installing')
    expect(screen.getByTestId('VoicePackSetting.cancel')).toBeInTheDocument()
    expect(screen.queryByTestId('VoicePackSetting.install')).toBeNull()
  })

  it('installing with no size yet: no percentage', async () => {
    await renderRow(status('installing'))
    expect(state()).toHaveTextContent(/^Downloading…$/)
  })

  it('ready: Installed and a Remove button', async () => {
    await renderRow(status('ready'))
    expect(state()).toHaveTextContent('Installed')
    expect(screen.getByTestId('VoicePackSetting.remove')).toHaveTextContent('Remove')
    expect(screen.queryByTestId('VoicePackSetting.install')).toBeNull()
  })

  it('unsupported: says so and offers nothing', async () => {
    await renderRow(status('unsupported'))
    expect(state()).toHaveTextContent('Not available on this host')
    for (const part of ['install', 'cancel', 'remove']) {
      expect(screen.queryByTestId(`VoicePackSetting.${part}`)).toBeNull()
    }
  })

  it('failed: the host error, and Retry', async () => {
    await renderRow(status('failed', { error: 'Hugging Face answered 503' }))
    expect(state()).toHaveTextContent('Failed: Hugging Face answered 503')
    expect(screen.getByTestId('VoicePackSetting.install')).toHaveTextContent('Retry')
  })
})

describe('VoicePackSetting — the buttons', () => {
  it('Install calls the install command, and the row follows the host to Installed', async () => {
    await renderRow(status('missing'))
    host = status('ready')
    fireEvent.click(screen.getByTestId('VoicePackSetting.install'))
    expect(api.voicePackInstall).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(state()).toHaveTextContent('Installed'))
  })

  it('right after the press the row already reads as downloading, with a Cancel', async () => {
    await renderRow(status('missing'))
    api.voicePackInstall.mockImplementation(() => new Promise(() => {}))
    fireEvent.click(screen.getByTestId('VoicePackSetting.install'))
    await waitFor(() => expect(state()).toHaveAttribute('data-state', 'installing'))
    expect(screen.getByTestId('VoicePackSetting.cancel')).toBeInTheDocument()
  })

  it('Cancel calls the cancel command', async () => {
    await renderRow(status('installing'))
    await pastCancelGuard()
    fireEvent.click(screen.getByTestId('VoicePackSetting.cancel'))
    expect(api.voicePackInstallCancel).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(api.voicePackStatus).toHaveBeenCalledTimes(2))
  })

  it('a double click on Install does not cancel the download it just started', async () => {
    await renderRow(status('missing'))
    api.voicePackInstall.mockImplementation(() => new Promise(() => {}))
    const install = screen.getByTestId('VoicePackSetting.install')
    install.focus()
    fireEvent.click(install)
    const cancel = await screen.findByTestId('VoicePackSetting.cancel')
    // A new element: focus (and a held Enter) did not follow to it.
    expect(cancel).not.toBe(install)
    expect(document.activeElement).not.toBe(cancel)

    fireEvent.click(cancel)
    expect(api.voicePackInstallCancel).not.toHaveBeenCalled()

    await pastCancelGuard()
    fireEvent.click(screen.getByTestId('VoicePackSetting.cancel'))
    expect(api.voicePackInstallCancel).toHaveBeenCalledTimes(1)
  })

  it('Remove asks twice, like the other destructive buttons: nothing is deleted on the first press', async () => {
    await renderRow(status('ready'))
    const remove = screen.getByTestId('VoicePackSetting.remove')
    fireEvent.click(remove)
    expect(remove).toHaveTextContent('Confirm remove?')
    expect(api.voicePackRemove).not.toHaveBeenCalled()

    host = status('missing')
    fireEvent.click(remove)
    expect(api.voicePackRemove).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(state()).toHaveTextContent('Not installed (~700 MB)'))
  })

  it('an armed Remove disarms when the pack is no longer installed', async () => {
    await renderRow(status('ready'))
    fireEvent.click(screen.getByTestId('VoicePackSetting.remove'))
    act(() => applyVoicePackStatus(status('missing')))
    host = status('ready')
    act(() => applyVoicePackStatus(status('ready')))
    expect(screen.getByTestId('VoicePackSetting.remove')).toHaveTextContent(/^Remove$/)
  })

  it('a remote client without admin: after the first refusal the row is read-only with one line', async () => {
    await renderRow(status('missing'))
    api.voicePackInstall.mockRejectedValue(
      new Error('Permission denied: "voice:pack-install" requires the "admin" capability')
    )
    fireEvent.click(screen.getByTestId('VoicePackSetting.install'))
    expect(await screen.findByTestId('VoicePackSetting.denied')).toHaveTextContent(
      'Managing the speech model needs admin access on this host'
    )
    // No buttons that would only fail the same way; the state is still shown.
    for (const part of ['install', 'cancel', 'remove']) {
      expect(screen.queryByTestId(`VoicePackSetting.${part}`)).toBeNull()
    }
    expect(state()).toHaveTextContent('Not installed (~700 MB)')
    expect(screen.queryByTestId('VoicePackSetting.error')).toBeNull()
  })

  it('the read-only line outlives the host’s progress ticks and state changes', async () => {
    await renderRow(status('installing'))
    await pastCancelGuard()
    api.voicePackInstallCancel.mockRejectedValue(
      new Error('Permission denied: "voice:pack-install-cancel" requires the "admin" capability')
    )
    fireEvent.click(screen.getByTestId('VoicePackSetting.cancel'))
    await screen.findByTestId('VoicePackSetting.denied')
    for (let received = 1; received < 8; received++) {
      act(() =>
        applyVoicePackStatus(
          status('installing', { progress: { receivedBytes: received, totalBytes: 100 } })
        )
      )
    }
    expect(screen.getByTestId('VoicePackSetting.denied')).toBeInTheDocument()
    act(() => applyVoicePackStatus(status('ready')))
    expect(screen.getByTestId('VoicePackSetting.denied')).toBeInTheDocument()
    expect(screen.queryByTestId('VoicePackSetting.remove')).toBeNull()
  })

  it('a command failure stays under the row through progress ticks, until the state changes', async () => {
    await renderRow(status('installing'))
    await pastCancelGuard()
    api.voicePackInstallCancel.mockRejectedValue(new Error('the host went away'))
    host = status('installing', { progress: { receivedBytes: 1, totalBytes: 100 } })
    fireEvent.click(screen.getByTestId('VoicePackSetting.cancel'))
    expect(await screen.findByTestId('VoicePackSetting.error')).toHaveTextContent(
      'the host went away'
    )
    await waitFor(() => expect(api.voicePackStatus).toHaveBeenCalledTimes(2))
    for (let received = 2; received < 8; received++) {
      act(() =>
        applyVoicePackStatus(
          status('installing', { progress: { receivedBytes: received, totalBytes: 100 } })
        )
      )
    }
    expect(screen.getByTestId('VoicePackSetting.error')).toBeInTheDocument()
    act(() => applyVoicePackStatus(status('failed', { error: 'x' })))
    expect(screen.queryByTestId('VoicePackSetting.error')).toBeNull()
  })

  it('a first read that fails shows “Status unavailable” with a Retry, not “Checking…” for ever', async () => {
    api.voicePackStatus.mockRejectedValueOnce(new Error('No handler registered'))
    render(<VoicePackSetting />)
    await waitFor(() => expect(state()).toHaveTextContent('Status unavailable'))
    host = status('ready')
    fireEvent.click(screen.getByTestId('VoicePackSetting.retry'))
    await waitFor(() => expect(state()).toHaveTextContent('Installed'))
    expect(screen.queryByTestId('VoicePackSetting.retry')).toBeNull()
  })

  it('the web transport’s timeout on install is not shown as a failure; the host’s progress is', async () => {
    await renderRow(status('missing'))
    host = status('installing', { progress: { receivedBytes: 10, totalBytes: 100 } })
    api.voicePackInstall.mockRejectedValue(new Error('Timeout: voice:pack-install'))
    fireEvent.click(screen.getByTestId('VoicePackSetting.install'))
    await waitFor(() => expect(state()).toHaveTextContent('Downloading 10%'))
    expect(screen.queryByTestId('VoicePackSetting.error')).toBeNull()
  })
})

describe('VoicePreviewSetting', () => {
  it('is on by default, with the help text and the this-device badge', () => {
    render(<VoicePreviewSetting enabled />)
    expect(screen.getByTestId('VoicePreviewSetting')).toBeInTheDocument()
    expect(screen.getByTestId('VoicePreviewSetting.toggle')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('Live preview while speaking')).toBeInTheDocument()
    expect(screen.getByTestId('VoicePreviewSetting')).toHaveTextContent(VOICE_PREVIEW_HELP_TEXT)
    expect(screen.getByTestId('VoicePreviewSetting')).toHaveTextContent('this device')
    expect(VOICE_PREVIEW_HELP_TEXT).toBe(
      'Shows words as you speak for opencode and pi sessions; the final text arrives when you let go'
    )
  })

  it('toggling saves it for THIS client (localStorage), and reads the saved value back', () => {
    const view = render(<VoicePreviewSetting enabled />)
    fireEvent.click(screen.getByTestId('VoicePreviewSetting.toggle'))
    expect(screen.getByTestId('VoicePreviewSetting.toggle')).toHaveAttribute(
      'aria-pressed',
      'false'
    )
    expect(localStorage.getItem(LIVE_PREVIEW_KEY)).toBe('false')
    expect(readLivePreview()).toBe(false)

    view.unmount()
    render(<VoicePreviewSetting enabled />)
    expect(screen.getByTestId('VoicePreviewSetting.toggle')).toHaveAttribute(
      'aria-pressed',
      'false'
    )

    fireEvent.click(screen.getByTestId('VoicePreviewSetting.toggle'))
    expect(readLivePreview()).toBe(true)
  })

  it('is disabled and dimmed while voice input is off', () => {
    render(<VoicePreviewSetting enabled={false} />)
    const toggle = screen.getByTestId('VoicePreviewSetting.toggle')
    expect(toggle).toBeDisabled()
    fireEvent.click(toggle)
    expect(localStorage.getItem(LIVE_PREVIEW_KEY)).toBeNull()
  })
})

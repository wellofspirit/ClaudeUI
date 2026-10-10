/**
 * Settings › Voice input › Microphone — the picker and the test meter, over a
 * fake `mediaDevices` (no real microphone anywhere) and fake Web Audio.
 *
 * Pinned: the list (system default with its current name, each input, a
 * remembered device that is absent shown disabled), the not-connected line, the
 * permission action, following `devicechange`, the test meter's level/status
 * and its stops (button, unmount, blur) — and that it NEVER reaches the voice
 * transport.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MicrophoneSetting, MIC_ALLOW_LIST_TEXT, MIC_TEST_IDLE_TEXT } from '../MicrophoneSetting'
import type { CaptureEnv } from '../../../lib/voice/browser-voice-capture'
import { readMicPreference, writeMicPreference } from '../../../lib/voice/mic-preference'

interface FakeDevice {
  deviceId: string
  label: string
  groupId: string
}

const MAC: FakeDevice = { deviceId: 'mac', label: 'MacBook Pro Microphone', groupId: 'g-mac' }
const PODS: FakeDevice = { deviceId: 'pods', label: 'AirPods Pro', groupId: 'g-pods' }
const JABRA: FakeDevice = { deviceId: 'jabra', label: 'Jabra Evolve2 65', groupId: 'g-jabra' }

let ports: Array<{ onmessage: ((e: { data: unknown }) => void) | null }> = []
let openTracks: Array<{ stop: ReturnType<typeof vi.fn>; label: string }> = []

class FakeNode {
  connect = vi.fn()
  disconnect = vi.fn()
  gain = { value: 1 }
  port = {
    onmessage: null as ((e: { data: unknown }) => void) | null,
    postMessage: (message: unknown) => {
      if (message === 'flush') queueMicrotask(() => this.port.onmessage?.({ data: 'flushed' }))
    }
  }
}
class FakeContext {
  sampleRate = 16000
  state = 'running'
  destination = new FakeNode()
  audioWorklet = { addModule: async () => {} }
  createMediaStreamSource = (): FakeNode => new FakeNode()
  createGain = (): FakeNode => new FakeNode()
  close = async (): Promise<void> => {}
}
class FakeWorklet extends FakeNode {
  constructor() {
    super()
    ports.push(this.port)
  }
}

function world(initial: FakeDevice[], defaultId: string, opts: { hidden?: boolean } = {}) {
  let devices = initial
  let defaultDevice = defaultId
  let hidden = opts.hidden ?? false
  const listeners = new Set<() => void>()
  const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
    const audio = constraints.audio as MediaTrackConstraints | boolean
    const exact =
      typeof audio === 'object'
        ? (audio.deviceId as { exact?: string } | undefined)?.exact
        : undefined
    const device = devices.find((d) => d.deviceId === (exact ?? defaultDevice))!
    // Granting access unlocks the names, as in a real browser.
    hidden = false
    const track = Object.assign(new EventTarget(), {
      stop: vi.fn(),
      label: device.label,
      getSettings: () => ({ deviceId: device.deviceId, groupId: device.groupId })
    })
    openTracks.push(track)
    return { getTracks: () => [track] } as unknown as MediaStream
  })
  const env: CaptureEnv = {
    isSecureContext: true,
    mediaDevices: {
      getUserMedia,
      enumerateDevices: async () => {
        const def = devices.find((d) => d.deviceId === defaultDevice)
        const list = [
          ...(def ? [{ ...def, deviceId: 'default', label: `Default - ${def.label}` }] : []),
          ...devices
        ].map((d) => ({
          kind: 'audioinput',
          deviceId: hidden ? '' : d.deviceId,
          label: hidden ? '' : d.label,
          groupId: hidden ? '' : d.groupId
        }))
        return list as unknown as MediaDeviceInfo[]
      },
      addEventListener: (_t: 'devicechange', l: () => void) => listeners.add(l),
      removeEventListener: (_t: 'devicechange', l: () => void) => listeners.delete(l)
    },
    AudioContextCtor: FakeContext as unknown as typeof AudioContext,
    AudioWorkletNodeCtor: FakeWorklet as unknown as typeof AudioWorkletNode
  }
  return {
    env,
    getUserMedia,
    listeners,
    change(next: { devices?: FakeDevice[]; defaultId?: string }): void {
      if (next.devices) devices = next.devices
      if (next.defaultId) defaultDevice = next.defaultId
      for (const l of [...listeners]) l()
    }
  }
}

/** One worklet block at a constant sample value, as the audio thread posts it. */
function block(samples: number, value: number): void {
  act(() => {
    ports.at(-1)?.onmessage?.({ data: new Float32Array(samples).fill(value) })
  })
}

const transport = {
  voiceStart: vi.fn(),
  voiceAudio: vi.fn(),
  voiceStop: vi.fn()
}
const originalWidth = window.innerWidth

beforeEach(() => {
  ports = []
  openTracks = []
  localStorage.clear()
  for (const fn of Object.values(transport)) fn.mockClear()
  ;(window as unknown as { api: unknown }).api = { platform: 'darwin', ...transport }
})
afterEach(() => {
  cleanup()
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth })
})

const optionIds = (): string[] =>
  screen.getAllByTestId('MicrophoneSetting.select.option').map((o) => o.getAttribute('data-id')!)

async function openSelect(): Promise<void> {
  fireEvent.click(await screen.findByTestId('MicrophoneSetting.select.trigger'))
}

describe('MicrophoneSetting — the picker (desktop)', () => {
  it('lists the system default by its current name, then every input', async () => {
    const w = world([MAC, PODS], 'mac')
    render(<MicrophoneSetting enabled env={w.env} />)
    await waitFor(() =>
      expect(screen.getByTestId('MicrophoneSetting.select.trigger')).toHaveTextContent(
        'System default — MacBook Pro Microphone'
      )
    )
    await openSelect()
    expect(optionIds()).toEqual(['default', 'mac', 'pods'])
    expect(screen.getByTestId('MicrophoneSetting.badge')).toHaveTextContent('this device')
  })

  it('choosing a microphone remembers it on this device; System default forgets it', async () => {
    const w = world([MAC, PODS], 'mac')
    render(<MicrophoneSetting enabled env={w.env} />)
    await openSelect()
    await waitFor(() => expect(optionIds()).toContain('pods'))
    fireEvent.click(
      screen
        .getAllByTestId('MicrophoneSetting.select.option')
        .find((o) => o.getAttribute('data-id') === 'pods')!
    )
    expect(readMicPreference()).toEqual({ deviceId: 'pods', label: 'AirPods Pro' })
    expect(screen.getByTestId('MicrophoneSetting.select.trigger')).toHaveTextContent('AirPods Pro')

    await openSelect()
    fireEvent.click(
      screen
        .getAllByTestId('MicrophoneSetting.select.option')
        .find((o) => o.getAttribute('data-id') === 'default')!
    )
    expect(readMicPreference()).toBeNull()
  })

  it('a remembered microphone that is absent shows disabled, with the not-connected line', async () => {
    writeMicPreference({ deviceId: 'sony', label: 'Sony WH-1000XM5' })
    const w = world([MAC, PODS], 'mac')
    render(<MicrophoneSetting enabled env={w.env} />)
    await waitFor(() =>
      expect(screen.getByTestId('MicrophoneSetting.notConnected')).toHaveTextContent(
        'Not connected now — using MacBook Pro Microphone'
      )
    )
    expect(screen.getByTestId('MicrophoneSetting.select.trigger')).toHaveTextContent(
      'Sony WH-1000XM5 · not connected'
    )
    await openSelect()
    const missing = screen
      .getAllByTestId('MicrophoneSetting.select.option')
      .find((o) => o.getAttribute('data-id') === '__not-connected__')!
    expect(missing).toBeDisabled()
  })

  it('no not-connected line while the remembered microphone is there', async () => {
    writeMicPreference({ deviceId: 'pods', label: 'AirPods Pro' })
    const w = world([MAC, PODS], 'mac')
    render(<MicrophoneSetting enabled env={w.env} />)
    await waitFor(() =>
      expect(screen.getByTestId('MicrophoneSetting.select.trigger')).toHaveTextContent(
        'AirPods Pro'
      )
    )
    expect(screen.queryByTestId('MicrophoneSetting.notConnected')).toBeNull()
  })

  it('without permission, offers to unlock the names — opening and closing a stream at once', async () => {
    const w = world([MAC, PODS], 'mac', { hidden: true })
    render(<MicrophoneSetting enabled env={w.env} />)
    const allow = await screen.findByTestId('MicrophoneSetting.allowAccess')
    expect(allow).toHaveTextContent(MIC_ALLOW_LIST_TEXT)
    // Nothing was opened just by showing the page.
    expect(w.getUserMedia).not.toHaveBeenCalled()

    fireEvent.click(allow)
    await waitFor(() => expect(screen.queryByTestId('MicrophoneSetting.allowAccess')).toBeNull())
    expect(w.getUserMedia).toHaveBeenCalledWith({ audio: true })
    expect(openTracks[0].stop).toHaveBeenCalled()
    await openSelect()
    expect(optionIds()).toEqual(['default', 'mac', 'pods'])
  })

  it('follows devicechange while open — the list and the default’s name', async () => {
    const w = world([MAC], 'mac')
    render(<MicrophoneSetting enabled env={w.env} />)
    await waitFor(() =>
      expect(screen.getByTestId('MicrophoneSetting.select.trigger')).toHaveTextContent(
        'MacBook Pro Microphone'
      )
    )
    act(() => w.change({ devices: [MAC, JABRA], defaultId: 'jabra' }))
    await waitFor(() =>
      expect(screen.getByTestId('MicrophoneSetting.select.trigger')).toHaveTextContent(
        'System default — Jabra Evolve2 65'
      )
    )
    await openSelect()
    expect(optionIds()).toEqual(['default', 'mac', 'jabra'])
  })

  it('stops listening for device changes when it goes away', async () => {
    const w = world([MAC], 'mac')
    const { unmount } = render(<MicrophoneSetting enabled env={w.env} />)
    await waitFor(() => expect(w.listeners.size).toBe(1))
    unmount()
    expect(w.listeners.size).toBe(0)
  })

  it('is disabled while voice input is off', async () => {
    const w = world([MAC], 'mac')
    render(<MicrophoneSetting enabled={false} env={w.env} />)
    expect(await screen.findByTestId('MicrophoneSetting.select.trigger')).toBeDisabled()
    expect(screen.getByTestId('MicrophoneSetting.test')).toBeDisabled()
  })
})

describe('MicrophoneSetting — the test meter', () => {
  async function startTest(w: ReturnType<typeof world>): Promise<void> {
    render(<MicrophoneSetting enabled env={w.env} />)
    const button = await screen.findByTestId('MicrophoneSetting.test')
    expect(button).toHaveTextContent('Test mic')
    expect(screen.getByTestId('MicrophoneSetting.status')).toHaveTextContent(MIC_TEST_IDLE_TEXT)
    await act(async () => {
      fireEvent.click(button)
    })
    await waitFor(() => expect(ports).toHaveLength(1))
  }

  it('shows the level and who it hears — and never touches the voice transport', async () => {
    writeMicPreference({ deviceId: 'pods', label: 'AirPods Pro' })
    const w = world([MAC, PODS], 'mac')
    await startTest(w)
    // It tests the CHOSEN microphone.
    expect(w.getUserMedia.mock.calls[0][0]).toMatchObject({
      audio: { deviceId: { exact: 'pods' } }
    })
    expect(screen.getByTestId('MicrophoneSetting.test')).toHaveTextContent('Stop')

    block(1600, 2000 / 32767)
    expect(screen.getByTestId('MicrophoneSetting.level').style.width).toBe('100%')
    expect(screen.getByTestId('MicrophoneSetting.status')).toHaveTextContent(
      'Hearing you on AirPods Pro.'
    )
    expect(transport.voiceStart).not.toHaveBeenCalled()
    expect(transport.voiceAudio).not.toHaveBeenCalled()
    expect(transport.voiceStop).not.toHaveBeenCalled()
  })

  it('says so when the microphone sends pure silence', async () => {
    const w = world([MAC], 'mac')
    await startTest(w)
    block(24000, 0)
    expect(screen.getByTestId('MicrophoneSetting.status')).toHaveTextContent(
      'No signal from MacBook Pro Microphone — lid closed or muted?'
    )
    expect(screen.getByTestId('MicrophoneSetting.status')).toHaveAttribute('data-kind', 'silent')
  })

  it('Stop closes the microphone and resets the meter', async () => {
    const w = world([MAC], 'mac')
    await startTest(w)
    block(1600, 0.5)
    await act(async () => {
      fireEvent.click(screen.getByTestId('MicrophoneSetting.test'))
    })
    await waitFor(() => expect(openTracks[0].stop).toHaveBeenCalled())
    expect(screen.getByTestId('MicrophoneSetting.level').style.width).toBe('0%')
    expect(screen.getByTestId('MicrophoneSetting.status')).toHaveTextContent(MIC_TEST_IDLE_TEXT)
  })

  it('closes the microphone on unmount', async () => {
    const w = world([MAC], 'mac')
    await startTest(w)
    cleanup()
    await waitFor(() => expect(openTracks[0].stop).toHaveBeenCalled())
  })

  it('closes the microphone when the window loses focus', async () => {
    const w = world([MAC], 'mac')
    await startTest(w)
    act(() => {
      window.dispatchEvent(new Event('blur'))
    })
    await waitFor(() => expect(openTracks[0].stop).toHaveBeenCalled())
    expect(screen.getByTestId('MicrophoneSetting.test')).toHaveTextContent('Test mic')
  })
})

describe('MicrophoneSetting — phone layout (mockup 1b412724)', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 })
  })

  it('a list of rows with a check, not a select', async () => {
    writeMicPreference({ deviceId: 'galaxy', label: 'Galaxy Buds' })
    const w = world([MAC, PODS], 'mac')
    render(<MicrophoneSetting enabled env={w.env} />)
    await waitFor(() => expect(screen.getAllByTestId('MicrophoneSetting.option')).toHaveLength(4))
    expect(screen.queryByTestId('MicrophoneSetting.select')).toBeNull()
    const rows = screen.getAllByTestId('MicrophoneSetting.option')
    expect(rows.map((r) => r.textContent)).toEqual([
      'System default — MacBook Pro Microphone',
      'MacBook Pro Microphone',
      'AirPods Pro',
      'Galaxy Buds · not connected'
    ])
    expect(rows[3]).toBeDisabled()

    fireEvent.click(rows[2])
    expect(readMicPreference()).toEqual({ deviceId: 'pods', label: 'AirPods Pro' })
    await waitFor(() =>
      expect(
        screen
          .getAllByTestId('MicrophoneSetting.option')
          .find((r) => r.getAttribute('data-id') === 'pods')
      ).toHaveAttribute('aria-checked', 'true')
    )
    expect(screen.getByTestId('MicrophoneSetting.meter')).toBeInTheDocument()
  })
})

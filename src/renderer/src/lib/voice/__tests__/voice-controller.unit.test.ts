/**
 * Layer 1 tests for the voice controller — the sequencing between the client's
 * one capture and the voice transport (IPC on the desktop, the WebSocket on the
 * web client).
 *
 * The capture is the REAL `BrowserVoiceCapture`, over environment doubles (no
 * audio in jsdom — see browser-voice-capture.unit.test.ts); the transport is a
 * recorder. Every step lands in one ordered log, so each test reads as the
 * sequence it pins.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  createVoiceController,
  VOICE_OWNERSHIP_WINDOW_MS,
  type VoiceTransport
} from '../voice-controller'
import {
  MIC_DENIED_MACOS_MESSAGE,
  MIC_DISCONNECTED_MESSAGE,
  MIC_MUTED_MESSAGE,
  MIC_MUTE_GRACE_MS,
  SILENCE_WARNING_MS,
  type CaptureEnv,
  type CaptureSilence
} from '../browser-voice-capture'

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

let log: string[] = []
/** Every track the fake microphone handed out, to dispatch `ended`/`mute` on. */
let liveTracks: EventTarget[] = []
let workletPort: { onmessage: ((event: { data: Float32Array }) => void) | null } | null = null

class FakeNode {
  connect = vi.fn()
  disconnect = vi.fn()
  gain = { value: 1 }
  port = { onmessage: null as ((event: { data: Float32Array }) => void) | null }
}

class FakeContext {
  sampleRate = 16000
  destination = new FakeNode()
  audioWorklet = { addModule: vi.fn(async () => {}) }
  createMediaStreamSource(): FakeNode {
    return new FakeNode()
  }
  createGain(): FakeNode {
    return new FakeNode()
  }
  close = vi.fn(async () => {
    log.push('context:close')
  })
}

class FakeWorkletNode extends FakeNode {
  constructor() {
    super()
    workletPort = this.port
  }
}

function makeEnv(gum?: () => Promise<MediaStream>): CaptureEnv {
  return {
    isSecureContext: true,
    mediaDevices: {
      getUserMedia: vi.fn(
        gum ??
          (async () => {
            log.push('mic:open')
            const track = Object.assign(new EventTarget(), {
              stop: () => log.push('mic:close')
            })
            liveTracks.push(track)
            return { getTracks: () => [track] } as unknown as MediaStream
          })
      )
    },
    AudioContextCtor: FakeContext as unknown as typeof AudioContext,
    AudioWorkletNodeCtor: FakeWorkletNode as unknown as typeof AudioWorkletNode
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void
  let reject!: (e: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** A transport whose start settles when the test says so. */
function makeTransport(startGate: () => Promise<void> = async () => {}): VoiceTransport & {
  start: ReturnType<typeof vi.fn>
  audio: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
} {
  return {
    start: vi.fn(async (routingId: string, language: string) => {
      log.push(`transport:start ${routingId} ${language}`)
      await startGate()
    }),
    audio: vi.fn((routingId: string) => {
      log.push(`transport:audio ${routingId}`)
    }),
    stop: vi.fn(async (routingId: string) => {
      log.push(`transport:stop ${routingId}`)
    })
  }
}

/** One ~100 ms worklet block, as the audio thread would post it. */
function pushBlock(): void {
  workletPort?.onmessage?.({ data: new Float32Array(1600).fill(0.25) })
}

beforeEach(() => {
  log = []
  liveTracks = []
  workletPort = null
})

// ---------------------------------------------------------------------------

describe('voice controller — start', () => {
  it('opens the microphone FIRST, then the transport, then arms (flushing what it held)', async () => {
    const gate = deferred()
    const transport = makeTransport(() => gate.promise)
    const controller = createVoiceController(transport, { env: makeEnv() })

    const started = controller.start('rid-1', 'en')
    await vi.waitFor(() => expect(transport.start).toHaveBeenCalled())
    // Speech while the transport start is in flight is held, not sent.
    pushBlock()
    expect(transport.audio).not.toHaveBeenCalled()

    gate.resolve()
    await started

    expect(log).toEqual(['mic:open', 'transport:start rid-1 en', 'transport:audio rid-1'])
    // Armed: live audio goes straight through.
    pushBlock()
    expect(transport.audio).toHaveBeenCalledTimes(2)
    expect(controller.isActive()).toBe(true)
  })

  it('a transport failure closes the microphone and rethrows', async () => {
    const transport = makeTransport(async () => {
      throw new Error('Provider does not support voice')
    })
    const controller = createVoiceController(transport, { env: makeEnv() })

    await expect(controller.start('rid-1', 'en')).rejects.toThrow(/does not support voice/)

    expect(log).toEqual(['mic:open', 'transport:start rid-1 en', 'mic:close', 'context:close'])
    expect(controller.isActive()).toBe(false)
    // Nothing captured before the failure leaks out afterwards.
    pushBlock()
    expect(transport.audio).not.toHaveBeenCalled()
  })

  it('a refused microphone never reaches the transport', async () => {
    const denied = Object.assign(new Error('denied'), { name: 'NotAllowedError' })
    const transport = makeTransport()
    const controller = createVoiceController(transport, {
      env: makeEnv(async () => {
        throw denied
      })
    })

    await expect(controller.start('rid-1', 'en')).rejects.toThrow(/^Microphone access denied/)
    expect(transport.start).not.toHaveBeenCalled()
  })

  it('is idempotent while active — a second press never restarts the transport', async () => {
    const transport = makeTransport()
    const controller = createVoiceController(transport, { env: makeEnv() })

    await controller.start('rid-1', 'en')
    await controller.start('rid-1', 'en')

    expect(transport.start).toHaveBeenCalledTimes(1)
    expect(log.filter((l) => l === 'mic:open')).toHaveLength(1)
  })

  it('a second press while the first is still starting is idempotent too', async () => {
    const gate = deferred()
    const transport = makeTransport(() => gate.promise)
    const controller = createVoiceController(transport, { env: makeEnv() })

    const first = controller.start('rid-1', 'en')
    await vi.waitFor(() => expect(transport.start).toHaveBeenCalled())
    await controller.start('rid-1', 'en')
    gate.resolve()
    await first

    expect(transport.start).toHaveBeenCalledTimes(1)
  })
})

describe('voice controller — stop', () => {
  it('closes the microphone FIRST, then tells the transport', async () => {
    const transport = makeTransport()
    const controller = createVoiceController(transport, { env: makeEnv() })
    await controller.start('rid-1', 'en')
    log = []

    await controller.stop('rid-1')

    expect(log).toEqual(['mic:close', 'context:close', 'transport:stop rid-1'])
    expect(controller.isActive()).toBe(false)
  })

  it('tells the transport even when nothing was captured', async () => {
    const transport = makeTransport()
    const controller = createVoiceController(transport, { env: makeEnv() })

    await controller.stop('rid-1')

    expect(transport.stop).toHaveBeenCalledWith('rid-1')
  })

  it('a stop while the transport start is in flight DRAINS: queued audio goes out before the stop (S2 item 1)', async () => {
    const gate = deferred()
    const transport = makeTransport(() => gate.promise)
    const controller = createVoiceController(transport, { env: makeEnv() })

    const started = controller.start('rid-1', 'en')
    await vi.waitFor(() => expect(transport.start).toHaveBeenCalled())
    pushBlock() // said while cli.js was still spawning
    const stopped = controller.stop('rid-1')
    // The microphone closed at once…
    expect(log).toContain('mic:close')
    // …and the halt has long finished (graph torn down) — yet the transport is
    // not told to stop, and nothing is discarded, until the start has answered.
    await vi.waitFor(() => expect(log).toContain('context:close'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(transport.stop).not.toHaveBeenCalled()

    gate.resolve()
    await Promise.all([started, stopped])

    expect(log.filter((l) => l.startsWith('transport:'))).toEqual([
      'transport:start rid-1 en',
      'transport:audio rid-1',
      'transport:stop rid-1'
    ])
    expect(controller.isActive()).toBe(false)
  })
})

describe('voice controller — drain edge cases (S2 item 1)', () => {
  it('a start that FAILS discards the queue; the stop still reaches the transport', async () => {
    const gate = deferred()
    const transport = makeTransport(() => gate.promise)
    const controller = createVoiceController(transport, { env: makeEnv() })

    const started = controller.start('rid-1', 'en')
    await vi.waitFor(() => expect(transport.start).toHaveBeenCalled())
    pushBlock()
    const stopped = controller.stop('rid-1')
    gate.reject(new Error('Provider does not support voice'))

    await expect(started).rejects.toThrow(/does not support voice/)
    await stopped
    expect(transport.audio).not.toHaveBeenCalled()
    expect(transport.stop).toHaveBeenCalledWith('rid-1')
  })

  it('a release while the microphone is still opening cancels the press', async () => {
    let grant!: () => void
    const transport = makeTransport()
    const controller = createVoiceController(transport, {
      env: makeEnv(
        () =>
          new Promise<MediaStream>((resolve) => {
            grant = () => {
              const track = Object.assign(new EventTarget(), {
                stop: () => log.push('mic:close')
              })
              resolve({ getTracks: () => [track] } as unknown as MediaStream)
            }
          })
      )
    })

    const started = controller.start('rid-1', 'en')
    await vi.waitFor(() => expect(grant).toBeTypeOf('function'))
    const stopped = controller.stop('rid-1')
    grant() // the permission prompt answered after the button was let go
    await Promise.all([started, stopped])

    expect(transport.start).not.toHaveBeenCalled()
    expect(log).toContain('mic:close')
    expect(controller.isActive()).toBe(false)
  })

  it('a re-press during the drain waits for it, then starts cleanly', async () => {
    const gate = deferred()
    let calls = 0
    const transport = makeTransport(() => (++calls === 1 ? gate.promise : Promise.resolve()))
    const controller = createVoiceController(transport, { env: makeEnv() })

    const first = controller.start('rid-1', 'en')
    await vi.waitFor(() => expect(transport.start).toHaveBeenCalledTimes(1))
    const stopped = controller.stop('rid-1')
    const second = controller.start('rid-1', 'en')
    gate.resolve()
    await Promise.all([first, stopped, second])

    // The first press's stop reached the transport BEFORE the second start.
    expect(
      log.filter((l) => l.startsWith('transport:start') || l.startsWith('transport:stop'))
    ).toEqual(['transport:start rid-1 en', 'transport:stop rid-1', 'transport:start rid-1 en'])
    expect(controller.isActive()).toBe(true)
  })
})

describe('voice controller — microphone faults (S2 item 9)', () => {
  it('an unplugged microphone is reported AND ends the capture through the normal stop', async () => {
    const transport = makeTransport()
    const controller = createVoiceController(transport, { env: makeEnv() })
    const faults: string[] = []
    controller.onFault((message) => faults.push(message))
    await controller.start('rid-1', 'en')
    pushBlock()

    liveTracks[0].dispatchEvent(new Event('ended'))
    await vi.waitFor(() => expect(transport.stop).toHaveBeenCalledWith('rid-1'))

    expect(faults).toEqual([MIC_DISCONNECTED_MESSAGE])
    expect(controller.isActive()).toBe(false)
  })

  it('a sustained system mute is reported, and the capture carries on', async () => {
    const transport = makeTransport()
    const controller = createVoiceController(transport, { env: makeEnv() })
    const faults: string[] = []
    const off = controller.onFault((message) => faults.push(message))
    await controller.start('rid-1', 'en')

    vi.useFakeTimers()
    try {
      const track = liveTracks[0]
      Object.assign(track, { muted: true })
      track.dispatchEvent(new Event('mute'))
      vi.advanceTimersByTime(MIC_MUTE_GRACE_MS)
      expect(faults).toEqual([MIC_MUTED_MESSAGE])
      expect(transport.stop).not.toHaveBeenCalled()
      expect(controller.isActive()).toBe(true)

      off()
      Object.assign(track, { muted: false })
      track.dispatchEvent(new Event('unmute'))
      Object.assign(track, { muted: true })
      track.dispatchEvent(new Event('mute'))
      vi.advanceTimersByTime(MIC_MUTE_GRACE_MS)
      expect(faults).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('voice controller — level and silence (S3a items 5–6)', () => {
  it("relays the capture's per-block level to subscribers until they unsubscribe", async () => {
    const controller = createVoiceController(makeTransport(), { env: makeEnv() })
    const levels: number[] = []
    const off = controller.onLevel((level) => levels.push(level))
    await controller.start('rid-1', 'en')

    pushBlock()
    expect(levels).toHaveLength(1)
    expect(levels[0]).toBeGreaterThan(0)

    off()
    pushBlock()
    expect(levels).toHaveLength(1)
  })

  it('relays the live silence warning, and its clearing', async () => {
    const controller = createVoiceController(makeTransport(), { env: makeEnv() })
    const silences: CaptureSilence[] = []
    controller.onSilence((silence) => silences.push(silence))
    await controller.start('rid-1', 'en')

    workletPort?.onmessage?.({ data: new Float32Array((SILENCE_WARNING_MS * 16000) / 1000) })
    pushBlock()
    expect(silences.map((s) => s.silent)).toEqual([true, false])
  })

  it('words a denied microphone for its client', async () => {
    const controller = createVoiceController(makeTransport(), {
      env: makeEnv(async () => {
        throw Object.assign(new Error('denied'), { name: 'NotAllowedError' })
      }),
      deniedMessage: MIC_DENIED_MACOS_MESSAGE
    })
    await expect(controller.start('rid-1', 'en')).rejects.toThrow(MIC_DENIED_MACOS_MESSAGE)
  })
})

// Review item 1: the desktop's `voice:error` is replicated, so every client
// watching a session hears it. Only the client that held the microphone shows it:
// from its press until VOICE_OWNERSHIP_WINDOW_MS after its stop completed.
describe('voice controller — owns a recent capture', () => {
  it('owns nothing it never captured for', () => {
    const controller = createVoiceController(makeTransport(), { env: makeEnv() })
    expect(controller.ownsRecentCapture('rid-1')).toBe(false)
  })

  it('owns the session from the press, through the stop, until the window closes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const controller = createVoiceController(makeTransport(), { env: makeEnv() })
      const starting = controller.start('rid-1', 'en')
      expect(controller.ownsRecentCapture('rid-1')).toBe(true)
      await starting
      expect(controller.ownsRecentCapture('rid-1')).toBe(true)
      expect(controller.ownsRecentCapture('rid-other')).toBe(false)

      // Held for minutes: still ours — the window only starts at the stop.
      vi.setSystemTime(Date.now() + 10 * 60_000)
      expect(controller.ownsRecentCapture('rid-1')).toBe(true)

      await controller.stop('rid-1')
      vi.setSystemTime(Date.now() + VOICE_OWNERSHIP_WINDOW_MS - 1)
      expect(controller.ownsRecentCapture('rid-1')).toBe(true)
      vi.setSystemTime(Date.now() + 1)
      expect(controller.ownsRecentCapture('rid-1')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a refused start is still owned — its error is this client’s to show', async () => {
    const controller = createVoiceController(makeTransport(), {
      env: makeEnv(async () => {
        throw Object.assign(new Error('denied'), { name: 'NotAllowedError' })
      })
    })
    await expect(controller.start('rid-1', 'en')).rejects.toThrow()
    expect(controller.ownsRecentCapture('rid-1')).toBe(true)
  })

  it('follows a rekey: a capture under the old id owns the new one', async () => {
    const rekeys = new Map<string, string>()
    const controller = createVoiceController(makeTransport(), {
      env: makeEnv(),
      resolveId: (id) => rekeys.get(id) ?? id
    })
    await controller.start('pending-1', 'en')
    rekeys.set('pending-1', 'sdk-1')
    expect(controller.ownsRecentCapture('sdk-1')).toBe(true)
    await controller.stop('sdk-1')
    expect(controller.ownsRecentCapture('pending-1')).toBe(true)
    expect(controller.ownsRecentCapture('sdk-1')).toBe(true)
  })
})

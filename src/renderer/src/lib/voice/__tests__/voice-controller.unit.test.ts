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
import { createVoiceController, type VoiceTransport } from '../voice-controller'
import type { CaptureEnv } from '../browser-voice-capture'

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

let log: string[] = []
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
            const track = { stop: () => log.push('mic:close') }
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

    await expect(controller.start('rid-1', 'en')).rejects.toThrow(/Microphone access was denied/)
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

  it('a stop while the transport start is in flight leaves nothing armed', async () => {
    const gate = deferred()
    const transport = makeTransport(() => gate.promise)
    const controller = createVoiceController(transport, { env: makeEnv() })

    const started = controller.start('rid-1', 'en')
    await vi.waitFor(() => expect(transport.start).toHaveBeenCalled())
    pushBlock()
    await controller.stop('rid-1')
    gate.resolve()
    await started

    // The held block died with the capture; arm() on an idle capture is a no-op.
    expect(transport.audio).not.toHaveBeenCalled()
    expect(controller.isActive()).toBe(false)
  })
})

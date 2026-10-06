/**
 * Layer 1 tests for the voice capture (`BrowserVoiceCapture`) — the one
 * implementation the desktop window and the web client share. Moved here with
 * it from `src/web/` when desktop capture left the main process.
 *
 * **What is deliberately NOT tested here, and why.** jsdom has no
 * `AudioContext`, no `AudioWorklet` and no audio device, and no headless
 * environment has a microphone. So `voice-worklet.js` — which is loaded
 * by URL into an audio-thread global scope with no module graph the test runner
 * can reach — is untestable at every layer we have, and is written to be trivial
 * for exactly that reason: it copies floats into a buffer and posts it.
 *
 * The correctness that would otherwise ride on it lives in
 * `shared/audio/pcm16.ts`, which is pure and has its own suite. What is left for
 * this file is the part that jsdom CAN hold: the state machine — support
 * detection, permission failures, the pre-arm queue, and teardown — driven
 * through injected environment doubles.
 *
 * The remaining gap is honest and named: nobody has proven in CI that a real
 * browser's worklet produces blocks in the shape this controller assumes. That
 * is the owner's device verification.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  BrowserVoiceCapture,
  MIC_DISCONNECTED_MESSAGE,
  MIC_MUTED_MESSAGE,
  MIC_MUTE_GRACE_MS,
  VOICE_WORKLET_URL,
  WORKLET_FLUSH_TIMEOUT_MS,
  captureUnsupportedReason,
  type CaptureEnv,
  type CaptureFault
} from '../browser-voice-capture'

// ---------------------------------------------------------------------------
// Environment doubles
// ---------------------------------------------------------------------------

class FakeAudioNode {
  connect = vi.fn()
  disconnect = vi.fn()
  gain = { value: 1 }
  port = {
    onmessage: null as ((event: { data: Float32Array | string }) => void) | null,
    postMessage: vi.fn((_message: unknown) => {})
  }
}

/**
 * How the fake worklet answers a `flush`: post a partial batch of
 * `workletTailSamples` (if any) and then `flushed`, asynchronously like a real
 * port — or, when `workletAnswers` is false, never (a context that stopped
 * rendering).
 */
let workletAnswers = true
let workletTailSamples = 0

let contexts: FakeAudioContext[] = []
let workletNodes: FakeAudioWorkletNode[] = []
let addedModules: string[] = []

class FakeAudioContext {
  sampleRate: number
  closed = false
  state: AudioContextState = 'running'
  resume = vi.fn(async () => {
    this.state = 'running'
  })
  destination = new FakeAudioNode()
  audioWorklet = {
    addModule: vi.fn(async (url: string) => {
      addedModules.push(url)
    })
  }

  constructor(options?: { sampleRate?: number }) {
    // The browsers that honour the option give us the rate we asked for.
    this.sampleRate = options?.sampleRate ?? 48000
    contexts.push(this)
  }

  createMediaStreamSource(): FakeAudioNode {
    return new FakeAudioNode()
  }

  createGain(): FakeAudioNode {
    return new FakeAudioNode()
  }

  close = vi.fn(async () => {
    this.closed = true
  })
}

/** A context constructor that rejects the sampleRate option, like Safari. */
class PickyAudioContext extends FakeAudioContext {
  constructor(options?: { sampleRate?: number }) {
    if (options?.sampleRate) throw new Error('unsupported sample rate')
    super()
  }
}

class FakeAudioWorkletNode extends FakeAudioNode {
  constructor(
    public context: FakeAudioContext,
    public name: string
  ) {
    super()
    workletNodes.push(this)
    this.port.postMessage = vi.fn((message: unknown) => {
      if (message !== 'flush' || !workletAnswers) return
      queueMicrotask(() => {
        if (workletTailSamples > 0) {
          this.port.onmessage?.({ data: new Float32Array(workletTailSamples).fill(0.75) })
        }
        this.port.onmessage?.({ data: 'flushed' })
      })
    })
  }
}

/** A MediaStreamTrack double: stoppable, and an EventTarget for `ended`/`mute`. */
type FakeTrack = EventTarget & { stop: ReturnType<typeof vi.fn> }

let tracks: FakeTrack[] = []

function makeStream(): MediaStream {
  const track = Object.assign(new EventTarget(), { stop: vi.fn() }) as FakeTrack
  tracks.push(track)
  return { getTracks: () => [track] } as unknown as MediaStream
}

function makeEnv(
  overrides: Partial<CaptureEnv> = {},
  gum?: () => Promise<MediaStream>
): CaptureEnv {
  return {
    isSecureContext: true,
    mediaDevices: { getUserMedia: vi.fn(gum ?? (async () => makeStream())) },
    AudioContextCtor: FakeAudioContext as unknown as typeof AudioContext,
    AudioWorkletNodeCtor: FakeAudioWorkletNode as unknown as typeof AudioWorkletNode,
    ...overrides
  }
}

/** Feed one worklet block into the controller, as the audio thread would. */
function pushBlock(samples: number, value = 0.5): void {
  const node = workletNodes[workletNodes.length - 1]
  node.port.onmessage?.({ data: new Float32Array(samples).fill(value) })
}

beforeEach(() => {
  contexts = []
  workletNodes = []
  addedModules = []
  tracks = []
  workletAnswers = true
  workletTailSamples = 0
})

// ---------------------------------------------------------------------------

describe('captureUnsupportedReason', () => {
  it('names the secure-context requirement first — it is the one an owner can act on', () => {
    const reason = captureUnsupportedReason(makeEnv({ isSecureContext: false }))
    expect(reason).toMatch(/secure \(HTTPS\)/)
  })

  it('reports a browser with no microphone API', () => {
    expect(captureUnsupportedReason(makeEnv({ mediaDevices: undefined }))).toMatch(/microphone API/)
  })

  it('reports a browser with no AudioWorklet', () => {
    expect(captureUnsupportedReason(makeEnv({ AudioWorkletNodeCtor: undefined }))).toMatch(
      /AudioWorklet/
    )
    expect(captureUnsupportedReason(makeEnv({ AudioContextCtor: undefined }))).toMatch(
      /AudioWorklet/
    )
  })

  it('passes a secure context with the full API', () => {
    expect(captureUnsupportedReason(makeEnv())).toBeNull()
  })
})

describe('BrowserVoiceCapture', () => {
  it('opens a mono microphone, loads the worklet by URL, and routes it through a muted sink', async () => {
    const env = makeEnv()
    const capture = new BrowserVoiceCapture({ sendAudio: vi.fn(), env })

    await capture.start()

    expect(env.mediaDevices!.getUserMedia).toHaveBeenCalledWith({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    })
    // A same-origin asset — a blob: or data: module (which Vite would inline a
    // file this small as, without `no-inline`) is refused by `script-src 'self'`.
    expect(addedModules).toEqual([VOICE_WORKLET_URL])
    expect(VOICE_WORKLET_URL).toMatch(/voice-worklet[^/]*\.js/)
    expect(VOICE_WORKLET_URL).not.toMatch(/^(data|blob):/)
    expect(capture.isActive()).toBe(true)
    // The graph must reach the destination for a worklet to run at all, and the
    // gain it reaches it through must be silent or the speaker hears themselves.
    const context = contexts[0]
    expect(context.sampleRate).toBe(16000)
    expect(capture.isActive()).toBe(true)
    expect(workletNodes[0].name).toBe('voice-capture')
    expect(workletNodes[0].connect).toHaveBeenCalled()
  })

  it('falls back to the device rate when the browser refuses a 16 kHz context', async () => {
    const env = makeEnv({ AudioContextCtor: PickyAudioContext as unknown as typeof AudioContext })
    const capture = new BrowserVoiceCapture({ sendAudio: vi.fn(), env })

    await capture.start()

    expect(capture.isActive()).toBe(true)
    expect(contexts[0].sampleRate).toBe(48000)
  })

  it('refuses to start in an insecure context, and never touches the microphone', async () => {
    const env = makeEnv({ isSecureContext: false })
    const capture = new BrowserVoiceCapture({ sendAudio: vi.fn(), env })

    await expect(capture.start()).rejects.toThrow(/secure \(HTTPS\)/)
    expect(env.mediaDevices!.getUserMedia).not.toHaveBeenCalled()
    expect(capture.isActive()).toBe(false)
  })

  it('turns a denied permission into a message an owner can act on, and cleans up', async () => {
    const denied = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' })
    const env = makeEnv({}, async () => {
      throw denied
    })
    const capture = new BrowserVoiceCapture({ sendAudio: vi.fn(), env })

    await expect(capture.start()).rejects.toThrow(/Microphone access was denied/)
    expect(capture.isActive()).toBe(false)
  })

  it('distinguishes a missing device and a busy one', async () => {
    for (const [name, pattern] of [
      ['NotFoundError', /No microphone was found/],
      ['NotReadableError', /in use by another application/]
    ] as const) {
      const capture = new BrowserVoiceCapture({
        sendAudio: vi.fn(),
        env: makeEnv({}, async () => {
          throw Object.assign(new Error('nope'), { name })
        })
      })
      await expect(capture.start()).rejects.toThrow(pattern)
    }
  })

  it('holds blocks captured before `arm()` and flushes them in order', async () => {
    const sendAudio = vi.fn()
    const capture = new BrowserVoiceCapture({ sendAudio, env: makeEnv() })
    await capture.start()

    // The window while the transport start is in flight: the server has no capture
    // bound yet and would drop these on the floor.
    pushBlock(1600, 0.5)
    pushBlock(1600, -0.5)
    expect(sendAudio).not.toHaveBeenCalled()

    capture.arm()
    expect(sendAudio).toHaveBeenCalledTimes(2)
    const flushed = sendAudio.mock.calls.map((c) => c[0] as string)
    expect(flushed[0]).not.toBe(flushed[1]) // order preserved, distinct payloads

    // Live from here on.
    pushBlock(1600, 0.25)
    expect(sendAudio).toHaveBeenCalledTimes(3)
  })

  it('encodes a block as base64 of 16 kHz i16LE bytes', async () => {
    const sendAudio = vi.fn()
    const capture = new BrowserVoiceCapture({ sendAudio, env: makeEnv() })
    await capture.start()
    capture.arm()

    // The context honoured 16 kHz, so 160 input samples are 160 output samples,
    // i.e. 320 bytes.
    pushBlock(160, 1)
    const bytes = Uint8Array.from(atob(sendAudio.mock.calls[0][0] as string), (c) =>
      c.charCodeAt(0)
    )
    expect(bytes.length).toBe(320)
    // Full positive scale, little-endian: 0x7fff.
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0x7f])
  })

  it('drops the OLDEST queued block when a slow transport start overruns the buffer', async () => {
    const sendAudio = vi.fn()
    const capture = new BrowserVoiceCapture({ sendAudio, env: makeEnv() })
    await capture.start()

    // 64 blocks is the cap; the 65th must evict the first, not refuse the newest —
    // the newest audio is the audio still being spoken.
    for (let i = 0; i < 70; i++) pushBlock(160, (i + 1) / 100)
    capture.arm()

    expect(sendAudio).toHaveBeenCalledTimes(64)
    const first = sendAudio.mock.calls[0][0] as string
    // Block 7 (value 0.07) is the oldest survivor of 70 blocks capped at 64.
    const expectedFirstSample = Math.round(0.07 * 0x7fff)
    const bytes = Uint8Array.from(atob(first), (c) => c.charCodeAt(0))
    expect(bytes[0] | (bytes[1] << 8)).toBe(expectedFirstSample)
  })

  it('stop() releases the device, closes the context, and silences later blocks', async () => {
    const sendAudio = vi.fn()
    const capture = new BrowserVoiceCapture({ sendAudio, env: makeEnv() })
    await capture.start()
    capture.arm()
    const node = workletNodes[0]

    await capture.stop()

    expect(capture.isActive()).toBe(false)
    // The track stop is what turns the browser's recording indicator off.
    expect(tracks[0].stop).toHaveBeenCalled()
    expect(contexts[0].closed).toBe(true)
    expect(node.disconnect).toHaveBeenCalled()

    // A block still in flight from the audio thread must not be sent.
    node.port.onmessage?.({ data: new Float32Array(160).fill(0.5) })
    expect(sendAudio).not.toHaveBeenCalled()
  })

  it('stop() is idempotent and arm() after stop does nothing', async () => {
    const sendAudio = vi.fn()
    const capture = new BrowserVoiceCapture({ sendAudio, env: makeEnv() })
    await capture.start()
    pushBlock(160)

    await capture.stop()
    await expect(capture.stop()).resolves.toBeUndefined()
    capture.arm()

    expect(sendAudio).not.toHaveBeenCalled()
    expect(capture.isActive()).toBe(false)
  })

  it('releases a microphone that arrives AFTER stop() — the permission-prompt race', async () => {
    // The interleaving this pins is not exotic; it is the FIRST use on a phone.
    // `getUserMedia` does not resolve until the permission prompt is answered,
    // and answering it means letting go of a hold-to-talk button — so `stop()`
    // runs while `start()` is still awaiting, and the stream lands afterwards.
    // A bail that merely returns leaves that stream live: the browser's
    // recording indicator stays lit, and the next press overwrites the field and
    // orphans the tracks for the page's lifetime.
    let resolveMedia: (stream: MediaStream) => void = () => {}
    const env = makeEnv(
      {},
      () =>
        new Promise<MediaStream>((resolve) => {
          resolveMedia = resolve
        })
    )
    const capture = new BrowserVoiceCapture({ sendAudio: vi.fn(), env })

    const starting = capture.start()
    await capture.stop() // the button was released while the prompt was up
    resolveMedia(makeStream()) // …and only now is permission granted
    await starting

    expect(capture.isActive()).toBe(false)
    // THE assertion: the device is released, not merely forgotten.
    expect(tracks[0].stop).toHaveBeenCalled()
    // And nothing built after the bail is left running either.
    for (const context of contexts) expect(context.closed).toBe(true)
  })

  it('releases everything when stop() lands while the worklet module is loading', async () => {
    // The same race one await later: permission was already granted, so the
    // window that matters is `addModule`'s network fetch.
    let resolveModule: () => void = () => {}
    class SlowContext extends FakeAudioContext {
      audioWorklet = {
        addModule: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              resolveModule = resolve
            })
        )
      }
    }
    const capture = new BrowserVoiceCapture({
      sendAudio: vi.fn(),
      env: makeEnv({ AudioContextCtor: SlowContext as unknown as typeof AudioContext })
    })

    const starting = capture.start()
    await vi.waitFor(() => expect(typeof resolveModule).toBe('function'))
    await capture.stop()
    resolveModule()
    await starting

    expect(capture.isActive()).toBe(false)
    expect(tracks[0].stop).toHaveBeenCalled()
    expect(contexts[0].closed).toBe(true)
  })

  it('a second start() while capturing is a no-op rather than a second microphone', async () => {
    const env = makeEnv()
    const capture = new BrowserVoiceCapture({ sendAudio: vi.fn(), env })
    await capture.start()
    await capture.start()

    expect(env.mediaDevices!.getUserMedia).toHaveBeenCalledTimes(1)
    expect(contexts).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// S2 — lifecycle robustness
// ---------------------------------------------------------------------------

/** Decode a sent batch's first sample. */
function firstSample(dataB64: string): number {
  const bytes = Uint8Array.from(atob(dataB64), (c) => c.charCodeAt(0))
  return ((bytes[0] | (bytes[1] << 8)) << 16) >> 16
}

describe('BrowserVoiceCapture — halt keeps what was captured (S2 item 1)', () => {
  it('halt() closes the microphone at once but keeps the queue; arm() then drains it', async () => {
    const sendAudio = vi.fn()
    const capture = new BrowserVoiceCapture({ sendAudio, env: makeEnv() })
    await capture.start()
    pushBlock(160, 0.5)

    await capture.halt()
    expect(tracks[0].stop).toHaveBeenCalled()
    expect(contexts[0].closed).toBe(true)
    expect(capture.isActive()).toBe(false)
    expect(sendAudio).not.toHaveBeenCalled()

    capture.arm()
    expect(sendAudio).toHaveBeenCalledTimes(1)
    // Drained: a second arm has nothing left to send.
    capture.arm()
    expect(sendAudio).toHaveBeenCalledTimes(1)
  })

  it('stop() after halt() discards the queue', async () => {
    const sendAudio = vi.fn()
    const capture = new BrowserVoiceCapture({ sendAudio, env: makeEnv() })
    await capture.start()
    pushBlock(160, 0.5)

    await capture.halt()
    await capture.stop()
    capture.arm()
    expect(sendAudio).not.toHaveBeenCalled()
  })

  it('halt() is idempotent — concurrent halts share one teardown', async () => {
    const capture = new BrowserVoiceCapture({ sendAudio: vi.fn(), env: makeEnv() })
    await capture.start()
    await Promise.all([capture.halt(), capture.halt()])
    expect(contexts[0].close).toHaveBeenCalledTimes(1)
  })
})

describe('BrowserVoiceCapture — a suspended context is resumed (S2 item 8)', () => {
  class SuspendedContext extends FakeAudioContext {
    state: AudioContextState = 'suspended'
  }

  it('resumes a context that starts suspended, before building the graph', async () => {
    const capture = new BrowserVoiceCapture({
      sendAudio: vi.fn(),
      env: makeEnv({ AudioContextCtor: SuspendedContext as unknown as typeof AudioContext })
    })
    await capture.start()
    expect(contexts[0].resume).toHaveBeenCalledTimes(1)
    expect(contexts[0].state).toBe('running')
    expect(capture.isActive()).toBe(true)
  })

  it('does not resume a running one', async () => {
    const capture = new BrowserVoiceCapture({ sendAudio: vi.fn(), env: makeEnv() })
    await capture.start()
    expect(contexts[0].resume).not.toHaveBeenCalled()
  })

  it('a release while resuming bails and releases everything', async () => {
    let finishResume: () => void = () => {}
    class SlowResume extends SuspendedContext {
      resume = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishResume = resolve
          })
      )
    }
    const capture = new BrowserVoiceCapture({
      sendAudio: vi.fn(),
      env: makeEnv({ AudioContextCtor: SlowResume as unknown as typeof AudioContext })
    })
    const starting = capture.start()
    await vi.waitFor(() => expect(contexts[0]?.resume).toHaveBeenCalled())
    await capture.stop()
    finishResume()
    await starting

    expect(capture.isActive()).toBe(false)
    expect(tracks[0].stop).toHaveBeenCalled()
    expect(contexts[0].closed).toBe(true)
    expect(workletNodes).toHaveLength(0)
  })
})

describe('BrowserVoiceCapture — track faults (S2 item 9)', () => {
  it('reports an unplugged microphone as an ENDED fault', async () => {
    const onFault = vi.fn((_fault: CaptureFault) => {})
    const capture = new BrowserVoiceCapture({ sendAudio: vi.fn(), onFault, env: makeEnv() })
    await capture.start()

    tracks[0].dispatchEvent(new Event('ended'))
    expect(onFault).toHaveBeenCalledWith({ message: MIC_DISCONNECTED_MESSAGE, ended: true })
    // The capture does not end itself — that is the owner's call.
    expect(capture.isActive()).toBe(true)
  })

  describe(`a mute is reported only once it outlasts ${MIC_MUTE_GRACE_MS} ms`, () => {
    // Real tracks carry a live `muted` flag next to the events; the double mirrors it.
    function mute(track: FakeTrack): void {
      Object.assign(track, { muted: true })
      track.dispatchEvent(new Event('mute'))
    }
    function unmute(track: FakeTrack): void {
      Object.assign(track, { muted: false })
      track.dispatchEvent(new Event('unmute'))
    }

    async function capturing(): Promise<{
      capture: BrowserVoiceCapture
      onFault: ReturnType<typeof vi.fn>
    }> {
      const onFault = vi.fn((_fault: CaptureFault) => {})
      const capture = new BrowserVoiceCapture({ sendAudio: vi.fn(), onFault, env: makeEnv() })
      await capture.start()
      return { capture, onFault }
    }

    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('a mute held past the grace is reported once, as a non-ending fault', async () => {
      const { capture, onFault } = await capturing()

      mute(tracks[0])
      vi.advanceTimersByTime(MIC_MUTE_GRACE_MS - 1)
      expect(onFault).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(onFault).toHaveBeenCalledTimes(1)
      expect(onFault).toHaveBeenCalledWith({ message: MIC_MUTED_MESSAGE, ended: false })

      // A repeated `mute` event while still muted does not report again on its own.
      vi.advanceTimersByTime(MIC_MUTE_GRACE_MS * 5)
      expect(onFault).toHaveBeenCalledTimes(1)
      expect(capture.isActive()).toBe(true)
    })

    it('a mute→unmute pair within the grace (a Bluetooth profile switch) reports nothing', async () => {
      const { onFault } = await capturing()

      mute(tracks[0])
      vi.advanceTimersByTime(MIC_MUTE_GRACE_MS / 2)
      unmute(tracks[0])
      vi.advanceTimersByTime(MIC_MUTE_GRACE_MS * 2)

      expect(onFault).not.toHaveBeenCalled()
    })

    it('a halt during the grace reports nothing', async () => {
      const { capture, onFault } = await capturing()

      mute(tracks[0])
      const halting = capture.halt()
      await vi.advanceTimersByTimeAsync(MIC_MUTE_GRACE_MS * 2)
      await halting

      expect(onFault).not.toHaveBeenCalled()
    })

    it('an `ended` during the grace reports the disconnect, not the mute', async () => {
      const { onFault } = await capturing()

      mute(tracks[0])
      tracks[0].dispatchEvent(new Event('ended'))
      vi.advanceTimersByTime(MIC_MUTE_GRACE_MS * 2)

      expect(onFault.mock.calls.map(([fault]) => fault)).toEqual([
        { message: MIC_DISCONNECTED_MESSAGE, ended: true }
      ])
    })
  })

  it('says nothing about a track that ends because WE stopped it', async () => {
    const onFault = vi.fn((_fault: CaptureFault) => {})
    const capture = new BrowserVoiceCapture({ sendAudio: vi.fn(), onFault, env: makeEnv() })
    await capture.start()
    const track = tracks[0]
    await capture.stop()

    track.dispatchEvent(new Event('ended'))
    track.dispatchEvent(new Event('mute'))
    expect(onFault).not.toHaveBeenCalled()
  })
})

describe('BrowserVoiceCapture — the worklet tail (S2 item 10)', () => {
  it('asks the worklet for its partial batch before tearing down, and keeps it', async () => {
    const sendAudio = vi.fn()
    const capture = new BrowserVoiceCapture({ sendAudio, env: makeEnv() })
    await capture.start()
    capture.arm()
    workletTailSamples = 160
    const node = workletNodes[0]

    await capture.halt()

    expect(node.port.postMessage).toHaveBeenCalledWith('flush')
    // The tail (0.75 full scale) went out before the node was disconnected.
    expect(sendAudio).toHaveBeenCalledTimes(1)
    expect(firstSample(sendAudio.mock.calls[0][0] as string)).toBe(Math.round(0.75 * 0x7fff))
    expect(node.disconnect).toHaveBeenCalled()
  })

  it('an unarmed capture queues the tail for the drain', async () => {
    const sendAudio = vi.fn()
    const capture = new BrowserVoiceCapture({ sendAudio, env: makeEnv() })
    await capture.start()
    workletTailSamples = 160

    await capture.halt()
    expect(sendAudio).not.toHaveBeenCalled()
    capture.arm()
    expect(sendAudio).toHaveBeenCalledTimes(1)
  })

  it(`waits at most ${WORKLET_FLUSH_TIMEOUT_MS} ms for a worklet that never answers`, async () => {
    vi.useFakeTimers()
    try {
      workletAnswers = false
      const capture = new BrowserVoiceCapture({ sendAudio: vi.fn(), env: makeEnv() })
      await capture.start()

      let halted = false
      const halting = capture.halt().then(() => {
        halted = true
      })
      await vi.advanceTimersByTimeAsync(WORKLET_FLUSH_TIMEOUT_MS - 1)
      expect(halted).toBe(false)
      // The microphone is off already; only the graph waits for the tail.
      expect(tracks[0].stop).toHaveBeenCalled()
      expect(workletNodes[0].disconnect).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await halting
      expect(halted).toBe(true)
      expect(workletNodes[0].disconnect).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

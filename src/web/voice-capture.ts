/**
 * Browser microphone capture for the web client — SyncCore phase 5 S3.
 *
 * The desktop's `main/services/voice-capture.ts` loads a NAPI module that emits
 * 16 kHz i16LE mono PCM directly. A browser has no such thing: `MediaRecorder`
 * yields opus-in-webm and nothing else, which is what aborted the first attempt
 * at remote voice. `AudioWorklet` is the way through — it hands the page raw
 * Float32 blocks — and this file is the state machine around it.
 *
 * Three parts, and only one of them can be wrong in a way tests can catch:
 *  - `public/voice-worklet.js` batches render quanta (untestable: no
 *    AudioWorklet in jsdom, no audio device in CI — see its header);
 *  - `shared/audio/pcm16.ts` converts to the wire format (pure, unit-tested,
 *    and carries the correctness of the whole path);
 *  - this controller owns permissions, the graph, and the lifecycle.
 *
 * Everything the environment supplies is injected ({@link CaptureEnv}) so the
 * lifecycle IS testable in jsdom without pretending jsdom has audio.
 */

import {
  VOICE_SAMPLE_RATE,
  downsampleToPcm16,
  initialDownsampleState,
  pcm16ToBytesLe,
  type DownsampleState
} from '../shared/audio/pcm16'

/** Served by the remote server's static branch (`*.js` at the web root). */
export const VOICE_WORKLET_URL = '/voice-worklet.js'
/** The name `voice-worklet.js` registers. */
const PROCESSOR_NAME = 'voice-capture'

/**
 * Pre-arm queue depth, in ~150 ms blocks.
 *
 * A capture starts the microphone BEFORE `voice:start` has resolved, because the
 * round trip can spawn a cli.js child and open a Deepgram socket — seconds during
 * which someone is already talking. Frames produced in that window are held here
 * and flushed when {@link BrowserVoiceCapture.arm} says the server is listening.
 *
 * Bounded because a `voice:start` that never resolves must not grow a buffer
 * forever, and dropping the OLDEST is the right end to drop: the newest audio is
 * the audio still being spoken. 64 blocks is ~10 s.
 */
const MAX_PENDING_BLOCKS = 64

export interface CaptureEnv {
  /** `getUserMedia` is unavailable outside a secure context — HTTPS or localhost. */
  isSecureContext: boolean
  mediaDevices?: { getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> }
  AudioContextCtor?: typeof AudioContext
  AudioWorkletNodeCtor?: typeof AudioWorkletNode
}

/** Read the capture environment out of the browser globals. */
export function detectCaptureEnv(): CaptureEnv {
  const w = globalThis as unknown as {
    isSecureContext?: boolean
    navigator?: Navigator
    AudioContext?: typeof AudioContext
    webkitAudioContext?: typeof AudioContext
    AudioWorkletNode?: typeof AudioWorkletNode
  }
  return {
    isSecureContext: w.isSecureContext === true,
    mediaDevices: w.navigator?.mediaDevices,
    AudioContextCtor: w.AudioContext ?? w.webkitAudioContext,
    AudioWorkletNodeCtor: w.AudioWorkletNode
  }
}

/**
 * Why this environment cannot capture, or null when it can.
 *
 * The tailnet HTTPS origin passes; plain-HTTP LAN does not, which is the same
 * rule passkeys already imposed on this app (security.md) — so the answer for an
 * owner who wants voice on their phone is the answer they have already been
 * given for enrollment, not a new one.
 */
export function captureUnsupportedReason(env: CaptureEnv): string | null {
  if (!env.isSecureContext) {
    return 'Voice input needs a secure (HTTPS) connection — use the tailnet or tunnel address.'
  }
  if (!env.mediaDevices?.getUserMedia) return 'This browser does not expose a microphone API.'
  if (!env.AudioContextCtor || !env.AudioWorkletNodeCtor) {
    return 'This browser does not support AudioWorklet, which voice capture needs.'
  }
  return null
}

type CaptureState = 'idle' | 'starting' | 'capturing'

export interface BrowserVoiceCaptureOptions {
  /** Ship one base64 PCM batch upstream (the `voice-audio` lane frame). */
  sendAudio: (dataB64: string) => void
  env?: CaptureEnv
}

export class BrowserVoiceCapture {
  private readonly sendAudio: (dataB64: string) => void
  private readonly env: CaptureEnv

  private state: CaptureState = 'idle'
  private armed = false
  private pending: string[] = []

  private stream: MediaStream | null = null
  private context: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private worklet: AudioWorkletNode | null = null
  private sink: GainNode | null = null
  private resampler: DownsampleState | null = null

  constructor(options: BrowserVoiceCaptureOptions) {
    this.sendAudio = options.sendAudio
    this.env = options.env ?? detectCaptureEnv()
  }

  isActive(): boolean {
    return this.state !== 'idle'
  }

  /** Null when capture is possible here; otherwise the reason, for the caller to surface. */
  unsupportedReason(): string | null {
    return captureUnsupportedReason(this.env)
  }

  /**
   * Open the microphone and start producing batches.
   *
   * Throws — rather than failing quietly — on an unsupported environment and on
   * a denied permission: the caller (the mic button's handler) is what decides
   * how loud that is, and swallowing it here would leave a button that does
   * nothing for reasons nobody can see.
   */
  async start(): Promise<void> {
    if (this.state !== 'idle') return
    const reason = this.unsupportedReason()
    if (reason) throw new Error(reason)

    this.state = 'starting'
    this.armed = false
    this.pending = []

    try {
      // ASSIGNED BEFORE THE STATE CHECK, and every bail below is `stop()` rather
      // than a bare return. `start()` is a sequence of awaits and `stop()` can
      // land in any of the gaps — on a phone it RELIABLY does, because
      // `getUserMedia` does not resolve until the permission prompt is answered
      // and answering it means letting go of a hold-to-talk button. A bail that
      // returned without cleanup left a live MediaStream in a field nobody would
      // ever read again: the browser's recording indicator stays lit and the
      // next press overwrites the field, orphaning the tracks for the page's
      // lifetime. `stop()` is idempotent and releases whatever has been assigned
      // so far, which is why it is the only correct bail.
      this.stream = await this.env.mediaDevices!.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      })
      if (this.state !== 'starting') {
        await this.stop()
        return
      }
      // Ask for the wire rate outright. Where the browser honours it the
      // resampler becomes a pass-through quantizer and the whole conversion is
      // one multiply per sample; where it does not (or throws on the option) we
      // fall back to the device rate and downsample, which is why `pcm16.ts`
      // handles an arbitrary ratio rather than hard-coding 3:1.
      this.context = this.makeContext()
      await this.context.audioWorklet.addModule(VOICE_WORKLET_URL)
      if (this.state !== 'starting') {
        await this.stop()
        return
      }

      const sampleRate = this.context.sampleRate
      this.resampler = initialDownsampleState(sampleRate)

      this.source = this.context.createMediaStreamSource(this.stream)
      this.worklet = new this.env.AudioWorkletNodeCtor!(this.context, PROCESSOR_NAME)
      this.worklet.port.onmessage = (event: MessageEvent): void => {
        this.onBlock(event.data as Float32Array, sampleRate)
      }
      // A worklet only runs while its graph reaches the destination, so the node
      // is routed there through a MUTED gain — connecting it directly would play
      // the speaker's own voice back at them.
      this.sink = this.context.createGain()
      this.sink.gain.value = 0
      this.source.connect(this.worklet)
      this.worklet.connect(this.sink)
      this.sink.connect(this.context.destination)

      this.state = 'capturing'
    } catch (err) {
      await this.stop()
      throw new Error(describeCaptureFailure(err))
    }
  }

  /**
   * The server is listening: flush what was captured while `voice:start` was in
   * flight, and stream live from here on.
   */
  arm(): void {
    if (this.state === 'idle') return
    this.armed = true
    const queued = this.pending
    this.pending = []
    for (const dataB64 of queued) this.sendAudio(dataB64)
  }

  /** Close the microphone and tear the graph down. Idempotent. */
  async stop(): Promise<void> {
    this.state = 'idle'
    this.armed = false
    this.pending = []
    this.resampler = null

    if (this.worklet) {
      this.worklet.port.onmessage = null
      try {
        this.worklet.disconnect()
      } catch {
        /* a node from a closed context throws; nothing left to do about it */
      }
      this.worklet = null
    }
    for (const node of [this.source, this.sink]) {
      try {
        node?.disconnect()
      } catch {
        /* as above */
      }
    }
    this.source = null
    this.sink = null

    // Tracks first: this is what turns the browser's recording indicator off,
    // and it must happen even if closing the context throws.
    for (const track of this.stream?.getTracks() ?? []) {
      try {
        track.stop()
      } catch {
        /* ignore */
      }
    }
    this.stream = null

    const context = this.context
    this.context = null
    if (context) {
      try {
        await context.close()
      } catch {
        /* already closed */
      }
    }
  }

  // -- Private ---------------------------------------------------------------

  private makeContext(): AudioContext {
    const Ctor = this.env.AudioContextCtor!
    try {
      return new Ctor({ sampleRate: VOICE_SAMPLE_RATE })
    } catch {
      // Safari refuses rates its hardware cannot run; the fallback is the
      // device rate, which the resampler handles.
      return new Ctor()
    }
  }

  private onBlock(block: Float32Array, sampleRate: number): void {
    if (this.state === 'idle' || !this.resampler) return
    const { samples, state } = downsampleToPcm16(block, sampleRate, this.resampler)
    this.resampler = state
    if (samples.length === 0) return
    const dataB64 = bytesToBase64(pcm16ToBytesLe(samples))

    if (this.armed) {
      this.sendAudio(dataB64)
      return
    }
    this.pending.push(dataB64)
    // Drop the OLDEST: the newest audio is the audio still being spoken.
    if (this.pending.length > MAX_PENDING_BLOCKS) this.pending.shift()
  }
}

/**
 * A `getUserMedia` rejection, in words an owner can act on.
 *
 * `NotAllowedError` is the one that matters — on a phone it usually means the
 * site permission was denied once and the browser now refuses silently, which is
 * not something a generic "capture failed" would ever let someone diagnose.
 */
function describeCaptureFailure(err: unknown): string {
  const name = (err as { name?: string } | null)?.name
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone access was denied. Allow it for this site and try again.'
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No microphone was found on this device.'
  }
  if (name === 'NotReadableError') {
    return 'The microphone is in use by another application.'
  }
  const message = err instanceof Error ? err.message : String(err)
  return `Voice capture failed: ${message}`
}

/**
 * Raw bytes → base64.
 *
 * `String.fromCharCode(...bytes)` is a spread, so the byte count becomes the
 * ARGUMENT count and a large enough input overflows the call stack. A real batch
 * is nowhere near that — 150 ms of 16 kHz i16 mono is 4800 bytes, so the loop
 * runs once and the chunking never engages. The constant is a backstop for a
 * future batch size, and it is 8 KB rather than the more common 32 KB precisely
 * because 32 KB is itself in the neighbourhood of engine argument limits: a cap
 * that sits next to the hazard it is meant to avoid is not a cap.
 */
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x2000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/**
 * Microphone capture for every client — the desktop window and the remote web
 * client run this same file (`src/web/main.tsx` renders the renderer app).
 *
 * It began as the web client's (SyncCore phase 5 S3), when the desktop captured
 * in the main process through Claude Code's native `audio-capture` module. That
 * module binds the OS default input at start and has no device API, so desktop
 * capture moved here too: one Web Audio implementation, pushing 16 kHz i16LE mono
 * PCM to the main process, which relays it to the cli.js voice server.
 *
 * `MediaRecorder` yields opus-in-webm and nothing else, which is what aborted
 * the first attempt at remote voice. `AudioWorklet` is the way through — it hands
 * the page raw Float32 blocks — and this file is the state machine around it.
 *
 * Three parts, and only one of them can be wrong in a way tests can catch:
 *  - `voice-worklet.js` batches render quanta (untestable: no AudioWorklet in
 *    jsdom, no audio device in CI — see its header);
 *  - `shared/audio/pcm16.ts` converts to the wire format (pure, unit-tested,
 *    and carries the correctness of the whole path);
 *  - this class owns permissions, the graph, and the lifecycle.
 *
 * Who it talks to is not its business: `voice-controller.ts` pairs it with a
 * transport. Everything the environment supplies is injected ({@link CaptureEnv})
 * so the lifecycle IS testable in jsdom without pretending jsdom has audio.
 */

import {
  VOICE_SAMPLE_RATE,
  downsampleToPcm16,
  initialDownsampleState,
  pcm16ToBytesLe,
  type DownsampleState
} from '../../../../shared/audio/pcm16'
// `no-inline`: the worklet is small enough that Vite would otherwise inline it
// as a `data:` URL, which `script-src 'self'` refuses. As a hashed asset under
// `/assets/` it is same-origin in both builds — `file://` on the desktop,
// `remote-server.ts`'s static branch on the web.
import workletUrl from './voice-worklet.js?url&no-inline'

/** The worklet module's URL, as the build emitted it. */
export const VOICE_WORKLET_URL: string = workletUrl
/** The name `voice-worklet.js` registers. */
const PROCESSOR_NAME = 'voice-capture'

/**
 * Pre-arm queue depth, in ~150 ms blocks.
 *
 * A capture starts the microphone BEFORE the transport's start has resolved,
 * because that round trip can spawn a cli.js child and open a Deepgram socket — seconds during
 * which someone is already talking. Frames produced in that window are held here
 * and flushed when {@link BrowserVoiceCapture.arm} says the server is listening.
 *
 * Bounded because a start that never resolves must not grow a buffer
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
 * The desktop window passes (`file://` and the dev server's localhost are both
 * secure contexts), as does the tailnet HTTPS origin; plain-HTTP LAN does not, which is the same
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

/**
 * - `starting`: the microphone and graph are being built (no blocks yet);
 * - `capturing`: blocks flow — sent if armed, queued if not;
 * - `halting`: the microphone is closing; the worklet's last partial batch is
 *   still on its way;
 * - `halted`: the microphone is closed but the pre-arm queue is KEPT, waiting
 *   for {@link BrowserVoiceCapture.arm} (flush) or
 *   {@link BrowserVoiceCapture.stop} (discard).
 */
type CaptureState = 'idle' | 'starting' | 'capturing' | 'halting' | 'halted'

/**
 * How long a halt waits for the worklet's partial batch. The worklet answers
 * within a render quantum or two; the bound only matters for a context that has
 * stopped rendering, where waiting longer would just delay the release.
 */
export const WORKLET_FLUSH_TIMEOUT_MS = 100

/** What the worklet answers a `flush` with, after posting its partial batch. */
const WORKLET_FLUSHED = 'flushed'

export const MIC_DISCONNECTED_MESSAGE = 'The microphone was disconnected.'
export const MIC_MUTED_MESSAGE = 'The microphone was muted by the system.'

/**
 * How long a track must STAY muted before it is reported. Browsers fire brief
 * mute/unmute pairs on their own — a macOS Bluetooth headset switching between
 * its A2DP and HFP profiles, an Android audio-focus blip — and each one would
 * otherwise put an error on the session for a microphone that is fine.
 */
export const MIC_MUTE_GRACE_MS = 1000

export interface CaptureFault {
  message: string
  /** The track ENDED: no more audio will come, so the capture should be ended. */
  ended: boolean
}

export interface BrowserVoiceCaptureOptions {
  /** Ship one base64 PCM batch upstream (the transport's `voiceAudio`). */
  sendAudio: (dataB64: string) => void
  /**
   * Something happened to the microphone mid-capture that the speaker should
   * hear about — it was unplugged (`ended`) or the OS muted it. The capture does
   * not end itself: the owner decides, so an unplug can still finalize what was
   * said through the normal stop.
   */
  onFault?: (fault: CaptureFault) => void
  env?: CaptureEnv
}

export class BrowserVoiceCapture {
  private readonly sendAudio: (dataB64: string) => void
  private readonly onFault?: (fault: CaptureFault) => void
  private readonly env: CaptureEnv

  private state: CaptureState = 'idle'
  private armed = false
  private pending: string[] = []
  /** The halt in progress, so a second halt (or a stop) joins it. */
  private halting: Promise<void> | null = null

  private stream: MediaStream | null = null
  private context: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private worklet: AudioWorkletNode | null = null
  private sink: GainNode | null = null
  private resampler: DownsampleState | null = null
  /** Resolves the halt's wait for the worklet's tail. */
  private onFlushed: (() => void) | null = null
  private untrack: (() => void) | null = null

  constructor(options: BrowserVoiceCaptureOptions) {
    this.sendAudio = options.sendAudio
    this.onFault = options.onFault
    this.env = options.env ?? detectCaptureEnv()
  }

  /** The microphone is open or opening. False once halted, queue or no queue. */
  isActive(): boolean {
    return this.state === 'starting' || this.state === 'capturing'
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
      // ASSIGNED BEFORE THE STATE CHECK, and every bail below releases rather
      // than returning bare. `start()` is a sequence of awaits and a halt can
      // land in any of the gaps — on a phone it RELIABLY does, because
      // `getUserMedia` does not resolve until the permission prompt is answered
      // and answering it means letting go of a hold-to-talk button. A bail that
      // returned without cleanup left a live MediaStream in a field nobody would
      // ever read again: the browser's recording indicator stays lit and the
      // next press overwrites the field, orphaning the tracks for the page's
      // lifetime. `release()` is idempotent and frees whatever has been assigned
      // so far, which is why it is the only correct bail. (Nothing is queued
      // before `capturing`, so a halt here has no audio to keep.)
      this.stream = await this.env.mediaDevices!.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      })
      if (this.state !== 'starting') {
        await this.release()
        return
      }
      // Ask for the wire rate outright. Where the browser honours it the
      // resampler becomes a pass-through quantizer and the whole conversion is
      // one multiply per sample; where it does not (or throws on the option) we
      // fall back to the device rate and downsample, which is why `pcm16.ts`
      // handles an arbitrary ratio rather than hard-coding 3:1.
      this.context = this.makeContext()
      // A context created outside a user gesture's activation window — the
      // await on `getUserMedia` above is enough to lose it — can start
      // SUSPENDED, and a suspended context renders nothing: the worklet would
      // never post a block and the capture would be silent with no error.
      if (this.context.state === 'suspended') {
        await this.context.resume()
        if (this.state !== 'starting') {
          await this.release()
          return
        }
      }
      await this.context.audioWorklet.addModule(VOICE_WORKLET_URL)
      if (this.state !== 'starting') {
        await this.release()
        return
      }

      const sampleRate = this.context.sampleRate
      this.resampler = initialDownsampleState(sampleRate)

      this.source = this.context.createMediaStreamSource(this.stream)
      this.worklet = new this.env.AudioWorkletNodeCtor!(this.context, PROCESSOR_NAME)
      this.worklet.port.onmessage = (event: MessageEvent): void => {
        if (event.data === WORKLET_FLUSHED) {
          this.onFlushed?.()
          return
        }
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

      this.watchTracks(this.stream)
      this.state = 'capturing'
    } catch (err) {
      await this.release()
      this.discard()
      throw new Error(describeCaptureFailure(err))
    }
  }

  /**
   * The server is listening: flush what was captured while the transport's start
   * was in flight, and stream live from here on. On a HALTED capture this is the
   * drain — the queue goes out and the capture is done.
   */
  arm(): void {
    if (this.state === 'idle') return
    this.armed = true
    const queued = this.pending
    this.pending = []
    for (const dataB64 of queued) this.sendAudio(dataB64)
    if (this.state === 'halted') this.state = 'idle'
  }

  /**
   * Close the microphone NOW, but keep what was captured.
   *
   * The tracks stop at once; the worklet's last partial batch is then fetched
   * before the graph is torn down (bounded by {@link WORKLET_FLUSH_TIMEOUT_MS}),
   * so a release does not clip the final syllable. If the capture was armed everything has already gone out and it is
   * done; if not, it waits `halted` for {@link arm} or {@link stop}. Idempotent;
   * a halt during `start()` cancels the start (there is nothing to keep yet).
   */
  async halt(): Promise<void> {
    if (this.halting) return this.halting
    if (this.state === 'idle' || this.state === 'halted') return
    if (this.state === 'starting') {
      // The start's own bail releases whatever it acquires after this point.
      this.state = 'idle'
      await this.release()
      return
    }
    this.state = 'halting'
    this.halting = (async () => {
      // The microphone goes off NOW — the recording indicator with it. The
      // worklet's partial batch is already in the worklet, so the tail can be
      // fetched after the track has stopped.
      this.stopTracks()
      await this.flushWorkletTail()
      await this.release()
      // Armed: every block, the tail included, has been sent. Otherwise the queue
      // waits for the transport's start to say where to send it.
      this.state = this.armed ? 'idle' : 'halted'
      if (this.armed) this.pending = []
    })()
    try {
      await this.halting
    } finally {
      this.halting = null
    }
  }

  /** Close the microphone and DISCARD anything not yet sent. Idempotent. */
  async stop(): Promise<void> {
    await this.halt()
    this.discard()
  }

  // -- Private ---------------------------------------------------------------

  private discard(): void {
    this.state = 'idle'
    this.armed = false
    this.pending = []
  }

  /**
   * Ask the worklet for its partial batch and wait for it. The answer arrives
   * on the same port as the blocks, after the tail block, so `onBlock` has
   * handled the tail by the time this resolves.
   */
  private async flushWorkletTail(): Promise<void> {
    const worklet = this.worklet
    if (!worklet) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, WORKLET_FLUSH_TIMEOUT_MS)
      function done(): void {
        clearTimeout(timer)
        resolve()
      }
      this.onFlushed = done
      try {
        worklet.port.postMessage('flush')
      } catch {
        done()
      }
    })
    this.onFlushed = null
  }

  /**
   * Tear the graph down and close the microphone. Leaves the state and the
   * queue alone — that is the caller's decision. Idempotent.
   */
  private async release(): Promise<void> {
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
    this.stopTracks()

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

  /** Close the microphone. Idempotent. */
  private stopTracks(): void {
    this.untrack?.()
    this.untrack = null
    for (const track of this.stream?.getTracks() ?? []) {
      try {
        track.stop()
      } catch {
        /* ignore */
      }
    }
    this.stream = null
  }

  /**
   * Report what happens to the microphone itself while capturing: `ended` (it
   * was unplugged, or the OS revoked it) and a SUSTAINED `mute` (the OS stopped
   * feeding it — a hardware switch, another app taking exclusive use). A mute is
   * only reported if it outlasts {@link MIC_MUTE_GRACE_MS} with the capture still
   * running; `unmute`, `ended` and the capture ending all cancel the wait. Our
   * own `track.stop()` fires none of these, and all are ignored outside
   * `capturing`.
   */
  private watchTracks(stream: MediaStream): void {
    const tracks = stream.getTracks()
    let muteTimer: ReturnType<typeof setTimeout> | null = null
    const cancelMute = (): void => {
      if (muteTimer) clearTimeout(muteTimer)
      muteTimer = null
    }
    const onEnded = (): void => {
      cancelMute()
      if (this.state === 'capturing') {
        this.onFault?.({ message: MIC_DISCONNECTED_MESSAGE, ended: true })
      }
    }
    const onMute = (event: Event): void => {
      if (this.state !== 'capturing' || muteTimer) return
      const track = event.target as MediaStreamTrack | null
      muteTimer = setTimeout(() => {
        muteTimer = null
        if (this.state !== 'capturing') return
        // `muted` is the track's live answer; a double without it is taken at its event.
        if (track && track.muted === false) return
        this.onFault?.({ message: MIC_MUTED_MESSAGE, ended: false })
      }, MIC_MUTE_GRACE_MS)
    }
    for (const track of tracks) {
      track.addEventListener?.('ended', onEnded)
      track.addEventListener?.('mute', onMute)
      track.addEventListener?.('unmute', cancelMute)
    }
    this.untrack = () => {
      cancelMute()
      for (const track of tracks) {
        track.removeEventListener?.('ended', onEnded)
        track.removeEventListener?.('mute', onMute)
        track.removeEventListener?.('unmute', cancelMute)
      }
    }
  }

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
    if ((this.state !== 'capturing' && this.state !== 'halting') || !this.resampler) return
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

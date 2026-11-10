/**
 * The on-device voice server — cli.js's voice-server protocol over loopback TCP,
 * answered by a local {@link Recognizer} (ADR-101 §2, docs/architecture/local-voice.md C4).
 *
 * Speaking cli.js's protocol is the whole point: `VoiceStreamClient`, the relay,
 * both capture owners, the pre-`ready` drain, the timeouts and the outcome
 * messages then serve opencode and pi sessions unchanged.
 *
 *   client → server   {"type":"voice_start","language":"en","token":"<hex>","preview":true}
 *                     {"type":"audio","data":"<base64 i16le 16 kHz mono>"}
 *                     {"type":"voice_stop"}
 *   server → client   {"type":"ready"}
 *                     {"type":"transcript","text":"…","isFinal":false|true}
 *                     {"type":"error","message":"…"}
 *                     {"type":"closed"}
 *
 * `token` and `preview` are this server's two additions; cli.js ignores both. The
 * token is a per-spawn secret the host passes through the environment: another
 * local user can reach 127.0.0.1, and what this port does is run a 0.8 GB model
 * on whatever audio it is sent. A missing or wrong token gets `unauthorized` and
 * a closed socket.
 *
 * One capture per connection. Audio accumulates as `Float32Array`s the server
 * allocated itself (see `recognizer.ts` on external buffers). While the button is
 * held, {@link previewDue} paces re-decodes of the uncommitted tail (with a short
 * lead-in before it for context) and
 * `preview.ts` folds them into the interim text; on `voice_stop` ONE decode of
 * the whole utterance (segments cut at quiet points past 60 s) produces the final
 * transcript, which replaces the interim.
 *
 * ## One recognizer, many connections
 *
 * The desktop window and any number of remote browsers share the worker, and the
 * recognizer is one native object, so every decode goes through {@link DecodeQueue}
 * — serialized, in arrival order. A preview therefore can wait behind another
 * capture's final pass; that costs a stale interim, never a wrong answer.
 *
 * ## Lifetime
 *
 * `onIdleExit` fires after {@link IDLE_EXIT_MS} with no AUTHENTICATED connection
 * (the worker's `main.ts` turns it into exit 0 and the ~0.8 GB comes back); a
 * capturing connection, however quiet, keeps it alive, while a peer that never
 * authenticates cannot (it is dropped after {@link PRE_AUTH_DEADLINE_MS} anyway).
 * The clock and timers are injected so tests drive time by hand.
 *
 * **Audio, transcripts and the token are never logged** — not in `log`, not on
 * stderr. A diagnostic here says THAT something failed, never what was said.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import * as net from 'node:net'
import * as readline from 'node:readline'
import {
  advancePreview,
  newPreviewState,
  previewDue,
  previewWindowStart,
  shiftWords,
  type PreviewState,
  type Word
} from './preview'
import { SAMPLE_RATE, type Recognizer } from './recognizer'
import { planSegments } from './segments'

/** The worker exits this long after its last connection closed. */
export const IDLE_EXIT_MS = 10 * 60_000
/** How often a live capture asks whether a preview is due; the pacing itself is {@link previewDue}'s. */
const PREVIEW_POLL_MS = 100
/**
 * Audio kept per capture. Five minutes is 19 MB of samples and, decoded in
 * 60 s segments (`segments.ts`), a bounded amount of recognizer memory; a held
 * button that never lets go (a stuck renderer) must not grow the worker without
 * bound.
 */
export const MAX_CAPTURE_SECONDS = 300

/**
 * A connection that has not sent a valid `voice_start` by this deadline is
 * dropped, and may send at most this much before it does. The port is loopback
 * but not private to us: without these a peer that connects and says nothing, or
 * streams garbage, would hold a socket (and the idle exit) forever.
 */
export const PRE_AUTH_DEADLINE_MS = 5_000
export const PRE_AUTH_MAX_BYTES = 64 * 1024
/** After `unauthorized` the socket is half-closed, then destroyed this much later. */
export const REJECT_LINGER_MS = 100

export const UNAUTHORIZED_MESSAGE = 'unauthorized'
export const TOO_LONG_MESSAGE = 'Recording is too long — the rest was not transcribed'
export const DECODE_FAILED_MESSAGE = 'Speech recognition failed'

/** Time, as the server needs it. Real in production; a hand-cranked fake in tests. */
export interface Clock {
  now(): number
  /** Returns the cancel function. */
  setInterval(fn: () => void, ms: number): () => void
  setTimeout(fn: () => void, ms: number): () => void
}

export const realClock: Clock = {
  now: () => Date.now(),
  setInterval: (fn, ms) => {
    const t = setInterval(fn, ms)
    return () => clearInterval(t)
  },
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms)
    return () => clearTimeout(t)
  }
}

export interface VoiceServerOptions {
  recognizer: Recognizer
  /** The per-spawn secret every `voice_start` must carry. */
  token: string
  /** Called once per idle period (see Lifetime). */
  onIdleExit: () => void
  clock?: Clock
  idleExitMs?: number
  /** Diagnostics: the fact of a failure, never audio, text or the token. */
  log?: (message: string) => void
}

export interface VoiceServer {
  /** Listen on 127.0.0.1 on an OS-chosen port; resolves with it. */
  listen(): Promise<number>
  close(): Promise<void>
}

/** Serializes decodes: a job starts when every earlier one has settled. */
class DecodeQueue {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(job: () => Promise<T>): Promise<T> {
    const result = this.tail.then(job)
    this.tail = result.catch(() => undefined)
    return result
  }
}

interface CaptureDeps {
  recognizer: Recognizer
  queue: DecodeQueue
  clock: Clock
  send: (msg: Record<string, unknown>) => void
  log: (message: string) => void
  preview: boolean
}

/** One connection's recording: its audio, its preview state, its final pass. */
class Capture {
  private chunks: Float32Array[] = []
  private samples = 0
  private tooLong = false

  private previewState: PreviewState = newPreviewState()
  private lastPreviewAt: number | null = null
  private decoding: Promise<void> | null = null
  private previewBroken = false
  /** Stopped or cancelled: nothing more is sent on the strength of a decode in flight. */
  private ended = false
  /**
   * The connection went away. Set by {@link Capture.cancel} only — `finish()` ends
   * a capture too, but its final pass still has to run. Queued decodes check it
   * when their turn comes, so a dead connection's jobs cost the recognizer nothing.
   */
  private cancelled = false
  private cancelPoll: (() => void) | null = null

  constructor(private readonly deps: CaptureDeps) {
    if (deps.preview) {
      this.cancelPoll = deps.clock.setInterval(() => this.maybePreview(), PREVIEW_POLL_MS)
    }
  }

  /** One decoded wire frame: i16le mono 16 kHz bytes. A dangling odd byte is dropped. */
  push(pcm: Buffer): void {
    const n = pcm.length >> 1
    if (n === 0 || this.ended) return
    if (this.samples + n > MAX_CAPTURE_SECONDS * SAMPLE_RATE) {
      if (!this.tooLong) {
        this.tooLong = true
        this.deps.send({ type: 'error', message: TOO_LONG_MESSAGE })
      }
      return
    }
    const f32 = new Float32Array(n)
    for (let i = 0; i < n; i++) f32[i] = pcm.readInt16LE(i * 2) / 32768
    this.chunks.push(f32)
    this.samples += n
  }

  /** The audio from sample `from` to the live edge, in one fresh array. */
  private audioFrom(from: number): Float32Array {
    const out = new Float32Array(Math.max(0, this.samples - from))
    let chunkStart = 0
    for (const chunk of this.chunks) {
      const chunkEnd = chunkStart + chunk.length
      if (chunkEnd > from) {
        const skip = Math.max(0, from - chunkStart)
        out.set(chunk.subarray(skip), chunkStart + skip - from)
      }
      chunkStart = chunkEnd
    }
    return out
  }

  private maybePreview(): void {
    if (
      this.ended ||
      this.previewBroken ||
      !previewDue({
        now: this.deps.clock.now(),
        lastPreviewAt: this.lastPreviewAt,
        decoding: this.decoding !== null,
        audioSeconds: this.samples / SAMPLE_RATE
      })
    ) {
      return
    }
    this.lastPreviewAt = this.deps.clock.now()
    this.decoding = this.runPreview()
  }

  /**
   * One decode on the shared queue. Null when the capture was cancelled by the
   * time the job's turn came: the recognizer is not touched.
   */
  private decodeQueued(samples: Float32Array): Promise<{ text: string; words: Word[] } | null> {
    const { recognizer, queue } = this.deps
    return queue.run(async () => (this.cancelled ? null : recognizer.decode(samples)))
  }

  private async runPreview(): Promise<void> {
    const { send, log } = this.deps
    const edge = this.samples / SAMPLE_RATE
    // The window starts on a sample boundary, and the hypothesis is shifted by
    // exactly that, so word times stay consistent from one window to the next.
    // It starts a lead-in before the commit point; advancePreview drops those words.
    const startSample = Math.floor(previewWindowStart(this.previewState) * SAMPLE_RATE)
    const window = this.audioFrom(startSample)
    try {
      const result = await this.decodeQueued(window)
      if (!result || this.ended) return
      const next = advancePreview(
        this.previewState,
        shiftWords(result.words, startSample / SAMPLE_RATE),
        edge
      )
      this.previewState = next.state
      if (next.text) send({ type: 'transcript', text: next.text, isFinal: false })
    } catch (err) {
      // A preview is a courtesy: stop previewing this capture, keep the audio.
      // The final pass reports a real recognizer failure itself.
      this.previewBroken = true
      log(`preview decode failed: ${errorName(err)}`)
    } finally {
      this.decoding = null
    }
  }

  /**
   * `voice_stop`: the final pass, then `closed`. One decode of the whole take up
   * to 60 s; a longer take is decoded in segments cut at quiet
   * points (`segments.ts` says why), each its own queued job so other captures
   * can interleave, and the texts are joined with spaces.
   */
  async finish(): Promise<void> {
    const { send, log } = this.deps
    this.ended = true
    this.cancelPoll?.()
    if (this.decoding) await this.decoding
    if (this.cancelled) return
    if (this.samples > 0) {
      const all = this.audioFrom(0)
      try {
        const texts: string[] = []
        for (const seg of planSegments(all)) {
          const piece = seg.end - seg.start === all.length ? all : all.slice(seg.start, seg.end)
          const result = await this.decodeQueued(piece)
          if (!result) return
          if (result.text) texts.push(result.text)
        }
        const text = texts.join(' ')
        if (text) send({ type: 'transcript', text, isFinal: true })
      } catch (err) {
        log(`final decode failed: ${errorName(err)}`)
        send({ type: 'error', message: DECODE_FAILED_MESSAGE })
      }
    }
    send({ type: 'closed' })
  }

  /** The connection went away: stop pacing previews and let in-flight work drop its result. */
  cancel(): void {
    this.ended = true
    this.cancelled = true
    this.cancelPoll?.()
  }
}

/** An error's class and code — enough to diagnose, nothing that could hold content. */
function errorName(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code
    return code ? `${err.name} (${code})` : err.name
  }
  return typeof err
}

const digest = (s: string): Buffer => createHash('sha256').update(s).digest()

export function createVoiceServer(options: VoiceServerOptions): VoiceServer {
  const { recognizer, onIdleExit } = options
  const clock = options.clock ?? realClock
  const idleExitMs = options.idleExitMs ?? IDLE_EXIT_MS
  const log = options.log ?? (() => {})
  // Compared as fixed-length digests: `timingSafeEqual` needs equal lengths, and
  // hashing first means the length of a guess is not observable either.
  const expected = digest(options.token)
  const tokenOk = (given: unknown): boolean =>
    typeof given === 'string' && timingSafeEqual(digest(given), expected)

  const queue = new DecodeQueue()
  const sockets = new Set<net.Socket>()
  /** Connections past the token check. Only these keep the worker alive. */
  let authenticated = 0
  let cancelIdle: (() => void) | null = null
  let closing = false

  const armIdle = (): void => {
    if (closing) return
    cancelIdle?.()
    cancelIdle = clock.setTimeout(onIdleExit, idleExitMs)
  }
  const disarmIdle = (): void => {
    cancelIdle?.()
    cancelIdle = null
  }

  const server = net.createServer((sock) => {
    sockets.add(sock)

    const send = (msg: Record<string, unknown>): void => {
      if (sock.writable) sock.write(JSON.stringify(msg) + '\n')
    }
    const rl = readline.createInterface({ input: sock })
    // Same defusing as the client's: readline re-emits socket errors on itself.
    rl.on('error', () => {})
    sock.on('error', (err) => log(`connection error: ${errorName(err)}`))

    let capture: Capture | null = null
    let started = false
    let finishing = false
    let isAuthenticated = false
    let rejected = false
    let preAuthBytes = 0

    // Until a valid `voice_start`: a deadline, and a cap on what may be sent.
    let cancelDeadline: (() => void) | null = clock.setTimeout(
      () => sock.destroy(),
      PRE_AUTH_DEADLINE_MS
    )
    let cancelLinger: (() => void) | null = null
    // Attached after readline's own listener, so a valid first line authenticates
    // before its bytes are counted against the cap.
    sock.on('data', (chunk: Buffer) => {
      if (isAuthenticated || rejected) return
      preAuthBytes += chunk.length
      if (preAuthBytes > PRE_AUTH_MAX_BYTES) sock.destroy()
    })

    rl.on('line', (line) => {
      if (rejected) return
      let msg: Record<string, unknown>
      try {
        const parsed: unknown = JSON.parse(line)
        if (typeof parsed !== 'object' || parsed === null) return
        msg = parsed as Record<string, unknown>
      } catch {
        return
      }

      switch (msg.type) {
        case 'voice_start':
          // One capture per connection; a repeated start is noise.
          if (started) return
          started = true
          cancelDeadline?.()
          cancelDeadline = null
          if (!tokenOk(msg.token)) {
            rejected = true
            send({ type: 'error', message: UNAUTHORIZED_MESSAGE })
            // Half-close first: unread audio behind this line would turn an
            // immediate destroy into a reset that can eat the error before the
            // client reads it. Then destroy, so a peer that keeps its side open
            // cannot hold the socket.
            sock.end()
            cancelLinger = clock.setTimeout(() => sock.destroy(), REJECT_LINGER_MS)
            return
          }
          isAuthenticated = true
          authenticated++
          disarmIdle()
          capture = new Capture({
            recognizer,
            queue,
            clock,
            send,
            log,
            preview: msg.preview !== false
          })
          send({ type: 'ready' })
          break

        case 'audio':
          if (capture && !finishing && typeof msg.data === 'string') {
            capture.push(Buffer.from(msg.data, 'base64'))
          }
          break

        case 'voice_stop':
          if (capture && !finishing) {
            finishing = true
            void capture.finish().then(() => sock.end())
          }
          break

        default:
          break
      }
    })

    sock.on('close', () => {
      cancelDeadline?.()
      cancelLinger?.()
      capture?.cancel()
      rl.close()
      sockets.delete(sock)
      if (isAuthenticated && --authenticated === 0) armIdle()
    })
  })

  return {
    listen: () =>
      new Promise<number>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject)
          armIdle()
          resolve((server.address() as net.AddressInfo).port)
        })
      }),
    close: () =>
      new Promise<void>((resolve) => {
        closing = true
        disarmIdle()
        for (const sock of sockets) sock.destroy()
        server.close(() => resolve())
      })
  }
}

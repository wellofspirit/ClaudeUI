/**
 * The opencode 2.x event feed (`GET /api/event`, ADR-097 §7) as an async
 * stream: SSE framing, the curated event union, and reconnects the CONSUMER
 * is told about.
 *
 * Wire facts (opencode v2.0.24, `vendor/opencode-src`):
 * - `packages/server/src/handlers/event.ts`: the first frame of every
 *   subscription is `server.connected`, sent after the server-side subscriber
 *   is registered — so once it arrives, nothing published later can be missed
 *   on this connection. A `: heartbeat` comment follows every 15 s.
 * - `packages/server/src/event-feed.ts`: each frame is `data: <json>\n\n`; a
 *   subscriber that falls 4 096 frames behind is failed (the stream ends).
 * - There is NO replay: no `Last-Event-ID`, no cursor. Text/reasoning deltas,
 *   usage, tool progress, permission and form events are ephemeral
 *   (`EVENT_DURABILITY`), so what happened while disconnected is gone.
 *
 * THE RECONNECT CONTRACT: `subscribeOpencodeEvents` reconnects on its own, and
 * yields `{kind:'connected', reconnected:true}` before the first event of
 * every connection after the first. A consumer that keeps state from events
 * MUST re-read that state when it sees it (`session.message.list`,
 * `session.permission.list`, `session.form.list`, `session.inbox.list`,
 * `session.active`), because events from the gap never arrive. The marker
 * comes after the new subscription is live, so a read made on it cannot fall
 * into a second gap; events arriving after it may already be reflected in the
 * read, so applying them must be idempotent (ids are stable).
 *
 * Backpressure is the server's: the stream is read only while the consumer
 * pulls. A consumer slow enough to fall 4 096 frames behind gets failed
 * server-side, which arrives here as a drop → reconnect → `reconnected:true`.
 */
import {
  isOpencodeEvent,
  type OpencodeEvent,
  type ServerConnectedEvent
} from './protocol-v2/events'

// --- SSE framing ------------------------------------------------------------

/** One dispatched SSE message (comments and empty-data blocks never become one). */
export interface SseFrame {
  readonly data: string
  readonly event?: string
  readonly id?: string
}

/**
 * Incremental SSE parser (WHATWG `text/event-stream` rules): lines end in LF,
 * CRLF or CR; `data:` lines of one block join with `\n`; one leading space
 * after the colon is dropped; `:` lines are comments (heartbeats); a blank
 * line dispatches. `retry:` and unknown fields are ignored.
 */
export class SseParser {
  private buffer = ''
  private data: string[] = []
  private event: string | undefined
  private id: string | undefined
  /** A chunk ended in CR: a following LF belongs to the same line ending. */
  private pendingCR = false

  push(chunk: string): SseFrame[] {
    let text = chunk
    if (this.pendingCR && text.startsWith('\n')) text = text.slice(1)
    this.pendingCR = text.endsWith('\r')
    this.buffer += text
    const frames: SseFrame[] = []
    const lines = this.buffer.split(/\r\n|\r|\n/)
    this.buffer = lines.pop() ?? ''
    for (const line of lines) {
      const frame = this.line(line)
      if (frame) frames.push(frame)
    }
    return frames
  }

  private line(line: string): SseFrame | null {
    if (line === '') {
      const frame =
        this.data.length > 0
          ? {
              data: this.data.join('\n'),
              ...(this.event !== undefined ? { event: this.event } : {}),
              ...(this.id !== undefined ? { id: this.id } : {})
            }
          : null
      this.data = []
      this.event = undefined
      return frame
    }
    if (line.startsWith(':')) return null
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') this.data.push(value)
    else if (field === 'event') this.event = value
    else if (field === 'id') this.id = value
    return null
  }
}

/**
 * A frame's payload as a curated event, or null: not JSON, not an object with
 * a string `type`, or a type ClaudeUI does not consume (`rpc.*`, `worktree.*`,
 * anything a newer server adds) — those are ignored, never an error.
 */
export function decodeOpencodeEvent(frame: SseFrame): OpencodeEvent | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(frame.data)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  return isOpencodeEvent(parsed as { type?: unknown }) ? (parsed as OpencodeEvent) : null
}

// --- Errors -----------------------------------------------------------------

export type OpencodeStreamFailure =
  /** The server answered the subscribe with a non-2xx status. */
  | 'http'
  /** fetch / the body read failed (connection refused, reset, …). */
  | 'transport'
  /** No byte for `stallTimeoutMs` while we were reading — a half-open socket. */
  | 'stall'
  /** The server ended the stream (overflowed subscriber, shutdown). */
  | 'closed'
  /** `maxConsecutiveFailures` attempts in a row never reached `server.connected`. */
  | 'gave-up'

export class OpencodeStreamError extends Error {
  override readonly name = 'OpencodeStreamError'
  constructor(
    readonly failure: OpencodeStreamFailure,
    message: string,
    readonly status?: number,
    options?: { cause?: unknown }
  ) {
    super(message, options)
  }
}

// --- One connection ---------------------------------------------------------

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>

export interface EventEndpoint {
  readonly baseUrl: string
  readonly authHeader: string
  readonly fetch?: FetchFn
}

export interface ConnectOptions {
  readonly signal?: AbortSignal
  /**
   * Fail the connection when no byte arrives for this long while we are
   * reading. The server heartbeats every 15 s, so the default (45 s) is three
   * missed heartbeats. `<= 0` disables.
   */
  readonly stallTimeoutMs?: number
}

export const EVENT_PATH = '/api/event'
export const DEFAULT_STALL_TIMEOUT_MS = 45_000

/**
 * ONE subscription. Yields every curated event, `server.connected` first.
 * Returns when `signal` aborts. Throws `OpencodeStreamError` on a non-2xx
 * answer, a transport failure, a stall, or the server ending the stream (to a
 * subscriber, an ended event stream is always a lost one).
 */
export async function* openOpencodeEventStream(
  endpoint: EventEndpoint,
  options: ConnectOptions = {}
): AsyncGenerator<OpencodeEvent, void, undefined> {
  const { signal } = options
  if (signal?.aborted) return
  const stallMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS
  const controller = new AbortController()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  // Abort the fetch AND cancel the reader: a pending read then settles even
  // with a fetch that does not error its body on abort.
  const stop = (): void => {
    controller.abort()
    reader?.cancel().catch(() => {})
  }
  signal?.addEventListener('abort', stop, { once: true })
  let stalled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = (): void => {
    if (stallMs <= 0) return
    timer = setTimeout(() => {
      stalled = true
      stop()
    }, stallMs)
  }
  const disarm = (): void => {
    if (timer) clearTimeout(timer)
    timer = undefined
  }
  /** What a throw means: null for the caller's own abort (the stream just ends). */
  const failure = (err: unknown): OpencodeStreamError | null => {
    if (signal?.aborted) return null
    if (err instanceof OpencodeStreamError) return err
    if (stalled)
      return new OpencodeStreamError('stall', `opencode event stream silent for ${stallMs} ms`)
    return new OpencodeStreamError(
      'transport',
      `opencode event stream failed: ${err instanceof Error ? err.message : String(err)}`,
      undefined,
      { cause: err }
    )
  }

  try {
    let response: Response
    arm()
    try {
      response = await (endpoint.fetch ?? fetch)(endpoint.baseUrl.replace(/\/$/, '') + EVENT_PATH, {
        method: 'GET',
        headers: {
          authorization: endpoint.authHeader,
          accept: 'text/event-stream',
          'cache-control': 'no-cache'
        },
        signal: controller.signal
      })
    } finally {
      disarm()
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new OpencodeStreamError(
        'http',
        `opencode GET ${EVENT_PATH} → ${response.status}: ${text.slice(0, 300)}`,
        response.status
      )
    }
    if (!response.body)
      throw new OpencodeStreamError('transport', 'opencode event stream has no body')
    reader = response.body.getReader()
    const decoder = new TextDecoder()
    const parser = new SseParser()
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>
      arm()
      try {
        chunk = await reader.read()
      } finally {
        disarm()
      }
      if (chunk.done) {
        if (signal?.aborted || stalled) break
        throw new OpencodeStreamError('closed', 'opencode closed the event stream')
      }
      for (const frame of parser.push(decoder.decode(chunk.value, { stream: true }))) {
        const event = decodeOpencodeEvent(frame)
        if (!event) continue
        yield event
        if (signal?.aborted) return
      }
    }
    // Only a stall or the caller's abort leaves the loop; an aborted read may
    // resolve `done` instead of rejecting.
    if (stalled && !signal?.aborted)
      throw new OpencodeStreamError('stall', `opencode event stream silent for ${stallMs} ms`)
  } catch (err) {
    const mapped = failure(err)
    if (mapped) throw mapped
  } finally {
    disarm()
    signal?.removeEventListener('abort', stop)
    stop()
  }
}

// --- Reconnecting feed ------------------------------------------------------

export type OpencodeFeedItem =
  /**
   * The subscription is live (`server.connected` arrived). `reconnected:true`
   * = there was a gap before it: re-read state (see the file header).
   */
  | { readonly kind: 'connected'; readonly reconnected: boolean; readonly connection: number }
  | { readonly kind: 'event'; readonly event: Exclude<OpencodeEvent, ServerConnectedEvent> }
  /**
   * The connection failed or dropped; the next attempt starts in `retryInMs`.
   * `failures` counts attempts in a row without a `server.connected`.
   */
  | {
      readonly kind: 'disconnected'
      readonly error: OpencodeStreamError
      readonly retryInMs: number
      readonly failures: number
    }

export interface SubscribeOptions extends ConnectOptions {
  /** First retry delay; doubles per consecutive failure up to `maxRetryDelayMs`. Default 250. */
  readonly initialRetryDelayMs?: number
  /** Default 5 000. */
  readonly maxRetryDelayMs?: number
  /**
   * Attempts in a row that never reach `server.connected` before the feed
   * throws `OpencodeStreamError('gave-up')`. A connection that did connect
   * resets the count. Default 8 (about 20 s of a server that is gone).
   * `Infinity` retries until `signal` aborts.
   */
  readonly maxConsecutiveFailures?: number
  /** Test seam. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

/**
 * The event feed, reconnecting. Ends (returns) only when `signal` aborts;
 * throws when the server refuses the subscription with a 4xx other than
 * 408/429 (wrong password: the server is not the one we spawned — retrying
 * cannot help) or after `maxConsecutiveFailures`.
 */
export async function* subscribeOpencodeEvents(
  endpoint: EventEndpoint,
  options: SubscribeOptions = {}
): AsyncGenerator<OpencodeFeedItem, void, undefined> {
  const { signal } = options
  const initial = options.initialRetryDelayMs ?? 250
  const ceiling = options.maxRetryDelayMs ?? 5_000
  const maxFailures = options.maxConsecutiveFailures ?? 8
  const sleep = options.sleep ?? abortableSleep
  let connection = 0
  let failures = 0
  while (!signal?.aborted) {
    let connected = false
    let error: OpencodeStreamError | null = null
    try {
      for await (const event of openOpencodeEventStream(endpoint, options)) {
        if (event.type === 'server.connected') {
          if (connected) continue
          connected = true
          failures = 0
          connection++
          yield { kind: 'connected', reconnected: connection > 1, connection }
          continue
        }
        // Defensive: nothing precedes server.connected on the wire.
        if (!connected) continue
        yield { kind: 'event', event }
      }
    } catch (err) {
      error =
        err instanceof OpencodeStreamError
          ? err
          : new OpencodeStreamError('transport', String(err), undefined, { cause: err })
    }
    if (signal?.aborted) return
    error ??= new OpencodeStreamError('closed', 'opencode closed the event stream')
    if (
      error.failure === 'http' &&
      error.status !== undefined &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 408 &&
      error.status !== 429
    )
      throw error
    failures++
    if (failures >= maxFailures)
      throw new OpencodeStreamError(
        'gave-up',
        `opencode event stream: ${failures} attempts in a row failed (last: ${error.message})`,
        error.status,
        { cause: error }
      )
    const retryInMs = Math.min(ceiling, initial * 2 ** (failures - 1))
    yield { kind: 'disconnected', error, retryInMs, failures }
    await sleep(retryInMs, signal)
  }
}

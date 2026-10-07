/**
 * @vitest-environment node
 *
 * The opencode 2.x event feed: SSE framing, curated-event filtering, one
 * connection's failure modes, and the reconnecting feed's contract (the
 * consumer is TOLD it reconnected, because 2.x has no replay).
 */
import { describe, expect, it, vi } from 'vitest'
import {
  OpencodeStreamError,
  SseParser,
  decodeOpencodeEvent,
  openOpencodeEventStream,
  subscribeOpencodeEvents,
  type FetchFn,
  type SseFrame,
  type OpencodeFeedItem
} from '../opencode-event-stream'
import type { OpencodeEvent } from '../protocol-v2/events'

// --- Fakes ------------------------------------------------------------------

const BASE = 'http://127.0.0.1:4096'
const AUTH = 'Basic b3BlbmNvZGU6cHc='

const connected = { id: 'evt_c', type: 'server.connected', data: {} }
const delta = (n: number) => ({
  id: `evt_${n}`,
  type: 'session.text.delta',
  created: n,
  location: { directory: '/w' },
  data: { sessionID: 'ses_1', delta: `d${n}` }
})
const frame = (event: object) => `data: ${JSON.stringify(event)}\n\n`

type Ending = 'close' | 'hang' | 'error'

/**
 * A streamed response: `chunks` in order, then `ending`. The body errors when
 * the request's signal aborts (as undici's does).
 */
function sseResponse(chunks: string[], ending: Ending, signal?: AbortSignal | null): Response {
  const encoder = new TextEncoder()
  let i = 0
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener('abort', () => {
        try {
          controller.error(new DOMException('aborted', 'AbortError'))
        } catch {
          // already closed
        }
      })
    },
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i++]))
        return
      }
      if (ending === 'close') controller.close()
      else if (ending === 'error') controller.error(new TypeError('socket hang up'))
      // 'hang': never settle
      return ending === 'hang' ? new Promise<void>(() => {}) : undefined
    }
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** One scripted answer per connection attempt. */
type Script = { status: number; text?: string } | { chunks: string[]; ending: Ending } | Error

function scriptedFetch(scripts: Script[]) {
  const calls: { url: string; init?: RequestInit }[] = []
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, init })
    const script = scripts[Math.min(calls.length - 1, scripts.length - 1)]
    if (script instanceof Error) throw script
    if ('status' in script) return new Response(script.text ?? '', { status: script.status })
    return sseResponse(script.chunks, script.ending, init?.signal)
  }
  return { fetchFn, calls }
}

async function collect<T>(
  gen: AsyncGenerator<T>,
  max = 50
): Promise<{ items: T[]; error?: unknown }> {
  const items: T[] = []
  try {
    for await (const item of gen) {
      items.push(item)
      if (items.length >= max) break
    }
  } catch (error) {
    return { items, error }
  }
  return { items }
}

// --- SSE framing ------------------------------------------------------------

describe('SseParser', () => {
  it('joins multi-line data with \\n and strips one leading space', () => {
    const parser = new SseParser()
    expect(parser.push('data: {"a":\ndata:  1}\n\n')).toEqual([{ data: '{"a":\n 1}' }])
  })

  it('dispatches only on a blank line, across arbitrary chunk splits', () => {
    const parser = new SseParser()
    const text = frame(delta(1)) + frame(delta(2))
    const frames: SseFrame[] = []
    for (const ch of text) frames.push(...parser.push(ch))
    expect(frames.map((f) => JSON.parse(f.data).id)).toEqual(['evt_1', 'evt_2'])
  })

  it('accepts CRLF and lone CR line endings, including a CRLF split across chunks', () => {
    const parser = new SseParser()
    expect([
      ...parser.push('data: a\r'),
      ...parser.push('\n\r'),
      ...parser.push('\ndata: b\r\r')
    ]).toEqual([{ data: 'a' }, { data: 'b' }])
  })

  it('ignores comments (heartbeats), retry, unknown fields and empty-data blocks', () => {
    const parser = new SseParser()
    expect(parser.push(': heartbeat\n\nretry: 10\nfoo: bar\n\nevent: x\n\n')).toEqual([])
  })

  it('carries event and id fields', () => {
    expect(new SseParser().push('event: e\nid: 7\ndata: x\n\n')).toEqual([
      { data: 'x', event: 'e', id: '7' }
    ])
  })
})

describe('decodeOpencodeEvent', () => {
  it('keeps curated types and drops unknown, rpc.*, non-JSON and non-object frames', () => {
    expect(decodeOpencodeEvent({ data: JSON.stringify(delta(1)) })?.type).toBe('session.text.delta')
    expect(
      decodeOpencodeEvent({ data: JSON.stringify({ type: 'worktree.ready', data: {} }) })
    ).toBeNull()
    expect(
      decodeOpencodeEvent({ data: JSON.stringify({ type: 'rpc.claudeui', data: {} }) })
    ).toBeNull()
    expect(decodeOpencodeEvent({ data: 'not json' })).toBeNull()
    expect(decodeOpencodeEvent({ data: '"text"' })).toBeNull()
    expect(decodeOpencodeEvent({ data: JSON.stringify({ data: {} }) })).toBeNull()
  })
})

// --- One connection ---------------------------------------------------------

describe('openOpencodeEventStream', () => {
  it('GETs /api/event with auth and yields server.connected then curated events only', async () => {
    const { fetchFn, calls } = scriptedFetch([
      {
        chunks: [
          frame(connected),
          ': heartbeat\n\n',
          frame({ id: 'e', type: 'rpc.claudeui-xeng.x', data: {} }),
          frame(delta(1)).slice(0, 20),
          frame(delta(1)).slice(20)
        ],
        ending: 'hang'
      }
    ])
    const ac = new AbortController()
    const seen: OpencodeEvent[] = []
    for await (const event of openOpencodeEventStream(
      { baseUrl: BASE + '/', authHeader: AUTH, fetch: fetchFn },
      { signal: ac.signal }
    )) {
      seen.push(event)
      if (seen.length === 2) ac.abort()
    }
    expect(seen.map((e) => e.type)).toEqual(['server.connected', 'session.text.delta'])
    expect(calls[0].url).toBe(`${BASE}/api/event`)
    expect((calls[0].init?.headers as Record<string, string>).authorization).toBe(AUTH)
    expect((calls[0].init?.headers as Record<string, string>).accept).toBe('text/event-stream')
  })

  it('a caller abort ends the stream quietly (no throw)', async () => {
    const { fetchFn } = scriptedFetch([{ chunks: [frame(connected)], ending: 'hang' }])
    const ac = new AbortController()
    const gen = openOpencodeEventStream(
      { baseUrl: BASE, authHeader: AUTH, fetch: fetchFn },
      { signal: ac.signal }
    )
    expect((await gen.next()).value?.type).toBe('server.connected')
    const pending = gen.next()
    ac.abort()
    await expect(pending).resolves.toEqual({ done: true, value: undefined })
  })

  it('throws http with the status on a non-2xx answer', async () => {
    const { fetchFn } = scriptedFetch([{ status: 401, text: 'nope' }])
    const { error } = await collect(
      openOpencodeEventStream({ baseUrl: BASE, authHeader: AUTH, fetch: fetchFn })
    )
    expect(error).toBeInstanceOf(OpencodeStreamError)
    expect(error).toMatchObject({ failure: 'http', status: 401 })
  })

  it('a server-side end of stream is a failure (closed), not a normal end', async () => {
    const { fetchFn } = scriptedFetch([{ chunks: [frame(connected)], ending: 'close' }])
    const { items, error } = await collect(
      openOpencodeEventStream({ baseUrl: BASE, authHeader: AUTH, fetch: fetchFn })
    )
    expect(items).toHaveLength(1)
    expect(error).toMatchObject({ failure: 'closed' })
  })

  it('a transport error mid-stream is a transport failure', async () => {
    const { fetchFn } = scriptedFetch([{ chunks: [frame(connected)], ending: 'error' }])
    const { error } = await collect(
      openOpencodeEventStream({ baseUrl: BASE, authHeader: AUTH, fetch: fetchFn })
    )
    expect(error).toMatchObject({ failure: 'transport' })
  })

  it('a silent socket fails as a stall after stallTimeoutMs (heartbeats keep it alive)', async () => {
    const { fetchFn } = scriptedFetch([{ chunks: [frame(connected)], ending: 'hang' }])
    const started = Date.now()
    const { items, error } = await collect(
      openOpencodeEventStream(
        { baseUrl: BASE, authHeader: AUTH, fetch: fetchFn },
        { stallTimeoutMs: 40 }
      )
    )
    expect(items.map((e) => e.type)).toEqual(['server.connected'])
    expect(error).toMatchObject({ failure: 'stall' })
    expect(Date.now() - started).toBeGreaterThanOrEqual(35)
  })

  it('does not count consumer time as silence (the timer runs only while reading)', async () => {
    const { fetchFn } = scriptedFetch([
      { chunks: [frame(connected), frame(delta(1))], ending: 'close' }
    ])
    const gen = openOpencodeEventStream(
      { baseUrl: BASE, authHeader: AUTH, fetch: fetchFn },
      { stallTimeoutMs: 30 }
    )
    expect((await gen.next()).value?.type).toBe('server.connected')
    await new Promise((r) => setTimeout(r, 80)) // a slow consumer
    expect((await gen.next()).value?.type).toBe('session.text.delta')
    await expect(gen.next()).rejects.toMatchObject({ failure: 'closed' })
  })
})

// --- Reconnecting feed ------------------------------------------------------

describe('subscribeOpencodeEvents', () => {
  const kinds = (items: OpencodeFeedItem[]) =>
    items.map((item) =>
      item.kind === 'event'
        ? `event:${item.event.id}`
        : item.kind === 'connected'
          ? `connected:${item.reconnected}`
          : `disconnected:${item.error.failure}:${item.retryInMs}`
    )

  it('tells the consumer it reconnected after a server-side drop (no replay → re-read state)', async () => {
    const { fetchFn, calls } = scriptedFetch([
      { chunks: [frame(connected), frame(delta(1))], ending: 'close' },
      { chunks: [frame(connected), frame(delta(2))], ending: 'hang' }
    ])
    const sleeps: number[] = []
    const ac = new AbortController()
    const items: OpencodeFeedItem[] = []
    for await (const item of subscribeOpencodeEvents(
      { baseUrl: BASE, authHeader: AUTH, fetch: fetchFn },
      { signal: ac.signal, sleep: async (ms) => void sleeps.push(ms) }
    )) {
      items.push(item)
      if (item.kind === 'event' && item.event.id === 'evt_2') ac.abort()
    }
    expect(kinds(items)).toEqual([
      'connected:false',
      'event:evt_1',
      'disconnected:closed:250',
      'connected:true',
      'event:evt_2'
    ])
    expect(items[3]).toMatchObject({ kind: 'connected', reconnected: true, connection: 2 })
    expect(sleeps).toEqual([250])
    expect(calls).toHaveLength(2)
  })

  it('backs off exponentially up to the cap while the server is unreachable, then resets on connect', async () => {
    const refused = new TypeError('fetch failed')
    const { fetchFn } = scriptedFetch([
      refused,
      refused,
      refused,
      refused,
      refused,
      { chunks: [frame(connected)], ending: 'close' },
      { chunks: [frame(connected)], ending: 'hang' }
    ])
    const sleeps: number[] = []
    const ac = new AbortController()
    const items: OpencodeFeedItem[] = []
    for await (const item of subscribeOpencodeEvents(
      { baseUrl: BASE, authHeader: AUTH, fetch: fetchFn },
      { signal: ac.signal, maxRetryDelayMs: 2_000, sleep: async (ms) => void sleeps.push(ms) }
    )) {
      items.push(item)
      if (item.kind === 'connected' && item.connection === 2) ac.abort()
    }
    // 5 refusals: 250, 500, 1000, 2000 (cap), 2000; then a connect resets the count.
    expect(sleeps).toEqual([250, 500, 1000, 2000, 2000, 250])
    expect(
      items
        .filter((i) => i.kind === 'connected')
        .map((i) => i.kind === 'connected' && i.reconnected)
    ).toEqual([false, true])
    const firstDrop = items.find((i) => i.kind === 'disconnected')
    expect(firstDrop).toMatchObject({ failures: 1, error: { failure: 'transport' } })
  })

  it('gives up after maxConsecutiveFailures attempts that never connect', async () => {
    const { fetchFn, calls } = scriptedFetch([new TypeError('fetch failed')])
    const { items, error } = await collect(
      subscribeOpencodeEvents(
        { baseUrl: BASE, authHeader: AUTH, fetch: fetchFn },
        { maxConsecutiveFailures: 3, sleep: async () => {} }
      )
    )
    expect(kinds(items)).toEqual(['disconnected:transport:250', 'disconnected:transport:500'])
    expect(error).toMatchObject({ failure: 'gave-up' })
    expect(calls).toHaveLength(3)
  })

  it('does not retry a 401 (wrong password: not the server we spawned)', async () => {
    const { fetchFn, calls } = scriptedFetch([{ status: 401 }])
    const { items, error } = await collect(
      subscribeOpencodeEvents(
        { baseUrl: BASE, authHeader: AUTH, fetch: fetchFn },
        { sleep: async () => {} }
      )
    )
    expect(items).toEqual([])
    expect(error).toMatchObject({ failure: 'http', status: 401 })
    expect(calls).toHaveLength(1)
  })

  it('retries a 5xx', async () => {
    const { fetchFn } = scriptedFetch([
      { status: 503 },
      { chunks: [frame(connected)], ending: 'hang' }
    ])
    const ac = new AbortController()
    const items: OpencodeFeedItem[] = []
    for await (const item of subscribeOpencodeEvents(
      { baseUrl: BASE, authHeader: AUTH, fetch: fetchFn },
      { signal: ac.signal, sleep: async () => {} }
    )) {
      items.push(item)
      if (item.kind === 'connected') ac.abort()
    }
    expect(kinds(items)).toEqual(['disconnected:http:250', 'connected:false'])
  })

  it('an abort during the backoff ends the feed without another attempt', async () => {
    const { fetchFn, calls } = scriptedFetch([new TypeError('fetch failed')])
    const ac = new AbortController()
    const items: OpencodeFeedItem[] = []
    for await (const item of subscribeOpencodeEvents(
      { baseUrl: BASE, authHeader: AUTH, fetch: fetchFn },
      { signal: ac.signal, initialRetryDelayMs: 60_000, maxRetryDelayMs: 60_000 }
    )) {
      items.push(item)
      setTimeout(() => ac.abort(), 5)
    }
    expect(kinds(items)).toEqual(['disconnected:transport:60000'])
    expect(calls).toHaveLength(1)
  })

  it('breaking out of the loop cancels the open connection', async () => {
    const aborted = vi.fn()
    const fetchFn: FetchFn = async (_url, init) => {
      init?.signal?.addEventListener('abort', aborted)
      return sseResponse([frame(connected)], 'hang', init?.signal)
    }
    for await (const item of subscribeOpencodeEvents({
      baseUrl: BASE,
      authHeader: AUTH,
      fetch: fetchFn
    })) {
      expect(item.kind).toBe('connected')
      break
    }
    expect(aborted).toHaveBeenCalled()
  })
})

import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { OpencodeServerManager } from '../OpencodeServerManager'
import type { SpawnResult, SpawnServerFn } from '../OpencodeServerManager'

// ── Fake spawn harness ─────────────────────────────────────────────────────────
//
// A fake ChildProcess (EventEmitter) whose kill() flips a flag and emits 'exit'
// so the manager's unexpected-death cleanup runs exactly as it would in prod.

interface FakeChild extends ChildProcess {
  killed: boolean
}

function makeFakeChild(): FakeChild {
  const emitter = new EventEmitter() as unknown as FakeChild
  ;(emitter as { killed: boolean }).killed = false
  emitter.kill = ((_signal?: NodeJS.Signals | number) => {
    ;(emitter as { killed: boolean }).killed = true
    // Mirror real behavior: killing the process eventually emits 'exit'.
    emitter.emit('exit', null, 'SIGTERM')
    return true
  }) as ChildProcess['kill']
  return emitter
}

/**
 * Build an injectable spawnFn that records invocations and returns a fresh
 * fake child per call. `delayMs` lets us widen the async window so concurrent
 * acquires genuinely overlap (proving the pending-promise dedupe).
 */
function makeSpawnFn(delayMs = 0): {
  spawnFn: SpawnServerFn
  calls: Array<{ cwd: string; child: FakeChild }>
} {
  const calls: Array<{ cwd: string; child: FakeChild }> = []
  let port = 40000
  const spawnFn: SpawnServerFn = async (_binary, cwd) => {
    const child = makeFakeChild()
    calls.push({ cwd, child })
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
    const result: SpawnResult = { process: child, baseUrl: `http://127.0.0.1:${port++}` }
    return result
  }
  return { spawnFn, calls }
}

function makeManager(spawnFn: SpawnServerFn): OpencodeServerManager {
  // Stub the binary locator so tests never touch the filesystem.
  return new OpencodeServerManager({ spawnFn, locateBinaryFn: () => '/fake/opencode' })
}

// The key test: port parsing regex
describe('port parsing', () => {
  it('extracts port from opencode server stdout line', () => {
    const PORT_PATTERN = /opencode server listening on http:\/\/127\.0\.0\.1:(\d+)/
    const line = 'opencode server listening on http://127.0.0.1:45678'
    const m = PORT_PATTERN.exec(line)
    expect(m).not.toBeNull()
    expect(m![1]).toBe('45678')
  })

  it('does not match partial or wrong-host lines', () => {
    const PORT_PATTERN = /opencode server listening on http:\/\/127\.0\.0\.1:(\d+)/
    expect(PORT_PATTERN.exec('opencode server listening on http://0.0.0.0:1234')).toBeNull()
    expect(PORT_PATTERN.exec('listening on port 1234')).toBeNull()
    expect(PORT_PATTERN.exec('')).toBeNull()
  })
})

// SSE block parser tests (imported from client)
describe('SSE block parsing', () => {
  it('parses a well-formed SSE data line', async () => {
    const { parseSSEStream } = await import('../OpencodeClient')
    const event = { id: 'evt_1', type: 'server.connected', properties: {} }
    const encoded = new TextEncoder().encode('data: ' + JSON.stringify(event) + '\n\n')

    const stream = new ReadableStream({
      start(c) {
        c.enqueue(encoded)
        c.close()
      },
    })

    const events: unknown[] = []
    for await (const e of parseSSEStream(stream)) {
      events.push(e)
    }
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual(event)
  })

  it('handles chunked delivery across multiple reads', async () => {
    const { parseSSEStream } = await import('../OpencodeClient')
    const event = { id: 'evt_2', type: 'message.part.updated', properties: { text: 'hello' } }
    const full = 'data: ' + JSON.stringify(event) + '\n\n'
    // Split into 2 chunks
    const mid = Math.floor(full.length / 2)
    const chunks = [full.slice(0, mid), full.slice(mid)]
    const enc = new TextEncoder()

    let i = 0
    const stream = new ReadableStream({
      pull(c) {
        if (i < chunks.length) {
          c.enqueue(enc.encode(chunks[i++]))
        } else c.close()
      },
    })

    const events: unknown[] = []
    for await (const e of parseSSEStream(stream)) {
      events.push(e)
    }
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual(event)
  })

  it('handles multiple events in one chunk', async () => {
    const { parseSSEStream } = await import('../OpencodeClient')
    const e1 = { id: 'evt_1', type: 'server.connected', properties: {} }
    const e2 = { id: 'evt_2', type: 'session.created', properties: {} }
    const raw = 'data: ' + JSON.stringify(e1) + '\n\ndata: ' + JSON.stringify(e2) + '\n\n'
    const enc = new TextEncoder()

    const stream = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(raw))
        c.close()
      },
    })

    const events: unknown[] = []
    for await (const e of parseSSEStream(stream)) {
      events.push(e)
    }
    expect(events).toHaveLength(2)
    expect(events[0]).toEqual(e1)
    expect(events[1]).toEqual(e2)
  })

  it('skips non-data SSE lines (id:, event:, retry:)', async () => {
    const { parseSSEStream } = await import('../OpencodeClient')
    const event = { id: 'evt_1', type: 'server.connected', properties: {} }
    const raw =
      'id: evt_1\n' +
      'event: message\n' +
      'retry: 3000\n' +
      'data: ' +
      JSON.stringify(event) +
      '\n\n'
    const enc = new TextEncoder()

    const stream = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(raw))
        c.close()
      },
    })

    const events: unknown[] = []
    for await (const e of parseSSEStream(stream)) {
      events.push(e)
    }
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual(event)
  })

  it('skips malformed JSON without throwing', async () => {
    const { parseSSEStream } = await import('../OpencodeClient')
    const raw = 'data: {bad json}\n\ndata: {"id":"2","type":"ok","properties":{}}\n\n'
    const enc = new TextEncoder()

    const stream = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(raw))
        c.close()
      },
    })

    const events: unknown[] = []
    for await (const e of parseSSEStream(stream)) {
      events.push(e)
    }
    expect(events).toHaveLength(1)
    expect((events[0] as { type: string }).type).toBe('ok')
  })

  it('respects AbortSignal', async () => {
    const { parseSSEStream } = await import('../OpencodeClient')
    const controller = new AbortController()

    let pullCount = 0
    const stream = new ReadableStream({
      pull(c) {
        pullCount++
        if (pullCount === 1) {
          controller.abort()
          // Don't enqueue anything — stream is cancelled
          c.close()
        } else {
          c.close()
        }
      },
    })

    const events: unknown[] = []
    for await (const e of parseSSEStream(stream, controller.signal)) {
      events.push(e)
    }
    expect(events).toHaveLength(0)
  })

  it('yields nothing when the signal is already aborted before consumption', async () => {
    const { parseSSEStream } = await import('../OpencodeClient')
    const controller = new AbortController()
    controller.abort()

    // Even a stream with a ready event must produce nothing once pre-aborted.
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(
          new TextEncoder().encode('data: {"id":"e1","type":"server.connected","properties":{}}\n\n')
        )
        c.close()
      },
    })

    const events: unknown[] = []
    for await (const e of parseSSEStream(stream, controller.signal)) {
      events.push(e)
    }
    expect(events).toHaveLength(0)
  })

  it('aborts a mid-flight idle stream via reader.cancel (no new chunk needed)', async () => {
    // The crux of NOTE 3: a silent /event stream that never enqueues another
    // chunk and never closes. Pre-cancel wiring, parseSSEStream would hang on
    // reader.read() forever; wiring the signal to reader.cancel() unblocks it.
    const { parseSSEStream } = await import('../OpencodeClient')
    const controller = new AbortController()

    let cancelled = false
    const stream = new ReadableStream({
      start(c) {
        // Emit one event, then go idle (no further enqueue, no close()).
        c.enqueue(
          new TextEncoder().encode(
            'data: {"id":"e1","type":"message.part.updated","properties":{}}\n\n'
          )
        )
      },
      cancel() {
        cancelled = true
      },
    })

    const events: unknown[] = []
    // Abort shortly after consumption starts; the generator must terminate.
    setTimeout(() => controller.abort(), 20)

    await Promise.race([
      (async () => {
        for await (const e of parseSSEStream(stream, controller.signal)) {
          events.push(e)
        }
      })(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('parseSSEStream did not abort an idle stream')), 1000)
      ),
    ])

    expect(events).toHaveLength(1) // got the one event before going idle
    expect(cancelled).toBe(true) // reader.cancel() ran, unblocking the read
  })
})

// Ref-counting / lifecycle tests against the REAL manager, with an injected
// fake spawn (no binary). These exercise acquire/release/teardown and the
// concurrency dedupe that FIX 1 closes.
describe('OpencodeServerManager lifecycle', () => {
  it('sequential: acquire×2 same cwd spawns once (refCount 2); release×2 kills once', async () => {
    const { spawnFn, calls } = makeSpawnFn()
    const mgr = makeManager(spawnFn)
    const cwd = '/work/proj'

    const c1 = await mgr.acquire(cwd)
    const c2 = await mgr.acquire(cwd)

    expect(calls).toHaveLength(1) // spawned exactly once
    expect(c1.baseUrl).toBe(c2.baseUrl) // same server
    expect(c1.authHeader).toBe(c2.authHeader)
    expect(mgr.activeCount).toBe(1)

    const child = calls[0].child
    mgr.release(cwd)
    expect(child.killed).toBe(false) // still one ref outstanding
    expect(mgr.activeCount).toBe(1)

    mgr.release(cwd)
    expect(child.killed).toBe(true) // last-out kill
    expect(mgr.activeCount).toBe(0)
  })

  it('concurrency: Promise.all([acquire, acquire]) spawns EXACTLY once (guards FIX 1)', async () => {
    // A spawn delay forces the two acquires to overlap — without the pending
    // promise, both would see no handle and each spawn a server (the race).
    const { spawnFn, calls } = makeSpawnFn(25)
    const mgr = makeManager(spawnFn)
    const cwd = '/work/proj'

    const [c1, c2] = await Promise.all([mgr.acquire(cwd), mgr.acquire(cwd)])

    expect(calls).toHaveLength(1) // <-- the assertion that fails pre-fix
    expect(c1.baseUrl).toBe(c2.baseUrl)
    expect(mgr.activeCount).toBe(1)

    // refCount must be 2 — both releases needed before teardown.
    const child = calls[0].child
    mgr.release(cwd)
    expect(child.killed).toBe(false)
    mgr.release(cwd)
    expect(child.killed).toBe(true)
    expect(mgr.activeCount).toBe(0)
  })

  it('higher concurrency: 5 simultaneous acquires share one server, 5 releases tear down', async () => {
    const { spawnFn, calls } = makeSpawnFn(15)
    const mgr = makeManager(spawnFn)
    const cwd = '/work/proj'

    const conns = await Promise.all(Array.from({ length: 5 }, () => mgr.acquire(cwd)))
    expect(calls).toHaveLength(1)
    expect(new Set(conns.map((c) => c.baseUrl)).size).toBe(1)

    const child = calls[0].child
    for (let i = 0; i < 4; i++) {
      mgr.release(cwd)
      expect(child.killed).toBe(false)
    }
    mgr.release(cwd)
    expect(child.killed).toBe(true)
    expect(mgr.activeCount).toBe(0)
  })

  it('different cwds get separate servers', async () => {
    const { spawnFn, calls } = makeSpawnFn()
    const mgr = makeManager(spawnFn)

    const a = await mgr.acquire('/work/a')
    const b = await mgr.acquire('/work/b')

    expect(calls).toHaveLength(2)
    expect(a.baseUrl).not.toBe(b.baseUrl)
    expect(mgr.activeCount).toBe(2)

    mgr.release('/work/a')
    expect(mgr.activeCount).toBe(1)
    mgr.release('/work/b')
    expect(mgr.activeCount).toBe(0)
  })

  it('normalizes cwd: relative + absolute forms of the same dir share a server', async () => {
    const { spawnFn, calls } = makeSpawnFn()
    const mgr = makeManager(spawnFn)

    // resolvePath() collapses these to the same absolute key.
    const a = await mgr.acquire('/work/proj')
    const b = await mgr.acquire('/work/proj/sub/..')

    expect(calls).toHaveLength(1)
    expect(a.baseUrl).toBe(b.baseUrl)

    mgr.release('/work/proj')
    mgr.release('/work/proj/sub/..')
    expect(mgr.activeCount).toBe(0)
  })

  it('re-acquire after full release spawns a fresh server', async () => {
    const { spawnFn, calls } = makeSpawnFn()
    const mgr = makeManager(spawnFn)
    const cwd = '/work/proj'

    await mgr.acquire(cwd)
    mgr.release(cwd)
    expect(mgr.activeCount).toBe(0)

    await mgr.acquire(cwd)
    expect(calls).toHaveLength(2) // a new spawn, not a revived dead handle
    expect(mgr.activeCount).toBe(1)
    mgr.release(cwd)
  })

  it('spawn failure rejects acquire and leaves no handle (retry can re-spawn)', async () => {
    let attempt = 0
    const goodSpawn = makeSpawnFn()
    const spawnFn: SpawnServerFn = async (binary, cwd, password) => {
      attempt++
      if (attempt === 1) throw new Error('boom: serve failed to start')
      return goodSpawn.spawnFn(binary, cwd, password)
    }
    const mgr = makeManager(spawnFn)
    const cwd = '/work/proj'

    await expect(mgr.acquire(cwd)).rejects.toThrow('boom')
    expect(mgr.activeCount).toBe(0)

    // A subsequent acquire must be able to re-spawn (pending entry was cleared).
    const conn = await mgr.acquire(cwd)
    expect(conn.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(mgr.activeCount).toBe(1)
    mgr.release(cwd)
  })

  it('concurrent acquires that all fail each reject; the cwd stays clean', async () => {
    const spawnFn: SpawnServerFn = async () => {
      await new Promise((r) => setTimeout(r, 10))
      throw new Error('boom')
    }
    const mgr = makeManager(spawnFn)
    const cwd = '/work/proj'

    const results = await Promise.allSettled([mgr.acquire(cwd), mgr.acquire(cwd)])
    expect(results.every((r) => r.status === 'rejected')).toBe(true)
    expect(mgr.activeCount).toBe(0)
  })

  it('unexpected server death drops the handle so the next acquire re-spawns', async () => {
    const { spawnFn, calls } = makeSpawnFn()
    const mgr = makeManager(spawnFn)
    const cwd = '/work/proj'

    await mgr.acquire(cwd)
    expect(mgr.activeCount).toBe(1)

    // Simulate a crash: the child emits 'exit' without us calling release().
    calls[0].child.emit('exit', 1, null)
    expect(mgr.activeCount).toBe(0)

    // Next acquire spawns fresh rather than handing back the dead handle.
    await mgr.acquire(cwd)
    expect(calls).toHaveLength(2)
    mgr.release(cwd)
  })

  it('release on an unknown cwd is a no-op (no throw)', () => {
    const { spawnFn } = makeSpawnFn()
    const mgr = makeManager(spawnFn)
    expect(() => mgr.release('/never/acquired')).not.toThrow()
  })

  it('dispose() kills all live servers and clears state', async () => {
    const { spawnFn, calls } = makeSpawnFn()
    const mgr = makeManager(spawnFn)

    await mgr.acquire('/work/a')
    await mgr.acquire('/work/b')
    expect(mgr.activeCount).toBe(2)

    mgr.dispose()
    expect(calls[0].child.killed).toBe(true)
    expect(calls[1].child.killed).toBe(true)
    expect(mgr.activeCount).toBe(0)
  })

  it('generates a distinct random password (Basic auth header) per server', async () => {
    const { spawnFn } = makeSpawnFn()
    const mgr = makeManager(spawnFn)

    const a = await mgr.acquire('/work/a')
    const b = await mgr.acquire('/work/b')

    expect(a.authHeader.startsWith('Basic ')).toBe(true)
    expect(a.authHeader).not.toBe(b.authHeader)
    // Decodes to opencode:<password>
    const decoded = Buffer.from(a.authHeader.slice('Basic '.length), 'base64').toString('utf8')
    expect(decoded.startsWith('opencode:')).toBe(true)
    expect(decoded.length).toBeGreaterThan('opencode:'.length)

    mgr.release('/work/a')
    mgr.release('/work/b')
  })
})

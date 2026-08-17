/**
 * @vitest-environment node
 *
 * Layer 1 tests for `PtyManager`'s multi-attach half (SyncCore phase 2,
 * sync-core.md §Terminal): the scrollback ring, several connections watching
 * one PTY tmux-style, and the backpressure decision.
 *
 * The desktop path is asserted alongside on purpose — the whole design premise
 * is ONE code path feeding renderer, ring and sockets, so every case here also
 * checks the desktop `onData` callback is unaffected.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Module from 'node:module'
import { createPtyStub } from '../../../test/stubs/pty-stub'
import type { PtyRemoteSink } from '../../../core/services/pty-manager'

const ptyStub = createPtyStub()

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, platform: () => 'linux' as NodeJS.Platform }
})

type LoadFn = (...a: unknown[]) => unknown
const modRef = Module as unknown as { _load: LoadFn }
const origLoad: LoadFn = modRef._load
modRef._load = function patched(...a: unknown[]): unknown {
  if ((a[0] as string) === 'node-pty') {
    return {
      spawn: (file: string, args: string[], options: Record<string, unknown>) =>
        ptyStub.spawn(file, args, options)
    }
  }
  return origLoad.call(this, ...a)
}

vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import { PtyManager } from '../../../core/services/pty-manager'

const flushPtyBatch = (): Promise<void> => new Promise((r) => setTimeout(r, 25))

interface RecordingSink extends PtyRemoteSink {
  received: Array<{ connectionId: string; termId: string; data: string }>
  exits: Array<{ connectionId: string; termId: string; exitCode: number }>
  detaches: Array<{ connectionId: string; termId: string; reason: string }>
  buffered: Map<string, number>
  gone: Set<string>
}

function makeSink(): RecordingSink {
  const sink: RecordingSink = {
    received: [],
    exits: [],
    detaches: [],
    buffered: new Map(),
    gone: new Set(),
    data: (connectionId, termId, data) => {
      sink.received.push({ connectionId, termId, data })
    },
    exit: (connectionId, termId, exitCode) => {
      sink.exits.push({ connectionId, termId, exitCode })
    },
    detached: (connectionId, termId, reason) => {
      sink.detaches.push({ connectionId, termId, reason })
    },
    bufferedAmount: (connectionId) =>
      sink.gone.has(connectionId) ? null : (sink.buffered.get(connectionId) ?? 0)
  }
  return sink
}

describe('PtyManager multi-attach', () => {
  let manager: PtyManager
  let sink: RecordingSink

  beforeEach(() => {
    ptyStub.reset()
    process.env.SHELL = '/bin/bash'
    manager = new PtyManager()
    sink = makeSink()
    manager.setRemoteSink(sink)
  })

  afterEach(() => {
    manager.killAll()
    vi.clearAllMocks()
  })

  it('fans one chunk out to every attached connection AND the desktop', async () => {
    const onData = vi.fn()
    const id = manager.create('/x', onData, vi.fn())
    manager.attach(id, 'conn-a')
    manager.attach(id, 'conn-b')

    ptyStub.spawned[0].emitData('hello world')
    await flushPtyBatch()

    expect(onData).toHaveBeenCalledWith(id, 'hello world')
    expect(sink.received).toEqual([
      { connectionId: 'conn-a', termId: id, data: 'hello world' },
      { connectionId: 'conn-b', termId: id, data: 'hello world' }
    ])
  })

  it('replays the scrollback to a LATE attach, before any live chunk', async () => {
    const id = manager.create('/x', vi.fn(), vi.fn())
    ptyStub.spawned[0].emitData('$ ls\r\n')
    await flushPtyBatch()
    ptyStub.spawned[0].emitData('file1 file2\r\n')
    await flushPtyBatch()

    // Nobody was attached for either chunk — the ring is fed regardless.
    expect(sink.received).toEqual([])

    manager.attach(id, 'late')
    // The replay lands SYNCHRONOUSLY inside attach(), so no live chunk can
    // interleave ahead of the history it belongs after.
    expect(sink.received).toEqual([{ connectionId: 'late', termId: id, data: '$ ls\r\nfile1 file2\r\n' }])

    ptyStub.spawned[0].emitData('more\r\n')
    await flushPtyBatch()
    expect(sink.received.map((r) => r.data)).toEqual(['$ ls\r\nfile1 file2\r\n', 'more\r\n'])
  })

  it('caps the scrollback ring and keeps the NEWEST bytes', async () => {
    const id = manager.create('/x', vi.fn(), vi.fn())
    // 5 × 64 KiB = 320 KiB through a ~200 KiB ring.
    for (let i = 0; i < 5; i++) {
      ptyStub.spawned[0].emitData(String(i).repeat(64 * 1024))
      await flushPtyBatch()
    }

    manager.attach(id, 'late')
    const replay = sink.received[0].data
    expect(replay.length).toBeLessThanOrEqual(200 * 1024)
    // The oldest chunk is gone, the newest survived intact.
    expect(replay.includes('0')).toBe(false)
    expect(replay.endsWith('4'.repeat(1024))).toBe(true)
  })

  it('truncates a single chunk larger than the whole ring to its tail', async () => {
    const id = manager.create('/x', vi.fn(), vi.fn())
    ptyStub.spawned[0].emitData('X'.repeat(10) + 'Y'.repeat(300 * 1024))
    await flushPtyBatch()

    manager.attach(id, 'late')
    const replay = sink.received[0].data
    expect(replay.length).toBe(200 * 1024)
    expect(replay.includes('X')).toBe(false)
  })

  it('one detach leaves the other connection streaming', async () => {
    const id = manager.create('/x', vi.fn(), vi.fn())
    manager.attach(id, 'conn-a')
    manager.attach(id, 'conn-b')
    manager.detach(id, 'conn-a')

    ptyStub.spawned[0].emitData('after detach')
    await flushPtyBatch()

    expect(sink.received.filter((r) => r.connectionId === 'conn-a')).toEqual([])
    expect(sink.received.filter((r) => r.connectionId === 'conn-b')).toHaveLength(1)
    expect(manager.isAttached(id, 'conn-a')).toBe(false)
    expect(manager.isAttached(id, 'conn-b')).toBe(true)
  })

  it('notifies every attached connection on exit', async () => {
    const onExit = vi.fn()
    const id = manager.create('/x', vi.fn(), onExit)
    manager.attach(id, 'conn-a')
    manager.attach(id, 'conn-b')

    ptyStub.spawned[0].emitExit(137)

    expect(onExit).toHaveBeenCalledWith(id, 137)
    expect(sink.exits).toEqual([
      { connectionId: 'conn-a', termId: id, exitCode: 137 },
      { connectionId: 'conn-b', termId: id, exitCode: 137 }
    ])
  })

  it('notifies attached connections when the terminal is killed', async () => {
    const id = manager.create('/x', vi.fn(), vi.fn())
    manager.attach(id, 'conn-a')

    manager.kill(id)
    // The stub raises exit asynchronously after kill(), exactly as node-pty does.
    await new Promise((r) => queueMicrotask(() => r(undefined)))

    expect(sink.exits).toEqual([{ connectionId: 'conn-a', termId: id, exitCode: 0 }])
  })

  it('detachAll releases every terminal and notifies with a reason', async () => {
    const idA = manager.create('/a', vi.fn(), vi.fn())
    const idB = manager.create('/b', vi.fn(), vi.fn())
    manager.attach(idA, 'conn')
    manager.attach(idB, 'conn')

    manager.detachAll('conn', 'policy-off')

    expect(manager.attachedTerminals('conn')).toEqual([])
    expect(sink.detaches.map((d) => d.termId).sort()).toEqual([idA, idB].sort())
    expect(sink.detaches.every((d) => d.reason === 'policy-off')).toBe(true)
  })

  it('refuses to attach when no remote sink is installed', () => {
    manager.setRemoteSink(null)
    const id = manager.create('/x', vi.fn(), vi.fn())
    expect(manager.attach(id, 'conn')).toBe(false)
    expect(manager.attach('no-such-terminal', 'conn')).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Backpressure (P4)
  // -------------------------------------------------------------------------

  it('pauses the pty while an attached socket is behind, and resumes on drain', async () => {
    const id = manager.create('/x', vi.fn(), vi.fn())
    manager.attach(id, 'slow')
    const fake = ptyStub.spawned[0]

    // Well past the 1 MiB high-water mark, without flooding OUR buffer — this
    // must be the SOCKET's backpressure, not the flush buffer's.
    sink.buffered.set('slow', 4 * 1024 * 1024)
    fake.emitData('a bit of output')
    await flushPtyBatch()

    expect(fake.paused).toBe(true)
    expect(manager.isAttached(id, 'slow')).toBe(true)

    // Still above the low-water mark: stay paused.
    sink.buffered.set('slow', 700 * 1024)
    await new Promise((r) => setTimeout(r, 120))
    expect(fake.paused).toBe(true)

    sink.buffered.set('slow', 1024)
    await new Promise((r) => setTimeout(r, 150))
    expect(fake.paused).toBe(false)
    expect(fake.resumeCount).toBeGreaterThan(0)
  })

  it('drops the slow attachment instead of buffering when the pty cannot pause', async () => {
    const id = manager.create('/x', vi.fn(), vi.fn())
    manager.attach(id, 'slow')
    manager.attach(id, 'fast')
    const fake = ptyStub.spawned[0]
    // A pty implementation without flow control: the only alternative to an
    // unbounded queue is dropping the attachment.
    ;(fake as unknown as { pause?: unknown }).pause = undefined

    sink.buffered.set('slow', 4 * 1024 * 1024)
    fake.emitData('output')
    await flushPtyBatch()

    expect(manager.isAttached(id, 'slow')).toBe(false)
    expect(sink.detaches).toEqual([{ connectionId: 'slow', termId: id, reason: 'backpressure' }])
    // The healthy viewer keeps streaming.
    expect(manager.isAttached(id, 'fast')).toBe(true)
    fake.emitData('more')
    await flushPtyBatch()
    expect(sink.received.filter((r) => r.connectionId === 'fast')).toHaveLength(2)
  })

  it('drops an attachment whose socket has vanished', async () => {
    const id = manager.create('/x', vi.fn(), vi.fn())
    manager.attach(id, 'ghost')
    sink.gone.add('ghost')

    ptyStub.spawned[0].emitData('output')
    await flushPtyBatch()

    expect(manager.isAttached(id, 'ghost')).toBe(false)
  })

  it('leaves desktop-only flow control exactly as it was', async () => {
    // No attachments at all: the pre-phase-2 behavior must be bit-for-bit the
    // same — pause on OUR high-water mark, resume after the flush.
    const onData = vi.fn()
    manager.create('/x', onData, vi.fn())
    const fake = ptyStub.spawned[0]

    const chunk = 'a'.repeat(64 * 1024)
    for (let i = 0; i < 20; i++) fake.emitData(chunk)
    expect(fake.paused).toBe(true)

    await flushPtyBatch()
    expect(onData).toHaveBeenCalledTimes(1)
    expect(fake.paused).toBe(false)
    expect(sink.received).toEqual([])
  })
})

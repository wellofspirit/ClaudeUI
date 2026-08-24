import { describe, it, expect } from 'vitest'
import { WireLog } from '../wire-log'

describe('WireLog', () => {
  it('records both directions with monotonic sequence numbers', () => {
    const log = new WireLog({ capacity: 10 })
    log.record('out', { type: 'control_request', request_id: 'a', request: {} })
    log.record('in', { type: 'control_response', response: { request_id: 'a' } })
    log.record('in', { type: 'assistant', id: 'm1' })

    const snap = log.snapshot()
    expect(snap.map((e) => e.seq)).toEqual([0, 1, 2])
    expect(snap.map((e) => e.dir)).toEqual(['out', 'in', 'in'])
    expect(snap[0].line).toMatchObject({ type: 'control_request', request_id: 'a' })
  })

  it('stays bounded at the configured capacity (ring behavior)', () => {
    const log = new WireLog({ capacity: 3 })
    for (let i = 0; i < 10; i++) log.record('in', { type: 'stream_event', i })
    const snap = log.snapshot()
    expect(snap).toHaveLength(3)
    // Oldest entry dropped: we should only see seq 7, 8, 9.
    expect(snap.map((e) => e.seq)).toEqual([7, 8, 9])
  })

  it('snapshot returns a shallow copy that does not mutate the internal buffer', () => {
    const log = new WireLog({ capacity: 5 })
    log.record('in', { type: 'stream_event' })
    const snap = log.snapshot()
    snap.length = 0
    expect(log.size()).toBe(1)
  })

  it('clear() resets state', () => {
    const log = new WireLog({ capacity: 5 })
    log.record('in', { type: 'x' })
    log.record('out', { type: 'y' })
    log.clear()
    expect(log.size()).toBe(0)
    log.record('in', { type: 'z' })
    // Sequence resets too — otherwise a clear()-then-replay confuses consumers.
    expect(log.snapshot()[0].seq).toBe(0)
  })
})

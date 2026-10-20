/**
 * @vitest-environment jsdom
 *
 * The desktop renderer's `SyncStats` timing relay: once per `sync-full`, receive →
 * hydrate return, through `window.api.logRelay` so it lands in the host log. A
 * catchup is not a full sync and relays nothing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { startDesktopSync, SYNC_PORT_MESSAGE } from '../desktop-transport'
import { setSyncClient } from '../../../../core/shared/sync/client-registry'
import type { FullStateSnapshot } from '../../../../shared/remote-protocol'

class FakePort {
  onmessage: ((event: { data: unknown }) => void) | null = null
  readonly posted: unknown[] = []
  start(): void {}
  postMessage(data: unknown): void {
    this.posted.push(data)
  }
  /** What main would send. */
  receive(data: unknown): void {
    this.onmessage?.({ data })
  }
}

const SNAPSHOT = { seq: 5, sessions: {} } as unknown as FullStateSnapshot

/** Hand the transport its port, the way the preload does. */
function deliverPort(port: FakePort): void {
  const event = new Event('message')
  Object.defineProperties(event, {
    data: { value: SYNC_PORT_MESSAGE },
    source: { value: window },
    ports: { value: [port] }
  })
  window.dispatchEvent(event)
}

describe('startDesktopSync — SyncStats timing relay', () => {
  const logRelay = vi.fn()

  beforeEach(() => {
    logRelay.mockClear()
    ;(window as unknown as { api: unknown }).api = { acquireSyncPort: vi.fn(), logRelay }
  })

  afterEach(() => {
    vi.restoreAllMocks()
    setSyncClient(null as never)
    delete (window as unknown as { api?: unknown }).api
  })

  it('relays ONE info line per sync-full, after the snapshot was applied', () => {
    const applied: number[] = []
    startDesktopSync((state) => {
      applied.push(state.seq)
      // The relay must come AFTER the apply, or it would not be measuring it.
      expect(logRelay).not.toHaveBeenCalled()
    })
    const port = new FakePort()
    deliverPort(port)
    expect(port.posted).toEqual([{ type: 'sync', lastSeq: 0, epoch: undefined }])

    port.receive({ type: 'sync-full', state: SNAPSHOT, epoch: 'e1' })

    expect(applied).toEqual([5])
    expect(logRelay).toHaveBeenCalledTimes(1)
    const [level, source, message] = logRelay.mock.calls[0]
    expect(level).toBe('info')
    expect(source).toBe('SyncStats')
    expect(message).toMatch(
      /^client sync-full applied: transport=desktop syncToFrameMs=\d+\.\d hydrateMs=\d+\.\d totalMs=\d+\.\d$/
    )
  })

  it('relays again for a later sync-full, and never for a catchup', () => {
    startDesktopSync(() => {})
    const port = new FakePort()
    deliverPort(port)

    port.receive({ type: 'sync-full', state: SNAPSHOT, epoch: 'e1' })
    port.receive({ type: 'sync-catchup', events: [], epoch: 'e1' })
    expect(logRelay).toHaveBeenCalledTimes(1)

    port.receive({ type: 'sync-full', state: { ...SNAPSHOT, seq: 9 }, epoch: 'e1' })
    expect(logRelay).toHaveBeenCalledTimes(2)
  })

  it('escalates to warn when receive → hydrate takes over 2 s', () => {
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    // The apply itself is what takes 2.5 s.
    startDesktopSync(() => {
      clock = 2650
    })
    const port = new FakePort()
    clock = 100 // the `sync` leaves when the port arrives
    deliverPort(port)
    clock = 150 // the frame is received
    port.receive({ type: 'sync-full', state: SNAPSHOT, epoch: 'e1' })

    expect(logRelay).toHaveBeenCalledWith(
      'warn',
      'SyncStats',
      'slow client sync-full applied: transport=desktop syncToFrameMs=50.0 hydrateMs=2500.0 totalMs=2550.0'
    )
  })

  it('relays nothing when the apply throws (there is no timing to report)', () => {
    startDesktopSync(() => {
      throw new Error('hydrate failed')
    })
    const port = new FakePort()
    deliverPort(port)
    expect(() => port.receive({ type: 'sync-full', state: SNAPSHOT, epoch: 'e1' })).toThrow()
    expect(logRelay).not.toHaveBeenCalled()
  })
})

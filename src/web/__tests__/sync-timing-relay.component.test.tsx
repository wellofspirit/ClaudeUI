/**
 * @vitest-environment jsdom
 *
 * The web client's `SyncStats` timing relay: once per `sync-full`, carrying the
 * frame length, decode ms, `sync` → frame ms and the apply (`hydrateReplica`,
 * dynamic-import wait included). Two copies leave the page: the console line
 * (`window.api.logRelay`) and the HOST-log report, a fire-and-forget
 * `sync:report-timing` invoke. A catchup relays and reports nothing, and a failing
 * or unanswered report never holds hydrate back.
 *
 * Drives the real entry (`../main`) over a scripted socket — the apply timing is
 * measured inside `main.tsx`'s full-state handler and the frame timing inside
 * `connection.ts`, so only the whole path proves they are joined into one line.
 * Harness borrowed from `provider-auth-hydration.component.test.tsx`.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { waitFor, fireEvent, screen } from '@testing-library/react'
import { act } from 'react'

vi.mock('@renderer/App', () => ({ default: () => <div data-testid="FakeApp">app</div> }))
vi.mock('@renderer/stores/replica', () => ({
  startReplica: () => {},
  hydrateReplica: () => ({ reloadActive: null, fillResumed: [] }),
  onReplicaApplied: () => () => {},
  getReplicaState: () => ({ sessions: {} }),
  resolveRekeyed: (id: string) => id
}))
vi.mock('@renderer/utils/projection-audit', () => ({ startProjectionAudit: () => {} }))
vi.mock('@renderer/lib/session-history-load', () => ({ finishHydrate: () => {} }))
vi.mock('@renderer/stores/session-store', () => ({
  useSessionStore: { getState: () => ({ refreshProviderAuth: async () => {} }) }
}))

class FakeSocket {
  // `connection.ts` compares `readyState` to `WebSocket.OPEN`, which is this class here.
  static OPEN = 1
  static last: FakeSocket | null = null
  onopen: ((ev?: unknown) => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: ((ev?: unknown) => void) | null = null
  onerror: ((ev?: unknown) => void) | null = null
  readyState = 1
  sent: string[] = []
  constructor(public url: string) {
    FakeSocket.last = this
  }
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.readyState = 3
  }
  /** Every `sync:report-timing` invoke the page sent, parsed. */
  reports(): Array<{ id: string; channel: string; args: unknown[] }> {
    return this.sent
      .map(
        (raw) => JSON.parse(raw) as { type: string; id: string; channel: string; args: unknown[] }
      )
      .filter((m) => m.type === 'invoke' && m.channel === 'sync:report-timing')
  }
  /** Deliver one frame; returns its length on the wire. */
  deliver(msg: unknown): number {
    const data = JSON.stringify(msg)
    this.onmessage?.({ data })
    return data.length
  }
}

const KDF = { algo: 'scrypt', N: 16, r: 1, p: 1, dkLen: 32 } as const
const SNAPSHOT = { seq: 0, sessions: {}, ui: {}, config: {} }

/** Sign in with a password and stop just BEFORE the first `sync-full`. */
async function authenticate(): Promise<FakeSocket> {
  await act(async () => {
    await import('../main')
  })
  await waitFor(() => expect(screen.getByTestId('PasswordLogin')).toBeTruthy())
  await act(async () => {
    fireEvent.change(screen.getByTestId('PasswordLogin.input'), { target: { value: 'hunter22' } })
    fireEvent.click(screen.getByTestId('PasswordLogin.submit'))
  })
  await waitFor(() => expect(FakeSocket.last).not.toBeNull(), { timeout: 8000 })
  const ws = FakeSocket.last!
  await act(async () => {
    ws.onopen?.()
  })
  await act(async () => {
    ws.deliver({ type: 'auth-response', ok: true, method: 'password' })
  })
  return ws
}

/** Deliver one `sync-full` and let the handler's dynamic imports land; returns the frame length. */
async function syncFull(ws: FakeSocket): Promise<number> {
  let length = 0
  await act(async () => {
    length = ws.deliver({ type: 'sync-full', epoch: 1, state: SNAPSHOT })
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  return length
}

describe('web client — SyncStats timing relay', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    FakeSocket.last = null
    ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          version: 1,
          methods: ['password'],
          password: { saltHex: 'aa', kdf: KDF }
        })
      }))
    )
    window.localStorage.clear()
    window.sessionStorage.clear()
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('relays ONE joined line per sync-full, and none for a catchup', async () => {
    const ws = await authenticate()
    const relay = vi.spyOn(window.api, 'logRelay').mockImplementation(() => {})

    const length = await syncFull(ws)

    await waitFor(() => expect(relay).toHaveBeenCalledTimes(1))
    const [level, source, message] = relay.mock.calls[0]
    expect(level).toBe('info')
    expect(source).toBe('SyncStats')
    expect(message).toMatch(
      new RegExp(
        `^client sync-full applied: transport=web frameChars=${length} decodeMs=\\d+\\.\\d ` +
          'syncToFrameMs=\\d+\\.\\d hydrateMs=\\d+\\.\\d totalMs=\\d+\\.\\d$'
      )
    )

    // A catchup is not a full sync.
    await act(async () => {
      ws.deliver({ type: 'sync-catchup', epoch: 1, events: [] })
    })
    expect(relay).toHaveBeenCalledTimes(1)

    // A re-sync (background → foreground) is another full sync, reported again.
    await syncFull(ws)
    await waitFor(() => expect(relay).toHaveBeenCalledTimes(2))
  }, 30_000)

  it('reports to the HOST once per sync-full, numbers only, and never for a catchup', async () => {
    const ws = await authenticate()
    vi.spyOn(window.api, 'logRelay').mockImplementation(() => {})
    expect(ws.reports()).toEqual([])

    const length = await syncFull(ws)

    await waitFor(() => expect(ws.reports()).toHaveLength(1))
    const [report] = ws.reports()
    // ONE object argument; exactly the four numeric fields, nothing else.
    expect(report.args).toHaveLength(1)
    const body = report.args[0] as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(
      ['decodeMs', 'frameBytes', 'hydrateMs', 'syncToFrameMs'].sort()
    )
    expect(body.frameBytes).toBe(length)
    for (const value of Object.values(body)) {
      expect(typeof value).toBe('number')
      expect(Number.isFinite(value)).toBe(true)
      expect(value as number).toBeGreaterThanOrEqual(0)
    }

    // A catchup is not a full sync.
    await act(async () => {
      ws.deliver({ type: 'sync-catchup', epoch: 1, events: [] })
    })
    expect(ws.reports()).toHaveLength(1)

    // A re-sync is another full sync, reported again.
    await syncFull(ws)
    await waitFor(() => expect(ws.reports()).toHaveLength(2))
  }, 30_000)

  it('does not hold hydrate back: an unanswered, refused or unsendable report leaves the app ready', async () => {
    const ws = await authenticate()
    vi.spyOn(window.api, 'logRelay').mockImplementation(() => {})

    // Nobody answers the report (it would sit out its 30 s timeout): the app must
    // already be rendered.
    await syncFull(ws)
    await waitFor(() => expect(screen.getByTestId('FakeApp')).toBeTruthy())
    await waitFor(() => expect(ws.reports()).toHaveLength(1))

    // The host refuses it (an older host: unknown channel, or the budget is spent):
    // no unhandled rejection, no state change.
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      await act(async () => {
        ws.deliver({
          type: 'invoke-response',
          id: ws.reports()[0].id,
          ok: false,
          error: 'Channel not available: sync:report-timing'
        })
      })
      // And the socket itself cannot take the frame: still no throw into hydrate.
      const send = ws.send.bind(ws)
      ws.send = (data: string): void => {
        if (data.includes('sync:report-timing')) throw new Error('socket closed')
        send(data)
      }
      await syncFull(ws)
      await new Promise((resolve) => setTimeout(resolve, 20))
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    expect(unhandled).toEqual([])
    expect(screen.getByTestId('FakeApp')).toBeTruthy()
  }, 30_000)
})

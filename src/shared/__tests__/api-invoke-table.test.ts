/**
 * @vitest-environment node
 *
 * The invoke table and its builder. Three clients build their pass-through members from it, so
 * what is pinned here is what none of them may differ on: the number of positions that reach the
 * wire (the web client marshals a missing trailing arg as `null` and the handlers rely on it),
 * the envelope handling, the progress path, and that no member is declared twice.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  API_EVENTS,
  API_INVOKES,
  DESKTOP_EVENTS,
  DESKTOP_INVOKES,
  buildEventApi,
  buildInvokeApi,
  buildMember,
  type InvokeEntry,
  type InvokeTable,
  type InvokeTransport
} from '../api-invoke-table'

function fakeTransport(result: unknown = undefined): {
  transport: InvokeTransport
  invoke: ReturnType<typeof vi.fn>
  invokeWithProgress: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
} {
  const invoke = vi.fn(async () => result)
  const invokeWithProgress = vi.fn(async () => result)
  const on = vi.fn(() => () => () => {})
  return {
    transport: { failurePrefix: 'Test', invoke, invokeWithProgress, on },
    invoke,
    invokeWithProgress,
    on
  }
}

const call = (entry: InvokeEntry, t: InvokeTransport, ...args: unknown[]): Promise<unknown> =>
  buildMember(entry, t)(...args)

describe('buildMember', () => {
  it('forwards exactly `arity` positions: missing ones as undefined, extra ones dropped', async () => {
    const { transport, invoke } = fakeTransport()
    const entry = { channel: 'x:y', arity: 3, mode: 'invoke' } as const
    await call(entry, transport, 'a')
    await call(entry, transport, 'a', 'b', 'c', 'd')
    expect(invoke.mock.calls).toEqual([
      ['x:y', ['a', undefined, undefined]],
      ['x:y', ['a', 'b', 'c']]
    ])
  })

  it('returns the raw result for invoke and the envelope data for unwrap', async () => {
    const envelope = { ok: true, data: 'D' }
    expect(
      await call({ channel: 'c', arity: 0, mode: 'invoke' }, fakeTransport(envelope).transport)
    ).toBe(envelope)
    expect(
      await call({ channel: 'c', arity: 0, mode: 'unwrap' }, fakeTransport(envelope).transport)
    ).toBe('D')
  })

  it('unwrap throws the envelope error, or the client failure text, and passes plain results', async () => {
    const entry = { channel: 'c:d', arity: 0, mode: 'unwrap' } as const
    await expect(call(entry, fakeTransport({ ok: false, error: 'E' }).transport)).rejects.toThrow(
      'E'
    )
    await expect(call(entry, fakeTransport({ ok: false }).transport)).rejects.toThrow(
      'Test c:d failed'
    )
    expect(await call(entry, fakeTransport({ x: 1 }).transport)).toEqual({ x: 1 })
    expect(await call(entry, fakeTransport(undefined).transport)).toBeUndefined()
  })

  it('a progress parameter rides invokeWithProgress only when given, and is not a wire arg', async () => {
    const { transport, invoke, invokeWithProgress } = fakeTransport()
    const entry = { channel: 'p:q', arity: 3, mode: 'invoke', progress: 2 } as const
    await call(entry, transport, 'a', 'b')
    expect(invoke).toHaveBeenCalledWith('p:q', ['a', 'b'])
    expect(invokeWithProgress).not.toHaveBeenCalled()
    const onProgress = (): void => {}
    await call(entry, transport, 'a', 'b', onProgress)
    expect(invokeWithProgress).toHaveBeenCalledWith('p:q', ['a', 'b'], onProgress)
  })

  it("progress 'always' rides invokeWithProgress with a no-op callback and unwraps", async () => {
    const { transport, invoke, invokeWithProgress } = fakeTransport({ ok: true, data: 'D' })
    const entry = { channel: 'w:x', arity: 2, mode: 'unwrap', progress: 'always' } as const
    expect(await call(entry, transport, 'a')).toBe('D')
    expect(invoke).not.toHaveBeenCalled()
    const [channel, args, cb] = invokeWithProgress.mock.calls[0]
    expect([channel, args]).toEqual(['w:x', ['a', undefined]])
    expect(typeof cb).toBe('function')
  })

  it('shapes the wire args with `wire`, from the positional args', async () => {
    const { transport, invoke } = fakeTransport()
    const entry = {
      channel: 's:t',
      arity: 2,
      mode: 'invoke',
      wire: (a: readonly unknown[]) => [{ id: a[0], v: a[1] }]
    } as const
    await call(entry, transport, 'i')
    expect(invoke).toHaveBeenCalledWith('s:t', [{ id: 'i', v: undefined }])
  })
})

describe('the real table entries that shape the wire', () => {
  const wireOf = (entry: InvokeEntry, ...args: unknown[]): unknown[] => [
    ...(entry.wire ?? (() => []))(Array.from({ length: entry.arity }, (_, i) => args[i]))
  ]

  it('loadSessionHistory sends its options as a 4th wire arg only when given', () => {
    const e = API_INVOKES.loadSessionHistory
    expect(e.progress).toBe(3)
    expect(wireOf(e, 's', 'p', 'r')).toEqual(['s', 'p', 'r'])
    expect(wireOf(e, 's', 'p', 'r', () => {}, { deferStatusLine: true })).toEqual([
      's',
      'p',
      'r',
      { deferStatusLine: true }
    ])
  })

  it('the optional replaceOwn list rides the wire only when it names something', () => {
    for (const e of [API_INVOKES.setSharedProviderApiKey, API_INVOKES.setSharedProviderDisabled]) {
      expect(wireOf(e, 'id', 'k')).toEqual(['id', 'k'])
      expect(wireOf(e, 'id', 'k', [])).toEqual(['id', 'k'])
      expect(wireOf(e, 'id', 'k', ['pi'])).toEqual(['id', 'k', ['pi']])
    }
  })
})

describe('buildEventApi', () => {
  it('subscribes each member to its channel through the transport', () => {
    const { transport, on } = fakeTransport()
    const api = buildEventApi(
      { onAuthState: 'auth:state', onBeforeQuit: 'app:before-quit' },
      transport
    )
    expect(Object.keys(api).sort()).toEqual(['onAuthState', 'onBeforeQuit'])
    expect(on.mock.calls.map((c) => c[0]).sort()).toEqual(['app:before-quit', 'auth:state'])
  })
})

describe('arity is checked against the ClaudeAPI method at compile time', () => {
  it('rejects an entry whose arity is not the method parameter count (getBlob takes 1)', () => {
    const table = {
      // @ts-expect-error arity 2 is not the parameter count of getBlob(blobId)
      getBlob: { channel: 'blob:get', arity: 2, mode: 'invoke' }
    } as const satisfies InvokeTable
    // The runtime builder trusts the number; the check is the compiler's (`bun run typecheck`).
    expect(table.getBlob.arity).toBe(2)
    expect(API_INVOKES.getBlob.arity).toBe(1)
  })
})

describe('table invariants', () => {
  const entries = Object.entries(API_INVOKES) as Array<[string, InvokeEntry]>
  const desktop = Object.entries(DESKTOP_INVOKES) as Array<[string, InvokeEntry]>

  it('no member is in two tables (a client would build it twice)', () => {
    const names = [
      ...Object.keys(API_INVOKES),
      ...Object.keys(DESKTOP_INVOKES),
      ...Object.keys(API_EVENTS),
      ...Object.keys(DESKTOP_EVENTS)
    ]
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([])
  })

  it('no channel is declared by two members of a table', () => {
    for (const table of [entries, desktop]) {
      const channels = table.map(([, e]) => e.channel)
      expect(channels.filter((c, i) => channels.indexOf(c) !== i)).toEqual([])
    }
  })

  it('a progress parameter sits inside the declared arity, and only progress methods have one', () => {
    for (const [name, e] of [...entries, ...desktop]) {
      if (typeof e.progress === 'number') expect(e.progress, name).toBeLessThan(e.arity)
    }
    expect(
      entries
        .filter(([, e]) => e.progress !== undefined)
        .map(([n]) => n)
        .sort()
    ).toEqual([
      'createWorktree',
      'loadSessionHistory',
      'loadSessionStatusLine',
      'measureWorktree',
      'removeWorktree',
      'removeWorktrees'
    ])
  })

  it('the builders yield exactly one function per table entry', () => {
    const { transport } = fakeTransport()
    for (const table of [API_INVOKES, DESKTOP_INVOKES]) {
      const built = buildInvokeApi(table, transport)
      expect(Object.keys(built).sort()).toEqual(Object.keys(table).sort())
      for (const member of Object.values(built)) expect(typeof member).toBe('function')
    }
  })

  it('is not vacuous', () => {
    expect(entries.length).toBeGreaterThan(200)
    expect(desktop.length).toBeGreaterThan(30)
    expect(Object.keys(API_EVENTS).length).toBeGreaterThan(5)
  })
})

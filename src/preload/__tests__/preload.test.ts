/**
 * @vitest-environment node
 *
 * Tests for the preload script's pure helper functions.
 * Since the actual preload depends on Electron's contextBridge and ipcRenderer,
 * we test the unwrap/onEvent logic patterns in isolation.
 */
import { describe, it, expect } from 'vitest'

// ---------------------------------------------------------------------------
// Replicate the unwrap logic from preload/index.ts
// ---------------------------------------------------------------------------

async function unwrap<T>(result: unknown): Promise<T> {
  if (result && typeof result === 'object' && 'ok' in result) {
    const r = result as { ok: boolean; data?: T; error?: string }
    if (!r.ok) throw new Error(r.error ?? 'IPC call failed')
    return r.data as T
  }
  return result as T
}

// Replicate the onEvent factory pattern
function createOnEvent(): {
  handler: ((...args: unknown[]) => void) | null
  register: (cb: (...args: unknown[]) => void) => () => void
  simulateEvent: (...args: unknown[]) => void
} {
  let handler: ((...args: unknown[]) => void) | null = null

  const register = (cb: (...args: unknown[]) => void): (() => void) => {
    handler = cb
    return () => {
      handler = null
    }
  }

  const simulateEvent = (...args: unknown[]): void => {
    if (handler) handler(...args)
  }

  return { handler: null, register, simulateEvent }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('unwrap', () => {
  it('unwraps a successful result', async () => {
    const result = await unwrap<string>({ ok: true, data: 'hello' })
    expect(result).toBe('hello')
  })

  it('throws on failed result', async () => {
    await expect(unwrap({ ok: false, error: 'Something went wrong' })).rejects.toThrow(
      'Something went wrong'
    )
  })

  it('throws with default message when error is missing', async () => {
    await expect(unwrap({ ok: false })).rejects.toThrow('IPC call failed')
  })

  it('passes through non-envelope values', async () => {
    expect(await unwrap<number>(42)).toBe(42)
    expect(await unwrap<string>('plain')).toBe('plain')
    expect(await unwrap<null>(null)).toBeNull()
  })

  it('passes through undefined', async () => {
    expect(await unwrap<undefined>(undefined)).toBeUndefined()
  })

  it('unwraps with complex data', async () => {
    const data = { users: [{ id: 1, name: 'test' }], total: 1 }
    const result = await unwrap<typeof data>({ ok: true, data })
    expect(result).toEqual(data)
  })

  it('handles ok: true with undefined data', async () => {
    const result = await unwrap<undefined>({ ok: true })
    expect(result).toBeUndefined()
  })
})

describe('onEvent pattern', () => {
  it('registers a callback and receives events', () => {
    const events = createOnEvent()
    const received: unknown[] = []

    events.register((...args) => received.push(args))
    events.simulateEvent('hello', 42)

    expect(received).toHaveLength(1)
    expect(received[0]).toEqual(['hello', 42])
  })

  it('returns an unsubscribe function', () => {
    const events = createOnEvent()
    const received: unknown[] = []

    const unsub = events.register((...args) => received.push(args))
    events.simulateEvent('before')
    unsub()
    events.simulateEvent('after')

    expect(received).toHaveLength(1)
  })

  it('handles events with no args', () => {
    const events = createOnEvent()
    const calls: number[] = []

    events.register(() => calls.push(1))
    events.simulateEvent()

    expect(calls).toHaveLength(1)
  })
})

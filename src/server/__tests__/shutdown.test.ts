import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createShutdown } from '../shutdown'

function setup(prepareStop: () => Promise<void>, stop: () => void = () => {}) {
  const calls: string[] = []
  const handle = createShutdown({
    prepareStop: () => {
      calls.push('prepareStop')
      return prepareStop()
    },
    stop: () => {
      calls.push('stop')
      stop()
    },
    exit: () => calls.push('exit'),
    log: () => {}
  })
  return { calls, handle }
}

describe('createShutdown', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('runs prepareStop, then stop, then exit after the delay', async () => {
    const { calls, handle } = setup(() => Promise.resolve())
    handle('SIGTERM')
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toEqual(['prepareStop', 'stop'])
    await vi.advanceTimersByTimeAsync(500)
    expect(calls).toEqual(['prepareStop', 'stop', 'exit'])
  })

  it('does not stop before prepareStop settles', async () => {
    let settle!: () => void
    const { calls, handle } = setup(() => new Promise<void>((r) => (settle = r)))
    handle('SIGINT')
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls).toEqual(['prepareStop'])
    settle()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toEqual(['prepareStop', 'stop'])
  })

  it('cuts a prepareStop that never settles at the bound', async () => {
    const { calls, handle } = setup(() => new Promise<void>(() => {}))
    handle('SIGTERM')
    await vi.advanceTimersByTimeAsync(3999)
    expect(calls).toEqual(['prepareStop'])
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toEqual(['prepareStop', 'stop'])
    await vi.advanceTimersByTimeAsync(500)
    expect(calls).toEqual(['prepareStop', 'stop', 'exit'])
  })

  it('still stops and exits when prepareStop rejects', async () => {
    const { calls, handle } = setup(() => Promise.reject(new Error('x')))
    handle('SIGTERM')
    await vi.advanceTimersByTimeAsync(500)
    expect(calls).toEqual(['prepareStop', 'stop', 'exit'])
  })

  it('still exits when stop throws', async () => {
    const { calls, handle } = setup(
      () => Promise.resolve(),
      () => {
        throw new Error('x')
      }
    )
    handle('SIGTERM')
    await vi.advanceTimersByTimeAsync(500)
    expect(calls).toEqual(['prepareStop', 'stop', 'exit'])
  })

  it('ignores a second signal', async () => {
    const { calls, handle } = setup(() => Promise.resolve())
    handle('SIGINT')
    handle('SIGTERM')
    await vi.advanceTimersByTimeAsync(500)
    expect(calls).toEqual(['prepareStop', 'stop', 'exit'])
  })
})

import { describe, it, expect } from 'vitest'
import { withTimeout } from '../ipc-timeout'

describe('withTimeout', () => {
  it('resolves with the value when promise completes before timeout', async () => {
    const result = await withTimeout(Promise.resolve(42), 1000, 'test')
    expect(result).toBe(42)
  })

  it('rejects with timeout error when promise takes too long', async () => {
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve('late'), 500))
    await expect(withTimeout(slow, 10, 'slowCall')).rejects.toThrow('IPC timeout: slowCall (10ms)')
  })

  it('preserves the original rejection', async () => {
    const failing = Promise.reject(new Error('original error'))
    await expect(withTimeout(failing, 1000, 'test')).rejects.toThrow('original error')
  })

  it('includes label and ms in the timeout error message', async () => {
    const slow = new Promise(() => {}) // never resolves
    await expect(withTimeout(slow, 50, 'myIpcCall')).rejects.toThrow('IPC timeout: myIpcCall (50ms)')
  })

  it('works with non-primitive resolved values', async () => {
    const obj = { key: 'value', nested: [1, 2] }
    const result = await withTimeout(Promise.resolve(obj), 1000, 'test')
    expect(result).toEqual(obj)
  })
})

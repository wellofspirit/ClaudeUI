/**
 * Layer 1: the accessory-key seam.
 *
 * The registry itself is trivial; what it has to guarantee is not. An injector
 * must never outlive its xterm instance (a key row typing into a disposed
 * terminal), and a REMOUNT must not be unregistered by the previous instance's
 * cleanup — React is free to run the new effect before the old teardown.
 */

import { describe, it, expect, vi } from 'vitest'
import { registerTerminalInput, sendTerminalInput } from '../terminal-input'

describe('terminal-input registry', () => {
  it('routes bytes to the registered injector, by terminal id', () => {
    const a = vi.fn()
    const b = vi.fn()
    const offA = registerTerminalInput('term-a', a)
    const offB = registerTerminalInput('term-b', b)

    expect(sendTerminalInput('term-a', '\x03')).toBe(true)
    expect(a).toHaveBeenCalledWith('\x03')
    expect(b).not.toHaveBeenCalled()

    offA()
    offB()
  })

  it('is a no-op (never a throw) with no active terminal or no instance mounted', () => {
    expect(sendTerminalInput(null, '\x1b')).toBe(false)
    expect(sendTerminalInput(undefined, '\x1b')).toBe(false)
    // xterm is lazy-chunked: a tab can exist for a frame before its instance does.
    expect(sendTerminalInput('term-not-mounted', '\x1b')).toBe(false)
  })

  it('stops routing once the instance unregisters', () => {
    const inject = vi.fn()
    const off = registerTerminalInput('term-c', inject)
    off()

    expect(sendTerminalInput('term-c', '\t')).toBe(false)
    expect(inject).not.toHaveBeenCalled()
  })

  it('a stale cleanup never unregisters the instance that replaced it', () => {
    const first = vi.fn()
    const second = vi.fn()
    const offFirst = registerTerminalInput('term-d', first)
    // The remount registers before React runs the old effect's cleanup.
    const offSecond = registerTerminalInput('term-d', second)
    offFirst()

    expect(sendTerminalInput('term-d', 'x')).toBe(true)
    expect(second).toHaveBeenCalledWith('x')
    expect(first).not.toHaveBeenCalled()

    offSecond()
  })
})

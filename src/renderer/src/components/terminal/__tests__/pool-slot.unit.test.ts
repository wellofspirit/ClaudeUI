/**
 * Layer 1 unit tests for the client's pool-slot chooser.
 *
 * The mapping slot → pty is resolved in main; the client's only job is to name
 * the slot it wants. Getting this wrong is what would make a `+` press spawn a
 * duplicate shell instead of re-attaching to the one another surface holds.
 */

import { describe, it, expect } from 'vitest'
import { nextFreeSlot } from '../pool-slot'
import type { TerminalTab } from '../../../../../shared/types'

const tab = (id: string, poolIndex?: number): TerminalTab => ({
  id,
  title: id,
  cwd: '/repo',
  poolIndex
})

describe('nextFreeSlot', () => {
  it('starts at 0 for an empty group', () => {
    expect(nextFreeSlot([])).toBe(0)
  })

  it('takes the next slot up when the low ones are taken', () => {
    expect(nextFreeSlot([tab('a', 0), tab('b', 1)])).toBe(2)
  })

  it('fills a hole left by a closed tab rather than appending', () => {
    // Slot 1 was closed: asking for it again re-attaches to that pty if another
    // surface still has it open, which is the whole point of the pool.
    expect(nextFreeSlot([tab('a', 0), tab('c', 2)])).toBe(1)
  })

  it('is order-independent', () => {
    expect(nextFreeSlot([tab('c', 2), tab('a', 0)])).toBe(1)
  })

  it('falls back to a tab’s position when it carries no pool index', () => {
    expect(nextFreeSlot([tab('a'), tab('b')])).toBe(2)
    // Mixed: 'a' stands in at position 0, 'b' declares slot 3 — 1 is free.
    expect(nextFreeSlot([tab('a'), tab('b', 3)])).toBe(1)
  })
})

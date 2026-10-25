// @vitest-environment node
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeMockupWatchersUnder, trackMockupWatcher } from '../mockup-watch-registry'

const untrackers: Array<() => void> = []
afterEach(() => {
  for (const u of untrackers.splice(0)) u()
})
const track = (dir: string, close: () => void): void => {
  untrackers.push(trackMockupWatcher(dir, close))
}

describe('mockup watcher registry (C-S7)', () => {
  const wt = path.resolve('/repo/.claude/worktrees/a')

  it('closes the watches at or inside the removed path, and only those', () => {
    const inside = vi.fn()
    const sibling = vi.fn()
    const prefixOnly = vi.fn()
    track(path.join(wt, '.claude', 'ui', 'mockups', 'm1'), inside)
    track(path.resolve('/repo/.claude/worktrees/b/.claude/ui/mockups/m1'), sibling)
    // `a-two` shares the string prefix `a` but is another directory.
    track(path.resolve('/repo/.claude/worktrees/a-two/.claude/ui/mockups/m1'), prefixOnly)

    expect(closeMockupWatchersUnder(wt)).toBe(1)
    expect(inside).toHaveBeenCalledOnce()
    expect(sibling).not.toHaveBeenCalled()
    expect(prefixOnly).not.toHaveBeenCalled()
  })

  it('a closed watch is forgotten (closing twice does nothing), and a throwing close does not stop the sweep', () => {
    const bad = vi.fn(() => {
      throw new Error('already closed')
    })
    const good = vi.fn()
    track(path.join(wt, 'x'), bad)
    track(path.join(wt, 'y'), good)

    expect(closeMockupWatchersUnder(wt)).toBe(2)
    expect(good).toHaveBeenCalledOnce()
    expect(closeMockupWatchersUnder(wt)).toBe(0)
  })

  it('an untracked watch is no longer closed', () => {
    const close = vi.fn()
    const untrack = trackMockupWatcher(path.join(wt, 'z'), close)
    untrack()
    expect(closeMockupWatchersUnder(wt)).toBe(0)
    expect(close).not.toHaveBeenCalled()
  })
})

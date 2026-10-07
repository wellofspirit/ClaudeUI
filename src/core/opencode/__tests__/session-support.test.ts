/**
 * The shared 2.x teardown (`stopOpencodeSessions`) and worktree read
 * (`locationWorktree`) — used by `OpencodeSession` and the dispatcher's
 * opencode targets (ADR-097 S5/S9).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { locationWorktree, stopOpencodeSessions } from '../session-support'

function client(active: () => Record<string, unknown>) {
  return {
    interrupt: vi.fn(async (_id: string) => true),
    cancelInbox: vi.fn(async (_s: string, _i: string) => {}),
    activeSessions: vi.fn(async () => active() as Record<string, { type: 'running' }>)
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('stopOpencodeSessions', () => {
  it('interrupts every session, cancels the inbox items, and waits until none is active', async () => {
    let polls = 0
    const c = client(() => (++polls < 3 ? { ses_a: { type: 'running' } } : {}))
    await stopOpencodeSessions(c, ['ses_a', 'ses_child'], { sessionID: 'ses_a', ids: ['msg_1'] })
    expect(c.interrupt.mock.calls.map(([id]) => id)).toEqual(['ses_a', 'ses_child'])
    expect(c.cancelInbox).toHaveBeenCalledWith('ses_a', 'msg_1')
    expect(polls).toBe(3)
  })

  it('is bounded by the grace period and never rejects (a failing route included)', async () => {
    vi.useFakeTimers()
    const c = client(() => ({ ses_a: { type: 'running' } }))
    c.interrupt.mockRejectedValue(new Error('500'))
    let done = false
    void stopOpencodeSessions(c, ['ses_a'], undefined, 1_000).then(() => (done = true))
    await vi.advanceTimersByTimeAsync(999)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(done).toBe(true)
    // It stopped polling.
    const polls = c.activeSessions.mock.calls.length
    await vi.advanceTimersByTimeAsync(1_000)
    expect(c.activeSessions.mock.calls.length).toBe(polls)
  })

  it('a session still active while it waits is interrupted again', async () => {
    let polls = 0
    const c = client(() => (++polls < 7 ? { ses_a: { type: 'running' } } : {}))
    await stopOpencodeSessions(c, ['ses_a'])
    expect(c.interrupt.mock.calls.length).toBeGreaterThan(1)
  })

  it('a failing active read ends the wait at once', async () => {
    const c = client(() => {
      throw new Error('gone')
    })
    await expect(stopOpencodeSessions(c, ['ses_a'])).resolves.toBeUndefined()
  })
})

describe('locationWorktree', () => {
  const at = (directory: unknown) => ({
    call: vi.fn(async () => ({ project: { directory } }))
  })

  it("is the location's project directory; the filesystem root or nothing is no worktree", async () => {
    expect(await locationWorktree(at('/repo') as never)).toBe('/repo')
    expect(await locationWorktree(at('/') as never)).toBeNull()
    expect(await locationWorktree(at('') as never)).toBeNull()
    expect(await locationWorktree(at(undefined) as never)).toBeNull()
  })
})

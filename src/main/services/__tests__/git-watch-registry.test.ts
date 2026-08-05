/**
 * @vitest-environment node
 *
 * Layer 1 unit tests for GitWatchRegistry.
 *
 * gitServiceManager is mocked: what matters here is the arbitration between
 * owners (who starts the poller, who merely attaches, when it is torn down), not
 * real git output. The mock also lets us assert the invariant that motivated the
 * registry — `GitService.startPolling()` holds a SINGLE callback, so a second
 * `startPolling()` on the same cwd would silently clobber the first owner's
 * broadcast.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { GitStatusData } from '../../../shared/types'

interface FakeService {
  startPolling: ReturnType<typeof vi.fn>
  stopPolling: ReturnType<typeof vi.fn>
  /** Fire the callback the most recent startPolling() installed. */
  tick: (status: GitStatusData) => void
}

const managerMock = vi.hoisted(() => {
  const services = new Map<string, FakeService>()
  const make = (): FakeService => {
    const svc: FakeService = {
      startPolling: vi.fn(),
      stopPolling: vi.fn(),
      tick: (status) => {
        const calls = svc.startPolling.mock.calls
        const cb = calls[calls.length - 1]?.[0] as ((s: GitStatusData) => void) | undefined
        cb?.(status)
      }
    }
    return svc
  }
  return {
    services,
    get: vi.fn((cwd: string) => {
      const existing = services.get(cwd)
      if (existing) return existing
      const svc = make()
      services.set(cwd, svc)
      return svc
    }),
    release: vi.fn(),
    getIfExists: vi.fn((cwd: string) => services.get(cwd)),
    reset: (): void => {
      services.clear()
    }
  }
})

vi.mock('../git-service', () => ({ gitServiceManager: managerMock }))

// Import AFTER the mock.
import { GitWatchRegistry } from '../git-watch-registry'

const status = (over: Partial<GitStatusData> = {}): GitStatusData =>
  ({
    branch: 'main',
    ahead: 0,
    behind: 0,
    trackingBranch: null,
    files: [],
    staged: [],
    unstaged: [],
    untracked: [],
    linesAdded: 0,
    linesRemoved: 0,
    ...over
  }) as GitStatusData

const CWD = '/repo/a'
const OTHER = '/repo/b'

let registry: GitWatchRegistry
let seen: Array<{ cwd: string; status: GitStatusData }>

beforeEach(() => {
  managerMock.get.mockClear()
  managerMock.release.mockClear()
  managerMock.getIfExists.mockClear()
  managerMock.reset()
  registry = new GitWatchRegistry()
  seen = []
  registry.init((cwd, s) => seen.push({ cwd, status: s }))
})

const svcFor = (cwd: string): FakeService => managerMock.services.get(cwd)!

describe('GitWatchRegistry — start / attach', () => {
  it('the first owner of a cwd starts the poller', () => {
    registry.startWatching(CWD, 'desktop')
    expect(managerMock.get).toHaveBeenCalledWith(CWD)
    expect(svcFor(CWD).startPolling).toHaveBeenCalledTimes(1)
    expect(svcFor(CWD).startPolling.mock.calls[0][1]).toBe(5000)
    expect(registry.ownersOf(CWD)).toEqual(['desktop'])
  })

  it('broadcasts every poll to the injected fan-out', () => {
    registry.startWatching(CWD, 'desktop')
    svcFor(CWD).tick(status({ linesAdded: 3 }))
    expect(seen).toEqual([{ cwd: CWD, status: status({ linesAdded: 3 }) }])
  })

  it('a second owner does NOT restart the poller but DOES get the current status', () => {
    registry.startWatching(CWD, 'desktop')
    svcFor(CWD).tick(status({ linesAdded: 7 }))
    seen = []

    registry.startWatching(CWD, 'remote')

    // The critical assertion: a second startPolling() would have replaced the
    // desktop's callback.
    expect(svcFor(CWD).startPolling).toHaveBeenCalledTimes(1)
    expect(registry.ownersOf(CWD).sort()).toEqual(['desktop', 'remote'])
    // Replayed immediately — the poller only fires on CHANGE from here on, so a
    // late joiner would otherwise be blind until the tree moves.
    expect(seen).toEqual([{ cwd: CWD, status: status({ linesAdded: 7 }) }])
  })

  it('a second owner joining before the first poll lands replays nothing (the poll delivers)', () => {
    registry.startWatching(CWD, 'desktop')
    registry.startWatching(CWD, 'remote')
    expect(seen).toEqual([])

    svcFor(CWD).tick(status({ linesAdded: 1 }))
    expect(seen).toHaveLength(1)
  })

  it('both owners keep receiving broadcasts after the second joins (CLOBBER GUARD)', () => {
    registry.startWatching(CWD, 'desktop')
    const desktopCb = svcFor(CWD).startPolling.mock.calls[0][0] as (s: GitStatusData) => void
    registry.startWatching(CWD, 'remote')

    // Only one callback ever existed, and it is still the live one.
    expect(svcFor(CWD).startPolling).toHaveBeenCalledTimes(1)
    seen = []
    desktopCb(status({ linesAdded: 2 }))
    expect(seen).toEqual([{ cwd: CWD, status: status({ linesAdded: 2 }) }])
  })

  it('tracks cwds independently', () => {
    registry.startWatching(CWD, 'desktop')
    registry.startWatching(OTHER, 'remote')
    expect(svcFor(CWD).startPolling).toHaveBeenCalledTimes(1)
    expect(svcFor(OTHER).startPolling).toHaveBeenCalledTimes(1)
    svcFor(OTHER).tick(status({ branch: 'dev' }))
    expect(seen).toEqual([{ cwd: OTHER, status: status({ branch: 'dev' }) }])
  })
})

describe('GitWatchRegistry — stop', () => {
  it('a partial stop keeps the poller running for the remaining owner', () => {
    registry.startWatching(CWD, 'desktop')
    registry.startWatching(CWD, 'remote')

    registry.stopWatching(CWD, 'remote')

    expect(svcFor(CWD).stopPolling).not.toHaveBeenCalled()
    expect(managerMock.release).not.toHaveBeenCalled()
    expect(registry.ownersOf(CWD)).toEqual(['desktop'])

    seen = []
    svcFor(CWD).tick(status({ linesAdded: 4 }))
    expect(seen).toHaveLength(1)
  })

  it('the last stop tears down: stopPolling + manager release + dropped cache', () => {
    registry.startWatching(CWD, 'desktop')
    svcFor(CWD).tick(status({ linesAdded: 5 }))
    const svc = svcFor(CWD)

    registry.stopWatching(CWD, 'desktop')

    expect(svc.stopPolling).toHaveBeenCalledTimes(1)
    expect(managerMock.release).toHaveBeenCalledWith(CWD)
    expect(registry.ownersOf(CWD)).toEqual([])

    // The cached status went with the entry: re-watching starts a fresh poller
    // rather than replaying stale state (GitService's own fingerprint reset
    // guarantees that poller emits).
    seen = []
    registry.startWatching(CWD, 'desktop')
    expect(seen).toEqual([])
    expect(svcFor(CWD).startPolling).toHaveBeenCalledTimes(2)
  })

  it('an owner that started twice needs two stops (refcounted per owner)', () => {
    registry.startWatching(CWD, 'desktop')
    registry.startWatching(CWD, 'desktop')

    registry.stopWatching(CWD, 'desktop')
    expect(svcFor(CWD).stopPolling).not.toHaveBeenCalled()
    expect(registry.ownersOf(CWD)).toEqual(['desktop'])

    registry.stopWatching(CWD, 'desktop')
    expect(svcFor(CWD).stopPolling).toHaveBeenCalledTimes(1)
    expect(managerMock.release).toHaveBeenCalledWith(CWD)
  })

  it('a tick that settles after teardown is dropped', () => {
    registry.startWatching(CWD, 'desktop')
    const svc = svcFor(CWD)
    registry.stopWatching(CWD, 'desktop')
    seen = []
    svc.tick(status({ linesAdded: 9 }))
    expect(seen).toEqual([])
  })

  it('stopWatching is a no-op for an unknown cwd or an owner that never started', () => {
    registry.startWatching(CWD, 'desktop')
    expect(() => registry.stopWatching('/nope', 'desktop')).not.toThrow()
    registry.stopWatching(CWD, 'remote')
    expect(svcFor(CWD).stopPolling).not.toHaveBeenCalled()
    expect(managerMock.release).not.toHaveBeenCalled()
    expect(registry.ownersOf(CWD)).toEqual(['desktop'])
  })
})

describe('GitWatchRegistry — releaseOwner', () => {
  it('drops the owner from every cwd it holds and tears down the orphans', () => {
    registry.startWatching(CWD, 'remote')
    registry.startWatching(CWD, 'desktop')
    registry.startWatching(OTHER, 'remote')
    registry.startWatching(OTHER, 'remote') // count 2 — releaseOwner ignores counts
    const svcOther = svcFor(OTHER)

    registry.releaseOwner('remote')

    // CWD still has the desktop owner → poller survives.
    expect(svcFor(CWD).stopPolling).not.toHaveBeenCalled()
    expect(registry.ownersOf(CWD)).toEqual(['desktop'])
    // OTHER had only the remote owner → torn down despite the refcount of 2.
    expect(svcOther.stopPolling).toHaveBeenCalledTimes(1)
    expect(managerMock.release).toHaveBeenCalledWith(OTHER)
    expect(registry.ownersOf(OTHER)).toEqual([])
  })

  it('releasing an owner that holds nothing is a no-op', () => {
    registry.startWatching(CWD, 'desktop')
    expect(() => registry.releaseOwner('remote')).not.toThrow()
    expect(svcFor(CWD).stopPolling).not.toHaveBeenCalled()
    expect(managerMock.release).not.toHaveBeenCalled()
    expect(registry.ownersOf(CWD)).toEqual(['desktop'])
  })

  it('releasing on an empty registry is a no-op', () => {
    expect(() => registry.releaseOwner('remote')).not.toThrow()
    expect(managerMock.release).not.toHaveBeenCalled()
  })
})

describe('GitWatchRegistry — fan-out injection', () => {
  it('tracks owners and polls even before init() installs a broadcast', () => {
    const bare = new GitWatchRegistry()
    bare.startWatching(CWD, 'remote')
    expect(svcFor(CWD).startPolling).toHaveBeenCalledTimes(1)
    // No broadcaster yet: the tick must not throw, and the status is cached so a
    // later owner still gets it.
    expect(() => svcFor(CWD).tick(status({ linesAdded: 6 }))).not.toThrow()

    const later: GitStatusData[] = []
    bare.init((_cwd, s) => later.push(s))
    bare.startWatching(CWD, 'desktop')
    expect(later).toEqual([status({ linesAdded: 6 })])
  })
})

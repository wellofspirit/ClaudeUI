/**
 * @vitest-environment node
 *
 * Layer 1 unit tests for GitWatchRegistry.
 *
 * gitServiceManager is mocked: what matters here is the arbitration between
 * per-connection interest sets (whose set starts the poller, who merely joins,
 * when the union empties), not real git output. The mock also lets us assert the
 * two invariants the mobile git pill depends on — `GitService.startPolling()`
 * holds a SINGLE callback, so a second `startPolling()` on the same cwd would
 * silently clobber the other surface's broadcast, and every watch answers with a
 * status rather than waiting for the tree to change.
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

vi.mock('../../../core/services/git-service', () => ({ gitServiceManager: managerMock }))

// Import AFTER the mock.
import { GitWatchRegistry } from '../../../core/services/git-watch-registry'

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

describe('GitWatchRegistry — the union drives the poller', () => {
  it('the first watcher of a cwd starts the one poller', () => {
    registry.setWatch('c1', [CWD])
    expect(managerMock.get).toHaveBeenCalledWith(CWD)
    expect(svcFor(CWD).startPolling).toHaveBeenCalledTimes(1)
    expect(svcFor(CWD).startPolling.mock.calls[0][1]).toBe(5000)
    expect(registry.watchersOf(CWD)).toEqual(['c1'])
    expect(registry.watchedCwds()).toEqual([CWD])
  })

  it('broadcasts every poll to the injected fan-out', () => {
    registry.setWatch('c1', [CWD])
    svcFor(CWD).tick(status({ linesAdded: 3 }))
    expect(seen).toEqual([{ cwd: CWD, status: status({ linesAdded: 3 }) }])
  })

  it('a second connection does NOT restart the poller but DOES get the current status', () => {
    registry.setWatch('desktop', [CWD])
    svcFor(CWD).tick(status({ linesAdded: 7 }))
    seen = []

    registry.setWatch('phone', [CWD])

    // THE CLOBBER GUARD: a second startPolling() would have replaced the
    // desktop's callback, which is the bug this registry exists for.
    expect(svcFor(CWD).startPolling).toHaveBeenCalledTimes(1)
    expect(registry.watchersOf(CWD).sort()).toEqual(['desktop', 'phone'])
    // Replayed immediately — the poller only fires on CHANGE from here on, so a
    // late joiner would otherwise be blind until the tree moves. This is the
    // half of always-emit-first the fingerprint reset cannot cover.
    expect(seen).toEqual([{ cwd: CWD, status: status({ linesAdded: 7 }) }])
  })

  it('RE-STATING an unchanged set still emits (a renderer reload keeps its id)', () => {
    registry.setWatch('desktop', [CWD])
    svcFor(CWD).tick(status({ linesAdded: 7 }))
    seen = []

    registry.setWatch('desktop', [CWD])

    expect(svcFor(CWD).startPolling).toHaveBeenCalledTimes(1)
    // A reloaded renderer has an empty store and the SAME connection id. If an
    // unchanged set were a silent no-op its git pill would stay blank until the
    // working tree next changed — the regression class the pill fix closed.
    expect(seen).toEqual([{ cwd: CWD, status: status({ linesAdded: 7 }) }])
  })

  it('a second connection joining before the first poll lands replays nothing (the poll delivers)', () => {
    registry.setWatch('c1', [CWD])
    registry.setWatch('c2', [CWD])
    expect(seen).toEqual([])

    svcFor(CWD).tick(status({ linesAdded: 1 }))
    expect(seen).toHaveLength(1)
  })

  it('every watcher keeps receiving after another joins (one callback per cwd)', () => {
    registry.setWatch('desktop', [CWD])
    const theOnlyCallback = svcFor(CWD).startPolling.mock.calls[0][0] as (
      s: GitStatusData
    ) => void
    registry.setWatch('phone', [CWD])

    expect(svcFor(CWD).startPolling).toHaveBeenCalledTimes(1)
    seen = []
    theOnlyCallback(status({ linesAdded: 2 }))
    expect(seen).toEqual([{ cwd: CWD, status: status({ linesAdded: 2 }) }])
  })

  it('tracks cwds independently, and one connection may watch several', () => {
    registry.setWatch('c1', [CWD, OTHER])
    expect(registry.watchedCwds()).toEqual([CWD, OTHER].sort())
    expect(svcFor(CWD).startPolling).toHaveBeenCalledTimes(1)
    expect(svcFor(OTHER).startPolling).toHaveBeenCalledTimes(1)
    svcFor(OTHER).tick(status({ branch: 'dev' }))
    expect(seen).toEqual([{ cwd: OTHER, status: status({ branch: 'dev' }) }])
  })
})

describe('GitWatchRegistry — a shrinking union stops polling', () => {
  it('dropping a cwd from one set keeps the poller for the remaining watcher', () => {
    registry.setWatch('desktop', [CWD])
    registry.setWatch('phone', [CWD])

    registry.setWatch('phone', [])

    expect(svcFor(CWD).stopPolling).not.toHaveBeenCalled()
    expect(managerMock.release).not.toHaveBeenCalled()
    expect(registry.watchersOf(CWD)).toEqual(['desktop'])

    seen = []
    svcFor(CWD).tick(status({ linesAdded: 4 }))
    expect(seen).toHaveLength(1)
  })

  it('the last watcher leaving tears down: stopPolling + release + dropped cache', () => {
    registry.setWatch('desktop', [CWD])
    svcFor(CWD).tick(status({ linesAdded: 5 }))
    const svc = svcFor(CWD)

    registry.setWatch('desktop', [])

    expect(svc.stopPolling).toHaveBeenCalledTimes(1)
    expect(managerMock.release).toHaveBeenCalledWith(CWD)
    expect(registry.watchersOf(CWD)).toEqual([])
    expect(registry.watchedCwds()).toEqual([])

    // The cached status went with the entry: re-watching starts a FRESH poller
    // rather than replaying stale state, and GitService's own fingerprint reset
    // guarantees that poller emits on its first tick.
    seen = []
    registry.setWatch('desktop', [CWD])
    expect(seen).toEqual([])
    expect(svcFor(CWD).startPolling).toHaveBeenCalledTimes(2)
  })

  it('a set is REPLACED, not merged — switching cwd stops the old one', () => {
    registry.setWatch('c1', [CWD])
    registry.setWatch('c1', [OTHER])

    expect(svcFor(CWD).stopPolling).toHaveBeenCalledTimes(1)
    expect(registry.watchedCwds()).toEqual([OTHER])
    expect(registry.watchersOf(OTHER)).toEqual(['c1'])
  })

  it('a tick that settles after teardown is dropped', () => {
    registry.setWatch('c1', [CWD])
    const svc = svcFor(CWD)
    registry.setWatch('c1', [])
    seen = []
    svc.tick(status({ linesAdded: 9 }))
    expect(seen).toEqual([])
  })

  it('an empty set from a connection that watches nothing is a no-op', () => {
    registry.setWatch('desktop', [CWD])
    expect(() => registry.setWatch('phone', [])).not.toThrow()
    expect(svcFor(CWD).stopPolling).not.toHaveBeenCalled()
    expect(managerMock.release).not.toHaveBeenCalled()
    expect(registry.watchersOf(CWD)).toEqual(['desktop'])
  })
})

describe('GitWatchRegistry — releaseConnection (the socket died)', () => {
  it('drops the connection from every cwd it held and tears down the orphans', () => {
    registry.setWatch('phone', [CWD, OTHER])
    registry.setWatch('desktop', [CWD])
    const svcOther = svcFor(OTHER)

    registry.releaseConnection('phone')

    // CWD still has the desktop -> poller survives.
    expect(svcFor(CWD).stopPolling).not.toHaveBeenCalled()
    expect(registry.watchersOf(CWD)).toEqual(['desktop'])
    // OTHER had only the phone -> torn down. Under the retired collective-owner
    // model this could only happen once the LAST client disconnected.
    expect(svcOther.stopPolling).toHaveBeenCalledTimes(1)
    expect(managerMock.release).toHaveBeenCalledWith(OTHER)
    expect(registry.watchersOf(OTHER)).toEqual([])
  })

  it('releasing a connection that holds nothing is a no-op', () => {
    registry.setWatch('desktop', [CWD])
    expect(() => registry.releaseConnection('phone')).not.toThrow()
    expect(svcFor(CWD).stopPolling).not.toHaveBeenCalled()
    expect(managerMock.release).not.toHaveBeenCalled()
    expect(registry.watchersOf(CWD)).toEqual(['desktop'])
  })

  it('releasing on an empty registry is a no-op', () => {
    expect(() => registry.releaseConnection('phone')).not.toThrow()
    expect(managerMock.release).not.toHaveBeenCalled()
  })

  it('a re-watch after release starts a fresh poller (reconnect)', () => {
    registry.setWatch('phone', [CWD])
    registry.releaseConnection('phone')
    registry.setWatch('phone-2', [CWD])
    expect(svcFor(CWD).startPolling).toHaveBeenCalledTimes(2)
    expect(registry.watchersOf(CWD)).toEqual(['phone-2'])
  })
})

describe('GitWatchRegistry — fan-out injection', () => {
  it('tracks watchers and polls even before init() installs a broadcast', () => {
    const bare = new GitWatchRegistry()
    bare.setWatch('c1', [CWD])
    expect(svcFor(CWD).startPolling).toHaveBeenCalledTimes(1)
    // No broadcaster yet: the tick must not throw, and the status is cached so a
    // later watcher still gets it.
    expect(() => svcFor(CWD).tick(status({ linesAdded: 6 }))).not.toThrow()

    const later: GitStatusData[] = []
    bare.init((_cwd, s) => later.push(s))
    bare.setWatch('c2', [CWD])
    expect(later).toEqual([status({ linesAdded: 6 })])
  })
})

/**
 * Unit tests for QuitCoordinator (R3).
 *
 * The verified bug this guards against: services were torn down on the FIRST
 * (possibly-cancelled) before-quit pass, and cancel still force-quit ~5s later.
 * These tests would fail against that old behavior — teardown-on-first-pass and
 * a surviving fallback timer after cancel both flip assertions here.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { QuitCoordinator, type QuitCoordinatorDeps } from '../quit-coordinator'

function makeDeps(overrides: Partial<QuitCoordinatorDeps> = {}): {
  deps: QuitCoordinatorDeps
  notifyRenderer: ReturnType<typeof vi.fn>
  teardownServices: ReturnType<typeof vi.fn>
  quit: ReturnType<typeof vi.fn>
} {
  const notifyRenderer = vi.fn()
  const teardownServices = vi.fn()
  const quit = vi.fn()
  return {
    notifyRenderer,
    teardownServices,
    quit,
    deps: { notifyRenderer, teardownServices, quit, fallbackMs: 5000, ...overrides }
  }
}

describe('QuitCoordinator', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('first before-quit vetoes, notifies renderer, and does NOT tear down services', () => {
    const { deps, notifyRenderer, teardownServices, quit } = makeDeps()
    const coord = new QuitCoordinator(deps)
    const preventQuit = vi.fn()

    coord.handleBeforeQuit(preventQuit)

    expect(preventQuit).toHaveBeenCalledOnce()
    expect(notifyRenderer).toHaveBeenCalledOnce()
    expect(teardownServices).not.toHaveBeenCalled() // <- old bug tore down here
    expect(quit).not.toHaveBeenCalled()
    expect(coord.isConfirmed).toBe(false)
  })

  it('cancel clears the fallback timer so the app never force-quits or tears down', () => {
    const { deps, teardownServices, quit } = makeDeps()
    const coord = new QuitCoordinator(deps)

    coord.handleBeforeQuit(vi.fn())
    coord.cancel()
    vi.advanceTimersByTime(10_000) // well past the 5s fallback

    expect(quit).not.toHaveBeenCalled() // <- old bug fired app.quit() here
    expect(teardownServices).not.toHaveBeenCalled()
    expect(coord.isConfirmed).toBe(false)
  })

  it('after cancel, a fresh quit attempt re-prompts (does not silently proceed)', () => {
    const { deps, notifyRenderer, quit } = makeDeps()
    const coord = new QuitCoordinator(deps)

    coord.handleBeforeQuit(vi.fn())
    coord.cancel()

    const preventQuit = vi.fn()
    coord.handleBeforeQuit(preventQuit)

    expect(preventQuit).toHaveBeenCalledOnce()
    expect(notifyRenderer).toHaveBeenCalledTimes(2)
    expect(quit).not.toHaveBeenCalled()
  })

  it('confirm quits, and the subsequent confirmed pass tears services down exactly once', () => {
    const { deps, teardownServices, quit } = makeDeps()
    const coord = new QuitCoordinator(deps)

    coord.handleBeforeQuit(vi.fn())
    coord.confirm()

    expect(quit).toHaveBeenCalledOnce()
    expect(coord.isConfirmed).toBe(true)
    expect(teardownServices).not.toHaveBeenCalled() // not until the real before-quit pass

    // app.quit() re-emits before-quit; now confirmed -> teardown, no veto.
    const preventQuit = vi.fn()
    coord.handleBeforeQuit(preventQuit)
    expect(preventQuit).not.toHaveBeenCalled()
    expect(teardownServices).toHaveBeenCalledOnce()

    // A second confirmed pass must not tear down again (idempotent).
    coord.handleBeforeQuit(vi.fn())
    expect(teardownServices).toHaveBeenCalledOnce()
  })

  it('fallback timer force-confirms and quits when the renderer never responds', () => {
    const { deps, teardownServices, quit } = makeDeps()
    const coord = new QuitCoordinator(deps)

    coord.handleBeforeQuit(vi.fn())
    expect(quit).not.toHaveBeenCalled()

    vi.advanceTimersByTime(5000)
    expect(quit).toHaveBeenCalledOnce()
    expect(coord.isConfirmed).toBe(true)

    // The quit it triggers re-emits before-quit -> teardown proceeds.
    coord.handleBeforeQuit(vi.fn())
    expect(teardownServices).toHaveBeenCalledOnce()
  })

  it('confirm clears an armed fallback so quit fires once, not twice', () => {
    const { deps, quit } = makeDeps()
    const coord = new QuitCoordinator(deps)

    coord.handleBeforeQuit(vi.fn())
    coord.confirm()
    vi.advanceTimersByTime(10_000)

    expect(quit).toHaveBeenCalledOnce()
  })

  describe('promptShown (S3: the renderer has the quit modal up)', () => {
    it('stops the fallback timer, so a user who is reading the modal is not force-quit after 5 s', () => {
      const { deps, quit, teardownServices } = makeDeps()
      const coord = new QuitCoordinator(deps)

      coord.handleBeforeQuit(vi.fn())
      coord.promptShown()
      vi.advanceTimersByTime(60_000)

      expect(quit).not.toHaveBeenCalled()
      expect(teardownServices).not.toHaveBeenCalled()
      expect(coord.isConfirmed).toBe(false)
    })

    it('the user can still decide afterwards: confirm quits, and cancel leaves the app running', () => {
      const a = makeDeps()
      const confirmed = new QuitCoordinator(a.deps)
      confirmed.handleBeforeQuit(vi.fn())
      confirmed.promptShown()
      confirmed.confirm()
      expect(a.quit).toHaveBeenCalledOnce()

      const b = makeDeps()
      const cancelled = new QuitCoordinator(b.deps)
      cancelled.handleBeforeQuit(vi.fn())
      cancelled.promptShown()
      cancelled.cancel()
      vi.advanceTimersByTime(60_000)
      expect(b.quit).not.toHaveBeenCalled()
      // ...and the next quit asks again, with the fallback armed again.
      cancelled.handleBeforeQuit(vi.fn())
      vi.advanceTimersByTime(5000)
      expect(b.quit).toHaveBeenCalledOnce()
    })

    it('a renderer that never acks still hits the fallback; a late ack after the fallback changes nothing', () => {
      const { deps, quit } = makeDeps()
      const coord = new QuitCoordinator(deps)

      coord.handleBeforeQuit(vi.fn())
      vi.advanceTimersByTime(5000)
      expect(quit).toHaveBeenCalledOnce()

      coord.promptShown()
      expect(coord.isConfirmed).toBe(true)
      coord.handleBeforeQuit(vi.fn())
      expect(quit).toHaveBeenCalledOnce()
    })

    it('a second quit press re-arms the fallback until the renderer acks again', () => {
      const { deps, quit } = makeDeps()
      const coord = new QuitCoordinator(deps)

      coord.handleBeforeQuit(vi.fn())
      coord.promptShown()
      coord.handleBeforeQuit(vi.fn()) // Cmd+Q again with the modal up
      coord.promptShown() // the renderer is asked again and acks again
      vi.advanceTimersByTime(60_000)

      expect(quit).not.toHaveBeenCalled()
    })
  })

  describe('worktree removal after teardown (ADR-112 C-S1)', () => {
    it('removes the confirmed worktrees AFTER the teardown, vetoing the quit once; the re-entered quit then passes', async () => {
      const order: string[] = []
      let release!: () => void
      const removeWorktrees = vi.fn(async (paths: string[]) => {
        order.push(`remove:${paths.join(',')}`)
        await new Promise<void>((resolve) => (release = resolve))
      })
      const { deps, teardownServices, quit } = makeDeps({ removeWorktrees })
      teardownServices.mockImplementation(() => order.push('teardown'))
      quit.mockImplementation(() => order.push('quit'))
      const coord = new QuitCoordinator(deps)

      coord.handleBeforeQuit(vi.fn())
      coord.confirm(['/r/.claude/worktrees/a'])
      expect(order).toEqual(['quit']) // app.quit() -> the confirmed pass follows
      const veto = vi.fn()
      coord.handleBeforeQuit(veto)

      expect(order).toEqual(['quit', 'teardown', 'remove:/r/.claude/worktrees/a'])
      expect(veto).toHaveBeenCalledOnce() // the process must stay alive while the delete runs

      // Cmd+Q again mid-removal: vetoed, nothing torn down twice, no second removal.
      const again = vi.fn()
      coord.handleBeforeQuit(again)
      expect(again).toHaveBeenCalledOnce()
      expect(removeWorktrees).toHaveBeenCalledOnce()

      release()
      await vi.advanceTimersByTimeAsync(0)
      expect(quit).toHaveBeenCalledTimes(2)
      const last = vi.fn()
      coord.handleBeforeQuit(last)
      expect(last).not.toHaveBeenCalled() // now the quit really proceeds
      expect(teardownServices).toHaveBeenCalledOnce()
      expect(removeWorktrees).toHaveBeenCalledOnce()
    })

    it('without paths the quit is exactly the old one (no veto, no removal)', () => {
      const removeWorktrees = vi.fn(async () => {})
      const { deps } = makeDeps({ removeWorktrees })
      const coord = new QuitCoordinator(deps)
      coord.handleBeforeQuit(vi.fn())
      coord.confirm()
      const veto = vi.fn()
      coord.handleBeforeQuit(veto)
      expect(veto).not.toHaveBeenCalled()
      expect(removeWorktrees).not.toHaveBeenCalled()
    })

    it('the 5 s fallback cannot cut a confirmed removal off: confirm() clears it', async () => {
      const removeWorktrees = vi.fn(() => new Promise<void>(() => {}))
      const { deps, quit } = makeDeps({ removeWorktrees, removeTimeoutMs: 60_000 })
      const coord = new QuitCoordinator(deps)
      coord.handleBeforeQuit(vi.fn())
      coord.confirm(['/r/a'])
      coord.handleBeforeQuit(vi.fn())
      await vi.advanceTimersByTimeAsync(30_000) // far past the 5 s fallback
      expect(quit).toHaveBeenCalledTimes(1) // only confirm()'s own quit; removal still running
    })

    it('a hung removal is bounded, and a failing one still quits', async () => {
      const hung = vi.fn(() => new Promise<void>(() => {}))
      const a = makeDeps({ removeWorktrees: hung, removeTimeoutMs: 1000 })
      const coordA = new QuitCoordinator(a.deps)
      coordA.handleBeforeQuit(vi.fn())
      coordA.confirm(['/r/a'])
      coordA.handleBeforeQuit(vi.fn())
      await vi.advanceTimersByTimeAsync(999)
      expect(a.quit).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(a.quit).toHaveBeenCalledTimes(2)

      const failing = vi.fn(async () => {
        throw new Error('EBUSY')
      })
      const b = makeDeps({ removeWorktrees: failing })
      const coordB = new QuitCoordinator(b.deps)
      coordB.handleBeforeQuit(vi.fn())
      coordB.confirm(['/r/a'])
      coordB.handleBeforeQuit(vi.fn())
      await vi.advanceTimersByTimeAsync(0)
      expect(b.quit).toHaveBeenCalledTimes(2)
    })

    it('a repeated confirm() without paths keeps the earlier paths', () => {
      const removeWorktrees = vi.fn(async () => {})
      const { deps } = makeDeps({ removeWorktrees })
      const coord = new QuitCoordinator(deps)
      coord.handleBeforeQuit(vi.fn())
      coord.confirm(['/r/a'])
      coord.confirm()
      coord.handleBeforeQuit(vi.fn())
      expect(removeWorktrees).toHaveBeenCalledWith(['/r/a'])
    })
  })

  describe('prepareQuit (ADR-097 §5: the opencode slot is handed back while services live)', () => {
    it('runs once after confirm, BEFORE quit and while nothing is torn down', async () => {
      let release!: () => void
      const prepareQuit = vi.fn(() => new Promise<void>((resolve) => (release = resolve)))
      const { deps, teardownServices, quit } = makeDeps({ prepareQuit })
      const coord = new QuitCoordinator(deps)
      coord.handleBeforeQuit(vi.fn())
      coord.confirm()
      coord.confirm()
      expect(prepareQuit).toHaveBeenCalledOnce()
      expect(quit).not.toHaveBeenCalled()
      expect(teardownServices).not.toHaveBeenCalled()
      release()
      await vi.advanceTimersByTimeAsync(0)
      expect(quit).toHaveBeenCalledOnce()
    })

    it('is bounded: a hung prepare cannot block the quit', async () => {
      const prepareQuit = vi.fn(() => new Promise<void>(() => {}))
      const { deps, quit } = makeDeps({ prepareQuit, prepareTimeoutMs: 1000 })
      const coord = new QuitCoordinator(deps)
      coord.handleBeforeQuit(vi.fn())
      coord.confirm()
      await vi.advanceTimersByTimeAsync(999)
      expect(quit).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(quit).toHaveBeenCalledOnce()
    })

    it('a second quit while the prepare runs is vetoed and tears nothing down', async () => {
      let release!: () => void
      const prepareQuit = vi.fn(() => new Promise<void>((resolve) => (release = resolve)))
      const { deps, teardownServices, quit } = makeDeps({ prepareQuit })
      const coord = new QuitCoordinator(deps)
      coord.handleBeforeQuit(vi.fn())
      coord.confirm()
      const second = vi.fn()
      coord.handleBeforeQuit(second) // Cmd+Q again, mid-removal
      expect(second).toHaveBeenCalledOnce()
      expect(teardownServices).not.toHaveBeenCalled()
      release()
      await vi.advanceTimersByTimeAsync(0)
      expect(quit).toHaveBeenCalledOnce()
      // The real quit pass that follows tears down once.
      const third = vi.fn()
      coord.handleBeforeQuit(third)
      expect(third).not.toHaveBeenCalled()
      expect(teardownServices).toHaveBeenCalledOnce()
    })

    it('a failing prepare still quits, and the fallback path prepares too', async () => {
      const prepareQuit = vi.fn(async () => {
        throw new Error('opencode gone')
      })
      const { deps, quit } = makeDeps({ prepareQuit })
      const coord = new QuitCoordinator(deps)
      coord.handleBeforeQuit(vi.fn())
      await vi.advanceTimersByTimeAsync(5000) // the renderer never answered
      expect(prepareQuit).toHaveBeenCalledOnce()
      expect(quit).toHaveBeenCalledOnce()
    })
  })
})

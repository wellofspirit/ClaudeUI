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

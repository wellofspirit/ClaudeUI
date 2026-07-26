/**
 * QuitCoordinator — the quit-state machine behind Electron's `before-quit`.
 *
 * The window may hold active git worktrees the user has not yet decided about,
 * so quitting is a two-phase handshake with the renderer:
 *
 *   1. First `before-quit` (unconfirmed): veto the quit, ask the renderer to
 *      prompt, and arm a fallback timer. Services stay ALIVE — a cancel must
 *      leave the app fully working, so nothing is torn down here.
 *   2. Confirmed `before-quit` (after `confirm()` or the fallback timer): tear
 *      the services down and let the quit proceed.
 *
 * Extracted from `index.ts` (a) to fix the verified bug where services were
 * destroyed on the first, possibly-cancelled pass, and (b) so the state
 * transitions are unit-testable without an Electron app.
 *
 * The Electron dependencies (preventDefault, notifying the renderer, quitting,
 * the service teardown) are injected, so this class is pure and testable.
 */
export interface QuitCoordinatorDeps {
  /** Notify the renderer that a quit was requested (send `app:before-quit`). */
  notifyRenderer: () => void
  /** Tear down all process-lifetime services. Runs ONLY on the real quit. */
  teardownServices: () => void
  /** Actually quit the app (`app.quit()`). */
  quit: () => void
  /** Fallback timeout (ms) before force-quitting if the renderer never responds. Default 5000. */
  fallbackMs?: number
}

export class QuitCoordinator {
  private confirmed = false
  private toreDown = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly fallbackMs: number

  constructor(private readonly deps: QuitCoordinatorDeps) {
    this.fallbackMs = deps.fallbackMs ?? 5000
  }

  /**
   * Handle an app `before-quit`.
   *
   * @param preventQuit invoked to veto this quit pass (i.e. `event.preventDefault()`).
   */
  handleBeforeQuit(preventQuit: () => void): void {
    if (this.confirmed) {
      // Real quit — tear down once, then let Electron proceed (no preventDefault).
      this.teardown()
      return
    }
    // First pass — keep everything running; ask the renderer and arm a fallback.
    preventQuit()
    this.deps.notifyRenderer()
    this.armFallback()
  }

  /** Renderer confirmed the quit (Keep-all / Remove-all). */
  confirm(): void {
    this.clearTimer()
    this.confirmed = true
    this.deps.quit()
  }

  /**
   * Renderer cancelled the quit. Services are untouched (they were never torn
   * down), the fallback timer is cleared, and a later quit re-prompts.
   */
  cancel(): void {
    this.clearTimer()
    // `confirmed` intentionally stays false.
  }

  /** Exposed for assertions / diagnostics. */
  get isConfirmed(): boolean {
    return this.confirmed
  }

  private armFallback(): void {
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      this.confirmed = true
      this.deps.quit()
    }, this.fallbackMs)
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private teardown(): void {
    if (this.toreDown) return
    this.toreDown = true
    this.deps.teardownServices()
  }
}

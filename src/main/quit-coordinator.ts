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
 *      the services down and let the quit proceed. When the renderer confirmed
 *      WITH worktree paths (the quit modal's "Remove all"), the quit is vetoed
 *      once more right after the teardown while those directories are deleted
 *      (no engine or shell holds their cwd any more), then `quit()` re-enters
 *      and passes. The fallback timer is cleared by `confirm()`, so it can never
 *      cut a confirmed removal off.
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
  /**
   * Async work that needs the services ALIVE and must finish before the real
   * quit (ADR-097 §5: giving opencode's ChatGPT slot back to the user's own
   * credential needs an opencode server). Runs once, after the quit is
   * confirmed and before `quit()`, bounded by `prepareTimeoutMs`; a failure
   * never stops the quit.
   */
  prepareQuit?: () => Promise<void>
  /** Bound on `prepareQuit` (ms). Default 4000. */
  prepareTimeoutMs?: number
  /**
   * Delete the worktree directories the renderer confirmed (C-S1, ADR-112). Runs once, AFTER
   * `teardownServices` and before the process exits; it must stop whatever still holds those
   * directories itself (sessions, shells) and never throws into the quit — a rejection is
   * swallowed so the quit goes on.
   */
  removeWorktrees?: (paths: string[]) => Promise<void>
  /** Bound on `removeWorktrees` (ms): a hung delete cannot keep the app open. Default 120000. */
  removeTimeoutMs?: number
}

export class QuitCoordinator {
  private confirmed = false
  private toreDown = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private preparing = false
  private prepared = false
  /** Worktree paths the renderer confirmed for removal; consumed once after the teardown. */
  private pendingRemoval: string[] = []
  private removing = false
  private removed = false
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
    // A second quit while `prepareQuit` still runs (Cmd+Q again) must not tear
    // the services down under it: veto it; the prepare's own bound quits.
    if ((this.preparing && !this.prepared) || this.removing) {
      preventQuit()
      return
    }
    if (this.confirmed) {
      // Real quit — tear down once, then let Electron proceed (no preventDefault) —
      // unless confirmed worktrees still have to go: veto, delete them, quit again.
      this.teardown()
      if (this.pendingRemoval.length > 0 && this.deps.removeWorktrees && !this.removed) {
        preventQuit()
        this.runRemoval(this.deps.removeWorktrees)
      }
      return
    }
    // First pass — keep everything running; ask the renderer and arm a fallback.
    preventQuit()
    this.deps.notifyRenderer()
    this.armFallback()
  }

  /**
   * Renderer confirmed the quit (Keep-all / Remove-all). `worktreePaths`: the worktrees
   * "Remove all" chose, deleted after the teardown (see {@link QuitCoordinatorDeps.removeWorktrees}).
   */
  confirm(worktreePaths: string[] = []): void {
    this.clearTimer()
    this.confirmed = true
    // A repeated confirm (double click) with no paths must not drop an earlier one's.
    const paths = worktreePaths.filter((p) => typeof p === 'string' && p !== '')
    if (paths.length > 0) this.pendingRemoval = paths
    this.proceed()
  }

  /**
   * The renderer is showing its quit modal: stop the fallback timer, which exists only for a
   * renderer that never answers. `confirm()` / `cancel()` follow when the user decides. Ignored
   * once the quit is confirmed (nothing to wait for any more).
   */
  promptShown(): void {
    if (!this.confirmed) this.clearTimer()
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
      this.proceed()
    }, this.fallbackMs)
  }

  /** Run `prepareQuit` (once, bounded), then quit. */
  private proceed(): void {
    const prepare = this.deps.prepareQuit
    if (!prepare) {
      this.deps.quit()
      return
    }
    if (this.preparing) return
    this.preparing = true
    let bound: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>((done) => {
      bound = setTimeout(done, this.deps.prepareTimeoutMs ?? 4000)
    })
    const prepared = (async () => prepare())().catch(() => undefined)
    void Promise.race([prepared, timeout]).finally(() => {
      clearTimeout(bound)
      this.prepared = true
      this.deps.quit()
    })
  }

  /** Delete the confirmed worktrees (bounded), then re-enter the quit. */
  private runRemoval(remove: (paths: string[]) => Promise<void>): void {
    const paths = this.pendingRemoval
    this.pendingRemoval = []
    this.removing = true
    let bound: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>((done) => {
      bound = setTimeout(done, this.deps.removeTimeoutMs ?? 120_000)
    })
    const removal = (async () => remove(paths))().catch(() => undefined)
    void Promise.race([removal, timeout]).finally(() => {
      clearTimeout(bound)
      this.removing = false
      this.removed = true
      this.deps.quit()
    })
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

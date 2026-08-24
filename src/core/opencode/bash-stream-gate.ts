/**
 * Dedup + trailing-edge throttle gate for opencode bash live-output streaming.
 *
 * opencode's shell tool re-publishes `ctx.metadata({ metadata: { output } })`
 * on EVERY chunk of stdout/stderr — potentially many times per second for a
 * chatty command — with a CUMULATIVE tail preview as the payload. Feeding
 * every one of those straight into a `session:bash-output` IPC emission would
 * flood the renderer. This gate sits between the two:
 *
 *   - Dedup: an unchanged output string (same value re-delivered, e.g. from a
 *     re-iteration of the part map on an unrelated part update) is a no-op.
 *   - Throttle: at most one emission per `intervalMs` per key, TRAILING-EDGE
 *     only — the first update in a quiet period starts a timer; further
 *     updates before the timer fires just replace the pending value; when the
 *     timer fires, the LATEST pending value is emitted. No update is ever
 *     silently dropped forever — the last one always flushes.
 *
 * Pure logic, no I/O: the caller supplies the `emit` callback and owns when to
 * `cancel`/`cancelAll` (e.g. on tool completion or session teardown). Uses the
 * ambient `setTimeout`/`clearTimeout` so tests can drive it with
 * `vi.useFakeTimers()` without mocking this module.
 */
export interface BashStreamGateOptions {
  /** Throttle window in ms. Defaults to 100. */
  intervalMs?: number
}

export class BashStreamGate {
  private readonly intervalMs: number
  /** Last value actually flushed to `emit`, per key. */
  private readonly lastSent = new Map<string, string>()
  /** Latest value queued for the next flush, per key (present only while a timer is running). */
  private readonly pending = new Map<string, string>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(
    private readonly emit: (key: string, value: string) => void,
    options: BashStreamGateOptions = {}
  ) {
    this.intervalMs = options.intervalMs ?? 100
  }

  /**
   * Feed a new value for `key`. Dedups against the last flushed (or currently
   * pending) value and throttles the actual `emit` call to the trailing edge
   * of `intervalMs`.
   */
  update(key: string, value: string): void {
    const current = this.pending.get(key) ?? this.lastSent.get(key)
    if (value === current) return // unchanged — no-op

    this.pending.set(key, value)
    if (this.timers.has(key)) return // window already running — latest value will flush when it fires

    const timer = setTimeout(() => this.flush(key), this.intervalMs)
    this.timers.set(key, timer)
  }

  private flush(key: string): void {
    this.timers.delete(key)
    const value = this.pending.get(key)
    this.pending.delete(key)
    if (value === undefined) return
    this.lastSent.set(key, value)
    this.emit(key, value)
  }

  /** Discard any pending timer/value + last-sent tracking for `key` (e.g. on tool completion). */
  cancel(key: string): void {
    const timer = this.timers.get(key)
    if (timer) clearTimeout(timer)
    this.timers.delete(key)
    this.pending.delete(key)
    this.lastSent.delete(key)
  }

  /** Discard all pending timers/state for every key (e.g. on session teardown). */
  cancelAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.pending.clear()
    this.lastSent.clear()
  }
}

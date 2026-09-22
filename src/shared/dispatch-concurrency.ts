/**
 * How many dispatched agents may run at once, app-wide (ADR-033, 2026-09-18
 * ruling): "the slot can be a configuration as well, so we can have more slots.
 * not saying I want to hide the effect, but in certain cases we will need more
 * dispatches".
 *
 * A leaf module on purpose. The dispatcher (main) and the Settings row
 * (renderer) must agree on the resolution rule down to the edge cases, and the
 * dispatcher's own module drags the whole opencode/pi/codex target machinery
 * with it — importing that into the renderer to share one number is not a
 * trade worth making.
 */

/**
 * The cap when the setting is unset. Unchanged from the constant this replaced,
 * so the effect of the ruling is opt-in: nobody's behaviour moves until they
 * raise it.
 */
export const DEFAULT_MAX_CONCURRENT_DISPATCHES = 3

/**
 * `AppSettings.dispatchMaxConcurrent` → the effective cap.
 *
 *  - unset / not a number / negative → {@link DEFAULT_MAX_CONCURRENT_DISPATCHES}.
 *    A negative count is a fumbled keystroke, not a request; the same
 *    drop-the-key treatment the dispatch timeout fields give it.
 *  - `0` → `Infinity`, i.e. no limit. Returned as a number rather than a
 *    sentinel so the gate stays one `>=` comparison and cannot forget to
 *    special-case it.
 *  - anything else → itself, floored to a whole agent, at least 1. A cap below
 *    one slot would refuse every dispatch, which no user means by "0.5".
 */
export function resolveDispatchMaxConcurrent(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
    return DEFAULT_MAX_CONCURRENT_DISPATCHES
  }
  if (raw === 0) return Number.POSITIVE_INFINITY
  return Math.max(1, Math.floor(raw))
}

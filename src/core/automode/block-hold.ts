/**
 * The timer behind a held auto-mode block (ADR-091 §3) — one implementation
 * for every engine that holds one (pi, opencode, their dispatch targets).
 *
 * A judge block that trips no denial cap no longer goes straight back to the
 * engine: the caller parks the call on its human path with a Keep blocked /
 * Approve anyway card. Unanswered, the hold resolves exactly as Keep blocked
 * once {@link AUTO_MODE_BLOCK_HOLD_MS} has passed, so an unattended session
 * keeps moving. The caller's `onExpire` must run the SAME code path a Keep
 * blocked click does (card withdrawal, the `automode-blocked` outcome and the
 * model's deny text identical), and every other resolution — approve, keep,
 * interrupt, abandonment, teardown — must call `cancel()`.
 */

/** How long a held block waits for the user before it resolves as Keep blocked. */
export const AUTO_MODE_BLOCK_HOLD_MS = 120_000

export interface BlockHoldTimer {
  /** Epoch ms the hold resolves at → `PendingApproval.autoModeBlock.expiresAt`. */
  expiresAt: number
  /** Disarm. Idempotent; a no-op once the timer has fired. */
  cancel: () => void
}

/** Arm one hold's expiry. `onExpire` runs at most once, and never after `cancel()`. */
export function armBlockHold(
  onExpire: () => void,
  holdMs: number = AUTO_MODE_BLOCK_HOLD_MS
): BlockHoldTimer {
  const timer = setTimeout(onExpire, holdMs)
  // A pending hold must never keep a headless host process alive on its own.
  timer.unref?.()
  return { expiresAt: Date.now() + holdMs, cancel: () => clearTimeout(timer) }
}

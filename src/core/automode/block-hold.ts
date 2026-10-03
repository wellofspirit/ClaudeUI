/**
 * The timer behind a held auto-mode block (ADR-091 §3) — one implementation
 * for every engine that holds one (pi, opencode, their dispatch targets).
 *
 * A judge block that trips no denial cap no longer goes straight back to the
 * engine: when the user's hold window ({@link blockHoldMs}, ADR-091 part 6) is
 * above zero, the caller parks the call on its human path with a Keep blocked
 * / Approve anyway card. Unanswered, the hold resolves exactly as Keep blocked
 * once the window has passed, so an unattended session keeps moving. The
 * caller's `onExpire` must run the SAME code path a Keep blocked click does
 * (card withdrawal, the `automode-blocked` outcome and the model's deny text
 * identical), and every other resolution — approve, keep, interrupt,
 * abandonment, teardown — must call `cancel()`. A window of zero holds
 * nothing: the caller denies at once through that same Keep blocked path, and
 * the user can approve the block afterwards (`blocked-calls.ts`).
 */
import { loadSharedAutoModeConfig, normalizeBlockHoldSeconds } from '../services/ui-config'

export interface BlockHoldTimer {
  /** Epoch ms the hold resolves at → `PendingApproval.autoModeBlock.expiresAt`. */
  expiresAt: number
  /** Disarm. Idempotent; a no-op once the timer has fired. */
  cancel: () => void
}

/**
 * The hold window for a block arriving NOW, in ms: the user's live
 * `blockHoldSeconds` (ADR-091 part 6), read per block so a settings change
 * binds the next one. 0 — the default, and the answer when the file cannot be
 * read — means no hold.
 */
export function blockHoldMs(): number {
  try {
    return normalizeBlockHoldSeconds(loadSharedAutoModeConfig().blockHoldSeconds) * 1000
  } catch {
    return 0
  }
}

/** Arm one hold's expiry. `onExpire` runs at most once, and never after `cancel()`. */
export function armBlockHold(onExpire: () => void, holdMs: number): BlockHoldTimer {
  const timer = setTimeout(onExpire, holdMs)
  // A pending hold must never keep a headless host process alive on its own.
  timer.unref?.()
  return { expiresAt: Date.now() + holdMs, cancel: () => clearTimeout(timer) }
}

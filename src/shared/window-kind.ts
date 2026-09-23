/**
 * What kind of limit window a reading describes, from the LENGTH the vendor
 * states (ADR-071 §6).
 *
 * The kind used to come from the window's POSITION in the payload: Codex's
 * `primary` window was filed as `5h` and `secondary` as `7d`. That is wrong on
 * real plans — a ChatGPT plan with only a weekly limit delivers it as
 * `primary`, so a seven-day window was stored, summed and labelled as a
 * five-hour one (owner, 2026-09-21: "don't just assume, use trusted value").
 * The API states the length: the ChatGPT backend answers
 * `primary_window.limit_window_seconds`, Codex converts it to `window_minutes`
 * and the app-server wire carries it as `windowDurationMins`.
 *
 * So the kind is DERIVED FROM THE DURATION, in one place, for core and renderer
 * alike. It is a grouping key (`usage_window_sample.window_kind`,
 * `usage_window.window_kind`, ADR-072's relay), so the spelling has to be
 * stable and the same on every machine: `5h`, `7d`, and otherwise the plain
 * arithmetic — `3d`, `1h`, `45m`.
 *
 * A window with NO stated duration keeps the slot's own name (`primary`,
 * `secondary`), which is all we honestly know, and is labelled `limit`. It is
 * never guessed into `5h`, and {@link windowKindMinutes} answers null for it —
 * a window with no length has no numerator, so ADR-071 §7's value ledger
 * samples it and never materialises it.
 *
 * Claude's kinds are NOT derived here. `/api/oauth/usage` names its windows
 * itself (`five_hour`, `seven_day`, `weekly_scoped`), so `5h`, `7d` and
 * `7d:<slug>` come from the payload's own vocabulary; this module only has to
 * agree with them, which the 300 / 10,080-minute cases do.
 */

const MINUTES_PER_HOUR = 60
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR

/** The two lengths that have a name of their own, and everything else's suffix. */
const FIVE_HOUR_MINUTES = 5 * MINUTES_PER_HOUR
const SEVEN_DAY_MINUTES = 7 * MINUTES_PER_DAY

/**
 * Which window of a ChatGPT reading this is, when nothing else is known.
 *
 * `RateLimitSnapshot` carries two slots and the backend fills whichever ones
 * the plan has, so the slot is a position, not a length — it is the kind ONLY
 * when the duration is absent.
 */
export type WindowSlot = 'primary' | 'secondary'

/** The label for a window whose length the vendor did not state. */
export const UNKNOWN_WINDOW_LABEL = 'limit'

/** `5h`, `7d`, `3d`, `1h`, `45m` — split into its number and its unit. */
const KIND_PATTERN = /^(\d+(?:\.\d+)?)([dhm])$/

const UNIT_WORD: Record<string, string> = { d: 'day', h: 'hour', m: 'minute' }
const UNIT_MINUTES: Record<string, number> = { d: MINUTES_PER_DAY, h: MINUTES_PER_HOUR, m: 1 }

function usableMinutes(minutes: number | null | undefined): number | null {
  return typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0 ? minutes : null
}

/**
 * The canonical kind of a window that lasts `minutes`, or the slot's own name
 * when it does not say how long it lasts.
 *
 * Whole days and whole hours get the unit a person would use for them, so a
 * three-day window reads `3d` rather than `4320m`. A length that is neither —
 * Codex's own fixtures use 1800 s and 3600 s windows, so arbitrary values are
 * expected — keeps its minutes, fraction and all: two readings of one window
 * must produce the same grouping key, and rounding is what would break that.
 */
export function windowKindForMinutes(minutes: number | null | undefined, slot: WindowSlot): string {
  const usable = usableMinutes(minutes)
  if (usable === null) return slot
  if (usable === FIVE_HOUR_MINUTES) return '5h'
  if (usable === SEVEN_DAY_MINUTES) return '7d'
  if (Number.isInteger(usable) && usable % MINUTES_PER_DAY === 0) {
    return `${usable / MINUTES_PER_DAY}d`
  }
  if (Number.isInteger(usable) && usable % MINUTES_PER_HOUR === 0) {
    return `${usable / MINUTES_PER_HOUR}h`
  }
  return `${usable}m`
}

/**
 * The kinds of ONE reading's two slots, guaranteed distinct.
 *
 * Deriving a kind from the duration lost a property the positional scheme had
 * for free: two slots can state the SAME length, and the kind is an identity
 * everywhere downstream — `recordLimitSamples` dedups by it,
 * `usage_window`'s primary key contains it, `latestWindowSamples` returns one
 * row per kind, and the accounts panel keys its meters by it. Two windows
 * sharing a kind would silently become one series, with one slot's reading
 * overwriting the other's.
 *
 * So when both slots derive the same kind, the SECONDARY becomes
 * `<kind>:secondary`. The `:` suffix already means "a variant of this base
 * window" (`7d:fable`, a scoped weekly), {@link windowKindMinutes} already
 * reads the length off the base, and {@link windowKindLabel} already spells the
 * suffix out — so nothing downstream needs a new case.
 *
 * Pass the reading as it is currently KNOWN, not only what the latest push
 * carried: a sparse update that mentions one slot must not re-file that slot's
 * window under a different kind than the full read did.
 */
export function windowKindsForReading(reading: {
  primary?: { windowMinutes?: number | null } | null
  secondary?: { windowMinutes?: number | null } | null
}): { primary: string; secondary: string } {
  const primary = windowKindForMinutes(reading.primary?.windowMinutes, 'primary')
  const secondary = windowKindForMinutes(reading.secondary?.windowMinutes, 'secondary')
  // Equality is only reachable when both slots state the same duration: an
  // absent or length-less slot keeps its own name, and the two names differ.
  return { primary, secondary: secondary === primary ? `${secondary}:secondary` : secondary }
}

/**
 * How long a window of this kind lasts, in minutes — null when its name does
 * not say.
 *
 * The kind is the fallback for a row that carries no duration of its own:
 * Claude's windows have never had one (their lengths are fixed by the names the
 * API gives them), and a ChatGPT row written before the duration was kept has
 * only its kind. A scoped weekly (`7d:fable`) is a week, like its base.
 */
export function windowKindMinutes(kind: string): number | null {
  const base = kind.split(':')[0]
  const match = KIND_PATTERN.exec(base)
  if (!match) return null
  return Number(match[1]) * UNIT_MINUTES[match[2]]
}

/**
 * The window kind as a person says it: `5-hour`, `7-day`, `45-minute`, and
 * `limit` for one whose length is unknown.
 *
 * A scoped weekly keeps its slug beside the base label (`7-day fable`), which
 * is what the sample table can reconstruct — the server's display name is not
 * stored, only its slug.
 */
export function windowKindLabel(kind: string): string {
  const [base, ...rest] = kind.split(':')
  const suffix = rest.join(':').replace(/-/g, ' ')
  const match = KIND_PATTERN.exec(base)
  const label = match ? `${match[1]}-${UNIT_WORD[match[2]]}` : null
  if (label === null) {
    // `primary` / `secondary` — and any other kind that names no length. The
    // slot is not worth showing a user: what they are looking at is a limit
    // whose window the vendor did not describe.
    return base === 'primary' || base === 'secondary' ? UNKNOWN_WINDOW_LABEL : kind
  }
  return suffix ? `${label} ${suffix}` : label
}

/**
 * Is this window short enough to be acted on inside a working session?
 *
 * The split the reset text needs: a window that turns over in hours is read as
 * a countdown, one that is days away as a weekday and a clock time. Decided by
 * the LENGTH when it is known, and by nothing else when it is not — an unknown
 * window gets the countdown, which is true of any window regardless of how long
 * it is.
 */
export function isShortWindow(kind: string, windowMinutes?: number | null): boolean {
  const minutes = usableMinutes(windowMinutes) ?? windowKindMinutes(kind)
  return minutes === null ? true : minutes < MINUTES_PER_DAY
}

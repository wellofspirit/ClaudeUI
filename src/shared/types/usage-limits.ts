// ---------------------------------------------------------------------------
// Account usage types (5hr / 7-day rate windows)
// ---------------------------------------------------------------------------

export interface RateWindow {
  usedPercent: number // 0-100
  resetsAt: string | null // ISO8601 timestamp
  /**
   * How long the window lasts, when the vendor says (ADR-071 §6, S3c).
   *
   * ChatGPT states it (`limit_window_seconds`, converted to minutes) and it is what the window's KIND is derived from, so
   * a plan with only a weekly limit is no longer filed as a five-hour one.
   * Claude never states it: its windows are named by the API itself
   * (`five_hour`, `seven_day`), so the name carries the length and this stays
   * absent. Absent and null mean the same thing — no stated length.
   */
  windowMinutes?: number | null
}

/**
 * ChatGPT subscription usage for ONE stored vault account (ADR-068 §2).
 *
 * The backend's rate-limit windows map onto {@link RateWindow} one to one —
 * `used_percent` is already 0-100 and `reset_at` is a unix timestamp in SECONDS,
 * converted to ISO 8601 on the way in so the panel's existing
 * `formatResetTime` works unchanged.
 *
 * `primary` and `secondary` are SLOTS, not lengths (corrected 2026-09-21, S3c):
 * the backend fills whichever ones the plan has, and a plan with one weekly
 * limit delivers it as `primary`. How long each window lasts is
 * {@link RateWindow.windowMinutes}, and `windowKindForMinutes` is what turns
 * that into a kind and a label. Either slot is null when the backend did not
 * report it, which the panel shows as unavailable rather than as zero usage.
 */
export interface ChatgptAccountLimits {
  email?: string
  planType?: string
  primary: RateWindow | null
  secondary: RateWindow | null
  /**
   * A CREDITS-based plan (a business workspace, seen live 2026-09-14) reports no
   * windows at all — both are null — and answers with a credit balance instead.
   * Percentage bars are not the shape that plan has, so the balance is what the
   * panel shows for it. Absent when the backend says the account has no credits.
   */
  credits?: { unlimited: boolean; balance: string | null }
  /**
   * What a workspace's spend controls allow THIS member to use — see
   * {@link CreditLimit}. Absent when the workspace sets no per-member limit.
   */
  creditLimit?: CreditLimit
  fetchedAt: number
}

/**
 * A business workspace member's credit allowance: the backend's
 * `spend_control.individual_limit`, which the Codex CLI's `/status`
 * renders as "Monthly credit limit — N of M credits used".
 *
 * It is what makes a credits plan's usage legible. `credits` only says the
 * workspace HAS credits (its balance is usually withheld from members), while
 * this says how much of the member's share is spent.
 *
 * The wire carries the amounts as decimal STRINGS; they are parsed once on the
 * way in, and an allowance whose amounts do not parse is dropped whole.
 * `resetsAt` is ISO 8601 like every
 * {@link RateWindow}. It is a month away, not a rolling window, so it is never a
 * window kind and is not sampled (ADR-071 §6 samples rolling windows only).
 */
export interface CreditLimit {
  used: number
  limit: number
  /** 0-100, as the backend states it — not recomputed from the amounts. */
  remainingPercent: number
  resetsAt: string | null
}

/** Every account's limits, keyed by VAULT account id (never the workspace id). */
export type ChatgptRateLimits = Record<string, ChatgptAccountLimits>

export interface ExtraUsage {
  isEnabled: boolean
  monthlyLimit: number | null // null = unlimited, otherwise in cents (divide by 100 for dollars)
  usedCredits: number // in cents (divide by 100 for dollars)
  utilization: number // percentage 0-100
}

/** One limit window of an account's reading (ADR-071 §6). */
export interface AccountLimitWindow {
  /**
   * The canonical window id: `5h`, `7d`, or `7d:<model>` for a per-model weekly
   * bucket. It is a GROUPING key — what makes two readings of the same window,
   * on this machine and on another, the same series (ADR-072 §4) — never an
   * identity of spend.
   */
  kind: '5h' | '7d' | string
  /** The display name — `5-hour`, `7-day`, `7-day Fable`, `limit`. */
  label: string
  usedPercent: number
  resetsAt: string | null
  /** The window's length when the vendor stated it — see {@link RateWindow.windowMinutes}. */
  windowMinutes?: number | null
}

/**
 * What one vendor account's limits provider observed (ADR-071 §6).
 *
 * One shape for every vendor, so the dashboard and ADR-072's hub read Claude's
 * 5-hour window and a ChatGPT workspace's weekly one through the same fields.
 * `state` carries WHY a reading is thin instead of leaving the caller to infer
 * it from an empty `windows` array:
 *
 *  - `ok` — read just now;
 *  - `stale` — the last PERSISTED reading, no token spent (an inactive Claude
 *    account with `refresh: false`, the owner's refresh-grant rule);
 *  - `needs-sign-in` — the stored credential no longer authenticates;
 *  - `unavailable` — nothing was readable and nothing is stored.
 */
export interface AccountLimits {
  /** ADR-071 §3's key, or `unknown` when the account's identity is not yet captured. */
  accountKey: string
  label: string
  vendorId: string
  plan: string | null
  windows: AccountLimitWindow[]
  credits?: { unlimited: boolean; balance: string | null }
  /**
   * Local, or relayed through the hub's credits relay (ADR-072 §4, amended
   * 2026-10-01) for an account only another machine reads.
   */
  creditLimit?: CreditLimit
  /**
   * For a RELAYED credit reading only: which machine took it, and when. The
   * credits relay is separate from the window relay, so on a row that has both
   * they can come from different machines at different times, and the tag beside
   * each meter has to describe the reading it sits beside. {@link source} and
   * {@link observedAt} describe the windows when there are any.
   */
  creditSource?: { deviceId: string; deviceName: string }
  creditObservedAt?: number
  observedAt: number
  /**
   * Where the reading came from — ADR-072 relays readings from other machines.
   *
   * The NAME travels with the reading, not only the id. A relayed reading is
   * shown under both scopes (ADR-072 §4: a limit is a fact about the account,
   * and the dashboard scope decides whose spend is summed), so it cannot borrow
   * the machine list from a combined payload that may not exist — a `via` tag
   * reading `via 3f2a1b9c` is not an answer to "who read this". The id is the
   * fallback for a device the hub has since dropped from its list.
   */
  source: 'local' | { deviceId: string; deviceName: string }
  /**
   * True when {@link label} is the hub's MASKED form (`d•••@e•••.com`) rather
   * than a name this machine read itself (S5c).
   *
   * A surface has to be able to say so: the masked label is not what the account
   * is called, it is as much of it as a device caller is given (ADR-072 §6), and
   * a reader who sees it without that qualification reads it as a corrupted
   * address. Only a relayed reading for a key this machine has no ledger row for
   * can carry it.
   */
  labelMasked?: boolean
  state: 'ok' | 'stale' | 'needs-sign-in' | 'unavailable'
  error?: string
}

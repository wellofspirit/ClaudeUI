import type { BillingType } from './engine'
import type { ExtraUsage, RateWindow } from './usage-limits'

// ---------------------------------------------------------------------------
// The usage dashboard (ADR-071 §8)
//
// One read of `usage_bucket` over a range, grouped provider → account → model,
// with both costs, the unknown counts and a per-local-day series. Every figure
// here is already resolved by the cost rule; nothing downstream re-derives one.
// ---------------------------------------------------------------------------

/** The ranges the dashboard offers. `today` is the viewer's local calendar day. */
export type DashboardRange = 'today' | '7d' | '30d' | '90d'

/**
 * Whose spend the dashboard is about (ADR-072 §3, slice S5c).
 *
 * `local` is this machine's ledger and is what every range meant before the
 * usage hub existed; `all` folds the cached `remote_usage_bucket` rows in
 * through the same arithmetic, so a combined figure is the same kind of number
 * as a local one rather than a second, differently-derived total. `local` is the
 * wire's default, and the answer says which scope it actually used — a hub that
 * is off has no remote rows to fold and answers `local` whatever was asked.
 */
export type DashboardScope = 'local' | 'all'

/**
 * What one grouping of buckets cost, in the three currencies ADR-071 §2 defines
 * plus the honesty counts.
 *
 * `displayCostUsd` is Σ of the per-bucket display rule, which is what the
 * headline shows; `apiCostUsd` and `billedCostUsd` are the raw halves, kept so
 * the summary can split a total into what a plan absorbed and what was charged.
 * The two counts say how many turns are MISSING from those sums — an unpriced
 * turn is never added as a zero (ADR-030).
 */
export interface CostTotals {
  apiCostUsd: number
  billedCostUsd: number
  displayCostUsd: number
  unknownApiCostCount: number
  unknownBilledCostCount: number
  requestCount: number
  /** `cacheWrite` excludes nothing and overlaps nothing: the 1h tier is a SUBSET of it and is not carried. */
  tokens: { input: number; output: number; cacheWrite: number; cacheRead: number }
}

/** One (engine, vendor, model) row under an account. */
export interface DashboardModel {
  engineId: string
  vendorId: string
  modelId: string
  totals: CostTotals
  /** The `dispatch`-origin part of {@link totals}, or null when none of it was dispatched. */
  dispatched: CostTotals | null
  /** The `judge`-origin part of {@link totals} (ADR-081 §5), or null when none of it was. */
  judge: CostTotals | null
}

/**
 * One account's spend over the range.
 *
 * `billingType` is the type that covered the LARGEST part of the account's
 * display cost. An account has one plan at a time, so it is the account's plan
 * in every real case; the exceptions are `unknown` — the bucket every
 * unattributable row shares, which can mix — and an account whose plan changed
 * inside the range.
 */
export interface DashboardAccount {
  accountKey: string
  label: string
  providerId: string
  billingType: BillingType
  totals: CostTotals
  models: DashboardModel[]
  /** The `dispatch`-origin part of {@link totals}, or null when none of it was dispatched. */
  dispatched: CostTotals | null
  /** The `judge`-origin part of {@link totals} (ADR-081 §5), or null when none of it was. */
  judge: CostTotals | null
  /**
   * The machines this account's spend came from, this one as its own device id
   * (S5c). Emitted under the `all` scope only — under `local` there is one
   * machine and naming it would be noise.
   */
  machines?: string[]
  /** True when no bucket of this account's spend was written on THIS machine (S5c). */
  remoteOnly?: boolean
  /**
   * True when {@link label} is the hub's MASKED form of the name rather than one
   * this machine read (S5c round 3) — the same flag {@link AccountLimits} carries,
   * for the same reason.
   *
   * The masked label IS the account's name when nothing else knows one: showing
   * the key's fallback (`ws-9`) instead made the same account read differently
   * under the two scopes, because under `local` it is a credential row that shows
   * the mask and under `all` it is a ledger row that showed the fallback. A
   * ledger label always wins over the mask, and then this is never set.
   */
  labelMasked?: boolean
}

/** One provider's spend over the range, and the accounts under it. */
export interface DashboardProvider {
  providerId: string
  label: string
  totals: CostTotals
  accounts: DashboardAccount[]
}

/** One LOCAL calendar day of the range. Present even when nothing was spent. */
export interface DashboardDay {
  /** `YYYY-MM-DD` in the reader's timezone. */
  date: string
  /** Only the providers that spent something that day; a missing one is zero. */
  byProvider: Record<string, { apiCostUsd: number; billedCostUsd: number; displayCostUsd: number }>
  /**
   * The OTHER machines' part of {@link byProvider}, under the `all` scope only
   * (S5c) — a subset of it, never an addition, so a column's total is still
   * `byProvider` alone and a chart hatches this much of each segment.
   */
  byProviderRemote?: DashboardDay['byProvider']
  /**
   * The same cell split by DEVICE instead of by provider, under the `all` scope
   * only (S5c). A second split rather than a nesting: the two answer different
   * questions and neither derives the other — `byProviderRemote` loses which
   * machine, this loses which provider — and a `provider × machine` cell would
   * be the product of both for a chart that draws one at a time.
   */
  byMachine?: Record<string, { apiCostUsd: number; billedCostUsd: number; displayCostUsd: number }>
  totals: CostTotals
}

/**
 * One hour of the `today` range — the same cell as a {@link DashboardDay}, keyed
 * by the UTC hour `usage_bucket` already stores rather than by a date string.
 *
 * A day is a local calendar fact and has to be derived; an hour is the ledger's
 * own grain, so the bucket's key IS the column and no timezone arithmetic sits
 * between the two.
 */
export interface DashboardHour {
  /** Epoch ms floored to the UTC hour, exactly as `usage_bucket` keys it. */
  hourUtc: number
  /** Only the providers that spent something that hour; a missing one is zero. */
  byProvider: DashboardDay['byProvider']
  /** The other machines' part of {@link byProvider} — see {@link DashboardDay.byProviderRemote}. */
  byProviderRemote?: DashboardDay['byProvider']
  /** The hour split by device — see {@link DashboardDay.byMachine}. */
  byMachine?: DashboardDay['byMachine']
  totals: CostTotals
}

/**
 * One (provider, account) slice of ONE machine's spend (S5c).
 *
 * The provider tree carries no device, and the buckets carry no engine or model
 * per machine that a `machine → provider → account` tree would need to invent, so
 * the machine group-by reads this list instead of re-folding the tree. Labels are
 * not repeated here: every key in it also appears in `providers`, which is where
 * a reader resolves both.
 */
export interface DashboardMachineAccount {
  providerId: string
  accountKey: string
  totals: CostTotals
  /** The `dispatch`-origin part of {@link totals}, or null when none of it was. */
  dispatched: CostTotals | null
  /** The `judge`-origin part of {@link totals}, or null when none of it was. */
  judge: CostTotals | null
}

/**
 * One machine that spent something in the range, or that the hub knows about
 * (ADR-072 §7, slice S5c).
 *
 * THIS MACHINE IS ALWAYS FIRST and is the only row with `self: true`; the rest
 * come from `remote_device`, which never holds this device. A machine the hub
 * lists that spent nothing in the range is still a row, with zero totals — "it
 * synced and spent nothing" and "it has not synced" are different facts and
 * dropping the row would spell them the same way.
 *
 * `lastPushAt` is null when no push instant is known: for THIS machine before
 * its first announce, and for a machine that has cached buckets but no
 * `remote_device` row — a peer the hub has dropped since the last pull, whose
 * hours are still in the combined total and so still need a row. Nothing
 * derives "behind" from a null: an unknown last push is not a late one.
 */
export interface DashboardMachine {
  deviceId: string
  deviceName: string
  /** `process.platform`'s family — `win32`, `darwin`, `linux`, or `unknown`. */
  os: string
  appVersion: string
  lastPushAt: number | null
  /** The owner marked it retired on the hub, so nothing flags it as behind. */
  retired: boolean
  /** The machine the reader is looking at. Exactly one row carries it. */
  self: boolean
  totals: CostTotals
  /** Its display cost as a FRACTION of the range's, `0` when the range cost nothing. */
  share: number
  /** Its spend split by provider and account — the machine group-by's leaves. */
  accounts: DashboardMachineAccount[]
}

/**
 * The whole dashboard, from one bounded read of `usage_bucket`.
 *
 * DISPATCHED WORK IS INSIDE EVERY TOTAL (owner ruling, ADR-071 §8) and is
 * reported again as a sub-total on the account and on each model row, so a
 * surface can mark it without having to add it.
 */
export interface UsageDashboardData {
  range: DashboardRange
  /**
   * The scope this answer was actually built at (S5c). `all` only ever comes
   * back from a machine with a hub enabled and a device id of its own; anything
   * else answers `local`, because there is nothing to combine and no way to say
   * which rows are this machine's.
   */
  scope: DashboardScope
  /**
   * Where the range begins: the local midnight `range` days before {@link toTs}
   * (today's own midnight for `today`), floored to the UTC hour `usage_bucket`
   * is keyed by. Every bucket at or after it is in the answer, and `days[0]` is
   * the local day containing it.
   */
  fromTs: number
  /** The instant the range was taken to end at (the `now` the query was built for). */
  toTs: number
  generatedAt: number
  totals: CostTotals
  /** Σ display over the `subscription` buckets — what the plans absorbed. */
  coveredUsd: number
  providers: DashboardProvider[]
  days: DashboardDay[]
  /**
   * The `today` range's hourly series — midnight through the hour in progress —
   * and undefined for every other range, which has no per-hour split to show.
   * `days` is emitted alongside it, so a widget that only knows about days
   * keeps working on `today`.
   */
  hours?: DashboardHour[]
  /** Σ display over the `unknown` account — history from before attribution. */
  unattributedUsd: number
  /**
   * The part of `totals.displayCostUsd` this machine's own ledger produced, and
   * the part relayed from the others (S5c). They always add up to the hero: under
   * `local` the first IS the hero and the second is zero.
   */
  localUsd: number
  remoteUsd: number
  /**
   * Every machine in the combined view, this one first — empty under `local`,
   * where there is one machine and the question does not arise.
   */
  machines: DashboardMachine[]
}

export interface AccountUsage {
  /**
   * Null when the API reported no five-hour window at all (S3c).
   *
   * It used to default to `{ usedPercent: 0, resetsAt: null }`, which drew a
   * 0 % meter and wrote samples under a window the account does not have — the
   * case an API-key, Bedrock or Vertex session hits, where `rate_limits` is
   * unavailable. An absent window is now absent (ADR-030).
   */
  fiveHour: RateWindow | null
  sevenDay: RateWindow | null
  sevenDaySonnet: RateWindow | null
  sevenDayOpus: RateWindow | null
  /** Server-labeled weekly per-model buckets from rate_limits.limits[]
   *  (kind "weekly_scoped"), e.g. Fable. Null when the payload has none. */
  sevenDayModels: Array<{ label: string; window: RateWindow }> | null
  extraUsage: ExtraUsage | null
  planName: string | null // e.g. "claude_max_5x"
  fetchedAt: number // Date.now()
  error: string | null
  /**
   * Whose meters these are — the active account's email, with its organization
   * beside it when one is known (S2f). Null when no account is resolved: the
   * popup omits the heading rather than showing an unnamed one.
   */
  accountLabel: string | null
}

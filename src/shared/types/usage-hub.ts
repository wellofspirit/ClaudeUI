import type { DashboardScope } from './usage-dashboard'

// ---------------------------------------------------------------------------
// The usage hub (ADR-072)
//
// What the `usage-hub:*` channels carry. The SECRET is not here and is not in
// any shape below: the device credential lives in the operational database and
// no query returns it — `hasSecret` is the whole answer a surface gets.
// ---------------------------------------------------------------------------

/**
 * What the client is doing, or why it is not.
 *
 *  - `off` — no hub configured, or sync disabled;
 *  - `idle` — configured and up to date;
 *  - `syncing` — a pass is in flight;
 *  - `backoff` — a 5xx, a network failure or a 429; a retry is scheduled;
 *  - `needs-credentials` — the hub refused the service token (a 401, or the 302
 *    to the Access login page that a bad token actually gets). Only a person can
 *    fix it, so nothing is retried;
 *  - `update-hub` — the hub speaks an older schema (`426`). The cursor is
 *    untouched, so nothing is lost;
 *  - `error` — a request the hub refused for some other reason.
 */
export type UsageHubState =
  'off' | 'idle' | 'syncing' | 'backoff' | 'needs-credentials' | 'update-hub' | 'error'

/**
 * One other machine, as `GET /v1/devices` describes it (ADR-072 §6).
 *
 * A device caller may read this: a name the user chose, an OS family, a build
 * and an instant are not sensitive, and without them the machine list can only
 * show opaque uuids and guess "behind" from the newest hour it holds — so a
 * machine that synced but spent nothing would read as stale.
 */
export interface UsageHubDevice {
  deviceId: string
  deviceName: string
  os: string
  appVersion: string
  /** When the hub last accepted a write from that machine. */
  lastPushAt: number
  /** The owner marked it retired, so the machine list stops flagging it. */
  retired: boolean
}

/** Everything `usage-hub:status` answers. Carries no credential. */
export interface UsageHubStatus {
  enabled: boolean
  url: string
  /** Null until sync has been enabled once — reading the status never creates one. */
  deviceId: string | null
  deviceName: string
  /** The Access service token's client id. Public by design, so the form can show it. */
  clientId: string
  /** Whether a device secret is stored. Never the secret. */
  hasSecret: boolean
  state: UsageHubState
  lastPushAt: number | null
  lastPullAt: number | null
  lastError: string | null
  /** Attributed ledger rows waiting past the cursor. `unknown` rows are not counted. */
  pendingEvents: number
  remote: {
    devices: UsageHubDevice[]
    /** The hub's bucket-rebuild generation, or null before the first pull. */
    epoch: number | null
  }
}

/** What `usage-hub:configure` takes. The secret has its own write-only channel. */
export interface UsageHubConfigureInput {
  /** `https:` only, except `http://localhost` / `http://127.0.0.1`. No path, no credentials. */
  url: string
  deviceName: string
  /** The Access service token's client id. Not a secret — the id is public by design. */
  clientId: string
  enabled: boolean
}

// ---------------------------------------------------------------------------
// The window-value ledger (ADR-071 §7)
//
// `usage_window`'s row shape and the two figures a reader derives from it. They
// live here rather than beside the SQL because the dashboard reads them over
// IPC (`usage:windows`) and the renderer may not import `core/`.
// ---------------------------------------------------------------------------

/** One window's value row, as ADR-071 §7 defines it. */
export interface UsageWindowRow {
  accountKey: string
  /** `5h`, `7d`, `7d:<slug>` — the same vocabulary `usage_window_sample` uses. */
  windowKind: string
  canonicalEnd: number
  /** `canonicalEnd - windowDurationMs(windowKind, windowMinutes)`, stored so a reader need not restate the rule. */
  windowStart: number
  /**
   * The length the vendor stated, when it did (S3c). It is what
   * {@link windowStart} was computed from; a row without one had its length
   * read off its kind, which is Claude's case and every row written before the
   * duration was kept.
   */
  windowMinutes: number | null
  /** The highest utilization ever OBSERVED for the window, not the highest still on disk. */
  peakPercent: number
  /**
   * `Σ usage_event.api_cost_usd` over the window's rows — API-EQUIVALENT dollars,
   * what the tokens were worth at list price, whatever they were actually
   * charged. That is the numerator ADR-071 §7's implied window value divides,
   * and it is a different question from what the turns COST, which is the
   * dashboard's own total and is not stored here.
   */
  apiCostUsd: number
  /** The known part of what those turns were actually charged (`Σ` finite `billed_cost_usd`). */
  billedCostUsd: number
  /**
   * Turns inside the window with no known API-equivalent — never added as zeros
   * (ADR-030). It qualifies {@link apiCostUsd} and nothing else: this many of
   * the window's turns are MISSING from that sum.
   */
  unknownCostCount: number
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  sampleCount: number
  /** The end passed more than the grace period ago and a recompute summed it since. Final. */
  closed: boolean
  updatedAt: number
}

/** One window row with what a reader derives from it. */
export interface UsageWindowSummaryRow extends UsageWindowRow {
  /** Dollars the ledger saw per 1% of the window, or null under the noise floor. */
  usdPerPercent: number | null
  /** What a FULL window would have been worth at that rate, or null under the noise floor. */
  impliedFullWindowUsd: number | null
  /**
   * Always true, and always shown: the numerator is this machine's ledger while
   * the denominator is the account's global utilization, so every derived figure
   * here reads LOW by however much the account was used elsewhere (ADR-071 §7).
   */
  biased: true
}

/** What `usageWindowSummary` takes, and what the `usage:windows` channel accepts. */
export interface UsageWindowQuery {
  accountKey?: string
  kind?: string
  sinceTs?: number
  /**
   * `all` prefers the hub's row for a window it holds (ADR-072 §4): its
   * numerator is summed over every machine, which is the half of ADR-071 §7's
   * bias this arc exists to close. Defaults to `local`.
   */
  scope?: DashboardScope
}

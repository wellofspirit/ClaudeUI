/**
 * Builders for the shapes S4a's `usage:dashboard` and S3a's `usage:limits`
 * return. Shared by the shell test and the three widget tests so one change to
 * `UsageDashboardData` does not have to be re-typed four times.
 */

import type {
  AccountLimits,
  AccountLimitWindow,
  CostTotals,
  DashboardAccount,
  DashboardDay,
  DashboardHour,
  DashboardMachine,
  DashboardProvider,
  UsageDashboardData
} from '../../../../../shared/types'

export function makeTotals(overrides: Partial<CostTotals> = {}): CostTotals {
  return {
    apiCostUsd: 0,
    billedCostUsd: 0,
    displayCostUsd: 0,
    unknownApiCostCount: 0,
    unknownBilledCostCount: 0,
    requestCount: 0,
    tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    ...overrides
  }
}

/** One provider split, given as plain display dollars. */
function splitOf(byProvider: Record<string, number>): DashboardDay['byProvider'] {
  return Object.fromEntries(
    Object.entries(byProvider).map(([id, usd]) => [
      id,
      { apiCostUsd: usd, billedCostUsd: 0, displayCostUsd: usd }
    ])
  )
}

/** A local day whose providers are given as plain display dollars. */
export function makeDay(date: string, byProvider: Record<string, number>): DashboardDay {
  const display = Object.values(byProvider).reduce((s, v) => s + v, 0)
  return {
    date,
    byProvider: splitOf(byProvider),
    totals: makeTotals({ displayCostUsd: display, apiCostUsd: display })
  }
}

/** One hour of the `today` series — `hourUtc` is epoch ms on a UTC hour. */
export function makeHour(hourUtc: number, byProvider: Record<string, number>): DashboardHour {
  const display = Object.values(byProvider).reduce((s, v) => s + v, 0)
  return {
    hourUtc,
    byProvider: splitOf(byProvider),
    totals: makeTotals({ displayCostUsd: display, apiCostUsd: display })
  }
}

export function makeAccount(overrides: Partial<DashboardAccount> = {}): DashboardAccount {
  return {
    accountKey: 'anthropic:org-1:acct-1',
    label: 'person@example.test',
    providerId: 'anthropic',
    billingType: 'subscription',
    totals: makeTotals({ displayCostUsd: 10, apiCostUsd: 10 }),
    models: [],
    dispatched: null,
    ...overrides
  }
}

export function makeProvider(overrides: Partial<DashboardProvider> = {}): DashboardProvider {
  const accounts = overrides.accounts ?? [makeAccount()]
  return {
    providerId: 'anthropic',
    label: 'Anthropic',
    totals: makeTotals({
      displayCostUsd: accounts.reduce((s, a) => s + a.totals.displayCostUsd, 0)
    }),
    ...overrides,
    accounts
  }
}

export function makeDashboard(overrides: Partial<UsageDashboardData> = {}): UsageDashboardData {
  const providers = overrides.providers ?? [makeProvider()]
  const totals =
    overrides.totals ??
    makeTotals({ displayCostUsd: providers.reduce((s, p) => s + p.totals.displayCostUsd, 0) })
  return {
    range: '30d',
    // `local` by default: every widget's existing behaviour is its `local`
    // behaviour, and S5c's rule is that the scope has to be asked for.
    scope: 'local',
    fromTs: 0,
    toTs: 1,
    generatedAt: 1,
    totals,
    coveredUsd: 0,
    unattributedUsd: 0,
    days: [],
    // The hero is all this machine's until a combined answer says otherwise.
    localUsd: totals.displayCostUsd,
    remoteUsd: 0,
    machines: [],
    ...overrides,
    providers
  }
}

/**
 * One machine of the combined view. `share` is a FRACTION, as the query emits
 * it, so a test states `0.4` where the panel prints `40%`.
 */
export function makeMachine(overrides: Partial<DashboardMachine> = {}): DashboardMachine {
  const totals = overrides.totals ?? makeTotals({ displayCostUsd: 10, apiCostUsd: 10 })
  return {
    deviceId: 'dev-self',
    deviceName: 'desk',
    os: 'win32',
    appVersion: '3.3.0',
    lastPushAt: Date.now(),
    retired: false,
    self: true,
    share: 1,
    accounts: [],
    ...overrides,
    totals
  }
}

export function makeWindow(overrides: Partial<AccountLimitWindow> = {}): AccountLimitWindow {
  return {
    kind: '5h',
    label: '5-hour',
    usedPercent: 20,
    resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
    ...overrides
  }
}

export function makeLimits(overrides: Partial<AccountLimits> = {}): AccountLimits {
  return {
    accountKey: 'anthropic:org-1:acct-1',
    label: 'person@example.test',
    vendorId: 'anthropic',
    plan: 'Max 20x',
    windows: [makeWindow()],
    observedAt: Date.now(),
    source: 'local',
    state: 'ok',
    ...overrides
  }
}

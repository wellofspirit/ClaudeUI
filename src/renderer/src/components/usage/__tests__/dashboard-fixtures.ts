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
  return {
    range: '30d',
    fromTs: 0,
    toTs: 1,
    generatedAt: 1,
    totals: makeTotals({
      displayCostUsd: providers.reduce((s, p) => s + p.totals.displayCostUsd, 0)
    }),
    coveredUsd: 0,
    unattributedUsd: 0,
    days: [],
    ...overrides,
    providers
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

/**
 * The `usage:*` metering channels — ONE declaration, both transports (the usage hub's
 * channels are the sibling `usage-hub-commands.ts`). All `config`; none returns a token.
 */

import { usageFetcher } from '../services/usage-fetcher'
import { chatgptRateLimits } from '../shared-providers/chatgpt-rate-limits'
import { readAccountLimits } from '../services/usage-provider'
import { sanitizeUsageWindowQuery, usageWindowSummary } from '../services/usage-window-ledger'
import {
  buildUsageDashboard,
  sanitizeDashboardRange,
  sanitizeDashboardScope
} from '../services/usage-dashboard'
import { blockUsageService } from '../services/block-usage'
import type { CommandRegistration } from './command-registry'

export function usageMeteringCommands(): Array<Omit<CommandRegistration, 'transport'>> {
  return [
    {
      channel: 'usage:fetch',
      capability: 'config',
      kind: 'query',
      handler: async () => {
        return usageFetcher.fetch()
      }
    },
    {
      channel: 'usage:fetch-block',
      capability: 'config',
      kind: 'query',
      handler: async () => {
        return blockUsageService.getData() ?? (await blockUsageService.recalculate())
      }
    },
    /**
     * ADR-068 §2 — per-account ChatGPT subscription limits. Read-only and
     * token-free (percentages and reset times), and it TRIGGERS the read: rate
     * limits are fetched when somebody looks at them, never on a timer.
     */
    {
      channel: 'usage:chatgpt-limits',
      capability: 'config',
      kind: 'query',
      handler: async (refresh?: boolean) => {
        if (refresh) await chatgptRateLimits.refresh()
        return chatgptRateLimits.snapshot()
      }
    },
    /**
     * ADR-071 §6 — every account's limits, across vendors. `refresh` decides
     * whether a stored Claude account's credentials are read at all: without it
     * the answer comes from the last persisted reading and spends no refresh
     * grant (the owner's rule). Per-account failures travel as `state`, so one
     * account needing a sign-in cannot blank the rest.
     */
    {
      channel: 'usage:limits',
      capability: 'config',
      kind: 'query',
      handler: async (refresh?: boolean) => {
        return readAccountLimits({ refresh: !!refresh })
      }
    },
    /**
     * ADR-071 §7 — the window-value ledger. Read-only: one row per limit window
     * with the peak percent, what the ledger saw inside it, and the two derived
     * figures. Closed windows are in the answer and are most of it — the samples
     * behind them are pruned at 30 days, these rows are not.
     */
    {
      channel: 'usage:windows',
      capability: 'config',
      kind: 'query',
      handler: async (opts?: unknown) => {
        return usageWindowSummary(sanitizeUsageWindowQuery(opts))
      }
    },
    /**
     * ADR-071 §8 — the dashboard's one read: the ledger's hourly buckets over a
     * range, grouped provider → account → model, with both costs, the unknown
     * counts and a per-local-day series. Dispatched work is inside every total
     * and reported again as a sub-total.
     */
    {
      channel: 'usage:dashboard',
      capability: 'config',
      kind: 'query',
      handler: async (opts?: unknown) => {
        return buildUsageDashboard({
          range: sanitizeDashboardRange(opts),
          scope: sanitizeDashboardScope(opts)
        })
      }
    },
    {
      channel: 'usage:set-account-filter',
      capability: 'config',
      kind: 'command',
      handler: async (account: string | null) => {
        blockUsageService.setAccountFilter(account)
      }
    }
  ]
}

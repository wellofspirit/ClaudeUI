import { useState } from 'react'
import { useSessionStore } from '../../stores/session-store'
import type { AccountUsage, EngineUsageSummary, ModelTokenBreakdown } from '../../../../shared/types'
import { DailyUsageChart } from './DailyUsageChart'
import {
  formatTokenCount,
  formatCost,
  sumTokens,
  shortModelName,
  getModelColor
} from './usage-utils'

interface UsageViewProps {
  onClose: () => void
}

// ---------------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------------

export function UsageView({ onClose }: UsageViewProps): React.JSX.Element {
  const blockUsage = useSessionStore((s) => s.blockUsage)
  const accountUsage = useSessionStore((s) => s.accountUsage)

  if (!blockUsage) {
    return (
      <div data-testid="UsageView" className="flex flex-col h-full bg-bg-primary p-4">
        <Header onClose={onClose} />
        <div className="flex-1 flex items-center justify-center text-text-muted text-sm">
          Loading usage data…
        </div>
      </div>
    )
  }

  const { dailyHistory, accounts, accountFilter, perEngine } = blockUsage

  const claudeEntry = perEngine?.find((e) => e.engineId === 'claude') ?? null
  const opencodeEntry = perEngine?.find((e) => e.engineId === 'opencode') ?? null

  return (
    <div data-testid="UsageView" className="flex flex-col h-full bg-bg-primary overflow-y-auto">
      <div className="sticky top-0 z-10 bg-bg-primary/95 backdrop-blur-sm border-b border-border/30">
        <Header onClose={onClose}>
          {accounts.length > 1 && (
            <AccountSelector accounts={accounts} accountFilter={accountFilter} />
          )}
        </Header>
      </div>

      <div className="p-4 space-y-4">
        {/* Claude card — subscription quota + usage summary */}
        <ClaudeCard accountUsage={accountUsage} claudeEntry={claudeEntry} />

        {/* opencode section — only when data exists */}
        {opencodeEntry && <OpencodeSection entry={opencodeEntry} />}

        {/* Daily Usage (all engines) */}
        <Section title="Daily Usage" subtitle={`Last ${dailyHistory.length} days · all engines`}>
          <DailyUsageChart dailyHistory={dailyHistory} />
        </Section>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Claude card — flat card, structurally parallel to OpencodeSection
// ---------------------------------------------------------------------------

function ClaudeCard({
  accountUsage,
  claudeEntry
}: {
  accountUsage: AccountUsage | null
  claudeEntry: EngineUsageSummary | null
}): React.JSX.Element {
  const totalTokens = claudeEntry ? sumTokens(claudeEntry.tokens) : 0

  return (
    <div data-testid="ClaudeUsageCard" className="bg-bg-secondary rounded-xl border border-border/50 p-3">
      {/* Header row */}
      <div className="flex items-center gap-2 mb-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary">
          Claude
        </h3>
        <span className="text-[9px] px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-300 font-medium">
          subscription
        </span>
        <span className="text-[9px] text-text-muted">last 7 days · API quota</span>
      </div>

      {/* Quota block — real subscription data from accountUsage (OAuth 5h window) */}
      <div className="mb-3 pb-3 border-b border-border/30">
        <WindowPanel accountUsage={accountUsage} />
      </div>

      {/* Summary + per-model table */}
      {claudeEntry ? (
        <>
          <EngineSummaryStats
            totalTokens={totalTokens}
            costUsd={claudeEntry.costUsd}
            requestCount={claudeEntry.requestCount}
          />
          <EngineModelTable models={claudeEntry.models} engineTotalTokens={totalTokens} />
        </>
      ) : (
        <div className="text-text-muted text-[11px]">No Claude usage in the last 7 days</div>
      )}
    </div>
  )
}

function WindowPanel({ accountUsage }: { accountUsage: AccountUsage | null }): React.JSX.Element {
  if (!accountUsage || accountUsage.error) {
    return <div className="text-text-muted text-[11px]">No window data</div>
  }

  const pct = accountUsage.fiveHour.usedPercent
  const color = pct > 80 ? '#ef4444' : pct > 50 ? '#eab308' : '#22c55e'

  let resetStr = ''
  if (accountUsage.fiveHour.resetsAt) {
    const ms = new Date(accountUsage.fiveHour.resetsAt).getTime() - Date.now()
    if (ms > 0) {
      const min = Math.round(ms / 60_000)
      if (min >= 60) {
        resetStr = `resets in ${Math.floor(min / 60)}h ${min % 60}m`
      } else {
        resetStr = `resets in ${min}m`
      }
    }
  }

  return (
    <>
      {resetStr && (
        <div className="flex items-baseline gap-2 mb-2">
          <span className="text-[10px] text-text-muted">{resetStr}</span>
        </div>
      )}
      <div className="flex items-center gap-3">
        <div className="flex-1 h-2 rounded-full bg-white/5 overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{ width: `${Math.min(100, pct)}%`, backgroundColor: color }}
          />
        </div>
        <span className="text-[11px] font-mono font-medium" style={{ color }}>
          {Math.round(pct)}%
        </span>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// opencode section
// ---------------------------------------------------------------------------

function OpencodeSection({ entry }: { entry: EngineUsageSummary }): React.JSX.Element {
  const [refreshing, setRefreshing] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const totalTokens = sumTokens(entry.tokens)

  async function handleRefresh(): Promise<void> {
    setRefreshing(true)
    setNote(null)
    try {
      const r = await window.api.refreshPrices()
      setNote(`Updated ${r.count} model prices`)
    } catch {
      setNote('Refresh failed')
    } finally {
      setRefreshing(false)
    }
    setTimeout(() => setNote(null), 4000)
  }

  return (
    <div className="bg-bg-secondary rounded-xl border border-border/50 p-3">
      {/* Header row */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary">
            opencode
          </h3>
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 font-medium">
            pay-per-token
          </span>
          <span className="text-[9px] text-text-muted">last 7 days · no window</span>
        </div>
        <div className="flex items-center gap-2">
          {note && <span className="text-[9px] text-text-muted">{note}</span>}
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="[-webkit-app-region:no-drag] text-[10px] text-text-secondary hover:text-text-primary border border-border/50 rounded px-2 py-0.5 flex items-center gap-1 disabled:opacity-50 transition-colors cursor-default"
          >
            {refreshing ? 'Refreshing…' : '↻ refresh prices'}
          </button>
        </div>
      </div>

      <EngineSummaryStats
        totalTokens={totalTokens}
        costUsd={entry.costUsd}
        requestCount={entry.requestCount}
      />
      <EngineModelTable models={entry.models} engineTotalTokens={totalTokens} />

      {/* Footnote */}
      <p className="text-[9px] text-text-muted mt-2">
        Cost reported by opencode (models.dev pricing). No 5-hour window — pay-per-token.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared engine summary + per-model table (used by ClaudeCard + OpencodeSection)
// ---------------------------------------------------------------------------

function EngineSummaryStats({
  totalTokens,
  costUsd,
  requestCount
}: {
  totalTokens: number
  costUsd: number
  requestCount: number
}): React.JSX.Element {
  return (
    <div className="flex gap-5 text-[11px] mb-3">
      <div>
        <div className="text-text-muted text-[10px]">Tokens</div>
        <div className="font-mono text-text-primary">{formatTokenCount(totalTokens)}</div>
      </div>
      <div>
        <div className="text-text-muted text-[10px]">Cost</div>
        <div className="font-mono text-text-primary">{formatCost(costUsd)}</div>
      </div>
      <div>
        <div className="text-text-muted text-[10px]">Requests</div>
        <div className="font-mono text-text-primary">{requestCount}</div>
      </div>
    </div>
  )
}

function EngineModelTable({
  models,
  engineTotalTokens
}: {
  models: ModelTokenBreakdown[]
  engineTotalTokens: number
}): React.JSX.Element | null {
  if (models.length === 0) return null

  return (
    <table className="w-full text-[10px]">
      <thead>
        <tr className="text-text-muted">
          <th className="text-left font-medium pb-1">Model</th>
          <th className="text-right font-medium pb-1">Tokens</th>
          <th className="text-right font-medium pb-1">Cost</th>
          <th className="text-right font-medium pb-1">Reqs</th>
          <th className="text-right font-medium pb-1">Share</th>
        </tr>
      </thead>
      <tbody>
        {models.map((m) => (
          <EngineModelRow key={m.model} model={m} engineTotalTokens={engineTotalTokens} />
        ))}
      </tbody>
    </table>
  )
}

function EngineModelRow({
  model,
  engineTotalTokens
}: {
  model: ModelTokenBreakdown
  engineTotalTokens: number
}): React.JSX.Element {
  const mTotal = sumTokens(model.tokens)
  const pct = engineTotalTokens > 0 ? Math.round((mTotal / engineTotalTokens) * 100) : 0
  return (
    <tr className="text-text-secondary">
      <td className="py-0.5 flex items-center gap-1.5">
        <span
          className="inline-block w-2 h-2 rounded-full"
          style={{ backgroundColor: getModelColor(model.model) }}
        />
        {shortModelName(model.model)}
      </td>
      <td className="text-right font-mono">{formatTokenCount(mTotal)}</td>
      <td className="text-right font-mono">{formatCost(model.costUsd)}</td>
      <td className="text-right font-mono">{model.requestCount}</td>
      <td className="text-right font-mono">{pct}%</td>
    </tr>
  )
}

// ---------------------------------------------------------------------------
// Shared sub-components (unchanged from original)
// ---------------------------------------------------------------------------

function Header({
  onClose,
  children
}: {
  onClose: () => void
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between px-4 h-12 [-webkit-app-region:drag]">
      <div className="flex items-center gap-2">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="text-accent"
        >
          <path d="M18 20V10" />
          <path d="M12 20V4" />
          <path d="M6 20v-6" />
        </svg>
        <h2 className="text-sm font-semibold text-text-primary">Usage Analytics</h2>
        {children}
      </div>
      <button
        data-testid="UsageView.close"
        onClick={onClose}
        className="[-webkit-app-region:no-drag] flex items-center justify-center w-6 h-6 rounded-md hover:bg-bg-hover transition-colors cursor-default"
        title="Close"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <path d="M18 6L6 18" />
          <path d="M6 6l12 12" />
        </svg>
      </button>
    </div>
  )
}

function AccountSelector({
  accounts,
  accountFilter
}: {
  accounts: string[]
  accountFilter: string | null
}): React.JSX.Element {
  return (
    <select
      value={accountFilter ?? 'all'}
      onChange={(e) => {
        const v = e.target.value
        window.api.setUsageAccountFilter(v === 'all' ? null : v).catch(() => {})
      }}
      className="[-webkit-app-region:no-drag] text-[10px] bg-bg-secondary border border-border/50 rounded-md px-1.5 py-0.5 text-text-secondary outline-none cursor-default"
      title="Filter usage by account"
    >
      <option value="all">All accounts</option>
      {accounts.map((email) => (
        <option key={email} value={email}>
          {email}
        </option>
      ))}
    </select>
  )
}

function Section({
  title,
  subtitle,
  children
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="bg-bg-secondary rounded-xl border border-border/50 p-3">
      <div className="flex items-baseline gap-2 mb-2">
        <h3 className="text-[11px] font-semibold text-text-secondary uppercase tracking-wider">
          {title}
        </h3>
        {subtitle && <span className="text-[9px] text-text-muted">{subtitle}</span>}
      </div>
      {children}
    </div>
  )
}

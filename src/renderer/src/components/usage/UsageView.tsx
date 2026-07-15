import { useEffect, useState } from 'react'
import { useSessionStore } from '../../stores/session-store'
import type {
  BlockUsageData,
  UsageBlock,
  UsageSnapshot,
  EngineUsageSummary,
  ModelTokenBreakdown,
  DispatchedUsageSummary
} from '../../../../shared/types'
import { TokenDonut } from './TokenDonut'
import { BlockTimeline } from './BlockTimeline'
import { DailyUsageChart } from './DailyUsageChart'
import {
  formatTokenCount,
  formatCost,
  formatTime,
  formatDuration,
  sumTokens,
  shortModelName,
  getModelColor
} from './usage-utils'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ClaudeTab = 'block' | 'timeline' | 'recent'

function calendarDaySpan(history: BlockUsageData['dailyHistory']): number {
  if (history.length === 0) return 0
  const dates = history.map((day) => day.date).sort()
  return Math.round((Date.parse(dates[dates.length - 1]) - Date.parse(dates[0])) / 86_400_000) + 1
}

interface UsageViewProps {
  onClose: () => void
}

// ---------------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------------

export function UsageView({ onClose }: UsageViewProps): React.JSX.Element {
  const blockUsage = useSessionStore((s) => s.blockUsage)
  const [activeTab, setActiveTab] = useState<ClaudeTab>('block')
  // ADR-033 M4-B: delegated (cross-engine dispatched) usage — request/response
  // only, no live-push channel (an all-time aggregate, not a hot path). Local
  // component state, same pattern as OpencodeSection's refresh-prices call.
  const [dispatchedUsage, setDispatchedUsage] = useState<DispatchedUsageSummary[] | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api
      .fetchDispatchedUsage()
      .then((rows) => {
        if (!cancelled) setDispatchedUsage(rows)
      })
      .catch(() => {
        if (!cancelled) setDispatchedUsage([])
      })
    return () => {
      cancelled = true
    }
  }, [])

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

  const {
    currentBlock,
    recentBlocks,
    todaySnapshots,
    dailyHistory,
    accounts,
    accountFilter,
    perEngine
  } = blockUsage

  const opencodeEntry = perEngine?.find((e) => e.engineId === 'opencode') ?? null
  const historyDays = calendarDaySpan(dailyHistory)

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
        {/* Claude card — tabbed */}
        <ClaudeCard
          currentBlock={currentBlock}
          recentBlocks={recentBlocks}
          todaySnapshots={todaySnapshots}
          activeTab={activeTab}
          onTabChange={setActiveTab}
        />

        {/* opencode section — only when data exists */}
        {opencodeEntry && <OpencodeSection entry={opencodeEntry} />}

        {/* Delegated (cross-engine dispatched) usage — only when data exists */}
        {dispatchedUsage && dispatchedUsage.length > 0 && (
          <DelegatedUsageSection rows={dispatchedUsage} />
        )}

        {/* Daily Usage (all engines) */}
        <Section title="Daily Usage" subtitle={`Last ${historyDays} calendar days · all engines`}>
          <DailyUsageChart dailyHistory={dailyHistory} />
        </Section>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Claude card with 4-tab group
// ---------------------------------------------------------------------------

const CLAUDE_TABS: { id: ClaudeTab; label: string }[] = [
  { id: 'block', label: 'Current Block' },
  { id: 'timeline', label: 'Block Timeline' },
  { id: 'recent', label: 'Recent Blocks' }
]

function ClaudeCard({
  currentBlock,
  recentBlocks,
  todaySnapshots,
  activeTab,
  onTabChange
}: {
  currentBlock: UsageBlock | null
  recentBlocks: UsageBlock[]
  todaySnapshots: UsageSnapshot[]
  activeTab: ClaudeTab
  onTabChange: (tab: ClaudeTab) => void
}): React.JSX.Element {
  return (
    <div className="bg-bg-secondary rounded-xl border border-border/50">
      {/* Card header */}
      <div className="flex items-center gap-2 px-3 pt-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary">
          Claude
        </h3>
        <span className="text-[9px] px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-300 font-medium">
          subscription
        </span>
        <span className="text-[9px] text-text-muted">5-hour windows · blocks · API quota</span>
      </div>

      {/* Tab bar */}
      <div className="flex gap-0 px-3 mt-2 border-b border-border/30 text-[11px]">
        {CLAUDE_TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            className={`px-2.5 py-1.5 border-b-2 transition-colors cursor-default [-webkit-app-region:no-drag] ${
              activeTab === tab.id
                ? 'border-accent text-text-primary'
                : 'border-transparent text-text-muted hover:text-text-secondary'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab panels */}
      <div className="p-3">
        {activeTab === 'block' && <CurrentBlockPanel block={currentBlock} />}
        {activeTab === 'timeline' && (
          <TimelinePanel
            currentBlock={currentBlock}
            todaySnapshots={todaySnapshots}
          />
        )}
        {activeTab === 'recent' && <RecentBlocksPanel recentBlocks={recentBlocks} />}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tab panels (content only — no card chrome / no redundant section title)
// ---------------------------------------------------------------------------

function CurrentBlockPanel({ block }: { block: UsageBlock | null }): React.JSX.Element {
  if (!block) {
    return (
      <div className="text-text-muted text-[11px]">
        No active block — start using Claude to begin tracking
      </div>
    )
  }

  const total = sumTokens(block.tokens)
  const elapsed = Date.now() - block.startTime
  const remaining = block.endTime - Date.now()

  return (
    <>
      <div className="flex items-center gap-2 mb-3">
        {block.isActive && (
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-green-500/15 text-green-400 font-medium">
            active
          </span>
        )}
        <span className="text-[10px] text-text-muted">
          {formatTime(block.startTime)} – {formatTime(block.endTime)}
          <span className="ml-2 text-text-muted/60">
            ({formatDuration(elapsed)} in
            {remaining > 0 ? `, ${formatDuration(remaining)} left` : ''})
          </span>
        </span>
      </div>

      <div className="flex gap-4">
        {/* Donut */}
        <TokenDonut models={block.models} totalTokens={total} size={100} />

        {/* Stats */}
        <div className="flex-1 space-y-1.5 text-[11px]">
          <StatRow label="Total Tokens" value={formatTokenCount(total)} />
          <StatRow label="Cost" value={formatCost(block.costUsd)} />
          {block.burnRate && (
            <StatRow
              label="Burn Rate"
              value={`${formatTokenCount(block.burnRate.tokensPerMin)}/min · ${formatCost(block.burnRate.costPerHour)}/hr`}
            />
          )}
          {block.projectedUsage && (
            <StatRow
              label="Window Capacity"
              value={`~${formatTokenCount(block.projectedUsage.tokens)} · ${formatCost(block.projectedUsage.costUsd)}`}
              tooltip="Maximum tokens this 5hr window can handle, derived from current tokens ÷ API usage %"
              className="text-accent"
            />
          )}
        </div>
      </div>

      {/* Model breakdown table */}
      {block.models.length > 0 && (
        <div className="mt-3 border-t border-border/30 pt-2">
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
              {block.models
                .sort((a, b) => sumTokens(b.tokens) - sumTokens(a.tokens))
                .map((m) => {
                  const mTotal = sumTokens(m.tokens)
                  const pct = total > 0 ? Math.round((mTotal / total) * 100) : 0
                  return (
                    <tr key={m.model} className="text-text-secondary">
                      <td className="py-0.5 flex items-center gap-1.5">
                        <span
                          className="inline-block w-2 h-2 rounded-full"
                          style={{ backgroundColor: getModelColor(m.model) }}
                        />
                        {shortModelName(m.model)}
                      </td>
                      <td className="text-right font-mono">{formatTokenCount(mTotal)}</td>
                      <td className="text-right font-mono">{formatCost(m.costUsd)}</td>
                      <td className="text-right font-mono">{m.requestCount}</td>
                      <td className="text-right font-mono">{pct}%</td>
                    </tr>
                  )
                })}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

function TimelinePanel({
  currentBlock,
  todaySnapshots
}: {
  currentBlock: UsageBlock | null
  todaySnapshots: UsageSnapshot[]
}): React.JSX.Element {
  if (!currentBlock || todaySnapshots.length < 2) {
    return (
      <div className="text-text-muted text-[11px]">Not enough data yet</div>
    )
  }

  return (
    <BlockTimeline
      snapshots={todaySnapshots}
      blockStartTime={currentBlock.startTime}
      blockEndTime={currentBlock.endTime}
    />
  )
}

function RecentBlocksPanel({ recentBlocks }: { recentBlocks: UsageBlock[] }): React.JSX.Element {
  if (recentBlocks.length === 0) {
    return (
      <div className="text-text-muted text-[11px]">No recent blocks</div>
    )
  }

  return (
    <div className="space-y-1">
      {recentBlocks.map((block) => (
        <BlockRow key={block.id} block={block} />
      ))}
    </div>
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

      {/* Summary row */}
      <div className="flex gap-5 text-[11px] mb-3">
        <div>
          <div className="text-text-muted text-[10px]">Tokens</div>
          <div className="font-mono text-text-primary">{formatTokenCount(totalTokens)}</div>
        </div>
        <div>
          <div className="text-text-muted text-[10px]">Cost</div>
          <div className="font-mono text-text-primary">{formatCost(entry.costUsd)}</div>
        </div>
        <div>
          <div className="text-text-muted text-[10px]">Requests</div>
          <div className="font-mono text-text-primary">{entry.requestCount}</div>
        </div>
      </div>

      {/* Per-model table */}
      {entry.models.length > 0 && (
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
            {entry.models.map((m) => (
              <OpencodeModelRow key={m.model} model={m} engineTotalTokens={totalTokens} />
            ))}
          </tbody>
        </table>
      )}

      {/* Footnote */}
      <p className="text-[9px] text-text-muted mt-2">
        Cost reported by opencode; when the engine reports $0 (subscription/pooled
        billing), estimated list-price cost is shown. No 5-hour window —
        pay-per-token.
      </p>
    </div>
  )
}

function OpencodeModelRow({
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
// Delegated (cross-engine dispatched) usage — ADR-033 M4-B
// ---------------------------------------------------------------------------

function DelegatedUsageSection({ rows }: { rows: DispatchedUsageSummary[] }): React.JSX.Element {
  return (
    <div data-testid="DelegatedUsage" className="bg-bg-secondary rounded-xl border border-border/50 p-3">
      <div className="flex items-center gap-2 mb-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary">
          Delegated
        </h3>
        <span className="text-[9px] text-text-muted">
          cross-engine dispatch_agent calls · all-time
        </span>
      </div>

      <table className="w-full text-[10px]">
        <thead>
          <tr className="text-text-muted">
            <th className="text-left font-medium pb-1">Target</th>
            <th className="text-right font-medium pb-1">Dispatches</th>
            <th className="text-right font-medium pb-1">Tokens</th>
            <th className="text-right font-medium pb-1">Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={`${row.targetEngine}/${row.targetModel}`}
              data-testid="DelegatedUsage.row"
              data-id={`${row.targetEngine}/${row.targetModel}`}
              className="text-text-secondary"
            >
              <td className="py-0.5 flex items-center gap-1.5">
                <span
                  className="inline-block w-2 h-2 rounded-full"
                  style={{ backgroundColor: getModelColor(row.targetModel) }}
                />
                {row.targetEngine} · {shortModelName(row.targetModel)}
              </td>
              <td className="text-right font-mono">{row.dispatches}</td>
              <td className="text-right font-mono">{formatTokenCount(row.totalTokens)}</td>
              <td className="text-right font-mono">{formatCost(row.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="text-[9px] text-text-muted mt-2">
        Tasks this conversation delegated to the OTHER engine via dispatch_agent — attributed to
        the dispatching session, cost/tokens from the target&apos;s own turn result.
      </p>
    </div>
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

function StatRow({
  label,
  value,
  className,
  tooltip
}: {
  label: string
  value: string
  className?: string
  tooltip?: string
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between" title={tooltip}>
      <span className="text-text-muted">{label}</span>
      <span className={`font-mono text-text-primary ${className ?? ''}`}>{value}</span>
    </div>
  )
}

function BlockRow({ block }: { block: UsageBlock }): React.JSX.Element {
  const total = sumTokens(block.tokens)

  // Prefer finalApiPercent (actual API %) over computing from projectedUsage.
  const apiPct = block.finalApiPercent
  const pct = apiPct != null && apiPct > 0 ? Math.min(100, Math.round(apiPct)) : null

  // Derive projected total from API %
  const projTokens = apiPct != null && apiPct > 0 ? Math.round(total / (apiPct / 100)) : null
  const projCost =
    apiPct != null && apiPct > 0 && total > 0
      ? Math.round((block.costUsd / (apiPct / 100)) * 100) / 100
      : null

  return (
    <div className="flex items-center gap-2 text-[10px] py-1.5 px-1 rounded hover:bg-bg-hover/30 transition-colors">
      {/* Time range */}
      <span className="text-text-muted w-[120px] shrink-0">
        {formatTime(block.startTime)} – {formatTime(block.actualEndTime)}
      </span>
      {/* Tokens: used / projected */}
      <span className="font-mono w-[140px] text-right shrink-0">
        <span className="text-text-primary">{formatTokenCount(total)}</span>
        {projTokens != null && (
          <span className="text-text-muted"> / {formatTokenCount(projTokens)}</span>
        )}
      </span>
      {/* Cost: used / projected */}
      <span className="font-mono w-[120px] text-right shrink-0">
        <span className="text-text-muted">{formatCost(block.costUsd)}</span>
        {projCost != null && <span className="text-text-muted/50"> / {formatCost(projCost)}</span>}
      </span>
      {/* Utilization bar + percentage */}
      {pct !== null ? (
        <div
          className="flex-1 flex items-center gap-1.5"
          title={`Used ${pct}% of 5hr window capacity`}
        >
          <div className="flex-1 h-[5px] rounded-full bg-white/5 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${
                pct >= 80 ? 'bg-red-400/70' : pct >= 50 ? 'bg-yellow-400/60' : 'bg-green-400/50'
              }`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="text-text-muted font-mono text-[9px] w-[28px] text-right">{pct}%</span>
        </div>
      ) : (
        <div className="flex-1 flex items-center gap-1">
          {block.models.map((m) => (
            <span
              key={m.model}
              className="inline-block w-2 h-2 rounded-full"
              style={{ backgroundColor: getModelColor(m.model) }}
              title={`${shortModelName(m.model)}: ${formatTokenCount(sumTokens(m.tokens))}`}
            />
          ))}
        </div>
      )}
      {block.isActive && (
        <span className="text-[8px] px-1 py-0.5 rounded bg-green-500/15 text-green-400">
          active
        </span>
      )}
    </div>
  )
}

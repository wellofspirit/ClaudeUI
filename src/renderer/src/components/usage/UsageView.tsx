import { useSessionStore } from '../../stores/session-store'
import type { UsageBlock, AccountUsage } from '../../../../shared/types'
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

interface UsageViewProps {
  onClose: () => void
}

export function UsageView({ onClose }: UsageViewProps): React.JSX.Element {
  const blockUsage = useSessionStore((s) => s.blockUsage)
  const accountUsage = useSessionStore((s) => s.accountUsage)

  if (!blockUsage) {
    return (
      <div className="flex flex-col h-full bg-bg-primary p-4">
        <Header onClose={onClose} />
        <div className="flex-1 flex items-center justify-center text-text-muted text-sm">
          Loading usage data…
        </div>
      </div>
    )
  }

  const { currentBlock, recentBlocks, todaySnapshots, dailyHistory } = blockUsage

  return (
    <div className="flex flex-col h-full bg-bg-primary overflow-y-auto">
      <div className="sticky top-0 z-10 bg-bg-primary/95 backdrop-blur-sm border-b border-border/30">
        <Header onClose={onClose} />
      </div>

      <div className="p-4 space-y-4">
        {/* Current Block Card */}
        <CurrentBlockCard block={currentBlock} />

        {/* Block Timeline */}
        {currentBlock && todaySnapshots.length >= 2 && (
          <Section title="Block Timeline" subtitle="Token accumulation + API %">
            <BlockTimeline
              snapshots={todaySnapshots}
              blockStartTime={currentBlock.startTime}
              blockEndTime={currentBlock.endTime}
            />
          </Section>
        )}

        {/* 5hr API Usage Bar */}
        {accountUsage && !accountUsage.error && (
          <ApiUsageBar usage={accountUsage} />
        )}

        {/* Recent Blocks */}
        {recentBlocks.length > 0 && (
          <Section title="Recent Blocks" subtitle="Last 48 hours">
            <div className="space-y-1">
              {recentBlocks.map((block) => (
                <BlockRow key={block.id} block={block} />
              ))}
            </div>
          </Section>
        )}

        {/* Daily Usage Chart */}
        <Section title="Daily Usage" subtitle={`Last ${dailyHistory.length} days`}>
          <DailyUsageChart dailyHistory={dailyHistory} />
        </Section>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Header({ onClose }: { onClose: () => void }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between px-4 h-12 [-webkit-app-region:drag]">
      <div className="flex items-center gap-2">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-accent">
          <path d="M18 20V10" /><path d="M12 20V4" /><path d="M6 20v-6" />
        </svg>
        <h2 className="text-sm font-semibold text-text-primary">Usage Analytics</h2>
      </div>
      <button
        onClick={onClose}
        className="[-webkit-app-region:no-drag] flex items-center justify-center w-6 h-6 rounded-md hover:bg-bg-hover transition-colors cursor-default"
        title="Close"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M18 6L6 18" /><path d="M6 6l12 12" />
        </svg>
      </button>
    </div>
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
        {subtitle && (
          <span className="text-[9px] text-text-muted">{subtitle}</span>
        )}
      </div>
      {children}
    </div>
  )
}

function CurrentBlockCard({ block }: { block: UsageBlock | null }): React.JSX.Element {
  if (!block) {
    return (
      <div className="bg-bg-secondary rounded-xl border border-border/50 p-4">
        <h3 className="text-[11px] font-semibold text-text-secondary uppercase tracking-wider mb-2">
          Current Block
        </h3>
        <div className="text-text-muted text-[11px]">No active block — start using Claude to begin tracking</div>
      </div>
    )
  }

  const total = sumTokens(block.tokens)
  const elapsed = Date.now() - block.startTime
  const remaining = block.endTime - Date.now()

  return (
    <div className="bg-bg-secondary rounded-xl border border-border/50 p-3">
      <div className="flex items-baseline gap-2 mb-3">
        <h3 className="text-[11px] font-semibold text-text-secondary uppercase tracking-wider">
          Current Block
        </h3>
        {block.isActive && (
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-green-500/15 text-green-400 font-medium">
            active
          </span>
        )}
      </div>

      <div className="flex gap-4">
        {/* Donut */}
        <TokenDonut models={block.models} totalTokens={total} size={100} />

        {/* Stats */}
        <div className="flex-1 space-y-1.5 text-[11px]">
          <StatRow label="Total Tokens" value={formatTokenCount(total)} />
          <StatRow label="Cost" value={formatCost(block.costUsd)} />
          {block.burnRate && (
            <>
              <StatRow
                label="Burn Rate"
                value={`${formatTokenCount(block.burnRate.tokensPerMin)}/min · ${formatCost(block.burnRate.costPerHour)}/hr`}
              />
            </>
          )}
          {block.projectedUsage && (
            <StatRow
              label="Window Capacity"
              value={`~${formatTokenCount(block.projectedUsage.tokens)} · ${formatCost(block.projectedUsage.costUsd)}`}
              tooltip="Maximum tokens this 5hr window can handle, derived from current tokens ÷ API usage %"
              className="text-accent"
            />
          )}
          <div className="text-[10px] text-text-muted pt-1">
            {formatTime(block.startTime)} – {formatTime(block.endTime)}
            <span className="ml-2 text-text-muted/60">
              ({formatDuration(elapsed)} in{remaining > 0 ? `, ${formatDuration(remaining)} left` : ''})
            </span>
          </div>
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

function ApiUsageBar({ usage }: { usage: AccountUsage }): React.JSX.Element {
  const pct = usage.fiveHour.usedPercent
  const color = pct > 80 ? '#ef4444' : pct > 50 ? '#eab308' : '#22c55e'

  let resetStr = ''
  if (usage.fiveHour.resetsAt) {
    const ms = new Date(usage.fiveHour.resetsAt).getTime() - Date.now()
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
    <div className="bg-bg-secondary rounded-xl border border-border/50 p-3">
      <div className="flex items-baseline gap-2 mb-2">
        <h3 className="text-[11px] font-semibold text-text-secondary uppercase tracking-wider">
          5hr API Usage
        </h3>
        {resetStr && (
          <span className="text-[9px] text-text-muted">{resetStr}</span>
        )}
      </div>
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
    </div>
  )
}

function BlockRow({ block }: { block: UsageBlock }): React.JSX.Element {
  const total = sumTokens(block.tokens)

  return (
    <div className="flex items-center gap-3 text-[10px] py-1.5 px-1 rounded hover:bg-bg-hover/30 transition-colors">
      <span className="text-text-muted w-[120px] shrink-0">
        {formatTime(block.startTime)} – {formatTime(block.actualEndTime)}
      </span>
      <span className="text-text-primary font-mono w-[60px] text-right">
        {formatTokenCount(total)}
      </span>
      <span className="text-text-muted font-mono w-[50px] text-right">
        {formatCost(block.costUsd)}
      </span>
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
      {block.isActive && (
        <span className="text-[8px] px-1 py-0.5 rounded bg-green-500/15 text-green-400">active</span>
      )}
    </div>
  )
}

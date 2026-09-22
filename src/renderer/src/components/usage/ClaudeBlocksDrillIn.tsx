/**
 * The Claude 5-hour block analytics, behind a Claude account row (ADR-071 §8).
 *
 * Moved here from `UsageView` unchanged. They describe ONE kind of account —
 * an Anthropic subscription's rolling window — rather than the dashboard, so
 * the shell no longer leads with them; `AccountsPanel` expands them under the
 * account they belong to.
 */

import { useState } from 'react'
import type { BlockUsageData, UsageBlock, UsageSnapshot } from '../../../../shared/types'
import { TokenDonut } from './TokenDonut'
import { BlockTimeline } from './BlockTimeline'
import {
  formatTokenCount,
  formatCost,
  formatTime,
  formatDuration,
  sumTokens,
  shortModelName,
  getModelColor
} from './usage-utils'

type ClaudeTab = 'block' | 'timeline' | 'recent'

const CLAUDE_TABS: { id: ClaudeTab; label: string }[] = [
  { id: 'block', label: 'Current Block' },
  { id: 'timeline', label: 'Block Timeline' },
  { id: 'recent', label: 'Recent Blocks' }
]

export function ClaudeBlocksDrillIn({
  blockUsage
}: {
  blockUsage: BlockUsageData | null
}): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<ClaudeTab>('block')

  if (!blockUsage) {
    return (
      <div data-testid="ClaudeBlocksDrillIn" className="p-3 text-[11px] text-text-muted">
        Loading block analytics…
      </div>
    )
  }

  return (
    <div data-testid="ClaudeBlocksDrillIn" className="p-3">
      <ClaudeCard
        currentBlock={blockUsage.currentBlock}
        recentBlocks={blockUsage.recentBlocks}
        todaySnapshots={blockUsage.todaySnapshots}
        activeTab={activeTab}
        onTabChange={setActiveTab}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Claude card with the 3-tab group
// ---------------------------------------------------------------------------

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
          <TimelinePanel currentBlock={currentBlock} todaySnapshots={todaySnapshots} />
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
    return <div className="text-text-muted text-[11px]">Not enough data yet</div>
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
    return <div className="text-text-muted text-[11px]">No recent blocks</div>
  }

  return (
    <div className="space-y-1">
      {recentBlocks.map((block) => (
        <BlockRow key={block.id} block={block} />
      ))}
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

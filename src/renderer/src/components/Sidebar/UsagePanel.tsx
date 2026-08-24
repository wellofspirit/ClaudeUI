import { useState, useEffect, useRef } from 'react'
import { useSessionStore } from '../../stores/session-store'
import type { AccountUsage, ExtraUsage, RateWindow } from '../../../../shared/types'
import { formatTokenCount } from '../usage/usage-utils'

export function getUsageColor(pct: number): string {
  if (pct >= 80) return '#ef4444' // red
  if (pct >= 50) return '#eab308' // yellow
  return '#22c55e' // green
}

export function formatResetTime(resetsAt: string | null): string {
  if (!resetsAt) return ''
  const reset = new Date(resetsAt)
  const now = Date.now()
  const diffMs = reset.getTime() - now
  if (diffMs <= 0) return 'resetting...'
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 60) return `resets in ${mins}m`
  const hrs = Math.floor(mins / 60)
  const remMins = mins % 60
  return remMins > 0 ? `resets in ${hrs}h ${remMins}m` : `resets in ${hrs}h`
}

export function formatPlanName(tier: string | null): string {
  if (!tier) return ''
  // e.g. "default_claude_max_5x" → "Max 5x"
  const m = tier.match(/claude[_ ]?(pro|max)(?:[_ ]?(\d+x))?/i)
  if (m) {
    const plan = m[1].charAt(0).toUpperCase() + m[1].slice(1)
    return m[2] ? `${plan} ${m[2]}` : plan
  }
  // Bare subscription_type from the structured usage shape: 'pro' | 'max' |
  // 'team' | 'enterprise'. Title-case it for display.
  if (/^(pro|max|team|enterprise)$/i.test(tier)) {
    return tier.charAt(0).toUpperCase() + tier.slice(1).toLowerCase()
  }
  return tier
}

export function UsageProgressBar({
  label,
  window: w
}: {
  label: string
  window: RateWindow
}): React.JSX.Element {
  const pct = Math.round(w.usedPercent)
  const color = getUsageColor(pct)
  const resetStr = formatResetTime(w.resetsAt)

  return (
    <div className="mb-2 last:mb-0">
      <div className="flex items-center justify-between mb-0.5">
        <span className="text-[10px] text-text-secondary font-medium">{label}</span>
        <span className="text-[10px] text-text-muted font-mono">{pct}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${Math.min(100, pct)}%`, backgroundColor: color }}
        />
      </div>
      {resetStr && <div className="text-[9px] text-text-muted mt-0.5">{resetStr}</div>}
    </div>
  )
}

export function ExtraUsageBar({ extra }: { extra: ExtraUsage }): React.JSX.Element | null {
  if (!extra.isEnabled) return null

  const pct = Math.round(extra.utilization)
  const color = getUsageColor(pct)
  const usedDollars = (extra.usedCredits / 100).toFixed(2)

  // unlimited vs capped
  const limitStr =
    extra.monthlyLimit !== null
      ? `$${usedDollars} / $${(extra.monthlyLimit / 100).toFixed(2)}`
      : `$${usedDollars} used`

  return (
    <div className="mb-2 last:mb-0">
      <div className="flex items-center justify-between mb-0.5">
        <span className="text-[10px] text-text-secondary font-medium">Extra Usage</span>
        <span className="text-[10px] text-text-muted font-mono">{limitStr}</span>
      </div>
      {extra.monthlyLimit !== null && (
        <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{ width: `${Math.min(100, pct)}%`, backgroundColor: color }}
          />
        </div>
      )}
    </div>
  )
}

export function UsagePanel({
  usage,
  onRefresh
}: {
  usage: AccountUsage | null
  onRefresh: () => void
}): React.JSX.Element {
  const plan = usage ? formatPlanName(usage.planName) : null
  const agoStr = usage
    ? (() => {
        const ago = Math.round((Date.now() - usage.fetchedAt) / 1000)
        return ago < 60 ? `${ago}s ago` : `${Math.floor(ago / 60)}m ago`
      })()
    : null
  const blockUsage = useSessionStore((s) => s.blockUsage)
  const setActiveView = useSessionStore((s) => s.setActiveView)

  const currentBlock = blockUsage?.currentBlock

  // Format block summary
  let blockSummary: string | null = null
  if (currentBlock) {
    const total =
      currentBlock.tokens.inputTokens +
      currentBlock.tokens.outputTokens +
      currentBlock.tokens.cacheCreationTokens +
      currentBlock.tokens.cacheReadTokens
    const tokStr = formatTokenCount(total)
    const costStr = currentBlock.costUsd >= 0.01 ? `$${currentBlock.costUsd.toFixed(2)}` : '$0.00'
    const burnStr = currentBlock.burnRate
      ? `${formatTokenCount(currentBlock.burnRate.tokensPerMin)} tok/min`
      : ''
    blockSummary = `${tokStr} tok\u2009·\u2009${costStr}${burnStr ? `\u2009·\u2009${burnStr}` : ''}`
  }

  return (
    <div
      data-testid="UsagePanel"
      className="absolute bottom-full left-0 mb-1 w-[220px] bg-bg-secondary border border-border rounded-lg shadow-lg p-3 z-50"
    >
      {usage?.error ? (
        <div className="text-[10px] text-red-400">{usage.error}</div>
      ) : usage ? (
        <>
          <UsageProgressBar label="5-Hour Session" window={usage.fiveHour} />
          {usage.sevenDay && (
            <UsageProgressBar label="7-Day (all models)" window={usage.sevenDay} />
          )}
          {usage.sevenDayOpus && (
            <UsageProgressBar label="7-Day Opus" window={usage.sevenDayOpus} />
          )}
          {usage.sevenDaySonnet && (
            <UsageProgressBar label="7-Day Sonnet" window={usage.sevenDaySonnet} />
          )}
          {usage.extraUsage && <ExtraUsageBar extra={usage.extraUsage} />}
        </>
      ) : (
        <div className="text-[10px] text-text-muted">No live API data</div>
      )}
      {/* Block usage summary */}
      {blockSummary && (
        <div className="mt-2 pt-1.5 border-t border-border/30">
          <div className="text-[9px] text-text-muted mb-0.5">Current block</div>
          <div className="text-[10px] text-text-secondary font-mono">{blockSummary}</div>
        </div>
      )}
      <div className="flex items-center justify-between mt-2 pt-1.5 border-t border-border/30">
        <div className="flex items-center gap-1.5">
          {plan && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-accent/15 text-accent font-medium">
              {plan}
            </span>
          )}
          {agoStr && <span className="text-[9px] text-text-muted">{agoStr}</span>}
        </div>
        <div className="flex items-center gap-1">
          <button
            data-testid="UsagePanel.details"
            onClick={(e) => {
              e.stopPropagation()
              setActiveView({ type: 'usage' })
            }}
            className="text-[9px] text-accent hover:text-accent/80 cursor-default"
            title="View usage analytics"
          >
            Details →
          </button>
          {usage && (
            <button
              data-testid="UsagePanel.refresh"
              onClick={(e) => {
                e.stopPropagation()
                onRefresh()
              }}
              className="flex items-center justify-center w-5 h-5 rounded hover:bg-bg-hover transition-colors cursor-default"
              title="Refresh usage"
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-text-muted"
              >
                <path d="M23 4v6h-6" />
                <path d="M1 20v-6h6" />
                <path d="M3.51 9a9 9 0 0114.85-3.36L23 10" />
                <path d="M20.49 15a9 9 0 01-14.85 3.36L1 14" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export function UsageRing(): React.JSX.Element {
  const usage = useSessionStore((s) => s.accountUsage)
  const [showPanel, setShowPanel] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const ringRef = useRef<HTMLDivElement>(null)

  // Close panel on outside click
  useEffect(() => {
    if (!showPanel) return
    const handler = (e: MouseEvent): void => {
      if (ringRef.current && !ringRef.current.contains(e.target as Node)) {
        setShowPanel(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showPanel])

  const handleRefresh = (): void => {
    setIsRefreshing(true)
    window.api
      .fetchAccountUsage()
      .then((data) => {
        useSessionStore.getState().setAccountUsage(data)
      })
      .catch(() => {})
      .finally(() => {
        setIsRefreshing(false)
      })
  }

  // SVG ring params
  const size = 24
  const strokeWidth = 2.5
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const pct = usage?.error ? 0 : (usage?.fiveHour.usedPercent ?? 0)
  const dashOffset = circumference - (circumference * Math.min(100, pct)) / 100
  const color = usage && !usage.error ? getUsageColor(pct) : '#6b7280' // grey when no data
  const displayText = usage && !usage.error ? `${Math.round(pct)}` : usage?.error ? '!' : '—'

  return (
    <div data-testid="UsageRing" ref={ringRef} className="relative flex items-center gap-2">
      <button
        data-testid="UsageRing.toggle"
        onClick={() => setShowPanel(!showPanel)}
        className="relative flex items-center justify-center cursor-default hover:opacity-80 transition-opacity"
        title={usage?.error || `5hr usage: ${Math.round(pct)}%`}
      >
        <svg width={size} height={size} className={isRefreshing ? 'animate-spin' : ''}>
          {/* Background track */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth={strokeWidth}
            className="text-white/10"
          />
          {/* Progress arc */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
            className="transition-all duration-500"
          />
        </svg>
        {/* Text lives in its own overlay SVG so it stays put while the ring spins */}
        <svg
          width={size}
          height={size}
          className="absolute inset-0 pointer-events-none select-none"
          aria-hidden="true"
        >
          <text
            x={size / 2}
            y={size / 2}
            textAnchor="middle"
            dominantBaseline="central"
            className="font-mono font-semibold"
            style={{ fontSize: displayText.length > 2 ? '7px' : '8px', fill: color }}
          >
            {displayText}
          </text>
        </svg>
      </button>
      <span className="text-[10px] text-text-muted select-none">
        {usage && !usage.error ? formatResetTime(usage.fiveHour.resetsAt) : 'Usage'}
      </span>
      {showPanel && <UsagePanel usage={usage} onRefresh={handleRefresh} />}
    </div>
  )
}

import { useState, useEffect, useRef } from 'react'
import { useSessionStore } from '../../stores/session-store'
import type {
  AccountUsage,
  ChatgptAccountLimits,
  ExtraUsage,
  RateWindow
} from '../../../../shared/types'
import { formatTokenCount } from '../usage/usage-utils'
import { windowKindLabel, windowKindsForReading } from '../../../../shared/window-kind'

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
    <div data-testid="UsageProgressBar" data-id={label} className="mb-2 last:mb-0">
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

/**
 * A ChatGPT window's kind as THIS panel spells it: `7-Day`, `5-Hour`,
 * `1-Hour`, `Limit` when the backend stated no duration (S3c).
 *
 * Title case, unlike every other surface: the Claude bars beside it are
 * `5-Hour Session` and `7-Day (all models)`, and a lower-case `7-day` in that
 * column reads as a different kind of thing. The accounts panel and the Plan
 * value tab keep the shared lower-case label, which matches their own Claude
 * rows (orchestrator ruling, round 2).
 */
function chatgptWindowLabel(kind: string): string {
  return windowKindLabel(kind).replace(
    /(^|[\s-])([a-z])/g,
    (_, before, first) => `${before}${first.toUpperCase()}`
  )
}

/**
 * ChatGPT subscription usage, one block per stored vault account (ADR-068 §2).
 *
 * Beside Claude's rather than instead of it: a ClaudeUI user can be paying for
 * both, and the Codex sessions in the sidebar spend the ChatGPT one. Each block
 * names the account, because the whole point of several accounts is knowing
 * which one is close to its limit.
 *
 * A window the backend did not report says so rather than drawing a 0% bar —
 * "unavailable" and "unused" are not the same claim (ADR-030).
 *
 * A CREDITS-based plan (a business workspace) reports no windows at all and a
 * balance instead, so the balance is what it gets: "this plan is not metered in
 * percentages" and "we could not read this account" are different statements,
 * and only the second deserves an apology. An account with both shows the bars
 * and the balance under them.
 */
export function ChatgptUsageBlock({
  label,
  limits
}: {
  label: string
  limits: ChatgptAccountLimits
}): React.JSX.Element {
  const kinds = windowKindsForReading(limits)
  return (
    <div data-testid="UsagePanel.chatgptAccount" data-id={label} className="mb-2 last:mb-0">
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <span className="text-[10px] text-text-secondary font-medium truncate">{label}</span>
        {limits.planType && (
          <span className="text-[9px] text-text-muted shrink-0">{limits.planType}</span>
        )}
      </div>
      {limits.primary || limits.secondary ? (
        <>
          {/* The label is the window's LENGTH, from the duration the backend
              stated (S3c) — not its slot. A plan whose only limit is weekly
              delivers it as `primary`, and calling that "5-Hour" is how a
              seven-day meter came to say it resets in 28 hours. Both slots go
              through the one helper that keeps their kinds distinct when they
              state the same length. */}
          {limits.primary && (
            <UsageProgressBar label={chatgptWindowLabel(kinds.primary)} window={limits.primary} />
          )}
          {limits.secondary && (
            <UsageProgressBar
              label={chatgptWindowLabel(kinds.secondary)}
              window={limits.secondary}
            />
          )}
        </>
      ) : (
        !limits.credits && (
          <div className="text-[9px] text-text-muted">No usage data for this account</div>
        )
      )}
      {limits.credits && (
        <div data-testid="UsagePanel.chatgptCredits" className="text-[9px] text-text-muted">
          {limits.credits.unlimited
            ? 'Unlimited credits'
            : limits.credits.balance
              ? `Credits: ${limits.credits.balance}`
              : 'Credits available'}
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
  // ADR-068 §2: read when the panel OPENS, and again on Refresh — no polling
  // timer, because a subscription's limits are only interesting while somebody
  // is looking at them, and live Codex sessions push updates for free.
  const chatgptLimits = useSessionStore((s) => s.chatgptLimits)
  const loadChatgptLimits = useSessionStore((s) => s.loadChatgptLimits)
  useEffect(() => {
    void loadChatgptLimits(true)
  }, [loadChatgptLimits])
  const chatgptAccounts = Object.entries(chatgptLimits ?? {})

  const currentBlock = blockUsage?.currentBlock

  const hasClaudeWindow = !!(
    usage?.fiveHour ||
    usage?.sevenDay ||
    usage?.sevenDayOpus ||
    usage?.sevenDaySonnet ||
    usage?.sevenDayModels?.length
  )

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
          {/* Whose meters these are. Omitted rather than blank when the fetcher
              has not resolved an account — the ChatGPT blocks below name theirs,
              and an unnamed heading would read as a third, empty account. */}
          {usage.accountLabel && (
            <div
              data-testid="UsagePanel.claudeAccount"
              data-id={usage.accountLabel}
              className="text-[10px] text-text-secondary font-medium truncate mb-1"
            >
              {usage.accountLabel}
            </div>
          )}
          {/* Absent on an account the API reports no five-hour window for
              (S3c) — an API-key or Bedrock session. It used to draw 0 %. */}
          {usage.fiveHour && <UsageProgressBar label="5-Hour Session" window={usage.fiveHour} />}
          {usage.sevenDay && (
            <UsageProgressBar label="7-Day (all models)" window={usage.sevenDay} />
          )}
          {usage.sevenDayOpus && (
            <UsageProgressBar label="7-Day Opus" window={usage.sevenDayOpus} />
          )}
          {usage.sevenDaySonnet && (
            <UsageProgressBar label="7-Day Sonnet" window={usage.sevenDaySonnet} />
          )}
          {/* Server-labeled weekly buckets (limits[] / weekly_scoped). The label
              comes from the payload — skip one the legacy window already drew. */}
          {usage.sevenDayModels?.map(({ label, window: w }) => {
            const lower = label.toLowerCase()
            if (lower === 'opus' && usage.sevenDayOpus) return null
            if (lower === 'sonnet' && usage.sevenDaySonnet) return null
            return <UsageProgressBar key={label} label={`7-Day ${label}`} window={w} />
          })}
          {usage.extraUsage && <ExtraUsageBar extra={usage.extraUsage} />}
          {/* An account with no windows at all — an API key, Bedrock, Vertex —
              says so rather than leaving the block blank (ADR-030). */}
          {!hasClaudeWindow && !usage.extraUsage && (
            <div data-testid="UsagePanel.noWindows" className="text-[10px] text-text-muted">
              No window limits for this account
            </div>
          )}
        </>
      ) : (
        <div className="text-[10px] text-text-muted">No live API data</div>
      )}
      {chatgptAccounts.length > 0 && (
        <div data-testid="UsagePanel.chatgpt" className="mt-2 pt-1.5 border-t border-border/30">
          <div className="text-[9px] text-text-muted mb-1">ChatGPT</div>
          {chatgptAccounts.map(([accountId, limits]) => (
            // The account id is the deliberate fallback — two accounts have to stay
            // distinguishable — but reach it with `||`, not `??` (ADR-070 Slice J):
            // an empty email is absent, and `??` handed this heading a blank string.
            <ChatgptUsageBlock
              key={accountId}
              label={limits.email?.trim() || accountId}
              limits={limits}
            />
          ))}
        </div>
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
                void loadChatgptLimits(true)
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
  // The ring IS the five-hour window. An account that has none (S3c) reads as
  // no data rather than as 0 % used — the same treatment as an error.
  const fiveHour = usage && !usage.error ? usage.fiveHour : null
  const pct = fiveHour?.usedPercent ?? 0
  const dashOffset = circumference - (circumference * Math.min(100, pct)) / 100
  const color = fiveHour ? getUsageColor(pct) : '#6b7280' // grey when no data
  const displayText = fiveHour ? `${Math.round(pct)}` : usage?.error ? '!' : '—'

  return (
    <div data-testid="UsageRing" ref={ringRef} className="relative flex items-center gap-2">
      <button
        data-testid="UsageRing.toggle"
        onClick={() => setShowPanel(!showPanel)}
        className="relative flex items-center justify-center cursor-default hover:opacity-80 transition-opacity"
        title={
          usage?.error ||
          (fiveHour ? `5hr usage: ${Math.round(pct)}%` : 'No 5-hour window for this account')
        }
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
        {fiveHour ? formatResetTime(fiveHour.resetsAt) : 'Usage'}
      </span>
      {showPanel && <UsagePanel usage={usage} onRefresh={handleRefresh} />}
    </div>
  )
}

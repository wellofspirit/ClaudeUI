/**
 * The OpenRouter tab (Usage Analytics › OpenRouter): what OpenRouter itself says
 * about the key in the vault, beside what ClaudeUI's ledger recorded on it.
 *
 * Nothing here takes the shell's range, scope or group-by: every figure is
 * OpenRouter's own window (UTC days, weeks, a calendar month), so the shell
 * hides those controls on this tab and the panel carries its own refresh.
 * The overview is read when the tab mounts and when the button is pressed —
 * never on a timer, because each read is four requests spent on the user's key.
 *
 * The key never reaches this file: the host reads it from the vault per
 * request, and `OpenRouterKeyInfo.label` is OpenRouter's own masked label.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { OpenRouterKeyInfo, OpenRouterOverview } from '../../../../shared/openrouter'
import { getUsageColor } from '../Sidebar/UsagePanel'
import { OpenRouterModels } from './OpenRouterModels'
import { formatDuration, formatMoney, formatResetRelative, formatUtcMonthDay } from './usage-utils'

const DAY_MS = 24 * 60 * 60 * 1000

/** Below this many elapsed days a month-to-date run rate is noise, not a projection. */
const PACE_MIN_DAYS = 3

/** How often "read Ns ago" re-renders. The overview itself is never re-read on a clock. */
const AGE_TICK_MS = 10_000

const CARD = 'bg-bg-secondary rounded-xl border border-border/50 p-3'
const LABEL = 'text-[9px] uppercase tracking-wider text-text-muted'
const CHIP = 'text-[9px] px-1.5 py-px rounded-full border border-border text-text-secondary'
const MONEY = 'font-mono tabular-nums'

// ---------------------------------------------------------------------------
// Derived figures
// ---------------------------------------------------------------------------

/** What counts against the limit, which `/key` states as what is LEFT. */
function budgetUsed(key: OpenRouterKeyInfo): number {
  if (key.limitUsd !== null && key.limitRemainingUsd !== null) {
    return Math.max(0, key.limitUsd - key.limitRemainingUsd)
  }
  switch (key.limitReset) {
    case 'daily':
      return key.usage.dailyUsd
    case 'weekly':
      return key.usage.weeklyUsd
    case 'monthly':
      return key.usage.monthlyUsd
    default:
      return key.usage.totalUsd
  }
}

/**
 * Month-to-date run rate carried to month end. Only for a monthly limit (the
 * window IS the calendar month then) and only once enough of the month is behind
 * us for the rate to mean something.
 */
export function projectMonthEnd(used: number, now: number): number | null {
  const d = new Date(now)
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
  const elapsedDays = (now - start) / DAY_MS
  if (elapsedDays < PACE_MIN_DAYS) return null
  return (used / elapsedDays) * ((end - start) / DAY_MS)
}

function resetChip(resetsAt: string, now: number): string | null {
  const at = Date.parse(resetsAt)
  if (!Number.isFinite(at)) return null
  if (at <= now) return 'resetting'
  if (at - now < DAY_MS) return `resets ${formatResetRelative(resetsAt, now)}`
  return `resets ${formatUtcMonthDay(resetsAt)} · ${Math.ceil((at - now) / DAY_MS)}d`
}

function Bar({
  testid,
  pct,
  color
}: {
  testid: string
  pct: number
  color: string
}): React.JSX.Element {
  const width = Math.round(Math.max(0, Math.min(100, pct)) * 10) / 10
  return (
    <div className="h-1.5 mt-2 rounded-full bg-bg-hover overflow-hidden">
      <div
        data-testid={testid}
        className="h-full rounded-full"
        style={{ width: `${width}%`, background: color }}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------------

export function OpenRouterPanel({ onOpenSpend }: { onOpenSpend: () => void }): React.JSX.Element {
  const [overview, setOverview] = useState<OpenRouterOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [now, setNow] = useState(Date.now)

  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const inFlight = useRef(false)
  const load = useCallback(async () => {
    // Same guard as the shell's refresh buttons: a click while a read is out is
    // dropped rather than spending a second set of requests on the key.
    if (inFlight.current) return
    inFlight.current = true
    setLoading(true)
    try {
      const next = await window.api.openrouterOverview()
      if (!mounted.current) return
      setOverview(next)
      setError(null)
    } catch (e) {
      if (!mounted.current) return
      setError(e instanceof Error ? e.message : 'Could not read OpenRouter')
    } finally {
      inFlight.current = false
      if (mounted.current) {
        setLoading(false)
        setNow(Date.now())
      }
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), AGE_TICK_MS)
    return () => clearInterval(id)
  }, [])

  return (
    <div data-testid="OpenRouterPanel" className="space-y-4 max-w-[1100px]">
      <div className="flex items-center gap-2 text-[10px] text-text-muted">
        {overview && (
          <span data-testid="OpenRouterPanel.keyLabel" className="truncate">
            Key <span className="font-mono text-text-secondary">{overview.key.label}</span> · from
            the vault
          </span>
        )}
        <div className="ml-auto flex items-center gap-2 shrink-0">
          {overview && (
            <span data-testid="OpenRouterPanel.age">
              read {formatDuration(Math.max(0, now - overview.fetchedAt))} ago
            </span>
          )}
          <button
            data-testid="OpenRouterPanel.refresh"
            onClick={() => void load()}
            disabled={loading}
            title="Read the key, credits and model counts from OpenRouter again"
            className="text-[10px] text-text-secondary hover:text-text-primary border border-border/50 rounded px-2 py-0.5 flex items-center gap-1 disabled:opacity-50 transition-colors cursor-default"
          >
            {loading ? (
              <>
                <span
                  data-testid="OpenRouterPanel.refresh.spinner"
                  className="inline-block w-2.5 h-2.5 rounded-full border border-current border-t-transparent animate-spin"
                />
                Refreshing…
              </>
            ) : (
              '↻ refresh'
            )}
          </button>
        </div>
      </div>

      {error !== null && (
        <div
          data-testid="OpenRouterPanel.error"
          className="bg-bg-secondary rounded-xl border border-danger/40 p-3 text-[11px] text-danger flex items-center gap-3"
        >
          <span className="min-w-0">Could not read OpenRouter: {error}</span>
          <button
            data-testid="OpenRouterPanel.error.retry"
            onClick={() => void load()}
            disabled={loading}
            className="ml-auto shrink-0 text-[10px] text-text-secondary hover:text-text-primary border border-border/50 rounded px-2 py-0.5 disabled:opacity-50 cursor-default"
          >
            Retry
          </button>
        </div>
      )}

      {overview === null && error === null && (
        <div
          data-testid="OpenRouterPanel.loading"
          className={`${CARD} p-6 text-center text-[11px] text-text-muted`}
        >
          Reading OpenRouter…
        </div>
      )}

      {overview !== null && (
        <>
          <div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(240px,1fr))]">
            <BudgetCard overview={overview} now={now} />
            <SpendCard info={overview.key} />
            <CreditsCard overview={overview} />
            {overview.key.freeModelRequests !== null && <FreeModelsCard info={overview.key} />}
          </div>

          {overview.ledger !== null && (
            <ReconcileStrip overview={overview} onOpenSpend={onOpenSpend} />
          )}

          <OpenRouterModels
            available={overview.models.available}
            total={overview.models.total}
            refreshToken={overview.fetchedAt}
          />
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

function BudgetCard({
  overview,
  now
}: {
  overview: OpenRouterOverview
  now: number
}): React.JSX.Element {
  const { key } = overview
  const used = budgetUsed(key)
  const hasLimit = key.limitUsd !== null && key.limitUsd > 0
  const pct = hasLimit ? (used / (key.limitUsd as number)) * 100 : 0
  const chip = key.resetsAt ? resetChip(key.resetsAt, now) : null
  const projected = hasLimit && key.limitReset === 'monthly' ? projectMonthEnd(used, now) : null

  return (
    <div data-testid="OpenRouterPanel.budget" className={CARD}>
      <div className="flex items-baseline justify-between gap-2">
        <span className={LABEL}>Key budget{key.limitReset ? ` · ${key.limitReset}` : ''}</span>
        {chip && <span className={`${CHIP} whitespace-nowrap`}>{chip}</span>}
      </div>
      {hasLimit ? (
        <>
          <div className="mt-2 flex items-baseline gap-1.5">
            <span className={`text-2xl font-semibold text-text-primary ${MONEY}`}>
              {formatMoney(used)}
            </span>
            <span className={`text-[11px] text-text-muted ${MONEY}`}>
              / {formatMoney(key.limitUsd as number)}
            </span>
          </div>
          <Bar testid="OpenRouterPanel.budget.bar" pct={pct} color={getUsageColor(pct)} />
          <div className="flex justify-between mt-1 text-[10px]">
            <span className={`text-text-secondary ${MONEY}`}>
              {formatMoney(Math.max(0, (key.limitUsd as number) - used))} left
            </span>
            <span className={`text-text-muted ${MONEY}`}>{Math.round(pct)}%</span>
          </div>
          {projected !== null && (
            <div
              data-testid="OpenRouterPanel.budget.pace"
              className="text-[10px] text-text-muted mt-1.5"
            >
              On pace for{' '}
              <span
                className={`${MONEY} ${projected > (key.limitUsd as number) ? 'text-warning' : 'text-text-secondary'}`}
              >
                ~{formatMoney(projected, 0)}
              </span>{' '}
              by month end{' '}
              <span
                title="Derived, not reported by OpenRouter: month-to-date spend ÷ days elapsed × days in the month."
                className="cursor-help"
              >
                ⓘ
              </span>
            </div>
          )}
        </>
      ) : (
        <div className="mt-2">
          <div className="text-2xl font-semibold text-text-primary">No limit</div>
          <div className="text-[10px] text-text-muted mt-1">
            This key can spend as much as the account balance allows.
          </div>
        </div>
      )}
    </div>
  )
}

function SpendCard({ info }: { info: OpenRouterKeyInfo }): React.JSX.Element {
  const cells: Array<[string, number]> = [
    ['Today (UTC)', info.usage.dailyUsd],
    ['This week (UTC)', info.usage.weeklyUsd],
    ['This month', info.usage.monthlyUsd],
    ['All time', info.usage.totalUsd]
  ]
  return (
    <div data-testid="OpenRouterPanel.spend" className={CARD}>
      <span className={LABEL}>Spend on this key</span>
      <div className="grid grid-cols-2 gap-y-2 gap-x-3 mt-2">
        {cells.map(([label, usd]) => (
          <div key={label}>
            <div className="text-[10px] text-text-muted">{label}</div>
            <div className={`text-sm text-text-primary ${MONEY}`}>{formatMoney(usd)}</div>
          </div>
        ))}
      </div>
      <div className="text-[10px] text-text-muted mt-2">
        BYOK <span className={MONEY}>{formatMoney(info.byokUsage.monthlyUsd)}</span> this month ·{' '}
        <span className={MONEY}>{formatMoney(info.byokUsage.totalUsd)}</span> all time ·{' '}
        {info.includeByokInLimit ? 'counted in the limit' : 'not counted in the limit'}
      </div>
    </div>
  )
}

function CreditsCard({ overview }: { overview: OpenRouterOverview }): React.JSX.Element {
  const { credits, key } = overview
  if (credits === null) {
    return (
      <div data-testid="OpenRouterPanel.credits" className={CARD}>
        <span className={LABEL}>Account credits</span>
        <div className="mt-2 text-[11px] text-text-muted">
          Unavailable
          {overview.partialErrors.credits ? ` — ${overview.partialErrors.credits}` : ''}
        </div>
      </div>
    )
  }
  const balance = credits.totalUsd - credits.usedUsd
  const pct = credits.totalUsd > 0 ? (credits.usedUsd / credits.totalUsd) * 100 : 0
  const keyShare = credits.usedUsd > 0 ? (key.usage.totalUsd / credits.usedUsd) * 100 : null
  return (
    <div data-testid="OpenRouterPanel.credits" className={CARD}>
      <div className="flex items-baseline justify-between">
        <span className={LABEL}>Account credits</span>
        <span className={CHIP}>all keys</span>
      </div>
      <div className="mt-2 flex items-baseline gap-1.5">
        <span className={`text-2xl font-semibold text-text-primary ${MONEY}`}>
          {formatMoney(balance)}
        </span>
        <span className="text-[11px] text-text-muted">balance</span>
      </div>
      <Bar testid="OpenRouterPanel.credits.bar" pct={pct} color={getUsageColor(pct)} />
      <div className="flex justify-between mt-1 text-[10px] text-text-muted">
        <span className={MONEY}>{formatMoney(credits.usedUsd)} used</span>
        <span className={MONEY}>of {formatMoney(credits.totalUsd)} bought</span>
      </div>
      {keyShare !== null && (
        <div className="text-[10px] text-text-muted mt-1.5">
          This key accounts for{' '}
          <span className={`${MONEY} text-text-secondary`}>{Math.round(keyShare)}%</span> of the
          account&apos;s all-time use
        </div>
      )}
    </div>
  )
}

function FreeModelsCard({ info }: { info: OpenRouterKeyInfo }): React.JSX.Element | null {
  const free = info.freeModelRequests
  if (free === null) return null
  const pct = free.limit > 0 ? (free.used / free.limit) * 100 : 0
  return (
    <div data-testid="OpenRouterPanel.freeModels" className={CARD}>
      <span className={LABEL}>Free models · today</span>
      <div className="mt-2 flex items-baseline gap-1.5">
        <span className={`text-2xl font-semibold text-text-primary ${MONEY}`}>{free.used}</span>
        <span className={`text-[11px] text-text-muted ${MONEY}`}>
          / {free.limit.toLocaleString('en-US')} requests
        </span>
      </div>
      <Bar testid="OpenRouterPanel.freeModels.bar" pct={pct} color={getUsageColor(pct)} />
      <div className="text-[10px] text-text-muted mt-2">
        {info.isFreeTier ? 'Free tier' : 'Paid account'} · data regions:{' '}
        <span className="text-text-secondary">
          {info.dataRegions.length > 0 ? info.dataRegions.join(', ') : 'any'}
        </span>{' '}
        · {info.expiresAt ? `expires ${formatUtcMonthDay(info.expiresAt)}` : 'no expiry'}
      </div>
    </div>
  )
}

/**
 * Two ledgers for one key, set side by side. They legitimately differ — other
 * apps can use the key, and ClaudeUI prices from a catalog rather than from the
 * invoice — so the gap is stated as a fact with its likely causes, not as an
 * error.
 */
function ReconcileStrip({
  overview,
  onOpenSpend
}: {
  overview: OpenRouterOverview
  onOpenSpend: () => void
}): React.JSX.Element | null {
  const { ledger, key } = overview
  if (ledger === null) return null
  const reported = key.usage.monthlyUsd
  const gap = reported - ledger.costUsd
  return (
    <div data-testid="OpenRouterPanel.reconcile" className={`${CARD} flex items-start gap-3`}>
      <div className="flex-1 min-w-0 border-l-2 border-accent pl-2">
        <div className="text-[11px] text-text-primary">
          <span className="text-text-secondary">ClaudeUI&apos;s ledger</span> recorded{' '}
          <span className={MONEY}>{formatMoney(ledger.costUsd)}</span> on this key since{' '}
          {formatUtcMonthDay(ledger.sinceUtc)}
          {ledger.machines > 1 ? ` across ${ledger.machines} machines` : ''};{' '}
          <span className="text-text-secondary">OpenRouter</span> says{' '}
          <span className={MONEY}>{formatMoney(reported)}</span> this month.
        </div>
        {Math.abs(gap) >= 0.01 && (
          <div
            data-testid="OpenRouterPanel.reconcile.gap"
            className="text-[10px] text-text-muted mt-0.5"
          >
            The <span className={MONEY}>{formatMoney(Math.abs(gap))}</span> gap is{' '}
            {gap > 0
              ? 'spend from other apps using this key, or turns ClaudeUI could not price.'
              : 'ClaudeUI pricing turns from a catalog rather than the invoice, so its figure can run higher.'}
          </div>
        )}
      </div>
      <button
        data-testid="OpenRouterPanel.reconcile.openSpend"
        onClick={onOpenSpend}
        className="text-[10px] shrink-0 text-accent hover:text-accent-hover cursor-default"
      >
        Open in Spend →
      </button>
    </div>
  )
}

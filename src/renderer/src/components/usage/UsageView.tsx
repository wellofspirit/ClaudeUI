/**
 * The usage dashboard's SHELL (ADR-071 §8, slice S4b-1).
 *
 * It owns the three things every widget needs and none of them should fetch for
 * itself: the range, the group-by, and the two reads — `usage:dashboard` for the
 * ledger and `usage:limits` for what each account has left. The widgets below
 * are pure functions of what lands here.
 *
 * ONE RULE MATTERS MORE THAN THE LAYOUT. `fetchAccountLimits(true)` is the only
 * call that spends a refresh grant (ADR-071 §6), and the owner's concern is that
 * an account has a finite supply of them. So `true` is sent from exactly one
 * place in the app — the Refresh button below, on a click — and every other read
 * here, on mount and on every event, passes `false`.
 *
 * State is component-local rather than in `session-store`. The dashboard is one
 * screen's worth of derived numbers that nothing else reads; a store field would
 * need a sealed-fields entry and a replication story for data that is re-derived
 * on every open anyway. `blockUsage` stays on the store because the Claude
 * drill-in has always read it from there and it arrives on a push channel.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSessionStore } from '../../stores/session-store'
import { onSyncEvent } from '../../../../core/shared/sync/client-registry'
import type {
  AccountLimits,
  DashboardRange,
  DispatchedUsageSummary,
  EngineUsageSummary,
  ModelTokenBreakdown,
  UsageDashboardData
} from '../../../../shared/types'
import { DailyUsageChart } from './DailyUsageChart'
import { Summary } from './Summary'
import { AccountsPanel } from './AccountsPanel'
import { ResetTimeline } from './ResetTimeline'
import {
  buildProviderColorMap,
  formatTokenCount,
  formatCost,
  sumTokens,
  shortModelName,
  getModelColor
} from './usage-utils'
import { useIsMobile } from '../../hooks/useIsMobile'
import { SelectMenu } from '../shared/SelectMenu'

// ---------------------------------------------------------------------------
// Header controls
// ---------------------------------------------------------------------------

const RANGES: DashboardRange[] = ['7d', '30d', '90d']
const DEFAULT_RANGE: DashboardRange = '30d'

/**
 * Per-viewer, not per-profile: the range is a reading preference, and a phone
 * browsing the same host over the remote transport wants its own.
 */
const RANGE_STORAGE_KEY = 'claudeui.usage.range'

function readStoredRange(): DashboardRange {
  try {
    const raw = window.localStorage.getItem(RANGE_STORAGE_KEY)
    if (raw && (RANGES as string[]).includes(raw)) return raw as DashboardRange
  } catch {
    // Private mode, a disabled store, a quota error — a preference is never
    // worth failing the screen for.
  }
  return DEFAULT_RANGE
}

function storeRange(range: DashboardRange): void {
  try {
    window.localStorage.setItem(RANGE_STORAGE_KEY, range)
  } catch {
    // As above.
  }
}

/** What the breakdown's hierarchy is rooted on (S4b-2 consumes it). */
export type DashboardGroupBy = 'provider' | 'account' | 'engine' | 'model'

const GROUP_BY: DashboardGroupBy[] = ['provider', 'account', 'engine', 'model']

/**
 * How long a nudge waits before it turns into a read. A finished turn emits
 * `usage:block-data` and the limits channel can fire several times as one turn's
 * headers land; re-running two queries for each would be noise.
 */
const NUDGE_DEBOUNCE_MS = 2_000

interface UsageViewProps {
  onClose: () => void
}

// ---------------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------------

export function UsageView({ onClose }: UsageViewProps): React.JSX.Element {
  const blockUsage = useSessionStore((s) => s.blockUsage)
  const isMobile = useIsMobile()

  const [range, setRange] = useState<DashboardRange>(readStoredRange)
  const [groupBy, setGroupBy] = useState<DashboardGroupBy>('provider')
  const [dashboard, setDashboard] = useState<UsageDashboardData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [limits, setLimits] = useState<AccountLimits[] | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  // Bumped by the debounced event handlers; the fetch effects depend on it.
  const [ledgerNudge, setLedgerNudge] = useState(0)
  const [limitsNudge, setLimitsNudge] = useState(0)

  // ADR-033 M4-B: delegated (cross-engine dispatched) usage — request/response
  // only, no live-push channel (an all-time aggregate, not a hot path).
  const [dispatchedUsage, setDispatchedUsage] = useState<DispatchedUsageSummary[] | null>(null)

  // The ledger read: on mount, on a range change, and on a debounced nudge.
  useEffect(() => {
    let cancelled = false
    window.api
      .fetchUsageDashboard(range)
      .then((data) => {
        if (cancelled) return
        setDashboard(data)
        setError(null)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'Could not read usage')
      })
    return () => {
      cancelled = true
    }
  }, [range, ledgerNudge])

  // The limits read. `false` ALWAYS: nothing that happens on its own may spend a
  // refresh grant (ADR-071 §6).
  useEffect(() => {
    let cancelled = false
    window.api
      .fetchAccountLimits(false)
      .then((rows) => {
        if (!cancelled) setLimits(rows)
      })
      .catch(() => {
        if (!cancelled) setLimits([])
      })
    return () => {
      cancelled = true
    }
  }, [limitsNudge])

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

  // The two push channels that can invalidate what is on screen. Subscribed
  // here rather than in `useClaudeEvents` because the answer is this view's
  // local state: there is no store field to fold a nudge into.
  useEffect(() => {
    let ledgerTimer: ReturnType<typeof setTimeout> | undefined
    let limitsTimer: ReturnType<typeof setTimeout> | undefined
    const scheduleLedger = (): void => {
      clearTimeout(ledgerTimer)
      ledgerTimer = setTimeout(() => setLedgerNudge((n) => n + 1), NUDGE_DEBOUNCE_MS)
    }
    const scheduleLimits = (): void => {
      clearTimeout(limitsTimer)
      limitsTimer = setTimeout(() => setLimitsNudge((n) => n + 1), NUDGE_DEBOUNCE_MS)
    }
    const offBlock = onSyncEvent('usage:block-data', scheduleLedger)
    const offLimits = onSyncEvent('usage:limits-changed', () => {
      // A moved reading can also mean a turn just finished, so both reads go.
      scheduleLedger()
      scheduleLimits()
    })
    return () => {
      clearTimeout(ledgerTimer)
      clearTimeout(limitsTimer)
      offBlock()
      offLimits()
    }
  }, [])

  const handleRange = useCallback((next: DashboardRange) => {
    setRange(next)
    storeRange(next)
  }, [])

  const refreshInFlight = useRef(false)
  const handleRefreshLimits = useCallback(async () => {
    // The one caller in the app that spends a refresh grant. Re-entrancy would
    // spend two for one intent, so a click while one is in flight is dropped.
    if (refreshInFlight.current) return
    refreshInFlight.current = true
    setRefreshing(true)
    try {
      setLimits(await window.api.fetchAccountLimits(true))
    } catch {
      // Keep the readings already on screen: a failed refresh is not evidence
      // that the stored ones are wrong.
    } finally {
      refreshInFlight.current = false
      setRefreshing(false)
    }
  }, [])

  const providerColors = useMemo(
    () => buildProviderColorMap((dashboard?.providers ?? []).map((p) => p.providerId)),
    [dashboard]
  )

  const opencodeEntry = blockUsage?.perEngine?.find((e) => e.engineId === 'opencode') ?? null
  const accounts = blockUsage?.accounts ?? []

  return (
    <div data-testid="UsageView" className="flex flex-col h-full bg-bg-primary overflow-y-auto">
      <div className="sticky top-0 z-10 bg-bg-primary/95 backdrop-blur-sm border-b border-border/30">
        <Header onClose={onClose}>
          {accounts.length > 1 && (
            <AccountSelector
              accounts={accounts}
              accountFilter={blockUsage?.accountFilter ?? null}
            />
          )}
        </Header>
        <div className="flex flex-wrap items-center gap-2 px-4 pb-2">
          <PillGroup testid="UsageView.range" label="Range">
            {RANGES.map((r) => (
              <Pill
                key={r}
                testid={`UsageView.range.${r}`}
                active={r === range}
                onClick={() => handleRange(r)}
              >
                {r}
              </Pill>
            ))}
          </PillGroup>

          <PillGroup testid="UsageView.groupBy" label="Group by" value={groupBy}>
            {GROUP_BY.map((g) => (
              <Pill
                key={g}
                testid={`UsageView.groupBy.${g}`}
                active={g === groupBy}
                onClick={() => setGroupBy(g)}
              >
                {g}
              </Pill>
            ))}
          </PillGroup>

          <button
            data-testid="UsageView.refreshLimits"
            onClick={() => void handleRefreshLimits()}
            disabled={refreshing}
            title="Ask each provider for a fresh limits reading. Uses one refresh per signed-in account."
            className="[-webkit-app-region:no-drag] ml-auto text-[10px] text-text-secondary hover:text-text-primary border border-border/50 rounded px-2 py-0.5 flex items-center gap-1 disabled:opacity-50 transition-colors cursor-default"
          >
            {refreshing ? (
              <>
                <span
                  data-testid="UsageView.refreshLimits.spinner"
                  className="inline-block w-2.5 h-2.5 rounded-full border border-current border-t-transparent animate-spin"
                />
                Refreshing…
              </>
            ) : (
              '↻ refresh limits'
            )}
          </button>
        </div>
      </div>

      <div className="p-4 space-y-4">
        {error !== null && (
          <div
            data-testid="UsageView.error"
            className="bg-bg-secondary rounded-xl border border-danger/40 p-3 text-[11px] text-danger"
          >
            Could not read usage: {error}
          </div>
        )}

        {dashboard === null && error === null && (
          <div
            data-testid="UsageView.loading"
            className="bg-bg-secondary rounded-xl border border-border/50 p-6 text-center text-[11px] text-text-muted"
          >
            Loading usage data…
          </div>
        )}

        {dashboard !== null && (
          <>
            <Summary data={dashboard} compact={isMobile} providerColors={providerColors} />

            {/* The accounts panel carries rows of meters and a spend column; the
                resets card is one axis. An even split squeezed the first into
                three wrapped lines while the second sat mostly empty. */}
            <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-4 items-start">
              <AccountsPanel
                data={dashboard}
                limits={limits}
                blockUsage={blockUsage}
                providerColors={providerColors}
              />
              <ResetTimeline limits={limits} providerColors={providerColors} />
            </div>
          </>
        )}

        {/* MOUNT POINT — S4b-3 replaces this placeholder with <WindowValue />.
            It reads `fetchUsageWindows(...)` itself; the shell owes it only the
            range and the account list, both on `dashboard`. */}
        <Section title="Window value" subtitle="what a subscription window delivers">
          <div className="text-[11px] text-text-muted">
            Coming with the window-value ledger — what each 5-hour and weekly window was worth.
          </div>
        </Section>

        {/* MOUNT POINT — S4b-2 replaces this whole Section with <SpendChart />,
            which draws the same days from `dashboard.days` stacked by groupBy. */}
        <Section title="Daily Usage" subtitle="tokens per calendar day · all engines">
          <DailyUsageChart dailyHistory={blockUsage?.dailyHistory ?? []} />
        </Section>

        {/* MOUNT POINT — S4b-2 replaces both sections below with
            <BreakdownTable data={dashboard} groupBy={groupBy} />. */}
        <div data-group-by={groupBy} className="space-y-4">
          {opencodeEntry && <OpencodeSection entry={opencodeEntry} />}
          {dispatchedUsage && dispatchedUsage.length > 0 && (
            <DelegatedUsageSection rows={dispatchedUsage} />
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Header controls
// ---------------------------------------------------------------------------

function PillGroup({
  testid,
  label,
  value,
  children
}: {
  testid: string
  label: string
  value?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[9px] uppercase tracking-wider text-text-muted">{label}</span>
      <div
        data-testid={testid}
        data-value={value}
        className="flex items-center gap-0.5 bg-bg-secondary border border-border/50 rounded-md p-0.5"
      >
        {children}
      </div>
    </div>
  )
}

function Pill({
  testid,
  active,
  onClick,
  children
}: {
  testid: string
  active: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      data-testid={testid}
      data-active={active}
      aria-pressed={active}
      onClick={onClick}
      className={`[-webkit-app-region:no-drag] text-[10px] px-2 py-0.5 rounded transition-colors cursor-default ${
        active ? 'bg-bg-hover text-text-primary' : 'text-text-muted hover:text-text-secondary'
      }`}
    >
      {children}
    </button>
  )
}

// ---------------------------------------------------------------------------
// opencode section — replaced by S4b-2's BreakdownTable
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
        Cost reported by opencode; when the engine reports $0 (subscription/pooled billing),
        estimated list-price cost is shown. No 5-hour window — pay-per-token.
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
// Delegated (cross-engine dispatched) usage — ADR-033 M4-B, replaced by S4b-2
// ---------------------------------------------------------------------------

function DelegatedUsageSection({ rows }: { rows: DispatchedUsageSummary[] }): React.JSX.Element {
  return (
    <div
      data-testid="DelegatedUsage"
      className="bg-bg-secondary rounded-xl border border-border/50 p-3"
    >
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
        Tasks this conversation delegated to the OTHER engine via dispatch_agent — attributed to the
        dispatching session, cost/tokens from the target&apos;s own turn result.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared sub-components
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
    <SelectMenu
      testid="UsageView.accountFilter"
      value={accountFilter ?? 'all'}
      onChange={(v) => {
        window.api.setUsageAccountFilter(v === 'all' ? null : v).catch(() => {})
      }}
      options={[
        { value: 'all', label: 'All accounts' },
        ...accounts.map((email) => ({ value: email, label: email }))
      ]}
      triggerClassName="[-webkit-app-region:no-drag] text-[10px] bg-bg-secondary border border-border/50 rounded-md px-1.5 py-0.5 text-text-secondary outline-none"
      title="Filter usage by account"
    />
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

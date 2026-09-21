/**
 * The usage dashboard's SHELL (ADR-071 §8, slices S4b-1 to S4b-3).
 *
 * It owns the three things every widget needs and none of them should fetch for
 * itself: the range, the group-by, and the two reads — `usage:dashboard` for the
 * ledger and `usage:limits` for what each account has left. The widgets below
 * are pure functions of what lands here, split across two tabs (S4c): `Spend`
 * carries `Summary`, `AccountsPanel`, `SpendChart` and `BreakdownTable`, and
 * `Plan value` carries `WindowValue` alone — asking whether a subscription pays
 * for itself is an analysis you sit down to, not a glance at what a week cost.
 * Every one of them lives under the `dashboard !== null` guard, because every
 * one takes the dashboard data as a required prop.
 *
 * The tab decides what is MOUNTED, never what is read: both reads and all their
 * state stay here, so switching costs nothing and comes back to the same
 * numbers. The one thing a switch does move is `WindowValue`'s own read, which
 * runs when it mounts.
 *
 * `WindowValue` is the one exception to "the shell does the reading": windows
 * are a second, differently-shaped query that only it consumes, so it makes its
 * own call and takes the range from here (see its header).
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
import type { AccountLimits, DashboardRange, UsageDashboardData } from '../../../../shared/types'
import { Summary } from './Summary'
import { AccountsPanel } from './AccountsPanel'
import { WindowValue } from './WindowValue'
import { SpendChart } from './SpendChart'
import { BreakdownTable } from './BreakdownTable'
import { buildProviderColorMap } from './usage-utils'
import { useIsMobile } from '../../hooks/useIsMobile'
import { SelectMenu } from '../shared/SelectMenu'

// ---------------------------------------------------------------------------
// Header controls
// ---------------------------------------------------------------------------

const RANGES: DashboardRange[] = ['today', '7d', '30d', '90d']

/**
 * A pill reads as its own token — `7d`, `30d` — except `today`, which is a word
 * rather than a duration and would read as a window kind in lower case beside
 * them. Only the exceptions are listed.
 */
const RANGE_LABELS: Partial<Record<DashboardRange, string>> = { today: 'Today' }

/**
 * What a viewer who has never chosen sees. Owner ruling (S4d): the screen opens
 * on the current day. This is the RENDERER's default only — the wire keeps its
 * own in `sanitizeDashboardRange`, for a remote client that names no range.
 */
const DEFAULT_RANGE: DashboardRange = 'today'

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

/** Which half of the dashboard is on screen (S4c). */
type DashboardTab = 'spend' | 'plans'

const TABS: ReadonlyArray<{ id: DashboardTab; label: string }> = [
  { id: 'spend', label: 'Spend' },
  { id: 'plans', label: 'Plan value' }
]

const DEFAULT_TAB: DashboardTab = 'spend'

/** Per-viewer for the same reason the range is. */
const TAB_STORAGE_KEY = 'claudeui.usage.tab'

function readStoredTab(): DashboardTab {
  try {
    const raw = window.localStorage.getItem(TAB_STORAGE_KEY)
    if (TABS.some((t) => t.id === raw)) return raw as DashboardTab
  } catch {
    // As above.
  }
  return DEFAULT_TAB
}

function storeTab(tab: DashboardTab): void {
  try {
    window.localStorage.setItem(TAB_STORAGE_KEY, tab)
  } catch {
    // As above.
  }
}

/** What the breakdown's hierarchy is rooted on; the chart only explains itself by it. */
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

  const [tab, setTab] = useState<DashboardTab>(readStoredTab)
  const [range, setRange] = useState<DashboardRange>(readStoredRange)
  const [groupBy, setGroupBy] = useState<DashboardGroupBy>('provider')
  const [dashboard, setDashboard] = useState<UsageDashboardData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [limits, setLimits] = useState<AccountLimits[] | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  // Bumped by the debounced event handlers; the fetch effects depend on it.
  const [ledgerNudge, setLedgerNudge] = useState(0)
  const [limitsNudge, setLimitsNudge] = useState(0)

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

  const handleTab = useCallback((next: DashboardTab) => {
    setTab(next)
    storeTab(next)
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
          <TabStrip tab={tab} onSelect={handleTab} />

          <PillGroup testid="UsageView.range" label="Range">
            {RANGES.map((r) => (
              <Pill
                key={r}
                testid={`UsageView.range.${r}`}
                active={r === range}
                onClick={() => handleRange(r)}
              >
                {RANGE_LABELS[r] ?? r}
              </Pill>
            ))}
          </PillGroup>

          {/* Nothing on the plans tab is grouped, so the control that would say
              so is not offered there. */}
          {tab === 'spend' && (
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
          )}

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

      <div data-testid="UsageView.panel" data-tab={tab} className="p-4 space-y-4">
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

        {dashboard !== null && tab === 'spend' && (
          <>
            <Summary data={dashboard} compact={isMobile} providerColors={providerColors} />

            <AccountsPanel
              data={dashboard}
              limits={limits}
              blockUsage={blockUsage}
              providerColors={providerColors}
            />

            <SpendChart data={dashboard} providerColors={providerColors} groupBy={groupBy} />

            <BreakdownTable data={dashboard} groupBy={groupBy} providerColors={providerColors} />
          </>
        )}

        {dashboard !== null && tab === 'plans' && (
          <WindowValue
            data={dashboard}
            limits={limits}
            providerColors={providerColors}
            range={range}
          />
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Header controls
// ---------------------------------------------------------------------------

/**
 * Deliberately NOT a third `PillGroup`. The row already carries two labelled
 * pill rows that narrow what is shown; a third identical one would read as a
 * third filter, and this is not a filter — it chooses which question the screen
 * answers. Underlined text, sitting left of a divider, says that instead.
 *
 * Plain buttons, so the keyboard works without a roving-tabindex tab list this
 * screen has no other use for.
 */
function TabStrip({
  tab,
  onSelect
}: {
  tab: DashboardTab
  onSelect: (next: DashboardTab) => void
}): React.JSX.Element {
  return (
    <div
      data-testid="UsageView.tab"
      data-value={tab}
      className="flex items-center gap-3 pr-3 mr-1 border-r border-border/50"
    >
      {TABS.map(({ id, label }) => {
        const active = id === tab
        return (
          <button
            key={id}
            data-testid={`UsageView.tab.${id}`}
            data-active={active}
            aria-pressed={active}
            onClick={() => onSelect(id)}
            className={`[-webkit-app-region:no-drag] text-[11px] font-medium pb-0.5 border-b-2 transition-colors cursor-default ${
              active
                ? 'border-accent text-text-primary'
                : 'border-transparent text-text-muted hover:text-text-secondary'
            }`}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}

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

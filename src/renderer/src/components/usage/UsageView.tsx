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
 * here, on mount and on every event, passes `false`. The refresh-prices button
 * beside it spends nothing — models.dev is a public catalog — so it has only
 * the re-entrancy guard, not the "one place in the app" rule.
 *
 * State is component-local rather than in `session-store`. The dashboard is one
 * screen's worth of derived numbers that nothing else reads; a store field would
 * need a sealed-fields entry and a replication story for data that is re-derived
 * on every open anyway. `blockUsage` stays on the store because the Claude
 * drill-in has always read it from there and it arrives on a push channel.
 *
 * THE SCOPE (ADR-072 §7, slice S5c) is a third thing the shell owns, and it is
 * the only control here that can be UNAVAILABLE: without a usage hub there is
 * one machine, so the pills are not drawn and the query is asked for `local`.
 * The hub's own state arrives on a third push channel, `usage-hub:changed`, and
 * feeds both the chip beside the title and the machines card at the bottom of
 * the Spend tab. A stored `all` on a machine whose hub has since been forgotten
 * falls back to `local` rather than asking for a scope the query would refuse.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSessionStore } from '../../stores/session-store'
import { onSyncEvent } from '../../../../core/shared/sync/client-registry'
import type {
  AccountLimits,
  DashboardRange,
  DashboardScope,
  UsageDashboardData,
  UsageHubStatus
} from '../../../../shared/types'
import { Summary } from './Summary'
import { AccountsPanel } from './AccountsPanel'
import { WindowValue } from './WindowValue'
import { SpendChart } from './SpendChart'
import { BreakdownTable } from './BreakdownTable'
import { MachinesPanel, MACHINES_PANEL_ANCHOR } from './MachinesPanel'
import {
  buildProviderColorMap,
  combinedMachineCount,
  formatDuration,
  HUB_STATE_SEVERITY,
  SEVERITY_ICON,
  SEVERITY_TEXT_CLASS
} from './usage-utils'
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

/**
 * Whose spend is being looked at (S5c). Persisted per viewer like the range: a
 * phone on the remote transport is a different reader of the same host.
 */
const SCOPES: ReadonlyArray<{ id: DashboardScope; label: string; title: string }> = [
  {
    id: 'local',
    label: 'This machine',
    title: 'Only what this machine recorded — the view every range had before the usage hub.'
  },
  {
    id: 'all',
    label: 'All machines',
    title:
      'This machine plus every other one the hub knows about, from the last pull — so it works offline.'
  }
]

const DEFAULT_SCOPE: DashboardScope = 'local'

const SCOPE_STORAGE_KEY = 'claudeui.usage.scope'

function readStoredScope(): DashboardScope {
  try {
    const raw = window.localStorage.getItem(SCOPE_STORAGE_KEY)
    if (SCOPES.some((s) => s.id === raw)) return raw as DashboardScope
  } catch {
    // As with the range: a preference is never worth failing the screen for.
  }
  return DEFAULT_SCOPE
}

function storeScope(scope: DashboardScope): void {
  try {
    window.localStorage.setItem(SCOPE_STORAGE_KEY, scope)
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
export type DashboardGroupBy = 'provider' | 'account' | 'engine' | 'model' | 'machine'

const GROUP_BY: DashboardGroupBy[] = ['provider', 'account', 'engine', 'model']

/**
 * The groupings the combined scope adds. `machine` is the only dimension the
 * `local` data has no second value for, so offering it there would be a pill
 * that always draws one root.
 */
const COMBINED_GROUP_BY: DashboardGroupBy[] = ['machine']

/**
 * How long a nudge waits before it turns into a read. A finished turn emits
 * `usage:block-data` and the limits channel can fire several times as one turn's
 * headers land; re-running two queries for each would be noise.
 */
const NUDGE_DEBOUNCE_MS = 2_000

/** How long a machine may go without pushing before the chip and the card say so. */
const BEHIND_MS = 24 * 60 * 60 * 1000

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
  const [scope, setScope] = useState<DashboardScope>(readStoredScope)
  const [groupBy, setGroupBy] = useState<DashboardGroupBy>('provider')
  const [hub, setHub] = useState<UsageHubStatus | null>(null)
  const [dashboard, setDashboard] = useState<UsageDashboardData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [limits, setLimits] = useState<AccountLimits[] | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [pricesRefreshing, setPricesRefreshing] = useState(false)
  const [prices, setPrices] = useState<{ count: number; refreshedAt: number } | null>(null)
  // Bumped by the debounced event handlers; the fetch effects depend on it.
  const [ledgerNudge, setLedgerNudge] = useState(0)
  const [limitsNudge, setLimitsNudge] = useState(0)
  const [hubNudge, setHubNudge] = useState(0)

  /**
   * What the CONTROLS say, which is not always what was asked for.
   *
   * A stored `all` outlives the hub that justified it — a machine can be
   * forgotten in Settings while this screen is open — so the pills fall back to
   * `local` the moment the status says there is no hub. The REQUEST does not
   * wait for that: it sends the stored preference and lets the query downgrade,
   * which it already does and already reports (`data.scope`). Gating the first
   * read on the hub status instead would have cost every viewer a second fetch
   * on mount, or a round trip before the first paint.
   */
  const hubEnabled = hub?.enabled === true
  const effectiveScope: DashboardScope = hubEnabled ? scope : 'local'

  // The ledger read: on mount, on a range or scope change, and on a debounced
  // nudge — including a hub one, since a pull is new remote rows to fold.
  useEffect(() => {
    let cancelled = false
    window.api
      .fetchUsageDashboard(range, scope)
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
  }, [range, scope, ledgerNudge])

  /**
   * `machine` is not a grouping the `local` data has, so it cannot outlive the
   * scope that offered it.
   *
   * HERE rather than only in the pill's click handler, because most of the ways
   * the scope can fall back to `local` are not clicks: the hub is disabled or
   * forgotten in Settings, `usage-hub:changed` lands, the pill unmounts — and a
   * breakdown still rooted on `machine` then drew "Nothing in this range to
   * break down" under a hero of real money (round 2, R1).
   */
  useEffect(() => {
    if (effectiveScope !== 'local') return
    setGroupBy((current) => (current === 'machine' ? 'provider' : current))
  }, [effectiveScope])

  // The hub's state: on mount and on every `usage-hub:changed`. It decides
  // whether the scope pills exist at all, so it is read even with no hub.
  useEffect(() => {
    let cancelled = false
    window.api
      .usageHubStatus()
      .then((status) => {
        if (!cancelled) setHub(status)
      })
      .catch(() => {
        // A machine whose hub channel is unavailable has no combined view to
        // offer; the local dashboard is unaffected.
        if (!cancelled) setHub(null)
      })
    return () => {
      cancelled = true
    }
  }, [hubNudge])

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
    let hubTimer: ReturnType<typeof setTimeout> | undefined
    const scheduleLedger = (): void => {
      clearTimeout(ledgerTimer)
      ledgerTimer = setTimeout(() => setLedgerNudge((n) => n + 1), NUDGE_DEBOUNCE_MS)
    }
    const scheduleLimits = (): void => {
      clearTimeout(limitsTimer)
      limitsTimer = setTimeout(() => setLimitsNudge((n) => n + 1), NUDGE_DEBOUNCE_MS)
    }
    const scheduleHub = (): void => {
      clearTimeout(hubTimer)
      hubTimer = setTimeout(() => setHubNudge((n) => n + 1), NUDGE_DEBOUNCE_MS)
    }
    const offBlock = onSyncEvent('usage:block-data', scheduleLedger)
    const offLimits = onSyncEvent('usage:limits-changed', () => {
      // A moved reading can also mean a turn just finished, so both reads go.
      scheduleLedger()
      scheduleLimits()
    })
    // The hub changes state several times a pass (`syncing` → `idle`), and a
    // finished pull is new rows in all THREE of the things this screen reads:
    // the machine list, the ledger's remote buckets, and `remote_limits` — which
    // is where a relayed reading comes from (ADR-072 §4). Leaving the limits out
    // meant a peer's meters only appeared on the next open of this screen. The
    // read is local and spends no refresh grant, so it rides the same debounce.
    const offHub = onSyncEvent('usage-hub:changed', () => {
      scheduleHub()
      scheduleLedger()
      scheduleLimits()
    })
    return () => {
      clearTimeout(ledgerTimer)
      clearTimeout(limitsTimer)
      clearTimeout(hubTimer)
      offBlock()
      offLimits()
      offHub()
    }
  }, [])

  const handleRange = useCallback((next: DashboardRange) => {
    setRange(next)
    storeRange(next)
  }, [])

  const handleScope = useCallback((next: DashboardScope) => {
    setScope(next)
    storeScope(next)
    // The `machine` group-by is dropped by the effect above, which covers this
    // click and the three ways the scope falls back without one.
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

  const pricesInFlight = useRef(false)
  const handleRefreshPrices = useCallback(async () => {
    // Same guard as the limits button: one press, one fetch. models.dev costs
    // no grant, but two concurrent runs would race on the persisted catalog.
    if (pricesInFlight.current) return
    pricesInFlight.current = true
    setPricesRefreshing(true)
    try {
      const result = await window.api.refreshPrices()
      setPrices(result)
      // No display cost on screen CHANGES — the ledger stores what each turn
      // resolved to when it ran. What can change is a turn that had no price at
      // all: a model the catalog has just learned about now prices, so the read
      // goes again.
      setLedgerNudge((n) => n + 1)
    } catch {
      // A stale catalog is the status quo, not a failure worth a banner: the
      // button's tooltip still names the last run that worked.
    } finally {
      pricesInFlight.current = false
      setPricesRefreshing(false)
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
          {hub !== null && hub.enabled && <HubChip status={hub} />}
        </Header>
        <div className="flex flex-wrap items-center gap-2 px-4 pb-2">
          <TabStrip tab={tab} onSelect={handleTab} />

          {/* Only drawn when there is more than one machine to choose between:
              without a hub the answer is always `local`, and a control with one
              real option reads as a broken filter. */}
          {hubEnabled && (
            <PillGroup testid="UsageView.scope" label="Scope" value={effectiveScope}>
              {SCOPES.map((s) => (
                <Pill
                  key={s.id}
                  testid={`UsageView.scope.${s.id}`}
                  value={s.id}
                  active={s.id === effectiveScope}
                  title={s.title}
                  onClick={() => handleScope(s.id)}
                >
                  {s.label}
                </Pill>
              ))}
            </PillGroup>
          )}

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
              {[...GROUP_BY, ...(effectiveScope === 'all' ? COMBINED_GROUP_BY : [])].map((g) => (
                <Pill
                  key={g}
                  testid={`UsageView.groupBy.${g}`}
                  value={g}
                  active={g === groupBy}
                  onClick={() => setGroupBy(g)}
                >
                  {g}
                </Pill>
              ))}
            </PillGroup>
          )}

          <div className="ml-auto flex items-center gap-2">
            {/* Prices are the ledger's other input, and the only one a user can
                do anything about: an unpriced model stays unpriced until the
                catalog is refetched. It left with the opencode card in S4b-2
                and comes back here, beside the other manual read. */}
            <button
              data-testid="UsageView.refreshPrices"
              onClick={() => void handleRefreshPrices()}
              disabled={pricesRefreshing}
              title={
                prices
                  ? `Fetch the latest model prices from models.dev (${prices.count} models · refreshed ${formatDuration(Date.now() - prices.refreshedAt)} ago)`
                  : 'Fetch the latest model prices from models.dev'
              }
              className="[-webkit-app-region:no-drag] text-[10px] text-text-secondary hover:text-text-primary border border-border/50 rounded px-2 py-0.5 flex items-center gap-1 disabled:opacity-50 transition-colors cursor-default"
            >
              {pricesRefreshing ? (
                <>
                  <span
                    data-testid="UsageView.refreshPrices.spinner"
                    className="inline-block w-2.5 h-2.5 rounded-full border border-current border-t-transparent animate-spin"
                  />
                  Refreshing…
                </>
              ) : (
                '↻ refresh prices'
              )}
            </button>

            <button
              data-testid="UsageView.refreshLimits"
              onClick={() => void handleRefreshLimits()}
              disabled={refreshing}
              title="Ask each provider for a fresh limits reading. Uses one refresh per signed-in account."
              className="[-webkit-app-region:no-drag] text-[10px] text-text-secondary hover:text-text-primary border border-border/50 rounded px-2 py-0.5 flex items-center gap-1 disabled:opacity-50 transition-colors cursor-default"
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

            {/* LAST on the tab, and mounted only under `all` (owner's ruling on
                the mockup: a card at the bottom, not a popover behind the chip). */}
            {dashboard.scope === 'all' && (
              <MachinesPanel data={dashboard} status={hub} onSynced={setHub} />
            )}
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
    // `min-w-0` and a group that may wrap inside itself: the control row wraps
    // between its groups (S4c), but a flex ITEM is never narrower than its own
    // content, so one group whose pills did not fit still pushed the row wider
    // than the viewport and gave it a horizontal scrollbar. Four pills in a
    // labelled box is the widest thing here, and `Scope` added a fifth group.
    <div className="flex items-center gap-1.5 min-w-0">
      <span className="text-[9px] uppercase tracking-wider text-text-muted shrink-0">{label}</span>
      <div
        data-testid={testid}
        data-value={value}
        className="flex flex-wrap items-center gap-0.5 min-w-0 bg-bg-secondary border border-border/50 rounded-md p-0.5"
      >
        {children}
      </div>
    </div>
  )
}

function Pill({
  testid,
  value,
  title,
  active,
  onClick,
  children
}: {
  testid: string
  /** The machine-readable choice, when the label is prose (`This machine`). */
  value?: string
  title?: string
  active: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      data-testid={testid}
      data-value={value}
      data-active={active}
      aria-pressed={active}
      title={title}
      onClick={onClick}
      className={`[-webkit-app-region:no-drag] text-[10px] px-2 py-0.5 rounded transition-colors cursor-default ${
        active ? 'bg-bg-hover text-text-primary' : 'text-text-muted hover:text-text-secondary'
      }`}
    >
      {children}
    </button>
  )
}

/**
 * The sync chip (ADR-072 §7, mockup `47cfbd90`'s Machines C).
 *
 * Machines C with Machines A behind it was the layout pick, and the owner then
 * ruled the list a CARD at the bottom of the Spend tab rather than a popover: a
 * table of four machines in a popover over the summary hid the figures it is
 * meant to qualify. So the chip is a link to that card — one click, one scroll —
 * and carries only what has to be legible without opening anything: the client's
 * state, how many machines, how many are behind, and how fresh the view is.
 *
 * `behind` counts PEERS only. This machine's own push lag is a fact about its
 * hub connection, which the state dot already reports; counting it here would
 * tell a reader that their own screen is missing its own spend, which it is not.
 */
function HubChip({ status }: { status: UsageHubStatus }): React.JSX.Element {
  const severity = HUB_STATE_SEVERITY[status.state]
  const now = Date.now()
  // `remote.devices` is the peers — the pull filters this device out of it.
  const machines = combinedMachineCount(status.remote.devices)
  const behind = status.remote.devices.filter(
    (d) => !d.retired && now - d.lastPushAt > BEHIND_MS
  ).length
  const synced =
    status.lastPullAt === null
      ? 'never synced'
      : `synced ${formatDuration(Math.max(0, now - status.lastPullAt))} ago`

  return (
    <button
      data-testid="UsageView.hubChip"
      data-state={status.state}
      data-severity={severity}
      data-behind={behind > 0 ? String(behind) : undefined}
      onClick={() => {
        document
          .getElementById(MACHINES_PANEL_ANCHOR)
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }}
      title={
        status.lastError ??
        `Usage hub: ${status.state} · ${machines} machines · ${synced}. Shows the machine list.`
      }
      className="[-webkit-app-region:no-drag] flex items-center gap-1.5 min-w-0 shrink text-[10px] bg-bg-secondary border border-border/50 rounded-full px-2 py-0.5 text-text-secondary hover:text-text-primary transition-colors cursor-default"
    >
      <span aria-hidden="true" className={`shrink-0 ${SEVERITY_TEXT_CLASS[severity]}`}>
        {SEVERITY_ICON[severity]}
      </span>
      <span className="truncate">
        Hub · {machines} {machines === 1 ? 'machine' : 'machines'}
      </span>
      {behind > 0 && (
        <span
          data-testid="UsageView.hubChip.behind"
          className="shrink-0 whitespace-nowrap text-warning"
        >
          · {behind} behind
        </span>
      )}
      {/* The freshness is the first thing to give way at phone width: the header
          it sits in neither wraps nor scrolls, and the count and the behind
          warning are what a glance is for. The tooltip still carries it. */}
      <span className="hidden sm:inline whitespace-nowrap text-text-muted">{synced}</span>
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
      <div className="flex min-w-0 items-center gap-2">
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
        <h2 className="hidden min-w-0 shrink truncate text-sm font-semibold text-text-primary sm:block">
          Usage Analytics
        </h2>
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

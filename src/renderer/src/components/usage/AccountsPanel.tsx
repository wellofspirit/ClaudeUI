/**
 * Accounts and their limit windows, grouped by provider (ADR-071 §8, mockup
 * `140549af` Accounts C).
 *
 * The provider header carries the subtotal; each account is a slim row with its
 * windows inline as meters and its spend over the range on the right. One
 * screen answers both questions the owner asks together — "who spent it" and
 * "how much room is left" — which two separate widgets could not.
 *
 * TWO LISTS MEET HERE AND NEITHER CONTAINS THE OTHER, so the panel is their
 * UNION, not either one of them. The dashboard knows what an account SPENT (it
 * groups the ledger); the limits provider knows what an account HAS LEFT (it
 * reads credentials). A signed-in plan that ran nothing this range has limits
 * and no ledger row, and history from before attribution has ledger rows and no
 * credential. Both are rows; showing only the intersection dropped the account
 * at 100% of its window, which is the one a person opens this screen for.
 *
 * They join on the account key, with ONE exception: `unknown` is not a key, it
 * is the absence of one (ADR-071 §3). Joining on it matched every unattributed
 * row in the ledger to one stored credential and reported that credential's
 * state five times. `unknown` never joins.
 */

import { useState } from 'react'
import type {
  AccountLimits,
  AccountLimitWindow,
  BillingType,
  BlockUsageData,
  DashboardAccount,
  UsageDashboardData
} from '../../../../shared/types'
import { providerIdForBucket, providerLabel } from '../../../../shared/provider-label'
import { authIssueLabel } from '../../stores/auth-issues'
import { ClaudeBlocksDrillIn } from './ClaudeBlocksDrillIn'
import {
  SEVERITY_FILL_CLASS,
  SEVERITY_ICON,
  formatCost,
  formatDuration,
  formatReset,
  formatResetRelative,
  meterSeverity
} from './usage-utils'

/** The provider whose accounts own the Claude 5-hour block analytics. */
const ANTHROPIC = 'anthropic'

/** ADR-071 §3's stand-in for "this row's account is not known". Never a key. */
const UNKNOWN_KEY = 'unknown'

// ---------------------------------------------------------------------------
// The union
// ---------------------------------------------------------------------------

/** A row the ledger produced, with its credential's limits when it has one. */
interface LedgerRow {
  kind: 'ledger'
  account: DashboardAccount
  limits: AccountLimits | null
}

/** A row only the limits provider knows about: a credential with no spend. */
interface LimitsRow {
  kind: 'limits'
  limits: AccountLimits
}

type PanelRow = LedgerRow | LimitsRow

interface PanelProvider {
  providerId: string
  label: string
  /** Null for a provider the dashboard never saw — it has no ledger subtotal. */
  totals: UsageDashboardData['providers'][number]['totals'] | null
  rows: PanelRow[]
}

function rowKey(row: PanelRow): string {
  return row.kind === 'ledger'
    ? `ledger:${row.account.accountKey}`
    : // An `unknown`-keyed limits entry is not unique by key, so React is given
      // the credential's own coordinates instead.
      `limits:${row.limits.vendorId}:${row.limits.label}`
}

function rowAccountKey(row: PanelRow): string {
  return row.kind === 'ledger' ? row.account.accountKey : row.limits.accountKey
}

function rowLabel(row: PanelRow): string {
  return row.kind === 'ledger' ? row.account.label : row.limits.label
}

function rowBillingType(row: PanelRow): BillingType | null {
  return row.kind === 'ledger' ? row.account.billingType : null
}

/**
 * Both lists, one tree. Dashboard providers keep their order and their
 * accounts; a credential with no spend is appended under the provider its key
 * and vendor resolve to, creating that provider's group when the ledger has
 * never seen it.
 */
function buildProviders(data: UsageDashboardData, limits: AccountLimits[]): PanelProvider[] {
  // `unknown` is excluded from the join index on purpose: see the file header.
  const joinable = new Map<string, AccountLimits>()
  for (const entry of limits) {
    if (entry.accountKey !== UNKNOWN_KEY) joinable.set(entry.accountKey, entry)
  }

  const groups: PanelProvider[] = data.providers.map((provider) => ({
    providerId: provider.providerId,
    label: provider.label,
    totals: provider.totals,
    rows: provider.accounts.map((account): PanelRow => ({
      kind: 'ledger',
      account,
      limits: account.accountKey === UNKNOWN_KEY ? null : (joinable.get(account.accountKey) ?? null)
    }))
  }))

  const byProviderId = new Map(groups.map((g) => [g.providerId, g]))
  const spent = new Set(
    data.providers
      .flatMap((p) => p.accounts.map((a) => a.accountKey))
      .filter((k) => k !== UNKNOWN_KEY)
  )

  for (const entry of limits) {
    // An `unknown`-keyed entry is a real stored account whose identity has not
    // been captured yet, so it is always its own row — the ledger's `unknown`
    // rows are not it.
    if (entry.accountKey !== UNKNOWN_KEY && spent.has(entry.accountKey)) continue
    const providerId = providerIdForBucket(entry.accountKey, entry.vendorId)
    let group = byProviderId.get(providerId)
    if (!group) {
      group = { providerId, label: providerLabel(providerId), totals: null, rows: [] }
      byProviderId.set(providerId, group)
      groups.push(group)
    }
    group.rows.push({ kind: 'limits', limits: entry })
  }

  return groups
}

// ---------------------------------------------------------------------------

interface AccountsPanelProps {
  data: UsageDashboardData
  /**
   * The readings, or null while the first read is in flight. Null is NOT an
   * empty list: "no limits yet" and "this account has no rate window" are
   * different facts and the rows say so differently.
   */
  limits: AccountLimits[] | null
  /** Fed to the Claude drill-in exactly as the old view fed it. */
  blockUsage: BlockUsageData | null
  providerColors: Map<string, string>
}

export function AccountsPanel({
  data,
  limits,
  blockUsage,
  providerColors
}: AccountsPanelProps): React.JSX.Element {
  const providers = buildProviders(data, limits ?? [])
  const total = data.totals.displayCostUsd

  return (
    <div
      data-testid="AccountsPanel"
      className="bg-bg-secondary rounded-xl border border-border/50 overflow-hidden"
    >
      <div className="flex items-baseline gap-2 px-3 py-2 border-b border-border/50">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary">
          Accounts
        </h3>
        <span className="text-[9px] text-text-muted">spend over the range · limits now</span>
      </div>

      {providers.length === 0 ? (
        <div className="px-3 py-4 text-[11px] text-text-muted">
          No usage recorded in this range.
        </div>
      ) : (
        providers.map((provider) => (
          <ProviderGroup
            key={provider.providerId}
            provider={provider}
            grandTotal={total}
            color={providerColors.get(provider.providerId)}
            limitsLoaded={limits !== null}
            blockUsage={blockUsage}
          />
        ))
      )}
    </div>
  )
}

function ProviderGroup({
  provider,
  grandTotal,
  color,
  limitsLoaded,
  blockUsage
}: {
  provider: PanelProvider
  grandTotal: number
  color: string | undefined
  limitsLoaded: boolean
  blockUsage: BlockUsageData | null
}): React.JSX.Element {
  const usd = provider.totals?.displayCostUsd ?? 0
  const requests = provider.totals?.requestCount ?? 0
  const unpriced = provider.totals?.unknownApiCostCount ?? 0
  const share = grandTotal > 0 ? Math.round((usd / grandTotal) * 100) : 0
  const n = provider.rows.length

  /**
   * A provider that ran turns and priced none of them is a whole group of rows
   * that all read `$0.00` — true, and never what the reader came for. It starts
   * folded, with the counts on the header so the honesty is not lost.
   *
   * Never folded when a credential's meters live inside: a fold that hides the
   * window at 100% would undo the union this panel exists to draw.
   */
  const collapsible =
    usd === 0 && requests > 0 && !provider.rows.some((row) => row.kind === 'limits')
  const [collapsed, setCollapsed] = useState(collapsible)
  const showRows = !collapsible || !collapsed

  return (
    <div>
      <div
        data-testid="AccountsPanel.provider"
        data-provider-id={provider.providerId}
        data-collapsed={collapsible ? collapsed : undefined}
        className="flex items-center justify-between gap-2 px-3 py-1.5 bg-bg-tertiary border-b border-border/50"
      >
        <div className="flex items-center gap-2 min-w-0">
          {collapsible ? (
            <button
              data-testid="AccountsPanel.provider.toggle"
              onClick={() => setCollapsed((v) => !v)}
              aria-expanded={!collapsed}
              title={collapsed ? 'Show accounts' : 'Hide accounts'}
              className="[-webkit-app-region:no-drag] w-3 shrink-0 text-[9px] text-text-muted hover:text-text-primary transition-colors cursor-default"
            >
              {collapsed ? '▸' : '▾'}
            </button>
          ) : (
            <span className="w-3 shrink-0" />
          )}
          <i
            className="inline-block w-2 h-2 rounded-full shrink-0"
            style={{ backgroundColor: color }}
          />
          <b className="text-[11px] text-text-primary truncate">{provider.label}</b>
          <span className="text-[9px] text-text-muted shrink-0">
            {n} {n === 1 ? 'account' : 'accounts'}
          </span>
        </div>
        <div
          data-testid="AccountsPanel.provider.subtotal"
          className="font-mono text-[11px] text-text-primary shrink-0"
        >
          {formatCost(usd)} <span className="text-[9px] text-text-muted">{share}%</span>
          {collapsible && (
            <span className="ml-2 font-sans text-[9px] text-text-muted">
              {requests} {requests === 1 ? 'turn' : 'turns'} ·{' '}
              {/* `$0.00` with nothing unpriced is a FREE provider, not an
                  unpriced one; saying "0 unpriced" beside it read as a bug. */}
              {unpriced > 0 ? `${unpriced} unpriced` : 'free'}
            </span>
          )}
        </div>
      </div>

      {showRows &&
        provider.rows.map((row) => (
          <AccountRow
            key={rowKey(row)}
            row={row}
            providerId={provider.providerId}
            limitsLoaded={limitsLoaded}
            blockUsage={blockUsage}
          />
        ))}
    </div>
  )
}

function AccountRow({
  row,
  providerId,
  limitsLoaded,
  blockUsage
}: {
  row: PanelRow
  providerId: string
  limitsLoaded: boolean
  blockUsage: BlockUsageData | null
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  // Only an Anthropic subscription has 5-hour blocks to drill into; every other
  // account's row ends at its meters.
  const drillable = providerId === ANTHROPIC
  const accountKey = rowAccountKey(row)
  const billingType = rowBillingType(row)

  return (
    <div
      data-testid="AccountsPanel.account"
      data-account-key={accountKey}
      data-provider-id={providerId}
      data-limits-only={row.kind === 'limits' ? 'true' : undefined}
      className="border-b border-border/50 last:border-b-0"
    >
      <div className="flex items-center gap-3 pl-3 pr-3 py-2">
        {drillable ? (
          <button
            data-testid="AccountsPanel.drillIn.toggle"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            title={expanded ? 'Hide block analytics' : 'Show 5-hour block analytics'}
            className="[-webkit-app-region:no-drag] w-4 h-4 shrink-0 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-default text-[9px]"
          >
            {expanded ? '▾' : '▸'}
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}

        {/* Proportional, not fixed: a fixed column truncated every long label beside
            free space once the panel took the full width. A percentage keeps the
            meters aligned across rows; the floor keeps a narrow window readable. */}
        <div className="w-[28%] min-w-[190px] shrink-0 flex items-center gap-1.5">
          <span className="text-[11px] text-text-primary truncate" title={rowLabel(row)}>
            {rowLabel(row)}
          </span>
          {billingType && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-bg-tertiary text-text-secondary shrink-0">
              {billingType}
            </span>
          )}
        </div>

        <div className="flex-1 min-w-0 flex flex-wrap items-center gap-x-3 gap-y-1">
          <LimitsCell row={row} limitsLoaded={limitsLoaded} />
        </div>

        {row.kind === 'ledger' ? (
          <div
            data-testid="AccountsPanel.account.spend"
            className="w-[86px] shrink-0 text-right font-mono text-[11px] text-text-primary"
          >
            {formatCost(row.account.totals.displayCostUsd)}
          </div>
        ) : (
          <div
            data-testid="AccountsPanel.account.spend"
            title="no spend in this range"
            className="w-[86px] shrink-0 text-right font-mono text-[11px] text-text-muted"
          >
            —
          </div>
        )}
      </div>

      {drillable && expanded && (
        <div
          data-testid="AccountsPanel.drillIn"
          className="border-t border-border/50 bg-bg-primary"
        >
          <ClaudeBlocksDrillIn blockUsage={blockUsage} />
        </div>
      )}
    </div>
  )
}

/**
 * Whatever is known about this row's headroom. The order matters: a reading
 * that failed says so instead of drawing meters, an account this machine holds
 * no credential for says "no rate window", and an `unknown` ledger row says it
 * has no identity — which is a different fact from having no window, and must
 * not borrow another credential's state to say it.
 */
function LimitsCell({
  row,
  limitsLoaded
}: {
  row: PanelRow
  limitsLoaded: boolean
}): React.JSX.Element {
  if (row.kind === 'ledger' && row.account.accountKey === UNKNOWN_KEY) {
    return (
      <span
        className="text-[10px] text-text-muted"
        title="Recorded before this engine's usage was attributed to an account, so no credential can be matched to it."
      >
        no account identity
      </span>
    )
  }

  // `LedgerRow.limits` may be null; `LimitsRow.limits` never is.
  const limits: AccountLimits | null = row.limits
  if (!limits) {
    return (
      <span className="text-[10px] text-text-muted">
        {limitsLoaded ? 'no rate window' : 'reading limits…'}
      </span>
    )
  }

  const { state, windows, credits } = limits
  // A stored credential the ledger cannot name yet: say why rather than leaving
  // a reader to wonder which account this is.
  const unidentified = row.kind === 'limits' && limits.accountKey === UNKNOWN_KEY
  const hint = unidentified ? (
    <span className="text-[9px] text-text-muted">
      identity captured once this account is active
    </span>
  ) : null

  if (state === 'needs-sign-in' || state === 'unavailable') {
    return (
      <>
        <StateChip limits={limits} />
        {hint}
      </>
    )
  }

  return (
    <>
      {windows.map((w) => (
        <Meter key={w.kind} limitWindow={w} />
      ))}
      {windows.length === 0 && credits && (
        <span className="text-[10px] text-text-secondary">{creditsLabel(credits)}</span>
      )}
      {windows.length === 0 && !credits && (
        <span className="text-[10px] text-text-muted">no rate window</span>
      )}
      {state === 'stale' && <StateChip limits={limits} />}
      {hint}
    </>
  )
}

/**
 * What a credits plan has left. A business workspace reports credits instead of
 * windows, and sometimes reports the plan without a balance — which is "we know
 * it is a credits plan and not how much is in it", not a balance of nothing.
 */
function creditsLabel(credits: NonNullable<AccountLimits['credits']>): string {
  if (credits.unlimited) return 'Unlimited credits'
  if (credits.balance !== null) return `${credits.balance} credits left`
  return 'credits plan'
}

/**
 * Why a reading is thin. `stale` is the owner's refresh-grant rule working as
 * designed (ADR-071 §6) — an inactive account's stored reading, no token spent
 * — so it says how old rather than apologising.
 */
function StateChip({ limits }: { limits: AccountLimits }): React.JSX.Element {
  const { state } = limits
  let text: string
  let title: string
  let className = 'text-text-muted'
  if (state === 'stale') {
    const age = Math.max(0, Date.now() - limits.observedAt)
    text = `⚠ ${formatDuration(age)} old`
    title =
      'The last stored reading. Refreshing an inactive account spends one of its refresh grants, so nothing does it on a timer (ADR-071 §6).'
    className = 'text-warning'
  } else if (state === 'needs-sign-in') {
    // The same words ADR-070's auth pill uses for the same condition, from the
    // same constant, so one credential cannot be described two ways.
    text = authIssueLabel('needed')
    title = 'The stored credential no longer authenticates. Sign in again to read this account.'
    className = 'text-warning'
  } else {
    // Not a dash: a bare em-dash with no tooltip said nothing at all, and a
    // reader cannot tell "never read" from "read and empty" (ADR-030).
    text = 'not read'
    title = 'No reading for this account yet. Refresh limits reads its stored credentials.'
  }

  return (
    <span
      data-testid="AccountsPanel.state"
      data-state={state}
      className={`text-[10px] ${className}`}
      title={limits.error ?? title}
    >
      {text}
    </span>
  )
}

/**
 * One window's fill, its severity icon, its percent and when it comes back.
 *
 * Sized so that a three-window Claude account fits on ONE line: at the old
 * widths a meter was as wide as the whole cell and three of them stacked three
 * deep, which turned the panel's tallest row into its least readable. The reset
 * is the part that gives way first — it is the least urgent of the three facts
 * and it is always in the tooltip — so below `xl` only the icon and the percent
 * are drawn.
 */
function Meter({ limitWindow: w }: { limitWindow: AccountLimitWindow }): React.JSX.Element {
  const pct = Math.max(0, Math.min(100, Math.round(w.usedPercent)))
  const severity = meterSeverity(pct)
  // The row shows the form this kind of window is acted on; the tooltip carries
  // the other one, so neither reading costs a click.
  const reset = formatReset(w.kind, w.resetsAt)
  const relative = formatResetRelative(w.resetsAt)

  return (
    <div
      data-testid="AccountsPanel.meter"
      data-kind={w.kind}
      data-severity={severity}
      className="flex items-center gap-1 min-w-0"
      title={`${w.label} · ${pct}% used · resets ${reset}${relative === reset ? '' : ` (${relative})`}`}
    >
      <span className="text-[9px] text-text-muted min-w-[40px] shrink-0 whitespace-nowrap">
        {w.label}
      </span>
      <div className="w-[44px] h-[6px] shrink-0 rounded-full bg-bg-tertiary overflow-hidden">
        <div
          className={`h-full rounded-full ${SEVERITY_FILL_CLASS[severity]}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="font-mono text-[10px] text-text-primary whitespace-nowrap">
        <span aria-hidden="true">{SEVERITY_ICON[severity]}</span> {pct}%
        <span data-testid="AccountsPanel.meter.reset" className="hidden xl:inline text-text-muted">
          {' '}
          · {reset}
        </span>
      </span>
    </div>
  )
}

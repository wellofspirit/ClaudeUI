/**
 * What a subscription window actually delivers (ADR-071 §7 and §8, mockup
 * `140549af` Window value B → A → C).
 *
 * The ledger knows two things about a rate window: how far it was pushed
 * (`peakPercent`, reported by the provider) and what the turns inside it were
 * worth at list price (`apiCostUsd`, summed from this machine's rows). Dividing
 * one by the other is the only answer this app can give to "is the plan worth
 * it", and the three sections ask three versions of the question:
 *
 *   B  Subscriptions compared — one row per account per window kind. The single
 *      view for "which plan pays for itself", and the reason the range bar is
 *      the mark: an average alone hides that one window delivered $4 and the
 *      next one $400.
 *   A  Per window — the selected account's windows in time order, so a plan
 *      getting more or less use shows as a trend rather than as a wider range.
 *   C  Peak vs delivered — every closed window as a dot. The slope is dollars
 *      per 1% of the limit, and the dots BELOW the crowd are the bias made
 *      visible: a window pushed to 80% that delivered almost nothing was pushed
 *      somewhere this ledger cannot see.
 *
 * THE BIAS IS NOT A DEFECT TO HIDE. The percent is global to the account and the
 * dollars are local to this machine, so every figure here reads low. The
 * footnote says so once for the card rather than as a caveat per number
 * (ADR-071 §7; ADR-072's usage hub closes the other-machines half of it).
 *
 * UNDER THE COMBINED SCOPE (S5c) the read asks for `all` and the query prefers
 * the HUB's row for any window it holds, whose numerator is summed over every
 * machine (ADR-072 §4). That narrows the bias to the part nothing can close —
 * claude.ai and the provider's own web use — so the footnote stays exactly as it
 * was and the subtitle says how many machines went into the figures.
 *
 * ADR-030 runs through it: a window with unpriced turns says how many are
 * MISSING from its dollars rather than quietly summing them as zero.
 *
 * This widget owns its read. The shell's dashboard query is over `usage_bucket`
 * and says nothing about windows; `usage:windows` is a second, small query with
 * a different shape, and threading it through the shell would hand three other
 * widgets a prop none of them use.
 */

import { useEffect, useMemo, useState } from 'react'
import type {
  AccountLimits,
  DashboardRange,
  UsageDashboardData,
  UsageWindowSummaryRow
} from '../../../../shared/types'
import { providerIdForBucket, providerLabel } from '../../../../shared/provider-label'
import { windowKindLabel, windowKindMinutes } from '../../../../shared/window-kind'
import {
  PROVIDER_OVERFLOW_COLOR,
  combinedMachineCount,
  formatCost,
  rangeWords
} from './usage-utils'
import { SelectMenu } from '../shared/SelectMenu'

/**
 * How many machines the hub summed the numerators over — the SAME count the sync
 * chip and the summary print, so a reader is never told "3 machines" here and
 * "2 machines" on the card above.
 */
function CombinedNote({ data }: { data: UsageDashboardData }): React.JSX.Element {
  const n = combinedMachineCount(data.machines.filter((m) => !m.self))
  return (
    <span data-testid="WindowValue.combined">
      {' · '}combined across {n} {n === 1 ? 'machine' : 'machines'}
    </span>
  )
}

/**
 * ADR-071 §7's noise floor. Under this peak the denominator is small enough that
 * a single turn swings the implied value by hundreds of dollars, so the window
 * is kept and SHOWN — faint — but never averaged.
 */
const FLOOR_PERCENT = 5

/** dataviz: a column never fills its slot; the leftover is air. */
const COLUMN_MAX_W = 20
const COLUMNS_H = 110
/** The row under the plot that carries a column's caption, always reserved. */
const CAPTION_H = 10
const SCATTER_H = 180
/** Gutters carrying the scatter's dollar ticks and its percent ticks. */
const SCATTER_PAD_L = 44
const SCATTER_PAD_B = 20
/** A non-zero mark is never invisible (the floor the summary's coverage bar uses). */
const MIN_MARK_PCT = 0.6

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const EMPTY_MESSAGE = 'No closed window yet — the first values appear a day after a window ends.'

/**
 * Which windows the range actually admits.
 *
 * `usageWindowSummary` filters on `canonical_end >= fromTs`, so an OPEN window
 * — whose end is in the future — is in every range's rows. On `today` that is
 * most of what there is to see: with `fromTs` at midnight, almost nothing has
 * closed yet, and a caption promising "windows ending today" alone would read
 * as a bug when the widget draws a hatched open one.
 */
function windowScope(range: DashboardRange): string {
  return range === 'today'
    ? 'windows ending today or still open'
    : `windows ending in the ${rangeWords(range)}`
}

// ---------------------------------------------------------------------------
// Window-kind vocabulary
// ---------------------------------------------------------------------------

/**
 * A window kind as a person says it. A scoped weekly's slug comes from the
 * provider's own display name (`7d:fable`) and arrives lower-cased (S3a), and
 * is title-cased here beside the base label the shared rule gives.
 */
function kindLabel(kind: string): string {
  const [base, ...rest] = kind.split(':')
  const scope = rest.join(':')
  const label = windowKindLabel(base)
  return scope ? `${label} · ${titleCase(scope)}` : label
}

function titleCase(slug: string): string {
  return slug
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/**
 * Shortest window first, and a scoped weekly after the plain window of the same
 * length — the reading order the owner's plans produce (5-hour, 7-day, then the
 * per-model weeklies).
 *
 * Ordering by LENGTH rather than by the two literals, so a `3d` or `1h` window
 * (a ChatGPT plan can carry any duration, S3c) lands where it belongs instead of
 * in the "anything new" bucket at the end. A kind that names no length — a
 * window the vendor described only by position — sorts last, since there is
 * nothing to compare it by.
 */
function kindRank(kind: string): number {
  const [base, ...rest] = kind.split(':')
  const minutes = windowKindMinutes(base)
  if (minutes === null) return Number.MAX_SAFE_INTEGER
  // Two ranks per length: the plain window, then its scoped variants.
  return minutes * 2 + (rest.length > 0 ? 1 : 0)
}

function orderedKinds(rows: readonly UsageWindowSummaryRow[]): string[] {
  const kinds = [...new Set(rows.map((r) => r.windowKind))]
  return kinds.sort((a, b) => kindRank(a) - kindRank(b) || a.localeCompare(b))
}

/** `Thu 18 Sep, 09:00` — the weekday is what makes a weekly window recognisable. */
function formatWindowEnd(ts: number): string {
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}, ${hh}:${mm}`
}

/** `+3 unpriced`, or nothing — never a "0 unpriced" that reads as a warning. */
function unpricedSuffix(count: number): string {
  return count > 0 ? `\n+${count} unpriced (missing from the dollars)` : ''
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

interface WindowValueProps {
  data: UsageDashboardData
  limits: AccountLimits[] | null
  /** Provider id → its fixed colour, built once by the shell. */
  providerColors: Map<string, string>
  range: DashboardRange
}

export function WindowValue({
  data,
  limits,
  providerColors,
  range
}: WindowValueProps): React.JSX.Element {
  const [rows, setRows] = useState<UsageWindowSummaryRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [account, setAccount] = useState<string | null>(null)

  // One read, re-run when the shell's range moves (`fromTs` IS the query) or
  // when the shell re-read the ledger (`generatedAt`), which is also when a
  // finished turn may have changed a window's dollars. The rows on screen stay
  // put while a re-read is in flight: a nudge every two seconds that blanked the
  // card would be worse than a figure two seconds stale.
  const sinceTs = data.fromTs
  const generatedAt = data.generatedAt
  const scope = data.scope
  useEffect(() => {
    let cancelled = false
    window.api
      .fetchUsageWindows({ sinceTs, ...(scope === 'all' ? { scope } : {}) })
      .then((r) => {
        if (cancelled) return
        setRows(r)
        setError(null)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'Could not read window value')
      })
    return () => {
      cancelled = true
    }
  }, [sinceTs, generatedAt, scope])

  // An account with windows but no spend in range is absent from the dashboard
  // and present in the credentials, so both name accounts. `unknown` is never
  // joined on (S4b-1 round 3): several credentials report it, and one of their
  // labels would end up on all of them.
  const labels = useMemo(() => {
    const m = new Map<string, string>()
    for (const p of data.providers) {
      for (const a of p.accounts) if (a.accountKey !== 'unknown') m.set(a.accountKey, a.label)
    }
    for (const l of limits ?? []) if (l.accountKey !== 'unknown') m.set(l.accountKey, l.label)
    return m
  }, [data, limits])

  const labelFor = (key: string): string => labels.get(key) ?? key.split(':')[1] ?? key
  // A window row carries no vendor id, so the provider comes from the key's own
  // subscription prefix; a key with neither falls to the overflow neutral.
  const colorFor = (key: string): string =>
    providerColors.get(providerIdForBucket(key, '')) ?? PROVIDER_OVERFLOW_COLOR

  const accounts = useMemo(() => accountOptions(rows ?? []), [rows])
  const selected = account && accounts.some((a) => a.key === account) ? account : accounts[0]?.key

  return (
    <div
      data-testid="WindowValue"
      className="bg-bg-secondary rounded-xl border border-border/50 p-3"
    >
      <div className="flex items-baseline gap-2 mb-2">
        <h3 className="text-[11px] font-semibold text-text-secondary uppercase tracking-wider">
          Window value
        </h3>
        <span className="text-[9px] text-text-muted">
          what a subscription window delivers · {windowScope(range)}
          {data.scope === 'all' && <CombinedNote data={data} />}
        </span>
      </div>

      {error !== null ? (
        <div data-testid="WindowValue.error" className="text-[11px] text-danger py-2">
          Could not read window value: {error}
        </div>
      ) : rows === null ? (
        <div data-testid="WindowValue.loading" className="text-[11px] text-text-muted py-4">
          Reading window value…
        </div>
      ) : rows.length === 0 ? (
        <div data-testid="WindowValue.empty" className="text-[11px] text-text-muted py-4">
          {EMPTY_MESSAGE}
        </div>
      ) : (
        <div className="space-y-4">
          <Compare rows={rows} labelFor={labelFor} colorFor={colorFor} />
          <PerWindow
            rows={rows}
            accounts={accounts}
            selected={selected ?? null}
            onSelect={setAccount}
            labelFor={labelFor}
            colorFor={colorFor}
          />
          <Scatter
            rows={rows}
            labelFor={labelFor}
            colorFor={colorFor}
            providerColors={providerColors}
          />
          <Footnote />
        </div>
      )}
    </div>
  )
}

interface AccountOption {
  key: string
  closed: number
  total: number
}

/** The accounts that have any window at all, best-evidenced first. */
function accountOptions(rows: readonly UsageWindowSummaryRow[]): AccountOption[] {
  const byKey = new Map<string, AccountOption>()
  for (const r of rows) {
    const e = byKey.get(r.accountKey) ?? { key: r.accountKey, closed: 0, total: 0 }
    e.total += 1
    if (r.closed) e.closed += 1
    byKey.set(r.accountKey, e)
  }
  // The default selection is the account with the most CLOSED windows: it is the
  // one whose chart says something, and an account holding a single open window
  // would otherwise open the section on an axis with one hatched column.
  return [...byKey.values()].sort(
    (a, b) => b.closed - a.closed || b.total - a.total || a.key.localeCompare(b.key)
  )
}

// ---------------------------------------------------------------------------
// B — subscriptions compared
// ---------------------------------------------------------------------------

interface CompareRow {
  accountKey: string
  n: number
  min: number
  max: number
  mean: number
  /** Mean implied full-window value, or null when no window of this account priced one. */
  full: number | null
  unpriced: number
}

function buildCompare(
  rows: readonly UsageWindowSummaryRow[],
  kind: string
): { rows: CompareRow[]; domain: number } {
  const byKey = new Map<string, UsageWindowSummaryRow[]>()
  for (const r of rows) {
    // Closed only, and above the floor: an open window is still accumulating,
    // and a 2% window would set the average by itself.
    if (r.windowKind !== kind || !r.closed || r.peakPercent < FLOOR_PERCENT) continue
    const list = byKey.get(r.accountKey) ?? []
    list.push(r)
    byKey.set(r.accountKey, list)
  }

  const out: CompareRow[] = []
  for (const [accountKey, list] of byKey) {
    const usd = list.map((r) => r.apiCostUsd)
    const implied = list
      .map((r) => r.impliedFullWindowUsd)
      .filter((v): v is number => v !== null && Number.isFinite(v))
    out.push({
      accountKey,
      n: list.length,
      min: Math.min(...usd),
      max: Math.max(...usd),
      mean: usd.reduce((s, v) => s + v, 0) / usd.length,
      full: implied.length > 0 ? implied.reduce((s, v) => s + v, 0) / implied.length : null,
      unpriced: list.reduce((s, r) => s + r.unknownCostCount, 0)
    })
  }
  out.sort((a, b) => b.mean - a.mean || a.accountKey.localeCompare(b.accountKey))

  // ONE scale per kind, wide enough for the implied-value tick as well as the
  // bars: two accounts on the same kind of window are only comparable when their
  // rows are measured against the same axis.
  const domain = out.reduce((m, r) => Math.max(m, r.max, r.full ?? 0), 0) * 1.08
  return { rows: out, domain }
}

function Compare({
  rows,
  labelFor,
  colorFor
}: {
  rows: readonly UsageWindowSummaryRow[]
  labelFor: (key: string) => string
  colorFor: (key: string) => string
}): React.JSX.Element {
  const groups = orderedKinds(rows)
    .map((kind) => ({ kind, ...buildCompare(rows, kind) }))
    .filter((g) => g.rows.length > 0)

  return (
    <section data-testid="WindowValue.compare">
      <SectionHead
        title="Subscriptions compared"
        note="closed windows only · the bar spans least-to-most delivered"
      />
      {groups.length === 0 ? (
        <div className="text-[11px] text-text-muted">{EMPTY_MESSAGE}</div>
      ) : (
        <div className="space-y-3">
          {groups.map((g) => (
            <div key={g.kind} data-testid="WindowValue.compare.kind" data-kind={g.kind}>
              <div className="text-[9px] uppercase tracking-wider text-text-muted mb-1">
                Per {kindLabel(g.kind)} window · API-equivalent $
              </div>
              <div className="space-y-1">
                {g.rows.map((row) => (
                  <CompareRowView
                    key={row.accountKey}
                    row={row}
                    kind={g.kind}
                    domain={g.domain}
                    label={labelFor(row.accountKey)}
                    color={colorFor(row.accountKey)}
                  />
                ))}
              </div>
              <CompareAxis domain={g.domain} />
            </div>
          ))}
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[9px] text-text-muted">
            <span>● average delivered</span>
            <span>▬ least–most delivered</span>
            <span>┃ implied value at 100%</span>
          </div>
        </div>
      )}
    </section>
  )
}

function CompareRowView({
  row,
  kind,
  domain,
  label,
  color
}: {
  row: CompareRow
  kind: string
  domain: number
  label: string
  color: string
}): React.JSX.Element {
  const x = (v: number): number => (domain > 0 ? Math.min(100, (v / domain) * 100) : 0)
  const span = x(row.max) - x(row.min)
  const title =
    `${label} · ${kindLabel(kind)} window\n` +
    `${row.n} closed window${row.n === 1 ? '' : 's'}\n` +
    `Average delivered  ${formatCost(row.mean)}\n` +
    `Range              ${formatCost(row.min)} – ${formatCost(row.max)}\n` +
    `Implied full       ${row.full === null ? 'unknown' : `≈ ${formatCost(row.full)}`}` +
    unpricedSuffix(row.unpriced)

  return (
    <div
      data-testid="WindowValue.compare.row"
      data-account-key={row.accountKey}
      data-kind={kind}
      title={title}
      className="flex items-center gap-2 text-[10px]"
    >
      <div className="w-[104px] shrink-0 truncate text-text-primary">{label}</div>
      <div className="relative flex-1 h-[16px] min-w-[80px]">
        <div
          data-testid="WindowValue.compare.row.range"
          className="absolute top-1/2 -translate-y-1/2 h-[6px] rounded-full"
          style={{
            left: `${x(row.min)}%`,
            width: `${row.max > row.min ? Math.max(span, MIN_MARK_PCT) : 0}%`,
            backgroundColor: color,
            opacity: 0.35
          }}
        />
        <div
          data-testid="WindowValue.compare.row.avg"
          className="absolute top-1/2 w-[9px] h-[9px] rounded-full -translate-x-1/2 -translate-y-1/2 ring-2 ring-bg-secondary"
          style={{ left: `${x(row.mean)}%`, backgroundColor: color }}
        />
        {row.full !== null && (
          <div
            data-testid="WindowValue.compare.row.full"
            className="absolute inset-y-0 w-[2px] -translate-x-1/2 bg-text-primary"
            style={{ left: `${x(row.full)}%` }}
          />
        )}
      </div>
      <div className="w-[200px] shrink-0 text-right font-mono text-text-secondary whitespace-nowrap">
        {row.n}w · avg {formatCost(row.mean)} ·{' '}
        {row.full === null ? 'full ≈ —' : `full ≈ ${formatCost(row.full)}`}
      </div>
    </div>
  )
}

/** The shared x-axis under one kind's rows: a hairline rule and five labels. */
function CompareAxis({ domain }: { domain: number }): React.JSX.Element {
  const stops = [0, 0.25, 0.5, 0.75, 1]
  return (
    <div className="flex items-start gap-2 mt-0.5">
      <div className="w-[104px] shrink-0" />
      <div className="relative flex-1 h-[10px] min-w-[80px] border-t border-border/40">
        {stops.map((s) => (
          <span
            key={s}
            className="absolute top-[1px] text-[8px] text-text-muted -translate-x-1/2 font-mono"
            style={{ left: `${s * 100}%` }}
          >
            {formatCost(domain * s)}
          </span>
        ))}
      </div>
      <div className="w-[200px] shrink-0" />
    </div>
  )
}

// ---------------------------------------------------------------------------
// A — per window, for one account
// ---------------------------------------------------------------------------

function PerWindow({
  rows,
  accounts,
  selected,
  onSelect,
  labelFor,
  colorFor
}: {
  rows: readonly UsageWindowSummaryRow[]
  accounts: AccountOption[]
  selected: string | null
  onSelect: (key: string) => void
  labelFor: (key: string) => string
  colorFor: (key: string) => string
}): React.JSX.Element {
  const mine = rows.filter((r) => r.accountKey === selected)
  const kinds = orderedKinds(mine)

  return (
    <section data-testid="WindowValue.perWindow">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <SectionHead title="Per window" note="oldest → latest · API-equivalent $ delivered" />
        <SelectMenu
          testid="WindowValue.perWindow.account"
          value={selected ?? ''}
          onChange={onSelect}
          options={accounts.map((a) => ({ value: a.key, label: labelFor(a.key) }))}
          triggerClassName="text-[10px] bg-bg-primary/50 border border-border/50 rounded px-1.5 py-0.5 text-text-secondary outline-none"
          title="Which account's windows to chart"
          ariaLabel="Account"
        />
      </div>
      {kinds.length === 0 ? (
        <div className="text-[11px] text-text-muted">{EMPTY_MESSAGE}</div>
      ) : (
        <div className="space-y-2">
          {kinds.map((kind) => (
            <Columns
              key={kind}
              kind={kind}
              rows={mine.filter((r) => r.windowKind === kind)}
              color={colorFor(selected ?? '')}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function Columns({
  kind,
  rows,
  color
}: {
  kind: string
  rows: UsageWindowSummaryRow[]
  color: string
}): React.JSX.Element {
  const ordered = [...rows].sort((a, b) => a.canonicalEnd - b.canonicalEnd)
  // The columns' own scale. The implied full-window value is deliberately NOT on
  // this axis: a window at 8% implies twelve times what it delivered, and a rule
  // drawn there would flatten every column it is meant to explain. It is stated
  // as a figure beside the title instead.
  const domain = ordered.reduce((m, r) => Math.max(m, r.apiCostUsd), 0) * 1.08
  const implied = ordered
    .filter((r) => r.closed && r.peakPercent >= FLOOR_PERCENT)
    .map((r) => r.impliedFullWindowUsd)
    .filter((v): v is number => v !== null && Number.isFinite(v))
  const impliedMean =
    implied.length > 0 ? implied.reduce((s, v) => s + v, 0) / implied.length : null
  const openCount = ordered.reduce((n, r) => (r.closed ? n : n + 1), 0)

  return (
    <div
      data-testid="WindowValue.perWindow.chart"
      data-kind={kind}
      className="bg-bg-primary/30 rounded-lg border border-border/40 px-2 pt-1.5 pb-1"
    >
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <span className="text-[9px] uppercase tracking-wider text-text-muted">
          {kindLabel(kind)} windows
        </span>
        <span className="text-[9px] text-text-muted font-mono">
          {impliedMean === null
            ? 'implied full window ≈ —'
            : `implied full window ≈ ${formatCost(impliedMean)}`}
        </span>
      </div>
      <div className="flex items-end gap-[2px]" style={{ height: COLUMNS_H }}>
        {ordered.map((r) => (
          <Column key={`${r.windowKind}:${r.canonicalEnd}`} row={r} domain={domain} color={color} />
        ))}
      </div>
      {/* The captions get their own row rather than an overlay: drawn inside the
          plot they landed on the base of the very column they name. The row is
          reserved whether or not anything is open, so the baseline never moves.
          At 90 days of 5-hour windows a cell is a few pixels wide and the word
          is unreadable, which is what the footer's count is for. */}
      <div className="flex gap-[2px]" style={{ height: CAPTION_H }}>
        {ordered.map((r) => (
          <span
            key={`${r.windowKind}:${r.canonicalEnd}`}
            data-testid="WindowValue.perWindow.caption"
            data-end={String(r.canonicalEnd)}
            className="flex-1 min-w-[3px] text-center text-[8px] leading-[10px] text-text-muted truncate"
          >
            {r.closed ? '' : 'open'}
          </span>
        ))}
      </div>
      <div className="flex justify-between text-[8px] text-text-muted border-t border-border/40 pt-0.5">
        <span>oldest</span>
        <span className="font-mono">top of scale {formatCost(domain)}</span>
        <span>{openCount > 0 ? `latest · ${openCount} open` : 'latest'}</span>
      </div>
    </div>
  )
}

function Column({
  row,
  domain,
  color
}: {
  row: UsageWindowSummaryRow
  domain: number
  color: string
}): React.JSX.Element {
  const faint = row.peakPercent < FLOOR_PERCENT
  const height = domain > 0 ? Math.min(100, (row.apiCostUsd / domain) * 100) : 0
  const title =
    `${kindLabel(row.windowKind)} window ending ${formatWindowEnd(row.canonicalEnd)}\n` +
    `Peak used   ${row.peakPercent}%\n` +
    `Delivered   ${formatCost(row.apiCostUsd)}\n` +
    (row.closed
      ? faint
        ? 'Under the 5% floor — too little of the window was used to imply its full value.'
        : `Implied full ${
            row.impliedFullWindowUsd === null
              ? 'unknown'
              : `≈ ${formatCost(row.impliedFullWindowUsd)}`
          }`
      : 'Still open — it keeps accumulating until a day after it ends.') +
    unpricedSuffix(row.unknownCostCount)

  return (
    <div className="flex-1 min-w-[3px] h-full flex flex-col justify-end items-center">
      {row.unknownCostCount > 0 && (
        <span
          className="text-[8px] leading-none text-warning font-mono"
          title={`${row.unknownCostCount} unpriced`}
        >
          +{row.unknownCostCount}
        </span>
      )}
      <div
        data-testid="WindowValue.perWindow.column"
        data-end={String(row.canonicalEnd)}
        data-open={String(!row.closed)}
        data-faint={String(faint)}
        title={title}
        className="w-full rounded-t-[3px]"
        style={{
          height: `${height}%`,
          maxWidth: COLUMN_MAX_W,
          opacity: faint ? 0.35 : 1,
          // An open window is drawn, not omitted: its dollars are real but not
          // final, and the hatch says so without spending a legend entry.
          ...(row.closed
            ? { backgroundColor: color }
            : {
                backgroundImage: `repeating-linear-gradient(45deg, ${color} 0 3px, transparent 3px 6px)`,
                outline: `1px dashed ${color}`,
                outlineOffset: '-1px'
              })
        }}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// C — peak against delivered
// ---------------------------------------------------------------------------

function Scatter({
  rows,
  labelFor,
  colorFor,
  providerColors
}: {
  rows: readonly UsageWindowSummaryRow[]
  labelFor: (key: string) => string
  colorFor: (key: string) => string
  providerColors: Map<string, string>
}): React.JSX.Element {
  const dots = rows.filter((r) => r.closed)
  const domain = dots.reduce((m, r) => Math.max(m, r.apiCostUsd), 0) * 1.08
  const providers = [...new Set(dots.map((r) => providerIdForBucket(r.accountKey, '')))].sort()
  const yStops = [0, 0.25, 0.5, 0.75, 1]
  const xStops = [0, 25, 50, 75, 100]

  return (
    <section data-testid="WindowValue.scatter">
      <SectionHead
        title="Peak vs delivered"
        note="one dot per closed window · the slope is dollars per 1% of the limit"
      />
      {dots.length === 0 ? (
        <div className="text-[11px] text-text-muted">{EMPTY_MESSAGE}</div>
      ) : (
        <>
          <div className="relative" style={{ height: SCATTER_H }}>
            <div
              className="absolute top-0 right-0"
              style={{ left: SCATTER_PAD_L, bottom: SCATTER_PAD_B }}
            >
              <div className="relative w-full h-full">
                {yStops.map((s) => (
                  <div
                    key={s}
                    className="absolute inset-x-0 border-t border-border/40"
                    style={{ bottom: `${s * 100}%` }}
                  >
                    <span className="absolute right-full pr-1 -translate-y-1/2 text-[8px] text-text-muted font-mono whitespace-nowrap">
                      {formatCost(domain * s)}
                    </span>
                  </div>
                ))}
                {xStops.map((p) => (
                  <span
                    key={p}
                    className="absolute top-full mt-0.5 -translate-x-1/2 text-[8px] text-text-muted"
                    style={{ left: `${p}%` }}
                  >
                    {p}%
                  </span>
                ))}
                {dots.map((r) => (
                  <Dot
                    key={`${r.accountKey}:${r.windowKind}:${r.canonicalEnd}`}
                    row={r}
                    domain={domain}
                    label={labelFor(r.accountKey)}
                    color={colorFor(r.accountKey)}
                  />
                ))}
              </div>
            </div>
          </div>
          {/* Identity never rests on the dot's colour alone: the providers on the
              plot are named here, and every dot carries its account in its title. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[9px] text-text-muted">
            <span className="mr-auto">peak % of the window&apos;s limit →</span>
            {providers.map((id) => (
              <span key={id} className="flex items-center gap-1">
                <i
                  className="inline-block w-2 h-2 rounded-full"
                  style={{ backgroundColor: providerColors.get(id) ?? PROVIDER_OVERFLOW_COLOR }}
                />
                {providerLabel(id)}
              </span>
            ))}
          </div>
        </>
      )}
    </section>
  )
}

function Dot({
  row,
  domain,
  label,
  color
}: {
  row: UsageWindowSummaryRow
  domain: number
  label: string
  color: string
}): React.JSX.Element {
  const faint = row.peakPercent < FLOOR_PERCENT
  const title =
    `${label} · ${kindLabel(row.windowKind)}\n` +
    `Ending      ${formatWindowEnd(row.canonicalEnd)}\n` +
    `Peak used   ${row.peakPercent}%\n` +
    `Delivered   ${formatCost(row.apiCostUsd)}\n` +
    (faint
      ? 'Under the 5% floor — excluded from every average.'
      : `$ per 1%    ${row.usdPerPercent === null ? 'unknown' : formatCost(row.usdPerPercent)}`) +
    unpricedSuffix(row.unknownCostCount)

  return (
    <div
      data-testid="WindowValue.scatter.dot"
      data-account-key={row.accountKey}
      data-kind={row.windowKind}
      data-faint={String(faint)}
      title={title}
      className="absolute w-[9px] h-[9px] rounded-full -translate-x-1/2 translate-y-1/2 ring-2 ring-bg-secondary"
      style={{
        left: `${Math.max(0, Math.min(100, row.peakPercent))}%`,
        bottom: `${domain > 0 ? Math.min(100, (row.apiCostUsd / domain) * 100) : 0}%`,
        backgroundColor: color,
        opacity: faint ? 0.35 : 1
      }}
    />
  )
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function SectionHead({ title, note }: { title: string; note: string }): React.JSX.Element {
  return (
    <div className="flex items-baseline gap-2 mb-1">
      <h4 className="text-[10px] font-semibold text-text-secondary">{title}</h4>
      <span className="text-[9px] text-text-muted">{note}</span>
    </div>
  )
}

/** ADR-071 §7's bias, said once for the whole card. */
function Footnote(): React.JSX.Element {
  return (
    <p data-testid="WindowValue.footnote" className="text-[9px] text-text-muted leading-relaxed">
      Every figure here reads low. The percent is the account&apos;s GLOBAL utilization — every
      machine, and the vendor&apos;s own web app — while the dollars are only the turns this machine
      recorded, so whatever the account was used elsewhere raised the percent without adding
      dollars. Summing the dollars across machines will close that half; usage inside a
      vendor&apos;s web app stays invisible.
    </p>
  )
}

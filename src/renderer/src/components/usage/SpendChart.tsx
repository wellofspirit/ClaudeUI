/**
 * Spend over time (ADR-071 §8 item 5, mockup `140549af` Spend over time A / B).
 *
 * Replaces `DailyUsageChart`, which drew TOKENS per day from the Claude-shaped
 * `dailyHistory`. The question this screen answers is what the work cost, so
 * the value here is `displayCostUsd` — the ledger's headline rule — and the
 * series are the dashboard's providers rather than Claude's models. A tokens
 * toggle is deliberately out of scope (S4b's "Out of scope").
 *
 * TWO VARIANTS, BECAUSE ONE SCALE CANNOT SHOW BOTH. Stacked columns (A) answer
 * "what did each day cost, and who spent it" — the total is the bar. But the
 * owner's providers differ by roughly 30×, and on a shared scale the small ones
 * are a hairline. Variant B gives each provider its own baseline and its own
 * scale, which shows a $1/day provider's rhythm at the cost of the total. The
 * toggle is owned here: nothing outside this widget reads the mode.
 *
 * WHAT IT CAN AND CANNOT SPLIT BY. `days[].byProvider` is the only per-day
 * split the dashboard query carries, so the columns stack by PROVIDER whatever
 * the header's group-by says, and the subtitle says so when they disagree.
 * Inventing a per-day per-model series by spreading an account's range total
 * over its days would be a chart of an assumption, not of the ledger.
 *
 * TWO GRAINS (S4d). The `today` range carries an `hours` series as well, and a
 * day of hours is the chart the range exists for — a single daily column says
 * nothing about when the day was spent. Everything below therefore draws
 * `Column`s rather than days: the grain decides the key, the x label and the
 * tooltip heading, and nothing else in the geometry changes.
 *
 * TWO MACHINES INSIDE ONE SEGMENT (S5c). Under the combined scope each
 * provider's segment is drawn twice: its local part solid and the rest HATCHED
 * in the same colour, from `byProviderRemote`, which is a SUBSET of the segment
 * rather than an addition — so a column still totals `byProvider`, the axis
 * never moves, and every equality the card had is untouched. The tooltip then
 * lists both halves, and they add up to the line the provider had before. A
 * third mode drops the provider stack and splits every column by MACHINE, from
 * the second per-cell split the query carries for exactly that: the question
 * there is not what the money went on but where it came from.
 */

import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { DashboardDay, DashboardMachine, UsageDashboardData } from '../../../../shared/types'
import type { DashboardGroupBy } from './UsageView'
import { providerLabel } from '../../../../shared/provider-label'
import {
  PROVIDER_OVERFLOW_COLOR,
  buildSeriesColorMap,
  formatCost,
  formatHourLabel,
  formatShortDate
} from './usage-utils'

// ---------------------------------------------------------------------------
// Geometry (the mockup's, which is what "130px tall, bars capped at 14px" means)
// ---------------------------------------------------------------------------

/** The plot's total height, labels included — the owner's pick. */
const PLOT_HEIGHT = 130
const PAD_T = 6
const PAD_B = 16
const CHART_H = PLOT_HEIGHT - PAD_T - PAD_B
/** The baseline: no mark may be drawn below it. */
const PLOT_BOTTOM = PAD_T + CHART_H

/** The y-axis lives in its own SVG so the plot can scroll under a fixed scale. */
const AXIS_WIDTH = 44

const MAX_BAR_WIDTH = 14
/** Surface between adjacent columns; the bar takes the rest of its slot. */
const BAR_GAP = 3
/**
 * The narrowest a day may get before the chart starts scrolling instead. At 8px
 * a 90-day range is about 720px wide, which is the mockup's "90 still fit" on a
 * normal window and a scroll on a narrow one.
 */
const MIN_SLOT = 8
/** Used until the ResizeObserver reports, and in jsdom, which has none. */
const FALLBACK_VIEWPORT = 600

/** The 2px surface gap dataviz wants between stacked fills. */
const SEGMENT_GAP = 2
/** A day that spent something is never drawn as nothing (ADR-030 in geometry). */
const MIN_SEGMENT_H = 1

/** Roughly what a `Sep 20` or `09:00` label occupies at 8px, so ticks never collide. */
const MIN_LABEL_PX = 46

/** Variant B's rows: small, because there is one per provider. */
const ROW_HEIGHT = 34

export type SpendChartMode = 'stacked' | 'perProvider' | 'machine'

interface SpendChartProps {
  data: UsageDashboardData
  /** Provider id → its fixed colour, built once by the shell. */
  providerColors: Map<string, string>
  /** Only to explain the stacking when it is not what the header asked for. */
  groupBy: DashboardGroupBy
}

// ---------------------------------------------------------------------------
// Columns — the two grains, flattened to one shape
// ---------------------------------------------------------------------------

/** Which series the dashboard handed us. `today` brings hours; every range has days. */
type Granularity = 'daily' | 'hourly'

interface Column {
  /** React key, and the identity the hover index is resolved against. */
  key: string
  byProvider: DashboardDay['byProvider']
  /** The other machines' part of {@link byProvider} — empty under `local`. */
  byProviderRemote: DashboardDay['byProvider']
  /** The same slot split by device instead — empty under `local`. */
  byMachine: DashboardDay['byProvider']
  /** The x-axis tick under the column. */
  label: string
  /** The tooltip's heading, and variant B's `<title>` — the full slot, not the tick. */
  heading: string
  /** Set on a daily column only — the mark's identity, and the test hook. */
  date?: string
  /** Set on an hourly column only, for the same two jobs. */
  hourUtc?: number
}

/**
 * The columns to draw: the hourly series when the query sent one, the daily one
 * otherwise. `hours` is present only for `today`, so the presence of the field
 * IS the grain — the range token is never re-interpreted here.
 */
function buildColumns(data: UsageDashboardData): { columns: Column[]; granularity: Granularity } {
  if (data.hours) {
    return {
      granularity: 'hourly',
      columns: data.hours.map((hour) => {
        const label = formatHourLabel(hour.hourUtc)
        return {
          key: String(hour.hourUtc),
          byProvider: hour.byProvider,
          byProviderRemote: hour.byProviderRemote ?? {},
          byMachine: hour.byMachine ?? {},
          label,
          // The whole slot, so the reader is never left wondering whether
          // `09:00` means the instant or the hour that follows it.
          heading: `${label} – ${label.slice(0, 3)}59`,
          hourUtc: hour.hourUtc
        }
      })
    }
  }
  return {
    granularity: 'daily',
    columns: data.days.map((day) => ({
      key: day.date,
      byProvider: day.byProvider,
      byProviderRemote: day.byProviderRemote ?? {},
      byMachine: day.byMachine ?? {},
      label: formatShortDate(day.date),
      heading: formatShortDate(day.date),
      date: day.date
    }))
  }
}

// ---------------------------------------------------------------------------
// Scales
// ---------------------------------------------------------------------------

/**
 * A round step, so the axis reads `$0 / $5 / $10 / $15` rather than `$4.87`.
 * Three steps cover the data, which gives the four ticks the spec asks for.
 */
function niceStep(raw: number): number {
  if (!(raw > 0)) return 1
  const exponent = 10 ** Math.floor(Math.log10(raw))
  const f = raw / exponent
  const step = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10
  return step * exponent
}

/** The axis maximum and its ticks — `[0, step, 2·step, 3·step]`. */
function axisScale(maxValue: number): { max: number; ticks: number[] } {
  const step = niceStep(maxValue / 3)
  const max = step * 3
  return { max, ticks: [0, step, step * 2, max] }
}

/** Whole dollars once the steps are dollars; cents while they are cents. */
function formatAxisCost(usd: number, step: number): string {
  return step >= 1 ? `$${usd.toFixed(0)}` : `$${usd.toFixed(2)}`
}

// ---------------------------------------------------------------------------
// Series
// ---------------------------------------------------------------------------

interface Series {
  providerId: string
  label: string
  color: string
  /** The provider's display cost over the whole range, for variant B's row. */
  totalUsd: number
}

/**
 * The providers to stack, in the dashboard query's order (display cost
 * descending). A provider that only appears in `byProvider` — impossible from
 * the current query, but the series and the tree are built separately — is
 * appended rather than dropped, so a column always sums to its own total.
 *
 * The row totals come from the COLUMNS on screen, not from the provider tree:
 * on `today` the two agree, but variant B's per-row figure has to be the sum of
 * the bars beside it whatever grain is drawn.
 */
function buildSeries(
  data: UsageDashboardData,
  columns: Column[],
  providerColors: Map<string, string>
): Series[] {
  const totals = new Map<string, number>()
  for (const provider of data.providers) totals.set(provider.providerId, 0)
  for (const column of columns) {
    for (const [id, costs] of Object.entries(column.byProvider)) {
      totals.set(id, (totals.get(id) ?? 0) + costs.displayCostUsd)
    }
  }
  const ordered = [
    ...data.providers.map((p) => p.providerId),
    ...[...totals.keys()].filter((id) => !data.providers.some((p) => p.providerId === id))
  ]
  const labels = new Map(data.providers.map((p) => [p.providerId, p.label]))
  return ordered.map((providerId) => ({
    providerId,
    label: labels.get(providerId) ?? providerLabel(providerId),
    color: providerColors.get(providerId) ?? PROVIDER_OVERFLOW_COLOR,
    totalUsd: totals.get(providerId) ?? 0
  }))
}

function columnTotal(column: Column): number {
  let sum = 0
  for (const costs of Object.values(column.byProvider)) sum += costs.displayCostUsd
  return sum
}

/**
 * The part of one provider's segment that came from another machine, clamped to
 * the segment. The clamp is the invariant, not a guess: the remote split is a
 * SUBSET of the column, and a pull that ever landed otherwise must not be able
 * to draw a hatch taller than the bar it qualifies.
 */
function remoteOf(column: Column, providerId: string, usd: number): number {
  return Math.min(usd, column.byProviderRemote[providerId]?.displayCostUsd ?? 0)
}

/**
 * A figure at the precision `formatCost` will PRINT it at — cents above a cent,
 * four places below one.
 */
function toPrintedPrecision(usd: number): number {
  return usd >= 0.01 ? Math.round(usd * 100) / 100 : Math.round(usd * 10_000) / 10_000
}

/**
 * The column's total as the SUM OF THE LINES ABOVE IT, not as the sum of the
 * unrounded dollars.
 *
 * The ledger keeps cost to full precision, so `$364.3249 + $0.7451` is a true
 * `$365.07` that prints beside `$364.32` and `$0.75` — two numbers a reader can
 * add in their head to something else. A tooltip whose own arithmetic looks
 * wrong costs more trust than the tenth of a cent it is protecting, so the
 * total is rounded the way its parts are before being added. Every figure on
 * screen then agrees; the exact sum still drives the bar heights and the axis.
 */
function displayedColumnTotal(column: Column): number {
  let sum = 0
  for (const costs of Object.values(column.byProvider)) {
    if (costs.displayCostUsd > 0) sum += toPrintedPrecision(costs.displayCostUsd)
  }
  return sum
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export function SpendChart({ data, providerColors, groupBy }: SpendChartProps): React.JSX.Element {
  const [mode, setMode] = useState<SpendChartMode>('stacked')
  const combined = data.scope === 'all'
  const { columns, granularity } = useMemo(() => buildColumns(data), [data])
  const series = useMemo(
    () => buildSeries(data, columns, providerColors),
    [data, columns, providerColors]
  )
  const grandTotal = useMemo(
    () => columns.reduce((sum, column) => sum + columnTotal(column), 0),
    [columns]
  )
  // The chosen mode survives a scope change only while its rows still exist:
  // dropping back to `local` with `per machine` selected would draw one row and
  // call it a comparison. The selection is KEPT, so switching back restores it.
  const activeMode: SpendChartMode = !combined && mode === 'machine' ? 'stacked' : mode

  return (
    <div
      data-testid="SpendChart"
      data-mode={activeMode}
      className="bg-bg-secondary rounded-xl border border-border/50 p-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
        <div className="flex items-baseline gap-2">
          <h3 className="text-[11px] font-semibold text-text-secondary uppercase tracking-wider">
            Spend over time
          </h3>
          <span data-testid="SpendChart.granularity" className="text-[9px] text-text-muted">
            {granularity} · {data.range}
          </span>
        </div>
        <ModeToggle mode={activeMode} onChange={setMode} combined={combined} />
      </div>

      {/* The subtitle explains a PROVIDER stack that is not what the header
          asked for. Under `per machine` the chart is not stacked by provider at
          all, so the sentence would be wrong about both halves — and outright
          absurd when the group-by it claims cannot be drawn IS `machine`. The
          mode's own tooltip and `machineRowsNote` carry that variant's caveats. */}
      {groupBy !== 'provider' && activeMode !== 'machine' && (
        <p data-testid="SpendChart.subtitle" className="text-[9px] text-text-muted mb-2">
          Stacked by provider: the {granularity} series is the only split the ledger keeps per{' '}
          {granularity === 'hourly' ? 'hour' : 'day'}, so it cannot be broken down by {groupBy}. The
          breakdown below groups by {groupBy} in full.
        </p>
      )}

      {columns.length === 0 || grandTotal <= 0 ? (
        <div
          data-testid="SpendChart.empty"
          className="flex items-center justify-center text-text-muted text-[11px] py-8"
        >
          Nothing spent in this range
        </div>
      ) : activeMode === 'stacked' ? (
        <StackedColumns columns={columns} series={series} combined={combined} />
      ) : activeMode === 'machine' ? (
        <PerMachineRows columns={columns} machines={data.machines} />
      ) : (
        <PerProviderRows columns={columns} series={series} />
      )}
    </div>
  )
}

function ModeToggle({
  mode,
  onChange,
  combined
}: {
  mode: SpendChartMode
  onChange: (next: SpendChartMode) => void
  /** The third mode is offered only when there is more than one machine. */
  combined: boolean
}): React.JSX.Element {
  const options: Array<{ id: SpendChartMode; label: string; title: string }> = [
    {
      id: 'stacked',
      label: 'stacked',
      title:
        'One column per slot, split by provider on a shared scale — the slot’s total is the bar.'
    },
    {
      id: 'perProvider',
      label: 'per provider',
      title:
        'One row per provider, each on its own scale — shows a small provider’s rhythm, but the rows are not comparable.'
    },
    ...(combined
      ? [
          {
            id: 'machine' as const,
            label: 'per machine',
            title:
              'One row per machine, each on its own scale — when a machine started or stopped contributing.'
          }
        ]
      : [])
  ]
  return (
    <div
      data-testid="SpendChart.mode"
      data-value={mode}
      className="flex items-center gap-0.5 bg-bg-tertiary border border-border/50 rounded-md p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.id}
          data-testid={`SpendChart.mode.${option.id}`}
          data-active={option.id === mode}
          aria-pressed={option.id === mode}
          title={option.title}
          onClick={() => onChange(option.id)}
          className={`[-webkit-app-region:no-drag] text-[10px] px-2 py-0.5 rounded transition-colors cursor-default ${
            option.id === mode
              ? 'bg-bg-hover text-text-primary'
              : 'text-text-muted hover:text-text-secondary'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Variant A — stacked columns
// ---------------------------------------------------------------------------

/**
 * Whether the plot should jump back to the latest column, or leave the reader's
 * scroll position where they put it.
 *
 * A DIFFERENT NUMBER OF COLUMNS IS A DIFFERENT CHART, so it is always
 * re-pinned. The "did the reader scroll back" guard cannot answer for it:
 * going 30d → 90d runs the effect against a `scrollLeft` measured on the
 * PREVIOUS render, and a 30-day chart that fitted its viewport had
 * `scrollLeft 0` with nothing to scroll. The guard read that stale zero as "parked at the far left on
 * purpose" and left the newest 60 days off-screen.
 *
 * The guard is for the other dependency — a resize, which does not change what
 * is being shown. There, someone who has scrolled back to March keeps their
 * place while someone parked at the right edge stays pinned to it.
 *
 * Exported for its own test: jsdom reports every layout figure as 0, so the
 * decision is testable only as a function of the numbers, not through a render.
 */
export function shouldPinToLatest({
  hasPinned,
  columnCountChanged,
  distanceFromEnd,
  threshold
}: {
  /** False on the very first pass for this mount. */
  hasPinned: boolean
  /** The range moved, or a column was added to it. */
  columnCountChanged: boolean
  /** Pixels between the current viewport's right edge and the plot's. */
  distanceFromEnd: number
  /** How close counts as "at the end" — two columns' worth of slot. */
  threshold: number
}): boolean {
  if (!hasPinned) return true
  if (columnCountChanged) return true
  return distanceFromEnd <= threshold
}

function StackedColumns({
  columns,
  series,
  combined
}: {
  columns: Column[]
  series: Series[]
  combined: boolean
}): React.JSX.Element {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const [viewportWidth, setViewportWidth] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const hasAutoScrolled = useRef(false)
  const lastColumnCount = useRef<number | null>(null)

  useLayoutEffect(() => {
    const scroll = scrollRef.current
    if (!scroll || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setViewportWidth(entry.contentRect.width))
    observer.observe(scroll)
    return () => observer.disconnect()
  }, [])

  // The latest column is the one a person opens this for, so a range that does
  // not fit starts at its right edge — see `shouldPinToLatest` for when it is
  // re-pinned and when the reader's own scroll position is left alone.
  useLayoutEffect(() => {
    const scroll = scrollRef.current
    if (!scroll) return
    const columnCountChanged =
      lastColumnCount.current !== null && lastColumnCount.current !== columns.length
    lastColumnCount.current = columns.length
    if (
      shouldPinToLatest({
        hasPinned: hasAutoScrolled.current,
        columnCountChanged,
        distanceFromEnd: scroll.scrollWidth - scroll.clientWidth - scroll.scrollLeft,
        threshold: (scroll.clientWidth / Math.max(1, columns.length)) * 2
      })
    ) {
      scroll.scrollLeft = scroll.scrollWidth
    }
    hasAutoScrolled.current = true
  }, [columns.length, viewportWidth])

  const columnCount = columns.length
  const slot = Math.max(MIN_SLOT, (viewportWidth || FALLBACK_VIEWPORT) / columnCount)
  const plotWidth = slot * columnCount
  const barWidth = Math.min(MAX_BAR_WIDTH, Math.max(2, slot - BAR_GAP))

  const maxColumn = columns.reduce((m, c) => Math.max(m, columnTotal(c)), 0)
  const { max: axisMax, ticks } = axisScale(maxColumn)
  const yOf = (value: number): number => PAD_T + CHART_H - (value / axisMax) * CHART_H
  const labelEvery = Math.max(1, Math.ceil(MIN_LABEL_PX / slot))
  const lastIdx = columnCount - 1
  const hovered = hoverIdx === null ? null : columns[hoverIdx]

  return (
    <div className="relative">
      {/* One <pattern> per series, referenced by every hatched segment. A fill
          pattern cannot be written as a per-rect style, and a <pattern> inside
          each column would be ninety of them on a ninety-day range. */}
      {combined && (
        <svg width={0} height={0} className="absolute" aria-hidden="true">
          <defs>
            {series.map((s) => (
              <pattern
                key={s.providerId}
                id={hatchPatternId(s.providerId)}
                width={6}
                height={6}
                patternTransform="rotate(45)"
                patternUnits="userSpaceOnUse"
              >
                <rect width={3} height={6} fill={s.color} />
              </pattern>
            ))}
          </defs>
        </svg>
      )}
      <div className="flex items-start">
        <svg
          data-testid="SpendChart.axis"
          viewBox={`0 0 ${AXIS_WIDTH} ${PLOT_HEIGHT}`}
          className="block shrink-0"
          style={{ width: AXIS_WIDTH, height: PLOT_HEIGHT }}
          aria-hidden="true"
        >
          {ticks.map((tick) => (
            <text
              key={tick}
              x={AXIS_WIDTH - 4}
              y={yOf(tick)}
              textAnchor="end"
              dominantBaseline="middle"
              className="fill-text-muted"
              fontSize={9}
            >
              {formatAxisCost(tick, ticks[1])}
            </text>
          ))}
        </svg>

        <div
          ref={scrollRef}
          data-testid="SpendChart.scroll"
          className="min-w-0 flex-1 overflow-x-auto"
        >
          <svg
            viewBox={`0 0 ${plotWidth} ${PLOT_HEIGHT}`}
            className="block max-w-none"
            style={{ width: plotWidth, height: PLOT_HEIGHT }}
            onMouseLeave={() => setHoverIdx(null)}
          >
            {/* Recessive hairline grid, one line per tick. */}
            {ticks.map((tick) => (
              <line
                key={tick}
                x1={0}
                y1={yOf(tick)}
                x2={plotWidth}
                y2={yOf(tick)}
                stroke="currentColor"
                strokeWidth={0.5}
                className="text-border/60"
              />
            ))}

            {columns.map((column, i) => {
              const x = i * slot + (slot - barWidth) / 2
              const isHovered = hoverIdx === i
              // Stacked from the baseline in the series' fixed order, so a
              // provider is always in the same layer of every column.
              let cumulative = 0
              const drawn = series
                .map((s) => {
                  const usd = column.byProvider[s.providerId]?.displayCostUsd ?? 0
                  if (usd <= 0) return null
                  const trueH = (usd / axisMax) * CHART_H
                  const top = yOf(cumulative + usd)
                  cumulative += usd
                  // The gap is taken off the BOTTOM, so a segment's top stays
                  // exact and the topmost one still reads as the day's total.
                  // A value too small to draw is floored to a visible pixel
                  // (ADR-030 in geometry), and the floor is then pushed UP off
                  // the baseline rather than allowed to hang below the axis.
                  const height = Math.max(MIN_SEGMENT_H, trueH - SEGMENT_GAP)
                  // The remote part is drawn over the TOP of the same segment
                  // rather than beside or above it: it is a subset, so it moves
                  // neither the segment's height nor the column's total.
                  const remote = combined ? remoteOf(column, s.providerId, usd) : 0
                  return {
                    s,
                    top: Math.min(top, PLOT_BOTTOM - height),
                    height,
                    remoteH: Math.min(height, (remote / usd) * height)
                  }
                })
                .filter((seg): seg is NonNullable<typeof seg> => seg !== null)

              return (
                <g
                  key={column.key}
                  data-testid="SpendChart.column"
                  data-date={column.date}
                  data-hour={column.hourUtc}
                  onMouseEnter={() => setHoverIdx(i)}
                  className="cursor-default"
                >
                  {/* Hit target is the whole slot, which is wider than the bar. */}
                  <rect x={i * slot} y={PAD_T} width={slot} height={CHART_H} fill="transparent" />
                  {drawn.map((seg, j) => (
                    <g key={seg.s.providerId}>
                      <rect
                        data-testid="SpendChart.segment"
                        data-provider-id={seg.s.providerId}
                        x={x}
                        y={seg.top}
                        width={barWidth}
                        height={seg.height}
                        rx={j === drawn.length - 1 ? 2 : 0}
                        fill={seg.s.color}
                        fillOpacity={isHovered ? 1 : 0.85}
                        className="transition-opacity duration-100"
                      />
                      {seg.remoteH > 0 && (
                        <rect
                          data-testid="SpendChart.segment.remote"
                          data-provider-id={seg.s.providerId}
                          x={x}
                          y={seg.top}
                          width={barWidth}
                          height={seg.remoteH}
                          rx={j === drawn.length - 1 ? 2 : 0}
                          fill={`url(#${hatchPatternId(seg.s.providerId)})`}
                        />
                      )}
                    </g>
                  ))}
                </g>
              )
            })}

            {/* Ticks anchored on the LATEST column, so the one that matters is
                always labelled and the spacing never collides. */}
            {columns.map((column, i) =>
              (lastIdx - i) % labelEvery === 0 ? (
                <text
                  key={column.key}
                  x={i * slot + slot / 2}
                  y={PLOT_HEIGHT - 4}
                  textAnchor="middle"
                  className="fill-text-muted"
                  fontSize={8}
                >
                  {column.label}
                </text>
              ) : null
            )}
          </svg>
        </div>
      </div>

      {hovered && (
        <div
          data-testid="SpendChart.tooltip"
          className="absolute top-0 right-0 bg-bg-tertiary border border-border rounded-md px-2 py-1.5 text-[10px] space-y-0.5 pointer-events-none z-10 min-w-[150px]"
        >
          <div className="text-text-secondary font-medium">{hovered.heading}</div>
          {series.map((s) => {
            const usd = hovered.byProvider[s.providerId]?.displayCostUsd ?? 0
            if (usd <= 0) return null
            const remote = combined ? remoteOf(hovered, s.providerId, usd) : 0
            // Two lines only when there IS a remote part. A column this machine
            // alone spent on would otherwise trade its plain provider name for
            // a `$0.00` second line that says nothing.
            if (remote <= 0) {
              return (
                <div key={s.providerId} className="flex items-center gap-1.5">
                  <i
                    className="inline-block w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: s.color }}
                  />
                  <span className="text-text-muted flex-1">{s.label}</span>
                  <span className="text-text-primary font-mono">{formatCost(usd)}</span>
                </div>
              )
            }
            return (
              <div key={s.providerId}>
                <div data-testid="SpendChart.tooltip.local" className="flex items-center gap-1.5">
                  <i
                    className="inline-block w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: s.color }}
                  />
                  <span className="text-text-muted flex-1">{s.label} · this machine</span>
                  <span className="text-text-primary font-mono">{formatCost(usd - remote)}</span>
                </div>
                <div data-testid="SpendChart.tooltip.remote" className="flex items-center gap-1.5">
                  <i
                    className="inline-block w-2 h-2 rounded-sm shrink-0"
                    style={hatchSwatch(s.color)}
                  />
                  <span className="text-text-muted flex-1">{s.label} · other machines</span>
                  <span className="text-text-primary font-mono">{formatCost(remote)}</span>
                </div>
              </div>
            )
          })}
          <div className="flex items-center gap-3 border-t border-border/30 mt-1 pt-1">
            <span className="text-text-muted flex-1">Total</span>
            <span className="text-text-primary font-mono">
              {formatCost(displayedColumnTotal(hovered))}
            </span>
          </div>
        </div>
      )}

      <Legend series={series} />
    </div>
  )
}

/**
 * The `<pattern>` id for one series. Sanitised, because a provider id is a free
 * string and an SVG id carrying whitespace or a `#` breaks the `url(#…)` that
 * references it.
 */
function hatchPatternId(providerId: string): string {
  // Every character that is not alphanumeric becomes `-<hex>-`, and `-` is
  // itself escaped that way, so the encoding is INJECTIVE: a collapse-to-`_`
  // scheme would have given `a.b` and `a_b` one pattern, and one of the two
  // providers would have been hatched in the other's colour.
  const safe = providerId.replace(
    /[^a-zA-Z0-9]/g,
    (c) => `-${c.codePointAt(0)?.toString(16) ?? 'x'}-`
  )
  return `spendchart-hatch-${safe}`
}

/** The legend and tooltip swatch for a hatched mark — a gradient, not a pattern. */
function hatchSwatch(color: string): React.CSSProperties {
  return {
    backgroundImage: `repeating-linear-gradient(135deg, ${color} 0 3px, transparent 3px 6px)`
  }
}

/**
 * Identity is never colour alone: every series has a named swatch here, and the
 * tooltip repeats the name beside its figure.
 */
function Legend({ series }: { series: Series[] }): React.JSX.Element {
  return (
    <div
      data-testid="SpendChart.legend"
      className="flex flex-wrap items-center gap-3 mt-1.5 px-1 text-[9px] text-text-muted"
    >
      {series.map((s) => (
        <span
          key={s.providerId}
          data-provider-id={s.providerId}
          className="flex items-center gap-1"
        >
          <i className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: s.color }} />
          {s.label}
        </span>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Variant C — one row per machine (S5c)
// ---------------------------------------------------------------------------

/**
 * One row per machine, on variant B's geometry and for variant B's reason: the
 * machines differ by orders of magnitude, and on a shared scale the small one is
 * a hairline.
 *
 * It reads `byMachine`, the query's second per-slot split, rather than
 * apportioning each machine's RANGE total across the slots — which would have
 * been a chart of an assumption, the same trap the provider stack avoids by
 * refusing to split a day by model.
 *
 * Rows follow the machine list's order (this machine, then peers by spend,
 * retired last), so the card below reads in the same order as the chart. A
 * machine that spent nothing in the range is dropped: an empty baseline is
 * indistinguishable from a row whose data failed to load, and the footnote
 * counts it instead.
 */
function PerMachineRows({
  columns,
  machines
}: {
  columns: Column[]
  machines: ReadonlyArray<DashboardMachine>
}): React.JSX.Element {
  const width = Math.max(columns.length * MIN_SLOT, FALLBACK_VIEWPORT)
  const slot = width / columns.length
  const barWidth = Math.min(MAX_BAR_WIDTH, Math.max(2, slot - BAR_GAP))
  // A machine has no cross-profile identity, so it takes a palette slot by
  // sorted id exactly as an engine or a model row does.
  const colors = buildSeriesColorMap(machines.map((m) => m.deviceId))

  const drawn = machines
    .map((machine) => ({
      machine,
      values: columns.map((c) => c.byMachine[machine.deviceId]?.displayCostUsd ?? 0)
    }))
    .filter((row) => row.values.some((v) => v > 0))
  const hidden = machines.length - drawn.length

  return (
    <div>
      {drawn.map(({ machine, values }) => {
        const rowMax = values.reduce((m, v) => Math.max(m, v), 0)
        const color = colors.get(machine.deviceId) ?? PROVIDER_OVERFLOW_COLOR
        const label =
          machine.deviceName.trim() === '' ? machine.deviceId.slice(0, 8) : machine.deviceName
        return (
          <div
            key={machine.deviceId}
            data-testid="SpendChart.machineRow"
            data-device-id={machine.deviceId}
            data-self={machine.self ? 'true' : undefined}
            className="flex items-center gap-2.5 mb-1.5"
          >
            <div className="w-[110px] shrink-0">
              <div className="flex items-center gap-1.5 text-[10px] text-text-secondary truncate">
                <i
                  className="inline-block w-2 h-2 rounded-sm shrink-0"
                  style={machine.self ? { backgroundColor: color } : hatchSwatch(color)}
                />
                <span className="truncate" title={label}>
                  {label}
                </span>
              </div>
              <div
                data-testid="SpendChart.machineRow.total"
                className="font-mono text-[10px] text-text-primary"
              >
                {formatCost(values.reduce((sum, v) => sum + v, 0))}
              </div>
            </div>
            <svg
              viewBox={`0 0 ${width} ${ROW_HEIGHT}`}
              preserveAspectRatio="none"
              className="block flex-1 min-w-0"
              style={{ height: ROW_HEIGHT }}
            >
              <line
                x1={0}
                y1={ROW_HEIGHT - 0.5}
                x2={width}
                y2={ROW_HEIGHT - 0.5}
                stroke="currentColor"
                strokeWidth={0.5}
                className="text-border/60"
              />
              {values.map((usd, i) => {
                if (usd <= 0) return null
                const h = rowMax > 0 ? (usd / rowMax) * (ROW_HEIGHT - 3) : 0
                return (
                  <rect
                    key={columns[i].key}
                    data-testid="SpendChart.machineRow.bar"
                    data-date={columns[i].date}
                    data-hour={columns[i].hourUtc}
                    x={i * slot + (slot - barWidth) / 2}
                    y={ROW_HEIGHT - Math.max(MIN_SEGMENT_H, h)}
                    width={barWidth}
                    height={Math.max(MIN_SEGMENT_H, h)}
                    rx={2}
                    fill={color}
                    fillOpacity={machine.self ? 1 : 0.55}
                  >
                    <title>{`${label} · ${columns[i].heading} · ${formatCost(usd)}`}</title>
                  </rect>
                )
              })}
            </svg>
          </div>
        )
      })}
      <p
        data-testid="SpendChart.machineRowsNote"
        className="text-[9px] text-text-muted mt-1 ml-[120px]"
      >
        Each row has its own scale — heights are comparable within a row, never between rows.
        {hidden > 0 && ` · ${hidden} ${hidden === 1 ? 'machine' : 'machines'} with no spend hidden`}
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Variant B — one row per provider, independent scales
// ---------------------------------------------------------------------------

function PerProviderRows({
  columns,
  series
}: {
  columns: Column[]
  series: Series[]
}): React.JSX.Element {
  // Rows share ONE viewBox width so the same slot is the same x in every row,
  // even though the heights are not comparable. They scale to the container
  // rather than scrolling: a row is 34px tall and a horizontal scrollbar per
  // provider would be more chrome than chart.
  const width = Math.max(columns.length * MIN_SLOT, FALLBACK_VIEWPORT)
  const slot = width / columns.length
  const barWidth = Math.min(MAX_BAR_WIDTH, Math.max(2, slot - BAR_GAP))

  // A provider that spent nothing over the range has no scale of its own, so
  // its row is an empty baseline — visually identical to a provider whose data
  // failed to load. It is counted in the footnote instead. (The stacked variant
  // keeps them: there they cost a legend entry, not a whole empty row.)
  const drawn = series.filter((s) => s.totalUsd > 0)
  const hidden = series.length - drawn.length

  return (
    <div>
      {drawn.map((s) => {
        const values = columns.map((c) => c.byProvider[s.providerId]?.displayCostUsd ?? 0)
        const rowMax = values.reduce((m, v) => Math.max(m, v), 0)
        return (
          <div
            key={s.providerId}
            data-testid="SpendChart.row"
            data-provider-id={s.providerId}
            className="flex items-center gap-2.5 mb-1.5"
          >
            <div className="w-[110px] shrink-0">
              <div className="flex items-center gap-1.5 text-[10px] text-text-secondary truncate">
                <i
                  className="inline-block w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: s.color }}
                />
                <span className="truncate">{s.label}</span>
              </div>
              <div
                data-testid="SpendChart.row.total"
                className="font-mono text-[10px] text-text-primary"
              >
                {formatCost(s.totalUsd)}
              </div>
            </div>
            <svg
              viewBox={`0 0 ${width} ${ROW_HEIGHT}`}
              preserveAspectRatio="none"
              className="block flex-1 min-w-0"
              style={{ height: ROW_HEIGHT }}
            >
              <line
                x1={0}
                y1={ROW_HEIGHT - 0.5}
                x2={width}
                y2={ROW_HEIGHT - 0.5}
                stroke="currentColor"
                strokeWidth={0.5}
                className="text-border/60"
              />
              {values.map((usd, i) => {
                if (usd <= 0) return null
                const h = rowMax > 0 ? (usd / rowMax) * (ROW_HEIGHT - 3) : 0
                return (
                  <rect
                    key={columns[i].key}
                    data-testid="SpendChart.row.bar"
                    data-date={columns[i].date}
                    data-hour={columns[i].hourUtc}
                    x={i * slot + (slot - barWidth) / 2}
                    y={ROW_HEIGHT - Math.max(MIN_SEGMENT_H, h)}
                    width={barWidth}
                    height={Math.max(MIN_SEGMENT_H, h)}
                    rx={2}
                    fill={s.color}
                  >
                    <title>{`${s.label} · ${columns[i].heading} · ${formatCost(usd)}`}</title>
                  </rect>
                )
              })}
            </svg>
          </div>
        )
      })}
      <p data-testid="SpendChart.rowsNote" className="text-[9px] text-text-muted mt-1 ml-[120px]">
        Each row has its own scale — heights are comparable within a row, never between rows.
        {hidden > 0 &&
          ` · ${hidden} ${hidden === 1 ? 'provider' : 'providers'} with no spend hidden`}
      </p>
    </div>
  )
}

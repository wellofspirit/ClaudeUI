/**
 * Every limit window on one seven-day axis (ADR-071 §8, mockup `140549af`
 * Accounts D).
 *
 * `AccountsPanel` beside it says how full each window is; this says WHEN each
 * one comes back. With several subscriptions that is the question a person
 * actually has at 90% — not "how much is left here" but "what has headroom now,
 * and what returns first" — and it can only be read off a shared axis.
 *
 * Deliberately says nothing about spend. It pairs with the accounts panel
 * rather than replacing it.
 */

import type { AccountLimits } from '../../../../shared/types'
import { providerIdForBucket } from '../../../../shared/provider-label'
import {
  SEVERITY_FILL_CLASS,
  SEVERITY_ICON,
  formatReset,
  formatResetRelative,
  meterSeverity
} from './usage-utils'

/** The axis span. A weekly window is the longest one any vendor reports. */
const AXIS_DAYS = 7
const AXIS_MS = AXIS_DAYS * 86_400_000
/** Fixed so the overlay can place a marker by row index rather than measuring. */
const ROW_H = 22
const AXIS_H = 16

interface TimelineRow {
  accountKey: string
  accountLabel: string
  providerId: string
  kind: string
  kindLabel: string
  usedPercent: number
  resetsAt: string | null
  /** Milliseconds from now, or null when the vendor reported no reset. */
  resetInMs: number | null
}

function buildRows(limits: AccountLimits[], now: number): TimelineRow[] {
  const rows: TimelineRow[] = []
  for (const account of limits) {
    for (const w of account.windows) {
      const at = w.resetsAt ? Date.parse(w.resetsAt) : NaN
      rows.push({
        accountKey: account.accountKey,
        accountLabel: account.label,
        providerId: providerIdForBucket(account.accountKey, account.vendorId),
        kind: w.kind,
        kindLabel: w.label,
        usedPercent: Math.max(0, Math.min(100, Math.round(w.usedPercent))),
        resetsAt: w.resetsAt,
        resetInMs: Number.isFinite(at) ? Math.max(0, at - now) : null
      })
    }
  }
  // Soonest first: the axis exists to answer "which comes back next", and a
  // list ordered by account makes the reader do that scan themselves.
  return rows.sort((a, b) => (a.resetInMs ?? Infinity) - (b.resetInMs ?? Infinity))
}

export function ResetTimeline({
  limits,
  providerColors,
  now = Date.now()
}: {
  limits: AccountLimits[] | null
  providerColors: Map<string, string>
  /** Injectable so a test can pin the axis. */
  now?: number
}): React.JSX.Element {
  const rows = buildRows(limits ?? [], now)

  return (
    <div
      data-testid="ResetTimeline"
      className="bg-bg-secondary rounded-xl border border-border/50 overflow-hidden"
    >
      <div className="flex items-baseline gap-2 px-3 py-2 border-b border-border/50">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary">
          Resets
        </h3>
        <span className="text-[9px] text-text-muted">every window · next {AXIS_DAYS} days</span>
      </div>

      {rows.length === 0 ? (
        <div data-testid="ResetTimeline.empty" className="px-3 py-4 text-[11px] text-text-muted">
          {limits === null
            ? 'Reading limits…'
            : 'No account on this machine reports a rate window.'}
        </div>
      ) : (
        <div
          className="grid px-3 py-2 gap-x-2"
          style={{
            gridTemplateColumns: 'minmax(70px,1fr) 46px 96px minmax(120px,2fr)',
            gridAutoRows: `${ROW_H}px`
          }}
        >
          {rows.map((row) => (
            <RowCells key={`${row.accountKey}:${row.kind}`} row={row} />
          ))}
          <Axis rows={rows} providerColors={providerColors} now={now} />
        </div>
      )}
    </div>
  )
}

/** The three text columns of a row. The fourth column belongs to {@link Axis}. */
function RowCells({ row }: { row: TimelineRow }): React.JSX.Element {
  const severity = meterSeverity(row.usedPercent)
  return (
    <>
      <div
        className="flex items-center text-[10px] text-text-primary truncate"
        title={row.accountLabel}
      >
        {row.accountLabel}
      </div>
      <div className="flex items-center text-[9px] text-text-muted truncate">{row.kindLabel}</div>
      <div className="flex items-center gap-1.5">
        <div className="w-[48px] h-[6px] shrink-0 rounded-full bg-bg-tertiary overflow-hidden">
          <div
            className={`h-full rounded-full ${SEVERITY_FILL_CLASS[severity]}`}
            style={{ width: `${row.usedPercent}%` }}
          />
        </div>
        <span className="font-mono text-[10px] text-text-primary whitespace-nowrap">
          <span aria-hidden="true">{SEVERITY_ICON[severity]}</span> {row.usedPercent}%
        </span>
      </div>
    </>
  )
}

/**
 * The shared axis: one grid cell spanning every row's fourth column, with the
 * day gridlines, the now line and one marker per row drawn over it. Positioning
 * by row index against a fixed {@link ROW_H} keeps this free of measurement —
 * no layout effect, and correct on the first paint.
 */
function Axis({
  rows,
  providerColors,
  now
}: {
  rows: TimelineRow[]
  providerColors: Map<string, string>
  now: number
}): React.JSX.Element {
  const height = rows.length * ROW_H + AXIS_H
  // Spans one row PAST the last, so the grid reserves a row for the day labels
  // that hang below the markers.
  return (
    <div className="relative" style={{ gridColumn: 4, gridRow: `1 / ${rows.length + 2}`, height }}>
      {/* Inset on the right so a marker that lands on +7d is not half-clipped. */}
      <div className="absolute inset-y-0 left-0 right-[10px]">
        {Array.from({ length: AXIS_DAYS + 1 }, (_, d) => (
          <div
            key={d}
            className="absolute top-0 border-l border-border/40 text-[8px] text-text-muted"
            style={{ left: `${(d / AXIS_DAYS) * 100}%`, height: rows.length * ROW_H }}
          >
            <span
              className="absolute -translate-x-1/2 whitespace-nowrap"
              style={{ top: height - AXIS_H }}
            >
              {d === 0 ? 'now' : `+${d}d`}
            </span>
          </div>
        ))}

        {/* The now line sits on top of the first gridline so it reads as a mark
            rather than as part of the grid. */}
        <div
          data-testid="ResetTimeline.now"
          className="absolute left-0 top-0 w-px bg-accent"
          style={{ height: rows.length * ROW_H }}
        />

        {rows.map((row, i) => {
          if (row.resetInMs === null) {
            return (
              <span
                key={`${row.accountKey}:${row.kind}`}
                className="absolute text-[9px] text-text-muted -translate-y-1/2 pl-1.5"
                style={{ top: i * ROW_H + ROW_H / 2 }}
              >
                reset time not reported
              </span>
            )
          }
          const clamped = Math.min(row.resetInMs, AXIS_MS)
          const left = (clamped / AXIS_MS) * 100
          const color = providerColors.get(row.providerId)
          const reset = formatReset(row.kind, row.resetsAt, now)
          const relative = formatResetRelative(row.resetsAt, now)
          const tip = `${row.accountLabel} · ${row.kindLabel}\n${row.usedPercent}% used · resets ${reset}${relative === reset ? '' : ` (${relative})`}`
          return (
            <div
              key={`${row.accountKey}:${row.kind}`}
              className="absolute inset-x-0"
              style={{ top: i * ROW_H + ROW_H / 2 }}
            >
              {/* The run from now to the reset, so the wait has length. */}
              <div
                className="absolute h-[2px] -translate-y-1/2 rounded-full opacity-50"
                style={{ left: 0, width: `${left}%`, backgroundColor: color }}
              />
              <div
                data-testid="ResetTimeline.marker"
                data-account-key={row.accountKey}
                data-kind={row.kind}
                title={tip}
                className="absolute w-[9px] h-[9px] rounded-full -translate-x-1/2 -translate-y-1/2 ring-2 ring-bg-secondary"
                style={{ left: `${left}%`, backgroundColor: color }}
              />
              {/* The reset itself, beside its marker: the axis gives the shape,
                  this gives the fact. */}
              <span
                className="absolute text-[9px] text-text-muted -translate-y-1/2 whitespace-nowrap pl-2"
                style={{ left: `${left}%` }}
                title={tip}
              >
                {reset}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

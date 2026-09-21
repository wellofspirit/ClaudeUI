/**
 * The dashboard's headline (ADR-071 §8, mockup `140549af` Summary B / D).
 *
 * One hero figure — the API-EQUIVALENT of everything the ledger saw over the
 * range — with the bar underneath showing it splitting first into what a
 * subscription absorbed versus what a card was charged, then by provider. The
 * question the owner asks of this screen is "what did the work cost, and how
 * much of it did I already pay for", and B answers it in one glance.
 *
 * Below `useIsMobile()`'s breakpoint the card collapses to variant D, the
 * one-line strip: at phone width the hero plus two bars plus two legends is
 * most of a screen, and the strip carries the same four numbers.
 *
 * ADR-030 runs through both: an unpriced turn is never added as a zero, so the
 * count of turns MISSING from the hero is shown beside it rather than folded in.
 */

import type { UsageDashboardData } from '../../../../shared/types'
import { formatCost, rangeWords } from './usage-utils'

interface SummaryProps {
  data: UsageDashboardData
  /** Variant D — the caller decides, because it owns the breakpoint. */
  compact: boolean
  /** Provider id → its fixed colour, built once by the shell. */
  providerColors: Map<string, string>
}

/**
 * What the hero figure actually is. `displayCostUsd` is the owner's headline
 * rule, not one currency: a turn a plan absorbed contributes its API-equivalent
 * and a turn billed to a key contributes the charge, so calling the whole thing
 * "API-equivalent" would be wrong for half of it.
 */
const HERO_RULE =
  'What the work cost: the API-equivalent for turns a subscription covered, the actual charge for turns billed to a key.'

/**
 * How many plans absorbed part of this range — the accounts billed as a
 * subscription, counted across every provider. The summary says "covered by 4
 * plans" rather than "by 2 providers" because a provider can hold several
 * subscriptions and the plan is what has a limit and a price.
 */
function subscriptionPlanCount(providers: UsageDashboardData['providers']): number {
  let n = 0
  for (const p of providers) {
    for (const a of p.accounts) if (a.billingType === 'subscription') n += 1
  }
  return n
}

export function Summary({ data, compact, providerColors }: SummaryProps): React.JSX.Element {
  const { totals, coveredUsd, unattributedUsd, providers } = data
  const display = totals.displayCostUsd
  const billed = totals.billedCostUsd
  const coveredPct = display > 0 ? Math.round((coveredUsd / display) * 100) : 0
  const unpriced = totals.unknownApiCostCount
  const plans = subscriptionPlanCount(providers)

  const providerBar = (
    <ProviderBar providers={providers} total={display} providerColors={providerColors} />
  )

  if (compact) {
    return (
      <div
        data-testid="Summary"
        className="bg-bg-secondary rounded-xl border border-border/50 px-3 py-2"
      >
        <div
          data-testid="Summary.strip"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]"
        >
          <span className="text-[9px] uppercase tracking-wider text-text-muted">{data.range}</span>
          <span className="font-mono text-text-primary">
            <b data-testid="Summary.hero" title={HERO_RULE}>
              {formatCost(display)}
            </b>{' '}
            <span className="text-text-muted">equivalent</span>
          </span>
          {unpriced > 0 && <UnpricedBadge count={unpriced} />}
          <span className="text-text-muted">→</span>
          <span className="font-mono text-text-primary">
            <b>{formatCost(coveredUsd)}</b>{' '}
            <span className="text-text-muted">
              covered{plans > 0 && ` by ${plans} ${plans === 1 ? 'plan' : 'plans'}`}
            </span>
          </span>
          <span className="text-text-muted">+</span>
          <span className="font-mono text-text-primary">
            <b>{formatCost(billed)}</b> <span className="text-text-muted">billed</span>
          </span>
          <span className="flex-1 min-w-[120px]">{providerBar}</span>
        </div>
        {unattributedUsd > 0 && <UnattributedNote usd={unattributedUsd} />}
      </div>
    )
  }

  return (
    <div data-testid="Summary" className="bg-bg-secondary rounded-xl border border-border/50 p-3">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-text-muted">
            Spend · {rangeWords(data.range)}
          </div>
          <div className="flex items-baseline gap-2 mt-1">
            <div
              data-testid="Summary.hero"
              title={HERO_RULE}
              className="font-mono text-[30px] leading-none text-text-primary"
            >
              {formatCost(display)}
            </div>
            {unpriced > 0 && <UnpricedBadge count={unpriced} />}
          </div>
        </div>
        <div className="flex gap-7 items-end">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-text-muted">
              Covered by subscriptions
            </div>
            <div className="font-mono text-base text-text-primary">
              {formatCost(coveredUsd)}{' '}
              <span className="text-[10px] text-text-muted">{coveredPct}%</span>
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-text-muted">
              Actually billed
            </div>
            <div className="font-mono text-base text-text-primary">{formatCost(billed)}</div>
          </div>
        </div>
      </div>

      {/* Covered vs billed — the hero splitting into its parts, with a legend
          that names exactly the parts that were drawn. */}
      <CoverageBar hero={display} covered={coveredUsd} billed={billed} />

      {/* The same total, split by provider. */}
      <div className="mt-3">{providerBar}</div>
      <div className="flex flex-wrap items-center gap-3 mt-1.5 text-[9px] text-text-muted">
        {providers.map((p) => (
          <span key={p.providerId} className="flex items-center gap-1.5">
            <i
              className="inline-block w-2 h-2 rounded-full"
              style={{ backgroundColor: providerColors.get(p.providerId) }}
            />
            {p.label} <span className="font-mono">{formatCost(p.totals.displayCostUsd)}</span>
          </span>
        ))}
      </div>

      {unattributedUsd > 0 && <UnattributedNote usd={unattributedUsd} />}
    </div>
  )
}

/**
 * The turns the hero is MISSING, never the turns it counted as zero (ADR-030).
 * A model with no published price has no API-equivalent, and a dashboard that
 * quietly adds a `$0.00` for it reads as "this was free".
 */
function UnpricedBadge({ count }: { count: number }): React.JSX.Element {
  return (
    <span
      data-testid="Summary.unpriced"
      className="text-[10px] px-1.5 py-0.5 rounded bg-bg-tertiary text-text-secondary font-medium"
      title={`${count} ${count === 1 ? 'turn ran' : 'turns ran'} on a model with no known price — not included in the figure`}
    >
      +{count} unpriced
    </span>
  )
}

function UnattributedNote({ usd }: { usd: number }): React.JSX.Element {
  return (
    <p data-testid="Summary.unattributed" className="text-[9px] text-text-muted mt-2">
      {formatCost(usd)} of this predates account attribution and is listed below as Unattributed.
    </p>
  )
}

/**
 * How the hero splits: what a plan absorbed, what a card was charged, and the
 * remainder nothing can say either way.
 *
 * Every segment is a PERCENT OF THE HERO, never a share of the two figures'
 * own sum. Flex-growing by raw dollars made the bar a ratio between covered and
 * billed, so $0.39 covered under a $3,735 hero painted a third of the track —
 * a bar that says "most of this was covered" when almost none of it was.
 *
 * The third segment is the honest remainder (ADR-030): rows whose billing type
 * the ledger never captured are neither covered nor billed, and dropping them
 * would leave a bar that does not reach its own total.
 */
function CoverageBar({
  hero,
  covered,
  billed
}: {
  hero: number
  covered: number
  billed: number
}): React.JSX.Element {
  const unknown = Math.max(0, hero - covered - billed)
  const drawn = [
    { id: 'covered', usd: covered, className: 'bg-accent', label: 'Covered by a subscription' },
    { id: 'billed', usd: billed, className: 'bg-text-secondary', label: 'Billed to a card' },
    { id: 'unknown', usd: unknown, className: 'bg-bg-hover', label: 'Billing unknown' }
  ]
    .map((seg) => ({ ...seg, pct: hero > 0 ? (seg.usd / hero) * 100 : 0 }))
    .filter((seg) => seg.pct > 0)

  return (
    <>
      <div
        data-testid="Summary.coverageBar"
        className="flex gap-[2px] h-[10px] mt-3.5 rounded-sm bg-bg-tertiary overflow-hidden"
      >
        {drawn.map((seg) => (
          <div
            key={seg.id}
            data-segment={seg.id}
            className={`${seg.className} rounded-sm`}
            // A segment that exists must be visible; below about 0.2% of the
            // track it would round away to nothing.
            style={{ width: `${seg.pct}%`, minWidth: 2 }}
            title={`${seg.label} ${formatCost(seg.usd)} · ${Math.round(seg.pct)}%`}
          />
        ))}
      </div>
      {/* One entry per DRAWN segment. A legend naming a colour the bar does not
          contain sends the reader hunting for it. */}
      <div className="flex flex-wrap items-center gap-3 mt-1.5 text-[9px] text-text-muted">
        {drawn.map((seg) => (
          <span key={seg.id} data-legend={seg.id} className="flex items-center gap-1.5">
            <i className={`inline-block w-2 h-2 rounded-full ${seg.className}`} />
            {seg.label}
          </span>
        ))}
      </div>
    </>
  )
}

/**
 * The total split by provider, in the dashboard query's order (display cost
 * descending). Colour comes from the shell's fixed map, so the same provider is
 * the same colour on every widget and in every range.
 */
function ProviderBar({
  providers,
  total,
  providerColors
}: {
  providers: UsageDashboardData['providers']
  total: number
  providerColors: Map<string, string>
}): React.JSX.Element {
  return (
    <div
      data-testid="Summary.providerBar"
      className="flex gap-[2px] h-[10px] rounded-sm bg-bg-tertiary overflow-hidden"
    >
      {providers.map((p) => {
        const usd = p.totals.displayCostUsd
        const pct = total > 0 ? (usd / total) * 100 : 0
        const share = Math.round(pct)
        if (pct <= 0) return null
        return (
          <div
            key={p.providerId}
            data-provider-id={p.providerId}
            className="rounded-sm"
            style={{
              width: `${pct}%`,
              minWidth: 2,
              backgroundColor: providerColors.get(p.providerId)
            }}
            title={`${p.label} ${formatCost(usd)} · ${share}%`}
          />
        )
      })}
    </div>
  )
}

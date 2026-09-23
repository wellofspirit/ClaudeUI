/**
 * The breakdown (ADR-071 §8 item 6, mockup `140549af` Breakdown A).
 *
 * One tree table answers every "who spent it" question the header can ask: the
 * group-by pills reorder the hierarchy, each level carries its own subtotal,
 * and both costs sit beside the tokens that produced them. It is dense — it is
 * a table — but the alternatives (ranked bars, provider cards) each show one
 * level at a time and hide the accounts.
 *
 * IT REPLACES TWO SECTIONS. `OpencodeSection` was one engine's per-model table,
 * which the ledger now covers for every engine; `DelegatedUsageSection` was a
 * separate all-time read of `dispatched_usage`. The delegated INFORMATION is
 * not lost — S2c made a dispatched turn a ledger row and S4a reports it as the
 * `dispatched` sub-total of the row it is already inside, so it shows here as
 * the inline `↗ … dispatched` marker on whichever row (provider, account,
 * engine or model) the work actually ran under. That is strictly more than the
 * old section had: it is in range, it is attributed to an account, and it is
 * counted in every subtotal above it rather than sitting in its own table where
 * a reader could add it twice.
 *
 * ADR-030 runs down the cost columns: a turn nothing could price is never added
 * as `$0.00`. The count of those turns is shown beside the figure they are
 * missing from, at every level.
 *
 * ONE GROUPING READS A DIFFERENT LIST (S5c). `machine` cannot be folded out of
 * the provider tree: a bucket's device id survives into `machines`, not into the
 * accounts and models under a provider, and spreading a machine's range total
 * across the models it might have run would be a table of an assumption. So the
 * machine hierarchy reads `data.machines` — the same fold, sliced by device —
 * and every OTHER grouping still reads the provider tree unchanged, which is why
 * their subtotals continue to agree with each other and with the hero.
 */

import { useMemo, useState } from 'react'
import type { CostTotals, DashboardMachine, UsageDashboardData } from '../../../../shared/types'
import type { DashboardGroupBy } from './UsageView'
import { ENGINE_META } from '../../../../shared/engine-meta'
import {
  PROVIDER_OVERFLOW_COLOR,
  buildSeriesColorMap,
  formatBehind,
  formatCost,
  formatTokenCount,
  shortModelName
} from './usage-utils'

/**
 * Every numeric cell carries its own left gutter and a floor on its width.
 * Without them the table shrinks its columns until the figures touch — at
 * 800 px the real profile read `$3720.88—$3720.88` as one run of characters.
 * The cells refuse to shrink past this instead, and the `overflow-x-auto` box
 * around the table scrolls, which is the behaviour a dense table should have.
 */
const NUM_CELL = 'text-right font-mono whitespace-nowrap pl-3'
const NUM_HEAD = 'text-right font-medium whitespace-nowrap pb-1 pl-3'
const W_COST = 'min-w-[64px]'
const W_TOKENS = 'min-w-[96px]'

interface BreakdownTableProps {
  data: UsageDashboardData
  groupBy: DashboardGroupBy
  /** Provider id → its fixed colour, built once by the shell. */
  providerColors: Map<string, string>
}

// ---------------------------------------------------------------------------
// The flat facts the hierarchy is built from
// ---------------------------------------------------------------------------

/**
 * One (provider, account, engine, model) cell of the dashboard tree. Every
 * grouping below is a different way of folding this same list, which is why
 * the subtotals agree whichever pill is active.
 */
interface Leaf {
  providerId: string
  providerLabel: string
  accountKey: string
  accountLabel: string
  engineId: string
  modelId: string
  totals: CostTotals
  dispatched: CostTotals | null
  /** Set only on a machine leaf — the row its `machine` rung is drawn from. */
  machine?: DashboardMachine
}

function toLeaves(data: UsageDashboardData): Leaf[] {
  const leaves: Leaf[] = []
  for (const provider of data.providers) {
    for (const account of provider.accounts) {
      for (const model of account.models) {
        leaves.push({
          providerId: provider.providerId,
          providerLabel: provider.label,
          accountKey: account.accountKey,
          accountLabel: account.label,
          engineId: model.engineId,
          modelId: model.modelId,
          totals: model.totals,
          dispatched: model.dispatched
        })
      }
    }
  }
  return leaves
}

/**
 * The machine grouping's leaves: one per (machine, provider, account).
 *
 * A machine with no spend in the range contributes NO leaf and therefore no
 * root, deliberately: the machines card above is where "it synced and spent
 * nothing" is said, and an empty root here would be a tree row with nothing
 * under it. Labels come from the provider tree, which is the one place they are
 * resolved (limits → ledger → the key's own fallback).
 */
function toMachineLeaves(data: UsageDashboardData): Leaf[] {
  const providerLabels = new Map(data.providers.map((p) => [p.providerId, p.label]))
  const accountLabels = new Map(
    data.providers.flatMap((p) => p.accounts.map((a) => [a.accountKey, a.label] as const))
  )
  const leaves: Leaf[] = []
  for (const machine of data.machines) {
    for (const slice of machine.accounts) {
      leaves.push({
        providerId: slice.providerId,
        providerLabel: providerLabels.get(slice.providerId) ?? slice.providerId,
        accountKey: slice.accountKey,
        accountLabel: accountLabels.get(slice.accountKey) ?? slice.accountKey,
        // The buckets keep no per-machine engine or model split, and these two
        // rungs are never reached under this hierarchy.
        engineId: '',
        modelId: '',
        totals: slice.totals,
        dispatched: slice.dispatched,
        machine
      })
    }
  }
  return leaves
}

/** How long a machine may go without pushing before its row says so (ADR-072 §7). */
const BEHIND_MS = 24 * 60 * 60 * 1000

function engineLabel(engineId: string): string {
  // Engine ids in the ledger are free strings (a bucket written by a build that
  // knew an engine this one does not), so the registry is read defensively
  // rather than through `engineMeta`, which throws on an unknown id.
  const meta = (ENGINE_META as Record<string, { label: string } | undefined>)[engineId]
  return meta?.label ?? engineId
}

// ---------------------------------------------------------------------------
// Summing
// ---------------------------------------------------------------------------

function emptyTotals(): CostTotals {
  return {
    apiCostUsd: 0,
    billedCostUsd: 0,
    displayCostUsd: 0,
    unknownApiCostCount: 0,
    unknownBilledCostCount: 0,
    requestCount: 0,
    tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }
  }
}

function addTotals(acc: CostTotals, t: CostTotals): void {
  acc.apiCostUsd += t.apiCostUsd
  acc.billedCostUsd += t.billedCostUsd
  acc.displayCostUsd += t.displayCostUsd
  acc.unknownApiCostCount += t.unknownApiCostCount
  acc.unknownBilledCostCount += t.unknownBilledCostCount
  acc.requestCount += t.requestCount
  acc.tokens.input += t.tokens.input
  acc.tokens.output += t.tokens.output
  acc.tokens.cacheWrite += t.tokens.cacheWrite
  acc.tokens.cacheRead += t.tokens.cacheRead
}

// ---------------------------------------------------------------------------
// The hierarchy
// ---------------------------------------------------------------------------

/** One rung of the tree: what it groups on and what it is called. */
interface Level {
  /** The word for this rung in the first column's header. */
  name: string
  key: (leaf: Leaf) => string
  label: (leaf: Leaf) => string
}

const LEVEL: Record<DashboardGroupBy, Level> = {
  provider: { name: 'provider', key: (l) => l.providerId, label: (l) => l.providerLabel },
  account: { name: 'account', key: (l) => l.accountKey, label: (l) => l.accountLabel },
  engine: { name: 'engine', key: (l) => l.engineId, label: (l) => engineLabel(l.engineId) },
  model: { name: 'model', key: (l) => l.modelId, label: (l) => shortModelName(l.modelId) },
  machine: {
    name: 'machine',
    key: (l) => l.machine?.deviceId ?? '',
    label: (l) =>
      l.machine === undefined || l.machine.deviceName.trim() === ''
        ? (l.machine?.deviceId.slice(0, 8) ?? '')
        : l.machine.deviceName
  }
}

/**
 * Which rungs each pill produces. `provider` is the full tree; the others root
 * on their own dimension and keep one level of detail under it — two rungs is
 * what stays readable, and the pill the reader wants next is one click away.
 */
const HIERARCHY: Record<DashboardGroupBy, Level[]> = {
  provider: [LEVEL.provider, LEVEL.account, LEVEL.model],
  account: [LEVEL.account, LEVEL.model],
  engine: [LEVEL.engine, LEVEL.model],
  model: [LEVEL.model, LEVEL.account],
  // Three rungs, like `provider`: the question a reader brings to this pill is
  // "what did that machine spend it ON", and provider alone does not answer it.
  machine: [LEVEL.machine, LEVEL.provider, LEVEL.account]
}

interface Node {
  /** Unique within the rendered tree: the path from the root, not just the key. */
  path: string
  label: string
  depth: number
  /** Only the root rung carries a swatch; deeper rows are indented, not hued. */
  color: string | null
  totals: CostTotals
  /** The `dispatch`-origin part of {@link totals}, null when nothing was. */
  dispatched: CostTotals | null
  /** Set on a machine ROOT only — what the `remote` and `behind` tags read. */
  machine: DashboardMachine | null
  children: Node[]
}

function buildNodes(
  leaves: Leaf[],
  levels: Level[],
  depth: number,
  parentPath: string,
  colorOf: (leaf: Leaf) => string | null
): Node[] {
  const level = levels[depth]
  const groups = new Map<string, Leaf[]>()
  for (const leaf of leaves) {
    const key = level.key(leaf)
    const bucket = groups.get(key)
    if (bucket) bucket.push(leaf)
    else groups.set(key, [leaf])
  }

  const nodes: Node[] = []
  for (const [key, members] of groups) {
    const totals = emptyTotals()
    let dispatched: CostTotals | null = null
    for (const leaf of members) {
      addTotals(totals, leaf.totals)
      if (leaf.dispatched) {
        dispatched = dispatched ?? emptyTotals()
        addTotals(dispatched, leaf.dispatched)
      }
    }
    const path = `${parentPath}/${key}`
    nodes.push({
      path,
      label: level.label(members[0]),
      depth,
      color: depth === 0 ? colorOf(members[0]) : null,
      totals,
      dispatched,
      machine: depth === 0 ? (members[0].machine ?? null) : null,
      children:
        depth + 1 < levels.length ? buildNodes(members, levels, depth + 1, path, colorOf) : []
    })
  }

  // The dashboard query's own order — spend descending, the id breaking ties so
  // two rows worth the same amount do not swap places between renders.
  nodes.sort(
    (a, b) => b.totals.displayCostUsd - a.totals.displayCostUsd || a.path.localeCompare(b.path)
  )
  return nodes
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export function BreakdownTable({
  data,
  groupBy,
  providerColors
}: BreakdownTableProps): React.JSX.Element {
  // Keyed by the node path, which already carries the grouping, so switching a
  // pill and switching back finds the reader's tree as they left it.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({})

  const roots = useMemo(() => {
    const leaves = groupBy === 'machine' ? toMachineLeaves(data) : toLeaves(data)
    const levels = HIERARCHY[groupBy]
    // Provider and account rows wear the provider's pinned colour; engine, model
    // and machine rows have no cross-profile identity, so they take a slot from
    // the same palette instead (see `buildSeriesColorMap`).
    const seriesKey =
      groupBy === 'engine'
        ? (l: Leaf) => l.engineId
        : groupBy === 'model'
          ? (l: Leaf) => l.modelId
          : groupBy === 'machine'
            ? (l: Leaf) => l.machine?.deviceId ?? ''
            : null
    const seriesColors = seriesKey ? buildSeriesColorMap(leaves.map(seriesKey)) : null
    const colorOf = (leaf: Leaf): string =>
      seriesColors && seriesKey
        ? (seriesColors.get(seriesKey(leaf)) ?? PROVIDER_OVERFLOW_COLOR)
        : (providerColors.get(leaf.providerId) ?? PROVIDER_OVERFLOW_COLOR)
    return buildNodes(leaves, levels, 0, groupBy, colorOf)
  }, [data, groupBy, providerColors])

  const levels = HIERARCHY[groupBy]
  const grandTotal = data.totals.displayCostUsd

  // Roots open, everything under them closed: the top rung is the answer and
  // the rest is the evidence.
  const isExpanded = (node: Node): boolean => overrides[node.path] ?? node.depth === 0
  const toggle = (node: Node): void =>
    setOverrides((prev) => ({ ...prev, [node.path]: !(prev[node.path] ?? node.depth === 0) }))

  const visible: Node[] = []
  const walk = (nodes: Node[]): void => {
    for (const node of nodes) {
      visible.push(node)
      if (node.children.length > 0 && isExpanded(node)) walk(node.children)
    }
  }
  walk(roots)

  return (
    <div
      data-testid="BreakdownTable"
      data-group-by={groupBy}
      className="bg-bg-secondary rounded-xl border border-border/50 p-3"
    >
      <div className="flex items-baseline gap-2 mb-2">
        <h3 className="text-[11px] font-semibold text-text-secondary uppercase tracking-wider">
          Breakdown
        </h3>
        <span className="text-[9px] text-text-muted">
          {levels.map((l) => l.name).join(' → ')} · {data.range}
        </span>
      </div>

      {roots.length === 0 ? (
        <div data-testid="BreakdownTable.empty" className="text-[11px] text-text-muted py-4">
          Nothing in this range to break down.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[10px] border-collapse">
            <thead>
              <tr className="text-text-muted">
                <th className="text-left font-medium pb-1">
                  {levels.map((l) => l.name).join(' / ')}
                </th>
                <th className={`${NUM_HEAD} ${W_TOKENS}`}>Tokens in / out</th>
                <th className={`${NUM_HEAD} ${W_COST}`}>API</th>
                <th className={`${NUM_HEAD} ${W_COST}`}>Billed</th>
                <th className={`${NUM_HEAD} ${W_COST}`}>Cost</th>
                <th className={`${NUM_HEAD} w-[110px]`}>Share</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((node) => (
                <Row
                  key={node.path}
                  node={node}
                  expanded={isExpanded(node)}
                  onToggle={() => toggle(node)}
                  grandTotal={grandTotal}
                />
              ))}
            </tbody>
            <tfoot>
              <tr
                data-testid="BreakdownTable.total"
                className="text-text-primary border-t border-border/50"
              >
                <td className="py-1 font-medium">Total</td>
                <TokensCell totals={data.totals} />
                <td className={`${NUM_CELL} ${W_COST}`}>{formatCost(data.totals.apiCostUsd)}</td>
                <BilledCell usd={data.totals.billedCostUsd} />
                <td className={`${NUM_CELL} ${W_COST}`}>
                  {formatCost(data.totals.displayCostUsd)}
                  {data.totals.unknownApiCostCount > 0 && (
                    <UnpricedBadge count={data.totals.unknownApiCostCount} />
                  )}
                </td>
                <td className={`${NUM_CELL} pr-[34px]`}>100%</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function Row({
  node,
  expanded,
  onToggle,
  grandTotal
}: {
  node: Node
  expanded: boolean
  onToggle: () => void
  grandTotal: number
}): React.JSX.Element {
  const hasChildren = node.children.length > 0
  const root = node.depth === 0
  return (
    <tr
      data-testid="BreakdownTable.row"
      data-level={node.depth}
      data-key={node.path}
      data-expanded={hasChildren ? String(expanded) : undefined}
      className={root ? 'bg-bg-tertiary text-text-primary' : 'text-text-secondary'}
    >
      <td className="py-0.5" style={{ paddingLeft: 4 + node.depth * 16 }}>
        <span className="flex items-center gap-1.5">
          {hasChildren ? (
            <button
              data-testid="BreakdownTable.row.toggle"
              aria-expanded={expanded}
              onClick={onToggle}
              title={expanded ? 'Collapse' : 'Expand'}
              className="[-webkit-app-region:no-drag] w-3 shrink-0 text-text-muted hover:text-text-primary transition-colors cursor-default"
            >
              {expanded ? '▾' : '▸'}
            </button>
          ) : (
            <span className="w-3 shrink-0" />
          )}
          {node.color && (
            <i
              className="inline-block w-2 h-2 rounded-full shrink-0"
              style={{ backgroundColor: node.color }}
            />
          )}
          <span data-testid="BreakdownTable.row.label" className={root ? 'font-medium' : ''}>
            {node.label}
          </span>
          {node.machine && <MachineTags machine={node.machine} />}
          {node.dispatched && <DispatchedMarker totals={node.dispatched} />}
        </span>
      </td>
      <TokensCell totals={node.totals} />
      <td className={`${NUM_CELL} ${W_COST}`}>{formatCost(node.totals.apiCostUsd)}</td>
      <BilledCell usd={node.totals.billedCostUsd} />
      <td className={`${NUM_CELL} ${W_COST}`}>
        {formatCost(node.totals.displayCostUsd)}
        {node.totals.unknownApiCostCount > 0 && (
          <UnpricedBadge count={node.totals.unknownApiCostCount} />
        )}
      </td>
      <td className="pl-3">
        <ShareCell usd={node.totals.displayCostUsd} grandTotal={grandTotal} />
      </td>
    </tr>
  )
}

/**
 * Whose machine a root row is, when the tree is rooted on machines.
 *
 * `remote` and nothing at all, rather than `remote` and `local`: this machine is
 * the reader's default assumption, and labelling every row would make the split
 * harder to see rather than easier. `behind` is measured against the reader's
 * clock for the reason `MachinesPanel` measures it there — see its header.
 */
function MachineTags({ machine }: { machine: DashboardMachine }): React.JSX.Element {
  const behindMs =
    machine.retired || machine.lastPushAt === null ? null : Date.now() - machine.lastPushAt
  return (
    <>
      {!machine.self && (
        <span
          data-testid="BreakdownTable.row.remote"
          className="text-[9px] px-1 py-px rounded bg-bg-tertiary text-text-secondary whitespace-nowrap"
          title="Relayed from this machine through the usage hub, as the last pull left it."
        >
          remote
        </span>
      )}
      {behindMs !== null && behindMs > BEHIND_MS && (
        <span
          data-testid="BreakdownTable.row.behind"
          className="text-[9px] px-1 py-px rounded border border-warning/50 text-warning whitespace-nowrap"
          title="It has not pushed for more than a day, so its spend since then is missing from these figures."
        >
          behind {formatBehind(behindMs)}
        </span>
      )}
    </>
  )
}

/**
 * What a card was actually charged, or a dash.
 *
 * `$0.00` here would be a claim the ledger cannot make: a zero in this column
 * means a plan absorbed the turn or the model is free, never that a charge of
 * zero was issued (ADR-030). Shared by the data rows and the total row, which
 * is how the total came to read `$0.00` beside a column of dashes.
 */
function BilledCell({ usd }: { usd: number }): React.JSX.Element {
  if (usd > 0) return <td className={`${NUM_CELL} ${W_COST}`}>{formatCost(usd)}</td>
  return (
    <td
      className={`${NUM_CELL} ${W_COST} text-text-muted`}
      title="Nothing was charged — a plan covered it, or the model is free"
    >
      —
    </td>
  )
}

/**
 * In and out, which is what a reader compares between models; the cache tiers
 * are a fact about how a turn was served and live in the title rather than in a
 * column nobody scans.
 */
function TokensCell({ totals }: { totals: CostTotals }): React.JSX.Element {
  const { input, output, cacheWrite, cacheRead } = totals.tokens
  return (
    <td
      className={`${NUM_CELL} ${W_TOKENS} text-text-muted`}
      title={`In ${input.toLocaleString()} · Out ${output.toLocaleString()} · Cache write ${cacheWrite.toLocaleString()} · Cache read ${cacheRead.toLocaleString()} · ${totals.requestCount.toLocaleString()} turns`}
    >
      {formatTokenCount(input)} / {formatTokenCount(output)}
    </td>
  )
}

/**
 * The dispatched part of a row, ON the row rather than in a section of its own.
 * It is ALREADY inside every figure on this line (owner ruling, ADR-071 §8), so
 * the marker says where the work came from, never adds to the arithmetic.
 */
function DispatchedMarker({ totals }: { totals: CostTotals }): React.JSX.Element {
  // A dispatched sub-total of zero is the normal case on a free or unpriced
  // engine, and `↗ $0.00 dispatched` reads as a broken figure rather than as
  // the fact it carries. The turn count is what is actually known there.
  const measure =
    totals.displayCostUsd > 0
      ? formatCost(totals.displayCostUsd)
      : `${totals.requestCount} ${totals.requestCount === 1 ? 'turn' : 'turns'}`
  return (
    <span
      data-testid="BreakdownTable.row.dispatched"
      className="text-[9px] px-1 py-px rounded border border-accent/50 text-accent whitespace-nowrap"
      title={`${formatCost(totals.displayCostUsd)} of this row was work dispatched to another engine (${totals.requestCount} turns) — already included in the figures on this row, not an extra.`}
    >
      ↗ {measure} dispatched
    </span>
  )
}

/** Turns the figure beside it is MISSING, never turns it counted as zero (ADR-030). */
function UnpricedBadge({ count }: { count: number }): React.JSX.Element {
  return (
    <span
      data-testid="BreakdownTable.row.unpriced"
      className="ml-1 text-[9px] text-text-muted"
      title={`${count} ${count === 1 ? 'turn ran' : 'turns ran'} on a model with no known price — not included in this figure`}
    >
      +{count} unpriced
    </span>
  )
}

function ShareCell({ usd, grandTotal }: { usd: number; grandTotal: number }): React.JSX.Element {
  const pct = grandTotal > 0 ? (usd / grandTotal) * 100 : 0
  return (
    <span className="flex items-center gap-1.5 justify-end">
      <span className="w-[56px] h-[4px] rounded-sm bg-bg-tertiary overflow-hidden">
        <span
          className="block h-full rounded-sm bg-text-secondary"
          style={{ width: `${Math.min(100, pct)}%`, minWidth: pct > 0 ? 2 : 0 }}
        />
      </span>
      <span className="font-mono w-[30px] text-right text-text-muted">{Math.round(pct)}%</span>
    </span>
  )
}

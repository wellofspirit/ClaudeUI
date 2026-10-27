/**
 * The OpenRouter tab's Models card: the catalog the key can reach, and — one
 * click on a row — who serves a model and how healthy each provider is right
 * now.
 *
 * Both reads are lazy and host-cached (an hour for the lists, five minutes for
 * a model's endpoints), so this component re-asks freely: toggling `Mine`/`All`
 * or re-opening a row is a cache hit on the host, not an OpenRouter request.
 * `refreshToken` is the panel's refresh: it is the one thing that re-reads the
 * lists while this card stays mounted.
 */

import { useEffect, useMemo, useState } from 'react'
import type {
  OpenRouterEndpointRow,
  OpenRouterModelRow,
  OpenRouterModelScope
} from '../../../../shared/openrouter'
import { formatContextLength, formatPricePerM } from './usage-utils'

/** Endpoints past this many rows scroll inside the card instead of stretching it. */
const ENDPOINT_ROWS_VISIBLE = 8

const COLUMNS = 8

const TH = 'px-2 py-1.5 font-normal text-[9px] uppercase tracking-wider text-text-muted'
const NUM = 'font-mono tabular-nums text-right'

function errorMessage(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback
}

function formatIndex(n: number | null): string {
  return n === null ? '—' : n.toFixed(1)
}

export function OpenRouterModels({
  available,
  total,
  refreshToken
}: {
  available: number | null
  total: number | null
  refreshToken: number
}): React.JSX.Element {
  const [scope, setScope] = useState<OpenRouterModelScope>('user')
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  // Tagged with its scope so a slow `all` answer never paints under `Mine`.
  const [loaded, setLoaded] = useState<{
    scope: OpenRouterModelScope
    rows: OpenRouterModelRow[]
  } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setError(null)
    window.api
      .openrouterModels(scope)
      .then((rows) => {
        if (!cancelled) setLoaded({ scope, rows })
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorMessage(e, 'Could not read the model list'))
      })
    return () => {
      cancelled = true
    }
  }, [scope, refreshToken])

  const rows = loaded !== null && loaded.scope === scope ? loaded.rows : null
  const shown = useMemo(() => {
    if (rows === null) return []
    const q = filter.trim().toLowerCase()
    if (q === '') return rows
    return rows.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
  }, [rows, filter])

  const count = (n: number | null): string => (n === null ? '' : ` (${n})`)

  return (
    <div
      data-testid="OpenRouterPanel.models"
      className="bg-bg-secondary rounded-xl border border-border/50"
    >
      <div className="flex flex-wrap items-center gap-2 px-3 pt-3 pb-2">
        <span className="text-[12px] font-semibold text-text-primary">Models</span>
        {available !== null && total !== null && (
          <span className="text-[10px] text-text-muted">
            <span className="font-mono text-text-secondary">{available}</span> available to you of{' '}
            <span className="font-mono">{total}</span> — your provider and privacy settings filter
            the rest
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <div
            data-testid="OpenRouterPanel.models.scope"
            data-value={scope}
            className="flex gap-0.5 bg-bg-primary border border-border/50 rounded-md p-0.5"
          >
            {(
              [
                ['user', `Mine${count(available)}`],
                ['all', `All${count(total)}`]
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                data-testid={`OpenRouterPanel.models.scope.${id}`}
                data-active={id === scope}
                aria-pressed={id === scope}
                onClick={() => setScope(id)}
                className={`text-[10px] px-2 py-0.5 rounded transition-colors cursor-default ${
                  id === scope
                    ? 'bg-bg-hover text-text-primary'
                    : 'text-text-muted hover:text-text-secondary'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <input
            data-testid="OpenRouterPanel.models.filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter…"
            className="text-[10px] px-2 py-1 rounded border border-border/50 bg-bg-input text-text-primary outline-none w-32"
          />
        </div>
      </div>

      {error !== null ? (
        <div
          data-testid="OpenRouterPanel.models.error"
          className="px-3 pb-3 text-[11px] text-danger"
        >
          {error}
        </div>
      ) : rows === null ? (
        <div
          data-testid="OpenRouterPanel.models.loading"
          className="px-3 pb-3 text-[11px] text-text-muted"
        >
          Loading models…
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px] min-w-[640px]">
            <thead>
              <tr className="text-left border-y border-border/50">
                <th className={`${TH} px-3`}>Model</th>
                <th className={`${TH} text-right`}>Context</th>
                <th className={`${TH} text-right`}>In $/M</th>
                <th className={`${TH} text-right`}>Out $/M</th>
                <th className={`${TH} text-right`}>Cache $/M</th>
                <th className={TH}>Input</th>
                <th className={`${TH} text-right`} title="Artificial Analysis, via /benchmarks">
                  Intel.
                </th>
                <th
                  className={`${TH} px-3 text-right`}
                  title="Artificial Analysis, via /benchmarks"
                >
                  Coding
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && (
                <tr>
                  <td
                    data-testid="OpenRouterPanel.models.empty"
                    colSpan={COLUMNS}
                    className="px-3 py-3 text-[11px] text-text-muted"
                  >
                    {rows.length === 0 ? 'No models to show.' : 'No model matches the filter.'}
                  </td>
                </tr>
              )}
              {shown.map((m) => (
                <ModelRow
                  key={m.id}
                  model={m}
                  open={expanded === m.id}
                  onToggle={() => setExpanded((cur) => (cur === m.id ? null : m.id))}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="px-3 py-2 text-[9px] text-text-muted">
        Click a row for its providers: live uptime, latency and throughput. Benchmarks from
        Artificial Analysis.
      </div>
    </div>
  )
}

function ModelRow({
  model: m,
  open,
  onToggle
}: {
  model: OpenRouterModelRow
  open: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <>
      <tr
        data-testid="OpenRouterPanel.models.row"
        data-id={m.id}
        data-open={open}
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggle()
          }
        }}
        className="border-b border-border/30 hover:bg-bg-hover cursor-default"
      >
        <td className="px-3 py-1.5">
          <div className="text-text-primary">{m.name}</div>
          <div className="text-[9px] text-text-muted font-mono">{m.id}</div>
        </td>
        <td className={`px-2 ${NUM} text-text-secondary`}>
          {formatContextLength(m.contextLength)}
        </td>
        <td className={`px-2 ${NUM}`}>{formatPricePerM(m.promptPerM)}</td>
        <td className={`px-2 ${NUM}`}>{formatPricePerM(m.completionPerM)}</td>
        <td className={`px-2 ${NUM} text-text-muted`}>{formatPricePerM(m.cacheReadPerM)}</td>
        <td className="px-2 text-[10px] text-text-secondary">
          {m.inputModalities.join(' · ') || '—'}
        </td>
        <td className={`px-2 ${NUM}`}>{formatIndex(m.intelligenceIndex)}</td>
        <td className={`px-3 ${NUM}`}>{formatIndex(m.codingIndex)}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={COLUMNS} className="px-6 pb-2 bg-bg-primary">
            <Endpoints modelId={m.id} />
          </td>
        </tr>
      )}
    </>
  )
}

function uptimeClass(pct: number | null): string {
  if (pct === null) return 'text-text-muted'
  if (pct >= 99) return 'text-success'
  if (pct >= 90) return 'text-warning'
  return 'text-danger'
}

function Uptime({ pct }: { pct: number | null }): React.JSX.Element {
  return <span className={uptimeClass(pct)}>{pct === null ? '—' : `${pct.toFixed(1)}%`}</span>
}

/** Fastest first; an endpoint with no throughput reading goes last. */
function byThroughput(a: OpenRouterEndpointRow, b: OpenRouterEndpointRow): number {
  return (b.throughputP50 ?? -1) - (a.throughputP50 ?? -1)
}

/** Mounted only while its row is open, so it fetches on first open and nothing before. */
function Endpoints({ modelId }: { modelId: string }): React.JSX.Element {
  const [rows, setRows] = useState<OpenRouterEndpointRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api
      .openrouterModelEndpoints(modelId)
      .then((r) => {
        if (!cancelled) setRows([...r].sort(byThroughput))
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorMessage(e, 'Could not read the providers'))
      })
    return () => {
      cancelled = true
    }
  }, [modelId])

  if (error !== null) {
    return (
      <div data-testid="OpenRouterPanel.endpoints.error" className="py-2 text-[10px] text-danger">
        {error}
      </div>
    )
  }
  if (rows === null) {
    return (
      <div
        data-testid="OpenRouterPanel.endpoints.loading"
        className="py-2 flex items-center gap-1.5 text-[10px] text-text-muted"
      >
        <span className="inline-block w-2.5 h-2.5 rounded-full border border-current border-t-transparent animate-spin" />
        Loading providers…
      </div>
    )
  }
  if (rows.length === 0) {
    return (
      <div
        data-testid="OpenRouterPanel.endpoints"
        data-id={modelId}
        className="py-2 text-[10px] text-text-muted"
      >
        No providers are serving this model right now.
      </div>
    )
  }

  return (
    <div data-testid="OpenRouterPanel.endpoints" data-id={modelId}>
      <div className="py-1.5 text-[9px] uppercase tracking-wider text-text-muted">
        Providers · {rows.length} {rows.length === 1 ? 'endpoint' : 'endpoints'}, fastest first
      </div>
      <div
        data-scrolls={rows.length > ENDPOINT_ROWS_VISIBLE}
        className={`overflow-x-auto ${rows.length > ENDPOINT_ROWS_VISIBLE ? 'max-h-52 overflow-y-auto' : ''}`}
      >
        <table className="w-full text-[10px] min-w-[520px]">
          <thead>
            <tr className="text-left text-[9px] uppercase tracking-wider text-text-muted">
              <th className="font-normal py-1">Provider</th>
              <th className="font-normal">Quant</th>
              <th className="font-normal text-right">In $/M</th>
              <th className="font-normal text-right">Out $/M</th>
              <th className="font-normal text-right">Uptime 1d</th>
              <th className="font-normal text-right">30m</th>
              <th className="font-normal text-right">p50 latency</th>
              <th className="font-normal text-right">p50 tok/s</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e, i) => (
              <tr key={`${e.tag}:${i}`} className="border-t border-border/30">
                <td className="py-1 text-text-primary" title={e.tag}>
                  {e.provider}
                  {e.status < 0 && (
                    <span
                      data-testid="OpenRouterPanel.endpoints.degraded"
                      className="ml-1 text-[9px] px-1.5 rounded-full border border-warning/40 text-warning"
                    >
                      degraded
                    </span>
                  )}
                </td>
                <td className="text-text-muted">{e.quantization ?? '—'}</td>
                <td className={NUM}>{formatPricePerM(e.promptPerM)}</td>
                <td className={NUM}>{formatPricePerM(e.completionPerM)}</td>
                <td className={NUM}>
                  <Uptime pct={e.uptime1d} />
                </td>
                <td className={NUM}>
                  <Uptime pct={e.uptime30m} />
                </td>
                <td className={`${NUM} text-text-secondary`}>
                  {e.latencyP50Ms === null ? '—' : `${Math.round(e.latencyP50Ms)} ms`}
                </td>
                <td className={NUM}>
                  {e.throughputP50 === null ? '—' : Math.round(e.throughputP50)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

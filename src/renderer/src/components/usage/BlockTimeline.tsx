import { useState, useMemo } from 'react'
import type { UsageSnapshot, ModelTokenBreakdown } from '../../../../shared/types'
import { getModelColor, formatTokenCount, formatTime, shortModelName } from './usage-utils'

interface BlockTimelineProps {
  snapshots: UsageSnapshot[]
  blockStartTime: number
  blockEndTime: number
  height?: number
}

type ChartMode = 'area' | 'bar'

const MS_PER_HOUR = 3_600_000
const BUCKET_MS = 5 * 60_000 // 5-minute buckets

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function totalFromSnap(snap: UsageSnapshot): number {
  if (!snap.blockTokens) return 0
  return (
    snap.blockTokens.inputTokens +
    snap.blockTokens.outputTokens +
    snap.blockTokens.cacheCreationTokens +
    snap.blockTokens.cacheReadTokens
  )
}

function totalFromModel(m: ModelTokenBreakdown): number {
  return (
    m.tokens.inputTokens +
    m.tokens.outputTokens +
    m.tokens.cacheCreationTokens +
    m.tokens.cacheReadTokens
  )
}

// ---------------------------------------------------------------------------
// Bar chart bucket type
// ---------------------------------------------------------------------------

interface Bucket {
  startTs: number
  endTs: number
  /** Per-model token *deltas* accumulated within this bucket */
  modelDeltas: Map<string, number>
  totalDelta: number
  /** Average API% across snapshots in this bucket */
  avgApiPercent: number
  snapCount: number
}

/**
 * SVG chart showing token accumulation and API% over time within a single block.
 * Supports two modes: stacked area (cumulative) and stacked bar (5-min deltas).
 */
export function BlockTimeline({
  snapshots,
  blockStartTime,
  blockEndTime,
  height = 160
}: BlockTimelineProps): React.JSX.Element {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const [mode, setMode] = useState<ChartMode>('area')

  const width = 600
  const padL = 38
  const padR = 30
  const padT = 10
  const padB = 30
  const chartW = width - padL - padR
  const chartH = height - padT - padB

  // Filter snapshots belonging to this block
  const blockSnaps = snapshots.filter(
    (s) => s.activeBlockId && s.timestamp >= blockStartTime - 60_000
  )

  if (blockSnaps.length < 2) {
    return (
      <div className="flex items-center justify-center text-text-muted text-[11px] py-6">
        Collecting data points… (need at least 2 snapshots)
      </div>
    )
  }

  // Visible x-axis range
  const firstSnapTs = blockSnaps[0].timestamp
  const visibleStart = Math.max(
    blockStartTime,
    Math.floor(firstSnapTs / MS_PER_HOUR) * MS_PER_HOUR
  )
  const visibleEnd = blockEndTime
  const timeRange = visibleEnd - visibleStart

  // Collect all model names
  const allModels = new Set<string>()
  for (const snap of blockSnaps) {
    for (const m of snap.blockModels) allModels.add(m.model)
  }
  const modelList = Array.from(allModels)

  // X-axis time labels (every hour)
  const hourLabels: Array<{ x: number; label: string }> = []
  const firstHourLabel = Math.ceil(visibleStart / MS_PER_HOUR) * MS_PER_HOUR
  const xScale = (ts: number): number =>
    padL + ((ts - visibleStart) / timeRange) * chartW
  for (let t = firstHourLabel; t <= visibleEnd; t += MS_PER_HOUR) {
    hourLabels.push({ x: xScale(t), label: formatTime(t) })
  }

  return (
    <div className="relative">
      {/* Mode toggle */}
      <div className="flex items-center gap-1 mb-1">
        <button
          onClick={() => setMode('area')}
          className={`px-1.5 py-0.5 rounded text-[9px] transition-colors ${
            mode === 'area'
              ? 'bg-white/10 text-text-primary'
              : 'text-text-muted hover:text-text-secondary'
          }`}
        >
          Area
        </button>
        <button
          onClick={() => setMode('bar')}
          className={`px-1.5 py-0.5 rounded text-[9px] transition-colors ${
            mode === 'bar'
              ? 'bg-white/10 text-text-primary'
              : 'text-text-muted hover:text-text-secondary'
          }`}
        >
          Bar
        </button>
      </div>

      {mode === 'area' ? (
        <AreaChart
          blockSnaps={blockSnaps}
          modelList={modelList}
          visibleStart={visibleStart}
          visibleEnd={visibleEnd}
          timeRange={timeRange}
          hourLabels={hourLabels}
          width={width}
          height={height}
          padL={padL}
          padR={padR}
          padT={padT}
          padB={padB}
          chartW={chartW}
          chartH={chartH}
          xScale={xScale}
          hoverIdx={hoverIdx}
          setHoverIdx={setHoverIdx}
        />
      ) : (
        <BarChart
          blockSnaps={blockSnaps}
          modelList={modelList}
          visibleStart={visibleStart}
          visibleEnd={visibleEnd}
          timeRange={timeRange}
          hourLabels={hourLabels}
          width={width}
          height={height}
          padL={padL}
          padR={padR}
          padT={padT}
          padB={padB}
          chartW={chartW}
          chartH={chartH}
          xScale={xScale}
          hoverIdx={hoverIdx}
          setHoverIdx={setHoverIdx}
        />
      )}

      {/* Legend */}
      <div className="flex items-center gap-3 mt-1 px-1">
        {modelList.map((model) => (
          <div key={model} className="flex items-center gap-1 text-[9px] text-text-muted">
            <span
              className="inline-block w-2 h-2 rounded-full"
              style={{ backgroundColor: getModelColor(model) }}
            />
            {shortModelName(model)}
          </div>
        ))}
        <div className="flex items-center gap-1 text-[9px] text-red-400/70">
          <span className="inline-block w-3 border-t border-dashed border-red-400" />
          API %
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared sub-component props
// ---------------------------------------------------------------------------

interface ChartProps {
  blockSnaps: UsageSnapshot[]
  modelList: string[]
  visibleStart: number
  visibleEnd: number
  timeRange: number
  hourLabels: Array<{ x: number; label: string }>
  width: number
  height: number
  padL: number
  padR: number
  padT: number
  padB: number
  chartW: number
  chartH: number
  xScale: (ts: number) => number
  hoverIdx: number | null
  setHoverIdx: (idx: number | null) => void
}

// ---------------------------------------------------------------------------
// Area Chart (existing cumulative view)
// ---------------------------------------------------------------------------

function AreaChart({
  blockSnaps,
  modelList,
  visibleStart,
  timeRange,
  hourLabels,
  width,
  height,
  padL,
  padT,
  chartW,
  chartH,
  xScale,
  hoverIdx,
  setHoverIdx
}: ChartProps): React.JSX.Element {
  // Compute max tokens for y-scaling
  let maxTokens = 0
  for (const snap of blockSnaps) {
    const total = totalFromSnap(snap)
    if (total > maxTokens) maxTokens = total
  }
  if (maxTokens === 0) maxTokens = 1

  const yScale = (val: number): number =>
    padT + chartH - (val / maxTokens) * chartH
  const apiYScale = (pct: number): number =>
    padT + chartH - (pct / 100) * chartH

  // Build stacked area paths per model
  const modelPaths: Array<{ model: string; color: string; path: string }> = []
  for (let mi = 0; mi < modelList.length; mi++) {
    const model = modelList[mi]
    const upperPoints: string[] = []
    const lowerPoints: string[] = []

    for (const snap of blockSnaps) {
      const x = xScale(snap.timestamp)

      let upperSum = 0
      for (let j = 0; j <= mi; j++) {
        const m = snap.blockModels.find((bm) => bm.model === modelList[j])
        if (m) upperSum += totalFromModel(m)
      }

      let lowerSum = 0
      for (let j = 0; j < mi; j++) {
        const m = snap.blockModels.find((bm) => bm.model === modelList[j])
        if (m) lowerSum += totalFromModel(m)
      }

      upperPoints.push(`${x},${yScale(upperSum)}`)
      lowerPoints.push(`${x},${yScale(lowerSum)}`)
    }

    const pathD =
      `M ${upperPoints.join(' L ')} L ${lowerPoints.reverse().join(' L ')} Z`
    modelPaths.push({ model, color: getModelColor(model), path: pathD })
  }

  // API% line
  const apiLine = blockSnaps
    .map((s) => `${xScale(s.timestamp)},${apiYScale(s.apiUsagePercent)}`)
    .join(' L ')

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect()
    const svgX = ((e.clientX - rect.left) / rect.width) * width
    const relX = svgX - padL
    if (relX < 0 || relX > chartW) {
      setHoverIdx(null)
      return
    }
    const ts = visibleStart + (relX / chartW) * timeRange
    let nearest = 0
    let minDist = Infinity
    for (let i = 0; i < blockSnaps.length; i++) {
      const dist = Math.abs(blockSnaps[i].timestamp - ts)
      if (dist < minDist) {
        minDist = dist
        nearest = i
      }
    }
    setHoverIdx(nearest)
  }

  const hoverSnap = hoverIdx !== null ? blockSnaps[hoverIdx] : null

  return (
    <>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoverIdx(null)}
      >
        {/* Grid lines */}
        {[0.25, 0.5, 0.75, 1].map((frac) => (
          <line
            key={frac}
            x1={padL}
            y1={yScale(maxTokens * frac)}
            x2={padL + chartW}
            y2={yScale(maxTokens * frac)}
            stroke="currentColor"
            strokeWidth={0.5}
            className="text-white/5"
          />
        ))}

        {/* Stacked area */}
        {modelPaths.map((mp) => (
          <path
            key={mp.model}
            d={mp.path}
            fill={mp.color}
            fillOpacity={0.3}
            stroke={mp.color}
            strokeWidth={1}
            strokeOpacity={0.6}
          />
        ))}

        {/* API% dashed line */}
        {apiLine && (
          <path
            d={`M ${apiLine}`}
            fill="none"
            stroke="#ef4444"
            strokeWidth={1.5}
            strokeDasharray="4 3"
            opacity={0.7}
          />
        )}

        {/* Y-axis labels (tokens) */}
        {[0, 0.5, 1].map((frac) => (
          <text
            key={frac}
            x={padL - 4}
            y={yScale(maxTokens * frac)}
            textAnchor="end"
            dominantBaseline="middle"
            className="fill-text-muted"
            fontSize={9}
          >
            {formatTokenCount(Math.round(maxTokens * frac))}
          </text>
        ))}

        {/* Right Y-axis label for API% */}
        <text
          x={width - 2}
          y={padT}
          textAnchor="end"
          dominantBaseline="hanging"
          className="fill-red-400"
          fontSize={8}
        >
          API%
        </text>

        {/* X-axis labels */}
        {hourLabels.map((hl) => (
          <text
            key={hl.label}
            x={hl.x}
            y={height - 4}
            textAnchor="middle"
            className="fill-text-muted"
            fontSize={9}
          >
            {hl.label}
          </text>
        ))}

        {/* Hover crosshair */}
        {hoverSnap && (
          <>
            <line
              x1={xScale(hoverSnap.timestamp)}
              y1={padT}
              x2={xScale(hoverSnap.timestamp)}
              y2={padT + chartH}
              stroke="currentColor"
              strokeWidth={0.5}
              className="text-white/30"
            />
            <circle
              cx={xScale(hoverSnap.timestamp)}
              cy={apiYScale(hoverSnap.apiUsagePercent)}
              r={3}
              fill="#ef4444"
            />
          </>
        )}
      </svg>

      {/* Hover tooltip */}
      {hoverSnap && (
        <SnapTooltip snap={hoverSnap} modelList={modelList} />
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Bar Chart (5-minute delta buckets)
// ---------------------------------------------------------------------------

function BarChart({
  blockSnaps,
  modelList,
  visibleStart,
  timeRange,
  hourLabels,
  width,
  height,
  padL,
  padT,
  chartW,
  chartH,
  xScale,
  hoverIdx,
  setHoverIdx
}: ChartProps): React.JSX.Element {
  // Build 5-minute buckets with token deltas between consecutive snapshots
  const buckets = useMemo(() => {
    const result: Bucket[] = []

    // Create bucket time slots covering the visible range
    const bucketStart = Math.floor(visibleStart / BUCKET_MS) * BUCKET_MS
    const bucketSlots = new Map<number, Bucket>()
    for (let t = bucketStart; t < visibleStart + timeRange; t += BUCKET_MS) {
      bucketSlots.set(t, {
        startTs: t,
        endTs: t + BUCKET_MS,
        modelDeltas: new Map(),
        totalDelta: 0,
        avgApiPercent: 0,
        snapCount: 0
      })
    }

    // Compute deltas between consecutive snapshots, attribute to buckets
    for (let i = 1; i < blockSnaps.length; i++) {
      const prev = blockSnaps[i - 1]
      const curr = blockSnaps[i]

      // Total delta
      const prevTotal = totalFromSnap(prev)
      const currTotal = totalFromSnap(curr)
      const totalDelta = currTotal - prevTotal
      if (totalDelta <= 0) continue

      // Per-model deltas
      const modelDeltas = new Map<string, number>()
      for (const model of modelList) {
        const prevM = prev.blockModels.find((m) => m.model === model)
        const currM = curr.blockModels.find((m) => m.model === model)
        const prevTok = prevM ? totalFromModel(prevM) : 0
        const currTok = currM ? totalFromModel(currM) : 0
        const delta = currTok - prevTok
        if (delta > 0) modelDeltas.set(model, delta)
      }

      // Assign to the bucket the current snapshot falls into
      const bucketKey = Math.floor(curr.timestamp / BUCKET_MS) * BUCKET_MS
      const bucket = bucketSlots.get(bucketKey)
      if (bucket) {
        for (const [model, delta] of modelDeltas) {
          bucket.modelDeltas.set(model, (bucket.modelDeltas.get(model) ?? 0) + delta)
        }
        bucket.totalDelta += totalDelta
        bucket.avgApiPercent += curr.apiUsagePercent
        bucket.snapCount += 1
      }
    }

    // Finalize averages, collect non-empty buckets
    for (const bucket of bucketSlots.values()) {
      if (bucket.snapCount > 0) {
        bucket.avgApiPercent /= bucket.snapCount
        result.push(bucket)
      }
    }

    result.sort((a, b) => a.startTs - b.startTs)
    return result
  }, [blockSnaps, modelList, visibleStart, timeRange])

  // Max delta for y-scaling
  let maxDelta = 0
  for (const b of buckets) {
    if (b.totalDelta > maxDelta) maxDelta = b.totalDelta
  }
  if (maxDelta === 0) maxDelta = 1

  const yScale = (val: number): number =>
    padT + chartH - (val / maxDelta) * chartH
  const apiYScale = (pct: number): number =>
    padT + chartH - (pct / 100) * chartH

  // Bar geometry
  const barWidthFrac = BUCKET_MS / timeRange
  const barW = Math.max(2, barWidthFrac * chartW * 0.8) // 80% of slot, min 2px
  const gap = barWidthFrac * chartW * 0.1 // 10% gap on each side

  // API% line through bucket midpoints
  const apiLine = buckets
    .map((b) => {
      const midX = xScale(b.startTs + BUCKET_MS / 2)
      return `${midX},${apiYScale(b.avgApiPercent)}`
    })
    .join(' L ')

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect()
    const svgX = ((e.clientX - rect.left) / rect.width) * width
    const relX = svgX - padL
    if (relX < 0 || relX > chartW) {
      setHoverIdx(null)
      return
    }
    const ts = visibleStart + (relX / chartW) * timeRange
    // Find nearest bucket
    let nearest = 0
    let minDist = Infinity
    for (let i = 0; i < buckets.length; i++) {
      const mid = buckets[i].startTs + BUCKET_MS / 2
      const dist = Math.abs(mid - ts)
      if (dist < minDist) {
        minDist = dist
        nearest = i
      }
    }
    setHoverIdx(nearest)
  }

  const hoverBucket = hoverIdx !== null && hoverIdx < buckets.length ? buckets[hoverIdx] : null

  return (
    <>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoverIdx(null)}
      >
        {/* Grid lines */}
        {[0.25, 0.5, 0.75, 1].map((frac) => (
          <line
            key={frac}
            x1={padL}
            y1={yScale(maxDelta * frac)}
            x2={padL + chartW}
            y2={yScale(maxDelta * frac)}
            stroke="currentColor"
            strokeWidth={0.5}
            className="text-white/5"
          />
        ))}

        {/* Stacked bars */}
        {buckets.map((bucket, bi) => {
          const bx = xScale(bucket.startTs) + gap
          let yOffset = 0

          return (
            <g key={bi}>
              {modelList.map((model) => {
                const delta = bucket.modelDeltas.get(model) ?? 0
                if (delta === 0) return null
                const barH = (delta / maxDelta) * chartH
                const y = padT + chartH - yOffset - barH
                yOffset += barH
                return (
                  <rect
                    key={model}
                    x={bx}
                    y={y}
                    width={barW}
                    height={barH}
                    fill={getModelColor(model)}
                    fillOpacity={hoverBucket === bucket ? 0.6 : 0.35}
                    rx={1}
                  />
                )
              })}
            </g>
          )
        })}

        {/* API% dashed line */}
        {apiLine && (
          <path
            d={`M ${apiLine}`}
            fill="none"
            stroke="#ef4444"
            strokeWidth={1.5}
            strokeDasharray="4 3"
            opacity={0.7}
          />
        )}

        {/* Y-axis labels (delta tokens) */}
        {[0, 0.5, 1].map((frac) => (
          <text
            key={frac}
            x={padL - 4}
            y={yScale(maxDelta * frac)}
            textAnchor="end"
            dominantBaseline="middle"
            className="fill-text-muted"
            fontSize={9}
          >
            {formatTokenCount(Math.round(maxDelta * frac))}
          </text>
        ))}

        {/* Right Y-axis label for API% */}
        <text
          x={width - 2}
          y={padT}
          textAnchor="end"
          dominantBaseline="hanging"
          className="fill-red-400"
          fontSize={8}
        >
          API%
        </text>

        {/* X-axis labels */}
        {hourLabels.map((hl) => (
          <text
            key={hl.label}
            x={hl.x}
            y={height - 4}
            textAnchor="middle"
            className="fill-text-muted"
            fontSize={9}
          >
            {hl.label}
          </text>
        ))}

        {/* Hover highlight */}
        {hoverBucket && (
          <line
            x1={xScale(hoverBucket.startTs + BUCKET_MS / 2)}
            y1={padT}
            x2={xScale(hoverBucket.startTs + BUCKET_MS / 2)}
            y2={padT + chartH}
            stroke="currentColor"
            strokeWidth={0.5}
            className="text-white/30"
          />
        )}
      </svg>

      {/* Hover tooltip */}
      {hoverBucket && (
        <div className="absolute top-0 right-0 bg-bg-tertiary border border-border rounded-md px-2 py-1.5 text-[10px] space-y-0.5 pointer-events-none z-10">
          <div className="text-text-secondary font-medium">
            {formatTime(hoverBucket.startTs)} – {formatTime(hoverBucket.endTs)}
          </div>
          <div className="text-text-muted">
            API: <span className="text-red-400 font-mono">{Math.round(hoverBucket.avgApiPercent)}%</span>
          </div>
          <div className="text-text-muted">
            Δ Tokens:{' '}
            <span className="text-text-primary font-mono">
              +{formatTokenCount(hoverBucket.totalDelta)}
            </span>
          </div>
          {modelList.map((model) => {
            const delta = hoverBucket.modelDeltas.get(model) ?? 0
            if (delta === 0) return null
            return (
              <div key={model} className="flex items-center gap-1">
                <span
                  className="inline-block w-2 h-2 rounded-full"
                  style={{ backgroundColor: getModelColor(model) }}
                />
                <span className="text-text-muted">{shortModelName(model)}:</span>
                <span className="text-text-primary font-mono">
                  +{formatTokenCount(delta)}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Shared tooltip for area chart
// ---------------------------------------------------------------------------

function SnapTooltip({
  snap,
  modelList: _modelList
}: {
  snap: UsageSnapshot
  modelList: string[]
}): React.JSX.Element {
  return (
    <div className="absolute top-0 right-0 bg-bg-tertiary border border-border rounded-md px-2 py-1.5 text-[10px] space-y-0.5 pointer-events-none z-10">
      <div className="text-text-secondary font-medium">{formatTime(snap.timestamp)}</div>
      <div className="text-text-muted">
        API: <span className="text-red-400 font-mono">{Math.round(snap.apiUsagePercent)}%</span>
      </div>
      {snap.blockTokens && (
        <div className="text-text-muted">
          Tokens:{' '}
          <span className="text-text-primary font-mono">
            {formatTokenCount(totalFromSnap(snap))}
          </span>
        </div>
      )}
      {snap.blockModels.map((m) => (
        <div key={m.model} className="flex items-center gap-1">
          <span
            className="inline-block w-2 h-2 rounded-full"
            style={{ backgroundColor: getModelColor(m.model) }}
          />
          <span className="text-text-muted">{shortModelName(m.model)}:</span>
          <span className="text-text-primary font-mono">
            {formatTokenCount(totalFromModel(m))}
          </span>
        </div>
      ))}
      {snap.burnRate && (
        <div className="text-text-muted">
          Burn: <span className="font-mono">{snap.burnRate.tokensPerMin} tok/min</span>
        </div>
      )}
    </div>
  )
}

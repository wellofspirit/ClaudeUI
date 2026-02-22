import { useState } from 'react'
import type { BlockUsageData } from '../../../../shared/types'
import { getModelColor, formatTokenCount, formatCost, formatShortDate, shortModelName } from './usage-utils'

interface DailyUsageChartProps {
  dailyHistory: BlockUsageData['dailyHistory']
  height?: number
}

export function DailyUsageChart({
  dailyHistory,
  height = 180
}: DailyUsageChartProps): React.JSX.Element {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)

  if (dailyHistory.length === 0) {
    return (
      <div className="flex items-center justify-center text-text-muted text-[11px] py-8">
        No usage history yet
      </div>
    )
  }

  const width = 600
  const padL = 50
  const padR = 20
  const padT = 10
  const padB = 28
  const chartW = width - padL - padR
  const chartH = height - padT - padB

  // Find max total tokens for Y-axis
  let maxTokens = 0
  for (const day of dailyHistory) {
    if (day.totalTokens > maxTokens) maxTokens = day.totalTokens
  }
  if (maxTokens === 0) maxTokens = 1
  // Add 10% headroom
  maxTokens = Math.ceil(maxTokens * 1.1)

  // Collect all model names
  const allModels = new Set<string>()
  for (const day of dailyHistory) {
    for (const model of Object.keys(day.models)) allModels.add(model)
  }
  const modelList = Array.from(allModels)

  const barCount = dailyHistory.length
  const barGap = 2
  const barWidth = Math.max(4, (chartW - barGap * barCount) / barCount)

  const yScale = (val: number): number =>
    padT + chartH - (val / maxTokens) * chartH

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
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

        {/* Y-axis labels */}
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

        {/* Bars */}
        {dailyHistory.map((day, i) => {
          const x = padL + i * (barWidth + barGap)
          const isHovered = hoverIdx === i

          // Build stacked segments
          const segments: Array<{ model: string; y: number; h: number; color: string }> = []
          let cumTokens = 0
          for (const model of modelList) {
            const tokens = day.models[model] || 0
            if (tokens === 0) continue
            const segH = (tokens / maxTokens) * chartH
            segments.push({
              model,
              y: yScale(cumTokens + tokens),
              h: segH,
              color: getModelColor(model)
            })
            cumTokens += tokens
          }

          return (
            <g
              key={day.date}
              onMouseEnter={() => setHoverIdx(i)}
              className="cursor-default"
            >
              {/* Invisible hit area */}
              <rect
                x={x}
                y={padT}
                width={barWidth}
                height={chartH}
                fill="transparent"
              />
              {/* Stacked segments */}
              {segments.map((seg) => (
                <rect
                  key={seg.model}
                  x={x}
                  y={seg.y}
                  width={barWidth}
                  height={Math.max(1, seg.h)}
                  rx={1}
                  fill={seg.color}
                  fillOpacity={isHovered ? 0.9 : 0.6}
                  className="transition-opacity duration-100"
                />
              ))}
            </g>
          )
        })}

        {/* X-axis date labels (every 7 days or fewer) */}
        {dailyHistory.map((day, i) => {
          const labelInterval = Math.max(1, Math.floor(dailyHistory.length / 5))
          if (i % labelInterval !== 0 && i !== dailyHistory.length - 1) return null
          const x = padL + i * (barWidth + barGap) + barWidth / 2
          return (
            <text
              key={day.date}
              x={x}
              y={height - 4}
              textAnchor="middle"
              className="fill-text-muted"
              fontSize={8}
            >
              {formatShortDate(day.date)}
            </text>
          )
        })}

        {/* Hover highlight line */}
        {hoverIdx !== null && (
          <line
            x1={padL + hoverIdx * (barWidth + barGap) + barWidth / 2}
            y1={padT}
            x2={padL + hoverIdx * (barWidth + barGap) + barWidth / 2}
            y2={padT + chartH}
            stroke="currentColor"
            strokeWidth={0.5}
            className="text-white/20"
            strokeDasharray="2 2"
          />
        )}
      </svg>

      {/* Hover tooltip */}
      {hoverIdx !== null && dailyHistory[hoverIdx] && (
        <div className="absolute top-0 right-0 bg-bg-tertiary border border-border rounded-md px-2 py-1.5 text-[10px] space-y-0.5 pointer-events-none z-10 min-w-[140px]">
          <div className="text-text-secondary font-medium">
            {formatShortDate(dailyHistory[hoverIdx].date)}
          </div>
          <div className="text-text-muted">
            Total:{' '}
            <span className="text-text-primary font-mono">
              {formatTokenCount(dailyHistory[hoverIdx].totalTokens)}
            </span>
          </div>
          <div className="text-text-muted">
            Cost:{' '}
            <span className="text-text-primary font-mono">
              {formatCost(dailyHistory[hoverIdx].costUsd)}
            </span>
          </div>
          <div className="text-text-muted">
            Blocks: <span className="font-mono">{dailyHistory[hoverIdx].blockCount}</span>
          </div>
          <div className="text-text-muted">
            Peak API: <span className="text-red-400 font-mono">{Math.round(dailyHistory[hoverIdx].peakApiPercent)}%</span>
          </div>
          <div className="border-t border-border/30 mt-1 pt-1 space-y-0.5">
            {Object.entries(dailyHistory[hoverIdx].models)
              .sort((a, b) => b[1] - a[1])
              .map(([model, tokens]) => (
                <div key={model} className="flex items-center gap-1">
                  <span
                    className="inline-block w-2 h-2 rounded-full"
                    style={{ backgroundColor: getModelColor(model) }}
                  />
                  <span className="text-text-muted">{shortModelName(model)}:</span>
                  <span className="text-text-primary font-mono">{formatTokenCount(tokens)}</span>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-3 mt-1 px-1">
        {modelList.map((model) => (
          <div key={model} className="flex items-center gap-1 text-[9px] text-text-muted">
            <span
              className="inline-block w-2 h-2 rounded-full"
              style={{ backgroundColor: getModelColor(model) }}
            />
            {shortModelName(model)}
          </div>
        ))}
      </div>
    </div>
  )
}

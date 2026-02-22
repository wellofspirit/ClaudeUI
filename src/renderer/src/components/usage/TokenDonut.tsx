import type { ModelTokenBreakdown } from '../../../../shared/types'
import { getModelColor, formatTokenCount, sumTokens } from './usage-utils'

interface TokenDonutProps {
  models: ModelTokenBreakdown[]
  size?: number
  totalTokens: number
}

// Minimum visible arc: 3% of circle so tiny slices are still visible
const MIN_ARC_PCT = 0.03

export function TokenDonut({ models, size = 100, totalTokens }: TokenDonutProps): React.JSX.Element {
  const cx = size / 2
  const cy = size / 2
  const radius = size * 0.35
  const strokeWidth = size * 0.15

  // Build arcs — one per model, sorted by token count descending
  const sorted = [...models].sort((a, b) => sumTokens(b.tokens) - sumTokens(a.tokens))

  // Compute raw percentages and apply minimum arc size
  const rawPcts = sorted.map((m) => (totalTokens > 0 ? sumTokens(m.tokens) / totalTokens : 0))
  const adjustedPcts = rawPcts.map((p) => Math.max(p, MIN_ARC_PCT))
  // Normalize so they sum to 1
  const pctSum = adjustedPcts.reduce((s, p) => s + p, 0)
  const normalizedPcts = pctSum > 0 ? adjustedPcts.map((p) => p / pctSum) : adjustedPcts

  const arcs: Array<{ model: string; color: string; pct: number }> = sorted.map((m, i) => ({
    model: m.model,
    color: getModelColor(m.model),
    pct: normalizedPcts[i]
  }))

  const circumference = 2 * Math.PI * radius

  return (
    <div className="flex flex-col items-center gap-1">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {/* Background ring */}
        <circle
          cx={cx}
          cy={cy}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          className="text-white/5"
        />
        {/* Model arcs */}
        {arcs.map((arc, i) => {
          const dashLen = circumference * arc.pct
          const gapLen = circumference - dashLen
          // Offset for where this arc starts
          const offset = arcs.slice(0, i).reduce((sum, a) => sum + circumference * a.pct, 0)
          return (
            <circle
              key={arc.model}
              cx={cx}
              cy={cy}
              r={radius}
              fill="none"
              stroke={arc.color}
              strokeWidth={strokeWidth}
              strokeDasharray={`${dashLen} ${gapLen}`}
              strokeDashoffset={-offset}
              strokeLinecap="butt"
              transform={`rotate(-90 ${cx} ${cy})`}
              className="transition-all duration-300"
            />
          )
        })}
        {/* Center text */}
        <text
          x={cx}
          y={cy - 4}
          textAnchor="middle"
          dominantBaseline="middle"
          className="fill-text-primary font-mono font-bold"
          fontSize={size * 0.16}
        >
          {formatTokenCount(totalTokens)}
        </text>
        <text
          x={cx}
          y={cy + 10}
          textAnchor="middle"
          dominantBaseline="middle"
          className="fill-text-muted"
          fontSize={size * 0.09}
        >
          tokens
        </text>
      </svg>
    </div>
  )
}

import { useLayoutEffect, useRef, useState } from 'react'
import type { BlockUsageData } from '../../../../shared/types'
import {
  getModelColor,
  formatTokenCount,
  formatCost,
  formatShortDate,
  shortModelName
} from './usage-utils'

interface DailyUsageChartProps {
  dailyHistory: BlockUsageData['dailyHistory']
  height?: number
}

type DailyUsageDay = BlockUsageData['dailyHistory'][number]

const VISIBLE_CALENDAR_DAYS = 30
const BAR_GAP = 2
const AXIS_WIDTH = 50
const MS_PER_DAY = 24 * 60 * 60 * 1000

function utcTimestamp(date: string): number {
  const [year, month, day] = date.split('-').map(Number)
  return Date.UTC(year, month - 1, day)
}

function dateFromUtcTimestamp(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

function fillCalendarGaps(dailyHistory: BlockUsageData['dailyHistory']): DailyUsageDay[] {
  if (dailyHistory.length === 0) return []

  const byDate = new Map(dailyHistory.map((day) => [day.date, day]))
  const dates = [...byDate.keys()].sort()
  const first = utcTimestamp(dates[0])
  const last = utcTimestamp(dates[dates.length - 1])
  const calendarHistory: DailyUsageDay[] = []

  for (let timestamp = first; timestamp <= last; timestamp += MS_PER_DAY) {
    const date = dateFromUtcTimestamp(timestamp)
    calendarHistory.push(
      byDate.get(date) ?? {
        date,
        totalTokens: 0,
        costUsd: 0,
        models: {},
        peakApiPercent: 0,
        blockCount: 0
      }
    )
  }

  return calendarHistory
}

export function DailyUsageChart({
  dailyHistory,
  height = 180
}: DailyUsageChartProps): React.JSX.Element {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const [viewportWidth, setViewportWidth] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const hasAutoScrolled = useRef(false)
  const calendarHistory = fillCalendarGaps(dailyHistory)

  useLayoutEffect(() => {
    const scroll = scrollRef.current
    if (!scroll || typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(([entry]) => setViewportWidth(entry.contentRect.width))
    observer.observe(scroll)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    const scroll = scrollRef.current
    if (!scroll || viewportWidth === 0) return

    const distanceFromEnd = scroll.scrollWidth - scroll.clientWidth - scroll.scrollLeft
    const twoDayThreshold = (scroll.clientWidth / VISIBLE_CALENDAR_DAYS) * 2
    if (!hasAutoScrolled.current || distanceFromEnd <= twoDayThreshold) {
      scroll.scrollLeft = scroll.scrollWidth
    }
    hasAutoScrolled.current = true
  }, [calendarHistory.length, viewportWidth])

  if (dailyHistory.length === 0) {
    return (
      <div className="flex items-center justify-center text-text-muted text-[11px] py-8">
        No usage history yet
      </div>
    )
  }

  const padT = 10
  const padB = 28
  const dayCount = calendarHistory.length
  const leadingSlots = Math.max(0, VISIBLE_CALENDAR_DAYS - dayCount)
  const plotSlotCount = Math.max(VISIBLE_CALENDAR_DAYS, dayCount) + 1
  const daySlotWidth = (viewportWidth || 600) / VISIBLE_CALENDAR_DAYS
  const barWidth = daySlotWidth - BAR_GAP
  const plotWidth = plotSlotCount * daySlotWidth
  const chartH = height - padT - padB

  // Find max total tokens for Y-axis
  let maxTokens = 0
  for (const day of calendarHistory) {
    if (day.totalTokens > maxTokens) maxTokens = day.totalTokens
  }
  if (maxTokens === 0) maxTokens = 1
  // Add 10% headroom
  maxTokens = Math.ceil(maxTokens * 1.1)

  // Collect all model names
  const allModels = new Set<string>()
  for (const day of calendarHistory) {
    for (const model of Object.keys(day.models)) allModels.add(model)
  }
  const modelList = Array.from(allModels)

  const yScale = (val: number): number => padT + chartH - (val / maxTokens) * chartH

  return (
    <div data-testid="DailyUsageChart" className="relative">
      <div className="flex items-start">
        <svg
          data-testid="DailyUsageChart.axis"
          viewBox={`0 0 ${AXIS_WIDTH} ${height}`}
          className="block w-[50px] shrink-0"
          style={{ height }}
          aria-hidden="true"
        >
          {[0, 0.5, 1].map((frac) => (
            <text
              key={frac}
              x={AXIS_WIDTH - 4}
              y={yScale(maxTokens * frac)}
              textAnchor="end"
              dominantBaseline="middle"
              className="fill-text-muted"
              fontSize={9}
            >
              {formatTokenCount(Math.round(maxTokens * frac))}
            </text>
          ))}
        </svg>

        <div
          ref={scrollRef}
          data-testid="DailyUsageChart.scroll"
          className="min-w-0 flex-1 overflow-x-auto"
        >
          <svg
            data-testid="DailyUsageChart.svg"
            viewBox={`0 0 ${plotWidth} ${height}`}
            className="block max-w-none"
            style={{ width: plotWidth, height }}
            onMouseLeave={() => setHoverIdx(null)}
          >
            {/* Grid lines */}
            {[0.25, 0.5, 0.75, 1].map((frac) => (
              <line
                key={frac}
                x1={0}
                y1={yScale(maxTokens * frac)}
                x2={plotWidth}
                y2={yScale(maxTokens * frac)}
                stroke="currentColor"
                strokeWidth={0.5}
                className="text-white/5"
              />
            ))}

            {/* Bars */}
            {calendarHistory.map((day, i) => {
              const x = (leadingSlots + i) * daySlotWidth + BAR_GAP / 2
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
                <g key={day.date} onMouseEnter={() => setHoverIdx(i)} className="cursor-default">
                  {/* Invisible hit area */}
                  <rect x={x} y={padT} width={barWidth} height={chartH} fill="transparent" />
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
            {calendarHistory.map((day, i) => {
              const lastIndex = calendarHistory.length - 1
              const tooCloseToLast = lastIndex - i < 4
              if (i !== lastIndex && (i % 7 !== 0 || tooCloseToLast)) return null
              const x = (leadingSlots + i) * daySlotWidth + daySlotWidth / 2
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
                x1={(leadingSlots + hoverIdx) * daySlotWidth + daySlotWidth / 2}
                y1={padT}
                x2={(leadingSlots + hoverIdx) * daySlotWidth + daySlotWidth / 2}
                y2={padT + chartH}
                stroke="currentColor"
                strokeWidth={0.5}
                className="text-white/20"
                strokeDasharray="2 2"
              />
            )}
          </svg>
        </div>
      </div>

      {/* Hover tooltip */}
      {hoverIdx !== null && calendarHistory[hoverIdx] && (
        <div className="absolute top-0 right-0 bg-bg-tertiary border border-border rounded-md px-2 py-1.5 text-[10px] space-y-0.5 pointer-events-none z-10 min-w-[140px]">
          <div className="text-text-secondary font-medium">
            {formatShortDate(calendarHistory[hoverIdx].date)}
          </div>
          <div className="text-text-muted">
            Total:{' '}
            <span className="text-text-primary font-mono">
              {formatTokenCount(calendarHistory[hoverIdx].totalTokens)}
            </span>
          </div>
          <div className="text-text-muted">
            Cost:{' '}
            <span className="text-text-primary font-mono">
              {formatCost(calendarHistory[hoverIdx].costUsd)}
            </span>
          </div>
          <div className="text-text-muted">
            Blocks: <span className="font-mono">{calendarHistory[hoverIdx].blockCount}</span>
          </div>
          <div className="text-text-muted">
            Peak API:{' '}
            <span className="text-red-400 font-mono">
              {Math.round(calendarHistory[hoverIdx].peakApiPercent)}%
            </span>
          </div>
          <div className="border-t border-border/30 mt-1 pt-1 space-y-0.5">
            {Object.entries(calendarHistory[hoverIdx].models)
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

import type { TokenCounts } from '../../../../shared/types'

/** Model color palette — match by substring */
const MODEL_COLORS: Array<{ match: string; color: string }> = [
  { match: 'opus', color: '#8b5fcc' },
  { match: 'sonnet', color: '#6c9eff' },
  { match: 'haiku', color: '#4ade80' }
]

const FALLBACK_COLORS = ['#f97316', '#ec4899', '#06b6d4', '#eab308', '#a855f7', '#14b8a6']

const colorCache = new Map<string, string>()

/** Simple string hash → deterministic index into the fallback palette */
function hashString(s: string): number {
  let hash = 0
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0
  }
  return Math.abs(hash)
}

export function getModelColor(model: string): string {
  const cached = colorCache.get(model)
  if (cached) return cached

  const lower = model.toLowerCase()
  for (const { match, color } of MODEL_COLORS) {
    if (lower.includes(match)) {
      colorCache.set(model, color)
      return color
    }
  }

  const color = FALLBACK_COLORS[hashString(model) % FALLBACK_COLORS.length]
  colorCache.set(model, color)
  return color
}

/** Format a token count as K/M abbreviation */
export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

/** Format cost in USD */
export function formatCost(usd: number): string {
  if (usd >= 0.01) return `$${usd.toFixed(2)}`
  if (usd > 0) return `$${usd.toFixed(4)}`
  return '$0.00'
}

/** Sum all token fields */
export function sumTokens(t: TokenCounts): number {
  return t.inputTokens + t.outputTokens + t.cacheCreationTokens + t.cacheReadTokens
}

/**
 * Format a model string into a marketing-style display name.
 * e.g., "claude-opus-4-6-20250514" → "Opus 4.6"
 *        "claude-sonnet-4-20250514" → "Sonnet 4"
 *        "claude-haiku-3-5-20240101" → "Haiku 3.5"
 *        "opus" → "Opus"
 */
export function shortModelName(model: string): string {
  const m = model.toLowerCase()

  // Match family name, then optional major.minor version.
  // Minor is a single digit (to avoid matching the 8-digit date suffix).
  const match = m.match(/(opus|sonnet|haiku)(?:[- ](\d{1,2})(?:[- ](\d)(?!\d))?)?/)
  if (match) {
    const family = match[1].charAt(0).toUpperCase() + match[1].slice(1)
    const major = match[2]
    const minor = match[3]
    if (major && minor) return `${family} ${major}.${minor}`
    if (major) return `${family} ${major}`
    return family
  }

  // Fallback: last segment
  const parts = model.split('-')
  return parts.length > 2 ? parts.slice(1, 3).join('-') : model
}

/** Format time as h:mm AM/PM */
export function formatTime(ts: number): string {
  const d = new Date(ts)
  const h = d.getHours()
  const m = d.getMinutes()
  const ampm = h >= 12 ? 'PM' : 'AM'
  const hour = h % 12 || 12
  return `${hour}:${String(m).padStart(2, '0')} ${ampm}`
}

/** Format a date as "Mon DD" */
export function formatShortDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00')
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${months[d.getMonth()]} ${d.getDate()}`
}

/** Format duration in ms as human-readable */
export function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1_000)
  if (totalSec < 60) return `${totalSec}s`
  const totalMin = Math.floor(totalSec / 60)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

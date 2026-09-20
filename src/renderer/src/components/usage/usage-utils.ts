import type { TokenCounts } from '../../../../shared/types'

/** Model color palette — match by substring */
const MODEL_COLORS: Array<{ match: string; color: string }> = [
  { match: 'fable', color: '#d97757' },
  { match: 'opus', color: '#7c5cff' },
  { match: 'sonnet', color: '#e8a728' },
  { match: 'haiku', color: '#06b6d4' }
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
 *        "claude-fable-5[1m]" → "Fable 5"
 *        "opus" → "Opus"
 */
export function shortModelName(model: string): string {
  const m = model.toLowerCase()

  // Match family name, then optional major.minor version.
  // Minor is a single digit (to avoid matching the 8-digit date suffix).
  const match = m.match(/(opus|sonnet|haiku|fable|mythos)(?:[- ](\d{1,2})(?:[- ](\d)(?!\d))?)?/)
  if (match) {
    const family = match[1].charAt(0).toUpperCase() + match[1].slice(1)
    const major = match[2]
    const minor = match[3]
    if (major && minor) return `${family} ${major}.${minor}`
    if (major) return `${family} ${major}`
    return family
  }

  // Fallback: the family regex above covers every Claude model; any other id
  // (e.g. opencode model ids like "mimo-v2.5-free" or "grok-code-fast") is shown
  // as-is. This previously sliced off the first segment to strip a "claude-"
  // prefix, which mangled opencode names ("mimo-v2.5-free" → "v2.5-free").
  return model
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
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec'
  ]
  return `${months[d.getMonth()]} ${d.getDate()}`
}

// ---------------------------------------------------------------------------
// The usage dashboard's categorical palette and meter vocabulary (ADR-071 §8)
//
// Lives here rather than in a widget so the three S4b slices colour and grade
// the same thing the same way: a provider that was blue in the summary and
// green in the breakdown would read as two providers.
// ---------------------------------------------------------------------------

/**
 * The five-slot categorical palette, in FIXED order (ADR-071 §8).
 *
 * Validated against the `#111318` card surface (`--color-bg-secondary`) with
 * the dataviz validator: lightness band, chroma floor, contrast and CVD all
 * pass, worst adjacent pair ΔE 8.4 (protan). Slots are assigned by provider
 * identity and never by rank, so narrowing the range or dropping a provider
 * cannot repaint the survivors.
 */
export const PROVIDER_SERIES_COLORS = [
  '#3987e5',
  '#d95926',
  '#199e70',
  '#c98500',
  '#d55181'
] as const

/**
 * Providers that always take the same slot whatever else the ledger holds, so
 * Anthropic is the same blue on a profile that has never run anything else.
 */
const PINNED_PROVIDER_ORDER = ['anthropic', 'openai']

/**
 * The sixth provider onward. Five slots is what was validated; a generated hue
 * would be an unvalidated guess, so the tail shares one neutral and relies on
 * the direct label every surface already draws beside its mark.
 */
export const PROVIDER_OVERFLOW_COLOR = '#8b929e'

/** Provider id → its fixed colour, pinned providers first and the rest as given. */
export function buildProviderColorMap(providerIds: readonly string[]): Map<string, string> {
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const id of [...PINNED_PROVIDER_ORDER, ...providerIds]) {
    if (!providerIds.includes(id) || seen.has(id)) continue
    seen.add(id)
    ordered.push(id)
  }
  const map = new Map<string, string>()
  ordered.forEach((id, i) => map.set(id, PROVIDER_SERIES_COLORS[i] ?? PROVIDER_OVERFLOW_COLOR))
  return map
}

/** How close to its ceiling a limit window is. */
export type MeterSeverity = 'ok' | 'warn' | 'crit'

export function meterSeverity(usedPercent: number): MeterSeverity {
  if (usedPercent >= 90) return 'crit'
  if (usedPercent >= 70) return 'warn'
  return 'ok'
}

/**
 * Severity never rests on colour alone: every meter ships the icon AND the
 * percent beside its fill, so a CVD reader, a greyscale screenshot and a
 * forced-colours theme all still read the state.
 */
export const SEVERITY_ICON: Record<MeterSeverity, string> = {
  ok: '●',
  warn: '⚠',
  crit: '⛔'
}

/**
 * Theme tokens rather than the mockup's literals: the app has three themes and
 * a meter drawn in a hard-coded amber is unreadable in two of them.
 */
export const SEVERITY_FILL_CLASS: Record<MeterSeverity, string> = {
  ok: 'bg-accent',
  warn: 'bg-warning',
  crit: 'bg-danger'
}

/**
 * When a window comes back, relative to now — `in 1h 48m`, `now` for one that
 * has already turned over, `—` when the vendor reported no reset at all.
 */
export function formatResetRelative(resetsAt: string | null | undefined, now = Date.now()): string {
  if (!resetsAt) return '—'
  const at = Date.parse(resetsAt)
  if (!Number.isFinite(at)) return '—'
  const ms = at - now
  if (ms <= 0) return 'now'
  return `in ${formatDuration(ms)}`
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** A weekly window kind: `7d`, or a per-model bucket like `7d:fable`. */
function isWeeklyKind(kind: string): boolean {
  return kind === '7d' || kind.startsWith('7d:')
}

/**
 * When a window comes back, in the form that kind of window is ACTED on.
 *
 * A 5-hour window turns over inside a working session, so the useful fact is
 * how long the wait is (`in 1h 48m`). A weekly one is days away, where a
 * duration ("in 6d 3h") is arithmetic the reader has to finish; the weekday and
 * clock time (`Thu 09:00`, 24-hour, the viewer's zone) is the fact they can
 * plan around. The relative form stays available for the tooltip.
 */
export function formatReset(
  kind: string,
  resetsAt: string | null | undefined,
  now = Date.now()
): string {
  if (!resetsAt) return '—'
  const at = Date.parse(resetsAt)
  if (!Number.isFinite(at)) return '—'
  if (!isWeeklyKind(kind)) return formatResetRelative(resetsAt, now)
  const d = new Date(at)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${WEEKDAY_NAMES[d.getDay()]} ${hh}:${mm}`
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

/**
 * A colour per series for the groupings the fixed provider map cannot cover —
 * engines and models, which have no pinned slot and no shared identity across
 * profiles.
 *
 * Slots are assigned in the ids' LEXICOGRAPHIC order rather than in the order
 * the data happens to arrive. The dashboard's lists are sorted by spend, so a
 * first-seen assignment would be a rank assignment: narrowing the range until
 * one model overtook another would swap their colours, which is the one thing
 * ADR-071 §8 says categorical colour must never do. Sorted ids are stable
 * against every filter, and the sixth series onward shares the overflow neutral
 * exactly as the provider map does.
 */
export function buildSeriesColorMap(ids: readonly string[]): Map<string, string> {
  const ordered = [...new Set(ids)].sort()
  const map = new Map<string, string>()
  ordered.forEach((id, i) => map.set(id, PROVIDER_SERIES_COLORS[i] ?? PROVIDER_OVERFLOW_COLOR))
  return map
}

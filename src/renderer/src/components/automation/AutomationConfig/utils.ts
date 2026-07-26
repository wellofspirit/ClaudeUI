import { CronExpressionParser } from 'cron-parser'
import type { Automation, AutomationSchedule } from '../../../../../shared/types'

export const SCHEDULE_PRESETS = [
  { label: 'Every 15 min', ms: 15 * 60 * 1000 },
  { label: 'Every 30 min', ms: 30 * 60 * 1000 },
  { label: 'Every hour', ms: 60 * 60 * 1000 },
  { label: 'Every 3 hours', ms: 3 * 60 * 60 * 1000 },
  { label: 'Every 6 hours', ms: 6 * 60 * 60 * 1000 },
  { label: 'Every 12 hours', ms: 12 * 60 * 60 * 1000 },
  { label: 'Every day', ms: 24 * 60 * 60 * 1000 }
]

export const PERMISSION_TEMPLATES = [
  'Bash(command:*)',
  'Read',
  'Grep',
  'Glob',
  'WebFetch',
  'WebSearch',
  'Edit',
  'Write',
  'Bash(command:git*)',
  'Agent'
]

export const PERMISSION_MODES = [
  { value: 'default', label: 'Default', description: 'Deny tools that require approval' },
  {
    value: 'auto',
    label: 'Auto',
    description: 'Auto-classify tool calls and reject dangerous ones'
  }
] as const

export interface DirtyCheckInput {
  name: string
  prompt: string
  cwd: string
  schedule: unknown
  model: string
  effort: string
  thinkingMode: string
  permissionMode: string
  allowRules: string[]
  denyRules: string[]
}

export function isAutomationDirty(current: DirtyCheckInput, original: Automation): boolean {
  return (
    current.name !== original.name ||
    current.prompt !== original.prompt ||
    current.cwd !== original.cwd ||
    JSON.stringify(current.schedule) !== JSON.stringify(original.schedule) ||
    (current.model || '') !== (original.model || '') ||
    (current.effort || '') !== (original.effort || '') ||
    (current.thinkingMode || '') !== (original.thinkingMode || '') ||
    (current.permissionMode || 'auto') !== (original.permissionMode || 'auto') ||
    JSON.stringify(current.allowRules) !== JSON.stringify(original.permissions.allow) ||
    JSON.stringify(current.denyRules) !== JSON.stringify(original.permissions.deny)
  )
}

// ── Schedule helpers ────────────────────────────────────────────────

export type IntervalUnit = 'minutes' | 'hours' | 'days'

const MS_PER_MINUTE = 60_000
const MS_PER_HOUR = 3_600_000
const MS_PER_DAY = 86_400_000

export function unitMultiplier(u: IntervalUnit): number {
  if (u === 'days') return MS_PER_DAY
  if (u === 'hours') return MS_PER_HOUR
  return MS_PER_MINUTE
}

/**
 * Upper bound for interval schedules. The scheduler chains setTimeouts past the
 * 32-bit clamp (~24.85 days), so long intervals are safe to persist; this cap
 * (1 year) is belt-and-braces against absurd inputs that would otherwise
 * overflow or make the next-run preview meaningless.
 */
export const MAX_INTERVAL_MS = 365 * MS_PER_DAY

/** Clamp an interval to [1 minute, MAX_INTERVAL_MS]. */
export function clampIntervalMs(ms: number): number {
  return Math.min(Math.max(MS_PER_MINUTE, Math.floor(ms) || MS_PER_MINUTE), MAX_INTERVAL_MS)
}

/** Pick the largest unit that divides `ms` cleanly; falls back to minutes. */
export function naturalUnit(ms: number): IntervalUnit {
  if (ms > 0 && ms % MS_PER_DAY === 0) return 'days'
  if (ms > 0 && ms % MS_PER_HOUR === 0) return 'hours'
  return 'minutes'
}

/** Compute the upcoming run times for a schedule, N runs ahead. */
export function computeNextRuns(
  schedule: AutomationSchedule,
  lastRunAt: number | null,
  count: number,
  now: number = Date.now()
): Date[] {
  try {
    if (schedule.type === 'cron') {
      if (!schedule.cronExpression) return []
      const it = CronExpressionParser.parse(schedule.cronExpression, { currentDate: new Date(now) })
      const out: Date[] = []
      for (let i = 0; i < count; i++) out.push(it.next().toDate())
      return out
    }
    const ms = schedule.intervalMs ?? 0
    if (ms === 0) return []
    // Anchor to lastRunAt when the next tick is still in the future; else start from now.
    const anchor = lastRunAt && lastRunAt + ms > now ? lastRunAt : now
    const out: Date[] = []
    for (let i = 1; i <= count; i++) out.push(new Date(anchor + i * ms))
    return out
  } catch {
    return []
  }
}

/** Short "every 15m" / "every 3h" / "every 2d" / cron expression readback. */
export function formatScheduleSummary(schedule: AutomationSchedule): string {
  if (schedule.type === 'cron') return `cron · ${schedule.cronExpression || '(unset)'}`
  const ms = schedule.intervalMs ?? 0
  if (ms === 0) return 'no interval'
  const mins = Math.round(ms / MS_PER_MINUTE)
  if (mins < 60) return `every ${mins}m`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `every ${hours}h`
  const days = Math.round(hours / 24)
  return `every ${days}d`
}

/** Even shorter form used in the list sidebar (no "cron ·" prefix). */
export function formatScheduleHint(schedule: AutomationSchedule): string {
  if (schedule.type === 'cron') return schedule.cronExpression || 'cron'
  const ms = schedule.intervalMs ?? 0
  if (ms === 0) return ''
  const mins = Math.round(ms / MS_PER_MINUTE)
  if (mins < 60) return `every ${mins}m`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `every ${hours}h`
  const days = Math.round(hours / 24)
  return `every ${days}d`
}

/** Compact "3m" / "12h" / "2d" delta for countdowns. */
export function formatTimeDelta(ms: number): string {
  if (ms <= 0) return 'soon'
  if (ms < MS_PER_MINUTE) return '<1m'
  if (ms < MS_PER_HOUR) return `${Math.round(ms / MS_PER_MINUTE)}m`
  if (ms < MS_PER_DAY) return `${Math.round(ms / MS_PER_HOUR)}h`
  return `${Math.round(ms / MS_PER_DAY)}d`
}

// ── Status derivation ──────────────────────────────────────────────

export type StatusKind = 'running' | 'active' | 'disabled' | 'failed'

export function deriveStatus(input: {
  enabled: boolean
  hasRunningRun: boolean
  lastRunStatus: Automation['lastRunStatus']
}): StatusKind {
  if (input.hasRunningRun) return 'running'
  if (!input.enabled) return 'disabled'
  if (input.lastRunStatus === 'error') return 'failed'
  return 'active'
}

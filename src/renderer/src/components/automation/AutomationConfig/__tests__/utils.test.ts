import { describe, it, expect } from 'vitest'
import {
  isAutomationDirty, SCHEDULE_PRESETS, PERMISSION_TEMPLATES, PERMISSION_MODES,
  unitMultiplier, naturalUnit, computeNextRuns,
  formatScheduleSummary, formatScheduleHint, formatTimeDelta,
  deriveStatus,
} from '../utils'
import type { Automation } from '../../../../../../shared/types'

function baseAutomation(): Automation {
  return {
    id: 'a1',
    name: 'Test',
    prompt: 'do stuff',
    cwd: '/tmp',
    schedule: { type: 'interval', intervalMs: 3600000 },
    model: 'sonnet',
    effort: 'medium',
    permissions: { allow: ['Read'], deny: [] },
    enabled: true,
    lastRunAt: null,
    lastRunStatus: null,
    createdAt: Date.now()
  }
}

describe('isAutomationDirty', () => {
  it('returns false when nothing changed', () => {
    const auto = baseAutomation()
    expect(isAutomationDirty({
      name: auto.name, prompt: auto.prompt, cwd: auto.cwd,
      schedule: auto.schedule, model: auto.model || '', effort: auto.effort || '',
      thinkingMode: auto.thinkingMode || '',
      permissionMode: auto.permissionMode || 'auto',
      allowRules: auto.permissions.allow, denyRules: auto.permissions.deny
    }, auto)).toBe(false)
  })

  it('detects name change', () => {
    const auto = baseAutomation()
    expect(isAutomationDirty({
      name: 'Changed', prompt: auto.prompt, cwd: auto.cwd,
      schedule: auto.schedule, model: auto.model || '', effort: auto.effort || '',
      thinkingMode: auto.thinkingMode || '',
      permissionMode: auto.permissionMode || 'auto',
      allowRules: auto.permissions.allow, denyRules: auto.permissions.deny
    }, auto)).toBe(true)
  })

  it('detects schedule change', () => {
    const auto = baseAutomation()
    expect(isAutomationDirty({
      name: auto.name, prompt: auto.prompt, cwd: auto.cwd,
      schedule: { type: 'cron', cronExpression: '0 * * * *' },
      model: auto.model || '', effort: auto.effort || '',
      thinkingMode: auto.thinkingMode || '',
      permissionMode: auto.permissionMode || 'auto',
      allowRules: auto.permissions.allow, denyRules: auto.permissions.deny
    }, auto)).toBe(true)
  })

  it('detects permission change', () => {
    const auto = baseAutomation()
    expect(isAutomationDirty({
      name: auto.name, prompt: auto.prompt, cwd: auto.cwd,
      schedule: auto.schedule, model: auto.model || '', effort: auto.effort || '',
      thinkingMode: auto.thinkingMode || '',
      permissionMode: auto.permissionMode || 'auto',
      allowRules: ['Read', 'Write'], denyRules: auto.permissions.deny
    }, auto)).toBe(true)
  })

  it('treats empty model and undefined model as equal', () => {
    const auto = { ...baseAutomation(), model: undefined }
    expect(isAutomationDirty({
      name: auto.name, prompt: auto.prompt, cwd: auto.cwd,
      schedule: auto.schedule, model: '', effort: auto.effort || '',
      thinkingMode: auto.thinkingMode || '',
      permissionMode: auto.permissionMode || 'auto',
      allowRules: auto.permissions.allow, denyRules: auto.permissions.deny
    }, auto)).toBe(false)
  })

  it('detects permissionMode change', () => {
    const auto = { ...baseAutomation(), permissionMode: 'auto' as const }
    expect(isAutomationDirty({
      name: auto.name, prompt: auto.prompt, cwd: auto.cwd,
      schedule: auto.schedule, model: auto.model || '', effort: auto.effort || '',
      thinkingMode: auto.thinkingMode || '',
      permissionMode: 'default',
      allowRules: auto.permissions.allow, denyRules: auto.permissions.deny
    }, auto)).toBe(true)
  })

  it('treats undefined permissionMode and auto as equal', () => {
    const auto = baseAutomation() // permissionMode is undefined
    expect(isAutomationDirty({
      name: auto.name, prompt: auto.prompt, cwd: auto.cwd,
      schedule: auto.schedule, model: auto.model || '', effort: auto.effort || '',
      thinkingMode: auto.thinkingMode || '',
      permissionMode: 'auto',
      allowRules: auto.permissions.allow, denyRules: auto.permissions.deny
    }, auto)).toBe(false)
  })

  it('detects thinkingMode change', () => {
    const auto = baseAutomation()
    expect(isAutomationDirty({
      name: auto.name, prompt: auto.prompt, cwd: auto.cwd,
      schedule: auto.schedule, model: auto.model || '', effort: auto.effort || '',
      thinkingMode: 'adaptive',
      permissionMode: auto.permissionMode || 'auto',
      allowRules: auto.permissions.allow, denyRules: auto.permissions.deny
    }, auto)).toBe(true)
  })
})

describe('constants', () => {
  it('SCHEDULE_PRESETS has expected entries', () => {
    expect(SCHEDULE_PRESETS.length).toBeGreaterThan(0)
    expect(SCHEDULE_PRESETS[0]).toHaveProperty('label')
    expect(SCHEDULE_PRESETS[0]).toHaveProperty('ms')
  })

  it('PERMISSION_TEMPLATES has common tools', () => {
    expect(PERMISSION_TEMPLATES).toContain('Read')
    expect(PERMISSION_TEMPLATES).toContain('Edit')
    expect(PERMISSION_TEMPLATES).toContain('Write')
  })

  it('PERMISSION_MODES has default and auto', () => {
    const values = PERMISSION_MODES.map((m) => m.value)
    expect(values).toContain('default')
    expect(values).toContain('auto')
  })
})

describe('interval unit helpers', () => {
  it('unitMultiplier returns correct ms-per-unit', () => {
    expect(unitMultiplier('minutes')).toBe(60_000)
    expect(unitMultiplier('hours')).toBe(3_600_000)
    expect(unitMultiplier('days')).toBe(86_400_000)
  })

  it('naturalUnit picks largest clean divisor', () => {
    expect(naturalUnit(15 * 60_000)).toBe('minutes')
    expect(naturalUnit(60 * 60_000)).toBe('hours') // 1h divides both
    expect(naturalUnit(24 * 60 * 60_000)).toBe('days')
    expect(naturalUnit(3 * 24 * 60 * 60_000)).toBe('days')
  })

  it('naturalUnit falls back to minutes for non-clean values', () => {
    expect(naturalUnit(7 * 60_000)).toBe('minutes')
    expect(naturalUnit(90 * 60_000)).toBe('minutes') // 90m = 1.5h, not clean hours
    expect(naturalUnit(0)).toBe('minutes')
  })
})

describe('computeNextRuns', () => {
  const NOW = Date.parse('2026-04-22T22:00:00Z')

  it('returns empty array for unset cron expression', () => {
    expect(computeNextRuns({ type: 'cron' }, null, 4, NOW)).toEqual([])
  })

  it('returns empty array for invalid cron expression', () => {
    expect(computeNextRuns({ type: 'cron', cronExpression: 'not a cron' }, null, 4, NOW)).toEqual([])
  })

  it('parses */15 * * * * as 15-minute intervals', () => {
    const runs = computeNextRuns({ type: 'cron', cronExpression: '*/15 * * * *' }, null, 4, NOW)
    expect(runs).toHaveLength(4)
    // Deltas between consecutive runs should all be 15 minutes.
    for (let i = 1; i < runs.length; i++) {
      expect(runs[i].getTime() - runs[i - 1].getTime()).toBe(15 * 60_000)
    }
  })

  it('returns empty array for zero/missing interval', () => {
    expect(computeNextRuns({ type: 'interval' }, null, 4, NOW)).toEqual([])
    expect(computeNextRuns({ type: 'interval', intervalMs: 0 }, null, 4, NOW)).toEqual([])
  })

  it('anchors interval to now when no lastRunAt', () => {
    const runs = computeNextRuns({ type: 'interval', intervalMs: 60_000 }, null, 3, NOW)
    expect(runs.map((d) => d.getTime())).toEqual([NOW + 60_000, NOW + 120_000, NOW + 180_000])
  })

  it('anchors interval to lastRunAt when next tick is in the future', () => {
    const lastRun = NOW - 5 * 60_000 // 5 min ago
    const runs = computeNextRuns({ type: 'interval', intervalMs: 15 * 60_000 }, lastRun, 2, NOW)
    // next tick = lastRun + 15m = NOW + 10m (still future → anchor to lastRun)
    expect(runs[0].getTime()).toBe(lastRun + 15 * 60_000)
    expect(runs[1].getTime()).toBe(lastRun + 30 * 60_000)
  })

  it('falls back to now when lastRunAt + interval is already past', () => {
    const lastRun = NOW - 20 * 60_000 // 20 min ago, interval 15 → already missed
    const runs = computeNextRuns({ type: 'interval', intervalMs: 15 * 60_000 }, lastRun, 1, NOW)
    expect(runs[0].getTime()).toBe(NOW + 15 * 60_000)
  })
})

describe('formatScheduleSummary', () => {
  it('describes intervals with largest sensible unit', () => {
    expect(formatScheduleSummary({ type: 'interval', intervalMs: 15 * 60_000 })).toBe('every 15m')
    expect(formatScheduleSummary({ type: 'interval', intervalMs: 3 * 3_600_000 })).toBe('every 3h')
    expect(formatScheduleSummary({ type: 'interval', intervalMs: 2 * 86_400_000 })).toBe('every 2d')
  })

  it('handles cron with and without expression', () => {
    expect(formatScheduleSummary({ type: 'cron', cronExpression: '0 * * * *' })).toBe('cron · 0 * * * *')
    expect(formatScheduleSummary({ type: 'cron' })).toBe('cron · (unset)')
  })

  it('handles zero/missing interval', () => {
    expect(formatScheduleSummary({ type: 'interval' })).toBe('no interval')
    expect(formatScheduleSummary({ type: 'interval', intervalMs: 0 })).toBe('no interval')
  })
})

describe('formatScheduleHint', () => {
  it('shows cron expression raw (no "cron ·" prefix)', () => {
    expect(formatScheduleHint({ type: 'cron', cronExpression: '*/15 * * * *' })).toBe('*/15 * * * *')
    expect(formatScheduleHint({ type: 'cron' })).toBe('cron')
  })

  it('matches formatScheduleSummary for intervals', () => {
    expect(formatScheduleHint({ type: 'interval', intervalMs: 15 * 60_000 })).toBe('every 15m')
    expect(formatScheduleHint({ type: 'interval', intervalMs: 0 })).toBe('')
  })
})

describe('formatTimeDelta', () => {
  it('returns "soon" for non-positive deltas', () => {
    expect(formatTimeDelta(0)).toBe('soon')
    expect(formatTimeDelta(-1000)).toBe('soon')
  })

  it('returns compact unit-based strings', () => {
    expect(formatTimeDelta(30_000)).toBe('<1m')
    expect(formatTimeDelta(3 * 60_000)).toBe('3m')
    expect(formatTimeDelta(5 * 3_600_000)).toBe('5h')
    expect(formatTimeDelta(2 * 86_400_000)).toBe('2d')
  })
})

describe('deriveStatus', () => {
  it('running wins over everything else', () => {
    expect(deriveStatus({ enabled: false, hasRunningRun: true, lastRunStatus: 'error' })).toBe('running')
  })

  it('disabled when not enabled and not running', () => {
    expect(deriveStatus({ enabled: false, hasRunningRun: false, lastRunStatus: 'success' })).toBe('disabled')
  })

  it('failed when enabled and last run errored', () => {
    expect(deriveStatus({ enabled: true, hasRunningRun: false, lastRunStatus: 'error' })).toBe('failed')
  })

  it('active when enabled, idle, and no recent failure', () => {
    expect(deriveStatus({ enabled: true, hasRunningRun: false, lastRunStatus: 'success' })).toBe('active')
    expect(deriveStatus({ enabled: true, hasRunningRun: false, lastRunStatus: null })).toBe('active')
  })
})

import { describe, it, expect } from 'vitest'
import { isAutomationDirty, SCHEDULE_PRESETS, EFFORT_LEVELS, PERMISSION_TEMPLATES } from '../utils'
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
      schedule: auto.schedule, model: auto.model || '', effort: auto.effort || 'medium',
      allowRules: auto.permissions.allow, denyRules: auto.permissions.deny
    }, auto)).toBe(false)
  })

  it('detects name change', () => {
    const auto = baseAutomation()
    expect(isAutomationDirty({
      name: 'Changed', prompt: auto.prompt, cwd: auto.cwd,
      schedule: auto.schedule, model: auto.model || '', effort: auto.effort || 'medium',
      allowRules: auto.permissions.allow, denyRules: auto.permissions.deny
    }, auto)).toBe(true)
  })

  it('detects schedule change', () => {
    const auto = baseAutomation()
    expect(isAutomationDirty({
      name: auto.name, prompt: auto.prompt, cwd: auto.cwd,
      schedule: { type: 'cron', cronExpression: '0 * * * *' },
      model: auto.model || '', effort: auto.effort || 'medium',
      allowRules: auto.permissions.allow, denyRules: auto.permissions.deny
    }, auto)).toBe(true)
  })

  it('detects permission change', () => {
    const auto = baseAutomation()
    expect(isAutomationDirty({
      name: auto.name, prompt: auto.prompt, cwd: auto.cwd,
      schedule: auto.schedule, model: auto.model || '', effort: auto.effort || 'medium',
      allowRules: ['Read', 'Write'], denyRules: auto.permissions.deny
    }, auto)).toBe(true)
  })

  it('treats empty model and undefined model as equal', () => {
    const auto = { ...baseAutomation(), model: undefined }
    expect(isAutomationDirty({
      name: auto.name, prompt: auto.prompt, cwd: auto.cwd,
      schedule: auto.schedule, model: '', effort: auto.effort || 'medium',
      allowRules: auto.permissions.allow, denyRules: auto.permissions.deny
    }, auto)).toBe(false)
  })
})

describe('constants', () => {
  it('SCHEDULE_PRESETS has expected entries', () => {
    expect(SCHEDULE_PRESETS.length).toBeGreaterThan(0)
    expect(SCHEDULE_PRESETS[0]).toHaveProperty('label')
    expect(SCHEDULE_PRESETS[0]).toHaveProperty('ms')
  })

  it('EFFORT_LEVELS has 3 levels', () => {
    expect(EFFORT_LEVELS).toEqual(['low', 'medium', 'high'])
  })

  it('PERMISSION_TEMPLATES has common tools', () => {
    expect(PERMISSION_TEMPLATES).toContain('Read')
    expect(PERMISSION_TEMPLATES).toContain('Edit')
    expect(PERMISSION_TEMPLATES).toContain('Write')
  })
})

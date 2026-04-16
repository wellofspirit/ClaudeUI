import type { Automation } from '../../../../../shared/types'

export const EFFORT_LEVELS = ['low', 'medium', 'high'] as const

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

export interface DirtyCheckInput {
  name: string
  prompt: string
  cwd: string
  schedule: unknown
  model: string
  effort: string
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
    (current.effort || 'medium') !== (original.effort || 'medium') ||
    JSON.stringify(current.allowRules) !== JSON.stringify(original.permissions.allow) ||
    JSON.stringify(current.denyRules) !== JSON.stringify(original.permissions.deny)
  )
}

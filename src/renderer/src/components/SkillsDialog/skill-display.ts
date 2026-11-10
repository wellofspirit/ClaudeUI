import type { SkillInfo, SkillSource } from '../../../../shared/types'

/** Group order shared by the desktop and mobile views (bundled last: nothing emits it today). */
export const SKILL_SOURCE_ORDER: SkillSource[] = [
  'managed',
  'project',
  'user',
  'plugin',
  'engine',
  'bundled'
]

/**
 * The short tags a skill row / detail header carries. `command` marks a legacy
 * `.claude/commands` entry; the two flags appear only when explicitly false (an absent
 * flag, as on an engine's own skill, says nothing).
 */
export function skillTags(skill: SkillInfo): { id: string; label: string; title: string }[] {
  const tags: { id: string; label: string; title: string }[] = []
  if (skill.kind === 'command') {
    tags.push({ id: 'command', label: 'Command', title: 'A legacy .claude/commands entry' })
  }
  if (skill.userInvocable === false) {
    tags.push({
      id: 'not-user-invocable',
      label: 'Not user-invocable',
      title: 'Cannot be typed as a /command'
    })
  }
  if (skill.modelInvocable === false) {
    tags.push({
      id: 'not-model-invocable',
      label: 'Not model-invocable',
      title: 'Not offered to the model'
    })
  }
  return tags
}

/**
 * The note for a catalog entry that uses Claude-only behaviour this session's engine
 * does not apply (`claudeOnly` is only filled for non-Claude sessions), or null.
 */
export function claudeOnlyNote(skill: SkillInfo): string | null {
  if (!skill.claudeOnly || skill.claudeOnly.length === 0) return null
  return `Claude-only, not applied in this session: ${skill.claudeOnly.join(', ')}`
}

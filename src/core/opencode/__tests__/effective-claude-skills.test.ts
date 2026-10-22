import { expect, it } from 'vitest'
import type { ClaudeSkillCatalog } from '../../skills/claude-skills'
import { expandClaudeSkillInvocation } from '../../skills/claude-skills'
import { effectiveClaudeSkillCatalog } from '../effective-claude-skills'

it('uses only exact policy-visible shared rows for host expansion', () => {
  const catalog: ClaudeSkillCatalog = {
    skills: ['allowed', 'denied'].map((name) => ({
      name,
      path: `/project/.claude/skills/${name}/SKILL.md`,
      directory: `/project/.claude/skills/${name}`,
      description: name,
      content: `BODY_${name}`,
      source: 'project' as const,
      userInvocable: true,
      modelInvocable: true,
      compatibilityWarnings: []
    })),
    warnings: [],
    revision: ''
  }
  const effective = effectiveClaudeSkillCatalog(catalog, [
    {
      id: 'allowed',
      name: 'allowed',
      path: '/project/.claude/skills/allowed/SKILL.md',
      content: 'BODY_allowed'
    },
    {
      id: 'denied',
      name: 'denied',
      path: '/some/other/source/SKILL.md',
      content: 'BODY_denied'
    }
  ])
  expect(effective.skills.map((skill) => skill.name)).toEqual(['allowed'])
  expect(expandClaudeSkillInvocation('/allowed', effective)?.text).toContain('BODY_allowed')
  expect(expandClaudeSkillInvocation('/denied', effective)).toBeNull()
})

import type { ClaudeSkillCatalog } from '../skills/claude-skills'
import type { Skill_Info } from './protocol-v2/openapi'

/** The server's final skill list has already passed OpenCode's native policy. */
export function effectiveClaudeSkillCatalog(
  catalog: ClaudeSkillCatalog,
  exposed: readonly Skill_Info[]
): ClaudeSkillCatalog {
  return {
    ...catalog,
    skills: catalog.skills.filter((selected) =>
      exposed.some(
        (skill) =>
          skill.name === selected.name &&
          skill.path === selected.path &&
          skill.content === selected.content
      )
    )
  }
}

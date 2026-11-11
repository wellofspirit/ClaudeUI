// ---------------------------------------------------------------------------
// Skill types (skills management dialog)
// ---------------------------------------------------------------------------

/**
 * `managed`/`user`/`project`/`plugin` = the shared Claude skill catalog's sources;
 * `engine` = a skill the session's own engine loads itself (opencode's `.opencode` / `.agents`
 * folders, pi's `~/.pi` / `.pi` / `.agents` folders, built-ins).
 */
export type SkillSource = 'managed' | 'project' | 'user' | 'plugin' | 'bundled' | 'engine'

export interface SkillInfo {
  name: string
  displayName?: string
  description: string
  source: SkillSource
  pluginName?: string
  path: string // filesystem path to SKILL.md (empty for bundled)
  content: string // markdown body (no frontmatter)
  /** `command` = a legacy `.claude/commands` entry; absent = skill. */
  kind?: 'skill' | 'command'
  /** False: the user cannot type `/name` (frontmatter `user-invocable: false`). */
  userInvocable?: boolean
  /** False: hidden from the model (`disable-model-invocation`, `skillOverrides`). */
  modelInvocable?: boolean
  /** Claude-only behaviour this session's engine does not apply (non-Claude sessions only). */
  claudeOnly?: string[]
}

/**
 * The shared Claude skill catalog as pi sees it: `Skill`-shaped descriptors the bridge
 * extension's `before_agent_start` handler appends to pi's system-prompt skill listing
 * (`BeforeAgentStartEventBase.systemPromptOptions.skills`), served by `PiBridgeHost`'s
 * `POST /skills`. pi reads the SKILL.md itself when the model asks for it, so a descriptor
 * carries the path, not the body. Rules: docs/architecture/skill-catalog.md.
 */
import { dirname } from 'path'
import type { ClaudeSkillCatalog } from '../services/claude-skill-catalog'

export interface PiSkillDescriptor {
  /** Claude's name (`plugin:skill` for a plugin's). */
  name: string
  description: string
  /** Absolute path of the SKILL.md / command .md. */
  filePath: string
  /** The skill's directory (a plain `.md` command: its parent). */
  baseDir: string
}

/** Longest description the listing carries. */
export const PI_SKILL_DESCRIPTION_MAX = 1536

/** The catalog's model-invocable entries, as descriptors (description + ' - ' + whenToUse, cut with '…'). */
export function buildPiSkillDescriptors(catalog: ClaudeSkillCatalog): PiSkillDescriptor[] {
  const out: PiSkillDescriptor[] = []
  for (const entry of catalog.entries) {
    if (!entry.modelInvocable) continue
    let description = entry.whenToUse
      ? `${entry.description ? `${entry.description} - ` : ''}${entry.whenToUse}`
      : entry.description
    if (description.length > PI_SKILL_DESCRIPTION_MAX) {
      description = `${description.slice(0, PI_SKILL_DESCRIPTION_MAX - 1)}…`
    }
    out.push({
      name: entry.name,
      description,
      filePath: entry.file,
      baseDir: entry.baseDir ?? dirname(entry.file)
    })
  }
  return out
}

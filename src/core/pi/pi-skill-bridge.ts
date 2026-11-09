/**
 * The shared Claude skill catalog as pi sees it: `Skill`-shaped descriptors the bridge
 * extension's `before_agent_start` handler appends to pi's system-prompt skill listing
 * (`BeforeAgentStartEventBase.systemPromptOptions.skills`), served by `PiBridgeHost`'s
 * `POST /skills`. pi reads the SKILL.md itself when the model asks for it, so a descriptor
 * carries the path, not the body. Rules: docs/architecture/skill-catalog.md.
 */
import { dirname } from 'path'
import { skillListingDescription, type ClaudeSkillCatalog } from '../services/claude-skill-catalog'

export interface PiSkillDescriptor {
  /** Claude's name (`plugin:skill` for a plugin's). */
  name: string
  description: string
  /** Absolute path of the SKILL.md / command .md. */
  filePath: string
  /** The skill's directory (a plain `.md` command: its parent). */
  baseDir: string
}

/** The catalog's model-invocable entries, as descriptors listed with cli.js's description text. */
export function buildPiSkillDescriptors(catalog: ClaudeSkillCatalog): PiSkillDescriptor[] {
  return catalog.entries
    .filter((entry) => entry.modelInvocable)
    .map((entry) => ({
      name: entry.name,
      description: skillListingDescription(entry),
      filePath: entry.file,
      baseDir: entry.baseDir ?? dirname(entry.file)
    }))
}

import { isAbsolute, resolve } from 'node:path'
import { expandClaudeSkillInvocation, type ClaudeSkillCatalog } from '../skills/claude-skills'
import type { PiCommandEntry } from './pi-protocol'

function normalized(file: string): string {
  const path = resolve(file).replaceAll('\\', '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? path.toLowerCase() : path
}

/** The native registry tells us which names Pi can expand from Claude roots. */
export function blockedNativeClaudeSkillNames(
  commands: PiCommandEntry[],
  catalog: ClaudeSkillCatalog
): Set<string> {
  for (const entry of commands) {
    if (!entry || typeof entry !== 'object') throw new Error('Invalid Pi command entry')
    if (typeof entry.name !== 'string' || !entry.name) throw new Error('Invalid Pi command name')
    if (!['skill', 'prompt', 'extension'].includes(entry.source))
      throw new Error('Invalid Pi command source')
    if (
      entry.source === 'skill' &&
      (typeof entry.sourceInfo?.path !== 'string' ||
        !entry.sourceInfo.path ||
        !isAbsolute(entry.sourceInfo.path))
    )
      throw new Error('Invalid Pi skill command path')
  }
  const roots = (catalog.sourceRoots ?? []).map(normalized)
  const invocable = new Set(
    catalog.skills
      .filter((skill) => skill.userInvocable)
      .flatMap((skill) => [skill.name, ...(skill.aliases ?? [])])
  )
  return new Set(
    commands
      .filter((command) => {
        if (command.source !== 'skill' || !command.sourceInfo?.path) return false
        const file = normalized(command.sourceInfo.path)
        return roots.some((root) => file === root || file.startsWith(root + '/'))
      })
      .map((command) => command.name.replace(/^skill:/, ''))
      .filter((name) => !invocable.has(name))
  )
}

/** Pi expands /skill:name from its resource loader before before_agent_start runs. */
export function unavailableClaudeSkillCommand(
  prompt: string,
  catalog: ClaudeSkillCatalog,
  blockedNativeNames: ReadonlySet<string>,
  nativeCommandsVerified: boolean
): string | null {
  if (!prompt.startsWith('/skill:')) return null
  // Pi's _expandSkillCommand takes everything through the first literal space.
  // Tabs, slashes and Unicode are part of the name, not delimiters.
  const space = prompt.indexOf(' ')
  const name = space === -1 ? prompt.slice(7) : prompt.slice(7, space)
  const selected =
    catalog.skills.find((skill) => skill.name === name) ??
    catalog.skills.find((skill) => skill.aliases?.includes(name))
  if (selected) {
    if (!selected.userInvocable || !expandClaudeSkillInvocation(prompt, catalog)) return name
    return null
  }
  if (blockedNativeNames.has(name) || !nativeCommandsVerified) return name
  return null
}

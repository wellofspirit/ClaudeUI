/**
 * Catalog entries as the shapes the UI consumes: `SkillInfo` (Skills dialog) and
 * `SlashCommandInfo` (slash menu). The one place every engine session maps
 * `resolveClaudeSkillCatalog` output, so the dialog and the menu agree across engines.
 */

import type { SkillInfo, SlashCommandInfo } from '../../shared/types'
import type { ClaudeSkillEntry } from './claude-skill-catalog'

export interface SkillInfoOptions {
  /**
   * Carry `claudeOnly` (what the entry uses that the engine does not apply). Set for
   * non-Claude sessions only: a Claude session applies all of it.
   */
  includeClaudeOnly?: boolean
}

export function claudeSkillEntryToInfo(
  entry: ClaudeSkillEntry,
  options: SkillInfoOptions = {}
): SkillInfo {
  return {
    name: entry.name,
    ...(entry.displayName ? { displayName: entry.displayName } : {}),
    description: entry.description,
    source: entry.source,
    ...(entry.pluginName ? { pluginName: entry.pluginName } : {}),
    path: entry.file,
    content: entry.body,
    kind: entry.kind,
    userInvocable: entry.userInvocable,
    modelInvocable: entry.modelInvocable,
    ...(options.includeClaudeOnly && entry.claudeOnly.length > 0
      ? { claudeOnly: entry.claudeOnly }
      : {})
  }
}

/** The catalog's typed-`/name` entries as menu items. */
export function claudeSkillSlashCommands(entries: readonly ClaudeSkillEntry[]): SlashCommandInfo[] {
  return entries
    .filter((e) => e.userInvocable)
    .map((e) => ({
      name: '/' + e.name,
      ...(e.description ? { description: e.description } : {})
    }))
}

/** `base` first and winning a name clash, then whatever `extra` adds. */
export function mergeSlashCommandLists(
  base: readonly SlashCommandInfo[],
  extra: readonly SlashCommandInfo[]
): SlashCommandInfo[] {
  const seen = new Set(base.map((c) => c.name))
  return [...base, ...extra.filter((c) => !seen.has(c.name))]
}

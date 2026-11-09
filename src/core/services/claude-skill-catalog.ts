/**
 * The skills and legacy custom commands a ClaudeUI Claude session in a cwd would load,
 * resolved host-side the way cli.js 2.1.317 resolves them, so the opencode and pi bridges
 * (and the Skills dialog / slash menu of every engine) see exactly that set.
 * Rules: docs/architecture/skill-catalog.md. Fail-soft: never throws.
 *
 * CONTRACT MODULE: the types and signatures below are fixed by the arc spec
 * (`.work/skill-catalog/spec.md` §A). Slice A replaces the stub body.
 */

import type { Env } from './claude-config-paths'

/** Where cli.js found the entry. Managed = `<managedDir>/.claude/{skills,commands}`. */
export type ClaudeSkillSource = 'managed' | 'user' | 'project' | 'plugin'

/** `skill` = a `SKILL.md` (skills dir or plugin skill); `command` = a legacy `.md` command. */
export type ClaudeSkillKind = 'skill' | 'command'

export interface ClaudeSkillEntry {
  /**
   * cli.js's internal name, the one `/name` and the Skill tool take: the directory name for a
   * skills-dir skill; `a:b` for `commands/a/b.md`; `<plugin>:<dir>` for a plugin skill;
   * `<plugin>:<ns>:<cmd>` for a plugin command.
   */
  name: string
  /** Frontmatter `name` of a skills-dir skill (cli.js's userFacingName). */
  displayName?: string
  /** Extra names cli.js resolves to this entry (a plugin skill's bare frontmatter name). */
  aliases?: string[]
  kind: ClaudeSkillKind
  source: ClaudeSkillSource
  /** `name@marketplace`, plugin entries only. */
  pluginId?: string
  /** The plugin's name (its manifest `name`, else the id's name part). */
  pluginName?: string
  /** The plugin's root directory (fills `${CLAUDE_PLUGIN_ROOT}`). */
  pluginRoot?: string
  /** Absolute path of the `SKILL.md` / command `.md`. */
  file: string
  /** The skill's directory (the file's parent) for SKILL.md entries; undefined for a plain `.md` command. */
  baseDir?: string
  /** cli.js's resolved description (frontmatter, else body fallback, else the default label); '' under `name-only`. */
  description: string
  whenToUse?: string
  argumentHint?: string
  /** Frontmatter `arguments`: names usable as `$name` placeholders. */
  argumentNames: string[]
  /** The file's body after the frontmatter block. */
  body: string
  /** Typed `/name` allowed (`user-invocable` not false). */
  userInvocable: boolean
  /** In the model's skill listing (cli.js's listing eligibility, after `skillOverrides`). */
  modelInvocable: boolean
  /**
   * Claude-only behaviour this entry uses that other engines do not apply: frontmatter keys
   * (`context`, `agent`, `allowed-tools`, `disallowed-tools`, `hooks`, `model`, `effort`,
   * `shell`, `background`) and `shell-interpolation` when the body has `!` commands.
   */
  claudeOnly: string[]
}

export interface ClaudeSkillSkip {
  /** The entry's name, or the plugin id / path when no name was formed. */
  name: string
  reason: string
}

export interface ClaudeSkillCatalog {
  /** Effective entries, first-wins by name in cli.js's precedence order. */
  entries: ClaudeSkillEntry[]
  /** Not loaded, with a reason (plugin not on disk, conditional `paths` skill, override `off`, ...). */
  skipped: ClaudeSkillSkip[]
}

export interface SkillCatalogOptions {
  env?: Env
  /** Defaults to `os.homedir()`: the project walk stops before it. */
  homeDir?: string
  platform?: NodeJS.Platform
}

export function resolveClaudeSkillCatalog(
  _cwd: string,
  _options: SkillCatalogOptions = {}
): ClaudeSkillCatalog {
  return { entries: [], skipped: [] }
}

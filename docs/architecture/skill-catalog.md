# Shared skill catalog

The skills and legacy custom commands a ClaudeUI Claude session in a cwd would load, resolved host-side so the
opencode and pi engines see exactly that set under Claude's names, the way the MCP catalog does for servers
([mcp-catalog.md](mcp-catalog.md), ADR-096). Decision: [ADR-115](../adr/shared-catalogs.md).
Built against cli.js 2.1.317; re-check the rules below on a Claude Code bump (`bump-harness`).

| Module                                          | Role                                                                                                                                                  |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/services/claude-skill-catalog.ts`     | `resolveClaudeSkillCatalog(cwd)`: sources in cli.js's order, first name wins, overrides, eligibility, plugin skills and commands; never throws        |
| `src/core/services/claude-skill-frontmatter.ts` | cli.js's frontmatter reader (BOM, lazy `---` block, YAML, the quoting retry, `{}` fallback)                                                           |
| `src/core/services/claude-skill-invoke.ts`      | `parseSkillInvocation`, `expandClaudeSkillInvocation`, `parseSkillInvocationEnvelope`: a typed `/name args` expanded as cli.js expands it             |
| `src/core/services/claude-plugins.ts`           | `listEnabledClaudePlugins(cwd, env)`: enabled plugins and their roots, plugin-variable fill-in; shared with `claude-plugin-mcp.ts` (MCP servers only) |
| `src/core/services/claude-config-paths.ts`      | Config dir, managed dir, settings layers and merge, project location (shared with the MCP catalog)                                                    |

## Where cli.js reads

Sources, in precedence order; the first entry with a name wins, and a file reached twice (by realpath) counts once:

1. **Managed skills** `<managed>/.claude/skills` (`C:\Program Files\ClaudeCode`, `/Library/Application Support/ClaudeCode`,
   `/etc/claude-code`); `CLAUDE_CODE_DISABLE_POLICY_SKILLS` turns them off.
2. **User skills** `<configDir>/skills`, a dir named `synced` skipped.
3. **Project skills** `<dir>/.claude/skills` for each dir from the cwd up to and including the git root (nearest `.git`
   file or dir), closest first; outside git, up to the filesystem root. The walk always stops before `$HOME`, so the
   home's own `.claude/skills` is never a project dir. In a linked worktree whose own root has no `.claude/skills`, the
   main checkout's is appended.
4. **Legacy commands** `<managed>/.claude/commands`, `<configDir>/commands`, `<project>/.claude/commands` (same walk and
   worktree rule).
5. **Plugin commands**, then **plugin skills**, of the enabled plugins.

`strictPluginOnlyCustomization` in the managed-settings layer (`true`, or an array containing `"skills"`) drops 2-4;
managed skills and plugins stay.

**Skills dir**: exactly `<dir>/<name>/SKILL.md` (a directory or a symlink to one; hidden dirs are not skipped; loose
`.md` files and deeper nesting are ignored), file at most 1,000,000 bytes, directory sorted by `localeCompare`. The name
is the directory name; the frontmatter `name` is only the display name (dropped above 256 chars). A skill with `paths`
that is not all-`**` is conditional (cli.js activates it when matching files are touched): it is not loaded, and the
skip says so.

**Legacy commands**: recursive `*.md` (case-sensitive suffix), symlinks followed with dev:ino cycle protection, no depth
cap, files at most 1,048,576 bytes. The name is the path under the base joined with `:` (`a/b.md` is `a:b`); the
frontmatter `name` is ignored. A directory holding a `SKILL.md` (any case) contributes only that file, named after the
directory (`a/foo/SKILL.md` is `a:foo`).

**Frontmatter**: BOM stripped, a `---` block at the very start, YAML. On a parse error the block is retried once with
simple `key: value` lines quoted when the value holds `{}[]*&#!|>%@\`` or `: `(leading tabs become two spaces); if that
fails too the frontmatter is`{}` and the body still loads.

**Fields**: `description` (trimmed; numbers and booleans stringified; else the first non-empty body line with a leading
`#` stripped, cut to 97 chars plus `...` above 100; else `Custom command` / `Plugin skill` / `Plugin command`),
`when_to_use`, `argument-hint`, `arguments` (list or whitespace-separated; numeric names dropped),
`disable-model-invocation`, `user-invocable` (default true). Names must be non-empty, at most 256 chars, free of control
characters, `<`, `>`, U+2028 and U+2029, and must not use `anthropic-skills:`.

**`skillOverrides`** (merged settings, non-plugin entries only; looked up by name, then the part after the last `:`):
the effective value is the higher-ranked of the merged value and the managed layer's (`on` < `name-only` <
`user-invocable-only` < `off`). `off` drops the entry (recorded as skipped), `name-only` empties the description (and
`whenToUse`), `user-invocable-only` makes it not model-invocable.

**Eligibility** (`modelInvocable`): not `disable-model-invocation`, not `user-invocable-only`, and for plugin entries a
user-written `description` or `when_to_use` is required. `user-invocable: false` entries are still model-invocable.

**Claude-only behaviour** (`claudeOnly`): `context: fork`, `agent`, `background`, `allowed-tools`,
`disallowed-tools` / `disallowedTools`, `hooks`, `model`, `effort`, `shell`, plus `shell-interpolation` when the body
has an inline `` !`cmd` `` (at a line start or after whitespace) or a ` ```! ` block. The dialog shows these on
engines that do not apply them.

## Plugins

Enabled plugins, their marketplaces and their roots come from `claude-plugins.ts`, the code the MCP catalog already
used (see [mcp-catalog.md](mcp-catalog.md#plugin-servers)): `enabledPlugins` merged over user < project < local <
policy, a directory/file marketplace served in place, else `plugins/cache/<mkt>/<plugin>/<version>`, else the record's
`installPath`; anything not on disk is skipped.

- **Skills**: `<root>/skills/` whenever it exists, plus the manifest's `skills` (string or array of paths). A path whose
  `SKILL.md` exists is itself the skill; otherwise every subdirectory with a `SKILL.md` is one. With neither a manifest
  `skills` nor a `skills/` dir, a root `SKILL.md` makes a single-skill plugin. The name is
  `<plugin>:<dir with [^a-zA-Z0-9_-] replaced by ->`; a root-`SKILL.md` plugin takes its frontmatter `name` (a
  `<plugin>:` prefix stripped) instead of the directory name. A frontmatter `name` without `:` is an alias. `paths` is
  ignored for plugin skills.
- **Commands**: `<root>/commands/` only when the manifest has no `commands`; otherwise the manifest's `commands` (a
  path, an array of paths, or an object mapping a name to `{ source }`). Directories are walked to depth 32 and 4096
  dirs, links below the root are not followed, a directory with a `SKILL.md` is not descended, `.md` is
  case-insensitive. The name is `<plugin>:<ns>:...:<name>`.
- A plugin path escaping the plugin root is refused. A plugin skill whose realpath equals an already loaded skill's is
  dropped.
- **Variables**: `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${CLAUDE_PROJECT_DIR}` and `${user_config.K}` are
  filled into a plugin entry's `body` when the catalog is resolved, with the same code the MCP fill-in uses. A
  `sensitive`, undeclared or required-but-unset option stays as written (the skill is not skipped, and the credential
  store is never read).

## Invocation

A typed `/name args` (a user-invocable entry's name or alias; only a leading `/name` followed by whitespace or the end
matches) is expanded the way cli.js's `getPromptForCommand` does, for engines that do not run Claude skills:

1. `args` is the text after the name, trimmed, split bash-style (quotes, backslash escapes; whitespace split when a
   quote is left open).
2. A skill with a directory gets `Base directory for this skill: <dir>` and a blank line in front of its body.
3. Variables: `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PROJECT_DIR}` (the session cwd), `${CLAUDE_SESSION_ID}` (when given).
   `${CLAUDE_EFFORT}` is left as written.
4. Arguments, in one pass: `\$` before a placeholder makes it literal; `$name` (declared `arguments`, longest first, not
   followed by `[` or a word char); `$ARGUMENTS[n]`; `$n` (zero-based); `$ARGUMENTS` (the whole string). A missing
   index is left as written. When nothing matched and `args` is non-empty, `\n\nARGUMENTS: <args>` is appended. Every
   substituted value is escaped so it cannot form a `!` shell marker (`` `! `` to `` ` ! ``, `` !` `` to `` ! ` ``, a
   leading `!` to `\!`).
5. Shell commands are **not run** (owner ruling R4): each inline `` !`cmd` `` and each ` ```! ` block becomes
   `[ClaudeUI did not run this skill command; run it yourself if you need its output: `cmd`]`, so the model can run it
   through its own tool and the normal permission checks.
6. The engine receives
   `<command-message>name</command-message>\n<command-name>/name</command-name>\n<command-args>args</command-args>\n\n<expanded>`
   (no args line when empty): cli.js's own visible-message tags, which `parseCliCommand` in `session-history.ts` already
   renders as a `cli_command` block. `parseSkillInvocationEnvelope` reads the typed command back out for the cold-history
   mappers of the other engines.

## Per engine

The engine's own skills win a name clash and are never edited (owner ruling R1). Every engine's slash menu and the
Skills dialog are built from the same entries through `claude-skill-info.ts` (`claudeSkillEntryToInfo`,
`claudeSkillSlashCommands`, `mergeSlashCommandLists`: the engine's list first, so it wins a clash).

**Claude.** cli.js loads skills itself. The session adds the catalog's typed-invocable names its own `slash_commands`
lacks to its menu; the Skills dialog reads the catalog. The slash-menu cache (`slash-commands.json`) holds cli.js's list
minus this cwd's catalog names (built-ins, bundled skills, MCP prompts); a new session's menu is that cache plus its own
cwd's catalog, before cli.js has started.

**opencode.** `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1` turns off opencode's own `.claude/skills` scan, so the catalog is
the only source of Claude-form skills. The per-server host serves `GET /skills?directory=` (bearer; the housekeeping
directory gets an empty list). The claudeui-xeng plugin fetches it per location and adds the entries in a
`skill.transform` hook; ids opencode already has win, so its own `.agents`, config and built-in skills beat the catalog.
`skillsLoaded` is only reported through the `guard` RPC; it does not limit fetches (a throwing skill API leaves it
false and the guard still registers). A `reloadSkills` RPC exists but nothing calls it: a
skill edited after opencode opened a folder applies when that location is rebuilt. A typed `/name` is expanded in
`postPromptNow` (an opencode command of that name wins). Cold history maps the user row's command envelope through `content.ts`. The session publishes the menu
(`publishCommands`: commands, plus the catalog minus the ids opencode's own skills won) from `establishSession`, once per
connection, so an opencode menu is empty until the first prompt; before that the renderer's fallback (catalog skills for
the cwd) fills it. The served skill `content` has `${CLAUDE_SKILL_DIR}` and `${CLAUDE_PROJECT_DIR}` filled.

**pi.** Bridge v27 serves `POST /skills`; the extension loads it only with `CLAUDEUI_PI_SKILLS=1` and the bridge
credentials. Its `before_agent_start` handler appends the catalog's model-invocable skills to
`systemPromptOptions.skills` (pi's own names win); a failed fetch raises one notify. A typed `/name` is expanded in
`PiSession.run` for prompt, steer and follow-up (a pi command of that name wins). Host-run subagents get the parent's
snapshot; the dispatcher's pi target gets the dispatch cwd's catalog. Cold history maps through `pi-session-list.ts`.

**UI.** The slash menu is per session (`session:slash-commands`, carrying the engine list plus the catalog). The Skills
dialog asks the session (`discoverSkills`) and falls back to the catalog when there is no session. There is no separate
skill-name channel.

## Not reproduced

Bundled skills and built-in commands; claude.ai-synced skills; skills-dir plugins (`.claude-plugin` inside a skills
folder); MCP prompts; skills discovered mid-session (nested `.claude/skills` under the cwd when a file is touched) and
conditional `paths` activation; `--add-dir`; `context: fork`, `agent`, `background`, `allowed-tools`,
`disallowed-tools`, skill hooks, `model`, `effort`, `shell`; shell-command execution (R4); `Skill(...)` permission
rules; the model-listing budget and usage ranking; MDM / server-delivered policy; built-in and synced marketplaces;
inline `content` entries in an object-form plugin `commands`; on pi, `${CLAUDE_SKILL_DIR}` and
`${CLAUDE_PROJECT_DIR}` in a skill the model loads (it reads the raw file).

## Contract test

`src/integration/sdk-contract/skill-catalog.integration.test.ts` (`CLAUDE_INTEGRATION_TESTS=1`) spawns the pinned
cli.js in an isolated home over a fixture project and compares the catalog's user-invocable names with the `commands` of
cli.js's `reload_plugins` response (the `initialize` response predates plugin loading), and checks that an `off`
override, a conditional skill and a disabled plugin are absent from both. It needs no credentials, no network and no
model call. The managed directory is a fixed system path and is not covered.

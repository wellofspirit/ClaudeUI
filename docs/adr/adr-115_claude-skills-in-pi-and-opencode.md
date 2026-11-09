# ADR-115: Claude skills and commands in pi and opencode

**Status:** Accepted (2026-11-09, owner decision). Replaces PR #133's approach.
**Amends:** [ADR-024](adr-024_opencode-interaction-parity.md) (opencode skills were list-only and read by opencode
itself), [ADR-028](adr-028_opencode-native-config-in-place.md) (skills "need no bridge"),
[ADR-035](adr-035_pi-engine-backend.md) (pi's shared skills through `resources_discover`).
**Relates to:** [ADR-096](adr-096_pi-mcp-shared-catalog.md) (the shared MCP catalog, the same shape for MCP servers),
[ADR-103](adr-103_claude-agent-definitions-in-pi-and-opencode.md) (Claude agent definitions in pi and opencode).

## Context

A skill written for Claude Code (`~/.claude/skills`, a project's `.claude/skills`, an enabled plugin's skills, or a
legacy `.claude/commands` file) should work in a pi or opencode session run through ClaudeUI, under the same name.
Before this decision each engine got a different, approximate set:

- **opencode** read `.claude/skills` itself, with its own rules: it walked past the git root to `/`, scanned six
  levels deep and took loose `.md` files. It read no plugin skills, no commands and no `skillOverrides`, and a typed
  `/name` reached the model as plain text.
- **pi** got two folders through `resources_discover`. pi marks such skills "temporary", so ClaudeUI's slash menu
  dropped them, and picking one sent `/name`, which pi does not run (it runs `/skill:name`).
- **The slash menu** was one app-wide list, so whichever session reported last filled every session's menu.

The MCP sharing had the same problem and was rebuilt in PR #199: one catalog, resolved host-side the way cli.js
resolves it, bridged to each engine.

## Decision

1. **One catalog, the way cli.js loads it.** `resolveClaudeSkillCatalog(cwd)` re-implements cli.js 2.1.317's skill
   and legacy-command loading: managed, user and project sources (the project walk stops at the git root and never
   reaches `$HOME`), recursive commands, enabled plugins' skills and commands, first-wins names, realpath dedup,
   `skillOverrides`, conditional `paths` skills (left out, as at cli.js startup) and policy
   `strictPluginOnlyCustomization`. Plugin enumeration is shared with the MCP catalog. The rules are in
   [skill-catalog.md](../architecture/skill-catalog.md); a gated contract test compares the names with the real
   binary's.
2. **Claude's names in every engine** (`plugin:skill`, `ns:cmd`), so a typed `/name` is the same everywhere.
3. **The engine's own skills win a name clash**, as pi's own `mcp.json` wins in ADR-096. ClaudeUI never edits,
   removes or overrides opencode's `.opencode`, `.agents`, configured or built-in skills, or pi's `~/.pi`, `.pi`,
   `.agents`, settings or package skills.
4. **opencode's own `.claude/skills` reader is off** on ClaudeUI-spawned servers
   (`OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1`). ClaudeUI's opencode plugin fetches each folder's catalog from the
   per-server host (`GET /skills`, bearer token) and adds it through `skill.transform`.
5. **pi lists the catalog through `before_agent_start`.** The bridge (v27) fetches `POST /skills` from its host and
   appends the skills to pi's system-prompt skill list, instead of loading them through pi's resource loader, which
   renames them and cannot carry commands.
6. **A typed `/name args` on pi or opencode is expanded by ClaudeUI** with cli.js's rules (base-directory header,
   variables, `$ARGUMENTS` / `$n` / named arguments, the `ARGUMENTS:` fallback), behind cli.js's own command envelope,
   so history shows the typed command. An engine command of the same name wins.
7. **Skill shell commands are not run** (`` !`cmd` ``, ` ```! ` blocks): each becomes a note naming the command,
   so the model can run it through its own tool and the normal permission checks. Nothing in this decision touches
   the permission ladders, the judge or path containment.
8. **Slash menus and the Skills dialog are per session.** The dialog groups entries by source and shows, on pi and
   opencode, the Claude-only behaviour an entry uses that the engine does not apply.

## Consequences

- A skill or command that loads in a Claude session in a folder is offered under the same name in a pi or opencode
  session there; a disabled plugin's or an `off` skill is not.
- opencode no longer sees skills that only its own wider search found: above the git root, nested deeper than one
  level, or loose `.md` files.
- Not applied outside Claude: `context: fork`, `agent`, `allowed-tools`, `disallowed-tools`, skill hooks, `model`,
  `effort`, `shell`, skill shell commands, `Skill(...)` permission rules (opencode's own `skill` permission is
  unchanged), and skills cli.js discovers mid-session. The Skills dialog says so per entry.
- The catalog applies when a pi session spawns and when opencode opens a folder; a skill file edited after that
  applies on the next spawn or folder rebuild.
- The catalog follows cli.js 2.1.317 and is re-checked on a Claude Code bump (`bump-harness`), as the MCP catalog is.

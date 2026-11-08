# Shared MCP catalog

The MCP servers a ClaudeUI Claude session in a cwd would load, resolved host-side so the opencode and pi bridges
inherit exactly that set ([ADR-096](../adr/adr-096_pi-mcp-shared-catalog.md)). Built against cli.js 2.1.317;
re-check the rules below on a Claude Code bump (`bump-harness`).

| Module                                     | Role                                                                                                                          |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `src/core/services/claude-config-paths.ts` | Where cli.js keeps its config: config dir, global file, project key, settings layers, settings merge                          |
| `src/core/services/claude-mcp-catalog.ts`  | `resolveClaudeMcpCatalog(cwd)`: layers, approval veto, disabled list, policy, entry validation, plugin dedup and naming       |
| `src/core/services/claude-plugin-mcp.ts`   | `listPluginMcpServers(cwd)`: enabled plugins, their roots, their `.mcp.json` / `plugin.json` servers, plugin-variable fill-in |
| `src/core/services/claude-mcp-files.ts`    | McpDialog's legacy files (the "ClaudeUI layer")                                                                               |
| `src/core/services/claude-mcp-cli.ts`      | McpDialog's writes through cli.js's own `mcp add-json` / `mcp remove`                                                         |
| `src/core/services/claude-env-refs.ts`     | Claude's `${VAR}` / `${VAR:-default}` expansion, shared by both bridges                                                       |

## Where cli.js reads

- **Config dir** `$CLAUDE_CONFIG_DIR || ~/.claude`. **Global file** `<configDir>/.config.json` if non-empty (legacy),
  else `${CLAUDE_CONFIG_DIR || ~}/.claude.json` (`-custom-oauth` suffix with `CLAUDE_CODE_CUSTOM_OAUTH_URL`).
- **Project key** for `projects[...]` in the global file: the git root, a linked worktree resolving to its main
  checkout, else the cwd; `\` → `/`, drive letter as spelled (`C:/x` and `c:/x` are different keys).
- **Settings** resolve against the cwd, not the git root: user `<configDir>/settings.json`, project
  `<cwd>/.claude/settings.json`, local `<cwd>/.claude/settings.local.json`, policy `<managed>/managed-settings.json`
  plus `managed-settings.d/*.json` (`C:\Program Files\ClaudeCode`, `/Library/Application Support/ClaudeCode`,
  `/etc/claude-code`). Merge: later wins, objects per key, arrays concatenated.
- cli.js reads **no** `mcpServers` from any `settings*.json` and never reads `~/.claude/.mcp.json`.

## Layers

Low → high; a name in a higher layer replaces the whole entry:

1. **plugin** — enabled plugins' servers (below).
2. **user** — global file `mcpServers`.
3. **project** — every `.mcp.json` from the filesystem root's child down to the cwd, the closest winning, minus names
   in `disabledMcpjsonServers` (any settings layer, plus the legacy `projects[key].disabledMcpjsonServers`). This is
   cli.js's non-interactive (`-p`, stream-json) approval: everything else is auto-approved, trusted workspace or not.
4. **local** — `projects[key].mcpServers`.
5. **managed** — policy `managedMcpServers` (http/sse only, never env-expanded).
6. **ClaudeUI layer** — McpDialog's legacy files (`<configDir>/.mcp.json`, `<configDir>/settings.json`,
   `<cwd>/.claude/settings.json`, `<cwd>/.claude/settings.local.json` `mcpServers`). cli.js ignores them; a ClaudeUI
   Claude session receives them through `--mcp-config` (dynamic scope, top precedence), so the bridges get them too.
   `<cwd>/.mcp.json` is NOT injected: cli.js reads it natively, and injecting it would skip the approval veto.

A `<managed>/managed-mcp.json` makes `managedMcpServers` + that file exclusive: no other layer, no plugins.

Then, for every layer: `projects[key].disabledMcpServers` removes names (plugin servers by their full
`plugin:<p>:<s>` key); `deniedMcpServers` (union of all layers) and `allowedMcpServers` (merged, or policy-only with
`allowManagedMcpServersOnly`) match by name, exact `[command, ...args]` or url wildcard; deny wins; when any
`serverCommand` (`serverUrl`) entry exists, a stdio (remote) server must match one; org-delivered entries skip the
allowlist.

Entries are validated as cli.js validates config files: no `type` means stdio, but a `url` with no `type` is skipped;
`sse`, `http` (`streamable-http`) and stdio pass; `ws`, `sdk`, `claudeai-proxy`, `*-ide` and unknown types are
skipped; unknown keys (`cwd` included) are dropped. Every skip carries a reason; pi shows them in its one-time MCP
warning, opencode logs them.

## Plugin servers

- **Enabled** = `enabledPlugins` merged per key over user < project < local < policy, value exactly `true`, key
  `name@marketplace`; `builtin` / `inline` / `skills-dir` / `synced` marketplaces are not enumerated.
- **Root**: a string-source plugin of a directory/file marketplace is served in place; otherwise
  `<configDir>/plugins/cache/<mkt>/<plugin>/<version>` (version from the first applicable `installed_plugins.json`
  record — user/managed scope, or `projectPath` in the same checkout — then the catalog entry, then the manifest), else
  the record's `installPath`. `CLAUDE_CODE_PLUGIN_CACHE_DIR` moves the plugins dir.
- **Servers**: `<root>/.mcp.json`, overlaid by `plugin.json` `mcpServers` (object, relative path, or an array of
  those; a path escaping the root is refused).
- **Fill-in**: `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}` (`plugins/data/<sanitised id>`, created),
  `${CLAUDE_PROJECT_DIR}` and `${user_config.K}` (declared default ← `pluginConfigs[id].options` from user/policy
  settings) in command, args, env, url and headers; the three variables are also put in a stdio server's env.
- **Names**: cli.js keys a plugin server `plugin:<p>:<s>`; the catalog exposes it under the name cli.js gives its
  tools (`[^A-Za-z0-9_-]` → `_`, so `plugin_<p>_<s>`), which is also what a Claude rule like
  `mcp__plugin_<p>_<s>__tool` binds to. A plugin server duplicating a configured server's command+args or url is
  dropped; among plugins the first wins.
- **Skipped, with a reason**: MCPB bundles, plugins not on disk (cli.js would download them), entries using
  `headersHelper`, and servers that reference a `sensitive` `userConfig` option — those values live in cli.js's
  credential store, which ClaudeUI never reads.

## Not reproduced

claude.ai connectors, built-in and claude.ai-synced plugins, MDM / registry / server-delivered policy,
`strictPluginOnlyCustomization`, `strictKnownMarketplaces` / `blockedMarketplaces`, marketplace entries with inline
`mcpServers` (`strict: false`), npm-marketplace layouts, `--add-dir` plugin sources, OAuth state and `headersHelper`,
and in-session approvals. A Claude session still gets all of these from cli.js itself; only the bridges miss them.

## Expansion per engine

The catalog never expands `${VAR}`. pi expands host-side and escapes for pi's config-value resolver (`$` → `$$`,
leading `!` → `$!`). opencode expands host-side too: opencode substitutes `{env:}` / `{file:}` in the raw
`OPENCODE_CONFIG_CONTENT` text before parsing it, so ClaudeUI writes every `{` of such a token as `\u007b` and a
value can never trigger a substitution.

opencode connects every configured MCP server for each directory a request touches, so ClaudeUI's own housekeeping
directory (`PERSISTED_SESSIONS_DIR`: session lists, credentials, model discovery, usage) gets no bridged catalog;
otherwise the user's servers would start at app boot with no session open.

## McpDialog

The cold list is the catalog, grouped by source: User, Project, Local, Plugin, Managed and "ClaudeUI (legacy)"; a
live session's `mcp_status` list takes priority, with the catalog's source standing in for `dynamic`. Add and Remove
for user/project/local run `<claude> mcp add-json -s <scope> -- <name> <json>` / `mcp remove -s <scope> -- <name>`
with the session cwd (cli.js's own lock on the global file; argv, no shell; the JSON is never logged); without a cwd
only user scope is allowed. A running session then gets `reload_plugins`, which adds and drops the difference.
cli.js caches `~/.claude.json` behind a watcher (a reload right after a user/local write saw the old file for
240–860 ms in probes; `.mcp.json` is read fresh), so `reloadMcpUntil` (`claude-mcp-reload.ts`) checks `mcp_status`
for the server and retries a few times within ~1.6 s. Disabled servers stay listed, flagged, so they can be
re-enabled. Legacy entries can be removed (from every legacy file) but not added; the removal does not touch the
live session, because `mcp_set_servers` replaces the whole dynamic set, ClaudeUI's hosted servers included. Plugin
and managed entries are read-only. The cold enable/disable toggle writes `projects[key].disabledMcpServers`.

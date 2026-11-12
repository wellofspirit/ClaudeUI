# Shared catalogs: MCP servers, agent definitions and skills across engines

Governs: `src/core/services/claude-mcp-catalog.ts`, `src/core/services/claude-plugin-mcp.ts`, `src/core/services/claude-skill-catalog.ts`, `src/core/services/claude-skill-invoke.ts`, `src/core/agents/`, `src/core/pi/pi-mcp-bridge.ts`, `src/core/pi/pi-skill-bridge.ts`, `src/core/opencode/claude-agent-shim.ts`, `src/core/opencode/claude-mcp-bridge.ts`

The rule the three decisions share: an opencode or pi session gets what a Claude session in the same folder would
load (MCP servers, agent definitions, skills and legacy commands), resolved host-side the way cli.js resolves them,
delivered through each engine's own channel and never by editing the engine's own config. As-built mechanics live in
`docs/architecture/mcp-catalog.md` and `docs/architecture/skill-catalog.md` (re-checked on every Claude Code bump,
`bump-harness`). Neighbouring decisions: opencode custom-agent CRUD (ADR-029), the injected config and permission
overlays (ADR-097 §2, §3) and opencode subagent parity (ADR-111) are in `opencode.md`; plugins ADR-004 and ADR-005 in
`plugins.md`; the pi backend, its bridge and its subagents (ADR-035, ADR-089) in `pi.md`; the shared rule ladder
(ADR-022, ADR-085) in `permissions.md`.

## pi and opencode inherit the one shared MCP catalog (ADR-096)

ClaudeUI has one MCP catalog: the servers a Claude session in the cwd loads, resolved host-side by
`resolveClaudeMcpCatalog(cwd)` (`claude-mcp-catalog.ts`) the way cli.js resolves them. opencode
(`claude-mcp-bridge.ts`, runtime-only through `OPENCODE_CONFIG_CONTENT`) and pi (below) both consume it. A pi session
gets exactly what opencode gets: runtime-only, never written to pi's own config, secrets only in memory; bridged
servers are `exposure: "direct"`; no `--no-mcp` (pi's own MCP keeps working); every MCP call goes through ClaudeUI's
normal permission engine.

### What the catalog is (and the trust rules)

- **Layers**, low to high, a higher layer replacing a same-named entry whole: enabled plugins' servers; user (the
  global `~/.claude.json` `mcpServers`); project (every `.mcp.json` from the filesystem root's child down to the cwd,
  the closest winning); local (`projects[key].mcpServers`); managed (policy `managedMcpServers`, http/sse only);
  and "ClaudeUI's layer", McpDialog's own legacy files (`<configDir>/.mcp.json`, and `mcpServers` in the user and
  project settings files), which cli.js ignores but ClaudeUI's Claude sessions receive through `--mcp-config`, so the
  bridges get them too. cli.js reads no `mcpServers` from `settings*.json` and never `~/.claude/.mcp.json`.
- **Project servers need no approval, and the veto is exactly `disabledMcpjsonServers`.** The catalog follows cli.js's
  non-interactive (`-p`, stream-json) approval, which is what ClaudeUI runs: every `.mcp.json` server loads unless
  `disabledMcpjsonServers` (any settings layer, or the legacy `projects[key].disabledMcpjsonServers`) names it, trusted
  workspace or not. A project's `<cwd>/.mcp.json` is NOT injected through ClaudeUI's layer: cli.js reads it natively,
  and injecting it would skip that veto.
- **Disabled, denied, allowed.** `projects[key].disabledMcpServers` removes names (plugin servers by full
  `plugin:<p>:<s>` key). `deniedMcpServers` (union of all layers) and `allowedMcpServers` (merged, or policy-only with
  `allowManagedMcpServersOnly`) match by name, exact `[command, ...args]` or URL wildcard; **deny wins**; when any
  `serverCommand` / `serverUrl` entry exists a stdio / remote server must match one. A `managed-mcp.json` makes the
  managed set exclusive (no other layer, no plugins).
- **Validation** follows cli.js: a `url` with no `type` is skipped; `sse`, `http` and stdio pass; `ws`, `sdk`,
  `claudeai-proxy`, `*-ide` and unknown types are skipped; every skip carries a reason.
- **Plugin servers** come from enabled plugins only (`enabledPlugins` value exactly `true`), exposed under the name
  cli.js gives their tools (`plugin_<p>_<s>`), which is also what a Claude rule `mcp__plugin_<p>_<s>__tool` binds to.
  Entries that need cli.js's credential store (`sensitive` `userConfig`, `headersHelper`, MCPB bundles) are skipped,
  never read: ClaudeUI does not read cli.js's credential store.
- **Not reproduced** (a Claude session still gets them from cli.js; only the bridges miss them): claude.ai
  connectors, built-in and synced plugins, MDM / registry / server-delivered policy, OAuth state, in-session approvals.
- **McpDialog writes through cli.js**: Add and Remove for user / project / local run `<claude> mcp add-json -s <scope>`
  / `mcp remove -s <scope>` with the session cwd (argv, no shell, the JSON never logged), so cli.js's own lock and
  validation apply; a running Claude session then gets `reload_plugins`. Legacy-layer entries can be removed, not
  added. Plugin and managed entries are read-only. The cold enable/disable toggle writes
  `projects[key].disabledMcpServers`.
- `${VAR}` / `${VAR:-default}` expand host-side per engine (`claude-env-refs.ts`; an unset variable stays as
  written). opencode's housekeeping directory gets no bridged catalog, or the user's servers would start at app boot.

### pi: one read, one translator (`pi-mcp-bridge.ts`)

`collectClaudeMcpForPi` translates each catalog entry to pi's shape (stdio `{type, command, args, env}`, streamable
HTTP `{type, url, headers}`, always `exposure: "direct"`) and SKIPS, with a reason, what pi would refuse: SSE, `sdk` /
other transports, invalid names (outside `[A-Za-z0-9_-]`), bad URLs, no command or url, ClaudeUI's reserved names
(`claudeui`, `claude-ui`, `claude-ui-mockup`, `claude-ui-collab`, compared by pi namespace) and the second of two names
pi would put in one namespace. One bad entry never costs the others; skips are logged and shown once per session as a
`session:warning`. Values: Claude's `${VAR}` / `${VAR:-default}` are expanded host-side, then escaped for pi's
config-value resolver (`$` -> `$$`, leading `!` -> `$!`), so a header starting with `!` can never become a shell
command and a `$` in a password survives.

### pi: delivery over the authenticated host channel, not an env var

`PiSession.doStart` reads the catalog at every spawn and hands the snapshot to its `PiBridgeHost`. The bridge
extension, when `CLAUDEUI_PI_MCP=1`, `POST`s `/mcp-servers` with the bridge token while pi loads it (the factory
returns that promise; 10 s bound) and calls `pi.registerMcpServer` per entry. A refused entry or failed fetch never
throws out of the factory (pi would discard the whole extension, gate included); failures become one `session_start`
notify starting `MCP `.

**Why not an env var** (opencode's precedent): pi's env is inherited by every bash command and every stdio MCP server
pi starts, so `env` would print every bridged secret into the model's context. The route is repeatable (pi reloads
extensions on fork), so a process holding the token can read the catalog; that is no wider than the source, since the
same processes run as the same user and can read `.mcp.json` directly.

### pi: collision, permissions, rendering

- **Collision.** pi's own `~/.pi/agent/mcp.json` / `.pi/mcp.json` wins (pi's native rule: a `mcp.json` server whose
  namespace equals a registered one's wins). ClaudeUI reads only the NAMES pi's files define
  (`readPiNativeMcpServerNames`) and logs the collision; the entry is still sent and pi applies the rule. ClaudeUI never
  edits or removes pi's own MCP servers.
- **Permissions.** MCP calls reach the bridge's `tool_call` hook under pi's names (`mcp__<server>__<tool>` with
  `[^A-Za-z0-9_]` -> `_`). The shared ladder takes `PermissionEngineContext.mcpRuleKey`; pi's gates (the session, its
  children, the dispatcher's pi target) pass `piMcpRuleKey`, which spells a Claude rule's tool name the way pi names
  tools, so `mcp__my-server__get-issue`, `mcp__my-server` and `mcp__my-server__*` bind to `mcp__my_server__get_issue` in
  every tier, pi's own servers included. In auto mode the allow-rule skip maps pi's server back to its Claude name
  when exactly one known server fits and compares tool names through the same sanitizer. **No MCP tool is
  auto-allowed**: the mode base asks, as on Claude.
- **Rendering** is at parity and generic: `mcp__*` is the `mcp` kind, the header the raw tool name, the body `McpBody`
  (pi's names carry `_` where a Claude server name has `-`).

### pi: subagents and dispatch targets

A host-run child (ADR-089) registers its PARENT's snapshot (served by the child's own bridge host,
`CLAUDEUI_PI_MCP=1`) and is gated by the parent's gate. Tool lists follow Claude's rule with pi's semantics:
`tools: inherit` -> every MCP tool; an explicit list with no `mcp__` entry -> no MCP tool is declared (pi keeps them
registered but never activates a `direct` one); `mcp__...` entries in `tools` / `disallowedTools` are spelled in pi's
form (`mcp__my-srv__get-issue` -> `mcp__my_srv__get_issue`, a bare `mcp__github` -> `mcp__github__*`). The dispatcher's
pi TARGET registers the catalog for the dispatch cwd too, gated by the target's gate (user deny/ask rules with
`mcpRuleKey`, then the target judge); MCP tools are not a recursion path, a target still never gets `dispatch_agent`.

### Catalog changes, live controls, OAuth

- The catalog applies at spawn and respawn (a fork reload re-fetches the same snapshot). McpDialog and its live verbs
  (`mcp:status` / `toggle` / `reconnect`) stay Claude-only: the TopBar entry is `engineId === 'claude'`, and the verbs
  are gated on method presence, which `PiSession` does not implement (pi's RPC offers no status channel; a follow-up,
  not built). ADR-079 keeps the dialog Claude-only.
- A catalog HTTP server with no `Authorization` header is OAuth to pi. RPC mode cannot sign in on its own: pi marks the
  server "needs sign-in", the first prompt does not wait on it, and its notify ("MCP servers need attention: ... needs
  sign-in") reaches the user as a `session:warning` (the mapper surfaces `extension_ui_request` notifies of level
  warning/error that start `MCP `). Signing in through `/mcp login` from ClaudeUI is untested.
- Out of scope, deliberately: editing pi's native `mcp.json`; MCP live controls for pi; nested codemode-call
  rendering; "always allow" suggestions for pi MCP calls.

## Claude agent definitions run in pi and opencode (ADR-103)

User-level role agents are defined once, as Claude Code agent files in `~/.claude/agents` (and a project's
`.claude/agents`), and run in pi and opencode sessions through ClaudeUI, each harness on its own models, with no
copies and no patching of either harness. The agent registry's pi side (sources, hostile-input parsing, gating) is
ADR-089 in `pi.md`.

**One file, a block per harness.** An agent file keeps Claude Code's shape and may add a `harness` map Claude Code
ignores (`harness.pi.model`, `harness.opencode.model`). Each harness reads only its own block, and the body (the system
prompt) names no harness or model. A flat `pi-model` / `opencode-model` key was rejected for one nested key.

**pi (the agent registry).**

- Sources, later wins per normalized name: built-ins < `~/.claude/agents` < `~/.pi/agent/agents` < for each project
  directory from the root down, `.claude/agents` then `.pi/agents`. The harness's own folder wins at equal scope; a
  nearer directory beats a farther one; every override of a built-in or user agent is a diagnostic, a project agent
  shadowing one is marked `(project)` in the listing.
- **A project definition fully overrides** a same-named one, as in Claude Code: a project owns its agents and may give
  one a different model, tools or prompt (logged at info). The earlier "project files may only narrow and never pick a
  model" rule was reversed because it diverged from Claude Code and took a legitimate per-project choice away.
- `harness.pi.model` wins over `model` in every scope; a Claude alias (`sonnet`) is not a pi model and inherits, with a
  warning. The child's model is still validated against the session's allowlisted catalog.
- The `agent` tool's listing hides Claude built-in tools pi lacks (`WebFetch`, `WebSearch`, ...); extension and MCP
  tools still show. The names still reach `--tools`, which pi turns into a name matcher, so an unknown name matches
  nothing.

**opencode (the injected config).** The same two folders are read with the same hardened reader
(`src/core/agents/agent-defs.ts`: no evaluation, aliases refused, size and count caps; `claude-agent-shim.ts`).

- **The harness's own definition wins.** A name opencode already has is not injected, because the injected document is
  applied last and would rewrite the native agent. "Already has" mirrors opencode's own discovery: built-ins,
  `agents.<name>` in every config document opencode loads, and agent files in the global and every discovered
  `.opencode` folder (`agent` / `agents`, recursive, and `mode` / `modes`). Names compare case-insensitively; a name
  that is not a safe opencode agent id is skipped.
- Each agent is injected as a native 2.x subagent: `mode: "subagent"` (mandatory: a mode-less entry is primary and the
  `subagent` tool refuses it), `description`, `system` = a short ClaudeUI preamble plus the body (opencode's `system`
  REPLACES its default prompt where pi's `--append-system-prompt` appends, so the preamble carries the harness detail),
  `model` from `harness.opencode.model` in any scope. A model outside ClaudeUI's opencode allowlist, or a malformed
  one, skips the agent: never a silent substitute. A top-level `effort` becomes `#<effort>` on that model when it has
  no variant of its own (unvalidated at injection; the agent type catalog warns when it is not one of the model's
  variants). `permissionMode` and `background` are not mapped (ADR-111).
- **Permissions are deny-only, never an allow.** An allow would widen the default rules (e.g. turn the `.env` read asks
  into allows) and an all-deny would, through the child-session rules, cut the child off from paths outside the session
  directory (never `*` / `*_*`). A `tools` list denies every action it does not name (and `question` unless it names
  `AskUserQuestion`), plus `disallowedTools`. MCP follows Claude Code's rule that a tools allowlist without MCP names
  gets no MCP tools: every bridged server, every server in the loaded config documents' `mcp.servers` (and the 1.x
  `mcp.<name>` form) and ClaudeUI's hosted `claudeui` server is denied unless the list names it at server level
  (`mcp__<server>`); a denied server's resources go with it (`opencode_list_mcp_resources` on the server name,
  `opencode_read_mcp_resource` on `<server>:*`). A tool-level entry (`mcp__github__issues`) cannot be expressed
  deny-only, so the server stays denied, with a diagnostic. A server that exists only at runtime is not known when
  the config is built and is not denied. No `tools` key means no entry (defaults).
- **Rule order** for an injected agent: the user's global opencode `permissions`, then the agent's own denies, then
  ClaudeUI's per-agent overlay for that name (ADR-097 §3); last match wins, so the agent's denies beat the user's
  global allows. Session rules sit after agent rules in opencode, and a child copies the parent's session rules after
  its own, so ClaudeUI's child-session ruleset restores the agent's denies (`subagent-permissions.ts`, ADR-097 §3).
- A project definition overrides a user one whole, as in pi. Project `.claude/agents` files are repository-supplied
  input like a repository's own `.opencode` config (which can already define agents, models and permissions);
  ClaudeUI's model allowlist still bounds the model.
- **Size caps**: 8 KiB per injected agent, 24 KiB for the block (`MAX_INJECTED_AGENT_BYTES`,
  `MAX_INJECTED_BLOCK_BYTES`), well inside one Windows environment variable (32,767 characters); an over-cap agent is
  skipped with a diagnostic.
- The injected block is part of the server identity: an edited agent file, or an edit to opencode's own `mcp` servers
  or agents (the denies and skips follow them), starts a fresh server on the next session; the old one ends when its
  last session releases it. A server added to a config document while one runs is hot-reloaded by opencode but denied
  to a tools-list agent only from the next server on.

Consequences: one set of agent files serves Claude Code, pi and opencode, per-harness models beside each other in the
file and nowhere else. opencode 2.x reads `AGENTS.md`, not `CLAUDE.md`, so an injected agent does not see a repository's
`CLAUDE.md` rules (the orchestrator appends them to opencode briefs, ADR-026). Claude Code scans agent folders
recursively; both shims read them flat. Generating per-harness agent files from a config repo was rejected: a runtime
shim keeps one source and nothing to re-sync.

## Claude skills and commands are offered in pi and opencode under Claude's names (ADR-115)

A skill written for Claude Code (`~/.claude/skills`, a project's `.claude/skills`, an enabled plugin's skills, a
legacy `.claude/commands` file) works in a pi or opencode session under the same name.

1. **One catalog, the way cli.js loads it.** `resolveClaudeSkillCatalog(cwd)` re-implements cli.js 2.1.317's skill and
   legacy-command loading: managed, user and project sources (the project walk stops at the git root and never reaches
   `$HOME`), recursive commands, enabled plugins' skills and commands, first-wins names, realpath dedup,
   `skillOverrides`, conditional `paths` skills (left out, as at cli.js startup) and policy
   `strictPluginOnlyCustomization`. Plugin enumeration is shared with the MCP catalog. A gated contract test compares
   the names with the real binary's.
2. **Claude's names in every engine** (`plugin:skill`, `ns:cmd`), so a typed `/name` is the same everywhere.
3. **The engine's own skills win a name clash**, as pi's own `mcp.json` wins in ADR-096. ClaudeUI never edits, removes
   or overrides opencode's `.opencode`, `.agents`, configured or built-in skills, or pi's `~/.pi`, `.pi`, `.agents`,
   settings or package skills.
4. **opencode's own `.claude/skills` reader is off** on ClaudeUI-spawned servers (`OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1`);
   ClaudeUI's opencode plugin fetches each folder's catalog from the per-server host (`GET /skills`, bearer token) and
   adds it through `skill.transform`. opencode therefore no longer sees skills only its own wider search found (above
   the git root, nested deeper than one level, loose `.md` files).
5. **pi lists the catalog through `before_agent_start`.** The bridge (`CLAUDEUI_PI_SKILLS=1`) fetches `POST /skills`
   from its host and appends the model-invocable skills to pi's system-prompt skill list, skipping names pi already
   lists, instead of `resources_discover` (which renames skills and cannot carry commands). Host-run subagents get the
   parent's snapshot; a dispatch target gets the dispatch cwd's.
6. **A typed `/name args` on pi or opencode is expanded by ClaudeUI** with cli.js's rules (base-directory header,
   variables, `$ARGUMENTS` / `$n` / named arguments, the `ARGUMENTS:` fallback), behind cli.js's own command envelope
   so history shows the typed command. An engine command of the same name wins.
7. **Skill shell commands are not run** (`` !`cmd` ``, ` ```! ` blocks): each becomes a note naming the command, so
   the model can run it through its own tool and the normal permission checks. Nothing here touches the permission
   ladders, the judge or path containment.
8. **Slash menus and the Skills dialog are per session** (not one app-wide list). The dialog groups entries by source
   and shows, on pi and opencode, the Claude-only behaviour an entry uses that the engine does not apply.

Not applied outside Claude: `context: fork`, `agent`, `allowed-tools`, `disallowed-tools`, skill hooks, `model`,
`effort`, `shell`, skill shell commands, `Skill(...)` permission rules (opencode's own `skill` permission is
unchanged), and skills cli.js discovers mid-session. The catalog applies when a pi session spawns and when opencode
opens a folder; a skill file edited afterwards applies on the next spawn or folder rebuild. A skill or command that
loads in a Claude session in a folder is offered under the same name in a pi or opencode session there; a disabled
plugin's or an `off` skill is not.

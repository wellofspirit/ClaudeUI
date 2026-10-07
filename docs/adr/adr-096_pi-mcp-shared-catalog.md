# ADR-096: pi sessions get ClaudeUI's shared MCP catalog through `registerMcpServer`

**Status:** Accepted (2026-10-06, owner decision). Built on branch `pi-mcp` (based on
`harness-pins`: pi pinned and floored at 1.0.4).
**Amends:** [ADR-035](adr-035_pi-engine-backend.md) ("pi has no MCP client" — pi 1.0 has one, and
ClaudeUI now feeds it), [ADR-089](adr-089_pi-subagents-host-run.md) (children register the parent's
catalog; MCP entries in an agent's tool lists are spelled the way pi names MCP tools).
**Relates to:** [ADR-068](adr-068_chatgpt-identity-vault-owned-codex-injection.md) §5 (the Codex
bridge of the same catalog), [ADR-028](adr-028_opencode-native-config-in-place.md) / the opencode
`claude-mcp-bridge.ts` (the opencode bridge), [ADR-022](adr-022_opencode-permission-mapping.md) and
[ADR-085](adr-085_deny-ask-rules-hold-allow-rules-skip-judge.md) (the shared permission ladder and
the auto-mode allow-rule skip), [ADR-030](adr-030_capability-honesty.md) (no flag
claims what does not work), [ADR-079](adr-079_claude-harness-capability-gating-and-patch-set.md) (the MCP dialog stays
Claude-only).

## Context

ClaudeUI has one MCP catalog: the Claude-scoped servers McpDialog manages — user
(`~/.claude/.mcp.json` + `settings.json`), project (`<cwd>/.mcp.json` + `.claude/settings.json`),
local (`.claude/settings.local.json`) — minus the cwd's `disabledMcpServers`. Claude reads it
natively; opencode (`opencode/claude-mcp-bridge.ts`, runtime-only through
`OPENCODE_CONFIG_CONTENT`) and Codex (`codex/codex-mcp-bridge.ts`, a per-thread `config` override)
inherit it. pi sessions got none of it.

pi 1.0 ships an MCP client as a built-in extension (`vendor/pi-src/packages/coding-agent/src/extensions/mcp/`,
v1.0.4) that reads pi's own `~/.pi/agent/mcp.json` and the trusted project's `.pi/mcp.json`, and
an extension API to add servers at runtime: `pi.registerMcpServer(name, config)`
(`src/core/extensions/loader.ts`, `src/core/mcp-servers.ts`). Read in the source:

- a registration is session-only and must be repeated on every load (pi reloads extensions on
  `fork` / `switch_session` / `new_session`); registered while extensions load, the server connects
  at `session_start` next to `mcp.json`'s servers; registered later, right away;
- a `mcp.json` server whose namespace equals a registered one's wins, and the registration is listed
  as overridden;
- `validateMcpServerConfig` refuses names outside `[A-Za-z0-9_-]`, legacy SSE, non-http(s) URLs,
  and throws; the clash check for names that differ only in `-`/`_` reads the committed registry,
  so it cannot see two registrations staged in the same load;
- tools are named `mcp__<server>__<tool>` passed through `[^A-Za-z0-9_]` → `_` (hash-suffixed past
  64 characters);
- every MCP call runs through pi's tool pipeline, so `tool_call` hooks see it;
- stdio `env` and HTTP `headers` values are config templates (`core/resolve-config-value.ts`): a
  leading `!` runs a shell command, `$NAME` / `${NAME}` interpolate;
- exposure defaults to `codemode` (tools reachable only from a script tool); `direct` declares them
  to the model like built-ins.

## Decision

The owner's rulings (Daniel, 2026-10-06): pi gets the ONE shared catalog, exactly as opencode does
(option "A": runtime-only, never written to pi's own config, secrets only in memory); bridged
servers are `exposure: "direct"`; no `--no-mcp` — pi's own MCP keeps working; every MCP call goes
through ClaudeUI's normal permission engine (the existing fail-closed bridge `tool_call` gate).

### 1. One read, one translator

`readEnabledClaudeMcpServers(cwd)` (`services/claude-mcp.ts`) is the merge-minus-disabled read the
opencode, Codex and pi bridges now share. `src/core/pi/pi-mcp-bridge.ts`
translates each entry into pi's shape — stdio `{type, command, args, env, cwd?}`, streamable HTTP
`{type, url, headers}`, always `exposure: "direct"` — and SKIPS, with a reason, what pi would
refuse: SSE, `sdk`/other transports, invalid names, bad URLs, no command or url, ClaudeUI's reserved
names (`claudeui`, `claude-ui`, `claude-ui-mockup`, `claude-ui-collab`, compared by pi namespace),
and the second of two names pi would put in one namespace. One bad entry never costs the others.
Skips are logged and shown once per session as a `session:warning`.

Values: Claude's `${VAR}` / `${VAR:-default}` are expanded host-side against ClaudeUI's environment
(an unset variable stays as written; its NAME is logged), then escaped for pi (`$` → `$$`, leading
`!` → `$!`), so a header that starts with `!` can never become a command and a `$` in a password
survives.

### 2. Delivery over the authenticated host channel, not an env var

`PiSession.doStart` reads the catalog at every spawn and hands the snapshot to its `PiBridgeHost`
(`mcpServers`). The bridge extension (v13), when `CLAUDEUI_PI_MCP=1`, `POST`s `/mcp-servers` with
the bridge token while pi loads it (the factory returns that promise and pi awaits it; 10 s bound),
then calls `registerMcpServer` per entry. A refused entry or a failed fetch never throws out of the
factory (pi would discard the whole extension, gate included); failures become one `session_start`
notify starting `MCP `.

Why not an env var (opencode's `OPENCODE_CONFIG_CONTENT` precedent): pi's process env is inherited
by every bash command and every stdio MCP server pi starts, so `env` would print every bridged
secret into the model's context. Nothing forces env here — the factory may be async. The route is
repeatable (pi reloads extensions on fork), so a process holding the token (an approved command, an
MCP server — the token is in pi's env, the ADR-035 A1 model) can read the catalog; that is no wider
than the source, since the same processes run as the same user and can read `.mcp.json` directly.

### 3. Collision rule

pi's own `mcp.json` wins (pi's native rule). ClaudeUI reads only the NAMES pi's files define
(`readPiNativeMcpServerNames`) and logs the collision; the entry is still sent and pi applies the
rule. pi's own MCP servers are never edited or removed by ClaudeUI.

### 4. Permissions

MCP calls reach the bridge's `tool_call` hook under pi's names. The shared ladder gains
`PermissionEngineContext.mcpRuleKey`: pi's gates (the session, its children, the dispatcher's pi
target) pass `piMcpRuleKey`, which spells a Claude rule's tool name the way pi names tools, so
`mcp__my-server__get-issue`, `mcp__my-server` and `mcp__my-server__*` bind to
`mcp__my_server__get_issue` in every tier. Codex passes nothing (it names calls in Claude's form). In
auto mode the allow-rule skip maps pi's server back to its Claude name when exactly one known server
(catalog + pi's own) fits, and compares tool names through the same sanitizer (`mcpToolKey`). No
MCP tool is auto-allowed: the mode base asks, as on Claude.

### 5. Rendering

Unchanged and already at parity: `mcp__*` is the `mcp` kind (`hostedMcpKind`), the header is the raw
tool name and the body is `McpBody`, exactly as for Claude; live (`event-mapper.ts`) and cold
(`pi-session-list.ts`) handle MCP calls generically, so they agree. pi's names carry `_` where a
Claude server name has `-`.

### 6. Subagents and dispatch targets

A host-run child registers its PARENT's snapshot (served by the child's own bridge host,
`CLAUDEUI_PI_MCP=1`), as a Claude subagent sees its parent's MCP tools, and is gated by the parent's
gate. Tool lists follow Claude's rule with pi 1.0.4's semantics: `tools: inherit` → every MCP tool;
an explicit list with no `mcp__` entry → no MCP tool is declared (pi keeps them registered but never
activates a `direct` one, `agent-session.ts` `_isActivatable`); `mcp__…` entries in `tools` /
`disallowedTools` are spelled in pi's form (`mcp__my-srv__get-issue` → `mcp__my_srv__get_issue`, a
bare `mcp__github` → `mcp__github__*`).

The dispatcher's pi TARGET registers the catalog too, as an opencode target does: `CLAUDEUI_PI_MCP=1`
in `buildPiTargetChildEnv`, and the spawn site hands the target's bridge host
`collectClaudeMcpForPi(cwd).servers` for the dispatch cwd. Its calls hit the target's gate (the
user's deny/ask rules with `mcpRuleKey`, then the target judge). MCP tools are not a recursion path —
the target still never gets `dispatch_agent`.

### 7. Catalog changes and live controls

The catalog applies at spawn and respawn (and a fork reload re-fetches the same snapshot). McpDialog
and its live verbs (`mcp:status`/`toggle`/`reconnect`) stay Claude-only — the TopBar entry is
`engineId === 'claude'`, as for opencode and Codex, and the verbs are gated on method presence, which
`PiSession` does not implement. Supporting them for pi needs a status channel pi does not offer over
RPC (connection state lives inside the MCP extension) — follow-up, not built.

### 8. OAuth

A catalog HTTP server with no `Authorization` header is OAuth to pi. RPC mode cannot sign in on its
own: pi marks the server "needs sign-in", the first prompt does not wait on it, and its notify
("MCP servers need attention: … needs sign-in") now reaches the user as a `session:warning` (the
event mapper surfaces `extension_ui_request` notifies of level warning/error that start `MCP `).
Proven credential-free in `src/integration/pi/pi-mcp.integration.test.ts`. Signing in through
`/mcp login` from ClaudeUI is untested (it opens a browser and waits on an `input` dialog ClaudeUI
never answers, though the loopback callback can complete it).

## Out of scope

Editing pi's native `mcp.json`; MCP live controls for pi; nested codemode-call rendering (bridged
servers are `direct`, so codemode only appears for pi's own `codemode` servers); "always allow"
suggestions for pi MCP calls (none are offered, as before).

## Consequences

- A pi session sees the same servers a Claude session in that cwd sees; secrets never reach an env
  var or a file.
- Bridge v13; the extension's factory is asynchronous only when `CLAUDEUI_PI_MCP=1`.
- A user rule written for Claude now binds to pi's MCP calls, including pi's own servers.

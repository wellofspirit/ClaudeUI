# Follow-up — opencode hosted tools via on-the-fly MCP (replace the global plugin)

> ROADMAP **#4**, reframed (user decision): instead of scoping the global plugin to a private config
> dir, **pass our hosted tools to opencode as an MCP server on the fly** — Claude-Code-style. ClaudeUI
> hosts an in-process **HTTP MCP server** exposing render_mermaid / create_mockup / show_mockup (the
> REAL `mermaid-tool.ts` / `mockup-tool.ts` impls — no plugin duplication), and injects it per-spawn via
> `OPENCODE_CONFIG_CONTENT`. The global plugin (`~/.config/opencode/plugin/claudeui.plugin.js`) is
> **deleted** — no more polluting the user's standalone opencode. Branch
> `v2-followup-opencode-mcp-onthefly` (off `v2-followup-opencode-reasoning`). opencode source ref:
> `D:\WorkPlace\opencode-src` (READ-ONLY).

## Verified facts (do NOT re-discover)

- **opencode takes config inline at spawn**: `Flag.OPENCODE_CONFIG_CONTENT` (env var) is merged into the
  effective config (`opencode-src/config/config.ts:250,324`). So set `OPENCODE_CONFIG_CONTENT='{"mcp":
  {"claudeui":{"type":"remote","url":"http://127.0.0.1:<port>/mcp","headers":{"Authorization":"Bearer
  <token>"},"enabled":true}}}'` in the spawn env. No global file.
- **opencode connects to remote MCP over StreamableHTTP** (SSE fallback) with auth `headers`
  (`opencode-src/mcp/index.ts:256-276`); `type:'remote'` schema `{type, url, headers?, enabled?,
  timeout?}` (`:73`). `type:'local'` (stdio command) also exists — we use **remote HTTP**.
- **opencode names MCP tools** `sanitize(serverName) + "_" + sanitize(toolName)`
  (`mcp/index.ts:646`), `sanitize = s.replace(/[^a-zA-Z0-9_-]/g,"_")` (`mcp/catalog.ts:110`) — preserves
  `_`/`-`. So server **`claudeui`** + tools `render_mermaid`/`create_mockup`/`show_mockup` →
  **`claudeui_render_mermaid`**, **`claudeui_create_mockup`**, **`claudeui_show_mockup`**. (Verify on a
  live probe / by reading sanitize; these are the expected names.)
- **Our MCP SDK ships the server transport**: `@modelcontextprotocol/sdk@^1.29` has
  `server/streamableHttp.js` → `StreamableHTTPServerTransport`. `create-sdk-mcp.ts` already wraps
  `McpServer` from this SDK.
- **The real tools** (reuse — no duplication): `mermaid-tool.ts` `createMermaidServer()` (render_mermaid,
  no cwd); `mockup-tool.ts` `createMockupServer(cwd)` (create_mockup/show_mockup; writes
  `<cwd>/.claude/ui/mockups/<id>`, served by the renderer's `mockup-asset://` protocol,
  `index.ts:344`). Both return `SdkMcpServer` (an `McpServer` wrapper). **cwd is baked in at
  construction** → the MCP endpoint must be **per-cwd**.
- **Renderer classification**: engine-independent `hostedMcpKind()` (`shared/tool-kinds.ts:87-93`) maps
  `mcp__claude-ui__render_mermaid`→diagram, `mcp__claude-ui-mockup__*`→mockup — these WON'T match
  opencode's `claudeui_*` names. `OpencodeEngineToolMap.kindOf`/`normalize`
  (`tool-registry/OpencodeEngineToolMap.ts:50-52,122-130`) currently classifies the RAW plugin names
  (`render_mermaid`/`create_mockup`/`show_mockup`) → diagram/mockup and reads args `{source,title}` /
  `{html,title}` / `{directory}`. **Update these cases to the `claudeui_*` names**; args unchanged.
- **Spawn**: `OpencodeServerManager.spawnServer` (`OpencodeServerManager.ts:81-92`) sets env incl.
  `OPENCODE_SERVER_PASSWORD` + `CLAUDEUI_SESSION_CWD`. The server is **per-cwd, ref-counted**
  (`acquire`/`release`, last-out-kills). The MCP endpoint lifecycle pairs with this.
- **Plugin to delete**: `ensure-plugin.ts` (`ensureOpencodePlugin`, `opencodePluginDir`),
  `src/main/opencode/plugin/claudeui.plugin.js`, the `ensureOpencodePlugin()` call site (grep), the
  electron-builder `opencode-plugin` extraResources entry, and `CLAUDEUI_SESSION_CWD` spawn env **iff
  nothing else reads it** (grep — the MCP server bakes cwd via `createMockupServer(cwd)`, so the plugin's
  use is gone).

## Design (locked)

A **per-cwd in-process HTTP MCP host**, lifecycle-paired with the per-cwd opencode server:

1. **Combined hosted-tools MCP server** — a factory `createOpencodeHostedToolsServer(cwd): McpServer`
   that registers all three tools (render_mermaid + create_mockup + show_mockup) on ONE `McpServer`,
   reusing the existing tool implementations from `mermaid-tool.ts` / `mockup-tool.ts`. (Extract the
   `tool()` definitions into reusable pieces, or compose; keep the impls canonical — do NOT duplicate
   logic.) Server name `claudeui`.
2. **HTTP MCP listener** — `src/main/opencode/mcp-http-host.ts`: a tiny Node `http` server bound to
   `127.0.0.1:0` (ephemeral) per cwd, wiring the `McpServer` to a `StreamableHTTPServerTransport`
   (`@modelcontextprotocol/sdk/server/streamableHttp.js`). Validate an `Authorization: Bearer <token>`
   header (per-cwd random token); 401 otherwise. Expose `{ port, token }`. One listener per cwd is the
   simplest correct topology (few concurrent cwds; auto torn down with the opencode server).
3. **Lifecycle in `OpencodeServerManager`** — on `acquire(cwd)` (first ref), start the MCP host for cwd
   (capture `{port, token}`); on `release(cwd)` (last ref, alongside `killProcess`), close it. Store the
   `{port, token}` on the server handle.
4. **Inject config at spawn** — `spawnServer` adds `OPENCODE_CONFIG_CONTENT` to the env:
   `{"mcp":{"claudeui":{"type":"remote","url":"http://127.0.0.1:${mcpPort}/mcp","headers":
   {"Authorization":"Bearer ${mcpToken}"},"enabled":true}}}`. (spawnServer must receive the mcp
   `{port,token}` — thread it through the spawn path.) Keep `OPENCODE_SERVER_PASSWORD`; drop
   `CLAUDEUI_SESSION_CWD` if unused after plugin removal.
5. **Renderer classification** — `OpencodeEngineToolMap.kindOf`: `claudeui_render_mermaid`→`'diagram'`,
   `claudeui_create_mockup`/`claudeui_show_mockup`→`'mockup'`; `normalize` reads the same args as today
   (source/title; html/title; directory). Remove the now-stale raw-name cases (or keep as a fallback).
6. **Delete the plugin** (files + call site + extraResources + `CLAUDEUI_SESSION_CWD` if dead).

**Why per-cwd HTTP listener (not one shared):** `createMockupServer(cwd)` bakes the cwd; a shared
listener would need per-connection cwd routing. Per-cwd listeners are isolated, auto-cleaned with the
ref-counted server, and dead simple. render_mermaid is cwd-less but rides along.

## Steps
1. `createOpencodeHostedToolsServer(cwd)` (compose the three tools onto one `McpServer`, reusing the
   real impls).
2. `mcp-http-host.ts` (HTTP listener + StreamableHTTPServerTransport + bearer auth + start/close).
3. `OpencodeServerManager`: start/stop the MCP host with the per-cwd server ref; thread `{port,token}`
   into `spawnServer`; inject `OPENCODE_CONFIG_CONTENT`.
4. `OpencodeEngineToolMap`: classify `claudeui_*` names.
5. Delete `ensure-plugin.ts` + `claudeui.plugin.js` + call site + extraResources + dead env.
6. Tests.

## Tests
- **mcp-http-host** (unit): a request without the bearer token → 401; with it → MCP initialize/list-tools
  returns render_mermaid/create_mockup/show_mockup. (Use the SDK client transport against the listener,
  or assert the wiring.)
- **OPENCODE_CONFIG_CONTENT** (unit): `OpencodeServerManager` spawn builds the env with a well-formed
  `mcp.claudeui` remote entry (url has the captured port; headers carry the token); MCP host started on
  acquire and closed on last release (use the existing fake-spawn harness + a fake/ephemeral listener).
- **OpencodeEngineToolMap** (unit): `claudeui_render_mermaid`→diagram, `claudeui_create_mockup`/
  `claudeui_show_mockup`→mockup; normalize reads source/title / html/title / directory.
- **mockup cwd**: `createOpencodeHostedToolsServer(cwd)` create_mockup writes under `<cwd>/.claude/ui/
  mockups` (reuse mockup-tool's existing test pattern).
- **Integration (gated, real binary)** — *this also chips at ROADMAP #13*: spawn a real `opencode serve`
  with the injected `OPENCODE_CONFIG_CONTENT`, then via the v1 API confirm opencode **connected** to our
  MCP server and lists `claudeui_render_mermaid` (e.g. GET the providers/tools or MCP status). This proves
  the wiring end-to-end WITHOUT needing the model to call the tool. Best-effort/skipped if no binary.
- Keep existing opencode + mockup + tool-registry tests green; remove/adjust plugin tests.

## Verify
```
bun run typecheck && bun run test && bun run test:ci && bun run lint && bun run build
```
- 0 lint errors (3 pre-existing warnings OK). **No `bun install`** (better-sqlite3 ABI). If you must add
  a dep, STOP and flag it — we should not need one (`@modelcontextprotocol/sdk` + node `http` suffice).
- **Real-app / live (orchestrator):** the orchestrator will drive a live opencode turn ("render a mermaid
  diagram of …" / "create a mockup …") and confirm the diagram/mockup card renders from the MCP tool, and
  that the user's global `~/.config/opencode/plugin/` is no longer written. Agent: report unit/gate +
  the gated-integration result.

## Gotchas
- **Per-cwd MCP host** — cwd is baked via `createMockupServer(cwd)`; one listener per opencode-server-cwd,
  started/stopped with the ref-counted server. Don't host a single shared listener.
- **Auth** — 127.0.0.1 + a per-cwd bearer token in both the listener check and the injected headers;
  reject unauthenticated (defense in depth, mirrors `OPENCODE_SERVER_PASSWORD`).
- **Tool names** — opencode → `claudeui_<tool>` (single underscore, sanitize preserves `_`). Don't expect
  `mcp__claude-ui__*`. Update `OpencodeEngineToolMap`, not the engine-independent `hostedMcpKind()`.
- **Reuse the real impls** — compose `mermaid-tool.ts`/`mockup-tool.ts`; do NOT re-port logic (the whole
  point vs the plugin). Args + on-disk mockup layout stay identical so the renderer cards + `mockup-asset://`
  serving are unchanged.
- **Claude untouched** — Claude's in-process MCP (createSdkMcpServer via McpHost/control-requests) is a
  separate path; don't touch it. This is opencode-only.
- **Lifecycle race** — close the MCP host only on the LAST release (mirror `killProcess`); a sibling
  session on the same cwd keeps it alive. opencode-src is READ-ONLY.

## Out of scope
- Migrating Claude's hosted MCP to HTTP (it works via control-requests; leave it).
- A shared (non-per-cwd) MCP host with connection-routed cwd.
- New hosted tools.

## Commit (orchestrator, after review + live drive)
One commit, no AI attribution. Suggested subject:
`feat(v2/opencode): host hosted tools as on-the-fly MCP server; drop the global plugin`.

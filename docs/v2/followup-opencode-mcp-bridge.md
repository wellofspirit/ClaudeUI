# Follow-up — bridge the user's Claude MCP servers into opencode (runtime, always-on)

> Kickoff spec (Phase B). Agent: **Sonnet, `general-purpose`**. Opus orchestrates, reviews every line,
> runs gates, commits. **You must NOT:** commit, `git add`, branch, `bun install`/`add`/`remove`, or
> self-certify. Leave the tree dirty for review; report changed files + exact gate output + deviations.

## 0. Why
opencode reads MCP servers ONLY from its own `mcp` config key — it does NOT scan `.claude` (unlike skills,
which it reads from `.claude/skills`). So the user's configured Claude MCP servers (`.mcp.json` /
`settings.json`) never reach opencode. This phase bridges them.

**Decisions (locked with the user):**
- **Plane = runtime inject** (NOT written to opencode's files). Translate Claude's MCP servers and add them
  to the `OPENCODE_CONFIG_CONTENT` `mcp` block at spawn, alongside the existing `claudeui` hosted-tools
  entry. Rationale: keeps secrets (env/auth headers) out of opencode's on-disk config, auto-reflects
  add/remove with zero sync, and matches ADR-028's ownership split (bridged/neutral config → runtime, not
  persisted into the engine's files). This is the neutral-layer extension ADR-028 flagged as a follow-up.
- **Always-on**, no toggle (consistent with how skills are already shared). Respect Claude's per-project
  `disabledMcpServers` list.

## 1. Verified facts (file:line; do NOT re-discover)
- **Source** (`src/main/services/claude-mcp.ts`): `loadMcpServers(scope, cwd?)` (scope `'user'|'project'|'local'`,
  returns `Record<string, McpServerConfig>` merged from `.mcp.json` + `settings.json`); `readDisabledMcpServers(cwd)`
  → `string[]` of disabled server names for that cwd.
- **Claude shape** `McpServerConfig` (`shared/types.ts:1421`): `{ type?: 'stdio'|'sse'|'http'; command?: string;
  args?: string[]; env?: Record<string,string>; url?: string; headers?: Record<string,string> }`.
- **opencode target** `ConfigMCPV1.Info` (`vendor/opencode-src/packages/core/src/v1/config/mcp.ts`):
  - Local (stdio): `{ type:'local', command: string[], cwd?, environment?: Record<string,string>, enabled?, timeout? }`
  - Remote (sse/http): `{ type:'remote', url: string, headers?: Record<string,string>, enabled?, oauth?, timeout? }`
- **Injection point** (`src/main/opencode/OpencodeServerManager.ts`): `buildOpencodeConfigContent(mcpPort, mcpToken)`
  (line 101) currently emits ONLY `{ mcp: { claudeui: { type:'remote', url, headers:{Authorization}, enabled:true } } }`.
  Called in `spawnServer(binary, cwd, password, mcpPort, mcpToken)` (the real spawnFn). `cwd` is available there.
- The fake `spawnFn` used in `OpencodeServerManager.test.ts` does NOT call `buildOpencodeConfigContent` — so the
  bridge's file I/O only happens on the real spawn path (lifecycle tests stay I/O-free).

## 2. The work

### 2a. NEW `src/main/opencode/claude-mcp-bridge.ts`
- Define the opencode MCP entry types (match ConfigMCPV1): a discriminated union
  `OpencodeMcpEntry = { type:'local'; command:string[]; environment?:Record<string,string>; enabled:true }
   | { type:'remote'; url:string; headers?:Record<string,string>; enabled:true }`.
- `translateClaudeMcpServer(cfg: McpServerConfig): OpencodeMcpEntry | null` — **pure**:
  - stdio (`type==='stdio'`, or no type but `command` present): `{ type:'local', command:[cfg.command!, ...(cfg.args ?? [])],
    ...(cfg.env && Object.keys(cfg.env).length ? { environment: cfg.env } : {}), enabled:true }`.
  - remote (`type==='sse'||type==='http'`, or no type but `url` present): `{ type:'remote', url: cfg.url!,
    ...(cfg.headers && Object.keys(cfg.headers).length ? { headers: cfg.headers } : {}), enabled:true }`.
  - otherwise (no command and no url) → `null` (skip).
- `collectClaudeMcpForOpencode(cwd: string): Record<string, OpencodeMcpEntry>` — does the I/O:
  - merge `loadMcpServers('user')`, then `loadMcpServers('project', cwd)`, then `loadMcpServers('local', cwd)`
    (later scope wins on name collision — local > project > user).
  - drop names in `readDisabledMcpServers(cwd)`.
  - **drop the reserved name `claudeui`** (so a user server can't clobber the hosted-tools block) — log a warning
    via `logger` if encountered.
  - translate each; skip nulls. Return the map (possibly empty). Wrap in try/catch → `{}` on any failure
    (best-effort; never block a spawn).

### 2b. `src/main/opencode/OpencodeServerManager.ts`
- `buildOpencodeConfigContent(mcpPort, mcpToken, bridgedMcp?: Record<string, OpencodeMcpEntry>)`: build the `mcp`
  object as `{ claudeui: {…existing…}, ...(bridgedMcp ?? {}) }`. Keep it **pure** (takes the already-translated
  map; no I/O). `claudeui` stays first; bridged entries can't include `claudeui` (filtered in 2a).
- `spawnServer(...)`: before building, `const bridgedMcp = collectClaudeMcpForOpencode(cwd)`, then
  `OPENCODE_CONFIG_CONTENT: buildOpencodeConfigContent(mcpPort, mcpToken, bridgedMcp)`. Import from
  `./claude-mcp-bridge`. (Do NOT change the `SpawnServerFn` signature — compute inside spawnServer, which has `cwd`.)

## 3. Tests
- **`claude-mcp-bridge.test.ts`** (node):
  - `translateClaudeMcpServer`: stdio `{command:'node',args:['x.js'],env:{A:'1'}}` → `{type:'local',command:['node','x.js'],environment:{A:'1'},enabled:true}`; sse `{type:'sse',url:'http://x',headers:{H:'v'}}` → `{type:'remote',url:'http://x',headers:{H:'v'},enabled:true}`; type-less with `command` → local; type-less with `url` → remote; `{}` (neither) → null; stdio without env omits `environment`.
  - `collectClaudeMcpForOpencode` (mock `./../services/claude-mcp` `loadMcpServers`/`readDisabledMcpServers`): merges scopes (local overrides project overrides user on name collision); excludes disabled names; excludes a server literally named `claudeui`; returns `{}` when nothing configured.
- **`buildOpencodeConfigContent.test.ts`** (extend): with a `bridgedMcp` arg, the `mcp` object contains BOTH
  `claudeui` AND the bridged servers; without the arg (or `{}`), output is unchanged (only `claudeui`). `claudeui`
  block intact (port/token) in both cases.

## 4. Verify gates (report exact output, do NOT commit)
```
bun run typecheck && bun run test && bun run test:ci && bun run lint && bun run build
```
0 lint errors (3 pre-existing exhaustive-deps warnings OK; the 5 pre-existing `model-discovery-*` test failures are
known-unrelated — do not try to fix them). No `bun install`. Leave tree dirty; list changed files + rationale. No
app-shot (orchestrator drives the real app). rm any throwaway probe scripts.

## 5. Gotchas
- **Secrets stay in env** — env/headers from Claude config go into `OPENCODE_CONFIG_CONTENT` (in-memory at spawn),
  NEVER into opencode's on-disk config. Do not write a file.
- **Reserve `claudeui`** — never let a bridged server use that name (would shadow the hosted-tools block).
- **Per-cwd, per-spawn** — `collectClaudeMcpForOpencode(cwd)` runs at each cwd spawn, so the bridge auto-reflects
  the user's current Claude MCP set (and disabled list) without any sync/cleanup.
- **Keep `buildOpencodeConfigContent` pure** — it takes the translated map; the I/O (reading Claude config) lives
  in `collectClaudeMcpForOpencode`, called from `spawnServer`. This keeps the existing mcp-only unit test and the
  fake-spawnFn lifecycle tests untouched in spirit.
- **Don't touch** Phase A's opencode-config.ts, permissions, or skills.

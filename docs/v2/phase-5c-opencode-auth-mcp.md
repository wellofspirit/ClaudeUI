# Phase 5c — opencode auth provider + hosted-tools plugin

> Final Phase-5 sub-phase (5a infra ✅ → 5b chat MVP ✅ → **5c auth + hosted-tools**). Implements
> [foundation 4](04-auth-accounts.md) / [ADR-021](../adr/adr-021_v2-auth-account-model.md) for the
> opencode engine, plus the ADR-019 hosted-MCP intent (re-scoped: **an opencode plugin**, not a
> cross-process bridge). **Claude auth is behavior-preserving.**
>
> Every wire detail below was captured from the real opencode 1.17.9 binary during scoping.

## Verified facts (ground-truth — build on these)

### Auth endpoints (v1)
- `GET /provider/auth` → `Record<vendorId, AuthOption[]>` — the **auth-option catalog** (what you CAN
  configure). Each option: `{type:'api'|'oauth', label, prompts?}`. The **array index** is the
  `method` arg for OAuth. (Captured: openai has oauth/oauth/api; github-copilot oauth w/ prompts; etc.)
- `GET /config/providers` → only **configured/usable** vendors (free `opencode` always; more after auth).
- `PUT /auth/{providerID}` body = `Auth` (anyOf `OAuth | ApiAuth | WellKnownAuth`); **ApiAuth =
  `{type:'api', key}`** → boolean. `DELETE /auth/{providerID}` → boolean. (`OpencodeClient.setAuth`/
  `removeAuth` already exist from 5a.)
- `POST /provider/{providerID}/oauth/authorize` body `{method:number, inputs?:Record<string,string>}`
  → `{url, method:'auto'|'code', instructions}`.
- `POST /provider/{providerID}/oauth/callback` body `{method:number, code?:string}` → boolean.
- Auth is **global to opencode** (`auth.json`), not per-server — so auth ops can run against a
  **transient server** (like `model-discovery` does), no session needed.

### Plugin / hosted-tools (re-scoped from "MCP injection")
- opencode runs tools **in its own process** via plugins. `config.plugin` with an absolute path does
  **NOT** load (verified — no trace even at DEBUG). The working mechanism is the **auto-load dir**:
  - **Global:** `~/.config/opencode/plugin/*.js` — applies to ALL cwds. **Verified**: a plugin here
    registered `render_mermaid`; the model called it in a neutral cwd; `execute()` ran. **This is our
    injection vehicle** (one ClaudeUI-managed file, namespaced — does not clobber user plugins).
  - (Project `<cwd>/.opencode/plugin/*.js` also works but is intrusive — don't use it.)
- A plugin module exports a `Plugin` fn returning `{ tool: { <name>: tool({description, args, execute}) } }`.
  `import { tool } from "@opencode-ai/plugin"` **resolves** for an auto-loaded plugin (opencode provides
  it). `tool.schema.string()/.optional()` are the Zod-like arg builders. "If a plugin tool uses the
  same name as a built-in tool, the plugin tool takes precedence."
- The plugin runs in opencode's Bun process; `process.cwd()` == the per-cwd server's cwd == the session
  cwd (we spawn one server per cwd). So the plugin can write mockup files to the right place.
- `OPENCODE_CONFIG_CONTENT` is honored (verified: `username`/`instructions` round-tripped via `/config`)
  — use it for non-plugin config if needed; **plugin loading is via the dir, not config.plugin**.

### Tool rendering (renderer)
- mermaid/mockup cards dispatch on the FULL tool name + read `toolInput`:
  - `mcp__claude-ui__render_mermaid` → `MermaidDiagram` from `toolInput.source` (+ `.title`).
    (`ToolCallBlock/View.tsx:203`.)
  - `mcp__claude-ui-mockup__create_mockup` / `mcp__claude-ui-mockup__show_mockup` → `MockupPreviewCard`;
    dir id from `toolInput.directory` else parsed from result text `/Directory:\s*(\S+)/`; HTML served
    via the `mockup-asset://` protocol from `<cwd>/.claude/ui/mockups/<id>/index.html`.
    (`ToolCallBlock/View.tsx:204-321`, `MockupPreviewCard.tsx`.)
- **Decision: normalize in the mapper** — map opencode tool names `render_mermaid`/`create_mockup`/
  `show_mockup` → the canonical `mcp__claude-ui__*` forms when building tool_use blocks. **Zero
  renderer changes.** The plugin's arg names MUST match (`source`/`title`, `html`/`title`,
  `directory`) and `create_mockup` MUST emit the same result text + on-disk layout as
  `src/main/services/mockup-tool.ts`.

## Scope (locked with the user: "auth + hosted-tools plugin")

Two parts; **deliver as two review passes under one `v2-phase-5c-opencode-auth-mcp` branch + one commit.**

### Part A — OpencodeAuthProvider + per-vendor auth UI

1. **Extend `EngineAuthProvider`** (`src/main/auth/EngineAuthProvider.ts`) with optional,
   capability-gated **per-vendor** methods (opencode's flow doesn't fit Claude's `signIn`/`submitCode`):
   ```ts
   // per-vendor driven login (canDriveLogin); used by multi-vendor engines (opencode)
   listVendorAuthOptions?(): Promise<Record<VendorId, VendorAuthOption[]>>   // GET /provider/auth
   setVendorApiKey?(vendorId: VendorId, key: string): Promise<void>          // PUT /auth {type:'api',key}
   oauthAuthorize?(vendorId: VendorId, method: number, inputs?: Record<string,string>):
     Promise<{ url: string; method: 'auto'|'code'; instructions: string }>
   oauthCallback?(vendorId: VendorId, method: number, code: string): Promise<boolean>
   removeVendorAuth?(vendorId: VendorId): Promise<void>                      // DELETE /auth/{vendor}
   ```
   `VendorAuthOption = {type:'api'|'oauth', label, prompts?}` (add to shared/types). Claude does NOT
   implement these (keeps `signIn`/`submitCode`). **This is an ADR-021 update — note it.**
2. **`OpencodeAuthProvider`** (`src/main/auth/OpencodeAuthProvider.ts`, register `'opencode'` in
   `register-auth-providers.ts`):
   - `probe()` → `VendorAuthMap`: acquire a transient server (mirror `model-discovery` — acquire
     `PERSISTED_SESSIONS_DIR`, use `OpencodeClient`, release). Merge `GET /config/providers` (configured
     → `authState:'authenticated'`) with `GET /provider/auth` (catalog → uncon­figured =
     `'unauthenticated'`). `billingType`: the free `opencode`/zen vendor → `'free'`; oauth-configured →
     `'subscription'`; api-configured → `'apiKey'`; else `'unknown'`. Degrade to `{}` on any failure
     (opencode optional).
   - `listVendorAuthOptions` / `setVendorApiKey` / `oauthAuthorize` / `oauthCallback` /
     `removeVendorAuth` → transient-server HTTP via `OpencodeClient`. After any **mutation**, call
     `invalidateOpencodeModelCache()` (5b) so newly-authed vendors appear in the model picker.
   - No account registry (`multiAccount:false`). Capabilities already say `canDriveLogin:true`.
3. **IPC routing** (`session.ipc.ts`): the existing `auth:*`/`account:*` stay Claude-hardcoded. Add
   **engine-routed vendor-auth channels**, dispatched via `engineAuthRegistry.require(engineId)`:
   `vendor-auth:probe(engineId)` → VendorAuthMap; `vendor-auth:list-options(engineId)`;
   `vendor-auth:set-key(engineId, vendorId, key)`; `vendor-auth:oauth-authorize(engineId, vendorId,
   method, inputs?)`; `vendor-auth:oauth-callback(engineId, vendorId, method, code)`;
   `vendor-auth:remove(engineId, vendorId)`. Add to the `SESSION_IPC_CHANNELS` list, preload, and
   `ClaudeAPI`. (Each guards the optional method; throws a clear error if the provider lacks it.)
4. **`session.account` for opencode** — `OpencodeSession.status.account`: populate from a cached probe
   for the session's model vendor (`probe()[vendorId]` → `AccountRef {engineId:'opencode', vendorId,
   billingType, authState, label}`). Cache the probe in `OpencodeAuthProvider` (like Claude's cached
   source) and refresh on auth mutation; re-emit status on model switch (cross-vendor flips it).
5. **Settings › Vendors UI** (`SettingsDialog/settings-sections.tsx` + a new control): when the opencode
   engine is installed, render an **opencode vendors** section listing vendors from
   `vendor-auth:list-options` with per-vendor auth status (from `vendor-auth:probe`). Per vendor:
   - `type:'api'` → an API-key input + **Save** (`vendor-auth:set-key`) + **Remove** if authed.
   - `type:'oauth'` (`method:'code'`) → **Login** → `oauth-authorize` → open `url` (shell.openExternal)
     + show `instructions` → paste-code input → **Submit** (`oauth-callback`).
   - `type:'oauth'` (`method:'auto'`, loopback) → **out of scope** for 5c: show a "use `opencode auth
     login` in a terminal" hint (delegated; foundation §4 ToS caveat — don't make subscription OAuth
     load-bearing). Keep it a clearly-labeled fallback.
   Gate this section to the installed opencode engine (mirror the existing tier-tree gating). Reading
   auth state can reuse a renderer store field (e.g. `vendorAuth` extended per engine) or fetch on open.
6. **Re-auth affordance (light):** map opencode `session.error` with `error.name ==='ProviderAuthError'`
   → `session:error` carrying a re-login hint. Full 401-card parity is **deferred**; just don't swallow it.

### Part B — Hosted-tools opencode plugin

1. **The plugin source** — `src/main/opencode/plugin/claudeui.plugin.mjs` (committed, shipped as an
   `extraResource`). Registers three tools via `@opencode-ai/plugin`:
   - `render_mermaid({source, title?})` → return `\`${title?`"${title}"`:'Diagram'} rendered
     successfully.\`` (skip the `@mermaid-js/parser` validation — not available in opencode's runtime;
     the renderer validates visually). Arg names MUST be `source`,`title`.
   - `create_mockup({html, title?})` → reuse the EXACT logic/format of `mockup-tool.ts`: `id =
     randomBytes(4).hex`, write `wrapHtml(html,title)` to `<cwd>/.claude/ui/mockups/<id>/index.html`
     (cwd = `process.cwd()` of the opencode server, == session cwd), return the SAME result text
     (`Mockup created successfully.\nDirectory: <id>\nPath: .claude/ui/mockups/<id>\n...`). Port
     `wrapHtml`/`escapeHtml` into the plugin (small, self-contained).
   - `show_mockup({directory})` → check `<cwd>/.claude/ui/mockups/<directory>/index.html` exists,
     return the same result text as `mockup-tool.ts`.
   Keep it framework-free (plain `.mjs`, node `fs`/`crypto`). The `Plugin` ctx may carry a directory;
   **verify the ctx shape during impl** and prefer it over `process.cwd()` if available.
2. **Plugin install/management** — `scripts/ensure-opencode-plugin.mjs` (or a main-process
   `ensureOpencodePlugin()` run at app start / first opencode use): copy the shipped plugin to
   `~/.config/opencode/plugin/claudeui.plugin.mjs`, **version-stamped** (overwrite only when our
   bundled version differs; namespaced filename — never touch other files in that dir). Idempotent.
   Locate the source via `app.getAppPath()` (dev) / `process.resourcesPath` (packaged) — mirror the
   binary locator. electron-builder `extraResources`: ship the plugin file.
3. **Mapper normalization** — in `event-mapper.ts`, when building a tool_use block, map the plugin tool
   names to canonical renderer names: `render_mermaid`→`mcp__claude-ui__render_mermaid`,
   `create_mockup`→`mcp__claude-ui-mockup__create_mockup`, `show_mockup`→`mcp__claude-ui-mockup__show_mockup`.
   (Keep the original `callID` for the tool-result binding.) A tiny `OPENCODE_TOOL_NAME_MAP`. This makes
   the existing renderer cards + mockup serving work unchanged.
4. **Capability flip** — `OPENCODE_ENGINE_CAPABILITIES.hostedMcp → true`. **Gating nuance:** verify the
   renderer's MCP **dialog** (Claude's `.mcp.json` server config) is NOT surfaced for opencode by the
   `hostedMcp` flip — that dialog is Claude-native config, not "our hosted tools." If `canUseMcp`/
   `hostedMcp` currently gates the MCP dialog, scope the dialog to `engineId==='claude'` (or a distinct
   gate) so flipping `hostedMcp` only enables our injected tools, not the Claude MCP config UI.

## Out of scope
- Loopback (`method:'auto'`) OAuth in-app → delegated hint (foundation §4).
- Multi-account for opencode (it has none).
- Full 401 re-auth card parity for opencode (light hint only).
- `@mermaid-js/parser` validation inside the plugin (renderer validates).
- Phase 6 tool registry / Phase 7 metering.

## Testing
- **OpencodeAuthProvider** unit tests (fake OpencodeClient + fake server manager): `probe()` merges
  config-providers + provider-auth into the right VendorAuthMap + billingType; `setVendorApiKey`/
  `oauthAuthorize`/`oauthCallback` call the right endpoints; cache invalidation fires on mutation.
- **EngineAuthProvider routing**: `vendor-auth:*` dispatches to the right provider by engineId; Claude
  provider lacks the per-vendor methods (graceful error).
- **event-mapper**: tool-name normalization (`render_mermaid`→`mcp__claude-ui__render_mermaid`, etc.)
  with callID preserved.
- **Plugin**: a small node test that imports the plugin module, invokes each tool's `execute` with a
  temp cwd, asserts mermaid returns success + mockup writes `<cwd>/.claude/ui/mockups/<id>/index.html`
  with the wrapped HTML + the exact result text. (No opencode binary needed — call execute directly.)
- All opencode code stays main-process-only; never loaded into renderer/shared test graph.

## Verify
```
bun run typecheck && bun run test && bun run test:ci && bun run lint && bun run build
```
- **Runtime smoke (verifier-electron + a backend smoke):**
  - Backend: spawn via the manager, run the auth probe (free `opencode` vendor → authenticated/free);
    set a throwaway API key for a vendor via `setVendorApiKey` and assert `/config/providers` then lists
    it (use a dummy key; just assert the PUT path works — or skip live key to avoid spend).
  - Plugin: after `ensureOpencodePlugin()`, drive a real opencode turn (free model) asking it to call
    `render_mermaid` + `create_mockup`; assert the tool parts arrive and (via the mapper) surface as
    the canonical `mcp__claude-ui__*` names; confirm the mockup file was written.
  - App: open Settings › Vendors with opencode installed → screenshot the opencode vendor list + an
    API-key form. Open a chat, get the model to render a mermaid diagram → screenshot the card. **Read
    the PNGs.**
  - Confirm Claude auth/login UX is unchanged (sign-in banner, accounts).
- Clean up any spawned `opencode.exe` (the 5b tree-kill + `dispose()` should handle it).

## Gotchas
- **Plugin dir, not config.plugin** — absolute paths in `config.plugin` silently don't load; write to
  `~/.config/opencode/plugin/`. Namespaced filename; never clobber the user's own plugins.
- **Plugin runs in opencode's process** — it can't import ClaudeUI main-process code; it reimplements
  the (self-contained) mermaid/mockup logic. Keep mockup's result text + on-disk layout byte-identical
  to `mockup-tool.ts` so the renderer card + `mockup-asset://` serving work unchanged.
- **Auth is global** — auth ops run against a transient server (acquire/release `PERSISTED_SESSIONS_DIR`);
  no chat session required. Invalidate the model cache after mutations.
- **Don't break Claude auth** — the live login path; the user is logged in. Keep `auth:*`/`account:*`
  untouched; add NEW `vendor-auth:*` channels. A detection bug = lockout.
- **`hostedMcp` flip** — make sure it doesn't surface Claude's MCP-config dialog for opencode.
- **better-sqlite3 ABI** — no `bun install`/`bun add`. No new runtime deps needed (global fetch,
  node fs/crypto, `@opencode-ai/plugin` is resolved BY opencode at plugin load — NOT a ClaudeUI dep).
- **ToS caveat** — subscription OAuth (Claude/ChatGPT) via opencode is a moving target; keep loopback
  OAuth delegated, not in-app.

## Commit
Branch `v2-phase-5c-opencode-auth-mcp` off `v2-phase-5b-opencode-chat`; **no AI attribution**; one
commit, multi-paragraph body. Suggested subject:
`feat(v2): opencode auth provider + hosted-tools plugin (Phase 5c)`.

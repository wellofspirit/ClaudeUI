# ADR-017: Codex backend via app-server protocol

**Status:** Accepted
**Date:** 2026-06-17

## Context

With the provider abstraction in place (ADR-016), a second backend — OpenAI Codex — needed
to be wired in. The primary question was how to drive it.

Codex exposes two public interfaces:
- **ACP (Agent Client Protocol)** — text-oriented, minimal bidirectionality.
- **`codex app-server`** — a richer NDJSON JSON-RPC 2.0 protocol over stdio: bidirectional
  requests, structured turn/thread/item events, streaming deltas, token usage, and per-item
  approval requests.

A secondary question was whether to download the binary at runtime, use the system PATH
binary, or vendor a pinned copy.

## Decision

### Drive `codex app-server` directly

ACP was rejected: it does not expose structured tool-call events, per-item approval
requests, or token usage — all of which ClaudeUI already surfaces for Claude. The
`app-server` protocol provides these natively and maps cleanly onto the existing
`ContentBlock`/`session:*` contract.

### Bundle a pinned binary

The Codex CLI binary (`codex app-server`) is downloaded from the `@openai/codex` npm package
at a pinned version and stored in `vendor/codex-cli/` (gitignored, like `vendor/claude-cli/`):

- `package.json#codexCliVersion` — the binary version (e.g. `0.140.0`)
- `scripts/ensure-codex.mjs` — downloads the platform binary; cache-hit skip on matching
  version stamp; wired into `postinstall`, `dev`, and every `build:*` script alongside
  `ensure-cli`
- `bun run update-codex` (= `ensure-codex --force`) — force re-download (use after bumping
  `codexCliVersion`)
- `electron-builder` `extraResources` — copies `vendor/codex-cli/` into the production app
- `src/main/codex/locate.ts` — resolves the binary path in dev (`vendor/codex-cli/codex`)
  and production (`<Resources>/codex-cli/codex`), mirroring `src/main/sdk/locate.ts`

Reasons for bundling rather than using PATH: version determinism, reproducible builds,
platform-specific binary selection, and a slot to drop in a custom build if ever needed.

### Generate plain-TS protocol types from the pinned schema source

The `app-server` protocol schema lives in `openai/codex`'s `codex-rs/app-server-protocol`
directory. Types are generated (not hand-written) from the JSON Schema at a pinned commit:

- `package.json#codexProtocolRef` — the git SHA of the schema source (e.g.
  `3ac9870e21f4ce9a28c3ae3b878b7f8f95eff06d` for tag `rust-v0.140.0`)
- `scripts/generate-codex-protocol.mjs` — fetches and generates `src/main/codex/protocol/`
  (`schema.ts` — the generated type catalog: params, responses, items, notifications
  (~839 types at the pinned ref); `methods.ts` — method catalogs + typed ByMethod lookups;
  `index.ts` — barrel export)
- `bun run generate-codex-protocol` — (re)generates; run after bumping `codexProtocolRef`
- Generated output is **checked in** — unlike the binary, the generated TS is committed so
  the build is hermetic and protocol diffs are reviewable on version bumps

`codexCliVersion` and `codexProtocolRef` must be bumped **together** — protocol decode
failures occur when they drift. See `docs/codex/maintenance.md`.

### Protocol client: `CodexAppServerClient`

`src/main/codex/CodexAppServerClient.ts` wraps the spawned child's stdio with NDJSON
JSON-RPC 2.0 semantics, reusing the `NdjsonReader`/`NdjsonWriter` transport from
`src/main/sdk/protocol.ts`:
- Frame discrimination: `id`+`method` → server request; `method` no `id` → notification;
  matches response envelope → response to our request.
- Monotonic integer request IDs; `Map<id, Deferred>` correlation.
- API: `request(method, params)`, `notify(method, params)`, `handleServerRequest()`,
  `handleServerNotification()`, `handleUnknownServerRequest()` (default reply `methodNotFound`).
- Stderr drained separately, never fed to the JSON parser; ERROR-level lines are surfaced.

### `CodexSession extends BaseSession`

`src/main/codex/CodexSession.ts` implements `ISession` for Codex:

**Lifecycle:**
1. Spawn `vendor/codex-cli/codex app-server` with `cwd` and expanded env (no `CODEX_HOME`
   override — see Known Gotchas below).
2. Handshake: `request initialize` → `notify initialized` → `thread/start` (or `thread/resume`
   with fallback to `thread/start` on "not found" errors). Capture `thread.id` as the resume
   cursor.
3. Emit `session:status` with `provider: 'codex'` and `CODEX_CAPABILITIES`.

**Permission-mode → Codex policy mapping:**
| ClaudeUI mode              | Codex `approvalPolicy` | Codex `sandbox`/`sandboxPolicy`    |
| -------------------------- | ---------------------- | ---------------------------------- |
| default / approval-required | `untrusted`           | `read-only` / `readOnly`           |
| acceptEdits / auto         | `on-request`           | `workspace-write` / `workspaceWrite` |
| bypassPermissions / full   | `never`                | `danger-full-access` / `dangerFullAccess` |

**Turn loop:** `turn/start {threadId, input, approvalPolicy, sandboxPolicy, model?,
reasoningEffort?}`. Effort: Codex accepts `low`/`medium`/`high`/`xhigh`; ClaudeUI's `max`
alias is omitted (Codex rejects it). ClaudeUI's `'default'` model alias is also omitted
(Codex rejects it).

**Notification → `ContentBlock`/`session:*` mapping** (in `mapCodexEvent.ts`):
- `item/agentMessage/delta` → `session:stream {type:'text'}`
- `item/reasoning/textDelta` / `summaryTextDelta` → `session:stream {type:'thinking'}`
- `item/commandExecution/outputDelta` → streaming tool output
- `item/started` → `session:message` (tool_use block; `toolUseId = item.id`)
- `item/completed` → `session:tool-result`
- `thread/tokenUsage/updated` → `session:status-line` (tokens only — no USD)
- `turn/completed` → `session:result` + status `idle`/`error`
- `error` → `session:error` or `session:warning` depending on `willRetry`

**Approvals:** server→client requests (`item/commandExecution/requestApproval`,
`item/fileChange/requestApproval`, `item/tool/requestUserInput`) park the JSON-RPC response
in a Deferred; `resolveApproval('allow')` → Codex decision `'accept'`;
`resolveApproval('deny')` → `'decline'`. v1 is allow/deny only; `acceptForSession` and
policy-amendment variants are a tracked follow-up (see Follow-ups below).

**Capabilities (`CODEX_CAPABILITIES`, frozen):**
```ts
{ thinkingModes: false, effortLevels: true, voice: false, hostedMcp: false,
  backgroundTasks: false, subagents: false, plan: true, costUsd: false,
  fork: true, sideQuestion: false }
```

**History:** `src/main/codex/CodexHistory.ts` — spawns a short-lived app-server, calls
`thread/read {threadId, includeTurns:true}`, maps turns/items to `ChatMessage[]`. Replaces
`session-history.ts` (which is Claude JSONL-specific) for Codex sessions.

**Auth status:** `src/main/codex/codexStatus.ts` — spawns a short-lived app-server, calls
`account/read {}`, maps the result to `CodexStatus {authenticated, email, planLabel,
requiresLogin, notInstalled?, error?}`. Distinguishes three failure modes: spawn error
(binary missing → `notInstalled: true`), RPC failure (`error` message), and unauthenticated
(`requiresLogin: true`).

### Auth fully delegated to the Codex binary

No in-app OAuth is built. This is the explicit opposite of ADR-014 (Anthropic OAuth):
Codex manages its own credentials under `~/.codex`; ClaudeUI surfaces only the auth state
returned by `account/read`. If unauthenticated, an inline status card instructs the user to
run `codex login` in a terminal.

### No Codex binary patching in v1

Codex app-server is compiled Rust — not regex-patchable like cli.js. No patch pipeline is
built in v1. If/when a concrete need arises, the options are:
- **Wire-observable behavior** → in-process JSON-RPC frame interception in
  `CodexAppServerClient` (a `(frame) => frame | null` transform list). No separate process.
- **Non-wire behavior** → a `codex-rs` source fork + cross-platform Rust build.

These are designed *then*, not now.

### No ClaudeUI-hosted MCP in v1

Codex sessions start with no ClaudeUI-hosted MCP tools (mermaid, mockup). Tracked follow-up.

## Known Gotchas

**Never override `CODEX_HOME`.** `CODEX_HOME` *is* the directory the codex binary uses for its
config and credentials (`auth.json`), defaulting to `~/.codex`. An early bug set
`CODEX_HOME=$HOME`, which made codex look for credentials at `$HOME/auth.json` instead of
`~/.codex/auth.json` → every turn failed with HTTP 401 (`Missing bearer authentication`).
`withCodexAppServer` and `CodexSession` deliberately spawn with the environment unchanged
(`env: { ...process.env }`): a real, user-set `CODEX_HOME` still flows through, while an unset
one lets codex use its own `~/.codex` default.

## Consequences

- Version skew between binary and protocol types causes decode failures; managed by bumping
  `codexCliVersion` + `codexProtocolRef` together and running both `update-codex` and
  `generate-codex-protocol`. See `docs/codex/maintenance.md`.
- No patch pipeline: Codex behavior is unmodifiable in v1 beyond wire-level framing.
- Auth UX is minimal: a "run `codex login`" card rather than an in-app flow. Acceptable for
  the v1 MVP; may be revisited if Codex exposes an OAuth control request analogous to
  ADR-014.
- Usage dashboard remains Claude-only (`capabilities.costUsd: false` gates it off for Codex).

## Deferred follow-ups

1. `acceptForSession` + policy-amendment approval variants (Codex decision union).
2. ClaudeUI-hosted MCP tools in Codex sessions (inject via `-c mcp_servers.…`).
3. Codex multi-account / shadow-home overlay.
4. Usage dashboard for Codex (token-based; `thread/tokenUsage`, `account/rateLimits`).
5. Realtime/voice (`thread/realtime/*`), web-search and image-generation rendering polish.
6. Subagent/collab rendering (`collabAgentToolCall` / `subAgentActivity`).
7. Fail-fast missing-binary error surfaced to the user before session start.

## Related

- **[ADR-016](adr-016_provider-abstraction.md)** — the provider abstraction this backend
  plugs into.
- **[ADR-006](adr-006_rebundle-bun-binary.md)** — analogous bundling approach for Claude cli.js.
- **[ADR-014](adr-014_native-anthropic-oauth.md)** — native Anthropic OAuth; Codex auth is
  the opposite (fully delegated to the binary, no in-app flow).
- **`docs/codex/protocol-reference.md`** — method catalog and notification mapping detail.
- **`docs/codex/maintenance.md`** — version bump procedure.

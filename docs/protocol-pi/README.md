# pi wire protocol — verified integration notes

How ClaudeUI drives the [pi coding agent](https://github.com/earendil-works/pi) and what we
verified against the real binary. Everything here was probed on Windows against the pinned
standalone build (`package.json#piCliVersion`). The **authoritative protocol reference for the
pinned version ships inside the vendored payload**: `vendor/pi-cli/docs/rpc.md` (plus
`extensions.md`, `providers.md`, `session-format.md`, `settings.md`, `skills.md`) — consult those
before theorizing, they are version-exact and offline.

For source-level questions (internals not covered by docs), **do not** keep a vendored source
clone — shallow-checkout the pinned tag instead:

```bash
git clone --depth 1 --branch v<piCliVersion> https://github.com/earendil-works/pi <scratch-dir>
```

Key source locations: `packages/coding-agent/src/modes/rpc/` (RPC types + server),
`packages/coding-agent/src/core/session-manager.ts` (session files),
`packages/ai/src/auth/` (credentials), `packages/ai/src/providers/*.models.ts` (built-in catalog).

## Transport

- Spawn: `vendor/pi-cli/pi.exe --mode rpc [-e <extension.ts>] [--session <path>] [--no-session] [--session-dir <dir>]`,
  one process per ClaudeUI session (pi has no server mode; this is the claude-shaped lifecycle,
  not the opencode-shaped one).
- **Framing**: strict JSONL. Split stdout on `\n` only, strip a trailing `\r`, never use Node
  `readline` (it splits on U+2028/U+2029 which are legal inside JSON strings). Commands go to
  stdin one JSON object per line; optional `id` correlates the response.
- **stdout purity: verified** — with `--mode rpc` (with and without `-e` extensions) every stdout
  line parsed as JSON across full prompt/tool/abort/resume cycles. stderr is free-form logging.
- No version handshake exists. The pin is the contract: bumping `piCliVersion` requires re-running
  the gated integration suite.

## Commands ClaudeUI uses

See `vendor/pi-cli/docs/rpc.md` for full shapes. The integration surface:

| Command | Use |
|---|---|
| `prompt` (`message`, `images?`, `streamingBehavior?`) | send user input; **during streaming you MUST pass `streamingBehavior: "steer" \| "followUp"` or the command fails** |
| `steer` / `follow_up` | queue-steer parity |
| `abort` | interrupt current turn (session survives) |
| `set_model` (`provider`, `modelId`) / `get_available_models` | model switch + discovery |
| `set_thinking_level` (`off…max`) | reasoning control |
| `get_state` / `get_messages` / `get_entries` (`since` cursor, returns `leafId`) | state + history |
| `get_session_stats` | token/cost cross-check |
| `get_commands` | slash commands: extension commands, prompt templates, `skill:*` |
| `set_session_name` / `fork` / `get_fork_messages` / `switch_session` / `new_session` | session ops |
| `compact` / `set_auto_compaction` | compaction |
| `extension_ui_response` | reply to extension dialog requests |

## Events (verified sequence)

`response(prompt)` → `agent_start` → `turn_start` → `message_start` →
`message_update` (deltas: `text_start/delta/end`, `thinking_*`, `toolcall_*`) → `message_end` →
`tool_execution_start` → `tool_execution_update` (accumulated `partialResult`, replace-not-append) →
`tool_execution_end` → `message_end` (role `toolResult`) → `turn_end` → … → `agent_end` →
`agent_settled` (the real turn-complete signal; `agent_end` may be followed by retry/compaction/queued
continuations).

- Events carry **no stable message id** — the adapter must synthesize one per `message_start`
  (stream is strictly sequential per process).
- Abort: `message_end` arrives with `stopReason: "aborted"`, then `agent_settled`. Verified.
- Tool results also arrive as `message_end` with `message.role === "toolResult"`
  (`toolCallId`, `content`, `isError`).

## Verified doc drift (v0.80.10)

The shipped docs lag the wire in three places we care about:

1. `AssistantMessage.usage` additionally carries `reasoning` (tokens) and `totalTokens` — e.g.
   `{"input":1119,"output":5,"cacheRead":0,"cacheWrite":0,"reasoning":0,"totalTokens":1124,"cost":{…,"total":0.001149}}`.
2. `get_commands` entries carry `sourceInfo: {path, source: "cli"|…, scope, origin}` rather than
   the documented flat `path`/`location` fields.
3. `get_state` with no configured model returns a placeholder model object with
   `id/name/api/provider = "unknown"`, not `null`.

## Sessions on disk

- Layout: `~/.pi/agent/sessions/--<mangled-cwd>--/<ISO-ts>_<uuidv7>.jsonl`. Mangle rule (from
  `session-manager.ts`, verified): strip a leading `/` or `\`, then replace every `[/\\:]` with
  `-`, wrap in `--…--`. `D:\Work\App` → `--D--Work-App--`. Lossy one-way, same philosophy as our
  `projectKey` (ADR-025) — always map cwd → dir, never parse back.
- File format: documented in `vendor/pi-cli/docs/session-format.md` (header `{type:"session",
  version:3, id, timestamp, cwd, parentSession?}`, then tree entries `{type, id, parentId,
  timestamp, …}`; `message` / `model_change` / `thinking_level_change` / `compaction` /
  `branch_summary` / `session_info` / `label` / `custom` / `custom_message`).
- **Resume verified**: kill the process, respawn with `--session <file>` → same `sessionId`, full
  message history, and the model restored from `model_change` entries.

## Auth (`~/.pi/agent/auth.json`, 0600)

- Shapes: `{"<provider>": {"type":"api_key","key":"…"} | {"type":"oauth","refresh","access","expires",…extras}}`.
  Provider-id ↔ env-var table: `vendor/pi-cli/docs/providers.md`. Model catalog cache:
  `~/.pi/agent/models-store.json`.
- `get_available_models` returns only models whose provider has credentials (empty file → `[]`).
- **ChatGPT-subscription (provider `openai-codex`)**: same public OAuth client id as opencode's
  Codex flow (`app_EMoamEEZ73f0CkXaXp7hrann`), token entry structurally identical to opencode's
  `openai` entry; the ChatGPT account id is extracted from the access-token JWT claim, not from
  auth.json. A transplanted opencode token drives pi successfully (verified with
  `openai-codex/gpt-5.6-luna`).
- **Refresh-rotation caveat**: pi auto-refreshes expired OAuth tokens in place. If a token is
  *shared* with opencode (transplant), a pi-side refresh may rotate the refresh token and strand
  the opencode copy. Testing used an isolated `USERPROFILE`/`HOME` so the user's real
  `~/.pi` and opencode credentials are untouched; the product auth story is M3's.

## Extensions (the ClaudeUI bridge seam)

All **verified against the standalone `pi.exe`** (this was the M0 go/no-go):

- `-e <file.ts>` loads a TypeScript extension in RPC mode (compiled in-process; appears in
  `get_commands` with `sourceInfo.scope: "temporary"`).
- `pi.on("tool_call", handler)` — returning `{block: true, reason}` **provably prevents tool
  execution**; the reason lands in the `toolResult` message the model sees. `event.input` is
  mutable for allow-with-edits.
- The extension can `fetch()` a loopback HTTP endpoint and make the block decision from the
  response — the ClaudeUI approval-bridge architecture works end-to-end (per-spawn callback URL
  via env var).
- `ctx.ui.confirm/select/input/editor` emit `extension_ui_request` on stdout and block for an
  `extension_ui_response` on stdin; `notify`/`setStatus`/`setWidget`/`setTitle` are
  fire-and-forget. `ctx.mode === "rpc"`, `ctx.hasUI === true`.
- Useful shipped references: `vendor/pi-cli/examples/extensions/permission-gate.ts`,
  `examples/rpc-extension-ui.ts` + `examples/extensions/rpc-demo.ts`, `examples/extensions/subagent/`,
  `examples/extensions/plan-mode/`.

Probed for M5a (2026-07-20, same binary):

- **Imports work in `-e` extensions** — node builtins (`node:fs`) AND relative imports
  (`./helper.ts`) resolve from an arbitrary file path outside any package context. (The ClaudeUI
  bridge stays import-free by choice, not necessity — its tmp-file tamper surface is smaller that way.)
- **Action methods throw during extension load** — `getActiveTools()`/`setActiveTools()` at module
  top level fail the whole extension with "Extension runtime not initialized". Top level is for
  registration only (`registerTool`/`registerCommand`/`pi.on`); act inside event/command handlers.
- **`pi.setActiveTools()` works at runtime in RPC mode** — probed `["read","bash","edit","write"]`
  → `["read","grep","find","ls"]` round-trip via `getActiveTools()` from a command handler.
- **`pi.registerTool()` auto-activates** the tool (the M4a hosted tools rely on this); hide-until-
  needed requires an explicit `setActiveTools` filter afterwards.
- **Extension commands execute via the RPC `prompt` command** (`{"type":"prompt","message":"/name"}`)
  — "immediately even during streaming" (rpc.md) — this is ClaudeUI's inbound extension-signaling
  channel (plan-mode enter/exit).
- **`session_start` fires at the initial `-e` RPC spawn** with `reason: "startup"` — a value the
  extensions.md docs don't list (they document `"new" | "resume" | "fork"`). It also re-fires after
  session switch/fork reloads (fresh extension instance), which is what makes register-then-hide
  state machines safe across reloads.

## Behavior gotchas

- The RPC `bash` command (user-initiated, not model tool calls) enters LLM context **on the next
  prompt**, and emits no event.
- `prompt` responses signal *acceptance*; failures after acceptance surface only in the event
  stream.
- Windows: pi requires a bash (`C:\Program Files\Git\bin\bash.exe` auto-detected; `shellPath` in
  `~/.pi/agent/settings.json` overrides).
- Kill semantics: SIGTERM to the process works; bash child processes need tree-kill on Windows
  (same `taskkill` discipline as `OpencodeServerManager`).

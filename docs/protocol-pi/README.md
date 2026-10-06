# pi wire protocol — verified integration notes

Current tested release: **1.0.4** ([stable release](https://github.com/earendil-works/pi/releases/tag/v1.0.4)); floor = tested = **1.0.4**, ceiling **2.0.0** (ADR-082's next-major rule; owner, 2026-10-06 — the temporary 1.1.0 ceiling of the 1.0.2 bump is retired). A version in [1.0.4, 2.0.0) other than 1.0.4 runs as _untested_; only **1.0.4** was measured. The dated 0.84.3 findings below are historical probes, not fresh verification of every behavior on 1.0.4. The prior Windows 0.87.1 run passed all 13 gated tests, including live approval, hosted tools, subagents, dispatch, fork and clone. It used an isolated `PI_CODING_AGENT_DIR`, an explicit `openai-codex/gpt-5.6-luna` model entry, and a credential command that supplied the active vault access token over a pipe without copying tokens to disk or refreshing them. The credential gates honor `PI_CODING_AGENT_DIR`. Pi 0.87.1 persists system messages; fork/clone tests compare the complete expected transcript rather than assuming only user/assistant messages contribute to `messageCount`.

## 1.0.2 → 1.0.4 compatibility assessment (2026-10-06)

`git diff v1.0.2..v1.0.4` (51 commits; most of the 203 changed files are the new `pi-env`/durable packages and codemode, which ClaudeUI does not drive). Of the contracts ClaudeUI consumes:

- **RPC, session files, extension runner:** `packages/coding-agent/src/modes/rpc/`, `core/session-manager.ts`, `core/extensions/runner.ts` and `packages/agent/src/` are unchanged. `extensions/types.ts` adds one method to the pi-provided `ToolLoadout` (`getPromptGuidelines`). 0 commands, events or hooks added, removed or reshaped.
- **CLI:** one flag added (`--no-mcp`), none removed. `--tools` and `--exclude-tools` now take `*` patterns, and a `--tools` list with no `mcp__` entry keeps pi's own MCP tools _registered_ (previously it dropped them); they stay undeclared to the model unless `tool_search` is allowed, and are reachable through `codemode`. ClaudeUI passes `--tools`/`--exclude-tools` only for host-run subagents with an explicit tool list (`pi-subagents.ts`): a definition naming `codemode` or `tool_search` can now reach pi-configured MCP servers, still behind the bridge's `tool_call` gate; a literal `*` in a definition's (dis)allowed tools is now a glob.
- **Provider ids (1.0.3, breaking upstream):** the Azure provider was renamed `azure-openai-responses` → `azure` (provider key in `auth.json`, `models.json`, `settings.json`; the api id and `AZURE_OPENAI_*` env vars are unchanged). ClaudeUI's API-key vendor list (`src/core/auth/pi-vendor-ids.ts`) followed. `openai-codex` is unchanged.
- **Auth:** a started OAuth refresh now completes and persists the rotated refresh token even when its request is cancelled (1.0.3), which can only reduce lost-refresh-token cases for ClaudeUI's fed `openai-codex` credential. Output files (truncated tool output, codemode images) are now user-only (0600).
- **Ported classifiers:** `retry.ts` gained 5 patterns (ChatGPT subscription limit/unavailable, "model is at capacity", HTTP/2 pending-stream cancel) and `overflow.ts` 1 (z.ai CN) since 0.87.1; `src/core/pi/pi-agent-failure.ts` is re-synced to 1.0.4.

Credential-free checks on the 1.0.4 managed-store binary: the RPC/command/skill integration cases pass (5 of 13; the 8 model-call cases are credential-gated and were not run), and a bridge load registers all eight ClaudeUI tools with no extension error.

## 0.87.1 → 1.0.2 compatibility assessment (2026-10-05, historical)

Source comparison covered the original tested tag, not only the intervening local checkout (`git diff v0.87.1..v1.0.2`), across RPC types/server, extension types/runner, CLI arguments, session persistence and auth/provider code. Of the contracts ClaudeUI consumes:

- **RPC commands/events:** no command or event type was removed or renamed. Three success responses gained required `data.disposition`: `prompt` (`handled | queued | started`), `steer` and `follow_up` (`handled | queued`). ClaudeUI's generic response envelope already accepts `data`, so this is wire-compatible. Optional, unconsumed additions include nested-tool `parentToolCallId`, structured tool output, assistant `thinkingLevel` and nested-call history.
- **Extension API:** the consumed hooks and actions (`tool_call`, `resources_discover`, `session_start`, `project_trust`, `registerTool`, `registerCommand`, `sendMessage`, `getActiveTools`, `setActiveTools`) retain their shapes. Seven API methods were added (`registerToolRenderer`, `getSettings`, `registerMcpServer`, `unregisterMcpServer`, `getMcpServers`, `registerVirtualModel`, `unregisterVirtualModel`) and none was removed. Two hook event types were added (`mcp_servers_change`, `provider_stream_event`); six optional fields were added across existing tool hook events (`parentToolCallId` on five event records and `structuredContent` on `tool_result`), plus `structuredContent` on the corresponding handler result. Tool definitions and execution context gained optional MCP/codemode metadata and nested execution; existing definitions remain valid. Source inspection found no built-in codemode/MCP/tool-search name collision with ClaudeUI's tools; a real 1.0.2 load also registered all eight ClaudeUI bridge tools together with no extension error. Explicit `-e` files still load under `--no-extensions`.
- **CLI/session/auth:** none of ClaudeUI's spawn flags was removed. `--provider` now requires `--model` (ClaudeUI never sends it alone), `--no-extensions` additionally disables built-ins, and `--models` ignores empty patterns. Session files now flush on the first user message rather than waiting for the first assistant reply; the existing history reader accepts the same entry union. `openai-codex` remains registered with the same credential/provider id, although upstream now labels it legacy beside a new `openai` ChatGPT OAuth route.
- **Prompt disposition is newly observable, not a new hang:** a no-op extension command returned success and no `agent_settled` on both 0.87.1 and 1.0.2; only 1.0.2 added `data: {disposition: "handled"}`. Clients can use the field to avoid waiting when no independent extension work starts, but the old behavior is a pre-existing limitation rather than a 1.0 regression. ClaudeUI's own `/cui-deliver` may deliberately start independent work, so `handled` alone cannot replace its settle tracking.

No adapter change was required by the source diff or credential-free real-binary smoke tests. The model-call integration cases remain credential-gated and were not run during this assessment; therefore this is measured acceptance of **1.0.2**, not a claim that every historical wire note was manually re-verified.

How ClaudeUI drives the [pi coding agent](https://github.com/earendil-works/pi) and what we
verified against the real binary. Everything here was probed on Windows against the pinned
standalone build (`src/shared/harness-manifests/pi.json#tested`). The **authoritative protocol reference for the
pinned version is pi's own docs at the pinned tag**: `vendor/pi-src/packages/coding-agent/docs/rpc.md`
(plus `extensions.md`, `providers.md`, `session-format.md`, `settings.md`, `skills.md`) — consult
those before theorizing, they are version-exact and offline. (Until ADR-082 §8 unbundled pi, the
same files shipped in the vendored payload's `docs/`; the release archive in ClaudeUI's store,
`~/.claude/ui/harnesses/pi/<version>/docs/`, still carries them.)

`vendor/pi-src` is the upstream source checkout at the tested tag (CLAUDE.md's rule for engine
sources; gitignored). Create or move it with:

```bash
git clone --depth 1 --branch v<pi tested version> https://github.com/earendil-works/pi vendor/pi-src
```

Key source locations (in `vendor/pi-src`): `packages/coding-agent/src/modes/rpc/` (RPC types + server),
`packages/coding-agent/src/core/session-manager.ts` (session files),
`packages/ai/src/auth/` (credentials), `packages/ai/src/providers/*.models.ts` (built-in catalog).

## Transport

- Spawn: `<store>/pi/<version>/pi.exe --mode rpc [-e <extension.ts>] [--session <path>] [--no-session] [--session-dir <dir>]`,
  one process per ClaudeUI session (pi has no server mode; this is the claude-shaped lifecycle,
  not the opencode-shaped one).
- **Framing**: strict JSONL. Split stdout on `\n` only, strip a trailing `\r`, never use Node
  `readline` (it splits on U+2028/U+2029 which are legal inside JSON strings). Commands go to
  stdin one JSON object per line; optional `id` correlates the response.
- **stdout purity: verified** — with `--mode rpc` (with and without `-e` extensions) every stdout
  line parsed as JSON across full prompt/tool/abort/resume cycles. stderr is free-form logging.
- No version handshake exists. The pin is the contract: bumping the pi manifest's `tested` requires re-running
  the gated integration suite.

## Commands ClaudeUI uses

See `vendor/pi-src/packages/coding-agent/docs/rpc.md` for full shapes. The integration surface:

| Command                                                                              | Use                                                                                                                 |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `prompt` (`message`, `images?`, `streamingBehavior?`)                                | send user input; **during streaming you MUST pass `streamingBehavior: "steer" \| "followUp"` or the command fails** |
| `steer` / `follow_up`                                                                | queue-steer parity                                                                                                  |
| `abort`                                                                              | interrupt current turn (session survives)                                                                           |
| `set_model` (`provider`, `modelId`) / `get_available_models`                         | model switch + discovery                                                                                            |
| `set_thinking_level` (`off…max`)                                                     | reasoning control                                                                                                   |
| `get_state` / `get_messages` / `get_entries` (`since` cursor, returns `leafId`)      | state + history                                                                                                     |
| `get_session_stats`                                                                  | token/cost cross-check                                                                                              |
| `get_commands`                                                                       | slash commands: extension commands, prompt templates, `skill:*`                                                     |
| `set_session_name` / `fork` / `get_fork_messages` / `switch_session` / `new_session` | session ops                                                                                                         |
| `compact` / `set_auto_compaction`                                                    | compaction                                                                                                          |
| `extension_ui_response`                                                              | reply to extension dialog requests                                                                                  |

### `new_session` resets the MODEL too (pi 0.84.3, probed 2026-09-09)

`new_session` empties the conversation and mints a new `sessionId` (probed 2026-08-01), and
`--system-prompt` survives it — but the `set_model` selection does **not**. After
`set_model {openai-codex, gpt-5.6-luna}` → `prompt` → `new_session`, `get_state` reports pi's own
default (`gpt-5.4-mini`), and the next `prompt` on it returns an assistant message with
`content: []` in ~0.7 s, so `get_last_assistant_text` answers `{}` with no `text` key.

This bit the old auto-mode judge (`pi-judge.ts`, since removed), whose warm process reset between
verdicts: every second verdict threw `no assistant text` and landed on the human — strictly
alternating `auto-mode allow (stage=fast)` / `auto-mode BLOCK (stage=error)` in the log. **Any
warm-process design must re-apply `set_model` after every `new_session`.** The judge no longer
runs through pi at all: ClaudeUI makes its model call itself (ADR-081,
`src/core/automode/judge-http/`).

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

### `message_update` is deltas-only (BREAKING at 0.84.0)

Probed 2026-08-28 against the vendored 0.84.3 binary with `openai-codex/gpt-5.4-mini` (wire log in
the session scratchpad). The top-level shape is now exactly
`{type, usage, assistantMessageEvent}` — the cumulative `message` field and
`assistantMessageEvent.partial` are **gone** (upstream #7290; rpc.md: "intentionally omits").
A client that needs a live partial message must assemble it itself:

```json
{"type":"message_update","usage":{…},"assistantMessageEvent":{"type":"thinking_end","contentIndex":0,"content":""}}
{"type":"message_update","usage":{…},"assistantMessageEvent":{"type":"toolcall_start","contentIndex":1,"id":"call_LIh…|fc_039…","toolName":"write"}}
{"type":"message_update","usage":{…},"assistantMessageEvent":{"type":"toolcall_delta","contentIndex":1,"delta":"{\""}}
{"type":"message_update","usage":{…},"assistantMessageEvent":{"type":"toolcall_end","contentIndex":1,"toolCall":{"type":"toolCall","id":"call_LIh…|fc_039…","name":"write","arguments":{"path":"hello.txt","content":"hi"}}}}
```

- `contentIndex` orders the content blocks of the in-flight assistant message.
- `text_end.content` / `thinking_end.content` carry the block's **full accumulated string** — so
  each `*_end` overwrites its slot rather than appending. (`thinking` may be `""` with the real
  reasoning riding a `thinkingSignature` that only appears on `message_end`; unconsumed.)
- `toolcall_end.toolCall` is a complete `{type:"toolCall", id, name, arguments}` — the same shape
  `message_end`'s content array carries.
- `toolcall_start` carries `id` + `toolName` (0.84.3 fixed this — upstream #7953; they were absent
  in 0.84.0–0.84.2, so never resume-probe this against an older pin).
- New top-level `usage` (0.84.2) is cumulative for the in-flight message, but **may stay all zeros
  until completion** when the provider doesn't report mid-stream — openai-codex did exactly that on
  every update of both probed turns. ClaudeUI ignores it; `message_end.usage` is authoritative.
- `message_end` is unchanged and remains authoritative — its full `content` array replaces whatever
  the client assembled.

ClaudeUI's assembly lives in `src/core/pi/event-mapper.ts` (`PiMapperState.blocks`, keyed by
`contentIndex`, reset at both ends of an assistant message's life).

## Verified doc drift (v0.82.1; first verified v0.80.10)

The shipped docs lag the wire in three places we care about:

1. `AssistantMessage.usage` additionally carries `reasoning` (tokens) — e.g.
   `{"input":1119,"output":5,"cacheRead":0,"cacheWrite":0,"reasoning":0,"totalTokens":1124,"cost":{…,"total":0.001149}}`.
   (`totalTokens` was also undocumented at 0.80.10; the 0.82.1 docs now document it. `reasoning`
   remains undocumented.) Re-verified on the 0.84.3 wire (2026-08-28). #2 and #3 have NOT been
   re-probed since 0.82.1.
2. `get_commands` entries carry `sourceInfo: {path, source: "cli"|…, scope, origin}` rather than
   the documented flat `path`/`location` fields. Re-verified on the 0.82.1 wire (2026-07-29).
3. `get_state` with no configured model returns a placeholder model object with
   `id/name/api/provider = "unknown"`, not `null`. (Verified at 0.80.10; not re-probeable with
   credentials present — a real model resolves. Assumed still true.)

0.81.0–0.82.1 additions the adapter deliberately ignores (default-ignore in `event-mapper.ts`):
`summarization_retry_scheduled` / `summarization_retry_attempt_start` /
`summarization_retry_finished` (0.81.1) and `bash_execution_update` (0.82.0 — only fires for the
direct RPC `bash` command, which we never send). New command `get_available_thinking_levels`
(0.81.0) is a candidate replacement for the catalog-map half of `resolveCapsForModel`; not
adopted. 0.81.0 also folds tool/compaction/branch-summary usage into `get_session_stats` totals,
so a resumed session that compacted live shows a one-time cost jump versus its pre-restart
display (live path only sums assistant `message_end` usage) — accepted, not a double count.

## Sessions on disk

- Layout: `~/.pi/agent/sessions/--<mangled-cwd>--/<ISO-ts>_<uuidv7>.jsonl`. Mangle rule (from
  `session-manager.ts`, verified): strip a leading `/` or `\`, then replace every `[/\\:]` with
  `-`, wrap in `--…--`. `D:\Work\App` → `--D--Work-App--`. Lossy one-way, same philosophy as our
  `projectKey` (ADR-025) — always map cwd → dir, never parse back.
- File format: documented in `vendor/pi-src/packages/coding-agent/docs/session-format.md` (header `{type:"session",
version:3, id, timestamp, cwd, parentSession?}`, then tree entries `{type, id, parentId,
timestamp, …}`; `message` / `model_change` / `thinking_level_change` / `compaction` /
  `branch_summary` / `session_info` / `label` / `custom` / `custom_message`).
- **Resume verified**: kill the process, respawn with `--session <file>` → same `sessionId`, full
  message history, and the model restored from `model_change` entries.

## Auth (`~/.pi/agent/auth.json`, 0600)

- Shapes: `{"<provider>": {"type":"api_key","key":"…"} | {"type":"oauth","refresh","access","expires",…extras}}`.
  Provider-id ↔ env-var table: `vendor/pi-src/packages/coding-agent/docs/providers.md`. Model catalog cache:
  `~/.pi/agent/models-store.json`.
- `get_available_models` returns only models whose provider has credentials (empty file → `[]`).
- **ChatGPT-subscription (provider `openai-codex`)**: same public OAuth client id as opencode's
  Codex flow (`app_EMoamEEZ73f0CkXaXp7hrann`), token entry structurally identical to opencode's
  `openai` entry; the ChatGPT account id is extracted from the access-token JWT claim, not from
  auth.json. A transplanted opencode token drives pi successfully (verified with
  `openai-codex/gpt-5.6-luna`).
- **Refresh-rotation caveat**: pi auto-refreshes expired OAuth tokens in place. If a token is
  _shared_ with opencode (transplant), a pi-side refresh may rotate the refresh token and strand
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
- Useful shipped references (in `vendor/pi-src/packages/coding-agent/`):
  `examples/extensions/permission-gate.ts`, `examples/rpc-extension-ui.ts` + `examples/extensions/rpc-demo.ts`, `examples/extensions/subagent/`,
  `examples/extensions/plan-mode/`.

### Long-poll protocol (bridge v6, probed 2026-09-09)

**Bun's `fetch` has a default idle timeout, and it kills held bridge requests.** Probed inside pi's
embedded Bun 1.3.14 (pi 0.84.3) with a throwaway `-e` extension: a `fetch` to a server that never answers
rejects after **300.6 s** with a `DOMException` named `TimeoutError`. A standalone Bun 1.4.2 does the
same at 360 s. The original design held ONE request open until the decision was made — which for a
human approval is however long the card sits, and for a `dispatch_agent` run is the whole child run —
so anything past five minutes failed the tool call closed with
`ClaudeUI approval service unreachable (DOMException)` while ClaudeUI still displayed a live card.

So each exchange is now a sequence of BOUNDED requests (`pi-bridge-source.ts`'s single
`bridgeExchange` helper, `PiBridgeHost.ts`'s `inFlight` state machine):

- `POST /tool-call` and `POST /hosted-tool` START the work and hold the response for at most
  `holdMs` (**45 s** default). Settled in time → the decision / tool result inline, unchanged.
  Otherwise → `200 {"pending": true}`.
- `POST /tool-call/wait` and `POST /hosted-tool/wait`, body `{toolCallId}`, re-park on the same
  exchange under the same rules. Keys are `${route}:${toolCallId}` — the route MUST be part of the
  key, since a hosted tool passes through both routes carrying the same `toolCallId`. An unknown
  key → `404`, which the extension treats like any non-2xx: fail closed.
- A repeated INITIAL post for a live exchange parks like a wait; the handler never runs twice (no
  duplicate approval card, no double hosted-tool execution).
- At most one parked response per exchange; a result produced with nobody parked is buffered for the
  next wait.
- With nobody parked (after a `pending`, after a parked socket closed, or while a settled result
  sits uncollected) an `abandonMs` (**30 s** default) timer runs — the extension re-polls
  immediately, so that much loopback silence means the pi child is gone. On expiry the host drops
  the exchange and fires `onAbandoned`, which is how PiSession dismisses the now-pointless approval
  card and stops an orphaned dispatched child.
- Node's `http.Server` defaults (`requestTimeout` 300 s, `headersTimeout` 60 s) bound RECEIVING a
  request, not holding a response — no server option changes were needed.

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

Probed for M5b (2026-07-20, same binary):

- **Registered-tool `onUpdate({content, details})` payloads surface VERBATIM as
  `tool_execution_update.partialResult`** on the RPC wire — arbitrary nested `details` objects
  survive intact (the M5b subagent streaming contract rides this). `tool_execution_start` fires
  for registered tools too. The tool's FINAL return `{content, details}` additionally arrives via
  the toolResult `message_end`'s `.details` — two carriers for the terminal payload.
- **`-e` is repeatable** — `-e a.ts -e b.ts` loads both extensions.
- **Windows bunfs paths**: inside the bun-compiled `pi.exe`, `process.argv[1]` is
  `B:/~BUN/root/pi.exe` (drive-letter form, NOT the POSIX `/$bunfs/root/` the shipped subagent
  example checks for) and `fs.existsSync` returns TRUE for it (bun patches fs). Any
  "am I a compiled binary" detection must handle `X:[\\/]~BUN[\\/]` — the upstream example's
  `getPiInvocation` has this bug; our port fixes it.
- gpt-5.6-luna's `set_model` response data includes `thinkingLevelMap` with `xhigh`/`max` — the
  catalog DOES expose per-model higher-tier support (future: lift piModelCapabilities' conservative
  low/medium/high cap by reading this).

Probed for ADR-089 host-run subagents (2026-10-01, the 0.87.1 managed-store binary, an isolated
`PI_CODING_AGENT_DIR`, `PI_OFFLINE=1`, no model turn):

- **P1 `--session-dir <D> --session-id <id>`**: `get_state` reports `sessionId === <id>` and
  `sessionFile === <D>/<ISO-ts>_<id>.jsonl` — a FLAT layout, no `--<cwd>--` subdirectory under an
  explicit dir. No file is written before the first assistant message
  (`vendor/pi-src/packages/coding-agent/src/core/session-manager.ts` `_persist`). A fresh id prints
  `Warning: No project session found with id …` on stderr (harmless).
- **P2 `--append-system-prompt <text>`** appends inside `<addendum>…</addendum>` at the end of the
  system prompt, and the argument may be a FILE PATH: pi reads the file when it exists
  (`resource-loader.ts` `resolvePromptInput`).
- **P3 `--tools a,b` is an allowlist over built-in AND extension tools** — a registered extension
  tool missing from the list is inactive (`--tools read,grep,agent` gave `[read, grep, agent]`);
  `-xt <name>` removes one tool; no `--tools` gives pi's defaults plus every extension tool.
  Since 1.0.4 (source, not re-probed): entries may be `*` patterns, and a list without an `mcp__`
  entry keeps pi's own MCP tools registered for `codemode`/`tool_search` (see the 1.0.4
  assessment above).
- **P4 resume**: with an existing `<D>/<ts>_<id>.jsonl`, the same `--session-dir`/`--session-id`
  reopen it — but only from the cwd in its header. From a different cwd the same flags create a NEW
  session (`SessionManager.findById` filters by header cwd when the session dir is not pi's
  default), so a child must always be spawned with exactly the parent's cwd.
- **P7 `details` persists**: a tool's returned `details` lands on the `toolResult` message
  (`vendor/pi-src/packages/agent/src/agent-loop.ts`), and so in the session file — the
  `details.cuiAgent` history link rides this.

Probed for M5c fork/sideQuestion (2026-07-21, same binary):

- **`fork {entryId}` ALONE creates a new session file and switches the client to it, leaving the
  resumed SOURCE byte-unchanged** (sha256-verified) — the assumed clone-then-fork-on-the-clone
  two-step is unnecessary. `entryId` must be a USER message on the active branch (`get_fork_messages`
  lists them); fork drops that entry + everything after it. Entry ids are preserved across a
  resume, so a source-derived entryId works directly.
- **`clone` also creates a new session file + switches the client** (source untouched) but does NOT
  truncate — it's the only primitive for the "fork the LATEST message" case (no later user entry to
  fork at).
- Merely RESUMING a session that has never recorded a `thinking_level_change` entry makes pi
  auto-append one at load (before any command) — harmless for ClaudeUI-created sessions (which
  already have one, so re-resume is a no-op write; confirmed via hash).
- **`--no-tools` / `-nt` is accepted in `--mode rpc`** and disables bash/edit/write entirely — the
  enforced guard for the sideQuestion observer (a soft "don't act" prompt is not enough).
- pi has NO in-session non-persisting "ask" RPC (prompt/steer/followUp all persist to the active
  branch) and no equivalent of Claude's `side_question` control request — hence sideQuestion's
  transcript-fed ephemeral rather than an in-session query.

Probed for ADR-089 S3 (2026-10-02, pi 0.87.1 managed-store binary, isolated `PI_CODING_AGENT_DIR`,
`PI_OFFLINE=1`, no credentials; a scratch extension registering `cui-deliver` that base64-decodes its
args and calls `pi.sendMessage`):

- **P-S1** `prompt {message: '/cui-deliver <b64>'}` with `triggerTurn: false` at idle → `success:
true`; `message_start`/`message_end` with `role: 'custom'` and our `customType`; `get_messages`
  lists it as `custom`; the session file gains a `custom_message` entry (`display: true`).
  `Buffer` is available inside an extension.
- **P-S2** RPC `steer` sent at IDLE → `success: true`, then `get_state` shows `isStreaming: false`,
  `pendingMessageCount: 1`: the message is stranded until the next prompt. Never inject with
  `steer`/`follow_up`.
- **P-S3** the same command with `triggerTurn: true` at idle runs a full turn (`agent_start` …
  `agent_end`, `agent_settled`): one `agent_settled` per wake.
- **P-S4** a handler that throws still answers `success: true` (pi emits an `extension_error` from
  `command:cui-deliver`): the ack never confirms delivery, the `custom` message_end does.
- **P-S5** `get_commands` lists `cui-deliver` with `sourceInfo.scope: 'temporary'` (filtered out of
  ClaudeUI's slash menu with the other bridge commands).

At source (`vendor/pi-src/packages/coding-agent/src/core/agent-session.ts`, `rpc-mode.ts`,
`messages.ts`; `packages/agent/src/agent-loop.ts`):

- **S1** RPC `prompt` is fire-and-forget inside pi; the response is written once the preflight ends,
  so stdin commands are processed concurrently.
- **S2** `prompt()` runs an extension command first, even mid-stream, and returns; a prompt arriving
  while pi emits `agent_settled` is deferred until after it.
- **S3** `sendCustomMessage`: streaming + trigger → `agent.steer`; idle + trigger → a new run
  (deferred if settling); streaming + no trigger → appended at the END of the turn (the model does
  not see it in that run); idle + no trigger → appended now.
- **S4** a steered message is delivered after the current tool batch, before the next LLM call; the
  run keeps going while steering messages remain.
- **S5** `custom` messages reach the LLM as `user`-role messages and persist as `custom_message`
  entries — the marking lives in the role and `customType`, not in what the model sees.
- **S6** `abort()` does not clear the steer/follow-up queues: an undelivered steer survives an
  interrupt and is polled at the next run.
- **S7** `_runAgentPrompt` marks the run active synchronously before its first await, and the chain
  `prompt` → command handler → `pi.sendMessage` → `sendCustomMessage` has no await before it when
  the handler does not await: two back-to-back deliveries can never both start a run.
- **S8** a user prompt has awaits before its `isStreaming` check, so a delivery that starts a run
  inside that window makes the prompt fail "Agent is already processing"; once its ack is in, a
  delivery steers it.

Probed/verified for ADR-090 (2026-10-02, at source in `vendor/pi-src` v0.87.1, and in a recorded
session file + ClaudeUI log; no new probe run):

- **An abort during a tool batch ends the turn `stopReason: "error"`, not `"aborted"`.** The aborted
  batch leaves `hasMoreToolCalls` true and the loop requests the model again without checking the
  signal (`packages/agent/src/agent-loop.ts:182-243, 262-296`; aborted calls read "Operation
  aborted", 610-625; `bash` returns "Command aborted", `coding-agent/src/core/tools/bash.ts:356-357`).
  The request's setup (`coding-agent/src/core/sdk.ts:375-385` → `model-runtime.ts:638-643`) rejects
  on the aborted signal in `getAuth` (`model-runtime.ts:575-588`, 495-512), and `lazyStream` turns
  any setup failure into an assistant message with `stopReason: "error"`, `content: []`,
  `errorMessage: "The operation was aborted."` without consulting the signal
  (`packages/ai/src/api/lazy.ts:4-23, 46-60`); the loop ends on it (`agent-loop.ts:244-254`), then
  `agent_settled`. Every real provider maps an abort to `"aborted"`; the setup path is the hole
  (upstream bug). ClaudeUI suppresses the banner inside the user-stop window instead (ADR-090).

## MCP (pi 1.0 + ClaudeUI's shared catalog, ADR-094)

Source-read at v1.0.4 (`vendor/pi-src/packages/coding-agent/src/core/mcp-servers.ts`,
`src/extensions/mcp/`) and proven credential-free end to end by
`src/integration/pi/pi-mcp.integration.test.ts` (isolated `PI_CODING_AGENT_DIR`, a localhost
OpenAI-compatible provider in `models.json`, a stdio fixture server):

- **pi's own MCP** is a built-in extension: servers from `~/.pi/agent/mcp.json` and the trusted
  project's `.pi/mcp.json` (the bridge trusts every project ClaudeUI opens). ClaudeUI never passes
  `--no-mcp` and never edits those files.
- **`pi.registerMcpServer(name, config)`** adds a session-only server (config = one `mcpServers`
  entry). Registered while extensions load, it connects at `session_start`; later, right away.
  Re-register on every load: `fork` / `switch_session` / `new_session` rebuild the runtime and re-run
  every extension factory. A `mcp.json` server with the same namespace wins. Invalid names
  (outside `[A-Za-z0-9_-]`), legacy SSE and non-http(s) URLs throw; registrations staged in one load
  are NOT clash-checked against each other (ClaudeUI dedupes namespaces itself).
- **Tool names** are `mcp__<server>__<tool>` with `[^A-Za-z0-9_]` → `_` (`my-server` →
  `my_server`), hash-suffixed past 64 chars. Every call runs the `tool_call` hook (the gate).
- **Exposure**: default `codemode` hides tools behind the `codemode` script tool; ClaudeUI registers
  `direct` (declared like built-ins). The first prompt waits up to 10 s for `direct` servers.
- **Config values are templates** in `env` and `headers` (`core/resolve-config-value.ts`): a leading
  `!` RUNS A SHELL COMMAND, `$NAME`/`${NAME}` interpolate, `$$`/`$!` escape. ClaudeUI expands
  Claude's `${VAR}`/`${VAR:-default}` itself and escapes the result.
- **Stdio servers inherit pi's env** (`{...process.env, ...env}`), bridge token included.
- **Warnings reach RPC only as `extension_ui_request` notifies** (`method: "notify"`,
  `notifyType`): "MCP servers need attention: … needs sign-in / failed …", "MCP failed to load …".
  The event mapper surfaces warning/error notifies starting `MCP ` as `session:warning`.
- **OAuth**: an HTTP server without an `Authorization` header that answers 401 is "needs sign-in";
  nothing prompts and nothing hangs. `/mcp login` opens a browser and waits on an `input` dialog
  ClaudeUI does not answer (untested from ClaudeUI).
- **`--tools` without an `mcp__` entry** keeps MCP tools registered but never activates a `direct`
  one (`agent-session.ts` `_isActivatable`), so a subagent with an explicit list gets none —
  Claude's rule.

ClaudeUI's side: `src/core/pi/pi-mcp-bridge.ts` (translation, filtering, escaping, pi's own
names), `PiBridgeHost` `POST /mcp-servers` (the spawn-time snapshot, bearer-authenticated,
repeatable), bridge v13's `CLAUDEUI_PI_MCP=1` block (fetch, `registerMcpServer` per entry, one
`session_start` notify for failures; the factory returns that promise so pi waits).

## Behavior gotchas

- The RPC `bash` command (user-initiated, not model tool calls) enters LLM context **on the next
  prompt**, and emits no event.
- `prompt` responses signal _acceptance_; failures after acceptance surface only in the event
  stream.
- Windows: pi requires a bash (`C:\Program Files\Git\bin\bash.exe` auto-detected; `shellPath` in
  `~/.pi/agent/settings.json` overrides).
- Kill semantics: SIGTERM to the process works; bash child processes need tree-kill on Windows
  (same `taskkill` discipline as `OpencodeServerManager`).

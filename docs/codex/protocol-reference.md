# Codex App-Server Protocol Reference

> Pinned ref: `3ac9870e21f4ce9a28c3ae3b878b7f8f95eff06d` (tag `rust-v0.140.0`)
> Binary version: `codexCliVersion = 0.140.0` in `package.json`

---

## Overview

The Codex app-server speaks **NDJSON JSON-RPC 2.0** over `stdin`/`stdout`. The ClaudeUI
client (`CodexAppServerClient`, Phase 3) spawns `vendor/codex-cli/codex app-server` and
drives it using the protocol types generated into `src/main/codex/protocol/`.

Frame types:

| Frame | Discriminator | Direction |
| --- | --- | --- |
| Request | has `id` + `method` | either direction |
| Response | has `id` + (`result`\|`error`), no `method` | reply to request |
| Notification | has `method`, no `id` | either direction |

---

## Generated types

Three files under `src/main/codex/protocol/`:

| File | Contents |
| --- | --- |
| `schema.ts` | 604 TypeScript interfaces/type aliases from all JSON Schema definitions (root + v1/ + v2/ namespaces) |
| `methods.ts` | Method catalogs (`CLIENT_REQUEST_METHODS`, etc.) + typed `ByMethod` interfaces for params/responses |
| `index.ts` | Barrel re-export of both |

Regenerate after bumping `codexCliVersion`:

```sh
bun run generate-codex-protocol
```

---

## Protocol surface (at pinned ref)

### Client → Server requests (84)

Key methods ClaudeUI will use in Phase 4 (`CodexSession`):

| Method | Purpose |
| --- | --- |
| `initialize` | Handshake — send `clientInfo` + capabilities |
| `thread/start` | Create a new thread (session) |
| `thread/resume` | Resume an existing thread by `threadId` |
| `thread/fork` | Fork a thread at a given turn |
| `turn/start` | Start a new turn (send user prompt) |
| `turn/steer` | Steer a running turn |
| `turn/interrupt` | Interrupt the active turn |
| `model/list` | List available models |
| `account/read` | Read account info (auth probe) |
| `account/rateLimits/read` | Rate limit status |
| `thread/read` | Load turn history for resume |

Full list: `CLIENT_REQUEST_METHODS` in `methods.ts`.

### Client → Server notifications (1)

| Method | Purpose |
| --- | --- |
| `initialized` | Sent after `initialize` response, before any `thread/*` calls |

### Server → Client requests (10)

These require ClaudeUI to respond synchronously with a JSON-RPC response.

| Method | Purpose |
| --- | --- |
| `item/commandExecution/requestApproval` | Approval prompt for shell command |
| `item/fileChange/requestApproval` | Approval prompt for file write/delete |
| `item/tool/requestUserInput` | AskUser-style question |
| `item/permissions/requestApproval` | Permission escalation |
| `item/tool/call` | Dynamic tool call (Phase 3+) |
| `account/chatgptAuthTokens/refresh` | Auth token refresh (reply `methodNotFound` in v1) |
| `mcpServer/elicitation/request` | MCP elicitation (reply `methodNotFound` in v1) |
| `attestation/generate` | Attestation (reply `methodNotFound` in v1) |
| `applyPatchApproval` | Patch apply approval (legacy) |
| `execCommandApproval` | Exec command approval (legacy) |

### Server → Client notifications (66)

Key notifications ClaudeUI maps to `session:*` events in Phase 4:

| Method | Maps to |
| --- | --- |
| `item/agentMessage/delta` | `session:stream {type:'text', text:delta}` |
| `item/reasoning/textDelta` | `session:stream {type:'thinking', text:delta}` |
| `item/reasoning/summaryTextDelta` | `session:stream {type:'thinking', text:delta}` |
| `item/started` | `session:message` (tool_use block) |
| `item/completed` | `session:tool-result` |
| `item/commandExecution/outputDelta` | streaming tool output |
| `turn/completed` | `session:result` |
| `turn/plan/updated` | plan/todo widget feed |
| `turn/diff/updated` | git/diff panel |
| `thread/tokenUsage/updated` | `session:status-line` (tokens) |
| `error` | `session:error` or `session:warning` |

Full list: `SERVER_NOTIFICATION_METHODS` in `methods.ts`.

---

## Keeping versions in sync

`codexCliVersion` (the binary) and `codexProtocolRef` (the schema source) must move
together — protocol decode failures occur otherwise.

When bumping:

1. Update `package.json#codexCliVersion` to the new version.
2. Find the corresponding `rust-v<version>` tag SHA:
   ```sh
   curl -s https://api.github.com/repos/openai/codex/git/refs/tags/rust-v<ver> | jq -r '.object.sha'
   ```
3. Update `package.json#codexProtocolRef` to that SHA.
4. Run `bun run update-codex` to download the new binary.
5. Run `bun run generate-codex-protocol` to regenerate types.
6. Run `bun run typecheck` + `bun run test` to verify.
7. Review the diff in `src/main/codex/protocol/` and update `CodexAppServerClient`
   and `mapCodexEvent.ts` for any changed method signatures.

See also: `docs/codex/implementation-plan.md` §4c on the patch-deferred strategy.

---
name: patch-test-harness
description: Write and run behavioral tests for cli.js patches. Use when creating, updating, or debugging patch test harnesses that verify cli.js patches are functioning correctly. Covers the five patches in PATCH_REGISTRY — subagent-streaming, voice-server, bash-output-streaming, subprocess-proxy-strip, skip-securestorage.
---

# Patch Test Harness

Write behavioral tests that verify cli.js patches work correctly by launching real sessions against the rebundled Bun binary (`vendor/claude-cli/bun-claude`) and asserting on the message stream.

## The patch set

The patches are listed in `PATCH_REGISTRY` (`patch/lib/patch-registry.mjs`) as `{ name, apply, marker }`; `patch/apply-all.mjs` runs them in that order. After a build, `vendor/claude-cli/version.json` `patches` lists the ones whose `/*PATCHED:…*/` marker is actually in the patched `cli.js` — the app reads that list to gate patch-dependent surfaces (ADR-077). Five patches today:

| Patch                    | Test                                                               |
| ------------------------ | ------------------------------------------------------------------ |
| `subagent-streaming`     | `patch/subagent-streaming/test.mjs` — live                         |
| `bash-output-streaming`  | `patch/bash-output-streaming/test.mjs` — live                      |
| `subprocess-proxy-strip` | `patch/subprocess-proxy-strip/test.mjs` — live                     |
| `skip-securestorage`     | `patch/skip-securestorage/test.mjs` — structural, offline          |
| `voice-server`           | none; its apply script's own checks are the only guard (see below) |

The other nine patches were deleted at Claude Code 2.1.280 or replaced by native cli.js surfaces (ADR-077; the list is in `docs/protocol-cc/01-transport.md` §1.12). Their tests went with them.

## Test Infrastructure

All test code lives in `patch/` alongside the patch apply scripts.

### Key Files

| File                     | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `patch/test-helpers.mjs` | Shared utilities: spawns `bun-claude` directly, exposes stream-json iterator + control channel (`stopTask`, `mcpServerStatus`, `toggleMcpServer`, `reconnectMcpServer`, `getUsage`, `getContextUsage`, `controlRequest(subtype, fields)` for anything else, `close`). Factories: `createQuery()`, `createStreamingQuery()`, helpers: `collectMessages()`, `TestRunner`, `dumpMessages()`, `MessageChannel`, `userMessage()`. |
| `patch/test-all.mjs`     | Runner for all patch tests (bounded pool, `PATCH_TEST_CONCURRENCY`, default 4; `=1` runs them one at a time)                                                                                                                                                                                                                                                                                                                 |
| `patch/<name>/test.mjs`  | Individual patch test (one per patch that has one)                                                                                                                                                                                                                                                                                                                                                                           |

**Prerequisite:** `vendor/claude-cli/bun-claude` must exist. Run `bun run ensure-cli` (or `bun run update-cli` after bumping `claudeCliVersion`). Tests auto-fail with a clear error if the binary is missing.

**Debug stderr:** set `DEBUG_HARNESS=1` to forward cli.js stderr to the terminal — useful when a test returns 0 messages.

**Overrides:** `CLAUDEUI_TEST_BIN=<path>` runs the tests against another binary (e.g. Anthropic's unpatched one, to see a patch's test fail without it), `CLAUDEUI_TEST_MODEL` replaces the default model, `CLAUDEUI_TEST_ENTRYPOINT` replaces `CLAUDE_CODE_ENTRYPOINT` (default `sdk-ts`).

### Running Tests

```bash
# Run all patch tests
bun run test:patch        # = node patch/test-all.mjs

# Run a single patch test
node patch/<name>/test.mjs
```

## Writing a Patch Test

### 1. Understand the Patch Behavior

Before writing, read the patch's `apply.mjs` and `README.md` to understand:

- What observable behavior the patch adds or fixes
- What SDK message types/subtypes should appear when it works
- What workflow triggers the patched code path

### 2. Choose the Right Query Helper

**`createQuery(prompt, opts, timeoutMs)`** — For simple one-shot prompts where the model runs to completion:

```js
import { createQuery, collectMessages, TestRunner, dumpMessages } from '../test-helpers.mjs'

const { q, cleanup, ac } = createQuery('Your prompt here', {}, 120_000)
const messages = await collectMessages(q, { cleanup })
```

**`createStreamingQuery(initialPrompt, opts, timeoutMs)`** — For multi-turn tests that need to send follow-up messages or steer mid-turn:

```js
import { createStreamingQuery, userMessage, collectMessages, TestRunner } from '../test-helpers.mjs'

const { q, channel, cleanup } = createStreamingQuery('Initial prompt', {}, 120_000)

// Send follow-up messages mid-turn via channel:
channel.push(userMessage('Follow-up steer message'))

// When done sending all input:
channel.end()
```

**Key difference:** `createQuery` passes a string prompt — the SDK runs one message and exits. `createStreamingQuery` passes an `AsyncIterable` — the SDK stays alive, each `channel.push(userMessage(...))` triggers a new turn.

### 3. Structure Your Test

Every test follows this pattern:

```js
#!/usr/bin/env node
import { createQuery, collectMessages, TestRunner, dumpMessages } from '../test-helpers.mjs'

const PROMPT = '...'  // Carefully crafted to trigger the patched code path

async function main() {
  const t = new TestRunner('patch-name')

  const { q, cleanup } = createQuery(PROMPT, {}, 120_000)
  const messages = await collectMessages(q, {
    cleanup,
    onMessage: (msg) => {
      // Optional: react to messages mid-stream (e.g., stop a task, send steer)
    },
  })

  dumpMessages(messages)

  // Assertions
  t.assertSome('description', messages, (m) => /* predicate */)
  t.assert('custom check', someCondition)

  const ok = t.summarize()
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.error('Unexpected error:', err)
  process.exit(1)
})
```

### 4. Assertion Patterns

**Check for a message type with fields:**

```js
t.assertSome(
  'stream_event from sub-agent',
  messages,
  (m) => m.type === 'stream_event' && !!m.parent_tool_use_id
)
```

**Check system notification:**

```js
t.assertSome(
  'task_notification with status stopped',
  messages,
  (m) => m.type === 'system' && m.subtype === 'task_notification' && m.status === 'stopped'
)
```

**Check a patch-emitted message type:**

```js
t.assertSome(
  'bash_output received',
  messages,
  (m) => m.type === 'bash_output' && typeof m.tool_use_id === 'string'
)
```

**Check MCP server status (via control request):**

```js
const servers = await q.mcpServerStatus()
t.assert(
  'MCP server connected',
  servers.some((s) => s.name === 'test-server' && s.status === 'connected')
)
```

**Check control request response shape** (SDK wraps in envelope):

```js
// A control request resolves with the inner `response` of the control_response
// envelope ({ subtype: 'success', request_id, response: {...} }). Read the
// field with a fallback in case a caller hands you the envelope itself:
const result = await q.controlRequest('voice_server_start')
const port = result?.port ?? result?.response?.port
t.assert('voice_server_start answered with a port', typeof port === 'number')
```

### 5. Prompt Design — Gotchas & Lessons Learned

- **Tool names change between SDK versions.** The `Task` tool was renamed to `Agent` in SDK 0.2.60+. Always check for both: `b.name === 'Task' || b.name === 'Agent'`.
- **MCP tool names are prefixed.** An MCP tool named `patch_test_echo` on server `test-server` becomes `mcp__test-server__patch_test_echo`. Use `.includes('patch_test_echo')` or a regex pattern instead of exact matching.
- **`effort: 'low'` may skip tool use.** Models with low effort often answer directly instead of using tools. Use `effort: 'medium'` for tests that require the model to call specific tools (e.g., sub-agent tests). Use `effort: 'low'` only when the test doesn't depend on which tools the model calls (e.g., MCP status checks where the prompt just says "say hello").
- Be **explicit and forceful** about which tools to use. "You MUST call the Tool tool right now. Do NOT answer directly." works better than "Use the Task tool to answer...".
- Keep prompts **minimal** — the model should do exactly one thing to trigger the code path.
- For background tasks, use `sleep` commands (reliable, predictable timing).
- Set `maxTurns: N` when you know the expected turn count.

### 6. Multi-Turn Streaming Tests

For tests that need multiple turns (e.g., MCP toggle on/off/on), use `createStreamingQuery` and track phases via the `onMessage` callback:

```js
let phase = 'waiting-init'
let resultCount = 0

const messages = await collectMessages(q, {
  cleanup,
  onMessage: async (msg) => {
    // Each 'result' message marks the end of a turn
    if (msg.type !== 'result') return
    resultCount++

    if (resultCount === 1) {
      // First turn done — do something (toggle, push next message)
      await q.toggleMcpServer('test-server', false)
      channel.push(userMessage('Next prompt'))
    }

    if (resultCount === 2) {
      // Second turn done — wrap up
      channel.end()
    }
  }
})
```

**Important:** `onMessage` is NOT awaited by `collectMessages`. This is fine because the SDK blocks on `channel.next()` between turns, so your async operations (toggle, status check) complete before the next turn starts. However, be careful not to push a new message before the async operation finishes.

**Each `channel.push(userMessage(...))` produces a new `init` → `assistant` → `result` cycle.** Expect N init messages for N turns — this is normal, not a session restart.

### 7. MCP Test Server

No current patch test uses an MCP server. `patch/mcp-test-server.mjs` — a minimal stdio server with one `patch_test_echo` tool — served only the `mcp-status` and `mcp-tool-refresh` tests and was deleted with them (commit 53809349, ADR-077). A new patch test that needs one has to recreate it first; `git show 53809349^:patch/mcp-test-server.mjs` prints the last version. `createQuery`'s `mcpServers` option passes the servers to cli.js as `--mcp-config`:

```js
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const __dirname = dirname(fileURLToPath(import.meta.url))

const { q, cleanup } = createQuery(
  PROMPT,
  {
    mcpServers: {
      'test-server': {
        command: 'node',
        args: [resolve(__dirname, '../mcp-test-server.mjs')]
      }
    }
  },
  120_000
)
```

That server provided one tool: `patch_test_echo` — takes `{ text: string }` and echoes it back. The model sees it as `mcp__test-server__patch_test_echo`.

**MCP server status shape** (returned by `q.mcpServerStatus()`, as observed with that server):

```json
{
  "name": "test-server",
  "status": "connected",
  "serverInfo": { "name": "patch-test-server", "version": "1.0.0" },
  "config": { "type": "stdio", "command": "node", "args": [...] },
  "scope": "dynamic",
  "tools": [{ "name": "patch_test_echo", "annotations": {} }]
}
```

After `toggleMcpServer(name, false)`: `status: "disabled"`, `tools: []`.

### 8. Handling Timeouts

- Default timeout: 120s (sufficient for most single-turn tests)
- Multi-turn tests: 180s (several turns plus the gaps between them)
- Background task tests: use `onMessage` callback to detect events and close early via `q.close()`

### 9. Registering New Tests

A new patch is registered twice. Its apply script goes into `PATCH_REGISTRY` (`patch/lib/patch-registry.mjs`) with a `marker` regex matching every `/*PATCHED:…*/` comment it writes — the `/patch-readme` skill and `docs/protocol-cc/01-transport.md` §1.12 cover that, and `src/main/__tests__/patch-registry.test.ts` fails when the directory, the registry and the markers disagree. Its test goes into `patch/test-all.mjs`:

```js
const tests = [{ name: 'my-patch', script: resolve(__dirname, 'my-patch/test.mjs') }]
```

## Patch-Specific Test Strategies

### subagent-streaming

**Trigger:** two sessions. Foreground: a forceful prompt to delegate a small repo lookup to the Agent tool (synchronous), `effort: 'high'`. Background: the same with `run_in_background=true`; close the session shortly after the first `task_notification` once subagent output has been seen.
**Assert:** `stream_event` with non-null `parent_tool_use_id` (the patch-only signal — an unpatched binary has none), and an `assistant` with non-null `parent_tool_use_id` carrying `thinking`/`text`. Check the tool name with `b.name === 'Task' || b.name === 'Agent'` (name varies by version). The harness does not pass `--forward-subagent-text` (the app always does; add it with `extraArgs` if a test needs the app's argv).

### bash-output-streaming

**Trigger:** one Bash command that prints a line every 0.2 s for 4 s, `effort: 'low'`.
**Assert:** `bash_output` messages arrive, with `tool_use_id`, `output`, `total_lines`, `total_bytes`, and at least one carrying the expected `line-` text.

### subprocess-proxy-strip

**Trigger:** two sessions with `NO_PROXY` set to a non-matching sentinel host in the parent env, each running one Bash command that prints `${NO_PROXY:-MISSING}`: first with `CLAUDEUI_PROXY_SUBPROCESSES` unset, then with it set to `1`. (A non-matching `NO_PROXY` exercises the strip list without routing the model's own API traffic through an unreachable proxy.)
**Assert:** default phase — the probe prints `MISSING`, never the sentinel; opt-in phase — the probe prints the sentinel. Read probes only from `bash_output` / `user` tool results, never assistant text. Restore the parent env in a `finally`.

### skip-securestorage

**Trigger:** none — structural and offline. The credential backend leaves no signal on the message stream, and on a clean machine both backends read the same file.
**Assert:** against `vendor/claude-cli/cli.js`: the marker occurs exactly once, the patched getter short-circuits to the plaintext backend when `SKIP_SECURESTORAGE` is set, and the rest of the getter still builds the fallback facade. On a Linux store-less bundle the correct state is the unpatched one (marker absent).

### voice-server

No test. `voice_server_start` answers `{ port }` and opens a localhost TCP server; exercising the transcription path needs audio and Anthropic's voice backend. The apply script's own checks (anchor, reply helper, chunk export) and the rebundle's per-chunk syntax check are what guard it, and `docs/protocol-cc/07-control-outbound.md` documents the control subtypes. A test would start with `q.controlRequest('voice_server_start')` and a TCP client.

## Debugging Failures

1. **Run the failing test directly:** `node patch/<name>/test.mjs`
2. **Check message dump** — `dumpMessages()` shows all collected messages with types/subtypes/parent IDs/teammate IDs
3. **No messages at all?** Check:
   - Valid API key (ANTHROPIC_API_KEY env var)
   - Patches are applied: `node patch/apply-all.mjs`
   - Not running inside another Claude Code session (test-helpers.mjs deletes `CLAUDECODE` env var, but double-check)
4. **Model not using tools?** Bump `effort` to `'high'`. Make the prompt more forceful. Check if the tool name has changed in the new SDK version.
5. **MCP tool name mismatch?** MCP tools are prefixed as `mcp__<server-name>__<tool-name>`. Use `.includes()` or regex, never exact match on the bare tool name.
6. **Control request returns unexpected shape?** The SDK wraps control_response in an envelope: `{ subtype, request_id, response: { ... } }`. Access the inner value with `result?.response?.fieldName` as fallback.
7. **Timing issues with streaming tests?** The `onMessage` callback is not awaited, but this is OK because the SDK blocks on channel.next() between turns. If issues persist, add `await new Promise(r => setTimeout(r, N))` after toggle operations.
8. **Verify the patch is in the build:**
   ```bash
   grep -c "PATCHED:patch-name" vendor/claude-cli/cli.js
   ```
   (cli.js is the extracted source; `bun-claude` embeds its patched form. Run `bun run ensure-cli` after any patch edits.) `vendor/claude-cli/version.json` `patches` lists every registry entry whose marker was found after the last `apply-all.mjs` run; a patch missing from it applied nothing.

## SDK Message Type Reference

| Type                | Subtype             | Key Fields                                                                              | When                                                                                                                      |
| ------------------- | ------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `system`            | `init`              | `slash_commands`, `mcp_servers`                                                         | Session start (once per turn in streaming mode)                                                                           |
| `assistant`         | —                   | `message.content[]`, `parent_tool_use_id`                                               | Model response                                                                                                            |
| `stream_event`      | —                   | `event.type` (content_block_start/delta/stop, message_delta/stop), `parent_tool_use_id` | Streaming delta (subagent ones only with `subagent-streaming`)                                                            |
| `user`              | —                   | `message`, `parent_tool_use_id`                                                         | Synthetic tool_result                                                                                                     |
| `bash_output`       | —                   | `tool_use_id`, `output`, `total_lines`, `total_bytes`                                   | Live Bash output (only with `bash-output-streaming`)                                                                      |
| `system`            | `task_started`      | `task_id`                                                                               | Background agent/task launched                                                                                            |
| `system`            | `task_notification` | `task_id`, `status` (completed/stopped/failed)                                          | Background agent/task ended                                                                                               |
| `command_lifecycle` | —                   | `command_uuid`, `state`                                                                 | Fate of a queued command: a user frame sent with a `uuid` (the harness's frames carry none) or one cli.js enqueued itself |
| `rate_limit_event`  | —                   | `rate_limit_info`                                                                       | API rate limit info (ignore in tests)                                                                                     |
| `result`            | `success`/`error_*` | `total_cost_usd`, `num_turns`                                                           | Turn/session completed                                                                                                    |

Full catalog: `docs/protocol-cc/03-inbound-messages.md` and `04-system-subtypes.md`.

---
name: patch-test-harness
description: Write and run behavioral tests for SDK patches. Use when creating, updating, or debugging patch test harnesses that verify cli.js patches are functioning correctly. Covers subagent-streaming, taskstop-notification, team-streaming, queue-control, mcp-status, and mcp-tool-refresh patches.
---

# Patch Test Harness

Write behavioral tests that verify SDK patches work correctly by launching real SDK sessions and asserting on the message stream.

## Test Infrastructure

All test code lives in `patch/` alongside the patch apply scripts.

### Key Files

| File | Purpose |
|---|---|
| `patch/test-helpers.mjs` | Shared utilities: `createQuery()`, `createStreamingQuery()`, `collectMessages()`, `TestRunner`, `dumpMessages()`, `MessageChannel`, `userMessage()` |
| `patch/test-all.mjs` | Sequential runner for all patch tests |
| `patch/mcp-test-server.mjs` | Minimal stdio MCP server for MCP-related tests |
| `patch/<name>/test.mjs` | Individual patch test (one per patch) |

### Running Tests

```bash
# Run all patch tests
node patch/test-all.mjs

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
t.assertSome('stream_event from sub-agent', messages,
  (m) => m.type === 'stream_event' && !!m.parent_tool_use_id
)
```

**Check system notification:**
```js
t.assertSome('task_notification with status stopped', messages,
  (m) => m.type === 'system' && m.subtype === 'task_notification' && m.status === 'stopped'
)
```

**Check teammate messages:**
```js
t.assertSome('assistant with teammate_id', messages,
  (m) => m.type === 'assistant' && !!m.teammate_id
)
```

**Check MCP server status (via control request):**
```js
const servers = await q.mcpServerStatus()
t.assert('MCP server connected', servers.some(s => s.name === 'test-server' && s.status === 'connected'))
```

**Check control request response shape** (SDK wraps in envelope):
```js
// Control requests like dequeueMessage return a control_response envelope:
//   { subtype: 'success', request_id: '...', response: { removed: 0 } }
// Extract the inner value with fallback:
const removedValue = result?.removed ?? result?.response?.removed ?? undefined
t.assert('has removed field', typeof removedValue === 'number')
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
  },
})
```

**Important:** `onMessage` is NOT awaited by `collectMessages`. This is fine because the SDK blocks on `channel.next()` between turns, so your async operations (toggle, status check) complete before the next turn starts. However, be careful not to push a new message before the async operation finishes.

**Each `channel.push(userMessage(...))` produces a new `init` → `assistant` → `result` cycle.** Expect N init messages for N turns — this is normal, not a session restart.

### 7. MCP Test Server

For tests that need an MCP server, use `patch/mcp-test-server.mjs`:

```js
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const __dirname = dirname(fileURLToPath(import.meta.url))

const { q, cleanup } = createQuery(PROMPT, {
  mcpServers: {
    'test-server': {
      command: 'node',
      args: [resolve(__dirname, '../mcp-test-server.mjs')],
    },
  },
}, 120_000)
```

The test server provides one tool: `patch_test_echo` — takes `{ text: string }` and echoes it back. The model sees it as `mcp__test-server__patch_test_echo`.

**MCP server status shape** (returned by `q.mcpServerStatus()`):
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
- Team tests: 180s (multi-agent coordination is slower)
- MCP toggle tests: 180s (multiple turns + reconnection delays)
- Background task tests: use `onMessage` callback to detect events and close early via `q.close()`

### 9. Registering New Tests

Add new tests to `patch/test-all.mjs`:
```js
const tests = [
  { name: 'my-patch', script: resolve(__dirname, 'my-patch/test.mjs') },
]
```

## Patch-Specific Test Strategies

### subagent-streaming
**Trigger:** Forceful prompt to use Agent tool (synchronous). Must use `effort: 'medium'`.
**Assert:** `stream_event` and `assistant` messages with non-null `parent_tool_use_id`. Check tool name with `b.name === 'Task' || b.name === 'Agent'` (name varies by SDK version).

### taskstop-notification
**Trigger:** Launch background Agent with `sleep 300`, detect `task_started` via `onMessage`, then call `q.stopTask(taskId)` after a 2s delay.
**Assert:** `task_notification` with `status === 'stopped'`, matching `task_id` between started and notification.

### team-streaming
**Trigger:** Prompt creates a team with one teammate via TeamCreate + Agent tools. Timeout 180s.
**Assert:** `stream_event`/`assistant` with `teammate_id` (format: `name@team`), `task_notification` with `@` in task_id.

### queue-control
**Trigger:** Streaming query → prompt asks for `sleep 8 && echo done` → on tool_use detection, push steer message via `channel.push(userMessage(...))` after 1s delay.
**Assert:** `queued_command_consumed` system notification received. `dequeueMessage()` returns envelope with `response.removed` field (number). For non-existent message, `removed === 0`.

### mcp-status
**Trigger:** Query with MCP test server configured → detect `init` → call `q.mcpServerStatus()`.
**Assert:** Non-empty array, test server present with `status: 'connected'`, has tools array with entries.

### mcp-tool-refresh
**Trigger:** Streaming query with MCP test server → 3 turns:
1. Ask model to call `patch_test_echo` (should succeed)
2. Toggle OFF → verify `mcpServerStatus()` shows `disabled` + 0 tools → ask model to list tools
3. Toggle ON → wait 2s for reconnection → verify status → ask model to call tool again (should succeed)
**Assert:** Tool used in turn 1 and turn 3, toggle states correct in `mcpServerStatus()`, session completes.

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
8. **Verify patch marker in cli.js:**
   ```bash
   bundle-analyzer find node_modules/@anthropic-ai/claude-agent-sdk/cli.js "PATCHED:patch-name" --compact
   ```

## SDK Message Type Reference

| Type | Subtype | Key Fields | When |
|---|---|---|---|
| `system` | `init` | `slash_commands`, `mcp_servers` | Session start (once per turn in streaming mode) |
| `assistant` | — | `message.content[]`, `parent_tool_use_id`, `teammate_id` | Model response |
| `stream_event` | — | `event.type` (content_block_start/delta/stop, message_delta/stop), `parent_tool_use_id`, `teammate_id` | Streaming delta |
| `user` | — | `message`, `parent_tool_use_id`, `teammate_id` | Synthetic tool_result |
| `system` | `task_started` | `task_id` | Background agent/task launched |
| `system` | `task_notification` | `task_id`, `status` (completed/stopped/failed) | Background agent/task ended |
| `system` | `queued_command_consumed` | — | Steer message was consumed by CLI |
| `rate_limit_event` | — | — | API rate limit info (ignore in tests) |
| `result` | `success`/`error_*` | `total_cost_usd`, `num_turns` | Turn/session completed |

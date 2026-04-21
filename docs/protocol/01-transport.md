# 01 — Transport

How we spawn `cli.js` and talk to it. Covers process layout, stdio pipes, newline-delimited JSON, environment variables, and startup sequencing. Everything above this layer (messages, control requests, MCP routing) rides on top of this.

See `src/main/sdk/query.ts`, `src/main/sdk/protocol.ts`, `src/main/sdk/args.ts`, `src/main/sdk/locate.ts`, and `src/main/sdk/wire-log.ts` for implementations.

---

## 1.1 Process model

```
┌─────────────────────────────────────────┐
│ ClaudeUI main process (Electron Node)   │
│                                         │
│ src/main/sdk/query.ts                   │
│   spawn(executable, [...args])          │
│   pipe:  stdin ─→ cli.js                │
│          stdout ←─ cli.js               │
│          stderr ←─ cli.js               │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│ cli.js (Node subprocess)                │
│  13MB minified CommonJS,                │
│  extracted from the upstream            │
│  claude-code Bun binary                 │
└─────────────────────────────────────────┘
```

cli.js is not an interactive binary in this mode — it is a JSON-RPC-like protocol engine. It reads newline-delimited JSON off stdin, emits newline-delimited JSON on stdout, and writes human-readable diagnostics to stderr.

### The executable

`cli.js` runs inside a rebundled Bun standalone binary — `bun-claude[.exe]` — produced by `scripts/rebundle-cli.mjs`. We spawn it directly; no Node wrapper, no argv injection of a JS path:

```
<bun-claude> <flags>...
```

Because `cli.js` is embedded in the binary and Bun's loader resolves its own baked `file:///` URLs natively, we ship no separate Node shims, no vendored ripgrep, no separate `.node` addons — they all ride along inside the Bun binary.

Rationale: **[ADR-006](../adr/adr-006_rebundle-bun-binary.md)**. The previous pipeline unwrapped `cli.js` and spawned it under Electron-as-Node (`ELECTRON_RUN_AS_NODE=1`) with a `Module._resolveFilename` shim redirecting Bun's virtual paths to our vendored locations — fragile against CI-baked absolute paths that the shim didn't cover.

### Where the binary lives on disk

| Mode | Path |
|---|---|
| Dev (`bun run dev`) | `<projectRoot>/vendor/claude-cli/bun-claude[.exe]` |
| Production (installed app) | `<Resources>/claude-cli/bun-claude[.exe]` (extraResources) |
| Production fallback | `<app.asar.unpacked>/vendor/claude-cli/bun-claude[.exe]` |

Resolved by `locateBunClaude()` in `src/main/sdk/locate.ts`. `locateCliJs()` is kept as a deprecated alias returning the same path — lingering external callers.

### How the binary gets there

`bun run ensure-cli` is the chained pipeline: `extract-cli.mjs` (download upstream Bun binary, pull wrapped `cli.js` out of its `__BUN`/`.bun` section) → `patch/apply-all.mjs` (14 content-regex patches) → `rebundle-cli.mjs` (re-inject the patched `cli.js` into the Bun binary + ad-hoc codesign + clear quarantine on macOS). Cache key: `package.json#claudeCliVersion`. Full details in `docs/sdk-layer.md`.

---

## 1.2 Stdio wiring

```ts
spawn(executable, args, {
  cwd: options.cwd,
  env: buildEnv({ ...process.env, ...(options.env ?? {}) }),
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
})
```

- `stdin`  — we write newline-delimited JSON messages here (prompts + control_request + control_response)
- `stdout` — cli.js writes newline-delimited JSON messages here (assistant/user/system/result/stream_event + control_request + control_response + control_cancel_request)
- `stderr` — human-readable diagnostics. Never JSON; always a pass-through to `options.stderr` callback.

`windowsHide: true` suppresses the console window flash on Windows.

### Spawn override

Callers may pass `options.spawnClaudeCodeProcess` to substitute a custom launcher (containerized, sandboxed, etc.). SDK-parity hook. Signature:

```ts
(opts: {
  command: string
  args: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
}) => ChildProcess
```

---

## 1.3 Wire format: newline-delimited JSON

**Every line is exactly one JSON object terminated by `\n`.** Both directions. No framing, no length prefix, no partial lines — cli.js's reader and ours both require the line to be complete when the `\n` arrives.

### Reader

`NdjsonReader` in `src/main/sdk/protocol.ts`:
- Accumulates chunks into a string buffer.
- Splits on `\n` inside the buffer. Leaves trailing partial line for the next `data` event.
- Skips empty lines (including surrounding whitespace).
- Calls `JSON.parse` on each complete line. Parse failures call `onError(err)` but do NOT terminate the stream — the next line still gets processed.
- Flushes the buffer on `end` if it contains any non-whitespace content.

### Writer

`NdjsonWriter` in `src/main/sdk/protocol.ts`:
- Writes `JSON.stringify(obj) + '\n'`.
- Silently no-ops after `stream.writable` flips false (post-close/post-error) — avoids spamming EPIPEs during teardown.

### Stability rules

- **Never** embed a literal newline inside a JSON string value if you can help it. JSON encodes `\n` as `\\n`, so this is fine with compliant encoders, but some minified readers are strict.
- **Never** write more than one JSON object per line. Splitting on `\n` counts on exactly-one-per-line.
- Each write must be complete before the next starts. `JSON.stringify + '\n'` in one `stream.write()` call does that — but beware of manual chunked writes.

---

## 1.4 Argv structure

```
<executable> <executableArgs>... <cliPath> <flags>...
```

Built by `src/main/sdk/args.ts::buildArgs()`. The prefix is always exactly:

```
--output-format stream-json --verbose --input-format stream-json
```

Everything else is optional. See `docs/protocol/02-cli-flags.md` for the complete flag reference.

**Flag order matters.** cli.js's parser is tolerant, but we mirror the upstream SDK's order exactly so future diffs against `sdk.mjs` stay clean. Never reorder without re-checking.

---

## 1.5 Environment variables

### Set by the harness at spawn time

| Var | Source | Effect |
|---|---|---|
| `CLAUDE_CODE_ENTRYPOINT=sdk-ts` | `buildEnv()` default | cli.js telemetry tag. Distinguishes our harness from the upstream SDK (`sdk-mjs`) and the interactive CLI. Doesn't affect behavior. |
| `DEBUG=1` | `buildEnv()` when `DEBUG_CLAUDE_AGENT_SDK` is set | Enables cli.js's internal debug trace. |
| `NODE_OPTIONS` | Deleted | Prevents the child from inheriting debug attach / loader flags that would confuse startup. Harmless under Bun but kept for defensive consistency. |

Historically the table also carried `ELECTRON_RUN_AS_NODE=1` (when we spawned cli.js under Electron-as-Node) and `NODE_PATH` (pointing the unwrapped cli.js at our `node_modules` for `ws`/`undici`/`ajv`/etc.). Both retired with ADR-006 — the rebundled Bun binary is self-contained. `buildEnv()` still exists and still supports the `options.env` overlay so callers can pass per-spawn env without mutating `process.env`; that machinery is useful independently of the retired vars.

### Env vars cli.js itself reads (non-exhaustive — full list in `02-cli-flags.md`)

- `DEBUG` — enables internal event trace
- `CLAUDE_CODE_SYNC_PLUGIN_INSTALL` — forces synchronous plugin installation (affects MCP refresh timing, see `patch/mcp-status`)
- `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS` — gates `system/session_state_changed` emissions
- `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` — credential sources
- `ANTHROPIC_BASE_URL`, `ANTHROPIC_SMALL_FAST_MODEL`, `ANTHROPIC_MODEL` — API endpoint / model overrides

---

## 1.6 Startup sequence

```
t=0      spawn() returns. pipes attached.
t=0      NdjsonReader attaches to child.stdout.
t=0      NdjsonWriter writes first control_request:
         { type: 'control_request', request_id: '<id>',
           request: { subtype: 'initialize', ...initPayload } }
t=0      User's first prompt (string) is written:
         { type: 'user', message: { role: 'user', content: '...' } }
         (NOT awaiting initialize response — cli.js queues it.)
t=~50ms  First stdout byte. Typically an `assistant` partial or
         `system/init` message.
t=~100ms `system/init` arrives. Exposes session_id, tools,
         mcp_servers, slash_commands, skills.
t=~300ms First `assistant` message or `stream_event` deltas.
t=~Xs    `control_response { subtype: 'success', request_id: <init> }`
         carrying models / commands / agents / skills / plugins /
         account / output_style / pid.
t=...    Normal turn progression: stream_events → assistant → tool
         invocations → user (tool_result) → repeat → result.
```

**Key ordering invariant:** we do NOT await the initialize response before sending the first user prompt. cli.js queues incoming `user` messages and processes them after initialize is handled. Blocking would add user-visible latency to every session's first turn.

**Init timeout:** 60 s. If the initialize promise hasn't resolved in that window, log to stderr and surface empty `supportedModels/Commands/Agents` rather than stall indefinitely. See `src/main/sdk/query.ts` around `control.request(initPayload, { timeoutMs: 60_000 })`.

---

## 1.7 Teardown sequence

### Graceful (preferred for normal shutdown)

1. Call `queryHandle.endSession()` — sends `control_request { subtype: 'end_session' }`.
2. cli.js flushes any pending messages, writes a final `result`, breaks its read loop.
3. cli.js exits with code 0.
4. Our `child.on('exit', ...)` handler fires, `rejectAll()` clears any remaining pending control_requests, `writer.end()` closes stdin, `queue.finish()` ends the consumer iterator.

### Hard (SIGTERM)

1. `options.abortController.abort()` — triggers `child.kill('SIGTERM')`.
2. On Windows, `SIGTERM` is emulated as `TerminateProcess` — no graceful cleanup chance.
3. Same cleanup path on our side.

### Child-teardown race

After we call `endSession()` or `SIGTERM`, our outbound writer might still be asked to emit a trailing control_response by an in-flight inbound handler. A `childClosed` flag short-circuits the writer. Any write after `end()` is silently ignored; EPIPE on race is swallowed.

---

## 1.8 Diagnostics

### `DEBUG_SDK=1` (our harness)

Emits stderr timestamps for:
- `+Xms spawn` — child process created
- `+Xms first cli.js stdout byte`
- `+Xms init system event` — first `type:'system', subtype:'init'`
- `+Xms first assistant message`
- `+Xms initialize response`
- `+Xms first user message sent (string)`

And logs every outbound `control_request` with its first 200 chars of payload, plus the matching response or error.

### `DEBUG_CLAUDE_AGENT_SDK=1` (cli.js internal)

Passes `--debug-to-stderr` + sets `DEBUG=1` in the child env. cli.js writes its internal event trace to stderr. Very verbose — use when investigating a specific hang or state corruption.

### Wire log

Every query owns a ring buffer (`WireLog` in `src/main/sdk/wire-log.ts`) capturing every ndjson line with sequence, timestamp (ms since query start), direction, and parsed object.

```ts
const q = query({...})
// ...later:
const entries = q.wireLog()  // WireEntry[]
// dump to disk for analysis:
fs.writeFileSync('debug.jsonl',
  entries.map(e => JSON.stringify(e)).join('\n'))
```

Default capacity 1000 entries. Override with `options.wireLogCapacity` — bump only when a specific debug dump needs more history (stream_event deltas dominate the line rate at ~100/turn).

---

## 1.9 Signals

| Signal | Handler | Effect |
|---|---|---|
| `SIGTERM` | cli.js's default Node handler | Terminate, no cleanup. Our `child.on('exit', ...)` fires with `signal='SIGTERM'`. |
| `SIGINT` | cli.js traps (REPL-mode); in stream-json mode the default handler | Normally we never send this. |
| `child.kill()` w/o args | sends SIGTERM | Same as above. |

Windows has no UNIX signals. `child.kill('SIGTERM')` maps to `TerminateProcess`. Use `endSession()` for a graceful path.

---

## 1.10 Backpressure

`NdjsonWriter.write()` pushes to the pipe synchronously — Node's stream buffer absorbs writes until the kernel pipe is full. Under normal loads (a few KB/turn) this never matters.

Under pathological loads (very large tool inputs or huge streaming JSON), the pipe can block the write. There is no flow control in the protocol. If cli.js is slow to drain, our `stream.write()` returns `false` but we don't observe that. This has not been a problem in practice — the upstream SDK has the same design.

---

## 1.11 Quick reference — creating a query

```ts
import { query } from 'src/main/sdk'

const handle = query({
  prompt: 'hello',
  options: {
    cwd: '/path/to/repo',
    model: 'claude-opus-4-7-1m',
    // The defaults already resolve `bun-claude[.exe]` via locateBunClaude()
    // and set standaloneExecutable: true, so no executable/env overrides
    // needed for the normal path. Override only for tests or alt runtimes.
    canUseTool: async (name, input, ctx) => {
      return { behavior: 'allow', updatedInput: input }
    },
    abortController: new AbortController(),
  },
})

// Consume messages:
for await (const msg of handle) {
  // msg: SDKMessage (see 03-inbound-messages.md)
}

// Control plane:
await handle.interrupt()
await handle.setPermissionMode('plan')
const status = await handle.mcpServerStatus()
```

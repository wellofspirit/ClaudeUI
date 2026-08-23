# 01 — Transport

How we spawn `cli.js` and talk to it. Covers process layout, stdio pipes, newline-delimited JSON, environment variables, and startup sequencing. Everything above this layer (messages, control requests, MCP routing) rides on top of this.

See `src/core/sdk/query.ts`, `src/core/sdk/protocol.ts`, `src/core/sdk/args.ts`, `src/core/sdk/locate.ts`, and `src/core/sdk/wire-log.ts` for implementations.

---

## 1.1 Process model

```
┌─────────────────────────────────────────┐
│ ClaudeUI main process (Electron Node)   │
│                                         │
│ src/core/sdk/query.ts                   │
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

| Mode                       | Path                                                       |
| -------------------------- | ---------------------------------------------------------- |
| Dev (`bun run dev`)        | `<projectRoot>/vendor/claude-cli/bun-claude[.exe]`         |
| Production (installed app) | `<Resources>/claude-cli/bun-claude[.exe]` (extraResources) |
| Production fallback        | `<app.asar.unpacked>/vendor/claude-cli/bun-claude[.exe]`   |

Resolved by `locateBunClaude()` in `src/core/sdk/locate.ts`. `locateCliJs()` is kept as a deprecated alias returning the same path — lingering external callers.

### How the binary gets there

`bun run ensure-cli` is the chained pipeline: `extract-cli.mjs` (download upstream Bun binary, pull wrapped `cli.js` out of its `__BUN`/`.bun` section) → `patch/apply-all.mjs` (14 content-regex patches) → `rebundle-cli.mjs` (re-inject the patched `cli.js` into the Bun binary + ad-hoc codesign + clear quarantine on macOS). Cache key: `package.json#claudeCliVersion`. Full details in §1.12 below.

---

## 1.2 Stdio wiring

```ts
spawn(executable, args, {
  cwd: options.cwd,
  env: buildEnv({ ...process.env, ...(options.env ?? {}) }),
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true
})
```

- `stdin` — we write newline-delimited JSON messages here (prompts + control_request + control_response)
- `stdout` — cli.js writes newline-delimited JSON messages here (assistant/user/system/result/stream_event + control_request + control_response + control_cancel_request)
- `stderr` — human-readable diagnostics. Never JSON; always a pass-through to `options.stderr` callback.

`windowsHide: true` suppresses the console window flash on Windows.

### Spawn override

Callers may pass `options.spawnClaudeCodeProcess` to substitute a custom launcher (containerized, sandboxed, etc.). SDK-parity hook. Signature:

```ts
;(opts: {
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

`NdjsonReader` in `src/core/sdk/protocol.ts`:

- Accumulates chunks into a string buffer.
- Splits on `\n` inside the buffer. Leaves trailing partial line for the next `data` event.
- Skips empty lines (including surrounding whitespace).
- Calls `JSON.parse` on each complete line. Parse failures call `onError(err)` but do NOT terminate the stream — the next line still gets processed.
- Flushes the buffer on `end` if it contains any non-whitespace content.

### Writer

`NdjsonWriter` in `src/core/sdk/protocol.ts`:

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

Built by `src/core/sdk/args.ts::buildArgs()`. The prefix is always exactly:

```
--output-format stream-json --verbose --input-format stream-json
```

Everything else is optional. See `docs/protocol-cc/02-cli-flags.md` for the complete flag reference.

**Flag order matters.** cli.js's parser is tolerant, but we mirror the upstream SDK's order exactly so future diffs against `sdk.mjs` stay clean. Never reorder without re-checking.

---

## 1.5 Environment variables

### Set by the harness at spawn time

| Var                             | Source                                            | Effect                                                                                                                                            |
| ------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLAUDE_CODE_ENTRYPOINT=sdk-ts` | `buildEnv()` default                              | cli.js telemetry tag. Distinguishes our harness from the upstream SDK (`sdk-mjs`) and the interactive CLI. Doesn't affect behavior.               |
| `DEBUG=1`                       | `buildEnv()` when `DEBUG_CLAUDE_AGENT_SDK` is set | Enables cli.js's internal debug trace.                                                                                                            |
| `NODE_OPTIONS`                  | Deleted                                           | Prevents the child from inheriting debug attach / loader flags that would confuse startup. Harmless under Bun but kept for defensive consistency. |

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

**Init timeout:** 60 s. If the initialize promise hasn't resolved in that window, log to stderr and surface empty `supportedModels/Commands/Agents` rather than stall indefinitely. See `src/core/sdk/query.ts` around `control.request(initPayload, { timeoutMs: 60_000 })`.

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

Every query owns a ring buffer (`WireLog` in `src/core/sdk/wire-log.ts`) capturing every ndjson line with sequence, timestamp (ms since query start), direction, and parsed object.

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

| Signal                  | Handler                                                           | Effect                                                                            |
| ----------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `SIGTERM`               | cli.js's default Node handler                                     | Terminate, no cleanup. Our `child.on('exit', ...)` fires with `signal='SIGTERM'`. |
| `SIGINT`                | cli.js traps (REPL-mode); in stream-json mode the default handler | Normally we never send this.                                                      |
| `child.kill()` w/o args | sends SIGTERM                                                     | Same as above.                                                                    |

Windows has no UNIX signals. `child.kill('SIGTERM')` maps to `TerminateProcess`. Use `endSession()` for a graceful path.

---

## 1.10 Backpressure

`NdjsonWriter.write()` pushes to the pipe synchronously — Node's stream buffer absorbs writes until the kernel pipe is full. Under normal loads (a few KB/turn) this never matters.

Under pathological loads (very large tool inputs or huge streaming JSON), the pipe can block the write. There is no flow control in the protocol. If cli.js is slow to drain, our `stream.write()` returns `false` but we don't observe that. This has not been a problem in practice — the upstream SDK has the same design.

---

## 1.11 Quick reference — creating a query

```ts
import { query } from 'src/core/sdk'

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
    abortController: new AbortController()
  }
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

---

## 1.12 Build pipeline: extract → patch → rebundle

How `bun-claude[.exe]` gets produced. Architectural rationale: **[ADR-006](../adr/adr-006_rebundle-bun-binary.md)**.

```
downloads.claude.ai/claude-code-releases/<ver>/<plat>/claude[.exe]   (upstream Bun binary)
          │
          ▼
scripts/extract-cli.mjs                  (pull wrapped cli.js from the Bun payload)
          │
          ▼
vendor/claude-cli/cli.js                 (Bun CJS IIFE bytes, for patching + analysis)
          │
          ▼
patch/apply-all.mjs                      (14 content-regex patches, idempotent)
          │
          ▼
scripts/rebundle-cli.mjs                 (re-inject patched cli.js into a fresh copy
                                          of the Bun binary; auto-codesign on macOS)
          │
          ▼
vendor/claude-cli/bun-claude[.exe]       (shipped artifact — spawned natively)
```

### Directory layout

| Path                                 | Role                                                                                                                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vendor/claude-cli/bun-claude[.exe]` | Rebundled Bun binary — what ClaudeUI actually spawns. Never checked in; regenerated by `bun run ensure-cli`.                                                            |
| `vendor/claude-cli/cli.js`           | Wrapped Bun CJS IIFE bytes, post-patch. Kept on disk for debugging, grepping, and `/bundle-analyzer`. Not shipped — already baked into `bun-claude`.                    |
| `vendor/claude-cli/version.json`     | Upstream version + extraction metadata + path to the cached source binary (`sourceBinary` field feeds the rebundler in pipeline mode).                                  |
| `scripts/extract-cli.mjs`            | Downloads the per-platform Bun binary (SHA-verified against the manifest; cached under `.cache/claude-cli/` keyed on version), pulls `cli.js` out of its Bun section.   |
| `scripts/rebundle-cli.mjs`           | Re-injects the patched `cli.js` into the Bun binary. PE writer shrinks the section + strips the Authenticode cert; Mach-O writer pads to original section size + codesigns. |
| `patch/`                             | 14 content-regex patches against the wrapped `cli.js`. Idempotent; safe to re-run. Per-patch READMEs carry the bundle-analyzer anchors.                                 |

### Bun standalone serialization (reverse-engineered from Bun's `src/StandaloneModuleGraph.zig`)

The serialized module graph lives inside a container section (`.bun` on PE, `__BUN,__bun` on Mach-O, `.bun` section or EOF overlay on ELF) as:

```
[u64 blobLen (LE)] [blob] [padding to container alignment]

blob = [data buffer] [Offsets: 32 bytes] [Magic: 16 bytes "\n---- Bun! ----\n"]

Offsets (LE):
  byte_count         : u64         // size of data buffer (excludes Offsets + Magic)
  modules_ptr.off    : u32         // offset into data buffer where modules table starts
  modules_ptr.len    : u32         // modules table byte length (entries × 52)
  entry_point_id     : u32         // index of the entry module
  argv_ptr.off       : u32         // baked compile-exec-argv offset
  argv_ptr.len       : u32
  flags              : u32

Module table entries (52 bytes each, back-to-back):
  name                       : StringPointer (u32 off, u32 len)
  contents                   : StringPointer
  sourcemap                  : StringPointer
  bytecode                   : StringPointer        // JSC bytecode (optional)
  module_info                : StringPointer
  bytecode_origin_path       : StringPointer
  encoding                   : u8                   // 0=binary, 1=latin1
  loader                     : u8                   // 1=js, 10=napi, ...
  module_format              : u8
  side                       : u8                   // 0=server, 1=client
```

StringPointer offsets are **relative to the data buffer start** (`data_start = magic_offset - 32 - byte_count`). Each string is written with a trailing `\0` in the buffer (length excludes the terminator). No integrity checks — no hashes, no compression, no signatures over the graph. The only alignment rule: when `bytecode.len > 0`, `bytecode.off % 128 == 120` or JSC segfaults on load.

### Per-platform container wrappers

| Platform            | Container             | Wrapper                                                                                                                 |
| ------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Windows (PE)        | `.bun` section        | 8-byte LE blob size, then blob, then padding to FileAlignment. Authenticode cert table appended after the last section. |
| macOS (Mach-O)      | `__BUN,__bun` section | 8-byte LE blob size, then blob. `__LINKEDIT` + `LC_CODE_SIGNATURE` data follow the `__BUN` segment.                     |
| Linux (ELF, new)    | `.bun` section        | 8-byte LE blob size, then blob.                                                                                         |
| Linux (ELF, legacy) | File overlay at EOF   | Blob, then 8-byte LE total-byte-count (distinct from the `byte_count` in Offsets).                                      |

### Extraction

`scripts/extract-cli.mjs` downloads the per-platform binary (SHA-verified against `downloads.claude.ai/claude-code-releases/<ver>/manifest.json`), locates the `__BUN`/`.bun` section, walks the module table, and writes the module whose name ends with `/cli.js` **verbatim** to `vendor/claude-cli/cli.js`. The wrapped CJS IIFE form is preserved (`// @bun @bytecode @bun-cjs\n(function(exports, require, module, __filename, __dirname) {...})`) — no unwrapping, no shim injection. That matters because the rebundler later re-inserts the same bytes into a fresh Bun binary. No ripgrep download, no `.node` addon extraction — those stay inside the Bun binary and get re-injected intact.

`version.json` records `{ version, source, sourceBinary, extractedAt, cliSize, cliSha256, form: "wrapped" }`.

### Caching

The **source binary** is cached under `.cache/claude-cli/claude-<version>-<platform>[.exe]` and reused when its SHA256 matches the manifest. `extract-cli.mjs --force` ignores the cache and re-downloads. CI workflows (`pre-release.yml`, `release.yml`) persist this directory across runs keyed on `package.json#claudeCliVersion`.

**No `vendor/` cache shortcut.** `ensure-cli` always runs the full extract → patch → rebundle chain. Patches often change while `claudeCliVersion` stays pinned, and patch application is idempotent, so caching intermediate artifacts buys nothing and invites staleness bugs (e.g. the version.json `sourceBinary` absolute path breaking after cache restore). Warm pipeline runs in ~4 s (`rebundle-cli.mjs` alone ~270 ms); cold adds the ~60 s binary download.

### Rebundling

`scripts/rebundle-cli.mjs` mirrors the extractor on the writer side:

1. Parse the container to locate the Bun section (PE `.bun` or Mach-O `__BUN,__bun`).
2. Read the existing `[u64 blobLen][blob]`, parse the module graph into an editable structure.
3. Find the `cli.js` entry by name suffix (`/cli.js`), replace its `contents` bytes with the patched wrapped-form `vendor/claude-cli/cli.js`. A guardrail rejects anything not starting with `// @bun` — catches accidental unwrapped-form regressions.
4. Lay out a fresh blob:
   - Emit each module's six strings (name, contents, sourcemap, bytecode, module_info, bytecode_origin_path) back-to-back, each with a `\0` terminator.
   - **Drop bytecode**: set every module's bytecode `StringPointer` to `{off: 0, len: 0}`. Bun recompiles from source on first run (+~160 ms cold-start, saves ~100 MB of JSC bytecode in the blob). Also sidesteps the `offset % 128 == 120` alignment rule.
   - Emit the argv blob (usually empty) with terminator, the modules table (52 bytes per entry, same order, new StringPointers), the 32-byte Offsets struct (`byte_count` = current blob length, excluding Offsets + Magic), and the 16-byte magic.
5. Write the container:
   - **PE**: shrink the `.bun` section to fit the new blob, update the section header's `VirtualSize`/`SizeOfRawData`, zero the `IMAGE_DATA_DIRECTORY[Security]` to strip the now-invalid Authenticode cert reference, zero the optional-header checksum, update `SizeOfImage`. 235 MB → 137 MB.
   - **Mach-O**: overwrite the `__BUN` section contents with `[new blob][zero padding]`, keeping section size unchanged. `__LINKEDIT` and the code-signature blob stay at their original file offsets. Output size = input size.
6. Post-write (macOS only): `codesign --force --sign - <output>` (ad-hoc signature — required for Apple Silicon execution) and `xattr -c <output>` (clear quarantine). Cross-compiling Mac binaries from non-Mac hosts skips this with a warning.

Pipeline mode (`node scripts/rebundle-cli.mjs` with no args): reads `sourceBinary` from `vendor/claude-cli/version.json`, reads the patched `cli.js` from the same directory, writes `bun-claude[.exe]` alongside. NO-OP mode (`--noop`) reuses the original `cli.js` contents — used to validate reader/writer symmetry when debugging the rebundler.

Module inventory (confirmed at 2.1.114): Windows PE x64 carries 5 modules (cli.js, image-processor.js/.node, audio-capture.js/.node); macOS arm64 carries 11 (adds url-handler, computer-use-swift, computer-use-input). All modules except `cli.js` round-trip verbatim.

**If the rebundler fails on a new Bun version**, check Bun's `src/StandaloneModuleGraph.zig` for format changes. The 52-byte module struct and 32-byte Offsets struct have been stable across recent Bun releases but have changed historically (pre-1.3.7 modules were 36 bytes).

### Patch registry

14 content-regex patches under `patch/` (registry: `patch/apply-all.mjs`), applied between the extract and rebundle steps. Three auto-detect upstream fixes and no-op on recent cli.js versions (`taskstop-notification`, `incomplete-session-resume-fix`, `mcp-tool-refresh`). The active 11:

| Patch                    | What it adds to cli.js                                                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `subagent-streaming`     | Forwards subagent stream_events + messages that would otherwise be swallowed by internal aggregation                                                                                                        |
| `queue-control`          | `dequeue_message` control subtype + `queued_command_consumed` notification                                                                                                                                  |
| `mcp-status`             | Awaits MCP refresh before responding so `mcpServerStatus()` returns the full list                                                                                                                           |
| `background-task`        | `background_task` control subtype — convert foreground task to background                                                                                                                                   |
| `usage-relay`            | `get_usage` control subtype — exposes cli.js's internal /usage API                                                                                                                                          |
| `request-usage`          | Emits per-request token usage events after each API call                                                                                                                                                    |
| `rate-limit-relay`       | Emits rate limit headers after each API call                                                                                                                                                                |
| `voice-server`           | Adds internal TCP voice-transcription server, control subtypes `voice_server_start`/`stop`                                                                                                                  |
| `bash-output-streaming`  | Pushes Bash output to stream_event immediately instead of buffering 2s                                                                                                                                      |
| `subprocess-proxy-strip` | Strips `HTTP(S)_PROXY` / `ALL_PROXY` / `NO_PROXY` from env handed to bash/MCP/LSP/etc. subprocesses so cli.js's own proxy doesn't leak into shell tools (gated off via `CLAUDEUI_PROXY_SUBPROCESSES=1`)     |
| `skip-securestorage`     | When `SKIP_SECURESTORAGE` is set, forces the credential store to the plaintext file backend (bypassing macOS Keychain) so per-account `.credentials.json` files can be managed/swapped. Enables multi-account (ADR-015) |

Retired: `ci-path-remap` (obsolete once cli.js runs inside its native Bun runtime — ADR-006), `sandbox-network-fix` (upstream's "no allowed domains = no network" semantics kept deliberately), `team-streaming` (dir removed).

Patches operate on the wrapped Bun CJS IIFE bytes at `vendor/claude-cli/cli.js`; every anchor targets content inside the IIFE body. When the minifier changes variable names between versions, a patch fails with "cannot locate anchor" — update that patch's regex using its README's bundle-analyzer anchors.

`apply.mjs` conventions:

1. Read `vendor/claude-cli/cli.js`, check for `/*PATCHED:<name>*/` marker (idempotency).
2. Find code by **content patterns/string literals** — never char offsets or minified names.
3. Extract minified variable names dynamically from regex captures.
4. Use `const V = '[\\w$]+'` for matching minified identifiers.
5. Verify pattern matches exactly once, apply replacement with marker, write back.

Register new patches in the `patches` array in `patch/apply-all.mjs`. Skills for patch work: `/bundle-analyzer` (locate targets in minified cli.js), `/patch-readme` (per-patch README with anchors), `/patch-test-harness` (behavioral tests).

---

## 1.13 Harness module map (`src/core/sdk/`)

| File                | Responsibility                                                                                                                                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`          | Public exports: `query`, `tool`, `createSdkMcpServer`, `locateBunClaude`, `locateCliJs` (deprecated alias), `getCliVersion`, + types.                                                                                        |
| `types.ts`          | `QueryOptions`, `QueryHandle`, `SDKMessage`, `McpServerConfig`, `PermissionUpdate`, `HooksConfig`, etc. `QueryOptions.standaloneExecutable` defaults to `true` — skips `cliPath` argv injection for self-contained binaries. |
| `locate.ts`         | Resolves `bun-claude[.exe]` path in dev (`vendor/claude-cli/`) and prod (`<Resources>/claude-cli/`).                                                                                                                         |
| `args.ts`           | Builds argv. Exact port of sdk.mjs arg-builder (flag order + syntax). `buildEnv()` merges `options.env` overlay onto `process.env`.                                                                                          |
| `protocol.ts`       | `NdjsonReader` / `NdjsonWriter` — newline-delimited JSON over stdio.                                                                                                                                                         |
| `control.ts`        | `ControlChannel` — outbound control_request + response correlation, inbound AbortController registry for cancellation, `onPendingPermissionRequests` hook.                                                                   |
| `mcp-host.ts`       | In-process MCP hosting. Real `McpServer` from `@modelcontextprotocol/sdk` connected via a custom `PairedTransport` that bridges cli.js JSON-RPC ↔ our server.                                                                |
| `create-sdk-mcp.ts` | `createSdkMcpServer()` + `tool()` helpers. Zod-raw-shape passes directly through to `McpServer.registerTool()`.                                                                                                              |
| `query.ts`          | Orchestration: spawn child, wire reader/writer, initialize control_request, inbound dispatch, expose QueryHandle.                                                                                                            |
| `wire-log.ts`       | Per-query ring buffer of every ndjson line (§1.8). Snapshot via `queryHandle.wireLog()`.                                                                                                                                     |

`SDKMessage` is a discriminated union over `type`; each variant carries an index signature (`[k: string]: unknown`) so unknown upstream fields stay forward-compatible. `UnknownSDKMessage` is exported but NOT part of `SDKMessage` — it's for raw stream-json parsing (wire log, tests) where unknown types may appear.

Two SDK features are intentionally not ported from `sdk.mjs`: `transcriptMirror` (transcript replication batcher — nothing uses it) and `isSingleUserTurn` accounting (fine-grained turn accounting — our `interrupt()` is whole-query).

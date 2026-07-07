# Phase 5a — opencode infra/protocol (server + v1 client + smoke)

> First of the 3-way Phase 5 split (5a infra → 5b chat MVP → 5c auth/MCP). Implements the transport
> layer of [ADR-019](../adr/adr-019_opencode-engine-backend.md): vendor the binary, manage a shared
> `opencode serve`, and build the typed v1 HTTP+SSE client + a pinned-`/doc` smoke. **No engine
> registration, session, or UI yet — that's 5b.** Claude is untouched.

## Verified facts (I de-risked opencode 1.17.9 on Windows — build on these, don't re-discover)

- npm publishes per-platform binaries: `opencode-<os>-<arch>` (e.g. `opencode-windows-x64`,
  `opencode-darwin-arm64`, `opencode-linux-x64`) at the same version as `opencode-ai`. **Pin 1.17.9.**
- `opencode serve --port <p> --hostname 127.0.0.1` starts and prints to **stdout**:
  `opencode server listening on http://127.0.0.1:<port>` (parse the port from this line; `--port 0`
  → OS-assigned). Also warns `OPENCODE_SERVER_PASSWORD is not set; server is unsecured` when unset.
- `GET /doc` → OpenAPI 3.1 (`info.version` is the API version `1.0.0`, NOT the binary version).
- `GET /config/providers` → `{ providers: [{ id, name, source, env, models: { <id>: { id, providerID,
  name, capabilities: { reasoning, attachment, toolcall, input:{text,image,...}, output, ... } } } }] }`.
- `GET /event` → SSE: lines `data: {"id","type","properties"}` (first event `type:"server.connected"`).
  The session events (`message.part.updated`, `session.idle`, `permission.asked`) arrive here during a run.
- The downloaded probe binary is at `.cache/opencode-probe/package/bin/opencode.exe` (reuse for dev/smoke).

## Scope (5a only)

1. **`ensure-opencode`** (`scripts/ensure-opencode.mjs`) — mirror the `ensure-cli`/old-`ensure-codex`
   vendoring: download the platform binary (`npm pack opencode-<os>-<arch>@<opencodeCliVersion>` →
   extract `package/bin/opencode[.exe]`) into **`vendor/opencode-cli/opencode[.exe]`** + a `version.json`.
   Cache-hit skip on matching version; `--force` for `update-opencode`. Add `"opencodeCliVersion":
   "1.17.9"` to package.json; wire `ensure-opencode` into `postinstall` + `build` + every `build:*`
   (alongside `ensure-cli`). `.gitignore` `/vendor/opencode-cli/`. electron-builder `extraResources`:
   ship `vendor/opencode-cli/opencode*` + `version.json` (mirror the claude-cli entry).
2. **`OpencodeServerManager`** (`src/main/opencode/OpencodeServerManager.ts`) — a **shared, ref-counted
   `opencode serve` per cwd** (`Map<normalizedCwd, ServerHandle>`). `acquire(cwd)`: if a healthy server
   exists, ref++ and return its `{ baseUrl, password }`; else spawn `opencode serve --port 0 --hostname
   127.0.0.1` (`child_process.spawn`, `cwd`, env incl. a generated `OPENCODE_SERVER_PASSWORD`), parse
   the port from stdout, ref=1. `release(cwd)`: ref--; at 0, kill the process (+ tidy). Locate the
   binary via a `vendor/opencode-cli/` resolver (dev + packaged `resources/opencode-cli/`), mirroring
   the claude-cli locate pattern. Handle spawn failure / non-start with a clear error.
   - **Security:** set `OPENCODE_SERVER_PASSWORD` to a random secret and have the client send it
     (determine the header from `/doc` — likely `Authorization`). If the auth-header mechanism is
     unclear, fall back to **127.0.0.1-only binding** (acceptable for a desktop app) and document it.
3. **`OpencodeClient`** (`src/main/opencode/OpencodeClient.ts`) — typed v1 HTTP+SSE client over a
   `baseUrl` (+ password). Implement the endpoints 5b/5c will need (HTTP via `undici`/global `fetch`):
   `getConfigProviders()`, `getProviderAuth()`, `setAuth(providerId, body)` (PUT /auth/{id}); session
   ops as typed stubs/methods per `/doc` (create/prompt/abort/fork/delete — wire shapes from the
   snapshot; 5b drives them). **SSE consumer** for `GET /event`: a robust line-parser yielding
   `{ id, type, properties }` events (handle chunked `data:` frames, reconnection optional). Types
   derived from the `/doc` snapshot — keep them in a `src/main/opencode/protocol/` module.
4. **Pinned `/doc` snapshot + smoke test** — capture `/doc` at 1.17.9 into a committed snapshot
   (`src/main/opencode/protocol/doc-snapshot.1.17.14.json` or a trimmed shape file). A **gated smoke
   test** (mirror the `integration` project — needs the binary) starts `serve`, asserts the live
   endpoints + the event-type strings (`server.connected`, and the documented `message.part.updated`/
   `session.idle`/`permission.asked` in `/doc`) match the snapshot. Guards the wire contract on bumps
   (ADR-019). Keep it OUT of the default `test`/`test:ci` (binary-dependent).

## Out of scope (later sub-phases)
`OpencodeSession`/ISession, event→ContentBlock mapping, engine/vendor registration, the model picker,
tool→kind map (all 5b); `OpencodeAuthProvider` beyond the raw `setAuth`/`getProviderAuth` client
methods, hosted-MCP injection (5c). Do NOT register `'opencode'` in `engineRegistry`/`engineAuthRegistry`
yet — 5a adds no user-visible behavior.

## Testing
- **Default suite (unit, mocked):** `OpencodeServerManager` ref-counting + port-parsing (feed fake
  stdout); `OpencodeClient` HTTP calls (mock `fetch`) + the SSE line-parser (feed chunked `data:`
  frames → assert parsed events). No binary, no network — must pass in `test`/`test:ci`.
- **Gated smoke (real binary):** the `/doc` + event-string contract test, in the `integration` project.

## Verify
```
bun run typecheck && bun run test && bun run test:ci && bun run lint && bun run build
```
- `test`/`test:ci` green with the mocked unit tests (no binary needed).
- `bun run ensure-opencode` downloads + vendors the binary (cache-hit skip on re-run); confirm
  `vendor/opencode-cli/opencode.exe` + `version.json` appear.
- Run the gated smoke manually (`vitest --project integration` or the documented command) and report
  it passing against the real binary.
- No verifier-electron app smoke needed (5a is headless infra; no UI/engine change). Claude unaffected.

## Gotchas
- **Big binary (~165 MB).** gitignored + vendored + `extraResources`; ensure-opencode cache-hit skips
  re-download. Don't commit the binary.
- **Port parsing** must be robust (the exact stdout line above); time out if `serve` never prints it.
- **Ref-counting per cwd** is the lifecycle contract 5b relies on — get acquire/release/teardown right
  (no leaked servers, no premature kill while a session is attached).
- **Don't touch Claude** — no `engineRegistry` change, no shared-code coupling; everything lives under
  `src/main/opencode/`.
- **better-sqlite3 ABI** — don't `bun install` (reverts it); if package.json deps change for undici,
  prefer the already-present `undici`/global fetch.

## Commit
Branch off `v2-phase-4-auth-providers`; no AI attribution. Suggested:
`feat(v2): opencode server manager + v1 HTTP/SSE client + ensure-opencode (Phase 5a)`.

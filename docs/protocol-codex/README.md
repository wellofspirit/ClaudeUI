# Codex transport protocol

This is the transport reference. Codex is registered as the fourth engine and
runs under the shared permission model (ADR-067); the phase-1 release gates in
the [integration spec](../codex-integration-spec.md) are still open.
The pin is `package.json#codexCliVersion`, currently `0.154.0`. No Codex command
is hooked into postinstall, ordinary builds or release packaging yet.

## Acquisition

```sh
bun run ensure-codex
bun run update-codex
```

The second command forces reinstall of the same reviewed pin, not an upgrade to
latest. `scripts/codex-digests.json` pins the release archives, extracted binaries,
source commit and Apache-2.0 license. Only macOS arm64 is supported. Linux musl
and Windows release names/digests alone do not establish provisioning readiness.
Windows archives and ancillary executables have not been inspected in M1a;
single-executable Windows packaging is deliberately not claimed.

The release ships two assets that must be installed together:
`codex-aarch64-apple-darwin.tar.gz` and
`codex-code-mode-host-aarch64-apple-darwin.tar.gz`. Real catalog models are
`tool_mode: code_mode_only` and run every tool through the separate
`codex-code-mode-host` executable, which Codex resolves from the directory of its
own binary (`install-context::code_mode_host_program_from_exe`; the `code_mode_host`
feature is Stable and default-enabled). Without it each `exec_command` fails with
"the command tool failed to start" and no approval ever reaches ClaudeUI, so the
host is mandatory, not optional: the whole manifest is acquired and published by a
single directory rename, a missing or wrong-digest host is a cache miss, and
`codexBinaryAvailable()` reports Codex unavailable unless the host sits beside
`codex`. Only `codex` answers `--version`; the host is gated by its pinned digest.
The mock-model fixture is not code-mode, so it does not exercise this path.

Existing archives can avoid the downloads, matched to their manifest member by
digest rather than flag order; `--archive` may be repeated. Supplying the pinned
license also avoids its network fetch. Every file still undergoes digest
verification.

```sh
bun run ensure-codex \
  --archive /path/to/codex-aarch64-apple-darwin.tar.gz \
  --archive /path/to/codex-code-mode-host-aarch64-apple-darwin.tar.gz \
  --license /path/to/LICENSE
```

Acquisition bounds downloads and decompression, accepts exactly the expected
regular tar member from each archive, and rejects links, traversal, extra members,
truncation and digest mismatch. Cache hits rehash actual payload/license bytes. Installation
stages complete files before directory rename and restores the prior directory
if replacement fails. If restoring the prior directory also fails, its backup
is retained under the staging directory and the command reports the exact
recovery location without raw OS error details. During replacement an existing
install has a short
unavailable-path interval; callers should not provision concurrently with runtime
startup. Acquisition is developer opt-in, not a concurrent runtime updater.

## Regeneration

```sh
bun run generate-codex-protocol
bun run check-codex-protocol
```

Both commands verify the installed cache and executable version, then run in
fresh HOME/CODEX_HOME directories with a minimal, replacement environment. They
do not inspect native user auth. The generator runs no app-server session or
model request. Temporary generator outputs are removed afterward.

`generate-ts --experimental` supplies the exact initialize and selected M1b
account/model/config/thread/turn/approval/notification types and reachable import files. The CLI does not
emit the JSON-RPC envelopes as TypeScript. `generate-json-schema --experimental`
supplies `JSONRPCMessage` and its definitions; a deliberately limited converter
emits `envelopes.ts` and fails on unsupported schema constructs. No new dependency
or general schema generator is introduced. `provenance.json` records both
commands, source/binary/schema hashes, roots and output hashes, without timestamps.
Generated files are excluded from Prettier to preserve exact upstream output.

The small authored selections in `scripts/generate-codex-protocol.mjs` generate
`protocol/methods.ts`, importing exact generated params/results rather than
copying payload shapes. Generation verifies method/params pairs against the
pinned client-request, server-request and notification schemas and records their
hashes. It copies only the selected dependency closure, not entire unused RPC
unions. The M1b closure contains 252 TypeScript files; `provenance.json` is the
exact file/hash inventory. `CodexClient.request(method, params)` infers the result
from this map. The underlying `CodexAppServerClient.request<T>` remains generic
for transport internals and probes. These are compile-time contracts, not full
runtime payload validators. Native generated `bigint` annotations are preserved
exactly; JSON decoding still produces numbers. Consumers must not assume runtime
BigInts or lossless integers outside JavaScript's safe range. Initialize's `userAgent`
is not treated as a schema version; runtime runs the pinned `--version` check
before handshake. Check mode detects missing, extra or changed generated files,
returns nonzero on mismatch, and never changes checked-in outputs.

## Verification

```sh
bun run test:unit src/core/codex
CODEX_INTEGRATION=1 bun run test:integration src/integration/codex
bun run typecheck
bunx eslint scripts/ensure-codex.mjs scripts/generate-codex-protocol.mjs src/core/codex src/integration/codex
```

The real-binary test is gated and macOS arm64 only. It uses the production client,
copies the installed verified binary into a disposable directory and wraps test
spawns with `sandbox-exec`. The outer profile blocks user-data reads and outbound
network except the fixture's localhost port. HOME/CODEX_HOME are isolated, auth
storage is file-based, and discovery/telemetry/update features are disabled. No
login, refresh, real credentials or model service are used. The test asserts a
dynamic result reaches the mock provider, owning-turn interrupt aborts its
handler, disposal rejects an outstanding RPC, and process groups are gone after
the bounded cleanup interval. It writes no raw wire/stderr traces.

The later session adapter must abort the owning thread/turn's callbacks on
terminal events, not wait for native `serverRequest/resolved` and not cancel
independent children on parent completion. AbortSignal only communicates
cancellation; handlers must stop their actual local/dispatched work. Process
group cleanup does not capture escaped groups or PTY descendants. Platform
cleanup, native auth/concurrent refresh, product method routing, registration and
packaging remain M1/M2/M5 gates. The main reviewer owns independent gates and
acceptance; these local tests do not certify release readiness.

On process exit, the client immediately aborts incoming handlers and stops new
requests, callbacks and queued writes. It allows trailing stdout responses and
notifications until end/close, with a fixed one-second drain deadline for
inherited pipes. Remaining RPCs reject with the original process-exit reason;
ordinary request timers cannot replace that reason while draining. Explicit
disposal, errors and closure outside that drain remain immediate. Group TERM/KILL
cleanup follows the drain and retains its separate kill grace. Windows unit
coverage simulates ordering only; it is not Windows provisioning/runtime evidence.

## M1b service and ownership

`CodexService` is host-only and separate from any root `CodexClient`.
Overlapping reads share one service process and handshake; duplicate pending
account/catalog reads coalesce. The final reader disposes that process, so the
next operation reloads native state. History only calls `thread/read` and
`thread/list`; it never starts, resumes or forks threads. A later root adapter
must own its separate client and take its durable ID from the generated
`thread/start`, `thread/resume` or `thread/fork` response's `thread.id`. Service
read results do not transfer ownership. No EngineId registration was added.

Public host contracts:

- `accountStatus()` returns availability, authenticated/authKind/requiresLogin metadata only. It always sends `refreshToken: false` and omits email/account payloads.
- `models()` follows native cursors with repeat/page guards, preserving native effort metadata, including `ultra`. `modelOptions(explicit)` preserves an undiscovered explicit model, and never invents a default alias for empty discovery. Discovery failures remain errors, not evidence that an explicit model is invalid.
- `effectiveConfig()` selects model/provider/effort and native approval/reviewer/sandbox fields. It does not return arbitrary config keys, layers, instructions or credentials. Native thread response policy fields remain authoritative for a running root; no default tuple was ratified here.
- `readThread(params)` and `listThreads(params)` use generated params/results. Full transcript mapping, paging UI, deletion semantics and identity rekey remain later work.
- `startLogin(params)` accepts only native browser, device-code or API-key variants. It returns `started`, `completed`, and `cancel`. The process remains alive for the matching `account/login/completed`; API-key completion uses null login identity. Early completion, stale IDs, disconnect, cancellation and a bounded deadline are handled. Native failure strings are discarded. URL/device-code metadata goes only to the host caller; this service never opens a browser. Cancellation sends a best-effort native cancel when the ID is known, then disposes the process. It does not claim cancellation undoes already-persisted login state. Disposal never logs out.

Login APIs are implemented against mocks, not exercised against the user's
account. The generated low-level logout type exists, but no automatic logout,
external-token flow, vault feeding, auth provider registry or client IPC exists.

## Native auth evidence and gate

On 2026-09-10, the implementing agent reported that `bun scripts/codex-native-status.mjs`
privately captured the vendored CLI's `login status` streams and emitted only:

```json
{ "authenticated": true, "authKind": "chatgpt", "requiresLogin": false }
```

The runner preserves the user's native environment/CODEX_HOME and verifies the
vendored cache first. It never prints captured streams or native error payloads.
No user auth/config file was inspected by tools, no vault credentials were
injected, and no login/logout/explicit refresh or real-provider model turn ran.
This establishes stored native login status, not token freshness or successful
real-provider inference. Never run `codex login status` directly in a visible
tool: its API-key path prints key fragments.

Reviewed pinned public source at `rust-v0.154.0`:

- [`cli/src/login.rs`](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/cli/src/login.rs), `run_login_status`, uses native auth loading and can print formatted API-key fragments. This path does not invoke the direct-login file logger.
- [`account_processor.rs`](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/app-server/src/request_processors/account_processor.rs), `get_account_response` refreshes only when requested, then reads provider account state. `login_chatgpt_common` sets `open_browser: false`. Native browser/device tasks own completion/cancel, and API-key login emits completion with null ID.
- [`auth/manager.rs`](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/login/src/auth/manager.rs), `AuthManager.refresh_lock` is an instance semaphore. `refresh_token` reloads and skips refresh if stored auth changed, but this check is not proof of cross-process serialization. `auth()` can proactively refresh. `refresh_token_from_authority` also uses the instance semaphore.

The user subsequently chose **Accept upstream behavior**. Native multi-process
refresh races are accepted for phase 1, not certified safe or serialized by this
source evidence. `account/read` with refresh disabled does not prove other native
work cannot refresh. The main reviewer ran the authorized sanitized status probe
and confirmed authenticated ChatGPT; the earlier tool-approval block is resolved.
Allowlisted native account/config/catalog reads may proceed. No automatic logout,
credential rewrite, shared-vault feed, or retry of ambiguous work is authorized.
Real provider turns and sign-in remain main-reviewer gates.

M1b local evidence: 69 focused unit tests and both isolated production-client
integration tests passed. The new integration uses `CodexService` for account,
catalog, effective config and history, and a separate typed root client for one
synthetic localhost turn. Root identity remains usable after service reads.
Empty newly started roots are not yet cold-readable; the fixture persists a
completed turn before the successful cold service read. Early development with
four concurrent fresh service processes saw intermittent config-read failures;
the final implementation shares one read process rather than retrying requests.
The cause of those early failures was not established. Main-reviewer checks
passed: 69 focused tests, both isolated integrations, protocol check, typecheck,
lint, build, 11,387 default-suite tests and 11,476 CI-inclusive tests. Live native
login/concurrency, real account catalog and product integration are not certified
by these tests.

## M2 additions

The pinned generator now includes `thread/settings/update`, effective
`thread/settings/updated`, token usage, reasoning deltas and command-output
deltas. There are 262 generated files in the current closure; provenance and
read-only generator check remain authoritative. Payload files were regenerated,
not edited manually.

`CodexSession` is registered through the existing session/spawn registries. Core
owns native policy/approval commands and the host/native user-ID reconciliation.
Native text/reasoning use item-scoped message upserts; command output uses the
existing volatile output lane. Simple native approval decisions are validated
against private pending choices; questions may be cancelled with empty answers,
secret questions are declined, and permission-profile requests receive no grants.
Hosted dynamic calls remain method-not-found.

Native settings updates are not assumed durable. A real new-process resume lost
an unconsumed update; migration 15 now stores sparse accepted app overrides and
the session replays them on resume. The same test passes with the production
repository running against real in-memory SQLite. Reset removes app replay only:
the test asserts omitted policy arguments and the actual native response, since
Codex can retain its own thread settings. Zero-turn roots still refuse separate
cold reads; that error is preserved and remains an M3 materialization gate.

Native device-code UI is implemented on desktop and remote transports and is
mock-tested, not live-login-tested. The production root integration uses an
isolated native OpenAI Responses WebSocket endpoint, including its non-generating
warmup, and tests a real native command approval/write plus cold read/list.
Root/service environments are replaced by fixture environments and all writes
stay inside the outer sandbox's temporary directory. No real keys or tokens are
used. The latest milestone status and remaining release gates are in the
[integration spec](../codex-integration-spec.md).

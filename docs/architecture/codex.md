# Codex engine architecture

**Registered fourth engine.** `codex` is in `EngineId`, registered through `register-engines.ts` and `SpawnPrepRegistry`, and selectable once native catalog discovery finds the installed pinned binary. Sessions run under ClaudeUI's shared permission modes and rules ([ADR-067](../adr/adr-067_codex-shared-permission-model.md)); [ADR-066](../adr/adr-066_codex-fourth-engine.md) owns the rest of the design, and the [integration spec](../codex-integration-spec.md) records exact implemented scope and remaining mandatory gates. Built: stdio transport, typed client and read-only service, the session adapter and event mapper, native catalog/model/effort selection, native device-code auth, and a history read/list baseline. Planned: application queue and steer, hosted tools, native children, fork, delete and archive, complete metering, and release hardening. The user accepted upstream native auth concurrency, and the main reviewer passed the sanitized authenticated ChatGPT status probe.

## M1a foundation

`src/core/codex/CodexAppServerClient.ts` owns one non-reusable JSONL connection.
It locates only vendored executables through the host app path, validates the
pinned executable version before initialize and then sends initialized. The
locator reserves extraResources/unpacked paths, but packaging is not wired.
Caller-provided environment replaces inheritance; omission inherits the native
runtime environment. Neither environment nor stderr nor raw protocol errors
are logged. The transport itself does not own account or login policy.

When the child dies the transport records it once. `fail()` with `stdout-closed`,
`process-exited`, `process-closed` or `spawn-failed` emits a single `warn` line
from source `CodexAppServerClient` carrying the failure code, the child's exit
code and signal, its pid, whether the client had reached ready, and the session
cwd. It waits up to a second for the `exit` that normally follows stdout's EOF —
the boot-time deaths seen on fresh scratch homes on 2026-09-15 all rejected as
`stdout-closed` before Node reported an exit code — and writes `exit=still
running` when none arrives. `CodexTransportError` exposes the same `exitCode` and
`exitSignal`, read through the client's one exit record so a rejection minted
before the exit still answers correctly; `message` stays `Codex transport:
<code>`. Ordinary closes log nothing: `disposed`, timeouts and `rpc-error-*` are
not deaths.

Stderr is still discarded unless `CLAUDEUI_CODEX_STDERR=1` is set on the app's
environment. With it, the child's stderr is appended verbatim to
`<log dir>/codex-stderr-<pid>.log` beside the daily logs (`getLogDir()` in
`src/core/services/logger.ts`), opened on the first chunk, written synchronously
so a dying child's last words survive, and closed when the pipe itself ends. While capture is armed, teardown does not destroy the stderr pipe (a destroyed readable discards what the child wrote and the parent has not read, and Node delivers `exit` before the pipes drain); it closes on its own once the child is gone. The warn line names
that PATH and nothing else out of the child. Codex's stderr can carry key
fragments, so the flag is off by default and its file is the only place stderr
may land: never an error message, a `session:error`, or the main log. The
credential boundary in [codex-integration-handoff.md](../codex-integration-handoff.md)
covers the file itself.

Every client names its CALLER. `CodexClientOptions.label` is a bare identifier the call site picks — `session`, `auth-probe`, `rate-limits`, `config`, `discovery`, `history-list`, `history-read`, `lineage-scan`, `delete`, `dispatch-target` — and `CodexService` forwards it like `cwd`; the death line reads `label=<label>`, `CodexTransportError.label` carries it for callers that log their own, and every spawn writes one debug line, `app-server spawned: <label> pid=<n> cwd=<dir>`. That line is off by default (the logger's default level is `warn`) and turned on with `CLAUDE_UI_LOG=CodexAppServerClient` — a bare word is read as that source at debug level, `CLAUDE_UI_LOG=debug` raises everything, and `CLAUDE_UI_LOG=info,CodexAppServerClient:debug` mixes the two (`parseFilter`, `src/core/services/logger.ts`). A label reaches the log, so it is held to `^[a-z][a-z0-9-]{0,31}$` and anything else — a path, an account, user text — is dropped to `unlabelled`, which is also what a site that named nobody reads as.

**Reads AND sessions run on a HOST, not on a process of their own** ([ADR-069](../adr/adr-069_codex-host-per-home-and-account.md), slices H1 and H2). `CodexHost` owns exactly one `CodexClient`; `CodexHostRegistry` (module singleton `codexHostRegistry`) hands out one host per Codex HOME and injected ACCOUNT, keyed `<normalised home>|acct:<vault account id>` or `<normalised home>|native`. `{ accountId: null }` means "the active account" and is resolved at acquire time, so a caller that follows active and one pinned to that same id share one process — and a vault with no active account resolves to `native`, the uninjected host, rather than opening a second identical process in a bucket of its own (that IS what following the active account means with an empty vault, and it is the fallback `CodexAuthProvider.probe` already reports). **Every product reader passes `{ accountId: null }`** — the auth probe, discovery, rate limits, config, the sidebar listing, the lineage scan, history reads and delete — so the common machine runs exactly ONE app-server per home. `native` survives for two callers only: `CodexService.startLogin`'s dedicated client, which must run uninjected because a native login is refused while external auth is active, and the tests and integration suites, which construct services without an identity so a developer's vault is never read. Identity is the one piece of PROCESS state (`account/login/start {chatgptAuthTokens}` binds the whole process and a second native login is refused while external auth is active, ADR-068 §1), which is why the key is home AND account rather than home alone. `acquire()` starts the client lazily — version probe, first-run gate, spawn, `initialize`, inject — and single-flights that start, so two acquirers landing in the same tick share one spawn; it returns a handle `{ request, injectedAccountId, host, release }` that every read holds for the length of the read and drops in a `finally`. The process is labelled `host`; the CALLER names itself per acquire in a debug line (`host acquired: <label> key=<key>`), which is what keeps a warm-host read attributable now that the spawn line no longer fires per caller. A transport failure closes the host, rejects every open handle through the transport's own error, writes the one F7 death line with `label=host`, and removes the host from the registry so the next `acquire` starts a fresh one — nothing retries a dead process on a caller's behalf (ADR-069 §5).

**Sessions are threads on the host, demultiplexed by `threadId`** (ADR-069 §2, slice H2). `CodexHost.attach(owner)` hands a session — or a dispatch target — a `CodexThreadConnection`: `request()`, `abortServerRequests()`, `claim(threadId)` / `disclaim(threadId)` and `detach()`. The host registers the UNION of the server methods its owners answer (the transport gates on that list before any routing happens) and applies three rules: a notification or server request stamped with a `threadId` goes to the owner that CLAIMED it; a payload with no `threadId` at all — `account/rateLimits/updated`, `account/updated` — is account-level and is fanned out to every attached owner; `account/chatgptAuthTokens/refresh` is the host's own, answered from its hook, whose `onAuthRequired` is likewise fanned out so every session on a stale credential says so. A server request for a thread NOBODY claimed is answered with the transport's `-32601 Method not found` and logged at debug — never silently accepted, because a lost approval has to be visible; a NOTIFICATION for an unclaimed thread is held and replayed the moment someone claims that thread, which is what keeps a native child's first events — they routinely beat the spawn item that names it — from being lost now that the hold cannot live in the session. That hold is bounded three ways, because nothing else prunes a bucket nobody claims: a thread the binary reports `thread/closed` loses its bucket at once, entries older than 30 s are discarded rather than replayed (a disposed session's leftovers must never surface in the session that resumes its thread), and a full hold (200 entries) evicts its oldest bucket instead of refusing the newest child. A claim of a thread another owner already holds is REFUSED, not stolen: one live session per thread is an invariant, and detaching is how a thread is legitimately handed on. `detach()` sends `thread/unsubscribe` for every claimed thread: it stops the firehose, and because the binary unloads a thread with no subscribers about a minute later (`thread_unload_delay`, `app-server/src/request_processors/thread_lifecycle.rs`), it is also what eventually releases that thread's writer lock. Each host START takes the next process-wide GENERATION, which is what scopes a session's pending approvals and one-shot hosted calls: an answer minted on the previous host is refused after a resume, exactly as a previous process's was.

**The writer lock follows the PROCESS, so a delete follows the host.** A loaded thread's lock refuses every OTHER app-server on the home — `thread/delete` and `thread/resume` alike (`thread <id> already has an active writer`, pinned by upstream's own `app-server/tests/suite/v2/thread_resume.rs`) — while the holder may delete its own thread, idle or mid-turn (ADR-069 probe P5). So `CodexHost` remembers every thread its process has loaded — learned from the `thread/start` / `thread/resume` / `thread/fork` RESPONSES, since the lock is taken when the thread opens rather than when an owner claims it, and kept until the binary says `thread/closed` — `acquire({ thread })` is served by that host when one holds it, and `CodexService.deleteThread` uses it. That is what retired `delete.ts`'s stop-then-wait retry: stopping a session no longer ends a process, and there is no lock to outwait. The same lock is what a session moving BETWEEN hosts — a re-pin, or a resume after an account switch — has to wait out; see the switch paragraph below. (H2 refused such a re-pin outright while another SESSION shared the host, because its way of freeing the lock was to CLOSE the vacated host, which would have taken that session's turn with it. H3 waits instead, so the refusal is gone; a host with owners is never closed for one pin. Read leases were, and remain, ignored in that decision — a read that loses its host fails once, ADR-069 §5.)

**An ACTIVE-account switch moves the sessions that FOLLOW it** (ADR-069 §4, slice H3). `CredentialSync.switchActiveAccount` — and `removeAccount` when it promotes another — rings `onActiveAccountChanged`, which the Electron-free boot seam (`core/boot/core-services.ts`) wires to `followCodexActiveAccount(sessionManager, activeId)`. Every live Codex session with no pin whose host runs as a different account interrupts its children, leaves its host (`leaveHost`, which closes that host only when nothing else is attached to it) and goes `disconnected` — a `session:status` and NO `session:error`, because a switch is the user's own act, like a Stop. A PINNED session is untouched, including one pinned to the account that has just stopped being active, and its host keeps running for it. Nothing is resumed eagerly: the follower continues on the new account's host at its next prompt, through the same `thread/resume` a `disconnected` session has always continued through (ADR-045), which is also the only order that works — the thread's writer lock is still held by the host it just left. The hook is wired in the boot seam rather than in the desktop's provider registrar because the session graph is what it needs and `claudeui-server` never imports that registrar; `CredentialSync.configure()` is additive, so the two composition roots wire their own halves without clobbering each other.

**A resume that meets the writer lock WAITS for it** (ADR-069 §4). A `thread/resume` refused `-32600` is retried every 2 s for up to 75 s — the binary's `thread_unload_delay` is 60 s — with one `session:warning` ("Waiting for the previous Codex process to release this thread") and a running status on the first retry, and it is what carries both moves a shared host makes necessary: an account switch's resume and a re-pin off a host another session is using. The refusal is matched STRUCTURALLY, never by the binary's error text: it is waited out only while `codexHostRegistry.holdsThread(threadId, env)` still names a live host on this home as the thread's holder, because that host is the refusal's explanation and its unload is the bound. Every other `-32600` on that method — a thread that is gone, a lock held by an app-server this process does not own (out of scope, ADR-069's cross-process note) — fails at once, as before. Measured on Windows x64 with the real binary: after a switch the vacated host (kept alive by a pinned session) held the lock for ~57 s and the retry rode it out; when the vacated host is closed instead, the lock is gone with the process and the resume lands in under a second.

**The idle rule: reads keep a host WARM, not ALIVE.** A host with no handle and no registered session is closed after `CODEX_HOST_IDLE_MS` (five minutes), and that is a DEADLINE fixed the first time the host falls to zero users, not a sliding window. The sidebar's 30-second directory poll is why: a window reset by every read would pin a process for as long as the app is open, which is the cost the host model exists to remove. A read landing during the wait cancels the timer — nothing is closed under a live request — and re-arms it on release for whatever is LEFT of the deadline, so a stream of polls still lets the host die on schedule (and a read that is itself still running when the deadline passes releases onto a zero-length timer). Only an ATTACHED OWNER keeps a host alive indefinitely: `attach()` clears the deadline and `detach()` re-arms it, so a host lives exactly as long as the last session or dispatch target on it, plus the idle grace.

**Closing is graceful.** `CodexAppServerClient.dispose()` now ends the child's stdin first — Codex's stdio transport exits on `stdio_connection_closed` on every platform (`app-server/src/lib.rs`), and that is the only shutdown that lets it close its sqlite state files itself; a `taskkill /F` never does, and what it leaves behind is one half of the "failed to initialize sqlite state runtime" class F7/F8 chased. The process-tree guarantee is unchanged because the grace is bounded: `killGraceMs` after the EOF, or the moment the child exits, `terminate()` runs exactly as before (`taskkill /T /F` on Windows, SIGTERM then SIGKILL on the process GROUP on POSIX), so a child that ignores the EOF and any descendants that outlive their parent are still reaped. Only a close the CLIENT initiated takes that path; every other failure is already a dead or dying child and goes straight to the kill. A disposal never writes the F7 death line, including the `stdout-closed` the EOF itself produces — the failure code stays `disposed`, which is not a death code. App quit disposes every host this way (`codexHostRegistry.dispose()` in `src/main/index.ts`), bounded: nothing waits on a child, and a parent that exits first closes the pipe, which is the same EOF.

The FIRST app-server per Codex home is serialised. Codex builds its sqlite state runtime the first time an app-server starts in a home, and a second one racing it dies with `failed to initialize sqlite state runtime under <home>` and exit 1 (`app-server/src/lib.rs`); ClaudeUI's boot starts three within milliseconds — the catalog discovery behind the renderer's first models request, the launch-time lineage scan and the auth probe — so on a machine with no `~/.codex` the loser could be the user's first session. `start()` therefore resolves the home the child will use (`codex-home.ts`: the client's own `env` first, since that environment REPLACES inheritance, then `CODEX_HOME`, then `~/.codex` — Codex's `find_codex_home` rule) and, if that directory holds no `state_*.sqlite`, takes a module-level gate keyed by the normalised path. Everything else starting on the same home waits for it and then re-checks: a holder that lived created the databases, so the check passes; one that died left the home uninitialised, so the first waiter to re-check becomes the next holder and the rest wait on it. The holder releases when `initialize` has answered or when `fail()` closes it — whichever comes first, and `fail()` is on every other exit including `dispose()` — and a client disposed while waiting rejects with `disposed` without spawning. An initialised home pays one `readdirSync` per start. Retrying a dead app-server instead was considered and rejected: it hides a race behind a second process, and the loser's death is indistinguishable from a real startup failure. Known limit, captured live on 2026-09-15: the same failure also hits an INITIALISED home when an app-server starts while a short-lived sibling (the auth probe's native read that session creation triggers) is shutting down a few hundred milliseconds after it started; widening the gate to every start made that deterministic, because the waiter is released exactly when the sibling has answered `initialize` and is about to exit. That second shape is an open item (`docs/codex-followups-spec.md`, F8 Landed). Since ADR-069's H1 the gate guards HOST starts: reads no longer start app-servers of their own, so the racers it serialises are the hosts for a home and the sessions that still own a process until H2 — which also removes the second shape's trigger, a short-lived sibling shutting down under a starting app-server.

One of those three spawns is now gone after the first: `model/list` is answered locally by the binary and cannot change without a re-vendor, so `discoverCodexModels()` (`model-discovery.ts`) memoises the catalog for the life of the process, keyed by the located binary's path, size and mtime plus the vault's active account (Codex fills the list with `RefreshStrategy::OnlineIfUncached`, so a signed-in process may fetch it online and a switched identity may see a different list), and single-flights the discovery so the composer's re-fetch on every cwd change — and the two requests boot lands at once — share one app-server instead of spawning their own; only a succeeded, non-empty catalog is stored, and `discoverCodexModels({ refresh: true })` re-asks the binary (wired to nothing but the tests today).

Outgoing RPC IDs are independent of native numeric/string server-request IDs.
Pending work and write queues are bounded. Timeout errors identify potentially
delivered requests, never trigger retry, and remove expired unsent writes.
Incoming handlers receive an AbortSignal and must cancel their actual work.
Native resolution aborts matching handlers. A later session adapter must call
`abortServerRequests` on the owning thread/turn's terminal event, including the
interrupted-dynamic gap. Unknown methods receive -32601; unknown notifications
are tolerated. Duplicate incoming IDs fail closed, including reused resolved
IDs. A 100,000 incoming-ID lifetime cap and 256-character string-ID limit bound
deduplication memory. Cancelled replies still waiting in the write queue are
removed before drain.

LF framing preserves UTF-8 fragmentation, CRLF and Unicode line separators.
Invalid frames fail closed without payload diagnostics. Process exit immediately
aborts incoming handlers, blocks new requests/callbacks and drops queued writes.
It drains trailing stdout responses and notifications until end/close or a fixed
one-second deadline, then rejects unresolved RPCs with the original exit reason.
Inherited pipes are closed locally at the deadline. Close/error/disposal otherwise
reject pending RPCs immediately. Disconnect emits once, and failed initialization
cannot return the client to ready. POSIX detached groups receive TERM then KILL
after a bounded grace, even when the root exits first. Windows uses the existing taskkill-first helper
unchanged. Escaped process groups and PTY descendants are not solved by this
foundation. Windows x64 runtime evidence as of 2026-09-13: acquisition, `codex.exe --version`, app-server
spawn and initialize, `account/read` and catalog discovery through the settings pane, the real `execpolicy check`
parser in the unit suite, `check-codex-protocol` (byte-identical generated types), and no orphaned process after the
harness quit. Windows x64 evidence as of 2026-09-14, real signed-in turns on GPT-6-Astra in `D:\WorkPlace\codex-scratch`:
there is no Windows sandbox in 0.154.0 (`experimental_windows_sandbox` and the elevated variant are stage Removed,
`windows_sandbox_service` is UnderDevelopment and off; `capabilities.sandbox` reports false), so every command runs
unsandboxed and the decision surface is the whole containment. In default mode (`untrusted`) a file write prompted and
ran only after Allow. In Auto (`on-request`) BOTH the file write and a loopback `ping` produced a "Codex auto-review
approved (risk: low)" row, which is what `exec_policy.rs` promises: with the sandbox backend disabled and a managed
filesystem profile, `render_decision_for_unmatched_command_for_platform` returns `Prompt` for every unmatched command,
and under `on-request` that prompt goes to the guardian. Expect more reviewer rows and slower Auto turns on Windows than
on macOS or Linux. Process tree: with one session mid-`ping` and again with two sessions each mid-`ping` (two `codex.exe`,
two `codex-code-mode-host.exe`, two `PING.EXE`, two Codex `pwsh.exe`), nothing survived five seconds after the app closed;
the taskkill-first helper reaps the whole tree. Linux evidence is in the Linux section below.

`scripts/ensure-codex.mjs` acquires the reviewed 0.154.0 binaries for every host in `scripts/codex-digests.json#hosts` — macOS arm64, Windows x64 (installing `codex.exe` and `codex-code-mode-host.exe`) and Linux x64/arm64 (the statically linked musl assets); since `e5bf09b6` it runs from `postinstall` and from every packaging target in `scripts/build.mjs`, and `electron-builder.yml` ships `vendor/codex-cli` (both members) as `Resources/codex-cli`. On a host the manifest does not cover (Windows arm64 today) it skips with one line and exits 0, and the engine gates itself off. Generated
initialize types are exact CLI output; envelopes are derived from the pinned
CLI's JSON schema because its TypeScript generator omits them. M1b adds typed
method maps over this generic transport without claiming runtime payload-schema validation.
[Regeneration and tests](../protocol-codex/README.md) describe the local fixture
and the remaining platform and release gates. M1a itself changed no UI or other
engine behavior.

### Linux

Linux x64 and arm64 are reviewed hosts: `scripts/codex-digests.json#hosts` pins the
statically linked `-unknown-linux-musl` `codex` and `codex-code-mode-host`,
`CODEX_SUPPORTED_HOSTS` offers the engine, and CI caches `vendor/codex-cli` per
`runner.arch`. The Linux ARTIFACT is the headless server tarball, not a desktop
build: `claudeui-server-*-linux-{x64,arm64}.tar.gz` now carries
`vendor/codex-cli` beside `vendor/opencode-cli` and `vendor/pi-cli`, which
resolves because the compiled executable's app path is the directory holding
`out/web` and `locateCodexBinary()` reads `<appPath>/vendor/codex-cli/codex`. No
Linux desktop build ships, so `electron-builder.yml` needed no change.

Linux is no longer the only headless host. Since 2026-09-14 the desktop `build`
matrix also stages a server archive — `claudeui-server-*-mac-arm64.zip` and
`claudeui-server-*-win-x64.zip`, with `vendor/claude-cli` alongside the other
three engines (ADR-061's 2026-09-14 amendment). Codex behaves identically there:
same locator, same app path. Only the sandbox differs, and `bwrap` is a Linux
concern alone — the note below applies to the tarballs, not the zips.

**bubblewrap is a system dependency, deliberately not a manifest member.** Codex's
Linux sandbox is `bwrap`: it prefers a system one on `PATH`
(`codex-rs/sandboxing/src/bwrap.rs::find_system_bwrap_in_path`, a `which`-style
walk), then one beside its own executable, and with neither it panics
`bubblewrap is unavailable` on the first sandboxed command
(`linux-sandbox/src/launcher.rs`). Landlock survives only behind the hidden
`--use-legacy-landlock` flag. Install it from the distro: `apt install bubblewrap`
(Debian/Ubuntu), `dnf install bubblewrap` (Fedora/RHEL), `apk add bubblewrap`
(Alpine), `pacman -S bubblewrap` (Arch). `claudeui-server` checks for it once at
boot — `codexLinuxSandboxWarning()` in `codex-locate.ts`, called only when a Codex
install is actually present — and logs one `warn` naming the package when it is
missing; commands the operator approves still run, only sandboxed ones fail.

Two environments break `bwrap` even when it is installed, both because it needs an
unprivileged user namespace: **Ubuntu 24.04+**, whose AppArmor restriction on
unprivileged user namespaces produces `No permissions to create a new namespace`,
and **Docker**, whose default seccomp profile blocks the same call (the verify
script below runs with `seccomp=unconfined`, `apparmor=unconfined` and
`SYS_ADMIN` for exactly that reason). Neither is a ClaudeUI bug and neither has a
workaround in our code.

Linux x64/arm64 runtime evidence as of 2026-09-14, in Debian bookworm containers on both arches (x64 under Rosetta): acquisition downloads and digest-verifies both members and reports a cache hit on rerun; `CLAUDEUI_CODEX_FAKE_HOST=linux/ia32` still skips; `check-codex-protocol` matches the vendored binary (generated types byte-identical to the macOS output); `locateCodexBinary()` resolves the installed pair at the manifest digests; `build:web` + `build:server:compile` produce a booting executable, and the release job's tarball layout resolves `vendor/codex-cli`; the four shared Codex integration suites (15 tests) pass against the real binary on both arches; the boot warning fires only when `bwrap` is off `PATH`. Real-account evidence (2026-09-14, arm64 container, the compiled server from the release tarball layout, the owner's vault file copied in by authorization, the web client driven with Playwright over the LAN E2E channel after a break-glass password login): a fresh Codex session on GPT-5.6-Luna ran `ls` inside the bubblewrap sandbox under Auto and answered; a second turn in default mode raised the approval card for a write outside the workspace, and the approved command ran unsandboxed with exit 0, as the permission model specifies. That drive found the web-client `null` optional-argument bug fixed in `remote-handlers.ts` (see M5-L Landed in `codex-integration-spec.md`). The other eight integration suites stay macOS-only: an exploratory arm64 run with their containment made conditional passed `codex-app-server`, `codex-lifecycle`, `codex-delete`, `codex-dispatch-target` and `codex-interrupted-tool`, but `codex-policy-probe`, `codex-auto-review-probe` and `codex-rules-sync` assert macOS specifics (the `/bin/zsh -lc` wrapper — Linux uses `/bin/bash -lc` — and seatbelt nesting), so nothing was switched.

Verification runs in a container, because no CI job hosts a Linux desktop:
`scripts/docker/codex-linux-verify.sh --arch x64|arm64` builds
`scripts/docker/codex-linux.Dockerfile` (Node 24.15.0 on bookworm, pinned bun,
bubblewrap), bind-mounts the checkout READ-ONLY, copies it to `/work` by
`git ls-files --cached --others --exclude-standard`, installs, and runs the
typecheck, `check-codex-protocol` and the Codex integration suites with
`CODEX_INTEGRATION=1`. `--no-bwrap` builds the same image without bubblewrap to
watch the boot warning fire. The host's `node_modules` and `vendor` are never
touched.

## Process and identity ownership

M1b now provides `CodexClient` typed methods and a separate `CodexService` with
coalesced account/catalog/config/history reads and retained native login flows.
These are host-only APIs behind registered core commands and the native auth
provider. Service reads never start or resume a root. Since
[ADR-069](../adr/adr-069_codex-host-per-home-and-account.md) H1 they never start
a PROCESS either: every read borrows the `CodexHost` for its home and the ACTIVE
account (see the transport section above), and the only app-server `CodexService`
still builds itself is `startLogin`'s, which by design must run uninjected. An
integration suite that constructs a service without an identity therefore has to
dispose `codexHostRegistry` in its teardown — `service.dispose()` drops leases,
it does not end a process. Device login UI is
mock-tested; the authorized native status check passed independently. See the
[service contracts and evidence](../protocol-codex/README.md#m1b-service-and-ownership).
The table marks the owners whose responsibilities are still partly planned (full usage).

| Owner                              | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CodexSession extends BaseSession` | One root session's lifecycle, model and effort selection, per-turn policy derivation and approval gating. Owns a THREAD on its account's host (ADR-069 §2), never a process: `dispose()` interrupts the running turn, closes its children's cards and detaches, `followActiveAccount()` leaves the host when the account it follows changes (§4), and a resume waits out the writer lock the host it left still holds. Held queue and steer, hosted tools, dispatch as a source, completed-turn fork and native children are built; full usage is planned |
| The host's app-server process      | Every thread ClaudeUI has open on that home and account — each session's root, their native children, and any dispatch target — plus model context and native persistence                                                                                                                                                                                                                                                                                                                                                                                 |
| RPC client                         | JSONL framing, handshake, request correlation, server requests, timeouts, generation invalidation, disconnect                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Pure mapper                        | Native items/deltas/results into neutral messages, tool results, task notifications, and usage facts                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `CodexHost` / `CodexHostRegistry`  | ONE app-server per Codex home and injected account (ADR-069 §1): lazy single-flight start, the injected identity and its refresh answer, leases for readers, THREAD CONNECTIONS for sessions and dispatch targets, the `threadId` demultiplexer and its claims, which threads the process holds (for delete), the host generation, the idle deadline, graceful close, and removal on death                                                                                                                                                                |
| `CodexService`                     | A FACADE over hosts (ADR-069 §3): bounded catalog/history/config/auth/rate-limit reads borrowed from the host for its home and account — every product reader asks for the ACTIVE account, so they share one host — plus the one dedicated client `startLogin` needs (a native login must run uninjected); owns no thread                                                                                                                                                                                                                                 |
| SyncCore                           | Canonical state, command authorization, replication, stream fanout, query routing                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

New code belongs under `src/core/codex/`; host locators/spawn inputs follow `src/core/host.ts`. `register-engines.ts` and `SpawnPrepRegistry` are the existing construction seams. No Electron import enters core, and a null window is normal. Desktop preload and web clients use the same typed core contracts. Neither gets a Codex socket or a browser-facing app-server port.

Persist native `thread.id`, not a tree display/grouping `sessionId`. The root's pre-start routing ID may need the existing rekey path once native identity is known. Store explicit parent-child relationships and route every native event by its owning thread. Use thread/turn/item composite keys for transcript mapping; include the HOST GENERATION (ADR-069 §2 — one process is shared and outlives no resume) for pending RPCs and one-shot authorization. Equal item IDs in different turns or children must not collide. Reconnect never revives an old deferred response.

## Permissions

Codex executes; ClaudeUI decides. The session's shared `PermissionMode`
(`plan | default | acceptEdits | auto`) is the only policy the user sets.
[ADR-067](../adr/adr-067_codex-shared-permission-model.md) holds the
mode-to-native mapping table and the probe and source evidence behind it. There
is no native policy pill, no `CodexPolicyOptions`, and no renderer carve-out:
the mode tab, the mode picker and the Shift+Tab cycle behave as they do on the
other three engines, `capabilities.plan` is true, and Auto follows the global
default (ADR-050).

`CodexSession.turnPolicy()` derives `approvalPolicy`, `sandboxPolicy` and
`approvalsReviewer` from the current mode and sends them on every `turn/start`.
The same mode policy goes on `thread/start` and `thread/resume` as the thread
baseline, so a turn that somehow starts without a per-turn override still runs
under the session's mode rather than the working directory's native
configuration. `setPermissionMode` applies from the next turn: a running turn is
not re-policied mid-flight, because `turn/steer` is not implemented and
`thread/settings/update` acknowledges out of band.

Every approval request the server sends is answered by the same engine-neutral
evaluator pi uses (`src/core/pi/permission-engine.ts`) against the same merged
user/project/local `~/.claude` rules: deny rules, ask rules, session allows,
allow rules, then the mode base. `item/commandExecution/requestApproval` gates
as `bash` on the command string, because `commandActions` is display-only.
`item/fileChange/requestApproval` carries no paths, so they are read from the
`fileChange` item already mapped into the transcript, one evaluation per file
(`add` is a write, every other change type an edit), collapsed as any-deny
denies, else any-ask asks, else allow; a request with nothing resolvable asks.
Allow answers `accept`. Deny answers `decline` plus a `session:error` naming the
rule or the plan reason, because neither native reply carries a reason. Ask
raises the standard `PendingApproval` with always-allow suggestions in the
Claude rule vocabulary, and `allowForSession` records the shared session-allow
key. `acceptForSession` and `acceptWithExecpolicyAmendment` are never sent;
ClaudeUI owns rules and session allows, and Codex's execpolicy is not written.
Under `auto` the native `auto_review` guardian reviews escalations first, and
whatever still reaches the client is gated exactly like `default`.

Approving is a full-access grant on this wire: an accepted command runs
unsandboxed whatever the sandbox policy says (probe, [codex-spike.md](../codex-spike.md)
section "Native approval surface probe"). The sandbox is what the model is told
about its environment and what contains Auto's silent in-workspace work, not a
second decision layer. Sandbox enforcement itself cannot be measured in the
integration fixture, so containment claims rest on the Codex source at tag
`rust-v0.154.0` and on real-app runs.

Two additions landed on 2026-09-12. Under `auto`, each completed guardian
review (`item/autoApprovalReview/completed`) becomes visible instead of
vanishing, and the guardian's circuit-breaker warning becomes a row plus
`session:error`; reviews are not thread items, so cold history cannot
reconstruct them. Since F18 (2026-09-16) a review that names a `targetItemId`
renders ON the card of the item it judged — `session:tool-review` carries a
`tool_review` block to the assistant message holding that `tool_use`, and
`ToolCard` shows a chip in the header (collapsed and expanded) plus a review
strip between header and body when expanded, in the approval card's own
vocabulary: decision, risk level, rationale. Approved rows carry it too, which
is the point: an action that ran under a machine's consent should say so. The
system row survives only where there is no card — a `targetItemId: null`
network-policy review, and every `guardianWarning`. A verdict whose target item
has not been mapped yet is held by `CodexSession` and released from `item()`,
falling back to the standalone row at turn end. The same block is produced for
opencode and pi by ClaudeUI's own Auto-mode judge (`reviewer: 'auto-mode'`, with
the corpus rule name instead of a risk level); Claude's Auto mode is cli.js-native
and emits no verdict on the wire, so there is nothing to render there. And the user-scope
Claude `Bash` rules are compiled into `$CODEX_HOME/rules/claudeui.rules`
(`rules-sync.ts`, see ADR-067's amendment for the mapping and trade-offs), so
deny rules bind even under `auto` and prefix allows skip the ask; the file is
regenerated on core boot, after a user-scope permission write and in the Codex
spawn prep, only when its source hash changes.

An MCP tool call is gated through the same ladder, but it does not arrive as a
`requestApproval` at all. Codex 0.154.0 has no `item/mcpToolCall/requestApproval`:
before an MCP tool runs under a mode that asks, `core/src/mcp_tool_call.rs`
sends the server request `mcpServer/elicitation/request` carrying a FORM whose
`_meta.codex_approval_kind` is `mcp_tool_call`, and reads anything but an
`accept` back — including the `Method not found` an unregistered method earns —
as `ReviewDecision::denied("user rejected MCP tool call")`, which is exactly what
every inherited server's first tool call hit. `mcp-elicitation.ts` reads the
form and `CodexSession.mcpElicitation` answers it: the gated tool name is
`mcp__<server>__<tool>` in Claude's own MCP rule vocabulary (kind `mcp`), allow
answers `{action: "accept", content: {}}`, deny answers
`{action: "decline"}` plus the usual `session:error`, and ask raises the
standard card whose always-allow suggestions and session-allow key use that same
name. The form names its tool only in the message (`Allow the <server> MCP
server to run tool "<tool>"?` — the meta key `tool_name` exists upstream but the
core's builder does not set it), so a message a connector template rewrote
narrows the gate to `mcp__<server>`, which never widens a verdict. Codex's own
persistence options are never echoed back: a response `_meta.persist` really is
forwarded into `Op::ResolveElicitation`, and ClaudeUI owns rules and session
allows. An elicitation that is not the tool approval is declined with one
`session:warning` naming the server; rendering arbitrary MCP forms is not built.
The exact request is recorded in
`src/core/codex/__tests__/fixtures/mcp-tool-approval-elicitation.json` and
re-captured on every run of
`src/integration/codex/codex-mcp-approval.integration.test.ts`.

`codex_session_overrides` (migration 15) now holds model and effort only. Rows
written before the shared gate still carry the retired
`approvalPolicy`/`sandbox`/`approvalsReviewer` keys; `savedCodexOverrides` drops
unknown keys on read so those sessions stay openable, while `parseCodexSettings`
rejects them outright on every write path. Model and effort travel over the
engine-neutral `session:set-model` and `session:set-effort` commands, which are
the only callers of `setCodexSettings`; native reasoning effort renders in the
standard effort picker from the tiers the engine publishes.

`SessionStatus.codex` carries the native state the UI still needs, the model
provider, current reasoning effort, effort options and saved overrides, not
policy. The only approval that still carries an engine-specific payload is the
native `item/tool/requestUserInput` question card; `item/permissions/requestApproval`
is refused with a visible explanation and an empty grant, and a question marked
secret is declined without an answer.

Before first spawn, replicated `codexModelExplicit` keeps a catalog preview from
overriding a project's native configured model. The API omits an inherited model
request, then folds the native model response into the canonical selection.

Hosted dynamic callbacks are not registered yet. When they are, they need a host
authorization boundary separate from these approvals: validate the live session
and call identity, deduplicate execution, and apply the configured
hosted-tool/dispatch policy, because a native invocation alone does not
authorize dispatch. Existing remote read/act and capability restrictions apply
to user-issued session commands and approval responses, and core keeps operating
with no clients connected.

## Four contract lanes

| SyncCore lane    | Codex use                                                                                                                                                                                                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Commands         | Create/resume, send/interrupt, permission-mode and model/effort changes, approvals and authorized login actions. Steer and recall are built (`4050eb0a`)                                                                                                                           |
| Domain events    | Session identity/status/effective config, final transcript items, pending request lifecycle, queue state, task lifecycle and usage metadata                                                                                                                                        |
| Volatile streams | Command-output tails plus root/direct-child text, reasoning and plans on the [per-item lane](../per-item-streaming-design.md): reliable open/seal, volatile chunk-only append, atomic watch replay. Partial output is sealed on interruption; a child may outlive the parent turn. |
| Queries          | Native catalog/status, history/list/fork anchors, non-secret account metadata                                                                                                                                                                                                      |

Extend the existing contracts in `src/core/shared/sync/`, `src/shared/types.ts`, and `src/shared/remote-protocol.ts`, not an engine-specific renderer side channel. Canonical and replica reducers must converge after reconnect, including pending approvals and non-recallable sends. Core continues operating with zero clients.

## Transcript and persistence

Native thread storage owns model context. A neutral history registry delegates read/list/delete/fork-anchor operations to each engine's implementation. Existing Claude, opencode, and pi readers remain intact behind that seam; all callers, including canonical resume seeding, must select an explicit engine. Unknown engine metadata produces a safe error rather than a Claude filesystem operation.

Use the same pure Codex mapping for live completion and history items. Preserve completed native IDs, text/reasoning, partial or full tool output, images, file-change diffs, and task notifications. Paginated read/resume worked in the small spike despite the guide; large-history paging/order/deduplication is still a release gate. Use bounded service reads without claiming a second active-thread owner.

The spike's interrupted dynamic invocation disappeared from immediate and cold native history. If needed for transcript fidelity, persist a narrow SQLite presentation supplement keyed by native thread/turn/call. Mark it interrupted or outcome-unknown, merge idempotently, and never replay it into model context or fabricate a native completion. Decide retention and delete/fork behavior with the history schema gate.

Codex read, list and fork are built (`5e92e52f`): the fork anchor is the turn parsed from the codex message id, `thread/fork` copies the source through that turn into a new thread whose `forkedFromId` is verified, forks are kept in the sidebar through a `session_meta` sweep because `thread/list` never returns them, and the canonical seed truncates the source history through the anchor. Delete walks the branch tree leaf-first after a confirmation (`01f38172`); archive is unused.
Fork anchors identify completed native turns. A message inside a turn must either resolve to an explicitly displayed supported boundary or be refused. Fork success creates a distinct thread and leaves the source untouched. Delete must define native deletion versus archive semantics and test descendants, pins, active ownership, and supplement cleanup before its UI is enabled. Legacy metadata import must recognize Codex going forward; already-clamped Claude rows cannot be automatically recovered from model names or guessed thread IDs.

## Queue and cancellation

Built in `4050eb0a` (2026-09-12) as designed below: `SessionQueue.consumeById`
correlates by `clientUserMessageId: steer-<itemId>`, boundaries are chained on
the session's own promise, and `capabilities.queue`/`steer` are true.

Keep `BaseSession`'s queue of record. Hold recallable input until an observed boundary supports a steer, then send `expectedTurnId` plus `clientUserMessageId`. At idle, start a new turn through the ordinary send path. Do not forward through Codex's native next-turn queue.

Separate local recallability from RPC acceptance and from native user-item acknowledgment. Once a send may have reached Codex, do not offer a guaranteed recall or claim inference consumption. A matching thread/turn/client ID acknowledges the input; duplicate text does not. Timeouts require thread/turn reconciliation before retry or terminal failure. Shared queue type changes must preserve the three existing engines' semantics.

Every callback has an owning thread/turn and generation. Terminal state for that owner or transport death invalidates pending callbacks and approvals, aborts actual local/dispatched execution, and drops late results. Missing native `serverRequest/resolved` is expected for interrupted dynamic calls. A parent finishing does not imply child completion; a surviving child's own turn governs its work. Full root teardown cleans up all owned descendants and emits `disconnected` per ADR-045.

Core settles its pending maps and emits explicit per-request dismiss/task events.
Renderers never infer dismissal from `idle` or parent completion. This preserves
ADR-038 while compensating for Codex's missing dynamic-call resolution event.

## Tools and dispatch

Built: `CodexEngineToolMap` feeds the existing renderer `ToolView` kinds; the
three hosted UI tools run over the native dynamic-tool channel (`30421310`,
`hostedMcp: true`); `dispatch_agent` makes Codex a dispatch SOURCE (`843b4ecf`,
`crossEngineDispatch: true`, ADR-033 amendment). Native children render as subagent transcripts under the spawning card on both collab surfaces (`5452d3c5`, `subagents: true`). Codex is also a dispatch TARGET (`749886cc`): the dispatcher runs a headless thread per target under the caller's mode.

**The Codex desktop app's own entries never reach a ClaudeUI thread (F17).** The desktop app shares `~/.codex` with the CLI and writes into the USER's `config.toml`: its own MCP servers (`[mcp_servers.node_repl]`, `[mcp_servers.cua_repl]`, `[mcp_servers.computer-use]`, commands inside the app bundle), a local `[marketplaces.openai-bundled]`, and `[plugins."<name>@openai-bundled"] enabled = true` for `browser`, `codex-app-tools`, `computer-use`, `visualize`. Nothing in the binary gates plugin or MCP LOADING on which client opened the thread — `core-plugins/src/manager.rs` uses the app-server client name only to filter install SUGGESTIONS, and the TUI merely hides the marketplace from its menus — so an app-server ClaudeUI starts loaded them all. That is the real source of the "in-app browser" a ClaudeUI turn once offered to test a build with: the `browser@openai-bundled` manifest and skill say "Use Browser, the ChatGPT in-app browser, when the user asks to open, inspect, navigate or test local web targets", and Codex injects that text into every prompt.

`CodexSession.threadParams()` — the one envelope `thread/start`, `thread/resume` and `thread/fork` all spread — now always carries a `config` override with three parts: `features` set to `CLAUDEUI_DISABLED_FEATURES` (`codex-features.ts`), `mcp_servers.<name>.enabled = false` for each detected desktop server (merged with the inherited Claude MCP table of ADR-068 §5; a name in both keeps its transport and gains the flag), and `plugins.<id>.enabled = false` for each detected desktop plugin. One `logger.info` line per spawn names what was disabled.

The set is DETECTED, never assumed (`codex-desktop-entries.ts`, pure and unit-tested): an `enabled: false` overlay on a server the user does not have would create a table with no transport and fail config load outright. A server counts when its name is `node_repl` / `cua_repl` / `computer-use` (the names `plugin/src/bundled_hooks.rs` pins) or its `command` runs through a `.app/Contents/` bundle; a plugin counts when its id ends in `@openai-bundled`. `openai-primary-runtime` plugins, every other marketplace, and the flags the TUI also has (`apps`, `plugins`, `remote_plugin`, `skill_search`, `tool_suggest`, `mentions_v2`, `goals`, `codex_hooks`) stay as the user configured them. Detection reads the EFFECTIVE config off the `config/read` a session already makes in `start()` — one read per session start, on the host it is already attached to (ADR-069), no second app-server.

The nine FEATURE flags (`in_app_browser`, `in_app_chat`, `in_app_dictation`, `in_app_local_automation`, `in_app_updates`, `browser_use`, `browser_use_full_cdp_access`, `browser_use_external`, `computer_use`) are `Stage::Stable, default_enabled: true` but gate no tool in `core/src/tools/spec_plan.rs` — their consumers are the guardian reviewer config, `turn_metadata.rs`'s `computer_use_review_required`, and `mcp_tool_call.rs`'s confirmation policies for the `node_repl` / `cua_repl` servers — so turning them off is hygiene, not the fix, and a standing tripwire on a future binary that starts gating a tool on one of them.

None of this is a WRITE. The per-thread `config` is deep-merged onto the user layer by `config/src/merge.rs` for this thread only; the file is untouched (the binary's own `[projects.…] trust_level` append aside) and `config/read` still shows the user's `enabled = true`, so the desktop app and the TUI are unaffected. `codex-desktop-entries.integration.test.ts` proves all of it against the pinned binary on a desktop-shaped home: the leak with the override bypassed, the suppression on start, resume and fork, and the file afterwards.

Register hosted dynamic tools only with explicit experimental initialization and a tested definition set. Reuse handlers rather than cloning mermaid/mockup/file/dispatch behavior. Add a Codex engine tool map alongside the existing renderer maps and feed neutral `ToolView` kinds. Native MCP remains native; dynamic-tool support alone does not prove the full hosted-MCP control contract.

Cold definitions persist, and resume has no dynamic-tool override. Before dispatch, prove definition replacement behavior, fork inheritance, namespace handling, and removal of recursive dispatch from target threads. If scrubbing cannot be enforced, refuse that target/resume/fork path instead of claiming an empty resume tool list fixes it.

`cross-engine-dispatcher.ts` has bespoke opencode, Claude, and pi targets. Add a separate Codex target factory using reusable transport/mapping pieces, not a fake `ISession` target. Both directions require caller-bound one-shot identity, target/model allowlists, explicit restriction-preserving policy envelopes, child approval forwarding, real child cancellation, and late-result suppression. Do not reuse the legacy Auto-to-bypass or plan-to-ask target mapping on Codex paths.

Usage attaches to effective engine/model/account and owning turn. Tokens and native rate limits are facts; USD may be absent or estimated. Keep estimates labeled and avoid parent/child/dispatch double counting. Hard USD caps cannot follow from unknown prices. Decide supported token/time caps before enabling budget-constrained dispatch, including failed turns and cancellation overshoot.

## Auth and service gates

> **Direction changed by [ADR-068](../adr/adr-068_chatgpt-identity-vault-owned-codex-injection.md) (2026-09-13):** the vault owns the ChatGPT identity and feeds every Codex process by `chatgptAuthTokens` injection after `initialize`, answering `account/chatgptAuthTokens/refresh` from the vault. The paragraphs below describe the phase-1 native-owned build that this replaces; they are updated slice by slice as ADR-068 lands.
>
> **As built (Slice 2a, 2026-09-13).** `codex-auth-hook.ts` is the one factory: `CodexClient.start(params, hook)` handshakes, calls `hook.inject()` (the vault's active account via `CredentialSync.injectionTokenFor`, the only token-bearing method in that module), sends `account/login/start {type:'chatgptAuthTokens'}` and resolves only after the login response; a refusal is a `CodexInjectionError` with the native message and the process is disposed. `CodexSession`, `CodexService` (and so model discovery and `CodexAuthProvider`) and the dispatch target all take the hook from their composition roots; without one they inject nothing. Each registers the server request `account/chatgptAuthTokens/refresh`, answered from the vault's cached credential (network only when expired), preferring the vault account whose workspace matches `previousAccountId`, then the injected account, then active; when nothing can answer, the session emits `session:auth-required` plus one `session:error`. `SessionStatus.account.accountId` is the vault account id. The device-code product UI and its three channels are gone; `codex:auth-status` remains the availability and model-count query. Proven against the pinned binary on Windows x64 by `codex-injection.integration.test.ts`.
>
> **Amended by [ADR-069](../adr/adr-069_codex-host-per-home-and-account.md) H2 (2026-09-15):** a process is shared, so a pin can no longer re-point it — re-pointing would move every other session on that host too. `setAccount` therefore moves the THREAD: interrupt, detach (which vacates the old host, closing it when nobody else is using it, because its writer lock would otherwise refuse the resume), acquire the target account's host, `thread/resume` there, re-claim. A pin to an account that resolves to the host the session is already on is a no-op beyond the overrides row. A refusal puts the session back on the host it came from and propagates the native message — never a silent substitution. `CodexService.rateLimits` is likewise one host per account with NO re-injection.
>
> **As built (Slice 2b, 2026-09-14).** A session may PIN one vault account (`codex_session_overrides.settings_json.accountId`; `null` = follow active). `session:set-account` (engine-neutral, `session-config`, refused where `capabilities.auth.perSessionAccount` is false) validates the id against the vault, persists it, and re-injects the live process between turns (`CodexClient.injectAccount`), or starts the process when nothing has spawned yet; a pin taken mid-turn applies at the next turn boundary before `turn/start`. Resume and fork inherit the pin; a removed pinned account falls back to active with one `session:error` and the pin cleared. `SessionStatus.codex.pinnedAccountId` drives the input-bar `AccountPicker` and the mobile sheet's account page, shown only when the engine has the capability, the ChatGPT provider's Per-session accounts toggle is on, and two or more accounts exist. Rate limits: `chatgpt-rate-limits.ts` keeps one map per vault account, fed by `CodexService.rateLimits(list)` (one process, sequential re-injection, read when the usage panel opens or refreshes) and by live sessions' `account/rateLimits/updated`; `usage:chatgpt-limits` is the query, `usage:chatgpt-limits-changed` the payload-free nudge; `resetsAt` is unix seconds. Business workspaces report credits rather than windows.

Native-owned authentication is selected: Codex owns login, credential storage, and refresh; ClaudeUI drives supported native flows and surfaces account metadata. Native browser/device-code/API-key behavior still needs integration testing. Experimental external-token injection and vault-to-Codex feeding are not phase-1 paths. A later opt-in native-Codex-to-vault adoption flow may share acquired tokens, but requires a single refresh owner and synchronization design before enabling other consumers. ADR-036's existing pi/opencode feeds remain unchanged.

Begin authorized account testing with read-only `account/read` without refresh. Use vault skill/tool secure injection for any later credential use; never expose tokens in logs, commands, IPC, or screenshots. No mass logout or native-store rewrite. Resolve concurrent refresh ownership before authenticated sessions and service clients run together. Remote login must not open a host browser unexpectedly; clients receive only non-secret account/login metadata. Account changes must reconcile model availability and usage attribution.

Catalog effort choices are native strings, not aliases into the current closed effort union. Explicit unavailable models error under ADR-059. Catalog/auth/history service lifecycle, title generation, automation, skills/slash features, and other product affordances need separate acceptance evidence. See the spec's phase-1 table rather than inferring completeness from this design.

# ADR-069: One Codex app-server host per home and account — sessions as threads, reads on the host

**Status:** Accepted (2026-09-15, design ruled by the owner); implementation tracked in `docs/codex-host-spec.md` — see § As built when slices land
**Supersedes:** [ADR-066](adr-066_codex-fourth-engine.md) §"Decision" process-model sentences ("One app-server child belongs to each root session and carries its native child threads" and "A separate, minimal service-client lifecycle may serve catalog, history, and auth operations"), and the 2026-09-13 ruling 11(c) recorded in `docs/codex-integration-handoff.md` ("keep one app-server per root session; at about 52 MB idle per process the shared-process redesign is not worth it")
**Amends:** [ADR-068](adr-068_chatgpt-identity-vault-owned-codex-injection.md) §1 (token injection is per HOST, one identity per process, unchanged in mechanism), [ADR-033](adr-033_cross-engine-dispatch.md) (a Codex dispatch target becomes a thread on the caller's host, not a process)
**Relates to:** ADR-045 (a host's death is the opencode server's death: every session on it goes `disconnected`), ADR-047 (opencode recycles on account switch; Codex hosts now do the same), ADR-067 (policy stays per thread; nothing here changes the permission model), ADR-030 (capability honesty)

## Context

ClaudeUI runs Codex as one `codex app-server --listen stdio://` process per session, plus a fresh one-shot process for every read: catalog discovery, the sidebar's thread listing (every 30 seconds), the lineage scan, rate limits, the config page, the auth probe, deletes. The follow-ups F7–F9 (2026-09-15, `docs/codex-followups-spec.md`) put a label and a stderr capture on every spawn and showed what that costs: a session's app-server dying with `failed to initialize sqlite state runtime` because it started while a one-shot sibling was being torn down; the boot-time lineage scan dying the same way on a fresh home; a `taskkill /F` on Windows that never lets Codex close its sqlite files; and a standing process spawn every 30 seconds for as long as the app is open. F8 serialised the first spawn per home and removed the boot deaths; the class remained, because the model was wrong.

Reading the app-server at the pinned tag (`.cache/codex-src`, `rust-v0.154.0`) settled the direction:

- The server has three transports; stdio is the explicit `single_client_mode` special case of a multi-connection server with a connection registry (`Opened` / `Closed` / `DisconnectAll`), a graceful restart that waits for the running assistant turns across the process, a unix-socket daemon mode and a websocket mode with its own auth policy (`app-server/src/lib.rs`).
- **The daemon transport takes a per-home startup lock before it initialises the sqlite state runtime** (`acquire_app_server_startup_lock(codex_home)`). The server assumes it is the one process on that home; our failures were that assumption violated.
- Threads are home-scoped, not process-scoped: `thread/list` returns every thread under the home and `thread/resume` reopens any of them in whichever process asks. Per-thread config, approval policy, sandbox, MCP overrides and dynamic tools ride `thread/start`; approvals and notifications carry the thread id; `turn/interrupt` is per thread.
- ClaudeUI already runs several threads in one process: a root's native children are threads on the root's connection, routed by thread id (ADR-066 slice F).
- The one process-level state is identity: `account/login/start { chatgptAuthTokens }` binds the whole process to one ChatGPT account, and "external auth is active" refuses a second login (ADR-068). So the unit of sharing is a process per home **and account**.

The 2026-09-13 ruling weighed 52 MB of idle memory per session against the redesign and closed it. That figure is what the host model saves, not what it costs.

## Decision

1. **A `CodexHost` per (Codex home, injected account).** Keyed by the normalised home path (`codex-home.ts`) and the vault account id it is injected with (`native` when the vault holds none and Codex's own login is used). Started lazily by the first session or read that needs it; owns exactly one `CodexAppServerClient`; injects its account right after `initialize` (ADR-068, unchanged); the F8 first-run gate applies to host starts. A host with no session on it is reaped after an idle period (reads only keep it warm, not alive); a host with a session lives as long as the session.
2. **Sessions are threads on their host.** `CodexSession` stops owning a client. It holds a per-thread connection the host hands out: `request()`, notifications and server requests for its `threadId` (and for the child threads it registers), and `abortServerRequests(threadId, turnId)`. The host demultiplexes on `threadId`; a notification for a thread nobody owns is dropped, as a foreign child's is today. The "process generation" that scopes pending approvals and one-shot hosted calls becomes the host generation, bumped on every host start, so a resumed thread on a new host never accepts an answer minted for the old one. Session `dispose()` interrupts its turn if one is running and unregisters the thread; the process stays.
3. **Reads run on the host.** `CodexService` becomes a facade that asks the host of the relevant account: catalog, `thread/list`, `thread/read`, lineage, rate limits, config read and write, the auth probe, delete. No one-shot processes remain. The 30-second directory poll becomes one request on a warm process, and the catalog memo (F10) stays in front of it.
4. **Account switch recycles the active host.** Sessions that follow the active account live on the active host. `provider-account:switch` closes that host gracefully; every session on it goes `disconnected` (ADR-045) and continues on the next prompt through `thread/resume` on the new account's host, exactly as Claude Code sessions continue after an interrupted process. A session pinned to another account lives on that account's host and is untouched. Re-pinning a live session moves its thread: interrupt, unregister, resume on the target host.
5. **Host death is the opencode server's death.** Every session on the host goes `disconnected` with the one F7 warn line naming the host; reads in flight fail once and the next read starts a fresh host. Nothing retries a dead process on the caller's behalf.
6. **Graceful close everywhere.** A host closes by ending stdin (the server exits on `stdio_connection_closed` on every platform), waits up to `killGraceMs` for exit, then kills the process tree. App quit disposes every host this way, bounded.
7. **Dispatch targets are threads on the caller's host** (caller's pin, else the active account), so a Codex-to-Codex dispatch is a `thread/start` on the same process rather than a refused spawn; the same-engine guard of ADR-033 is lifted for Codex by this decision and stays for the other engines.
8. **Correct by construction after the move:** `account/rateLimits/updated` (no `threadId`) belongs to the host's account; `account/chatgptAuthTokens/refresh` is answered by the host's hook; `session:auth-required` reaches every session on the host.

## Consequences

- Memory: one process per home and account in use, instead of one per session plus transient ones. Session start becomes a `thread/start` on a warm process (tens of milliseconds) instead of a spawn, version probe and `initialize` (about a second).
- Blast radius: a host crash takes every session on that account down, the way an opencode server crash does today. Threads survive on disk; resume is the recovery.
- The writer-lock rule for delete (`delete.ts`: a thread is deletable only when no process holds it) changes shape: the holder is now the host, and stopping a session no longer exits a process. Probe P3 decides whether an idle thread releases its lock in a live host or delete must wait for host recycle.
- Cross-process races are out of scope: a desktop app and a `claudeui-server` on the same never-initialised home still race (F8's note stands).
- Tests that pin one-process-per-session semantics (`codex-session.test.ts` dispose-kills assertions, `codex-service.test.ts` one-client-per-read, `codex-lifecycle` stop-holder waits, `codex-delete.test.ts` stop-then-delete, `codex-dispatch-target`) are rewritten against the host contract, not deleted.
- Docs: ADR-066's process-model sentences, `docs/architecture/codex.md` ownership table and transport section, `docs/protocol-codex/README.md` "M1b service and ownership", `docs/codex-integration-spec.md` §M1/M2 process notes.

## Probes before code (real binary, fixture provider, no real account)

- **P1** Three threads on one stdio connection, concurrent `turn/start`, each with a scripted approval: every notification and approval request carries the right `threadId`; nothing crosses threads; the transport's queue limits hold under three streaming turns.
- **P2** `thread/resume` on a fresh host of a thread whose previous host was force-killed mid-turn: the thread reopens, the interrupted turn is absent or marked, the next turn runs.
- **P3** Writer lock: a thread started and left idle in a live host — is `thread/delete` from a second process refused (lock held for the process lifetime) or accepted (lock released when idle)? Is there a wire method that unloads a thread without exiting the process?
- **P4** Graceful close: ending stdin on a host with an idle thread and with a running turn — exit code, time to exit, and whether the sqlite files are closed cleanly (a following start on the same home must not fail its state-runtime init).

## As built

_(filled per slice by the spec's Landed paragraphs)_

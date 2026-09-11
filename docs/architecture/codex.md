# Codex engine: foundation and planned architecture

**M1 foundations independently tested; M2 runtime/commands/UI and an M3 read/list baseline implemented for review.** Codex is registered and selectable only after native catalog discovery. The user accepted upstream native auth concurrency, and the main reviewer passed sanitized authenticated ChatGPT status; the old approval block is resolved. [ADR-066](../adr/adr-066_codex-fourth-engine.md) owns decisions; the [integration spec](../codex-integration-spec.md) records exact implemented scope and remaining mandatory gates. Queue, hosted tools, native children, verified fork/delete, complete metering and release hardening remain planned.

## M1a foundation

`src/core/codex/CodexAppServerClient.ts` owns one non-reusable JSONL connection.
It locates only vendored executables through the host app path, validates the
pinned executable version before initialize and then sends initialized. The
locator reserves extraResources/unpacked paths, but packaging is not wired.
Caller-provided environment replaces inheritance; omission inherits the native
runtime environment. Neither environment nor stderr nor raw protocol errors
are logged. The transport itself does not own account or login policy.

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
foundation; Windows/Linux runtime evidence is still required.

`scripts/ensure-codex.mjs` supports only verified macOS arm64 0.154.0 acquisition.
Its package commands are opt-in, with no build/postinstall/release hook. Generated
initialize types are exact CLI output; envelopes are derived from the pinned
CLI's JSON schema because its TypeScript generator omits them. M1b adds typed
method maps over this generic transport without claiming runtime payload-schema validation.
[Regeneration and tests](../protocol-codex/README.md) describe the local fixture
and remaining M1/M2/M5 gates. No UI or other engine behavior changed.

## Process and identity ownership

M1b now provides `CodexClient` typed methods and a separate `CodexService` with
coalesced account/catalog/config/history reads and retained native login flows.
These are host-only APIs behind registered core commands and the native auth
provider. Service reads never start or resume a root. Device login UI is
mock-tested; the authorized native status check passed independently. See the
[service contracts and evidence](../protocol-codex/README.md#m1b-service-and-ownership).
The table includes both implemented ownership and the remaining queue/child work.

| Owner                              | Planned responsibility                                                                                         |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `CodexSession extends BaseSession` | One root session's lifecycle, native effective config, queue handoff, approvals, children, and usage           |
| Root's app-server process          | Native root thread and its child threads, model context and native persistence                                 |
| RPC client                         | JSONL framing, handshake, request correlation, server requests, timeouts, generation invalidation, disconnect  |
| Pure mapper                        | Native items/deltas/results into neutral messages, tool results, task notifications, and usage facts           |
| Minimal service client             | Bounded catalog/history/auth reads and explicitly authorized auth actions; no second owner of an active thread |
| SyncCore                           | Canonical state, command authorization, replication, stream fanout, query routing                              |

New code belongs under `src/core/codex/`; host locators/spawn inputs follow `src/core/host.ts`. `register-engines.ts` and `SpawnPrepRegistry` are the existing construction seams. No Electron import enters core, and a null window is normal. Desktop preload and web clients use the same typed core contracts. Neither gets a Codex socket or a browser-facing app-server port.

Persist native `thread.id`, not a tree display/grouping `sessionId`. The root's pre-start routing ID may need the existing rekey path once native identity is known. Store explicit parent-child relationships and route every native event by its owning thread. Use thread/turn/item composite keys for transcript mapping; include process generation for pending RPCs and one-shot authorization. Equal item IDs in different turns or children must not collide. Reconnect never revives an old deferred response.

## Native policy state

`SessionStatus.codex` carries the effective native policy/sandbox/reviewer state, including unknown/granular values. `EngineSpawnOptions.codex` represents explicit overrides. Native settings and approval commands use the same core registrar on desktop and remote; the shared reducer retains the native status and pending choices through rekey/snapshots. The UI renders native acknowledgements, not a shared mode label.

The user selected preservation of their existing native policy. No approval/sandbox/reviewer override is sent by default. Explicit controls send generated `thread/settings/update` requests and display `thread/settings/updated` acknowledgements; only the human reviewer can be explicitly selected. Inherited automatic/granular state remains readable without reinterpretation. No `never`-as-Auto or sandbox-as-plan equivalence is permitted.

Accepted explicit requests are stored in `codex_session_overrides` (migration 15),
not as a copy of native config and not as model context. This closes the observed
loss of an unconsumed native settings update on process restart. The row is
independent of `session_meta`'s client projection and protects native-verified
identity from stale saves. An idle-only reset clears app policy/effort replay,
keeps model selection, and disconnects; it does not undo Codex-owned thread state.
Native deletion and cleanup of this row remain gated together.

Before first spawn, replicated `codexModelExplicit` keeps a catalog preview from
overriding a project's native configured model. The API omits an inherited model
request, then folds the native model response into the canonical selection.

Native command/file approvals and user questions retain their own request schemas. Bind responses to request/thread/turn identity, display advertised decisions, and handle resolution exactly once. Hosted dynamic callbacks have a separate host authorization boundary: validate the live session and call identity, deduplicate execution, and apply the configured hosted-tool/dispatch policy. A native invocation alone does not authorize dispatch. Existing remote read/act and capability restrictions apply to user-issued session commands and approval responses. Do not require an originating browser connection or its expiring grants for subsequent engine work; core must operate without clients.

## Four contract lanes

| SyncCore lane    | Codex use                                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Commands         | Create/resume, send/steer/recall/interrupt, explicit native policy changes, approvals and authorized login actions                                                 |
| Domain events    | Session identity/status/effective config, final transcript items, pending request lifecycle, queue state, task lifecycle and usage metadata                        |
| Volatile streams | Command-output tails. Text/reasoning currently use stable item-scoped message upserts so independent native items cannot concatenate in the single session stream. |
| Queries          | Native catalog/status, history/list/fork anchors, non-secret account metadata                                                                                      |

Extend the existing contracts in `src/core/shared/sync/`, `src/shared/types.ts`, and `src/shared/remote-protocol.ts`, not an engine-specific renderer side channel. Canonical and replica reducers must converge after reconnect, including pending approvals and non-recallable sends. Core continues operating with zero clients.

## Transcript and persistence

Native thread storage owns model context. A neutral history registry delegates read/list/delete/fork-anchor operations to each engine's implementation. Existing Claude, opencode, and pi readers remain intact behind that seam; all callers, including canonical resume seeding, must select an explicit engine. Unknown engine metadata produces a safe error rather than a Claude filesystem operation.

Use the same pure Codex mapping for live completion and history items. Preserve completed native IDs, text/reasoning, partial or full tool output, images, file-change diffs, and task notifications. Paginated read/resume worked in the small spike despite the guide; large-history paging/order/deduplication is still a release gate. Use bounded service reads without claiming a second active-thread owner.

The spike's interrupted dynamic invocation disappeared from immediate and cold native history. If needed for transcript fidelity, persist a narrow SQLite presentation supplement keyed by native thread/turn/call. Mark it interrupted or outcome-unknown, merge idempotently, and never replay it into model context or fabricate a native completion. Decide retention and delete/fork behavior with the history schema gate.

Fork anchors identify completed native turns. A message inside a turn must either resolve to an explicitly displayed supported boundary or be refused. Fork success creates a distinct thread and leaves the source untouched. Delete must define native deletion versus archive semantics and test descendants, pins, active ownership, and supplement cleanup before its UI is enabled. Legacy metadata import must recognize Codex going forward; already-clamped Claude rows cannot be automatically recovered from model names or guessed thread IDs.

## Queue and cancellation

Keep `BaseSession`'s queue of record. Hold recallable input until an observed boundary supports a steer, then send `expectedTurnId` plus `clientUserMessageId`. At idle, start a new turn through the ordinary send path. Do not forward through Codex's native next-turn queue.

Separate local recallability from RPC acceptance and from native user-item acknowledgment. Once a send may have reached Codex, do not offer a guaranteed recall or claim inference consumption. A matching thread/turn/client ID acknowledges the input; duplicate text does not. Timeouts require thread/turn reconciliation before retry or terminal failure. Shared queue type changes must preserve the three existing engines' semantics.

Every callback has an owning thread/turn and generation. Terminal state for that owner or transport death invalidates pending callbacks and approvals, aborts actual local/dispatched execution, and drops late results. Missing native `serverRequest/resolved` is expected for interrupted dynamic calls. A parent finishing does not imply child completion; a surviving child's own turn governs its work. Full root teardown cleans up all owned descendants and emits `disconnected` per ADR-045.

Core settles its pending maps and emits explicit per-request dismiss/task events.
Renderers never infer dismissal from `idle` or parent completion. This preserves
ADR-038 while compensating for Codex's missing dynamic-call resolution event.

## Tools and dispatch

Register hosted dynamic tools only with explicit experimental initialization and a tested definition set. Reuse handlers rather than cloning mermaid/mockup/file/dispatch behavior. Add a Codex engine tool map alongside the existing renderer maps and feed neutral `ToolView` kinds. Native MCP remains native; dynamic-tool support alone does not prove the full hosted-MCP control contract.

Cold definitions persist, and resume has no dynamic-tool override. Before dispatch, prove definition replacement behavior, fork inheritance, namespace handling, and removal of recursive dispatch from target threads. If scrubbing cannot be enforced, refuse that target/resume/fork path instead of claiming an empty resume tool list fixes it.

`cross-engine-dispatcher.ts` has bespoke opencode, Claude, and pi targets. Add a separate Codex target factory using reusable transport/mapping pieces, not a fake `ISession` target. Both directions require caller-bound one-shot identity, target/model allowlists, explicit restriction-preserving policy envelopes, child approval forwarding, real child cancellation, and late-result suppression. Do not reuse the legacy Auto-to-bypass or plan-to-ask target mapping on Codex paths.

Usage attaches to effective engine/model/account and owning turn. Tokens and native rate limits are facts; USD may be absent or estimated. Keep estimates labeled and avoid parent/child/dispatch double counting. Hard USD caps cannot follow from unknown prices. Decide supported token/time caps before enabling budget-constrained dispatch, including failed turns and cancellation overshoot.

## Auth and service gates

Native-owned authentication is selected: Codex owns login, credential storage, and refresh; ClaudeUI drives supported native flows and surfaces account metadata. Native browser/device-code/API-key behavior still needs integration testing. Experimental external-token injection and vault-to-Codex feeding are not phase-1 paths. A later opt-in native-Codex-to-vault adoption flow may share acquired tokens, but requires a single refresh owner and synchronization design before enabling other consumers. ADR-036's existing pi/opencode feeds remain unchanged.

Begin authorized account testing with read-only `account/read` without refresh. Use vault skill/tool secure injection for any later credential use; never expose tokens in logs, commands, IPC, or screenshots. No mass logout or native-store rewrite. Resolve concurrent refresh ownership before authenticated sessions and service clients run together. Remote login must not open a host browser unexpectedly; clients receive only non-secret account/login metadata. Account changes must reconcile model availability and usage attribution.

Catalog effort choices are native strings, not aliases into the current closed effort union. Explicit unavailable models error under ADR-059. Catalog/auth/history service lifecycle, title generation, automation, skills/slash features, and other product affordances need separate acceptance evidence. See the spec's phase-1 table rather than inferring completeness from this design.

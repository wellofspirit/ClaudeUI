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
and the remaining platform and release gates. M1a itself changed no UI or other
engine behavior.

## Process and identity ownership

M1b now provides `CodexClient` typed methods and a separate `CodexService` with
coalesced account/catalog/config/history reads and retained native login flows.
These are host-only APIs behind registered core commands and the native auth
provider. Service reads never start or resume a root. Device login UI is
mock-tested; the authorized native status check passed independently. See the
[service contracts and evidence](../protocol-codex/README.md#m1b-service-and-ownership).
The table marks the owners whose responsibilities are still planned.

| Owner                              | Responsibility                                                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CodexSession extends BaseSession` | One root session's lifecycle, model and effort selection, per-turn policy derivation and approval gating. Queue handoff, children and usage are planned |
| Root's app-server process          | Native root thread and its child threads, model context and native persistence                                                                          |
| RPC client                         | JSONL framing, handshake, request correlation, server requests, timeouts, generation invalidation, disconnect                                           |
| Pure mapper                        | Native items/deltas/results into neutral messages, tool results, task notifications, and usage facts                                                    |
| Minimal service client             | Bounded catalog/history/auth reads and explicitly authorized auth actions; no second owner of an active thread                                          |
| SyncCore                           | Canonical state, command authorization, replication, stream fanout, query routing                                                                       |

New code belongs under `src/core/codex/`; host locators/spawn inputs follow `src/core/host.ts`. `register-engines.ts` and `SpawnPrepRegistry` are the existing construction seams. No Electron import enters core, and a null window is normal. Desktop preload and web clients use the same typed core contracts. Neither gets a Codex socket or a browser-facing app-server port.

Persist native `thread.id`, not a tree display/grouping `sessionId`. The root's pre-start routing ID may need the existing rekey path once native identity is known. Store explicit parent-child relationships and route every native event by its owning thread. Use thread/turn/item composite keys for transcript mapping; include process generation for pending RPCs and one-shot authorization. Equal item IDs in different turns or children must not collide. Reconnect never revives an old deferred response.

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

| SyncCore lane    | Codex use                                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Commands         | Create/resume, send/interrupt, permission-mode and model/effort changes, approvals and authorized login actions. Steer and recall are planned                      |
| Domain events    | Session identity/status/effective config, final transcript items, pending request lifecycle, queue state, task lifecycle and usage metadata                        |
| Volatile streams | Command-output tails. Text/reasoning currently use stable item-scoped message upserts so independent native items cannot concatenate in the single session stream. |
| Queries          | Native catalog/status, history/list/fork anchors, non-secret account metadata                                                                                      |

Extend the existing contracts in `src/core/shared/sync/`, `src/shared/types.ts`, and `src/shared/remote-protocol.ts`, not an engine-specific renderer side channel. Canonical and replica reducers must converge after reconnect, including pending approvals and non-recallable sends. Core continues operating with zero clients.

## Transcript and persistence

Native thread storage owns model context. A neutral history registry delegates read/list/delete/fork-anchor operations to each engine's implementation. Existing Claude, opencode, and pi readers remain intact behind that seam; all callers, including canonical resume seeding, must select an explicit engine. Unknown engine metadata produces a safe error rather than a Claude filesystem operation.

Use the same pure Codex mapping for live completion and history items. Preserve completed native IDs, text/reasoning, partial or full tool output, images, file-change diffs, and task notifications. Paginated read/resume worked in the small spike despite the guide; large-history paging/order/deduplication is still a release gate. Use bounded service reads without claiming a second active-thread owner.

The spike's interrupted dynamic invocation disappeared from immediate and cold native history. If needed for transcript fidelity, persist a narrow SQLite presentation supplement keyed by native thread/turn/call. Mark it interrupted or outcome-unknown, merge idempotently, and never replay it into model context or fabricate a native completion. Decide retention and delete/fork behavior with the history schema gate.

Codex read and list are built; `engine-history.ts` refuses Codex delete and
fork-anchor outright, and `capabilities.fork` and `forkFromMessage` are false.
Fork anchors identify completed native turns. A message inside a turn must either resolve to an explicitly displayed supported boundary or be refused. Fork success creates a distinct thread and leaves the source untouched. Delete must define native deletion versus archive semantics and test descendants, pins, active ownership, and supplement cleanup before its UI is enabled. Legacy metadata import must recognize Codex going forward; already-clamped Claude rows cannot be automatically recovered from model names or guessed thread IDs.

## Queue and cancellation (planned)

`CodexSession.enqueuePrompt` throws, `capabilities.queue` and `capabilities.steer`
are false, and shared `SessionQueue` still correlates by text. The design below
is not built.

Keep `BaseSession`'s queue of record. Hold recallable input until an observed boundary supports a steer, then send `expectedTurnId` plus `clientUserMessageId`. At idle, start a new turn through the ordinary send path. Do not forward through Codex's native next-turn queue.

Separate local recallability from RPC acceptance and from native user-item acknowledgment. Once a send may have reached Codex, do not offer a guaranteed recall or claim inference consumption. A matching thread/turn/client ID acknowledges the input; duplicate text does not. Timeouts require thread/turn reconciliation before retry or terminal failure. Shared queue type changes must preserve the three existing engines' semantics.

Every callback has an owning thread/turn and generation. Terminal state for that owner or transport death invalidates pending callbacks and approvals, aborts actual local/dispatched execution, and drops late results. Missing native `serverRequest/resolved` is expected for interrupted dynamic calls. A parent finishing does not imply child completion; a surviving child's own turn governs its work. Full root teardown cleans up all owned descendants and emits `disconnected` per ADR-045.

Core settles its pending maps and emits explicit per-request dismiss/task events.
Renderers never infer dismissal from `idle` or parent completion. This preserves
ADR-038 while compensating for Codex's missing dynamic-call resolution event.

## Tools and dispatch

Built: `CodexEngineToolMap` feeds the existing renderer `ToolView` kinds.
Everything else in this section is planned, and `capabilities.hostedMcp`,
`subagents` and `crossEngineDispatch` are false.

Register hosted dynamic tools only with explicit experimental initialization and a tested definition set. Reuse handlers rather than cloning mermaid/mockup/file/dispatch behavior. Add a Codex engine tool map alongside the existing renderer maps and feed neutral `ToolView` kinds. Native MCP remains native; dynamic-tool support alone does not prove the full hosted-MCP control contract.

Cold definitions persist, and resume has no dynamic-tool override. Before dispatch, prove definition replacement behavior, fork inheritance, namespace handling, and removal of recursive dispatch from target threads. If scrubbing cannot be enforced, refuse that target/resume/fork path instead of claiming an empty resume tool list fixes it.

`cross-engine-dispatcher.ts` has bespoke opencode, Claude, and pi targets. Add a separate Codex target factory using reusable transport/mapping pieces, not a fake `ISession` target. Both directions require caller-bound one-shot identity, target/model allowlists, explicit restriction-preserving policy envelopes, child approval forwarding, real child cancellation, and late-result suppression. Do not reuse the legacy Auto-to-bypass or plan-to-ask target mapping on Codex paths.

Usage attaches to effective engine/model/account and owning turn. Tokens and native rate limits are facts; USD may be absent or estimated. Keep estimates labeled and avoid parent/child/dispatch double counting. Hard USD caps cannot follow from unknown prices. Decide supported token/time caps before enabling budget-constrained dispatch, including failed turns and cancellation overshoot.

## Auth and service gates

Native-owned authentication is selected: Codex owns login, credential storage, and refresh; ClaudeUI drives supported native flows and surfaces account metadata. Native browser/device-code/API-key behavior still needs integration testing. Experimental external-token injection and vault-to-Codex feeding are not phase-1 paths. A later opt-in native-Codex-to-vault adoption flow may share acquired tokens, but requires a single refresh owner and synchronization design before enabling other consumers. ADR-036's existing pi/opencode feeds remain unchanged.

Begin authorized account testing with read-only `account/read` without refresh. Use vault skill/tool secure injection for any later credential use; never expose tokens in logs, commands, IPC, or screenshots. No mass logout or native-store rewrite. Resolve concurrent refresh ownership before authenticated sessions and service clients run together. Remote login must not open a host browser unexpectedly; clients receive only non-secret account/login metadata. Account changes must reconcile model availability and usage attribution.

Catalog effort choices are native strings, not aliases into the current closed effort union. Explicit unavailable models error under ADR-059. Catalog/auth/history service lifecycle, title generation, automation, skills/slash features, and other product affordances need separate acceptance evidence. See the spec's phase-1 table rather than inferring completeness from this design.

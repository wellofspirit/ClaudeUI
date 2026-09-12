# ADR-066: Codex as a fourth engine

**Status:** Accepted integration direction, phase-1 scope, native-owned authentication including upstream concurrency behavior, and preservation of the user's native policy. M2 runtime/command/UI wiring and an M3 read/list baseline are implemented for independent review. Remaining M3-M5 work still blocks phase-1 release.
**Date:** 2026-09-10
**Supersedes:** [ADR-017](adr-017_codex-app-server-backend.md) as the current Codex design, and only ADR-019's dormant-Codex restriction.
**Amends:** [ADR-022](adr-022_opencode-permission-mapping.md) and [ADR-050](adr-050_auto-mode-as-the-default-autonomy.md) for Codex only.
**Amended by:** [ADR-067](adr-067_codex-shared-permission-model.md) (2026-09-11) replaces the section "Phase-1 permissions are native, not shared Auto": Codex now runs under ClaudeUI's shared permission modes and rules, and the ADR-022/ADR-050 carve-outs below no longer apply.

## Context

Codex is a distinct harness, not merely another OpenAI model route through opencode or pi. The user approved planning a fourth engine on `codex-integration`, with documentation before integration code. The shared `EngineId` and construction registry now include `codex`; selection requires actual installed-binary catalog discovery, never a seeded dummy model.

The [executable spike](../codex-spike.md) used official Codex 0.154.0 on macOS arm64, stdio app-server, and a custom localhost Responses mock. Independent review recorded 12 passing probes and one interrupted-dynamic-tool gap. It verified completed-tool identity through cold read/resume, completed-turn forks, same-turn steering, next-turn native queueing, and v1 child streaming. It did not test live authentication, real-provider behavior, v2 children, or other platforms. The pinned binary successfully read and resumed `paginated` threads despite contrary public-guide prose; large-history pagination remains untested.

## Decisions

### Native transport and session ownership

Use the official pinned binary, with 0.154.0 the integration candidate, over JSONL stdio. Verify release-asset digests per platform and retain license/provenance evidence. Generate checked-in protocol types from that binary, recording experimental dependencies explicitly. Do not revive ADR-017's old generated types or assume its permission mappings still apply.

Add an Electron-free `src/core/codex/` adapter implementing `ISession` through `BaseSession`, with a pure event mapper and a bidirectional RPC client. One app-server child belongs to each root session and carries its native child threads. **Built (`5452d3c5`, 2026-09-13):** the child threads a root spawns arrive on the root's own connection (the app-server attaches every initialized connection to every thread it creates) and render as subagent transcripts under the spawning call's card, on both native collab surfaces. A separate, minimal service-client lifecycle may serve catalog, history, and auth operations; it must not resume or become a second owner of an active thread.

Use native `thread.id` as the durable engine identity and engine-event routing key. Keep any temporary ClaudeUI routing ID/rekey lifecycle explicit. A session tree's `sessionId` is not a substitute for native thread identity. Scope items and requests by process generation, thread, turn, and native ID as appropriate.

The host-minted user-row ID travels as native `clientUserMessageId`. Native user items replace that row by explicit identity, not matching text, and retain their thread/turn/item IDs for cold history. Pending approval IDs additionally include a fresh root-process generation. Text/reasoning deltas currently use item-scoped message upserts because the existing single session stream would concatenate independent items; per-item volatile streaming/throttling remains a follow-up.

Desktop and headless hosts use the same core implementation with `win: null` supported. Browsers never connect to app-server and receive no new engine listener. Commands, domain events, volatile streams, and queries use the existing four SyncCore contract lanes.

### Phase-1 permissions are native, not shared Auto

> **Superseded by [ADR-067](adr-067_codex-shared-permission-model.md).** Kept as the record of the phase-1 decision; the as-built behaviour is the shared permission model.

Codex uses its native approval policy, sandbox, and reviewer fields. Shared permission-rule and classifier parity is explicitly deferred to a later Codex fork/patch. Claude, opencode, and pi keep their existing behavior.

Represent Codex configuration and effective state as engine-scoped typed data through spawn, core status, persistence, commands/events, reducers, and replicas. Do not cast native strings into the closed `PermissionMode` union, store them only in the renderer, or inherit global `full` to `auto` defaults. Display the effective native policy and advertised approval choices, not a false shared Auto or plan equivalent. Native `never` is not classifier-gated Auto and is not a bypass default.

The user chose preservation of their existing native policy. When no explicit native choice is supplied, omit approval, sandbox, and reviewer overrides. The earlier proposed `untrusted` / `workspace-write` / `user` default is not adopted. Display the actual native response, including inherited granular policy or `auto_review`, without silently converting it. Explicit reviewer controls remain human-only until automatic review has behavioral evidence.

M2's real resume test established that an acknowledged `thread/settings/update` can be lost across processes if no subsequent turn consumes it. Explicit accepted requests are therefore stored sparsely in `codex_session_overrides` (migration 15) and reapplied on resume. Inherited policy values are never copied into this store. Row presence also records native-verified identity, so stale client projections cannot erase/reclassify native metadata; pre-spawn UI-only entries remain mutable. Listing does not overwrite saved choices. The idle-only reset stops replaying app policy/effort overrides and keeps the model; it does not erase Codex-owned thread settings or rewrite native configuration/credentials. Native responses remain authoritative for effective state.

Native approvals do not govern every ClaudeUI-hosted dynamic callback. ClaudeUI owns authorization for those executions. Bind each call to the live process/session, deduplicate execution by call identity, apply a host-side tool allowlist and session policy, and fail closed on missing or stale context. Dispatch must never be silently auto-allowed merely because Codex invoked a tool. Remote capability checks remain on user-issued commands, including approval responses; ongoing engine work must not depend on a browser connection remaining present or armed.

### History and queue without a core rewrite

Add a minimal neutral registry for history read/list/delete/fork-anchor operations and route all consumers through it, including canonical seeding, Sidebar, preload, and web. Remove unknown-engine fallthroughs to Claude operations. Native Codex owns model context; SQLite may supplement interrupted-tool presentation because the spike could not recover that item from native history. Such records never fabricate model context or successful execution.

Fork only at verified completed-turn anchors, preserving the source. Do not offer a message-mid-turn fork as though Codex supports it. Test delete behavior for descendants, metadata, and pins before exposing it. The legacy DB importer clamps Codex to Claude; update recognition without guessing which already-clamped rows once belonged to Codex.

Retain ADR-053's application-held queue and forward at an observed supported boundary using `turn/steer` with `expectedTurnId` and `clientUserMessageId`. **Built as designed in `4050eb0a` (2026-09-12)**; one addition the build needed: boundary signals are chained on the session's own promise rather than fired blind, because a turn can end while its steer is still on the wire and `BaseSession.flushQueuedItems`'s re-entrancy guard would drop that signal and strand the item. Native queue acceptance is not inference consumption, and native queueing starts a different turn. Keep recallable, irrevocably sent, acknowledged, and ambiguous-delivery states honest. Correlate by identity, not duplicate text. Reconcile thread/turn state after a timeout; never blindly retry a possibly accepted send.

### Hosted tools, children, and dispatch

Dynamic tools require experimental capability. Reuse existing hosted handler implementations and neutral tool-kind views; keep native MCP separate. Preserve mixed rich results in live and cold transcripts, including images, file diffs, and notifications.

Track pending callbacks by their owning thread/turn and generation. Owning-turn termination or disconnect invalidates pending work, dismisses requests, cancels the actual dispatched child, and ignores late results. Parent turn completion must not cancel a still-running native child's independently owned work. Do not wait for `serverRequest/resolved` or item completion that the binary may never emit.

This is adapter-owned cancellation driven by an explicit native terminal event, not renderer inference from `idle`. Core must emit per-request `session:approval-dismiss` and task lifecycle events after settling its maps. ADR-038's replica contract and protection of independent child approvals remain unchanged.

Cold definitions persist. Redefinition, fork inheritance, and recursion scrubbing need explicit behavioral gates before dispatch is enabled. `thread/resume` has no dynamic-tools override; passing an empty tool list is not a removal strategy.

Cross-engine dispatch in both directions is the goal, but the existing dispatcher uses separate target clients, not `ISession` targets. Add a Codex target factory and explicit policy envelopes for Codex targets and Codex sources dispatching elsewhere. Propagate approvals and enforce restrictions; unsupported mappings fail closed. Do not extend the existing legacy Auto-to-bypass or plan-to-ask escalation to Codex paths. Unknown or estimated USD cannot enforce a hard billing cap. Decide supported time/token limits explicitly and account for cancellation overshoot and failed-turn spend.

### Authentication is native-owned

Codex owns login, credential storage, and refresh. The current product UI drives native device-code login on both desktop and remote clients. Browser/API-key service foundations are not additional exposed UI flows. No experimental external-token injection or shared-vault feed-in is used. Real device login remains a main-reviewer gate; it was not executed by the implementation agent.

The user explicitly chose **Accept upstream behavior** for phase 1. Native multi-process refresh races are accepted upstream behavior, not a claim of cross-process serialization or proven safety. Service/root processes may use native auth independently. Failures must be reported truthfully, with explicit retry/sign-in, and must never trigger automatic logout, credential deletion, or credential rewrites. The main reviewer ran the authorized sanitized status probe and confirmed authenticated ChatGPT; the prior tool-approval block is resolved.

The shared vault may later adopt tokens acquired through native Codex login, as a separate opt-in follow-up, not a prerequisite for integration. That direction is native Codex to vault, not vault to Codex. Before sharing a rotating refresh token with pi/opencode, define a single refresh owner and synchronization protocol; copying it into another independently refreshing store is not sufficient. ADR-036's existing feeds remain unchanged in phase 1.

Native auth uses native storage directly; it is not routed through shared-vault injection. User permission to test is not permission for mass logout or credential rewrites. Secrets stay on the host; clients receive allowlisted account/catalog/policy metadata and controlled login-flow URL/code data only. Neither desktop nor remote device login automatically opens a host browser. Real account/config/catalog reads are authorized under the accepted native behavior, but real-provider turns and sign-in still require main review. Full account-change attribution and rate-limit metering remain M4 gates.

### Capability and product honesty

Advertise a capability only after its complete path passes, per ADR-030. Resolve models and effort choices from the native catalog, including upstream strings such as `ultra` that the current closed effort list cannot represent. Preserve ADR-059's no-silent-model-fallback rule. Show token usage and rate limits when available; absent USD means unknown, not zero. Track title generation, automation, and service-client completeness explicitly rather than implying every product feature follows from a working chat turn.

`codexModelExplicit` distinguishes a picker choice from a catalog preview before first spawn and travels through canonical state/snapshots. An inherited selection omits the native model argument, allowing the working directory's effective native configuration to win. Native status then supplies the actual selection. No UI placeholder is sent as a native model alias.

## Delivery and consequences

The [integration spec](../codex-integration-spec.md) defines M0 through M5, mandatory release behavior, gates, and source seams. The [planned architecture](../architecture/codex.md) describes ownership and data flow. M0 delivers documents, not a running adapter. Each landed milestone must update its as-built status and verify shared-engine regressions. Runnable milestones follow ADR-026's gates and real-host verification; documentation-only work does not need an app launch.

This accepts native-policy differences to avoid pretending wire interception provides shared classifier parity. It adds a fourth process lifecycle and some shared type/history work, but does not authorize a SyncCore or dispatcher rewrite. Open gates are blockers for the relevant capabilities, not quiet feature cuts. No commit or push is authorized by this ADR.

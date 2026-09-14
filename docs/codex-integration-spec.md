# Codex integration kickoff

**State:** M1 foundations, the M2 native runtime and command/UI wiring, an M3 read/list baseline, and the slice-3 shared permission model are reviewed and committed on `codex-integration`. The user accepted upstream native multi-process auth behavior; the main reviewer passed the authorized sanitized authenticated ChatGPT status probe, resolving the prior approval block. Queue and steer, hosted tools, fork, delete and archive, interrupted presentation persistence, and M4-M5 remain incomplete. [ADR-066](adr/adr-066_codex-fourth-engine.md) records the accepted direction and open decisions, [ADR-067](adr/adr-067_codex-shared-permission-model.md) the permission model; [architecture](architecture/codex.md) separates implemented behavior from plans. This spec is not permission to install dependencies, mutate real credentials, push, or run real-provider turns without the user asking.

## Evidence and limits

Read [codex-spike.md](codex-spike.md) in full before implementation. `scripts/probe-codex.py` is an isolated experiment, not production infrastructure. Official 0.154.0 on macOS arm64 returned 12 passes and one dynamic cancellation gap against synthetic localhost Responses fixtures. No live auth was tested. Completed tool IDs/results survived cold read/resume; interrupted dynamic calls lacked resolution, completion, and reconstructed items. v1 child streaming passed, v2 ownership/control did not run. Steering stayed in the same turn; native queued input became a later turn. Small `paginated` histories read/resumed successfully despite public-guide claims to the contrary.

Pin 0.154.0 as the candidate and generate types from its executable with experimental schema dependencies recorded. Do not treat schema availability as a behavioral pass. Obtain platform-specific digests/license evidence before shipping each asset. The spike verified only one macOS arm64 asset, not Windows/Linux or every official distribution.

## Phase-1 contract

Phase 1 spans the staged rollout below, not just M1. MUST means required for phase-1 release, even if currently gated. A failed gate blocks that feature/release claim and requires a recorded scope decision; it is not implicit permission to drop the requirement. Capability flags stay false until complete end-to-end evidence exists.

| Area                                                                                              | Phase-1 expectation                                                                                                                                                                                                                                                                                                                  | Gate or explicit deferral                                                                                                     |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Binary, RPC, session identity                                                                     | MUST: pinned binary, generated types, stdio lifecycle, start/resume/interrupt/disconnect                                                                                                                                                                                                                                             | Per-platform provenance and process cleanup                                                                                   |
| Auth                                                                                              | MUST: Codex-native login/storage/refresh and truthful account status                                                                                                                                                                                                                                                                 | Native flow and concurrent-process tests; optional native-to-vault token adoption deferred                                    |
| Permissions and approvals                                                                         | MUST: the session's shared `PermissionMode` and the shared rules decide every gated command and file change, plus native questions. ~~typed policy/sandbox/reviewer state, command/file approvals, questions, no shared-default leakage~~ superseded by [ADR-067](adr/adr-067_codex-shared-permission-model.md), see "Slice 3" below | Real-app mode drive; per-mode `turn/start` parameters; `auto` guardian behaviour on a real account                            |
| Model catalog and effort                                                                          | MUST: native catalog, dynamic effort values, explicit-model errors                                                                                                                                                                                                                                                                   | Real account catalog; no closed-list coercion or silent fallback                                                              |
| Transcript and history                                                                            | MUST: live/cold rich results, list/resume, completed-turn fork, safe delete/pins/descendants                                                                                                                                                                                                                                         | Pagination, interrupted presentation supplement, native delete semantics                                                      |
| Application queue                                                                                 | MUST: boundary-held steer, identity ack, honest recall and ambiguous-send recovery                                                                                                                                                                                                                                                   | Shared queue races and restart/reconciliation tests                                                                           |
| Hosted tools                                                                                      | MUST: existing handler reuse and rich output; host authorization distinct from native approvals                                                                                                                                                                                                                                      | Experimental API, cold definitions, redefine/fork/namespace gates                                                             |
| Native subagents                                                                                  | MUST: visible child lifecycle/history/approvals/cancellation without ID collisions                                                                                                                                                                                                                                                   | v1 is fixture evidence only; v2 is gated, not required as an implementation choice                                            |
| Cross-engine dispatch                                                                             | MUST goal: Codex source and target with enforced restrictions and approval forwarding                                                                                                                                                                                                                                                | Definition scrub, policy envelopes, budget semantics; no legacy escalation reuse                                              |
| Metering                                                                                          | MUST: available tokens/rate limits and effective account/model attribution                                                                                                                                                                                                                                                           | USD optional and labeled unknown/estimate; no unsupported hard billing-cap promise                                            |
| Both hosts and clients                                                                            | MUST: Electron and headless core, desktop/web/mobile replication                                                                                                                                                                                                                                                                     | Null-window, reconnect, authorization and release-platform gates                                                              |
| Shared rules/classifier parity                                                                    | Rules and modes are built (ADR-067). ~~Deferred to a later Codex fork/patch~~                                                                                                                                                                                                                                                        | ClaudeUI's classifier and judge are deliberately NOT used for Codex `auto`; the native `auto_review` guardian reviews instead |
| Title generation and automation                                                                   | Track explicitly; gated follow-up unless separately accepted for phase 1                                                                                                                                                                                                                                                             | Truthful fallback titles; no automatic exposure through generic engine selectors                                              |
| Skills/slash commands, side questions, voice/realtime, background controls, native MCP management | Gated/deferred individually                                                                                                                                                                                                                                                                                                          | Inventory capability and unflagged method callers; native tool support does not imply product parity                          |

## Current source map

Paths below exist unless marked proposed. They are the starting seam map, not authority to change unrelated behavior.

| Paths                                                                                                                                            | Required integration work                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/core/codex/`                                                                                                                                | RPC/typed native service, registered M2 session/mapper/settings, and M3 read/list baseline. Hosted-tool adapter remains planned                                          |
| `package.json`, `scripts/`, `vendor/`                                                                                                            | M1a explicit opt-in pinned acquisition/type generation, macOS arm64 only. Packaging and automatic build hooks remain pending M2/M5                                       |
| `src/core/providers/ISession.ts`, `BaseSession.ts`, `EngineRegistry.ts`, `register-engines.ts`, `SpawnPrepRegistry.ts`                           | Add registration/spawn prep and typed native options without changing the neutral session lifecycle                                                                      |
| `src/core/providers/session-queue.ts`                                                                                                            | Existing text-correlated queue needs identity-aware Codex acknowledgment and explicit recallability/delivery handling                                                    |
| `src/shared/types.ts`, `engine-meta.ts`, `model-capabilities.ts`, `remote-protocol.ts`                                                           | Add engine descriptor, native typed policy state, dynamic effort/catalog representation, unknown/estimated usage semantics                                               |
| `src/core/ipc/create-session.ts`, `session.ipc.ts`, `remote-handlers.ts`, `handlers-core.ts`                                                     | Explicit native create/config/approval handling; canonical seed and all read/action paths must select the engine                                                         |
| `src/core/shared/sync/`, `src/core/sync/sync-core.ts`                                                                                            | Closed commands/events/state/reducers/streams and replica coverage, not a new transport                                                                                  |
| `src/core/services/session-history.ts`, `opencode-session-list.ts`, `pi-session-list.ts`, `session-delete.ts`, `fork-anchor.ts`                  | Proposed small neutral read/list/delete/anchor registry wrapping current readers; eliminate unknown-engine Claude fallthrough                                            |
| `src/core/services/session-watcher.ts`, `automation-manager.ts`, `session-manager.ts`                                                            | Audit secondary history and lifecycle consumers; keep unsupported features gated, not accidentally Claude-backed                                                         |
| `src/core/services/db.ts`                                                                                                                        | `importSessionEnginesOnce` currently clamps Codex/unknown IDs to Claude; recognize new metadata safely, narrowly store interrupted presentation if needed                |
| `src/core/services/cross-engine-dispatcher.ts`, `dispatch-model-hint.ts`                                                                         | Separate Codex target factory and explicit source/target policy envelope, allowlists, cancellation and usage                                                             |
| `src/core/opencode/opencode-hosted-tools.ts`, `src/shared/tool-kinds.ts`                                                                         | Reuse existing handler contracts/tool semantics; distinguish native MCP from dynamic callbacks                                                                           |
| `src/core/auth/EngineAuthProvider.ts`, `src/core/host.ts`                                                                                        | Native auth flow/status and host boundary; native login/refresh verification precedes release                                                                            |
| `src/renderer/src/components/Sidebar/Sidebar.tsx`, `src/renderer/src/stores/session-store.ts`                                                    | Engine discovery/history, native config UI, no inherited global `full` default, truthful unavailable features                                                            |
| `src/renderer/src/components/SettingsDialog/settings-pages.tsx`, `settings-sections.tsx`, `settings-target.ts`, `src/shared/permission-modes.ts` | Native approval settings within ADR-065's existing page/row model; explicit engine availability/default resolution instead of the current all-non-Claude Auto assumption |
| `src/renderer/src/components/chat/tool-registry/`                                                                                                | Proposed Codex map into existing `ToolView` kinds; media/diff/question/task rendering                                                                                    |
| `src/preload/index.ts`, `src/web/api-adapter.ts`                                                                                                 | Complete typed API parity for history, native config and approvals; no direct engine transport                                                                           |
| `src/main/`, `src/server/`, `src/integration/`                                                                                                   | Host composition, binary location/packaging, real-engine tests and release smoke coverage                                                                                |

Before adding a history registry, inventory every reader/list/delete/fork caller, including renderer event hooks and Sidebar actions. Canonical seeding currently calls the Claude JSONL reader directly; `resolveForkAnchor` special-cases pi then falls through to Claude, and delete has an `else` Claude path. Registry coverage must replace these defaults, not merely add a Codex-only endpoint. Missing legacy engine metadata may follow a documented legacy-Claude rule; an explicit unknown engine must fail safely. Never infer recovery of already-clamped rows from an OpenAI model name.

## Milestones

### M0: documents and remaining acceptance decisions

Deliver ADR/spec/planned architecture and scoped crossrefs. No running adapter, product edits, dependency work, or credentials. Main reviewer reads every changed line and independently checks references. Documentation checks are sufficient for this milestone.

Keep an acceptance ledger for native default/effective constraints, native auth flow/concurrency verification, delete semantics, interrupted supplement, dynamic-definition safety, child mode/control, dispatch policy/budgets, and platform evidence. Record selected outcomes before implementing their dependent behavior. Existing `docs/codex-spike.md` and `scripts/probe-codex.py` remain evidence, not targets for incidental cleanup.

### M1: binary, RPC, identity, auth prerequisite

M1a implements only the transport/build foundation. `ensure-codex` verifies the
0.154.0 archive, extracted payload and pinned-source Apache-2.0 license against
checked-in digests, stages installation, checks the executable version and
revalidates cached bytes. `update-codex` forces acquisition of the current pin;
it does not select a latest release. These are opt-in commands, absent from
postinstall, build and release pipelines. Only macOS arm64 provisioning has
executable evidence. Other platforms and packaging remain M2/M5 gates.

The generated initialize TypeScript dependency closure is copied exactly from
the installed CLI. This CLI does not emit JSON-RPC envelopes through
`generate-ts`; the small envelope set is derived from its
`generate-json-schema` output instead. Provenance records both commands, the
binary/schema hashes and generated file hashes. Check mode is read-only and
fails on drift. Generic RPC methods use unknown params and caller-selected
result types; typed thread/turn/account catalogs remain unfinished M1/M2 work.

`CodexAppServerClient` is Electron-free and one-shot. It checks `--version`
before initialize, awaits initialize before initialized, bounds frames and
outgoing work, distinguishes possibly delivered requests from expired unsent
requests, and never retries. It drains stderr without logging it and excludes
wire payloads from transport errors. Disconnect rejects pending RPCs and aborts
incoming handlers once, including explicit disposal. `serverRequest/resolved`
aborts matching handlers; `abortServerRequests(threadId, turnId)` lets the later
session adapter handle owning-turn termination where native resolution is
missing. It does not infer parent/child ownership or register hosted tools.

The gated production-client integration test passed on macOS arm64 with an
isolated HOME/CODEX_HOME, minimal replacement environment, outer sandbox and
localhost Responses fixture. It covers handshake, completed dynamic-tool turn,
interrupted dynamic call, disposal with an outstanding RPC, and bounded process
group cleanup. No login, auth mutation, real credentials or real-provider calls
ran. POSIX group TERM/KILL does not cover descendants escaping into new groups
or PTYs; Windows/Linux real-process cleanup remains unverified. Native auth,
identity/session ownership and typed method catalogs still block complete M1.

Reproduction and implementation limits: [protocol README](protocol-codex/README.md).

Independent M1a verification on 2026-09-10:

- Reviewed authored transport/tooling/tests and generated files; checked installed binary/license digests and regenerated protocol in read-only check mode.
- Demonstrated three transport guards failing before the fixes: trailing stdout after process exit, bounded inherited-pipe draining, and initialized-write failure incorrectly restoring ready state. All pass after the fixes. Added safe rollback-preservation and drain-state guards during review.
- Production-client isolated real-binary integration passed; no native credentials or real model requests were used.
- `bun run typecheck`, `bun run lint`, `bun run build`, and targeted formatting checks passed.
- `bun run test`: 618 files passed, 11,370 tests passed, six skipped.
- `bun run test:ci`: final rerun passed 620 files, 11,459 tests passed, six skipped. The first run failed with `EADDRINUSE` in an unchanged remote-server test; no test or product workaround was applied.
- No Electron interaction was exercised: this unregistered foundation has no UI caller. The real app-server integration is this infrastructure slice's runtime evidence, not certification of the later Electron/headless session integration.

Add pinned acquisition and schema/type generation, locator through host inputs, and a bounded bidirectional RPC client. Discriminate responses, notifications, and server requests; handle fragmented/multiple JSONL frames, stderr, unknown methods, request IDs, timeouts, backpressure, malformed input, process exit, and teardown without pending-promise leaks. Record experimental initialization and schema drift checks.

Define root/service ownership and native thread identity before session wiring. Service catalog/history reads must not resume active threads. Native-owned auth is selected: Codex owns login, credential storage and refresh. Start with read-only native status, then implement supported native login flows, secure credential handling and remote UX. Verify concurrent native processes do not race refresh or account changes. Do not use external-token injection or vault-to-Codex feeding. Optional adoption of native-acquired tokens into the shared vault is a separate follow-up requiring single-owner refresh/synchronization. No mass logout/rewrite or automatic credential sharing.

Guards: wrong binary/digest rejected, schema-version mismatch rejected, request response exactly once, stale generation ignored, process cleanup including descendants, no credential-bearing log/IPC output. Run isolated real-binary smoke in addition to transport mocks. Preserve existing engine startup/auth behavior.

M1b handoff on 2026-09-10: `CodexClient` wraps the existing transport with narrow
generated method maps; `CodexService` supplies coalesced read-only native account,
catalog/config/history calls and retained native browser/device/API-key login
flows. Root clients remain separate; service history never resumes threads.
The implementing agent reported authenticated ChatGPT metadata from the secure native status probe.
Native login flows are mock-tested, not live-tested. Pinned auth source shows an
instance refresh semaphore and reload-before-refresh, not established
cross-process serialization. Real authenticated app-server/model runs remain
gated for review. The main reviewer's independent `node scripts/codex-native-status.mjs`
invocation was denied by the tool approval layer, which requires specific user
confirmation of native credential-store status access. No alternate route or
retry was attempted. This is an execution-approval blocker, not evidence that
the user needs to log in again.
See [protocol M1b evidence](protocol-codex/README.md#m1b-service-and-ownership) for
contracts, exact generated inventory, source references and remaining limits.

Independent M1b checks passed: 69 focused unit tests, two isolated real-binary
integration tests, protocol regeneration/check, typecheck, lint and build.
The default suite passed 11,387 tests across 620 files; the CI-inclusive suite
passed 11,476 tests across 622 files, with six skipped in each suite. Authored
service/client/generator changes and tests were reviewed; generated payloads
were checked against the pinned CLI output. No real-provider inference,
interactive login, logout, explicit token refresh, or UI integration was tested.

### M2: session, native approvals, foundational UI

Implement `ISession`/`BaseSession`, registration/spawn prep, pure event mapping, explicit engine identity/rekey and catalog resolution. Carry engine-scoped requested/effective policy state through core and all replicas, not through casts into shared closed unions. Offer a minimal native settings/approval UI; never seed Codex from global `full` to `auto`. The user chose preservation of existing native policy: omit approval/sandbox/reviewer overrides unless explicitly requested. Display inherited native response values honestly, including granular policy and automatic reviewer values; explicit reviewer controls remain human-only until tested.

Guards: start/null-prompt/resume/model switch; explicit unavailable model errors; effort values outside the old list; native accept/deny/file change/user-question paths; duplicate/stale approval replies; policy change rejected by requirements; native choices preserved; interrupt/disconnect clears activity. Prove no Auto/bypass or plan equivalence leaks into defaults, commands, state or UI. Render text/reasoning and native command/file tools on desktop/mobile with structural DOM assertions.

#### Historical first-session handoff

The following records the initial unregistered slice. The continuation below supersedes its wiring/capability status.

Implemented for review:

- `CodexSession` extends `BaseSession` with one production `CodexClient`, serialized null-prompt startup, native root identity status, start/resume RPCs, single active turn, next-turn model/effort requests, interrupt/disposal, root-only event ownership, and explicit rejection of application queue, shared permission modes, attachments, and fork.
- Pure item/delta mapping covers text/reasoning, command live output/final result, file diffs, and user items for later history reuse. Live user echoes are suppressed because the caller paints the prompt. Composite IDs include thread, turn, and item. Terminal authoritative items can replace earlier completions.
- Native approval choices are retained in `PendingApproval.codex`; core rejects unoffered and stale replies. Transport abort and owning-turn termination explicitly dismiss pending cards. Missing command decision metadata permits only decline/cancel; amendment choices are labeled unsupported. File approvals support accept/decline/cancel, not speculative session grants. Questions map answers by native question ID; secret questions fail closed. Deny feedback is not invented. Dynamic tools and permission-grant requests are unregistered and receive method-not-found.
- `EngineId`, metadata, native effort representation, tool map, provisional terminal mark, macOS-arm64 installation query, and DB Codex recognition are added. Unknown/Codex delete and unsupported fork fail rather than accessing Claude files. Codex dispatch source/availability is disabled; the existing target allowlist already rejects it. No shared-vault provider route is added.
- Native effective policy survives status rekey/snapshot restoration. A read-only policy pill renders on desktop/mobile; shared Shift+Tab/mobile mode selection is suppressed and legacy bootstrap stays `default` for Codex.

Deliberately not registered or discoverable in engine pickers yet. All advanced
capability flags, including `interactiveApprovals` and `canDriveLogin`, remain
false until the reachable UI and command paths pass. Remaining M2 work is not a
scope waiver: construction/spawn registration, actual native model discovery in
engine selection, auth provider/settings composition, native policy mutation
and approval IPC commands with schema/remote authorization, native effort UI,
complete history-route/automation audit, token status, and full birth/resync
command-path tests. Resume RPC support does not claim cold transcript hydration.
Changing model/effort stores next-turn requests; effective settings updates
still need the native settings request/notification contract. Native child
work is not adopted or displayed in this slice.

The new `CodexSession` ran against the production transport in the existing
macOS outer sandbox with replacement HOME/CODEX_HOME/env and a localhost
Responses WebSocket fixture. The fixture uses the built-in OpenAI provider's
`openai_base_url` and a deliberately invalid synthetic API-key string in its
isolated auth file, never real credentials. The pinned CLI rejects overriding
`model_providers.openai`; custom-provider SSE evidence alone does not exercise
the native OpenAI WebSocket path. This passes a root text turn and bounded
disposal, not live account use, native approvals, UI, or full process-tree
containment. Main owns independent diff review and full gates.

Implementer checks for this handoff: `bun run typecheck` passed; targeted ESLint
over authored product files passed; 24 targeted unit/component files passed
450 tests; the Codex integration file passed all three isolated tests. These
are not the full default/CI/build/Electron gates. No actual user native status,
login/logout, refresh, config read, or real-provider model invocation ran here.

#### M2 continuation and M3 baseline, for review

The user accepted upstream native refresh concurrency for phase 1. No custom
refresh lock, automatic logout, vault feed, or credential rewrite was added.
Native errors remain errors or unknown status; installation failure is distinct
from an account-read failure so explicit sign-in remains reachable.

Implemented:

- Codex factory/spawn preparation, native auth provider, catalog discovery and selection on actual discovered models. No installed binary means no model group. Dynamic native effort choices are separate from Claude's closed effort list. Explicit model failures do not select aliases or other engines.
- One native command registrar serves desktop and remote: native approval replies require `chat`; auth status/device-flow operations require `config`. Core checks the live engine and validates pending offered decisions. ~~`session:codex-settings` requires `session-config`~~ removed in slice 3c: model and effort travel over the engine-neutral `session:set-model` and `session:set-effort` commands, and the `reset` action is gone with it.
- **Superseded by Slice 3 below.** ~~The native policy pill can initialize without a prompt, displays effective unknown/granular policy unchanged, and exposes explicit policy/sandbox/human-reviewer/effort controls. Updates use generated `thread/settings/update`; `thread/settings/updated` supplies effective replicated state. Shared mode and reasoning-default paths do not govern Codex.~~
- Migration 15 stores sparse accepted native requests in `codex_session_overrides`, separate from client-projected metadata lifetime. **Slice 3 narrowed the row to model and effort; the policy keys below no longer apply.** Real testing found unconsumed updates did not survive a new native process; the adapter now reapplies accepted choices on resume. Listing preserves app model choices and verified native identity cannot be pruned/reclassified by a stale client map. Rejected requests are not saved. ~~An explicit idle-only reset clears app policy/effort replay, preserves model choice, and disconnects; it does not reset settings Codex has retained itself.~~ The reset action was removed in slice 3c. Actual native deletion must eventually remove this row too.
- `codexModelExplicit` is replicated selection-origin metadata. Catalog previews do not override the native working-directory model/default, and no Claude/default aliases are passed. An explicit selection or existing thread model is preserved. Native status supplies the resulting model to every replica.
- Device-code Settings UI starts only on a user action, returns a validated HTTPS URL/code, polls metadata, supports cancellation, and refreshes discovered models on completion. It does not open a host browser. Real sign-in remains untested.
- **Partly superseded by Slice 3 below:** command and file approvals now render as the standard card, and `acceptForSession`/amendment choices are never offered. ~~Native command/file approvals, offered session/decline/cancel choices, disabled amendment explanations,~~ and typed user questions are reachable in inline/floating cards. Secret questions are declined without accepting or storing secret answers. Permission-profile requests return an empty grant and a visible unsupported explanation. Pending grants are independent of replicated choice arrays and include process-generation identity.
- Stop during pending `turn/start` records intent and interrupts when either native start notification or response supplies the owning turn. Late/duplicate replies remain invalid. Item-scoped delta upserts prevent text from independent items being concatenated; final command results replace, rather than duplicate, prior results.
- Core-created user IDs travel to native `clientUserMessageId`; native acknowledgements replace the host row by identity. This is tested through real core birth/rekey/commands/snapshot restore with a mock engine and no window, not just through renderer optimism.
- Native inline image inputs and corresponding native image history items are mapped. Live available tokens populate metering/status data. USD is not reported: equivalent cost is null and native cost UI is hidden rather than displaying a zero bill.
- `engine-history.ts` provides explicit engine read/list/delete/fork adapters. Generic IPC reads, canonical seeding and inactive-session reads route through persisted engine identity. Native directory listing feeds the shared canonical sidebar. Native reads use a separate read-only service, never resume an active thread, and use full turn pages for paginated histories. New Codex roots select native paginated history. Read failures are visible rather than substituting an empty transcript.
- Codex deletion/fork remain explicit refusals. Delete guards run before cancellation/removal, including mixed projects, and native delete controls are hidden. Native titles use app metadata rather than Claude JSONL; shared file watching and automatic title generation are unavailable for Codex.

The isolated production `CodexSession` tests now include a native command
approval, an actual benign write confined to the fixture directory, explicit
dismissal, policy-setting RPC, cold history identity/result equality, and native
listing. Native OpenAI sends a `generate:false` WebSocket warmup before a real
turn; the fixture distinguishes it from generation. Tests do not use real
credentials or real-provider inference.

The exploratory separate-service read of a newly initialized zero-turn root
still failed with the pinned native runtime, including paginated mode. The
adapter propagates that refusal; it does not invent an empty transcript or
replace the root. The initializer UI warns about this. Empty-root
materialization/cold reopen remains a mandatory M3 gate, distinct from the
passing completed-turn cold read/list checks.

~~The new-process policy-resume assertion initially failed (`untrusted` became
`on-request`); it passes with the real in-memory SQLite repository plus replay of
accepted overrides.~~ Superseded by Slice 3: policy is no longer persisted or
replayed, so the per-turn derivation makes that assertion moot. Reset
verification asserts omission of app fields and equality with the native
response, not an invented return to global defaults: Codex may retain its own
per-thread state after app replay is cleared.

Latest implementer gates: full typecheck and lint passed; 83 focused
unit/component files passed 1,807 tests; all four isolated native integration
tests passed. Protocol generation/check matched the pinned binary. These are not
the default/CI/build/real-Electron release gates, which remain with main.

#### Slice 3 (2026-09-11): shared permission model

[ADR-067](adr/adr-067_codex-shared-permission-model.md) replaced the native
policy surface described above. Codex executes; ClaudeUI decides.

Removed: the native policy pill, `CodexPolicyOptions` and the `codex` field of
`EngineSpawnOptions`, the policy keys in `codex_session_overrides` (rows that
still carry them load leniently and replay only model and effort), the native
policy fields of `SessionStatus.codex`, and every renderer carve-out that hid the
mode tab, the mode picker and the Shift+Tab cycle for Codex.
Native reasoning effort moved into the standard effort picker, and model and
effort now travel over the engine-neutral `session:set-model` and
`session:set-effort` commands.

In its place, `CodexSession` derives `approvalPolicy`, `sandboxPolicy` and
`approvalsReviewer` from the session's shared `PermissionMode` and sends them on
every `turn/start`, with the same values as the `thread/start` and
`thread/resume` baseline. A mode change applies from the next turn. Every
approval request the server sends is answered by the engine-neutral evaluator pi
already uses (`src/core/pi/permission-engine.ts`) against the same merged
`~/.claude` rules. Commands gate as `bash` on the command string; file changes
gate per file from the transcript item, `add` as a write and every other change
type as an edit, any-deny denies and any-ask asks. Deny answers `decline` plus a
`session:error` naming the rule or the plan reason, because no native reply
carries a reason. Ask raises the standard `PendingApproval` with always-allow
suggestions in the Claude rule vocabulary. `acceptForSession` and
`acceptWithExecpolicyAmendment` are never sent. `auto` maps to `on-request` plus
`auto_review`, so Codex's own guardian reviews escalations and whatever still
reaches the client is gated like `default`; ClaudeUI's classifier and judge are
not used for Codex. ADR-067 holds the mode table and the reasoning.

Evidence: the repo-resident probe in
`src/integration/codex/codex-policy-probe.integration.test.ts`, with findings in
[codex-spike.md](codex-spike.md) section "Native approval surface probe", plus
the Codex source at tag `rust-v0.154.0` checked out under `.cache/codex-src/`
and not vendored.

Gates met: guard tests in `src/core/codex/__tests__/codex-session.test.ts` cover
the per-mode `turn/start` parameters, plan declines, rule-sourced verdicts,
acceptEdits workspace narrowing, the standard card shape, `allowForSession` and
legacy override rows; two real-binary integration cases cover plan declining a
write with no file left behind, and default asking, the human allowing, and the
file existing. A real-account Auto turn with an outside-workspace write rendered the guardian's decision row in the app on 2026-09-12 (approved, low risk); the human override of a denial landed in `68bcf6e3` and is proven against the real binary with a scripted deny verdict. Still open:
sandbox containment, which the integration fixture cannot measure because macOS
refuses to nest a second seatbelt profile.

#### Mandatory remaining work

None of this is deferred by implication.

- **Application queue and steer.** Landed in `4050eb0a` (2026-09-12): core-held queue, `turn/steer` with `expectedTurnId` at completed sub-turn items, `turn/start` at idle, identity acknowledgment via `clientUserMessageId: steer-<itemId>` and `SessionQueue.consumeById`, honest recall, ambiguous-timeout reconciliation against `thread/items/list` with no blind resend. Proven against the real binary (same-turn steer while paused on an approval) and on the real app.
- **Hosted tools.** Landed in `30421310` (2026-09-12): render_mermaid, create_mockup and show_mockup declared as dynamic tools on `thread/start`, executed on the `item/tool/call` server request with one-shot `callId`s, the shared permission engine's verdict, abort on turn end and a dropped late result; specs persist in the rollout's SessionMeta so a resumed thread keeps them (confirmed live), hence `hostedMcp: true`. `dispatch_agent` from Codex stays M4; images in a dynamic-tool result are not rendered.
- **Completed-turn fork.** Landed in `5e92e52f` (2026-09-12): turn-granular anchor parsed from the codex message id, `thread/fork {threadId, lastTurnId, excludeTurns}` with `forkedFromId` verified and `parentThreadId` null, overrides copied, forks kept in the sidebar through a `session_meta` sweep with metadata-only `thread/read`, canonical seed truncated through the anchor turn. Follow-on: the sweep has no negative cache, so permanently deleted codex ids are re-probed on every refresh until delete/archive prunes `session_meta`.
- **Delete and archive.** Delete landed in `01f38172` (2026-09-13): a subtree walk, leaf-first, after a confirmation listing the branches, stopping non-destructively at the first refusal; archive stays unused (ClaudeUI's hidden sessions cover it). Native rule as pinned: The lifecycle probe (`src/integration/codex/codex-lifecycle.integration.test.ts`) pins the native rule: `thread/list` never lists forks, in either archived state; delete and archive are both refused while the owning root process holds the thread, and that refusal is inert (the live thread keeps accepting turns); stopping the holder is not sufficient, because a thread with a surviving descendant fork stays undeletable, listed and readable; archiving the descendant does not lift that, only deleting it does. A native delete of a forked thread is therefore a whole-subtree operation, leaf-first, and the UI must either walk the tree that way or fail non-destructively.
- **Interrupted-tool presentation supplement.** Decided 2026-09-13: live only. An interrupted dynamic-tool call is absent from native history (pinned); ClaudeUI synthesizes a failed result on the live card with cli.js's tombstone text (`6f69d427`). No persisted supplement.
- **Cross-engine dispatch.** Source side landed in `843b4ecf` (2026-09-12): `dispatch_agent` as a fourth dynamic tool, gated as kind `task` by the shared engine (asks in default/acceptEdits/auto, denied in plan) with the card bound to the call's id, the dispatcher's abort signal wired to the app-server request, stop on interrupt and disconnect, `crossEngineDispatch: true`. Target side landed in `749886cc` (2026-09-13): a headless thread per target with the caller's mode written into the thread baseline, no dynamic tools, allowlisted model, asks forwarded to the caller, stop via turn/interrupt, usage rows with equivalent cost, continuation only by ids this dispatcher created. A dispatched turn's cost rides `modelCosts`.
- **Native children.** Landed in `5452d3c5` (2026-09-13): child threads route into the shared subagent channels under the spawning call's card on both collab surfaces (v1 `collabAgentToolCall`, v2 `subAgentActivity`), held-then-bound because no `thread/started` is emitted for a spawned child, child approvals reach the human, parent interrupt cascades to running children, child usage is folded without double counting, cold history reads children back inline; `subagents: true`. Grandchildren are not rendered.
- **Metering.** Partly done (`76453c7f`, 2026-09-13): tokens reach status and an API-rate equivalent USD from published OpenAI prices rides metering, the status line and status (unpriced models stay null/zero); dispatched costs ride `modelCosts`. The cost contract is nullable since `ef83a639` (unknown, never $0, for an unpriced model). Still M4: child and dispatch attribution beyond that, and rate limits.
- **Platform packaging.** macOS arm64 acquisition now runs on `postinstall` and in every packaging target, and the binaries ship as `Resources/codex-cli` (`e5bf09b6`, verified by an unpacked build). Windows x64 digests landed on 2026-09-13: `scripts/codex-digests.json` became a per-host map and now pins the `codex-x86_64-pc-windows-msvc.exe` pair, so `postinstall`, `build:win` and the packaged app carry `codex.exe` and `codex-code-mode-host.exe`. Linux still lacks a digest manifest (the acquisition skips there and Codex is unavailable); its provisioning, paths and process trees are unverified. On Windows, acquisition, packaging, app-server spawn, account and catalog reads and the protocol check are verified; a signed-in turn, the Windows sandbox path and process-tree cleanup under load are not.
- **Real-account and host gates.** Live device login, real-provider turns, real catalog and media, and the full default/CI/build/Electron/headless gates remain with main.

Item-scoped message upserts are correct but not yet a high-throughput per-item
volatile stream. The read/list baseline is not lossless coverage of every
`ThreadItem` variant: native MCP/web-search/image-generation/collaboration/dynamic-tool
outputs, compaction markers and full question/media/artifact reconstruction still
need their M3/M4 mappers and tests. No completed M3 or phase-1 release is
claimed.

### M3: history, queue, hosted tools

Implement the neutral history registry across all consumers and safe metadata migration. Native context stays native. Use a narrow presentation supplement if the interrupted-tool history requirement needs it. Read/list page and merge deterministically, preserve IDs/media/diffs/notifications, and fork only at completed-turn boundaries without changing the source. Define deletion versus archive behavior, descendants, active sessions, pins, supplement cleanup and failure atomicity before enabling delete.

Wire ADR-053 held input to an observed steer boundary with `expectedTurnId` and `clientUserMessageId`, and use normal new-turn submission at idle. Extend queue semantics minimally to distinguish held/recallable from irrevocable or ambiguous delivery. A successful steer is acceptance, not proof of model consumption. Reconcile by thread/turn/client ID after uncertain timeout; no blind retry.

Add experimental dynamic tools through existing handlers and neutral views. Authorize each callback against its live session, call identity, tool allowlist and hosted-tool policy; execute each identity at most once. Remote capabilities gate user commands/approval responses, not autonomous callbacks against an expired or absent browser connection. Test partial/full text/image/file outputs. Invalidate callbacks at owning-turn end or disconnect; abort actual execution and ignore late results even when native resolution/completion never arrives. Settle core maps and emit explicit per-request dismiss/task events per ADR-038; never clear renderer approvals merely on idle. Cold definitions persist; resume cannot override them with an empty list.

Guards: canonical/desktop/web history equality after cold resume and reconnect; repeated IDs across turns/children; large paging; completed and interrupted tools; source-preserving fork; safe delete/pins; explicit unknown-engine refusal; legacy metadata without guessed recovery. Test duplicate-text queued sends, recall/steer/interrupt races, wrong/no-active-turn rejection, accepted-but-timed-out send, disconnect/restart reconciliation, and no use of native next-turn queue. Gate tool redefine/namespace/fork-inheritance behavior before M4 dispatch.

### M4: subagents, dispatch, metering

Route native children through the root-owned process with explicit thread/turn ownership. v1 fixture success is not a v2 subscription/control guarantee. Prove child approval routing, nested trees, cancellation and cold reconstruction. Parent completion must not terminate independent child-owned work; root teardown must clean all descendants.

Add a separate dispatcher target factory, reusing transport/mapper code rather than assuming targets implement `ISession`. Both directions need target/model allowlists, recursion scrub, request identity, restriction-preserving policy envelopes, approval forwarding, timeout/disconnect handling and cancellation of the actual target. Existing dispatcher Auto-to-bypass and plan-to-ask mappings must not govern Codex source or target paths. Unsupported envelopes fail closed.

Meter tokens/rate limits under effective account/model identity, distinguish native children from cross-engine targets, and prevent double counting after rekey/resume. Unknown USD is not zero. Estimated USD cannot guarantee a hard cap; decide whether supported time/token caps suffice or budget-constrained dispatch must remain blocked. Cover failed-turn spend, cancellation lag and resumed dispatch accumulation.

Guards: dispatch in both directions, unauthorized/missing/stale identity denied, allowlist denial, read-only restrictions retained, no recursion after cold resume/fork, nested approvals visible and resolvable, parent-end/child-active separation, actual target stopped on owning-call cancellation, late results ignored, usage deduplication and honest unknown-cost display. Run real child cancellation and authenticated metering gates separately from mocks.

### M5: hosts and release hardening

Verify desktop and headless composition, null-window sessions, no-client execution, web/mobile reconnect convergence, remote action authorization and login origin behavior. Package only verified platform assets with digest/license evidence. Validate Windows/Linux process trees, paths and sandbox behavior independently; macOS mock evidence does not cover them. Exercise real account, media, file-change, questions and child cancellation, keeping live credentials out of artifacts.

Inventory title generation, automation, service catalog/history/auth lifecycle, settings/search, binary-unavailable UI, tool controls and remaining capabilities. Either demonstrate each advertised path or keep it explicitly gated with follow-up status. Update as-built docs only for landed behavior, milestone by milestone.

### M5-L: Linux x64 and arm64 as reviewed Codex hosts (kickoff 2026-09-14)

**Landed 2026-09-14** on `codex-integration` (the commit after `187f2c51`). Built as specified, reviewed line by line, gated on the host (typecheck, lint, full `bun run test` at 670 files, `check-codex-protocol`, prettier on every touched file), the nine new guard tests proven failing against a clean HEAD worktree, and both container legs rerun by the reviewer: x64 (Rosetta) with the shared suites 4/4 files and 15 tests green; arm64 from a wiped vendor volume, so acquisition ran from scratch (`Codex 0.154.0 installed and verified (Linux arm64)`), then `check-codex-protocol` and the same 15 tests; `build:web` + `build:server:compile` on arm64, the release job's stage layout, and the compiled server booting from it with the bubblewrap warning present when `bwrap` was off PATH (stderr and the log file) and absent when present. Deviations accepted from the implementer's report: `--init` on the container (tini reaps orphaned grandchildren; without it a zombie kept an app-server process group alive and one disposal check failed on a container artefact), the `--no-bwrap` evidence taken through `PATH` on the one image, and the release-notes bodies in both release workflows now naming Codex and the `bubblewrap` requirement. Reviewer changes: the server's executable predicate uses `statSync` rather than `lstatSync` so a distro that installs `bwrap` as a symlink is not warned at; the `codex-locate.ts` comment no longer claims the release ships no bwrap asset (it does; we chose not to pin it). Per-suite Linux outcome of the older eight, from the implementer's exploratory container-local run with their containment made conditional: `codex-app-server`, `codex-lifecycle`, `codex-delete`, `codex-dispatch-target`, `codex-interrupted-tool` pass on both arches; `codex-policy-probe`, `codex-rules-sync` and `codex-auto-review-probe` assert macOS specifics (`/bin/zsh -lc`, seatbelt nesting). None were switched; flipping the five is a separate decision. Real-account drive, same day (owner-authorized vault copy into the arm64 container, compiled server on the tarball layout, Playwright on Edge against the web client): the first attempt failed every fresh Codex session with `Codex reasoning effort is unavailable for the selected model`. A trace in a disposable source copy showed `effort: null`: the web client marshals `invoke` arguments as JSON, so an omitted optional argument reaches the remote `session:create` handler as `null`, which `CodexSession.validateEffort` does not treat as unset (Electron IPC preserves `undefined`, so the desktop never saw it). Fixed at the transport boundary in `remote-handlers.ts` (`opt()`, applied to `session:create` and the same-shape handlers; handlers where `null` means "clear" were deliberately left alone), guard proven failing on clean HEAD. With the fix, a fresh Luna session ran `ls` inside the sandbox under Auto and answered, and a default-mode turn raised the approval card and ran the approved write unsandboxed. Two observations for follow-up: `claudeui-server --disable-auth` leaves the web client at "Missing Token" because `/remote/auth-info` advertises no method and the client's entry decision has no route for an `off` policy without a password; and the same JSON-null class may be latent in the command modules shared by both transports (`configCommands`, `authCommands`, `codexCommands`, …), which were out of scope.

Worked under [ADR-026](adr/adr-026_development-workflow.md): the main model wrote this kickoff, an Opus implementing agent builds it, the main model reads every changed line, re-runs the gates, runs the container legs itself and commits. The Windows leg (`c5cb505d`) is the model for the shape of the change; read that commit first.

Standing rules for the implementing agent:

- No `git add`, `commit`, `stash`, `checkout`, `reset`, `branch`, `push`. No `bun install`/`add`/`remove` on the host checkout (inside the verification container it is required and fine). No `bun run format` over the repo; format only the files you created or changed, by path. Do not delete, revert or edit any file you did not create, and never touch the untracked `docs/headless-server.md` or `docs/manual.md`. Report the exact file list you touched.
- No real credentials. Never read `~/.codex/*` or `~/.claude/ui/auth-vault.json`. Every test uses temp directories and the scripted localhost provider the existing fixtures already use.
- Every behaviour change ships with a guard test you prove fails before the change and passes after; quote both runs.
- Report results and deviations; never self-certify.

**Goal.** `linux-x64` and `linux-arm64` join the reviewed host set: acquisition installs the pinned musl binaries, the runtime gate offers the engine, the headless server tarball ships them, CI caches them, the four ADR-068 real-binary suites run on Linux, and the one Linux-only runtime dependency (bubblewrap) is documented and warned about at server boot rather than shipped.

**Evidence already in hand (2026-09-14, Debian bookworm-slim in Docker on colima, arm64 native and x64 under Rosetta).** Both `codex` builds answer `codex-cli 0.154.0`. Every release archive below is a single-member ustar tar the existing extractor accepts. The Linux sandbox is bubblewrap: Codex prefers a system `bwrap` on PATH (`codex-rs/sandboxing/src/bwrap.rs::find_system_bwrap_in_path`, a `which`-style walk of PATH for an executable named `bwrap`), then a bundled one beside its executable, and with neither it panics `bubblewrap is unavailable` on the first sandboxed command (`linux-sandbox/src/launcher.rs`). Landlock survives only behind the hidden `--use-legacy-landlock` flag. With `bwrap` present a sandboxed command ran with the workspace read-only and `/etc` blocked. Docker's default seccomp profile blocks user namespaces, so the container needs `--security-opt seccomp=unconfined --security-opt apparmor=unconfined --cap-add SYS_ADMIN`; Ubuntu 24.04's AppArmor restriction on unprivileged user namespaces produces the same `No permissions to create a new namespace` failure on a stock desktop.

**Decisions (owner, 2026-09-14; do not reopen).** bwrap is a documented system dependency, not a manifest member; the server logs a warning at boot when it is missing. Both arches. The verification Dockerfile is committed under `scripts/`. CI caches `vendor/codex-cli`.

**Digests (computed from the `rust-v0.154.0` release assets; the agent re-downloads and must get the same values, or stop and report).**

```text
linux-x64
  codex                 member codex-x86_64-unknown-linux-musl
                        archive d7e18b2597ae8f242f5f31ee9e90deef48dbc9edd634d9868fb6435d08c07f02
                        binary  3188814c35471432d4123203e0eb38e5bddc60226e3d7ddf0e59e649ea140022  (262858016 bytes)
  codex-code-mode-host  member codex-code-mode-host-x86_64-unknown-linux-musl
                        archive a68df7cca23c6da7cde175677df7de61c73a234add1333a1254b86d641af01f7
                        binary  0c57be435e73b70d9106c850d751cd259a7f04da958a453d7ef59090d82b70f1  (69431360 bytes)
linux-arm64
  codex                 member codex-aarch64-unknown-linux-musl
                        archive 583b48df32804213bdcd338c2e5adb06b34340821fa757a726cc0a524fa33c27
                        binary  9b7c1c7abdc26fc3c4f47c77656a8e9121def5483dbae830ef1ee561758448a9  (227482840 bytes)
  codex-code-mode-host  member codex-code-mode-host-aarch64-unknown-linux-musl
                        archive 20aefa302c2022b496e32911bf954a5f76c7fd749c6bdb9fbd711e32b66dcbfa
                        binary  f31e1c5ffbbca7884aff2f0f8795d3da197f4aafb114033a399dfc17a5119031  (63381656 bytes)
```

**Design.**

1. _Manifest and gates._ `scripts/codex-digests.json#hosts` gains `linux-x64` and `linux-arm64`, two members each, install names `codex` and `codex-code-mode-host`. `HOST_LABELS` in `ensure-codex.mjs` gains `Linux x64` and `Linux arm64`. `CODEX_SUPPORTED_HOSTS` in `codex-locate.ts` gains both keys. The caps (`MAX_ARCHIVE` 128 MiB, `MAX_PAYLOAD` 512 MiB), `cacheValid` (exec bits required on POSIX), `isolatedEnv` (POSIX branch) and `verifyVersion` need no change; say so in the report after reading them. Update the unit tests in `codex-tooling.test.ts` (`INSTALL_NAMES`, `MEMBER_PATTERNS`, the host-key list, the unsupported-host assertions move to hosts that stay unsupported such as `linux-ia32`, `win32-arm64`, `darwin-x64`) and `codex-locate.test.ts`. Run `bun run generate-codex-protocol` so `provenance.json#codexBinaries` carries all four hosts (the generated types are byte-identical; only provenance changes), then `bun run check-codex-protocol` must pass. Update the wording in `register-engines.ts` (error text), `scripts/build.mjs` (comment), `docs/protocol-codex/README.md` (pins paragraph and the "macOS arm64 only" test note), `docs/architecture/codex.md` (hosts paragraph). `scripts/probe-codex.py` stays macOS-only; it is the spike, not acquisition.

2. _Bubblewrap check._ Add a pure function in `src/core/codex/codex-locate.ts`, `codexLinuxSandboxWarning(platform, env, isExecutableFile)` returning `null` on any platform but Linux, `null` when an executable `bwrap` exists in any `PATH` entry (split on `:`, skip empty entries, same lookup Codex performs), and otherwise one message: `Codex sandboxed commands need bubblewrap: no \`bwrap\` on PATH. Install the bubblewrap package (apt, dnf, apk or pacman) and restart; until then every Codex command that runs inside the sandbox fails, while commands you approve still run.` The server (`src/server/main.ts`, next to the "listening" line) calls it with `process.platform`, `process.env`and an`lstatSync`-based predicate, only when `codexBinaryAvailable()`is true, and logs the message through`logger.warn('server', …)`. Guard tests for the pure function: non-Linux returns null; Linux with `bwrap`in the second PATH entry returns null; Linux without it returns the message; a PATH entry that is a directory named`bwrap` does not count. The desktop main process does not call it (no Linux desktop build ships).

3. _Server tarball._ `.github/workflows/pre-release.yml` and `release.yml`: the "Assemble tarball" step copies `vendor/codex-cli` beside `opencode-cli` and `pi-cli`, and the job's comment block names Codex among the engines that ride along. `codex-locate.ts`'s non-asar branch resolves `<appPath>/vendor/codex-cli/codex`, and the server's `resolveAppPath` (`src/server/main.ts`, around line 120–142) is the directory holding `out/web`, so the tarball layout already resolves; confirm by reading and state it in the report. `electron-builder.yml` needs no change (the `codex*` filter covers both members).

4. _CI cache._ In `ci.yml` (gates job) and in every job of `pre-release.yml` and `release.yml` that runs `bun install` (the desktop matrix and both server legs), add a "Read codex CLI version" step mirroring the claude one and an `actions/cache@v6` step with `path: vendor/codex-cli` and `key: ${{ runner.os }}-${{ runner.arch }}-codex-cli-${{ steps.codex-version.outputs.version }}`. No restore-keys: a partial hit is worthless because `cacheValid` re-verifies every digest and would re-download anyway. Keep the step order consistent with the existing cache steps.

5. _Integration gates._ Add `src/integration/codex/integration-host.ts` exporting `codexIntegrationEnabled = process.env.CODEX_INTEGRATION === '1' && codexHostSupported()` (import from `codex-locate.ts`). The four ADR-068 suites (`codex-injection`, `codex-mcp-override`, `codex-mcp-approval`, `codex-config-write`) switch to it. The older eight keep their macOS-only predicate unless the container run below passes them on BOTH arches, in which case they switch too; report each suite's Linux outcome either way and do not weaken an assertion to make one pass (the policy probe pins `/bin/zsh -lc`, which Linux will not produce; report it, leave it macOS-only). Read what the four fixtures assume about the platform (the Windows leg needed the fixture to serve `chatgpt_base_url` and `GET /v1/models` itself) and fix only what Linux actually needs, with the reason in the report.

6. _Verification container._ `scripts/docker/codex-linux.Dockerfile`: `FROM node:24.15.0-bookworm-slim` (the CI Node pin), `npm install -g bun@1.4.2` (the local bun; npm-registry package, pinned), apt `bubblewrap git python3 make g++ ca-certificates` (native addons rebuild on Linux). `scripts/docker/codex-linux-verify.sh --arch x64|arm64 [--keep] -- <command…>`: builds the image for `linux/amd64` or `linux/arm64`, mounts the repo READ-ONLY at `/src`, copies it into `/work` inside the container excluding `node_modules`, `vendor`, `.cache`, `out`, `dist`, `.git` objects it does not need (a `git ls-files`-driven copy plus the untracked working changes is acceptable; document the rule), mounts per-arch named volumes over `/work/node_modules`, `/work/vendor`, `/root/.bun/install/cache` and `/root/.cache/electron`, runs with the relaxed security profile above, `CODEX_INTEGRATION=1`, then `bun install` (postinstall acquires Linux Codex from the manifest, plus opencode and pi; `ensure-cli` is a documented clean skip on ELF) and the given command. The host's `node_modules` and `vendor` must never be touched; a guard in the script refuses a non-read-only repo mount. Default command: `bun run typecheck && bun run check-codex-protocol && bunx vitest run --project integration src/integration/codex`.

7. _Docs._ `docs/architecture/codex.md` gains a short "Linux" paragraph: hosts, the server tarball as the Linux artifact, bubblewrap as the system dependency with the exact package name per distro, the user-namespace caveats (Ubuntu 24.04 AppArmor, Docker seccomp), the boot warning, and the verification recipe (`scripts/docker/codex-linux-verify.sh`). `docs/protocol-codex/README.md` as in item 1.

**Verification the agent runs and quotes.** On the host: `bun run typecheck`, `bun run lint`, `bun run test`, `bun run check-codex-protocol`, `bunx prettier --check <touched files>`. In the container, both arches: `bun install` output showing `Codex 0.154.0 installed and verified (Linux …)`; a rerun showing `Codex verified cache hit`; `CLAUDEUI_CODEX_FAKE_HOST=linux/ia32 node scripts/ensure-codex.mjs` showing the skip line; `bun run check-codex-protocol`; the twelve Codex integration suites with per-suite outcomes; `bun run build:web && bun run build:server:compile && ./dist/server-bin/claudeui-server --help`; and a `bun -e` snippet that calls `setHostPaths({ getAppPath: () => '/work' })` and prints `locateCodexBinary()` plus its sha256, matching the manifest. Also show the boot warning firing in a container whose image lacks bubblewrap (a `--no-bwrap` flag on the script, or `PATH` without it) and silent when present.

**Report.** File list, both runs of every guard test, the container outputs above, and every deviation from this design with its reason.

## Verification and blockers

For every runnable milestone, add focused unit/component guard tests alongside code and cross-engine regressions. The reviewer independently reruns gates and demonstrates bug guards fail before the fix. Full integration gates are `bun run typecheck`, `bun run test`, `bun run test:ci`, `bun run lint`, and `bun run build`, followed by the real Electron app. Assert live DOM by `data-testid` before inspecting screenshots. Add headless integration smoke and real pinned-engine tests; mocks alone are insufficient. Do not run these application gates merely to validate M0 prose.

Release blockers remain explicit: native auth flow/concurrent-refresh verification; ratified native policy and native file/question coverage; dynamic authorization/redefinition/fork scrub; child cancellation/ownership; history pagination/delete semantics/interrupted presentation; queue uncertain-delivery reconciliation; dispatch restriction and budget envelopes; real account/media evidence; and platform packaging/process cleanup. The implementation agent reports results and deviations, never self-certifies or commits. The main reviewer owns review and independent verification; commits/pushes require separate user authorization.

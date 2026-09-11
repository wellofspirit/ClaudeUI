# Codex integration handoff

## Resume here

The user requested this handoff to start a new session. Stop implementing in the
old session. Continue on **`codex-integration`**, created from `pre-release`.
All integration work is uncommitted. Nothing was staged, committed, or pushed.

The latest user instructions are:

- Continue the remaining integration phases until a genuine blocker requires user intervention; do not stop for routine milestone approval.
- **Dispatch implementation changes to Claude, specifically Fable.** This supersedes the earlier request to use native implementation subagents.
- The available requested model is **`claude-fable-5-1[1m]`**, using `claudeui_dispatch_agent` with `engine: "claude"` and that exact `model`.
- The user explicitly approved a Fable dispatch to review existing changes and complete M3, including shared-worktree edits and tests, with no commits, dependency installation, or real credential access by that agent.

Main remains orchestrator/reviewer. Read actual code, review authored diffs,
independently rerun gates, and verify regression guards fail before fixes.
Follow ADR-026 and load the required skills, including `unslop`. Do not resume
the cancelled native implementation agent for more changes.

## Current checkpoint

**M1 foundations are implemented and previously independently verified. M2
runtime/UI wiring and an M3 read/list baseline now exist, but the latest large
continuation has not received a complete independent review or real-app gate.**

Do not trust older messages claiming Codex is still unregistered. The current
`src/core/providers/register-engines.ts` registers the Codex factory and spawn
preparation. `EngineId` includes `codex`.

The most recent main-model checks on this worktree were:

```sh
bun run typecheck
bun run test:unit src/core/codex
```

Both passed. The focused run passed **14 files / 111 tests**. Typecheck passed
again after the timed-out Fable dispatch. These checks are not release
certification or a full review of the latest continuation.

The working tree showed 71 tracked files changed, plus substantial untracked
new source/docs/generated files. `git diff --stat` omits the untracked files;
inspect them separately. The tracked stat remained 1,006 insertions and 207
deletions before and after the timed-out Fable assignment. That does not prove
all untracked file contents remained unchanged.

## Dispatch outcome

The first explicit Fable attempt was rejected by the tool approval layer. The
user then answered **Approve Fable dispatch** to the exact delegation scope.
The subsequent full Fable dispatch launched, but the tool returned:

```text
Dispatch timed out after 10 minutes - the target agent was aborted.
```

No completion report or resumable session ID was returned for that dispatch.
A later dispatch attempt was aborted before a useful result. **There is no
confirmed running Fable assignment to wait for.** Do not claim Fable completed
M3 or assume it made no partial edits.

Use smaller Fable assignments that can complete inside the observed ten-minute
tool limit. Start with a bounded review/fix or the queue identity groundwork,
not all of M3 in one dispatch. Supply full visible prompts. Do not set the
tool's internal `__xeng_*` fields yourself. If a permission gate rejects a
request, seek the specific approval rather than routing around it.

## Accepted decisions

- Codex is a first-class fourth harness, not just another OpenAI model route.
- Pin official **Codex 0.154.0** and drive `codex app-server` over stdio. No browser-facing Codex listener; desktop and web use existing core/SyncCore contracts.
- **Native auth:** Codex owns login, credential storage, and refresh. No vault-to-Codex injection or experimental external-token authentication. The shared vault may later adopt tokens acquired through native Codex login, with a separate refresh-ownership design.
- **Native permissions for phase 1:** shared permission-rule/classifier parity is deferred to a later fork/patch. Preserve existing native policy by omitting unspecified approval/sandbox/reviewer overrides. Do not force the earlier proposed `untrusted/workspace-write/user` default or map shared Auto to unrestricted native execution.
- **Native refresh concurrency:** the user explicitly chose **Accept upstream behavior**. Keep per-root processes plus service clients; document native refresh races, surface errors, and never automatically log out, delete credentials, or rewrite them. Do not reopen this decision or introduce a speculative request mutex/pooling redesign.
- **Queue semantics:** application-held, recallable items inject at an observed sub-turn boundary via `turn/steer`, not Codex's native next-turn queue.
- Capabilities become true only when the complete product path works. Unfinished mandatory features are not silently dropped from phase 1.
- No commits or pushes have been authorized.

## Credential boundary

The user authorized use of existing credentials for necessary integration
validation, then specifically authorized:

```sh
node scripts/codex-native-status.mjs
```

The main model independently ran it successfully after approval:

```json
{ "authenticated": true, "authKind": "chatgpt", "requiresLogin": false }
```

The previous status-access approval blocker is **resolved**. This proves stored
native login state, not successful inference or current token freshness. No
real-provider turn, live device login, logout, or explicit forced refresh was
performed by main. Latest implementation tests use isolated synthetic auth.

The status wrapper captures native output privately and returns allowlisted
metadata. Never run bare `codex login status` visibly: its API-key path can
print key fragments. Never read native auth files or vault material into tool
output. Load the `vault` skill for any new credential handling. The Fable
assignment itself excludes real credential access; main owns reviewed live
validation. Native app-server startup can refresh in background even when an
explicit `account/read` uses `refreshToken: false`.

## Read in this order

1. [ADR-066](adr/adr-066_codex-fourth-engine.md): accepted design and native exceptions.
2. [Integration spec](codex-integration-spec.md): especially **M2 continuation and M3 baseline, for review**, followed by remaining M3-M5 work.
3. [Codex architecture](architecture/codex.md): ownership and transport details. Check for stale foundation-only language against current code.
4. [Protocol reference](protocol-codex/README.md): tooling, generated contracts, spike details, and auth-source caveats.
5. [Executable spike](codex-spike.md): bounded observations, not proof of full UI integration.
6. [ADR-026](adr/adr-026_development-workflow.md), [ADR-030](adr/adr-030_capability-honesty.md), [ADR-038](adr/adr-038_event-driven-approval-lifecycle.md), [ADR-053](adr/adr-053_queue-item-identity-cc-parity.md), [ADR-059](adr/adr-059_no-silent-model-fallback.md), and [SyncCore](architecture/sync-core.md).

Some historical paragraphs still describe earlier blockers or unregistered
stages. The latest continuation section and inspected implementation supersede
those claims; reconcile documentation during review, not by assuming it is all
as built.

## Implemented code to assess

| Area           | Main paths and current state                                                                                                                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Acquisition    | `scripts/ensure-codex.mjs`, `scripts/codex-digests.json`; verified archive/payload/license, staged install and rollback protection. **macOS arm64 only**, opt-in, not ordinary build/postinstall/release hooks.                                                           |
| Protocol       | `scripts/generate-codex-protocol.mjs`, `src/core/codex/protocol/`; generated dependency closure and narrow method maps, deterministic provenance/drift checking. Avoid hand-editing generated types.                                                                      |
| Transport      | `CodexAppServerClient.ts`; one-shot RPC, bounded UTF-8 framing/writes, delivery-aware timeouts, abortable server requests, final-stdout draining, TERM/KILL group teardown.                                                                                               |
| Typed services | `CodexClient.ts`, `CodexService.ts`; native status/catalog/config/history reads and retained native login lifecycle. Service reads do not resume roots.                                                                                                                   |
| Session        | `CodexSession.ts`, `event-mapper.ts`, `model-selection.ts`, `model-discovery.ts`, `settings.ts`; native root, model/policy/effort, approvals/questions, token status, images, stable user/item identity and interruption.                                                 |
| Registration   | `src/core/providers/register-engines.ts`, shared engine metadata/capabilities, platform availability checks. Actual discovered models drive selection.                                                                                                                    |
| Auth/UI        | `src/core/auth/CodexAuthProvider.ts`, `src/core/ipc/codex-commands.ts`, `CodexAccount.tsx`, `CodexPolicyPill.tsx`, `CodexApprovalCard.tsx`. Device-code UI is explicit, no automatic host browser.                                                                        |
| History        | `src/core/services/engine-history.ts`, `src/core/codex/history.ts`; neutral reader routing, paginated native read/list, canonical/Sidebar/desktop/web integration. Codex fork/delete still refuse.                                                                        |
| Persistence    | `src/core/services/db.ts`; migration 15 `codex_session_overrides`, native verified identity protection and sparse accepted setting replay. Review migrations and interactions with client metadata replacement carefully.                                                 |
| Replication    | Core-created user IDs sent as `clientUserMessageId`; native acknowledgment replaces the host row by identity. `codexModelExplicit` distinguishes selection from a catalog preview. Changes span core commands, reducer/state, preload, renderer replicas and web adapter. |

Current `CODEX_ENGINE_CAPABILITIES` enables `interactiveApprovals` and
`auth.canDriveLogin`. Queue/steer, hosted tools, fork, subagents, dispatch,
voice, skills and advanced controls remain false. Validate the two enabled
flags against their complete UI/remote paths, not just unit tests.

## Important findings and invariants

- Codex native queue starts new turns when idle. It cannot replace ADR-053's active-turn feedback queue. `CodexSession.enqueuePrompt` still throws not implemented, and shared `SessionQueue` still correlates by text. Identity-aware acknowledgment is required for Codex without regressing old engines.
- Interrupting a pending dynamic tool can emit neither `serverRequest/resolved` nor `item/completed`; the interrupted item is absent from immediate and cold native history. Abort actual host work from its owning turn's terminal event and persist a narrow presentation record if transcript fidelity requires it. Never infer child cancellation from parent completion.
- Acknowledged native settings may not survive a new app-server process until consumed by a turn. Current code stores accepted overrides sparsely and reapplies them. Reset stops app replay; it does not erase Codex-owned thread state.
- Initialized zero-turn roots still fail some separate-process cold reads. Do not fabricate empty successful history or silently create a replacement thread. This remains a mandatory lifecycle gate.
- Native `thread.id` is conversation identity; `sessionId` can denote a tree root. Transcript IDs include thread/turn/item. Pending approval identity also includes process generation.
- `thread/resume` has no dynamic-tools replacement field. Persisted definition redefinition/fork inheritance and dispatch recursion exclusion need testing; sending an empty list is not a demonstrated scrub mechanism.
- Current delta handling uses item-scoped message upserts to avoid mixing concurrent items. This can flood the domain-event ring; per-item volatile streaming/throttling remains outstanding.
- Native OpenAI fixture transport uses WebSockets with `generate:false` warmup messages. Those are not model turns. Custom-provider SSE tests alone do not cover that path.
- USD is unavailable/unknown, not zero cost. Some current code hides native cost UI and stores null equivalent cost. Full account/rate-limit/child/dispatch attribution remains M4.
- POSIX process-group teardown does not prove cleanup of escaped groups or PTY descendants. Windows/Linux provisioning and runtime behavior remain unverified.

## Remaining work

### Review checkpoint first

Audit the latest M2/M3 baseline and run full gates plus real Electron/headless
verification before building on its assumptions. Shared changes include DB
identity, replica state, session commands, Sidebar and auth registration. The
cancelled native task left real code, not merely a plan. Preserve it and fix it
in place. Do not reset the branch or revert unrelated edits.

### M3

- Held queue, steer, recall, duplicate inputs/attachments and ambiguous-delivery reconciliation. Never replay a possibly accepted timed-out request blindly.
- Hosted mermaid/mockup/file tools through existing handlers, authorization, at-most-once execution and cancellation. Dispatch stays disabled until M4.
- Full relevant native item/rich-result history mapping, pagination/order/dedup, media/questions/artifacts, interrupted-tool presentation persistence, and zero-turn lifecycle.
- Native completed-turn fork with exact anchors and unchanged source.
- Verified delete/archive/descendant behavior with pins, metadata, overrides and supplement cleanup; fail non-destructively before enabling controls.
- Dynamic-definition persistence/redefinition/fork behavior and safe exclusion of recursive dispatch.

### M4

Native child observation/approvals/cancellation and history, followed by
cross-engine dispatch source and separate Codex target clients. Preserve
restrictions and forwarded approvals; do not extend legacy Auto-to-bypass or
plan-to-ask escalation. Unknown/estimated cost cannot justify a hard USD cap.
Complete account/model/rate-limit and child/dispatch usage attribution.

### M5

Real Electron DOM assertions before screenshots, headless/no-client execution,
web/mobile reconnect convergence, real-account/model/media coverage, supported
platform binary packages and cleanup, and release build wiring. Inventory
capabilities and unflagged callers so unsupported automation/title/skills/voice
paths do not fall through to another engine.

## Verification provenance

| Checkpoint                                      | Evidence                                                                                                                                                                                                                                                                |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1a, independent main                           | 52 focused tests; isolated production transport test; default suite 11,370 passed; CI suite 11,459 passed; typecheck/lint/build/protocol check passed. An initial CI attempt hit `EADDRINUSE` in an unchanged remote-server test; full rerun passed without workaround. |
| M1b, independent main                           | 69 focused tests; two isolated real-binary tests; default suite 11,387 passed; CI suite 11,476 passed; typecheck/lint/build/protocol check passed.                                                                                                                      |
| Latest M2/M3 continuation, implementer-reported | Typecheck/lint; 83 focused files / 1,807 tests; four isolated native integration tests; generated protocol check. **Main has not independently accepted these whole-slice claims.**                                                                                     |
| Latest worktree, independent main               | Typecheck and 14 Codex unit files / 111 tests passed. Typecheck passed again after Fable timeout. **No current full default/CI/build/Electron certification.**                                                                                                          |

Useful commands from the repository root:

```sh
git status --short --branch
bun run typecheck
bun run test:unit src/core/codex
CODEX_INTEGRATION=1 bun run test:integration src/integration/codex
bun run check-codex-protocol
bun run test
bun run test:ci
bun run lint
bun run build
git diff --check
```

Run default/CI suites sequentially when diagnosing port collisions. Use `bun`,
and `uv` for Python probes. Never install dependencies casually; native SQLite
must be rebuilt after any dependency installation under repo instructions.
Do not perform another real login simply to test the UI while an account is
already logged in.

## Artifacts and files to preserve

The installed binary is `vendor/codex-cli/codex`, ignored by git. The checked-in
manifest supplies authoritative digests. Original isolated spike evidence is in:

```text
/var/folders/3y/dsttymn54px6kwqkhxvhpfnm0000gn/T/opencode/codex-spike
```

`reviewer-01` and `reviewer-02` contain earlier independent spike reports/traces;
the Python spike is `scripts/probe-codex.py`. Temporary artifacts may expire and
are not a substitute for repeatable integration tests.

Do not treat these unrelated pre-existing untracked files as Codex changes:

- `docs/headless-server.md`
- `docs/manual.md`
- `qwen3.8-27b-fp8-g7e.md`
- `qwen3.8-27b-nvfp4-g7e.md`

New integration sources and documents are also untracked. A plain `git diff`
does not show them. Read/glob them directly during review and stage nothing
unless the user separately requests a commit.

## First Fable assignment suggestion

Send Fable a small assignment such as: inspect `SessionQueue`, `BaseSession`,
the current Codex enqueue/turn methods and their tests; implement only the
identity-aware queue groundwork with focused tests while preserving existing
engines. Do not enable queue/steer until the complete delivery/recall path is
wired and verified. Ask for a concise changed-file list, exact checks and
remaining hazards within the tool's observed time budget. Then review and
assign the next slice. Avoid another all-M3 prompt that times out before a
reviewable result.

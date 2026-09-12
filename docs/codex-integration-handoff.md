# Codex integration handoff

## Resume here

Work continues on **`codex-integration`**, created from `pre-release`. Ten Codex commits have landed on it, oldest first:

```text
b670492e feat(codex): pin Codex 0.154.0 acquisition and generate app-server protocol types
7fdc37f1 feat(codex): add stdio app-server transport, typed client and read-only service
f8244772 feat(codex): add session adapter with native policy, approvals and engine registration
c0b26144 feat(codex): route history list/read/delete through an engine-history registry
92ec1905 feat(codex): add renderer account, policy pill, approval card and sidebar wiring
6e0d4412 docs(codex): add ADR-066, integration spec, architecture notes and handoff
b0a61d61 fix(codex): show the model name in the picker and report disposal during startup
93091e75 test(codex): probe the native approval surface across policy and sandbox modes
970d9d4f feat(codex): gate Codex through ClaudeUI's shared permission model
0df6ed51 docs(adr): ADR-067 Codex under the shared permission model
```

`git log --oneline main..HEAD` also lists the unrelated pre-existing branch commits below `43a93ac7`. The native policy and policy pill named in the earlier subject lines were removed again by `970d9d4f`; see ADR-067.

Orchestration model in use, per ADR-026:

- The main model orchestrates, reviews every line, reruns gates independently, and commits.
- Opus subagents implement, one slice each, against a written kickoff spec. They never commit, `git add`, branch, or run `bun install`.
- Standing authorization to commit a reviewed slice. **Pushes still need an explicit ask.**

Answer behaviour questions from the Codex source before probing: the `rust-v0.154.0` checkout under `.cache/codex-src/` (gitignored, not vendored) is the fastest and most reliable source for what the binary does. Probe only what the source cannot settle.

The queue slice has a written kickoff spec that was parked before dispatch (identity-aware held queue via `turn/steer`, `consumeById` on `SessionQueue`, a `forwardQueuedItem` hook on `BaseSession`). It lives in the orchestrating session's scratchpad, which expires; rewrite it from the spec's "Mandatory remaining work" list if it is gone.

## Current checkpoint

Built and committed: pinned 0.154.0 acquisition and generated protocol types, the stdio transport, typed client and read-only service, `CodexSession` and the event mapper, engine registration and spawn prep, native catalog/model/effort selection, native device-code auth, a history read/list baseline through `engine-history.ts`, the renderer account pane, tool map and approval surfaces, and the shared permission model (ADR-067).

Not built: application queue and steer, hosted tools, native children, completed-turn fork, delete and archive, the interrupted-tool presentation supplement, full metering, cross-engine dispatch, non-macOS packaging. `capabilities.queue`, `steer`, `fork`, `forkFromMessage`, `hostedMcp`, `subagents`, `crossEngineDispatch`, `slashCommands`, `skills`, `sideQuestion`, `voice`, `backgroundTasks` and `sandbox` are all false; `plan`, `interactiveApprovals` and `auth.canDriveLogin` are true.

The [integration spec](codex-integration-spec.md) is the authority on scope: read its "Slice 3 (2026-09-11): shared permission model" and "Mandatory remaining work" sections rather than duplicating them here. Full default/CI/build and real-Electron release certification is not claimed.

## Accepted decisions

- Codex is a first-class fourth harness, not just another OpenAI model route.
- Pin official **Codex 0.154.0** and drive `codex app-server` over stdio. No browser-facing Codex listener; desktop and web use existing core/SyncCore contracts.
- **Native auth:** Codex owns login, credential storage, and refresh. No vault-to-Codex injection or experimental external-token authentication. The shared vault may later adopt tokens acquired through native Codex login, with a separate refresh-ownership design.
- **Shared permissions (ADR-067, supersedes the phase-1 native-policy decision):** the session's shared `PermissionMode` is the only policy surface. Per-turn native parameters are derived from it, and every server approval request is answered by the engine-neutral permission engine pi uses. `auto` alone delegates review to Codex's native `auto_review` guardian. Do not reintroduce a native policy pill or `CodexPolicyOptions`.
- **Native refresh concurrency:** the user explicitly chose **Accept upstream behavior**. Keep per-root processes plus service clients; document native refresh races, surface errors, and never automatically log out, delete credentials, or rewrite them. Do not reopen this with a speculative request mutex or pooling redesign.
- **Queue semantics:** application-held, recallable items inject at an observed sub-turn boundary via `turn/steer`, not Codex's native next-turn queue.
- Capabilities become true only when the complete product path works (ADR-030). Unfinished mandatory features are not silently dropped from phase 1.

## Credential boundary

The user authorized use of existing credentials for necessary integration validation, then specifically authorized:

```sh
node scripts/codex-native-status.mjs
```

The main model independently ran it successfully after approval:

```json
{ "authenticated": true, "authKind": "chatgpt", "requiresLogin": false }
```

The previous status-access approval blocker is **resolved**. This proves stored native login state, not successful inference or current token freshness. No real-provider turn, live device login, logout, or explicit forced refresh was performed by main. Latest implementation tests use isolated synthetic auth.

The status wrapper captures native output privately and returns allowlisted metadata. Never run bare `codex login status` visibly: its API-key path can print key fragments. Never read native auth files or vault material into tool output. Load the `vault` skill for any new credential handling. Implementing agents have no real credential access; main owns reviewed live validation. Native app-server startup can refresh in background even when an explicit `account/read` uses `refreshToken: false`.

## Read in this order

1. [ADR-067](adr/adr-067_codex-shared-permission-model.md): the permission model as built.
2. [ADR-066](adr/adr-066_codex-fourth-engine.md): the rest of the accepted design. Its "Phase-1 permissions are native, not shared Auto" section is superseded.
3. [Integration spec](codex-integration-spec.md): milestone state, the slice-3 record, and mandatory remaining work.
4. [Codex architecture](architecture/codex.md): ownership, transport, permissions and data flow as built.
5. [Protocol reference](protocol-codex/README.md): acquisition, generated contracts and real-binary tests.
6. [Executable spike](codex-spike.md): the two probes. Bounded observations, not proof of UI integration.
7. [ADR-026](adr/adr-026_development-workflow.md), [ADR-030](adr/adr-030_capability-honesty.md), [ADR-038](adr/adr-038_event-driven-approval-lifecycle.md), [ADR-053](adr/adr-053_queue-item-identity-cc-parity.md), [ADR-059](adr/adr-059_no-silent-model-fallback.md), and [SyncCore](architecture/sync-core.md).

## Important findings and invariants

- Codex's native queue starts a new turn when idle, so it cannot back ADR-053's active-turn queue. `CodexSession.enqueuePrompt` throws and shared `SessionQueue` still correlates by text.
- Interrupting a pending dynamic tool can emit neither `serverRequest/resolved` nor `item/completed`, and the interrupted item is absent from immediate and cold native history. Abort host work from the owning turn's terminal event; never infer child cancellation from parent completion.
- `thread/settings/update` acknowledges out of band (the applied settings arrive only on a later `thread/settings/updated` notification), and an unconsumed update did not survive a new app-server process. Slice 3 removed the need for it on the policy path: policy rides `turn/start` instead.
- `codex_session_overrides` (migration 15) holds model and effort only. Pre-slice-3 rows still carry policy keys; the loader drops unknown keys, the command parser rejects them.
- Initialized zero-turn roots still fail some separate-process cold reads. Do not fabricate an empty successful history or silently create a replacement thread. This remains a mandatory lifecycle gate.
- Native `thread.id` is conversation identity; `sessionId` can denote a tree root. Transcript IDs are thread/turn/item, and pending approval identity also includes process generation.
- An approved command runs unsandboxed on this wire. Sandbox containment cannot be measured in the integration fixture because macOS refuses to nest a second seatbelt profile.
- Native delete of a forked thread is a leaf-first whole-subtree operation, and forks are never listed by `thread/list`. See the lifecycle probe and the spec's remaining-work list before enabling any delete control.
- `thread/resume` has no dynamic-tools replacement field. Sending an empty list is not a demonstrated scrub mechanism.
- Intermittent, not reproduced since: on 2026-09-12 two of eight real-turn drives through the desktop app rendered only the user bubble and a running spinner although Codex completed the turn and core's canonical state held every message (verified by cold read and by two core-level reproductions of the app choreography). Both failures coincided with concurrent test suites; six later runs, two under deliberate load, rendered fully. `scripts/app-shot.mjs --state` (verifier hooks, commit cae94a2e) now captures the renderer store and replica canonical at failure time; use it on the next occurrence.
- Delta handling uses item-scoped message upserts to avoid mixing concurrent items. This can flood the domain-event ring; per-item volatile streaming and throttling remain outstanding.
- Native OpenAI transport sends a `generate:false` WebSocket warmup that is not a model turn. Custom-provider SSE tests alone do not cover that path.
- USD is unavailable and unknown, not zero. Full account/rate-limit/child/dispatch attribution remains M4.
- POSIX process-group teardown does not prove cleanup of escaped groups or PTY descendants. Windows and Linux provisioning and runtime behaviour remain unverified.

## Verification commands

```sh
bun run typecheck
bun run lint
bun run test
bun run test:ci
bun run build
bun run test:unit src/core/codex
CODEX_INTEGRATION=1 bun run test:integration src/integration/codex
bun run check-codex-protocol
git diff --check
```

Run the default and CI suites sequentially when diagnosing port collisions. Never install dependencies casually; native SQLite must be rebuilt after any dependency install. Do not perform another real login to test the UI while an account is already signed in.

## Artifacts

The installed binary is `vendor/codex-cli/codex`, gitignored; `scripts/codex-digests.json` holds the authoritative digests. The Codex source checkout is `.cache/codex-src` at tag `rust-v0.154.0`, also gitignored. The Python transport spike is `scripts/probe-codex.py`; the repo-resident probes are under `src/integration/codex/`. `docs/headless-server.md` and `docs/manual.md` are unrelated pre-existing untracked files, not Codex work.

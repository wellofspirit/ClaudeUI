# Codex integration handoff

## Resume here

Work continues on **`codex-integration`** (from `pre-release`). Forty-three Codex commits are on it. The first twenty-one were pushed to `origin/codex-integration` on 2026-09-12 with Daniel's approval; everything after `5eaf7bf5` is local until he asks for another push. The worktree is clean apart from two unrelated pre-existing untracked files (`docs/headless-server.md`, `docs/manual.md`). Oldest first:

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
59f19cfa docs(codex): reconcile architecture, spec and handoff with the built engine
ed5e357a test(codex): probe the native reviewer, execpolicy rules and judge-thread tooling
6e6d064e refactor(codex): drop the native settings channel, share allow-rule persistence, fix pre-turn effort
176dd767 fix(codex): acquire codex-code-mode-host alongside the binary and require it
389d22b0 fix(codex): gate and suggest on the command inside Codex's login-shell wrapper
cae94a2e feat(verifier): opt-in renderer state hooks for the real-app harness
33676b58 docs(codex): record the intermittent render loss and how to capture it
7022abf3 feat(codex): show the native reviewer's decisions in Auto-mode transcripts
a22ece12 feat(codex): compile user-scope Bash rules into a ClaudeUI-owned execpolicy file
5eaf7bf5 docs(codex): handoff for the next session, preserved slice specs, ADR-067 amendments
9edff274 docs(codex): rewrite the handoff as the resume point for the next session
44fcf2eb docs(codex): move the guardian override onto the declined card, record 2026-09-12 decisions
e56e466d fix(renderer): clear the draft after a send that rekeyed the session mid-flight
cd5d3598 docs(codex): record the draft fix and the render-loss tally after its verification drive
11a9637c docs(codex): defer the shared app-server decision to M4, record the inputs
68bcf6e3 feat(codex): let the human approve a guardian-denied action from the declined card
a3411d17 docs(codex): record the landed guardian override and the real Auto verification
3e7052e8 docs(codex): kickoff specs for hosted tools (slice C) and completed-turn fork (slice D)
156cd23c fix(codex): render native file adds and deletes as diffs; persist the rekeyed registry last
4050eb0a feat(codex): hold prompts sent mid-turn and steer them into the running turn by identity
3d15a284 docs(codex): record the landed queue and steer, and the shared base-loop hazard it exposed
30421310 feat(codex): host render_mermaid, create_mockup and show_mockup over Codex dynamic tools
7c365d8e docs(codex): record the landed hosted tools and their two verified deviations
0569269b docs(codex): kickoff spec for Codex as a cross-engine dispatch source (slice E)
21bff23e docs(codex): metering honesty gap as an open item; render-loss tally at twenty drives
5e92e52f feat(codex): branch a completed turn into a new native thread, and keep forks in the sidebar
368044ff docs(codex): record the landed fork and the sweep's missing negative cache
21f5f3ec docs(codex): kickoff spec for native children as subagent transcripts (slice F)
843b4ecf feat(codex): let Codex dispatch work to claude, opencode or pi through dispatch_agent
0cde917c docs(codex): record the landed dispatch source and its three departures from the spec
eed0b1c9 docs(codex): architecture pages and ADR-033 reflect the built queue, hosted tools, dispatch source and fork
5452d3c5 feat(codex): render native child agents as subagent transcripts under the spawning card
99cbf950 docs(codex): record the landed native children and the two presentation gaps they leave
```

The native policy pill and policy overrides named in the early subject lines were removed again by `970d9d4f`; ADR-067 is the permission model as built.

### How this branch is worked (ADR-026, as practised)

- The main model orchestrates: writes a kickoff spec per slice, reviews every line of the resulting diff, reruns every gate itself, verifies against the real Electron app, and commits. It never trusts an implementer's summary.
- Opus subagents implement one slice each against the written spec. They never commit, `git add`, branch, or run `bun install`. Every fix ships with a guard test proven to fail before the fix, with the failing assertion quoted in the report.
- Daniel gave standing authorization to commit a reviewed, gate-passing slice, one commit per slice with a substantive message. **Pushes still need an explicit ask.**
- Run at most two implementing agents at once, on disjoint files named in both specs. Three concurrent agents plus full-suite runs caused collisions and load flakes on 2026-09-11.
- Answer "what does Codex do" from the source first: the pinned checkout is `.cache/codex-src` (tag `rust-v0.154.0`, gitignored; re-clone with `git clone --depth 1 --branch rust-v0.154.0 https://github.com/openai/codex.git .cache/codex-src`). Probes confirm the running binary; they do not replace reading. Files that answered the big questions: `codex-rs/core/src/exec_policy.rs`, `core/src/safety.rs`, `core/src/tools/approvals.rs`, `core/src/guardian/review.rs`, `core/src/shell.rs`, `execpolicy/README.md`, `install-context/src/lib.rs`, `features/src/lib.rs`.
- Kickoff specs for the next two slices are in [codex-integration-next-slices.md](codex-integration-next-slices.md).

### Real-provider testing

Daniel authorized real Codex turns on his signed-in ChatGPT account for integration testing, with light usage: a few short turns per check, GPT-5.6 Luna by default, GPT 6 only for features Luna lacks. Rules of the road: run them in `/private/tmp/claudeui-codex-scratch` (contains `README.txt` and `hello.py`; recreate if gone), never in this repo; default mode unless the slice is about Auto; one benign command per check; never read `~/.codex` files or echo tokens; no login or logout while an account is signed in. Roughly a dozen turns were spent on 2026-09-12. The scratch directory now holds several completed Codex threads, so it appears in the welcome-screen directory list and can be selected by the harness.

Harness drive that works end to end (real turn, Auto mode, about 45 s):

```sh
bun run build
node scripts/app-shot.mjs --timeout 200000 --out .cache/screenshots/codex-turn.png \
  --click '[data-testid="EnginePicker.trigger"]' --click '[data-testid="EnginePicker.option"][data-engine="codex"]' \
  --click '[data-testid="WelcomeState.selectDirectory"]' --click '[data-testid="WelcomeState.directory"]:has-text("claudeui-codex-scratch")' \
  --click '[data-testid="InputBox.textarea"]' --type 'Run ls and tell me in one sentence what files are here. Do not modify anything.' \
  --click '[data-testid="InputBox.send"]' --wait 40000 --state --settle 500
```

`--state` prints the renderer store and replica canonical (verifier hooks, `cae94a2e`). Shift+Tab and other key presses do not reach the headless window; mode changes cannot be driven this way (the jsdom test covers them).

## Decisions recorded on 2026-09-11 and 2026-09-12

1. **Codex executes, ClaudeUI decides** ([ADR-067](adr/adr-067_codex-shared-permission-model.md)). The shared `PermissionMode` is the only policy surface. plan/default/acceptEdits run `untrusted` (the only policy that asks before executing anything) with our evaluator answering every command and file-change request; `auto` runs `on-request` with Codex's native `auto_review` guardian, which the user explicitly chose over a ClaudeUI judge ("if we can't map it, leave it as their native auto mode"). No bypass mode exists in the shared union. The pill, `CodexPolicyOptions` and the policy override keys are gone.
2. **Guardian visibility, B then C.** B (read-only rows for every completed review, circuit breaker as row plus error) landed in `7022abf3`. C ("approve anyway" via `thread/approveGuardianDeniedAction`) landed in `68bcf6e3` the same evening, in the shape Daniel ruled on: no pop-up per denial; the override lives on the declined tool card, bound by the review's `targetItemId`, survives turn end, and clears on answer, disconnect or the next `turn/start`. ADR-067 carries the amendment.
3. **Execpolicy rules file, option C** (deny and allow), landed in `a22ece12`: user-scope Bash rules only, deny as `forbidden` (prefix and exact), allow as `allow` (prefix only), everything else skipped and listed in the header, regenerated on core boot, on user-scope rule writes through ClaudeUI, and in the Codex spawn prep, only when the source hash changes. Daniel accepted that an execpolicy allow runs unsandboxed and unreviewed in every mode and that ClaudeUI writes one file into `~/.codex/rules/`. Project-scope rules are not compiled. Daniel's position on 2026-09-12: do not map rules per session, but do not give up on deny rules either; the design discussion is deferred until everything else on this branch is done. Until then a project-scope deny rule does not bind on Codex.
4. **Real-account Auto verification** with a forced guardian escalation is authorized (2026-09-12), under the light-usage rules.
5. **Draft left in the textarea after a rekey** is to be fixed, not left cosmetic.
6. **Delete walks the branch tree (2026-09-13).** Deleting a Codex session that has branches deletes the branches first, leaf-first, after a confirmation listing them, stopping non-destructively at the first refusal (spec: next-slices slice G). Archive stays unused.
7. **Queue and cost fixes authorized (2026-09-13):** fix the Claude "still shown as queued after pickup" bug and the shared base-loop dropped-boundary hazard; compute Codex equivalent USD from list prices (models.dev, cross-checked with OpenAI); replace the fork sweep with an explicit registry; close a dying child's card; fill the v2 wait card from our own child tracking. Render loss: track only.
8. Earlier decisions stand: native-owned auth with upstream refresh concurrency accepted; pinned 0.154.0 over stdio; application-held queue via `turn/steer`, never Codex's native next-turn queue; capabilities true only when the whole path works (ADR-030).

## Current checkpoint

Built, committed and verified on the real binary: acquisition of both `codex` and `codex-code-mode-host` with pinned digests; stdio transport, typed client, read-only service; session adapter with the shared permission model; shell-wrapper unwrapping so `Bash(...)` rules match Codex commands; guardian rows in Auto transcripts; the execpolicy rules file; native device-code auth; catalog and native effort in the standard pickers; history list/read through `engine-history.ts`; renderer account pane; verifier hooks. Real turns complete end to end in default and Auto mode, with approval card, command output, answer, metering and cold history; a prompt sent mid-turn is held, steered into the running turn at the next completed item, and its native user row replaces the synthesized one by identity (`4050eb0a`, seen live on 2026-09-12: the second user bubble landed between two command cards and one answer covered both prompts); the three hosted UI tools run over Codex's dynamic-tool channel and survive a resume (`30421310`, seen live: Luna called render_mermaid and the diagram card rendered an SVG); a completed turn can be branched into a new native thread that the sidebar keeps listing (`5e92e52f`, seen live twice: the branch answered from the copied context, no banner); Codex can dispatch to claude, opencode or pi through `dispatch_agent`, with the ask card on the task card (`843b4ecf`, seen live: Luna called it, deny returned the reason to the model); native child agents render as subagent transcripts under the spawning card on both collab surfaces, live and cold (`5452d3c5`, seen live on Astra: one spawned child, its reply under the Agent card, the root reporting it); a real Auto turn with an outside-workspace write showed the guardian's own decision row (approved, low risk), and the denial override (`68bcf6e3`) is proven against the real binary with a scripted deny verdict. A real denial has not been observed in the app: forcing one needs an action the reviewer rates risky, and every candidate that is also harmless if approved either trips ClaudeUI's own harness classifier or a user deny rule (`Bash(rm -rf /*)`). Minor presentation gap seen on that drive: a native `fileChange` add rendered "No changes" in the diff body.

Not built: Codex as a dispatch TARGET, delete and archive (native rule from the lifecycle probe: forks are never listed, delete is refused while a process holds the thread or a descendant fork exists, leaf-first), interrupted-tool presentation supplement (the M2 finding predates slice C, under which an interrupted dynamic call now completes `failed` with a cancellation text; whether cold history still omits it is unverified), full metering, non-macOS packaging.

### Open items, in the order I would take them

1. **Intermittent render loss.** Two of eight real-turn drives through the app rendered only the user bubble and a running spinner while Codex completed the turn and core's canonical state held every message. Both coincided with concurrent test suites; eight later drives rendered fully, two of them under deliberate load. Core-level reproductions of the app choreography (birth event, then the shared send handler, real client) were correct twice. If it recurs, capture with `--state` and compare the store against canonical; the suspect area is the routing-id rekey to the native thread id, but nothing in `reducer.ts`, `replica.ts` or `sync-core.ts` was found wrong on reading. The post-rekey draft bug (prompt text left in the textarea after the first turn of a new Codex session) is fixed in `e56e466d`: the replica records where each retired id went and `InputBox.handleSend` resolves the captured id through `resolveRekeyed` before its guard. Tally at the end of 2026-09-12: twenty real-turn drives, two losses, none in the twelve since (the last three exercised the guardian row, a same-turn steer and a hosted mermaid call, all rendered fully). Harness drives inherit the global default mode and Codex's default model; the 2026-09-12 evening drive ran in Auto on GPT-6-Astra, so pin the model through the picker when the rules call for Luna.
2. Then the spec's mandatory remaining work in [codex-integration-spec.md](codex-integration-spec.md) §"Mandatory remaining work".
3. **Fork sweep has no negative cache.** `listCodexSessions` re-reads every codex `session_meta` id the native list omits on each refresh, which after forks land is the forks plus every thread deleted behind our back. Bounded to four concurrent reads and throttled by the sidebar's refresh cadence, but unbounded in N. The clean fix is pruning `session_meta` when delete/archive lands, which is Daniel's design item; pruning on a transient read failure would silently lose a real fork, so it is not done here.
4. **Two child-agent presentation gaps.** On the v2 collab surface (Astra and friends) `wait_agent` carries no agent states, so its card shows null-filled input and "No agent reported a state for this call."; hiding it would lose the useful v1 card, so a v2-aware summary is the fix. Child approvals bind to the child item's id and therefore float rather than render inside the subagent transcript, because `SubagentMessages` has no approval binding; a renderer change.
5. **Dispatched cost invisible on Codex.** `addDispatchedCost` accumulates a dispatched turn's spend into the session, but `CodexSession` has no status-line builder and does not override `onDispatchedCostsChanged`, so the Codex TopBar tooltip never shows it. Small, and tied to the metering item above.
6. **Shared base-loop hazard, not Codex-specific (found while building the Codex queue).** `BaseSession.flushQueuedItems` returns early when a flush is already running, so a boundary signal that arrives while a forward is still on the wire is dropped; when that boundary was the turn end, no later boundary comes and the held item strands until the next send. Codex sidesteps it by chaining boundaries on its own promise (`queueBoundary`). opencode and pi call `flushQueuedItems` blind and carry the same latent hazard. Fixing it in the base loop changes all engines; raise with Daniel before touching it.
7. **Metering honesty: Codex reports $0, not "unknown".** `SessionStatus.totalCostUsd` is a plain `number` (`src/shared/types.ts`), so `CodexSession.status()` sends `0` for a subscription account whose USD cost is unknowable. The spec's M4 text says unknown USD is not zero. Fixing it means a nullable cost across the shared type, the reducer and the renderer's status bar for every engine; that is a cross-engine contract change, so it waits for Daniel.
8. **Process model, decided to defer (2026-09-12).** One app-server per root session (ADR-066) stays through slices A and B; whether to move to one shared, ref-counted app-server with per-thread subscribers is decided at M4, when native children force one process to host several threads anyway. Inputs for that decision: an idle app-server measured about 52 MB RSS plus one child process against an isolated home; the server multiplexes threads natively and offers `unix://` and `ws://` listeners besides stdio (multiple connections per process unverified); a shared process widens the blast radius of a crash or hang, contends on one stdio stream when several threads stream, needs an exit policy, and complicates the native "delete refused while a process holds the thread" rule (per-thread close unverified). The adapter already drops notifications for other thread ids, so it can sit behind a shared client later with little change. Cheap win available before M4: keep one warm read process in `CodexService` instead of spawning per read burst, or route reads through any live root's client.

## Credential boundary

Daniel authorized use of the existing native Codex login for integration validation and, on 2026-09-12, real-provider turns under the light-usage rules above. The sanitized status probe is:

```sh
node scripts/codex-native-status.mjs
```

It returned `{"authenticated":true,"authKind":"chatgpt","requiresLogin":false}` when main ran it. Never run bare `codex login status` visibly (its API-key path can print key fragments). Never read native auth files or vault material into tool output. Load the `vault` skill for any new credential handling. Implementing agents get no real credential access and no real turns; every integration test uses an isolated `CODEX_HOME` with a fake key and a scripted localhost provider. `rules-sync.ts` writes to the real `~/.codex/rules/claudeui.rules` only after core boot arms it; unit tests cannot reach the developer's home, and `ls ~/.codex/rules` after a full suite run showed no directory.

## Read in this order

1. [ADR-067](adr/adr-067_codex-shared-permission-model.md), including its 2026-09-12 amendments.
2. [ADR-066](adr/adr-066_codex-fourth-engine.md) for everything else; its native-permissions section is superseded.
3. [codex-integration-next-slices.md](codex-integration-next-slices.md): the two ready kickoff specs.
4. [Integration spec](codex-integration-spec.md): milestone record and mandatory remaining work.
5. [Codex architecture](architecture/codex.md): ownership, transport, permissions, data flow as built.
6. [Executable spike](codex-spike.md): the three probes (transport spike, approval surface, reviewer and judge thread).
7. [ADR-026](adr/adr-026_development-workflow.md), [ADR-030](adr/adr-030_capability-honesty.md), [ADR-038](adr/adr-038_event-driven-approval-lifecycle.md), [ADR-053](adr/adr-053_queue-item-identity-cc-parity.md), [SyncCore](architecture/sync-core.md).

## Findings and invariants worth remembering

- Codex wraps every model command as `<shell> -lc <script>`; the approval request and the transcript item both carry the wrapped string. `unwrapShellCommand` strips exactly one wrapper of the shape Codex's own `extract_bash_command` accepts before gating and suggesting.
- Approving a command runs it unsandboxed; so does an execpolicy `allow`. Approval and sandbox are alternatives, not layers.
- Under `auto`, no approval request reaches the client; only `item/autoApprovalReview/*` and `guardianWarning` notifications do. Reviews are not thread items and do not survive into cold history. Three consecutive guardian denials interrupt the turn.
- Real catalog models are `tool_mode: code_mode_only` and need `codex-code-mode-host` beside `codex`; the fixture's `mock-model` is not code-mode and never exercises that path.
- Codex loads `rules/*.rules` once per thread at start/resume; project-layer rules load only for trusted projects.
- `thread/settings/update` returns `{}` and acknowledges out of band; policy no longer uses it, effort still does.
- Native `thread.id` is conversation identity; transcript ids are thread/turn/item; pending approvals also carry the process generation.
- Native delete of a forked thread is leaf-first and whole-subtree; forks are never listed by `thread/list`.
- Delta handling uses item-scoped message upserts, which can flood the domain-event ring on long answers; per-item volatile streaming is outstanding.
- Sandbox enforcement cannot be measured in the integration fixture (macOS refuses to nest a second seatbelt profile); containment claims rest on source and real runs.
- The model, not the feature flag, picks Codex's collab surface (`multi_agent_version_for_model`): Luna and the older models take v1 (`collabAgentToolCall` items, `spawn_agent` in namespace `multi_agent_v1`), Astra/Sol/Terra/Daybreak take v2 (`subAgentActivity` items, namespace `collaboration`, spawn requires `task_name`). Only the `started` activity names the child thread; later activities carry their own item ids.
- No `thread/started` is ever emitted for a spawned child (three emit sites: `thread/start`, `thread/fork`, detached review). A child's early notifications must be held until its spawn item binds it.
- `dynamicTools` is accepted on `thread/start` only; resume and fork restore the specs from the source rollout's SessionMeta; children never inherit them.
- The v2 wire uses camelCase where the core deserializes snake_case: `GuardianAssessmentEvent` fields, action tags (`apply_patch`) and the `GuardianCommandSource` VALUE (`unifiedExec` vs `unified_exec`). Anything sent back to the core needs the mapping.
- A parent `turn/interrupt` does not cascade to spawned children; each running child needs its own.
- `BaseSession.flushQueuedItems` drops a boundary signal that arrives while a forward is in flight (re-entrancy guard). Codex chains boundaries on its own promise; opencode and pi still call it blind.
- Known test flakes unrelated to this branch: `remote-*.test.ts` port collisions under parallel load, and `SettingsDialogView.component.test.tsx` fails `format:check` since before the branch. Rerun in isolation before blaming a diff.

## Verification commands

```sh
bun run typecheck && bun run lint && bun run test
CODEX_INTEGRATION=1 bun run test:integration src/integration/codex
bun run check-codex-protocol
bun run build
git diff --check
bun run format:check
```

## Artifacts

Vendored binaries: `vendor/codex-cli/codex` and `vendor/codex-cli/codex-code-mode-host`, gitignored, digests in `scripts/codex-digests.json`. Source checkout: `.cache/codex-src`. Harness copies with longer watchdogs live in `.cache/` and can be deleted; `scripts/app-shot.mjs` now has `--wait`, `--eval`, `--state`, `--timeout`. Temporary real-turn probe tests were kept out of the repo. Memory notes for the orchestrating model live under the ClaudeUI project memory: source checkout, real-turn authorization, commit cadence, branch state.

# Codex integration handoff

## Resume here (ADR-068 arc — 2026-09-14)

**Start with `docs/adr/adr-068_chatgpt-identity-vault-owned-codex-injection.md` and `docs/codex-accounts-spec.md`.** The spec is the source of truth for this arc: every slice has a kickoff, and every landed slice has a "Landed …" paragraph recording the as-built deviations. Slices 1–6 are landed; ADR-068 is Implemented. Next: a push when Daniel asks, then the deferred items listed under "Open items". The older "Resume here" below is the pre-ADR-068 state and stays as history.

### What is committed (all local on `codex-integration`, oldest first; nothing pushed since the previous handoff — confirm with `git log origin/codex-integration..HEAD`)

```text
e23d5f93 docs(codex): ADR-068 + spec (vault-owned ChatGPT identity, Codex by token injection, accounts, one sign-in dialog)
855755af feat(auth): Slice 1 — vault holds N accounts, one active, vended to pi/opencode; Accounts card + per-session toggle
786902fd feat(codex): Slice 2a — inject the vault token into every Codex process; refresh answered from the vault
81822982 feat(codex): Slice 2b — per-session account pin, account picker, per-account rate limits (credits for business plans)
a54776e7 feat(auth): Slice 3 — SignInDialog for Anthropic + ChatGPT, one session:auth-required from every engine
772d89eb fix(auth): CredentialSync refresh timer overflowed for expiries beyond 2^31 ms and refreshed immediately
37ccd411 feat(codex): Slice 4 — inherit the shared Claude MCP list as a per-thread override (merges into the native table)
c3c32850 feat(codex): Slice 4b — MCP tool approvals via mcpServer/elicitation/request through the shared permission engine
463b060b docs(codex): handoff for the ADR-068 arc
3be8e0b2 feat(codex): Slice 5a — config.toml through the app-server; the Engines › Codex page
7e9c05a5 feat(codex): Slice 5b — Codex on Default models, Dispatch, the judge and Permissions; engines/codex.json defaults
60656d54 docs(adr): ADR-068 Implemented — as-built section for the eight landed slices
```

Every one of these was reviewed line by line by the main model, gated (typecheck, lint, full `bun run test`, `CODEX_INTEGRATION=1 bun run test:integration`, `check-codex-protocol` where the protocol changed), and driven in the real Electron app before commit. Live evidence that exists: a real signed-in Codex turn under an injected vault token (the first on Windows), the account picker pinning a session to a second account on a live process, the sign-in dialog opened from the bad-token discovery banner, the real app-server spawning a `.mcp.json` stub and the model calling its tool after the approval card was allowed.

### Slice 5a: landed 2026-09-14 (the commit after `463b060b`)

Reviewed line by line, gated (typecheck, lint, full `bun run test` — 655 files — `CODEX_INTEGRATION=1` on `codex-config-write.integration.test.ts`, `check-codex-protocol`, prettier), and driven four times in the real Electron app against an isolated profile. The review found and fixed three things the implementer's report did not show, all recorded in the spec's "Landed" paragraph: the write result carried an `ok` key, which the preload/web `unwrap` treats as the IPC envelope (the renderer received `undefined`, and the store's write queue stayed rejected after the first click — seen as three page errors on the first drive); two toggle defaults were inverted against the Codex source (`shell_environment_policy.ignore_default_excludes` defaults to `true`, and analytics are OFF under `codex app-server` unless `--analytics-default-enabled` is passed, which ClaudeUI never does); and two number placeholders asserted defaults the pinned checkout does not contain. Guard tests for the toggle defaults were proven failing before the fix (`expected 'true' to be 'false'` on `aria-pressed`).

Drive recipe that worked (Windows, Git Bash): the `.cache/app-shot-home.mjs` harness copy with `APP_SHOT_ELECTRON_ARGS="-r;<win path>\home-shim.cjs"`, `CLAUDEUI_TEST_HOME=<win path>\home`, `CODEX_HOME=<win path>\home\.codex`, `MSYS_NO_PATHCONV=1`; open the page with `--eval "window.dispatchEvent(new CustomEvent('open-settings',{detail:{page:'codex'}}))"` then `--wait 9000` (one app-server start per read and per write, about 3 s each on this machine), click by `CodexConfigPane.*` testids, and read the DOM back with one `--eval` before the screenshot. Click a select BEFORE actions that scroll the dialog: the anchored menu did not stay open after a scroll (pre-existing, noted in the spec). The fabricated `config.toml` must be reset between drives.

### Slice 5b: landed 2026-09-14 (the commit after `3be8e0b2`)

Reviewed line by line, gated (typecheck, lint, full `bun run test` — 658 files, 12276 tests — `check-codex-protocol`, prettier, `git diff --check`), and driven twice in the real app against the isolated profile (the three topic segments plus the permissions row; then the default-model pick, the written `engines/codex.json`, and a session seeded from it through `window.__claudeuiVerifier.sessionStore`). One reviewer fix: the configured effort is now PAIRED with the configured model (`codexDefaultEffortFor` in `InputBox.tsx`), because a sticky pick of another model would have made `CodexSession.validateEffort` refuse every new session; guard proven failing first. The implementer's deviations (all four `DISPATCH_CALLERS` corrected, empty-catalog `null` kept for the sign-in banner, one shared `engines/codex.json` object) were checked and accepted; details in the spec's Landed paragraph.

### Next

ADR-068 is flipped to Implemented with an as-built section in the same session. Remaining for this arc: the deferred items under "Open items after Slice 5" below. The two pre-existing observations from the 5a/5b Landed paragraphs were fixed and pushed the same day: anchored menus now follow their trigger on scroll and close only when it leaves the viewport (`use-anchored-menu.ts`), and `PiSessionDefaultModel` shares the one `engines/pi.json` object through the extracted `use-engine-config.ts` store. Daniel granted standing authorization (2026-09-14) to push `codex-integration` after every reviewed commit.

### How this arc is worked

ADR-026 as practised: the main model writes the kickoff into the spec, an Opus `general-purpose` agent implements against it with the standing rules at the top of the spec (no git state moves, no repo format, no deleting others' files, no real credentials, guard tests proven failing first), the main model reads every line, re-runs gates, proves fail-before from a clean HEAD worktree when in doubt (`git worktree add --detach .cache/wt-head <sha>` + a `node_modules` junction, then copy the new test files in), drives the app, and commits by explicit file list. Slices 1 and 2b each needed two or three review rounds; the fixes were real (a dead "+ Add account" button, a missing opencode recycle, a pre-spawn pin that never surfaced, an unhandled rejection from the picker).

### Recipes that took time to find

- **Isolated-profile app drive.** Electron ignores `NODE_OPTIONS --require`, and rewriting `USERPROFILE` breaks its crashpad launch. What works: `.cache/app-shot-home.mjs` (a gitignored copy of `scripts/app-shot.mjs` whose launch reads `APP_SHOT_ELECTRON_ARGS`, `;`-separated) passing Electron's own `-r <shim>` where the shim only patches `os.homedir()` to `CLAUDEUI_TEST_HOME`; run with `MSYS_NO_PATHCONV=1` and Windows-format paths. The shim was in the previous session's scratchpad (`home-shim.cjs`, ten lines: `require('node:os').homedir = () => process.env.CLAUDEUI_TEST_HOME`) — recreate it. LIMIT: it isolates only the main process (vault, providers, DB); child processes (cli.js, codex) still see the real `USERPROFILE`/`CODEX_HOME`.
- **Never launch the app against the real home while the owner's app is running**: two instances race the vault's token refresh. Reviewer-only exceptions were made for short, read-mostly drives; the vault's mtime was checked afterwards.
- **Fabricated profiles need JWT-shaped access tokens** (unsigned `alg: none` with `exp`, `email`, `https://api.openai.com/auth.chatgpt_account_id`); Codex parses the claims and rejects a plain string with "invalid ID token format". Far-future expiries must stay under the timer clamp fix or they would have been refreshed at once (now fixed in `772d89eb`).
- **Real-binary integration on Windows x64**: `CODEX_INTEGRATION=1 bunx vitest run --project integration src/integration/codex/<file>`. The ADR-068 tests (`codex-injection`, `codex-mcp-override`, `codex-mcp-approval`, `codex-config-write`) are gated for macOS arm64 AND Windows x64; the older Codex suites are still macOS-only. On Windows the child runs unsandboxed, so the fixture must serve `chatgpt_base_url` and `GET /v1/models` itself or a fake token earns real 401s.
- **Scratch directory for live Codex turns:** `D:\WorkPlace\codex-scratch` (README, `mcp-stub.cjs`, `.mcp.json` declaring `verify-stub` with a `ping` tool answering `pong-from-mcp`). Real turns there spend the owner's ChatGPT quota; keep them to one short prompt.
- **Eval-driven session start in the harness:** `st.createNewSession(id, cwd, true)`, then `setSelectedEngine("codex")`, then `window.api.createSession(id, cwd, undefined, undefined, "default", undefined, undefined, undefined, undefined, "codex")`, then `sendPrompt`. Codex rekeys the routing id to the native thread id, so find the session by `cwd` afterwards, not by the minted id.

### Findings from the binary worth keeping (all recorded in `docs/codex-spike.md`)

Per-thread `config.mcp_servers` overrides merge per key into the user's table (both nested and dotted forms). MCP tool approval is a form elicitation on `mcpServer/elicitation/request` with `_meta.codex_approval_kind = "mcp_tool_call"`, no question id, tool name only in the message; accept body is `{ action: "accept", content: {} }`. A user-level `forced_chatgpt_workspace_id` does not gate an injected token. A business workspace reports credits, not rate windows. `config/batchWrite`: `null` removes, stale version → `configVersionConflict`, no schema validation of keys.

### Decisions 2026-09-14 (after the arc)

- **Project-scope deny rules under Auto: leave it.** Daniel ruled that only user-scope Bash rules are compiled into `~/.codex/rules/claudeui.rules`; project-scope rules bind on Codex in plan/default/acceptEdits through ClaudeUI's evaluator and not under Auto. The Permissions row's sentence already says so. Rejected alternative: compiling into `<project>/.codex/rules/`, which writes a generated file into the repository and only loads for projects Codex marks trusted.
- **Linux: Daniel takes it** on a Mac with Linux emulation (digest manifest, acquisition, app-server spawn, process tree). Nothing to prepare on Windows.
- **Sign-in entry points (model picker + composer): LANDED as Slice 6** the same day (the commit after `015616ad`), from the owner mockup `mockup.html` at the repo root (untracked). Reviewed, gated and driven with and without a fabricated ChatGPT account; details in the spec's Slice 6 Landed paragraph.

### Roadmap after the Codex integration (Daniel, 2026-09-14)

In this order:

1. **History mappers, with a cross-harness tool survey — new session.** Add mappers and cards for every native Codex item kind the read/list path does not name today (`webSearch`, `imageGeneration`, `imageView`, `plan`, `contextCompaction`, `functionCallOutput`, `hookPrompt`, `enteredReviewMode`/`exitedReviewMode`, `sleep`; `mcpToolCall` renders through the generic body). Daniel wants this done properly: research EVERY tool and method each harness exposes (cli.js stream-json — `docs/protocol-cc/`; opencode HTTP+SSE — `vendor/opencode-src`; pi RPC — `docs/protocol-pi/`; Codex app-server — `protocol/v2/ThreadItem.ts` and the notification catalog in `docs/codex-spike.md`), inventory them against ClaudeUI's card vocabulary, and map each one deliberately. Start by building that inventory table before writing any mapper. Guards: canonical/desktop/web equality after a cold resume per kind.
2. **Per-item volatile stream — a design discussion first.** Text and reasoning deltas are item-scoped canonical upserts today; only command-output tails ride the volatile lane. Moving deltas per item onto the volatile lane touches SyncCore's stream protocol (per-session today), the replica projection and all three clients; write the design note and discuss before code.
3. **Metering attribution — folded into the usage-tracking dashboard revamp**, a broader discussion after the Codex integration. Open questions to carry there: child vs cross-engine attribution on usage rows, metering under a pinned account's identity, double counting after rekey/resume, failed-turn spend, and whether an estimated USD cap can gate dispatch.
4. **Grandchild rendering for every harness that supports nested dispatch** — not urgent; discuss the nested subagent view before building. Codex refuses a child's own spawn today with one error; the work is recursive binding, a nested transcript view, interrupt cascade, cold reconstruction and usage folding.

### Open items after Slice 5

pi has no distinguishable auth error (no `session:auth-required` from it); Codex→Codex dispatch is refused so the "caller pin reaches the target" wiring is dormant; headless-server device code is designed but not built; the macOS legs of the new integration tests have not run; the Rename → Orrery arc is untouched by this work.

## Resume here (pre-ADR-068 — historical)

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
7. **Codex as a dispatch target: build it (2026-09-13).** Daniel needs cross-engine dispatch into Codex; spec is next-slices slice H, modelled on the pi target.
8. **Queue and cost fixes authorized (2026-09-13):** fix the Claude "still shown as queued after pickup" bug and the shared base-loop dropped-boundary hazard; compute Codex equivalent USD from list prices (models.dev, cross-checked with OpenAI); replace the fork sweep with an explicit registry; close a dying child's card; fill the v2 wait card from our own child tracking. Render loss: track only.
9. **No live guardian-denial chase (2026-09-13).** The approve-anyway path is proven against the real binary with a scripted deny verdict; Daniel chose not to spend real turns forcing the reviewer to deny something live.
10. **Nested-agent approvals: both surfaces (2026-09-13).** Keep the floating card and also bind the approval to the matching tool block inside the subagent view (spec: next-slices slice I; benefits dispatched targets on every engine).
11. **2026-09-13 late decisions.** (a) The three small follow-ups are authorized: opencode dispatch-target approvals carry the tool id; the delete-plan sweep becomes a launch-time lineage scan with a cache that records roots too and a one-time rescan on a refused delete; the interrupted-tool cold-history question is probed. (b) Cost shows "unknown" rather than $0 when no price exists: the shared cost field becomes nullable across engines. (c) Process model: keep one app-server per root session; at about 52 MB idle per process the shared-process redesign is not worth it. Closed. (d) Windows and Linux stay in this doc for later; Daniel does Windows first, Linux separately. (e) Headless-server and web/mobile verification of Codex: Daniel runs it himself.
12. **Interrupted hosted-tool call (2026-09-13): synthesize a failed result live** so the card shows stopped; no cold-history supplement.
13. Earlier decisions stand: native-owned auth with upstream refresh concurrency accepted; pinned 0.154.0 over stdio; application-held queue via `turn/steer`, never Codex's native next-turn queue; capabilities true only when the whole path works (ADR-030).

## Current checkpoint

Built, committed and verified on the real binary: acquisition of both `codex` and `codex-code-mode-host` with pinned digests; stdio transport, typed client, read-only service; session adapter with the shared permission model; shell-wrapper unwrapping so `Bash(...)` rules match Codex commands; guardian rows in Auto transcripts; the execpolicy rules file; native device-code auth; catalog and native effort in the standard pickers; history list/read through `engine-history.ts`; renderer account pane; verifier hooks. Real turns complete end to end in default and Auto mode, with approval card, command output, answer, metering and cold history; a prompt sent mid-turn is held, steered into the running turn at the next completed item, and its native user row replaces the synthesized one by identity (`4050eb0a`, seen live on 2026-09-12: the second user bubble landed between two command cards and one answer covered both prompts); the three hosted UI tools run over Codex's dynamic-tool channel and survive a resume (`30421310`, seen live: Luna called render_mermaid and the diagram card rendered an SVG); a completed turn can be branched into a new native thread that the sidebar keeps listing (`5e92e52f`, seen live twice: the branch answered from the copied context, no banner); Codex can dispatch to claude, opencode or pi through `dispatch_agent`, with the ask card on the task card (`843b4ecf`, seen live: Luna called it, deny returned the reason to the model); native child agents render as subagent transcripts under the spawning card on both collab surfaces, live and cold (`5452d3c5`, seen live on Astra: one spawned child, its reply under the Agent card, the root reporting it); any Claude, opencode or pi session can dispatch work into a headless Codex thread (`749886cc`, seen live: a Claude session's task card read Dispatch: codex and reported the returned text); deleting a branched Codex session walks its branch tree leaf-first after a confirmation that lists the branches (`01f38172`, seen live: plan 0.9 s, delete 1.1 s, three rows gone); the session cost contract is nullable so an unpriced model reads as unknown rather than $0 on every engine and client, and opencode dispatch-target approvals bind inline (`ef83a639`, seen live: the cost tile read $0.16 for a priced Astra session); branch lineage is learned by a detached scan at launch into a cache (db v17) that also records roots and tombstones, so the delete plan is a synchronous cache read with one rescan on a refusal (`cf11b983`, seen live: 22 reads on first launch then 1, a fresh branch planned in 2 ms and deleted with its root in 123 ms); a hosted-tool call cut off by an interrupt now gets a synthesized failed result with cli.js's tombstone text so its card shows stopped (`6f69d427`; cold history still omits the item by decision); Codex is acquired on install and shipped in packaged builds on macOS arm64 (`e5bf09b6`, unpacked build carries both binaries with manifest-matching digests; other hosts skip with a message); a queued message picked up between turns by cli.js is now announced and the shared flush never drops a mid-forward boundary (`d4d5bf60`, harness 10/10 live); a nested agent's approval renders on its own tool card as well as floating (`4be947f9`); forks are recorded in a registry instead of swept (db v16), Codex sessions show an API-rate equivalent cost from published prices (about $0.16 for a trivial Astra turn, seen live), a dying child closes its card and the v2 wait card names the children (`76453c7f`); a real Auto turn with an outside-workspace write showed the guardian's own decision row (approved, low risk), and the denial override (`68bcf6e3`) is proven against the real binary with a scripted deny verdict. A real denial has not been observed in the app: forcing one needs an action the reviewer rates risky, and every candidate that is also harmless if approved either trips ClaudeUI's own harness classifier or a user deny rule (`Bash(rm -rf /*)`). Minor presentation gap seen on that drive: a native `fileChange` add rendered "No changes" in the diff body.

Not built: archive (unused by decision), a cold-history supplement for interrupted hosted-tool calls (decided against; the live card is closed instead), full metering, Linux digests and packaging (the acquisition skips there; Daniel's). Windows x64 digests and packaging landed on 2026-09-13 (per-host manifest; acquisition, packaging, app-server spawn, account and catalog reads and the protocol check verified on a Windows machine; a signed-in turn and the Windows sandbox path are still open).

### Open items, in the order I would take them

1. **Intermittent render loss.** Two of eight real-turn drives through the app rendered only the user bubble and a running spinner while Codex completed the turn and core's canonical state held every message. Both coincided with concurrent test suites; eight later drives rendered fully, two of them under deliberate load. Core-level reproductions of the app choreography (birth event, then the shared send handler, real client) were correct twice. If it recurs, capture with `--state` and compare the store against canonical; the suspect area is the routing-id rekey to the native thread id, but nothing in `reducer.ts`, `replica.ts` or `sync-core.ts` was found wrong on reading. The post-rekey draft bug (prompt text left in the textarea after the first turn of a new Codex session) is fixed in `e56e466d`: the replica records where each retired id went and `InputBox.handleSend` resolves the captured id through `resolveRekeyed` before its guard. Tally at the end of 2026-09-12: twenty real-turn drives, two losses, none in the twelve since (the last three exercised the guardian row, a same-turn steer and a hosted mermaid call, all rendered fully). Harness drives inherit the global default mode and Codex's default model; the 2026-09-12 evening drive ran in Auto on GPT-6-Astra, so pin the model through the picker when the rules call for Luna.
2. Then the spec's mandatory remaining work in [codex-integration-spec.md](codex-integration-spec.md) §"Mandatory remaining work".

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
- Native delete of a forked thread is leaf-first for FORKS (the binary deletes a root's spawned children itself). A fork is absent from `thread/list` only until it has run a turn; after that it is listed indistinguishably from a root (`forkedFromId` and `parentThreadId` null on the entry) and only `thread/read` reveals its source. `thread/read`'s not-found answer shares `-32600` with a transient miss, so a refusal counts only when a second spaced read confirms it.
- Delta handling uses item-scoped message upserts, which can flood the domain-event ring on long answers; per-item volatile streaming is outstanding.
- Sandbox enforcement cannot be measured in the integration fixture (macOS refuses to nest a second seatbelt profile); containment claims rest on source and real runs.
- The model, not the feature flag, picks Codex's collab surface (`multi_agent_version_for_model`): Luna and the older models take v1 (`collabAgentToolCall` items, `spawn_agent` in namespace `multi_agent_v1`), Astra/Sol/Terra/Daybreak take v2 (`subAgentActivity` items, namespace `collaboration`, spawn requires `task_name`). Only the `started` activity names the child thread; later activities carry their own item ids.
- No `thread/started` is ever emitted for a spawned child (three emit sites: `thread/start`, `thread/fork`, detached review). A child's early notifications must be held until its spawn item binds it. A child spawned after a mode switch inherits the NEW policy: `turn/start`'s overrides commit to the session configuration (same `prepare_update` as `thread/settings/update`) and `build_per_turn_config` projects them into the turn Config a child clones (verified on the binary, 2026-09-13). What does not follow a switch: a child already running, and a child spawned later in the same in-flight turn. Also, under `untrusted` Codex runs commands it deems safe (an `echo` redirect inside the workspace) without asking, root or child.
- `dynamicTools` is accepted on `thread/start` only; resume and fork restore the specs from the source rollout's SessionMeta; children never inherit them.
- The v2 wire uses camelCase where the core deserializes snake_case: `GuardianAssessmentEvent` fields, action tags (`apply_patch`) and the `GuardianCommandSource` VALUE (`unifiedExec` vs `unified_exec`). Anything sent back to the core needs the mapping.
- A parent `turn/interrupt` does not cascade to spawned children; each running child needs its own.
- `BaseSession.flushQueuedItems` drops a boundary signal that arrives while a forward is in flight (re-entrancy guard). Codex chains boundaries on its own promise; opencode and pi still call it blind.
- Branching only seeds the new session locally; the native `thread/fork` happens on the FIRST prompt sent in the branch. A branch never prompted is not a Codex thread, and its root deletes freely.
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

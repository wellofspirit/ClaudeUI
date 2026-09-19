# Codex integration handoff

State on 2026-09-18. The arc is merged: PR #37 (`codex-integration → pre-release`) landed at `80d71efc` (v3.2.0) and every follow-up F1–F21 is in `pre-release` and pushed. This file is the standing record of what is still OPEN, what still BINDS, and how to drive Codex without spending a credential.

The build specs that carried the landed work (`codex-integration-spec.md`, `codex-followups-spec.md`, `codex-accounts-spec.md`, `codex-host-spec.md`, `codex-integration-next-slices.md`) were deleted once their items landed — `git log -p -- docs/<name>.md` has the full text, kickoff by kickoff. Nothing in them is open.

## Read in this order

1. [ADR-069](adr/adr-069_codex-host-per-home-and-account.md) — the process model as built: one `codex app-server` per Codex home and injected account, sessions are threads on it, reads borrow it, quit disposes the registry, an active-account switch moves the sessions that follow the active account. § Probe answers and § As built carry the detail.
2. [ADR-067](adr/adr-067_codex-shared-permission-model.md) (with its 2026-09-12 amendments) and [ADR-068](adr/adr-068_chatgpt-identity-vault-owned-codex-injection.md) — identity, accounts, config page. [ADR-066](adr/adr-066_codex-fourth-engine.md) for everything else; its native-permissions section is superseded.
3. [`architecture/codex.md`](architecture/codex.md) — the engine as built, then [`codex-spike.md`](codex-spike.md) for the binary probes (wire-fact reference, cited from ~20 source files).
4. [ADR-026](adr/adr-026_development-workflow.md) (amended 2026-09-17), [ADR-030](adr/adr-030_capability-honesty.md), [ADR-038](adr/adr-038_event-driven-approval-lifecycle.md), [ADR-053](adr/adr-053_queue-item-identity-cc-parity.md), [SyncCore](architecture/sync-core.md).

## Open work

Not sequenced.

- Metering attribution (child vs dispatch, a pinned account's identity, double counting after rekey/resume, failed-turn spend, whether an estimated USD cap can gate dispatch) — folded into the usage-dashboard revamp.
- Images in a dynamic-tool result are not rendered. Grandchildren are not rendered on any harness (not urgent).
- Render loss is instrumented (F4 turn-end audit, F5 stress loop), not root-caused; nothing seen since.
- Same-engine dispatch for opencode → opencode (and possibly pi → pi) is a later candidate; Codex → Codex stays refused (native children cover it).
- Item-lane verification gap, remaining half: no standalone browser-client drive at any point in the migration, so WebSocket delivery of item frames still rests on the e2e suite rather than on a real browser. (The cross-engine dispatch half is CLOSED — see below.)
- Known flakes — rerun alone before blaming a diff: the Codex delete integration suite fails only under parallel load (`-32600` on a source with a loaded fork); the policy probe's `untrusted` matrix is load-sensitive; `remote-*.test.ts` port collisions; `src/web/__tests__/provider-auth-hydration.component.test.tsx` throws three `EnvironmentTeardownError` unhandled rejections when `bun run test` runs beside a build or an Electron drive (passes alone).

## Closed on 2026-09-19 — four of these were never open

This list had gone stale, and a session that trusts it re-derives work that is already done. What
was checked, and what it turned out to be:

- **pi `session:auth-required` — was REAL, now built.** The premise that pi's wire carries no
  distinguishable auth error is false. A rejected turn ends `stopReason:'error'` with the HTTP
  status at the head of `errorMessage`, in an adapter-specific shape: `anthropic-messages` writes
  `401 {json}`, `openai-responses` writes `OpenAI API error (401): {json}`, and a 403 can arrive
  with no body at all. Probed against the vendored 0.84.3 binary; see the classifier in
  `core/pi/event-mapper.ts`.
- **pi's PKCE port 1455 — was never open.** pi has no PKCE path of its own; its only driven login
  is `openai-codex`, which delegates to the same `CodexLoginFlow` F2 fixed. Pinned by
  `src/main/auth/vault/__tests__/PiLoginLoopback.test.ts`.
- **The fork sweep's negative cache — was never open.** The db v17 lineage cache already
  tombstones a twice-refused id as `(null, null)`, `listCodexLineage()` returns tombstones, and
  `cache.has(id)` therefore suppresses re-probing in the `new` and `changed` modes; `all` runs
  only after a refused delete. Pinned by `codex-app-server.integration.test.ts`.
- **The JSON-null class in the command modules — was REAL, now fixed.** Two of twenty optional
  parameters actually broke. `shared-provider:set-default` was live and user-visible: clearing a
  default model from the web client threw `Invalid shared provider routes` and cleared nothing.
- **Cross-engine dispatch on the item lane — verified live.** Claude→opencode, Claude→pi,
  Claude→codex and pi→Claude all stream incrementally; replica canonical never ran ahead of the
  store. `TaskCard.sendToBackground` is absent on dispatch cards BY DESIGN (`canBackground` ends
  in `&& !isDispatch`), and `TaskCard.openInPanel` renders only in the collapsed footer — neither
  is a drop.
- **Windows signed-in turn / sandbox / process tree — already recorded in
  [`architecture/codex.md`](architecture/codex.md), and re-confirmed.** That file has carried the
  2026-09-14 Windows x64 result all along: there is no Windows sandbox in 0.154.0, so every
  command runs unsandboxed. Re-confirmed 2026-09-19 on GPT-5.6-Luna, including process-tree
  cleanup with one and with three concurrent sessions — nothing orphaned either time, detached
  grandchildren included. **Note ClaudeUI logs no sandbox or turn-policy line on the codex path**,
  so the sandbox question cannot be answered from the log today; `WireLog` exists only for the
  Claude SDK.
- **The `SettingsDialogView` `format:check` flake — was a misdiagnosis.** That file is clean. The
  failure came from an untracked scratch worktree under `.claude/worktrees/` leaking into
  prettier's scan, plus one tracked mockup committed unformatted. Both fixed; the directory is now
  ignored.

**Roadmap, remaining:** (3) metering attribution inside the usage revamp; (4) grandchild rendering. Items (1) history mappers + cross-harness tool survey and (2) per-item volatile streaming are closed — see [`tool-survey.md`](tool-survey.md) and [`per-item-streaming-design.md`](per-item-streaming-design.md). Then the Rename → Orrery arc.

## Rulings that still bind

- **Codex executes, ClaudeUI decides** (ADR-067): plan/default/acceptEdits run `untrusted` with our evaluator answering every request; `auto` runs `on-request` with Codex's native `auto_review` guardian, and no ClaudeUI allow rule is consulted under `auto`. Approving a command runs it unsandboxed; so does an execpolicy `allow`.
- **Guardian visibility:** every completed review is visible, a denial can be reversed from the declined card via `thread/approveGuardianDeniedAction` with no pop-up. A judge's verdict renders on the card it judged (chip in the header, strip when expanded); the system row is kept only for target-less reviews and warnings.
- **Execpolicy rules file:** user-scope Bash rules only → `~/.codex/rules/claudeui.rules` (deny as `forbidden`, allow as `allow`), regenerated on boot and on rule writes; project-scope rules do not bind on Codex. Per-session rule mapping and project deny rules: deferred design discussion.
- **Account switch semantics are NOT unified and need nothing built** (2026-09-16): a Claude switch cancels every live Claude session (`invalidateLiveSessions`, ADR-015); a Codex switch disconnects every session that FOLLOWS the active account (ADR-069 §4); a session PINNED to an account is left alone. The Accounts page states each rule. "ChatGPT workspace" is the wording wherever a workspace is a ChatGPT organisation.
- **Queue:** application-held via `turn/steer` with `expectedTurnId`, never Codex's native next-turn queue; honest recall; reconcile by id after an ambiguous timeout, no blind resend (ADR-053).
- **Delete walks the branch tree** leaf-first after a confirmation listing the branches, stopping at the first refusal; archive stays unused. An interrupted hosted-tool call gets a synthesized failed result live and no cold-history supplement.
- **Cost is nullable:** unknown, never $0, for an unpriced model. Capabilities are true only when the whole path works (ADR-030).
- **`--disable-auth` web-client dead-end: ignore.** No `off` route for the browser client.
- **Same-engine dispatch stays refused for Codex.** The ADR-068 "caller pin reaches the target" plumbing stays as is.
- **A dispatched agent runs until the USER's limit** (2026-09-18, ADR-033's amendment of that date): only a user stop, a caller abort, `dispatch.turnTimeoutMs`/`idleTimeoutMs`, or `dispatch.maxCostUsd` ends a dispatched turn early. Empty or `0` for either time limit means NO limit, in every direction. `AppSettings.dispatchMaxConcurrent` (Settings › Cross-engine dispatch › Concurrency) is read at the gate on every dispatch — unset keeps the long-standing 3, `0` means no limit.
- **The desktop app's MCP servers and `openai-bundled` plugins stay off ClaudeUI threads** — detected in the user's config and disabled per thread through the deep-merged `config` override, with the nine desktop feature flags off as hygiene.
- Pinned binary 0.154.0 over stdio; native-owned auth with upstream refresh concurrency accepted; the fixture provider's fabricated vault writer is test tooling only.

## Drive recipes (no credential, no spend)

- **Isolated profile:** `CLAUDEUI_TEST_HOME=<home>`, `CODEX_HOME=<home>/.codex`, `CLAUDE_UI_LOG_DIR`, `CLAUDEUI_VERIFIER_HOOKS=1`, `CLAUDE_UI_LOG=CodexAppServerClient,CodexHost`, `CLAUDEUI_CODEX_STDERR=1`; the fixture provider from `scripts/codex-fixture-provider.mjs` on that Codex home. Windows uses `-r home-shim.cjs`; macOS uses `.cache/app-shot-home.mjs` (a copy of `scripts/app-shot.mjs` whose launch prepends `APP_SHOT_ELECTRON_ARGS`, `;`-separated, importing from `../scripts/`) with `APP_SHOT_ELECTRON_ARGS="-r;<shim>"`.
- **Store calls** through `window.__claudeuiVerifier.sessionStore`: `createNewSession` + `setSelectedEngine('codex')` starts a session on a home that lists no directory; `closeSignIn()` closes the sign-in dialog. `--state` prints the renderer store and the replica canonical.
- **A stored ChatGPT account:** run the fixture with `--chatgpt --vault-home <CLAUDEUI_TEST_HOME> --accounts <n>`. It serves `chatgpt_base_url` as well as `openai_base_url`, answers the binary's own `/backend-api/*` and `GET /v1/models` with `404 {"error":"fixture"}`, accepts the injected bearer, decodes gzip (Windows) or zstd (macOS) bodies, and writes the fabricated v3 vault itself (it refuses `os.homedir()`). `node scripts/codex-render-stress.mjs --accounts 1` does the whole thing. WITHOUT those flags a fabricated vault account starts the host under an injected identity whose backend calls go to the real chatgpt.com and it dies within seconds; a drive that needs no account runs with NO vault file so the identity resolves to `native`.
- **Render-loss stress:** `node scripts/codex-render-stress.mjs --iterations 20 --load --home <fresh>` after `bun run build`.
- **Gotchas:** a `disconnected` status projects as `state: 'idle'` + `sdkActive: false` (ADR-045), so assert `sdkActive`, never the state string. Playwright must be imported from the repo's `node_modules` by absolute path when the script lives outside the repo, and `_electron` arrives on the CJS `default`. Key presses do not reach the headless window (mode changes cannot be driven; the jsdom test covers them).

## Real-provider testing

Real provider turns run only under the maintainer's own explicit authorization, which is deliberately not recorded here. When they are authorized, these are the rules: light usage — a few short turns per check, GPT-5.6 Luna by default, GPT 6 only for what Luna lacks. Run them in a scratch directory outside this repo (`README.txt`, `hello.py`; recreate if gone), never in the repo itself; default mode unless the slice is about Auto; one benign command per check; never read `~/.codex` files or echo tokens; no login or logout while an account is signed in. Harness drives inherit the global default mode and Codex's default model, so pin the model through the picker when the rules call for Luna. Real-turn drive (about 45 s):

```sh
bun run build
node scripts/app-shot.mjs --timeout 200000 --out .cache/screenshots/codex-turn.png \
  --click '[data-testid="EnginePicker.trigger"]' --click '[data-testid="EnginePicker.option"][data-engine="codex"]' \
  --click '[data-testid="WelcomeState.selectDirectory"]' --click '[data-testid="WelcomeState.directory"]:has-text("claudeui-codex-scratch")' \
  --click '[data-testid="InputBox.textarea"]' --type 'Run ls and tell me in one sentence what files are here. Do not modify anything.' \
  --click '[data-testid="InputBox.send"]' --wait 40000 --state --settle 500
```

## Credential boundary

The sanitized status probe is `node scripts/codex-native-status.mjs` (it returned `{"authenticated":true,"authKind":"chatgpt","requiresLogin":false}`). Never run bare `codex login status` visibly (its API-key path can print key fragments). Never read native auth files or vault material into tool output. Implementing and verifying agents get no real credential access and no real turns; every integration test uses an isolated `CODEX_HOME` with a fake key and the scripted localhost provider. `rules-sync.ts` writes to the real `~/.codex/rules/claudeui.rules` only after core boot arms it. The app-server stderr capture (`CLAUDEUI_CODEX_STDERR=1`, `<log dir>/codex-stderr-<pid>.log`) is opt-in: treat that file like `~/.codex` contents, read it only to diagnose a death, never paste it anywhere. `CodexService.startLogin`'s app-server is the only one outside the host registry and must run uninjected.

## Findings and invariants worth remembering

- The writer lock is PROCESS-scoped: a loaded thread refuses every other app-server's `thread/resume` and `thread/delete` with `-32600` while the holder may delete its own; the binary unloads a thread about 60 s after its last subscriber leaves, so a cross-host resume rides a bounded retry. Ending stdin exits the server in ~13 ms with an idle thread. A `disconnected` session is renderable; a killed host's turn comes back marked `interrupted`. A same-host resume rejoins the loaded thread and continues its response chain (`previous_response_id`, no tool list on the wire).
- Codex wraps every model command as `<shell> -lc <script>`; `unwrapShellCommand` strips exactly one wrapper of the shape Codex's own `extract_bash_command` accepts before gating and suggesting.
- Under `auto` no approval request reaches the client; only `item/autoApprovalReview/*` and `guardianWarning` do. Reviews are not thread items and do not survive into cold history; a real denial run emits the review BEFORE the target's `item/completed`. Three consecutive guardian denials interrupt the turn. Under `untrusted` Codex still runs commands it deems safe without asking, root or child.
- Real catalog models are `tool_mode: code_mode_only` and need `codex-code-mode-host` beside `codex`; the fixture's `mock-model` is not code-mode. `config/batchWrite` does not validate keys against the schema; `browser_use.enabled` does not exist on 0.154.0, the switches are `features.browser_use` / `features.computer_use`. `[tools]` entries are structs, not booleans. A per-thread `config` override on `thread/start` is honoured for `features` and `mcp_servers` (spike Q3; `thread/resume` and `thread/fork` accept the same `config` field).
- Codex loads `rules/*.rules` once per thread at start/resume; project-layer rules load only for trusted projects. `thread/settings/update` returns `{}` and acknowledges out of band; policy no longer uses it, effort does.
- Native `thread.id` is conversation identity; transcript ids are thread/turn/item; pending approvals also carry the process generation. Branching seeds the new session locally and the native `thread/fork` happens on the FIRST prompt; a branch never prompted is not a Codex thread. Native delete of forks is leaf-first; a fork is absent from `thread/list` only until it has run a turn. `thread/read`'s not-found shares `-32600` with a transient miss, so a refusal counts only when a second spaced read confirms it.
- The model, not the feature flag, picks the collab surface (`multi_agent_version_for_model`): Luna and older take v1 (`collabAgentToolCall`), Astra/Sol/Terra/Daybreak take v2 (`subAgentActivity`, spawn requires `task_name`). No `thread/started` is emitted for a spawned child; hold its early notifications until the spawn item binds it. A child spawned after a mode switch inherits the NEW policy; a running child and a child spawned later in the same in-flight turn do not. A parent `turn/interrupt` does not cascade to children.
- `dynamicTools` is accepted on `thread/start` only; resume and fork restore the specs from the rollout's SessionMeta; children never inherit them.
- The v2 wire is camelCase where the core deserializes snake_case (`GuardianAssessmentEvent`, `apply_patch`, `unified_exec`); anything sent back to the core needs the mapping.
- `BaseSession.flushQueuedItems` drops a boundary signal that arrives while a forward is in flight; Codex chains boundaries on its own promise, opencode and pi still call it blind.
- A session under an injected ChatGPT identity sends its model requests compressed (gzip on Windows, zstd on macOS). Sandbox enforcement cannot be measured in the fixture (macOS refuses to nest a seatbelt profile).
- Every engine and every cross-engine dispatch target uses the per-item volatile lane: reliable open, chunk-only append, reliable resolved final seal. The session stream lane no longer exists. Native history remains authoritative after cold reload.

## Verification commands and artifacts

```sh
bun run typecheck && bun run lint && bun run test
CODEX_INTEGRATION=1 bun run test:integration src/integration/codex   # macOS arm64: app-server, delete, interrupted-tool, lifecycle, host suites
bun run check-codex-protocol
bun run build
git diff --check && bun run format:check
```

Vendored binaries `vendor/codex-cli/codex` and `codex-code-mode-host` (gitignored, digests in `scripts/codex-digests.json` — macOS arm64, Windows x64, Linux x64 and Linux arm64). Source checkout `.cache/codex-src` (0.154.0). `scripts/app-shot.mjs` has `--wait`, `--eval`, `--state`, `--timeout`; harness copies in `.cache/` can be deleted. Diagnostics: `CLAUDE_UI_LOG=CodexAppServerClient` shows every spawn with its caller label.

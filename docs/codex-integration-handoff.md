# Codex integration handoff

State on 2026-09-17. PR #37 (`codex-integration → pre-release`) merged on 2026-09-14 at `80d71efc` (v3.2.0); follow-ups land directly on `pre-release` and pushes there still need an explicit ask. Follow-ups F1–F16 are landed and recorded in [`codex-followups-spec.md`](codex-followups-spec.md) (one kickoff and one Landed paragraph each). The process model is [ADR-069](adr/adr-069_codex-host-per-home-and-account.md), built through [`codex-host-spec.md`](codex-host-spec.md) H0–H3: one `codex app-server` per Codex home and injected account, sessions are threads on it, reads borrow it, quit disposes the registry, an active-account switch moves the sessions that follow the active account. The older slice-by-slice history (ADR-066/067/068 arcs, Slices 1–7, the pre-merge checklist) lives in git history of this file (`git log -p -- docs/codex-integration-handoff.md`) and in the spec docs; nothing there is still open.

## Read in this order

1. [ADR-069](adr/adr-069_codex-host-per-home-and-account.md) — the process model as built, with § Probe answers and § As built.
2. [ADR-067](adr/adr-067_codex-shared-permission-model.md) (with its 2026-09-12 amendments) and [ADR-068](adr/adr-068_chatgpt-identity-vault-owned-codex-injection.md) (identity, accounts, config page). [ADR-066](adr/adr-066_codex-fourth-engine.md) for everything else; its native-permissions section is superseded.
3. [`codex-followups-spec.md`](codex-followups-spec.md) — F1 onwards; the open kickoffs are at the end.
4. [`codex-integration-spec.md`](codex-integration-spec.md) § "Mandatory remaining work" — the milestone record.
5. [`architecture/codex.md`](architecture/codex.md), then [`codex-spike.md`](codex-spike.md) for the binary probes.
6. [ADR-026](adr/adr-026_development-workflow.md) (amended 2026-09-17: GPT-5.6 Sol implements and a separate Sol verifier drives the app; the main model reviews code and PNGs), [ADR-030](adr/adr-030_capability-honesty.md), [ADR-038](adr/adr-038_event-driven-approval-lifecycle.md), [ADR-053](adr/adr-053_queue-item-identity-cc-parity.md), [SyncCore](architecture/sync-core.md).

## Open work

**Landed 2026-09-17:** F20 — every Codex thread item renders on both paths (web search, MCP calls, image view with bytes, image generation, sleep, the plan item on the Claude-style card with native plan mode sent on every turn, `update_plan` to the widget, hook context, review rows, compaction), plus the cross-harness fixes (structured web card for Claude and opencode, live Claude compaction, opencode compaction rows, pi full compaction summary and `custom_message`). Pushes to `pre-release` still need an explicit ask.

**Landed 2026-09-16, both reviewed and verified (Landed paragraphs in `codex-followups-spec.md`):** F17 — the Codex desktop app's MCP servers and `openai-bundled` plugins are detected in the user's config and disabled per thread through the deep-merged `config` override, with the nine desktop feature flags off as hygiene; F18 — a judge's verdict renders on the card it judged (chip in the header, strip when expanded) for Codex's auto-review and ClaudeUI's Auto-mode judge on opencode and pi, with the system row kept only for target-less reviews and warnings. Pushes to `pre-release` still need an explicit ask.

**Also landed 2026-09-16:** F19 — a detailed reasoning summary's bold headline renders as plain text, an empty summary delta no longer opens a bare "Thought", the Reasoning summaries row says it applies to new sessions, and the fixture script streams a reasoning item (`--reasoning`). Daniel still owes the real-account confirmation on a rebuilt app in a NEW session.

**Landed 2026-09-17 (F21):** roadmap item 2's approved first slice — shared per-item volatile streams, desktop/web transport and replica support, and Codex root/direct-child text, reasoning and plan adoption. Reliable open/seal events surround chunk-only volatile appends; rewatch restores the atomic active set, and interruption retains partial output. Design, as-built details and verification: [per-item streaming](per-item-streaming-design.md). Roadmap item 2 remains open: migrate Claude, opencode and pi in separate investigated slices, then retire the legacy session stream model after its last consumer migrates. Metering attribution and grandchild rendering follow that closure.

**Open, not sequenced:**

- pi raises no `session:auth-required` (no distinguishable auth error on its wire); a rejected ChatGPT credential on pi is a generic turn failure. Needs a pi wire probe (`docs/protocol-pi/`, `vendor/pi-cli/docs/`).
- pi's PKCE fallback still binds port 1455 on a headless server for its timeout (F2 fixed Codex only); two concurrent fallbacks collide.
- The identifier scrub (Daniel's).
- The fork sweep has no negative cache: permanently deleted Codex ids are re-probed on every refresh until delete prunes `session_meta`.
- Metering attribution (child vs dispatch, a pinned account's identity, double counting after rekey/resume, failed-turn spend, whether an estimated USD cap can gate dispatch) — folded into the usage-dashboard revamp.
- Linux: no Codex digest manifest, acquisition skips, provisioning and process trees unverified.
- Images in a dynamic-tool result are not rendered. Grandchildren are not rendered on any harness (not urgent).
- Render loss is instrumented (F4 audit, F5 stress loop), not root-caused; nothing seen since.
- Same-engine dispatch for opencode → opencode (and possibly pi → pi) is a later candidate; Codex → Codex stays refused (native children cover it).
- Known flakes: the Codex delete integration suite fails only under parallel load (`-32600` on a source with a loaded fork); the policy probe's `untrusted` matrix is load-sensitive; `remote-*.test.ts` port collisions; `SettingsDialogView.component.test.tsx` fails `format:check` since before the branch; `src/web/__tests__/provider-auth-hydration.component.test.tsx` throws three `EnvironmentTeardownError` unhandled rejections when `bun run test` runs beside a build or an Electron drive (three times on 2026-09-16, untouched by any slice, passes alone). Rerun alone before blaming a diff.

**Roadmap after the follow-ups (Daniel, 2026-09-14), in order:** (1) history mappers with a cross-harness tool survey — inventory every tool and method each harness exposes (cli.js `docs/protocol-cc/`, opencode `vendor/opencode-src`, pi `docs/protocol-pi/`, Codex `protocol/v2/ThreadItem.ts` + the notification catalog in `codex-spike.md`) against ClaudeUI's card vocabulary BEFORE writing a mapper, then map `webSearch`, `imageGeneration`, `imageView`, `plan`, `contextCompaction`, `functionCallOutput`, `hookPrompt`, `enteredReviewMode`/`exitedReviewMode`, `sleep`; (2) per-item volatile stream — design note and discussion before code (touches SyncCore's per-session stream protocol, the replica projection, every client); (3) metering attribution inside the usage revamp; (4) grandchild rendering. Then the Rename → Orrery arc.

## Rulings that still bind

- **Codex executes, ClaudeUI decides** (ADR-067): plan/default/acceptEdits run `untrusted` with our evaluator answering every request; `auto` runs `on-request` with Codex's native `auto_review` guardian, and no ClaudeUI allow rule is consulted under `auto`. Approving a command runs it unsandboxed; so does an execpolicy `allow`.
- **Guardian visibility:** every completed review is visible (B), a denial can be reversed from the declined card via `thread/approveGuardianDeniedAction` with no pop-up (C). F18 changes WHERE the verdict renders, not this.
- **Execpolicy rules file:** user-scope Bash rules only → `~/.codex/rules/claudeui.rules` (deny as `forbidden`, allow as `allow`), regenerated on boot and on rule writes; project-scope rules do not bind on Codex. Per-session rule mapping and project deny rules: deferred design discussion.
- **Account switch semantics are NOT unified and need nothing built** (2026-09-16): a Claude switch cancels every live Claude session (`invalidateLiveSessions`, ADR-015); a Codex switch disconnects every session that FOLLOWS the active account (ADR-069 §4); a session PINNED to an account is left alone. The Accounts page states each rule (`87e98444`). Layout is option 1 (one Accounts page, per-provider groups, Codex chip on the ChatGPT row; F14). "ChatGPT workspace" is the wording wherever a workspace is a ChatGPT organisation.
- **Queue:** application-held via `turn/steer` with `expectedTurnId`, never Codex's native next-turn queue; honest recall; reconcile by id after an ambiguous timeout, no blind resend (ADR-053).
- **Delete walks the branch tree** leaf-first after a confirmation listing the branches, stopping at the first refusal; archive stays unused. An interrupted hosted-tool call gets a synthesized failed result live and no cold-history supplement.
- **Cost is nullable:** unknown, never $0, for an unpriced model. Capabilities are true only when the whole path works (ADR-030).
- **`--disable-auth` web-client dead-end: ignore.** No `off` route for the browser client.
- **Same-engine dispatch stays refused for Codex.** The ADR-068 "caller pin reaches the target" plumbing stays as is.
- Pinned binary 0.154.0 over stdio; native-owned auth with upstream refresh concurrency accepted; the fixture provider's fabricated vault writer is test tooling only (F16).

## Drive recipes (no credential, no spend)

- **Isolated profile:** `CLAUDEUI_TEST_HOME=<home>`, `CODEX_HOME=<home>/.codex`, `CLAUDE_UI_LOG_DIR`, `CLAUDEUI_VERIFIER_HOOKS=1`, `CLAUDE_UI_LOG=CodexAppServerClient,CodexHost`, `CLAUDEUI_CODEX_STDERR=1`; the fixture provider from `scripts/codex-fixture-provider.mjs` on that Codex home. Windows uses `-r home-shim.cjs`; macOS uses `.cache/app-shot-home.mjs` (a copy of `scripts/app-shot.mjs` whose launch prepends `APP_SHOT_ELECTRON_ARGS`, `;`-separated, importing from `../scripts/`) with `APP_SHOT_ELECTRON_ARGS="-r;<shim>"`.
- **Store calls** through `window.__claudeuiVerifier.sessionStore`: `createNewSession` + `setSelectedEngine('codex')` starts a session on a home that lists no directory; `closeSignIn()` closes the sign-in dialog. `--state` prints the renderer store and the replica canonical.
- **A stored ChatGPT account:** run the fixture with `--chatgpt --vault-home <CLAUDEUI_TEST_HOME> --accounts <n>` (F16). It serves `chatgpt_base_url` as well as `openai_base_url`, answers the binary's own `/backend-api/*` and `GET /v1/models` with `404 {"error":"fixture"}`, accepts the injected bearer, decodes gzip (Windows) or zstd (macOS) bodies, and writes the fabricated v3 vault itself (it refuses `os.homedir()`). `node scripts/codex-render-stress.mjs --accounts 1` does the whole thing. WITHOUT those flags a fabricated vault account starts the host under an injected identity whose backend calls go to the real chatgpt.com and it dies within seconds; a drive that needs no account runs with NO vault file so the identity resolves to `native`.
- **Render-loss stress:** `node scripts/codex-render-stress.mjs --iterations 20 --load --home <fresh>` after `bun run build` (D1). D2–D5 (three concurrent sessions on one host; the active-account switch through the real `ProviderSheet` radio; a killed host; six idle minutes counting spawns) were scratchpad scripts modelled on it.
- **Gotchas:** a `disconnected` status projects as `state: 'idle'` + `sdkActive: false` (ADR-045), so assert `sdkActive`, never the state string. Playwright must be imported from the repo's `node_modules` by absolute path when the script lives outside the repo, and `_electron` arrives on the CJS `default`. Key presses do not reach the headless window (mode changes cannot be driven; the jsdom test covers them).

## Real-provider testing

Daniel authorized real Codex turns on his signed-in ChatGPT account, light usage: a few short turns per check, GPT-5.6 Luna by default, GPT 6 only for what Luna lacks. Run them in `/private/tmp/claudeui-codex-scratch` (`README.txt`, `hello.py`; recreate if gone), never in this repo; default mode unless the slice is about Auto; one benign command per check; never read `~/.codex` files or echo tokens; no login or logout while an account is signed in. Harness drives inherit the global default mode and Codex's default model, so pin the model through the picker when the rules call for Luna. Real-turn drive (about 45 s):

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
- Codex text/reasoning/plan deltas use the per-item volatile lane (F21): reliable open, chunk-only append, reliable resolved final seal. Other engines still use the session stream lane. Native history remains authoritative after cold reload.

## Verification commands and artifacts

```sh
bun run typecheck && bun run lint && bun run test
CODEX_INTEGRATION=1 bun run test:integration src/integration/codex   # macOS arm64: app-server, delete, interrupted-tool, lifecycle, host suites
bun run check-codex-protocol
bun run build
git diff --check && bun run format:check
```

Vendored binaries `vendor/codex-cli/codex` and `codex-code-mode-host` (gitignored, digests in `scripts/codex-digests.json`, macOS arm64 and Windows x64). Source checkout `.cache/codex-src` (0.154.0). `scripts/app-shot.mjs` has `--wait`, `--eval`, `--state`, `--timeout`; harness copies in `.cache/` can be deleted. Diagnostics: `CLAUDE_UI_LOG=CodexAppServerClient` shows every spawn with its caller label (F9).

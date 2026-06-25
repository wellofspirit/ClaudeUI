# ClaudeUI V2 — Roadmap & Pending Work (North Star)

> **Single source of truth for what's left.** Replaces the old `HANDOFF.md` (stale at Phase 7) and
> `implementation-plan.md` (sequencing complete). V2 is **feature-complete**: all plan phases (0–7)
> plus the opencode interaction series (8a–8e) and the usage-analytics follow-ups (9a–9b) landed and
> are pushed. What remains is the set of explicitly-deferred follow-ups tracked below — each verified
> against the current code (2026-06-23 reconciliation sweep) — and the **workflow** we follow to clear
> them.
>
> Read this first, then the relevant `0X-*.md` foundation doc and any `phase-*.md` kickoff for the
> area you're touching. The foundation docs (`01..06`, `persistence.md`) + ADR-018..024 remain the
> locked design spec; this doc only tracks the delta.

---

## How we work (follow this exactly)

This is the loop that built all of V2 and is the loop we keep using. **The main model (Opus) is the
orchestrator and reviewer; a Sonnet sub-agent writes the code.** Never let the implementing agent
self-certify — the main model owns correctness.

1. **Scope.** Main model reads the relevant foundation doc(s) + ADR(s), recons the current code
   (grep/read) to ground the change and gauge blast radius, and **de-risks external/native
   dependencies first** (probe the opencode binary, the cli.js wire, the DB ABI — don't design around
   assumptions).
2. **Decide the forks with the user.** For genuine forks (depth, behavior-preserving vs
   structure-ready, library choices), use `AskUserQuestion` with a clear recommendation. The user has
   consistently chosen the fuller, structure-ready option — design for the V2 target, not a shim.
   Don't re-ask settled things.
3. **Write a kickoff spec** (mirror an existing `phase-*.md`): scope decisions with the chosen forks,
   a precise file/seam map, verified facts so the agent doesn't re-discover, an explicit out-of-scope
   list, step-by-step, verify gates, gotchas, and a suggested commit message.
4. **Branch** off the current integration tip.
5. **Dispatch the Sonnet agent** (`Agent` tool, `subagent_type: general-purpose`, `model: sonnet`).
   Point it at the spec. Tell it explicitly: **do NOT commit / `git add` / create branches; do NOT
   `bun install`** (see Standing constraints); leave the working tree for review; report deltas, exact
   verify-gate output, and any deviations from the spec.
6. **Review every single line** of the agent's diff (`git diff <base>`). Read the actual code, not the
   agent's summary. Run independent checks (re-run gates, grep, probe the wire). Hunt the subtle bugs —
   every phase surfaced at least one real one (a model-picker regression, dead persisted data, a vacuous
   migration test, an `acquire()` race, a per-frame token overcount, a wrong auth-source mapping).
   **Verify the agent's tests actually test what they claim** — make it prove a guard test fails against
   the pre-fix code.
7. **Send fixes back** via `SendMessage` to the agent's id (it resumes with context). Categorize:
   required / minor / accept-with-note. The agent fixes; **re-review the fixes**; iterate until clean
   (1–3 rounds is typical).
8. **Verify against the real dev build.** All gates must pass:
   `bun run typecheck && bun run test && bun run test:ci && bun run lint && bun run build`
   (0 lint errors; 3 pre-existing `exhaustive-deps` warnings in Sidebar/ExitPlanModeCard/ReviewBar are
   OK). Then, for any UI/behavior change, the main model **dispatches a subagent to drive the real
   Electron app** via the `verifier-electron` skill (`node scripts/app-shot.mjs`): launch the built
   app, screenshot it, assert the live DOM, drive clicks — and **read the PNG** to confirm the behavior.
   Headless/infra changes get a gated or integration smoke instead. Tests passing is necessary but not
   sufficient; we confirm it works in the actual app.
9. **Commit + push** — one commit per item, after review is clean. `git add -A`, descriptive
   multi-paragraph message (subject + body), **no AI attribution / no Co-Authored-By**.
   `git push -u origin <branch>`.
10. **Update memory + this doc** — record the result, mark the item done here (move it to *Verified
    resolved*), and capture any new gotcha. Then `AskUserQuestion`: next item / open PR / pause.

**Cadence:** spec → branch → dispatch → review↔fix loop → verify (gates + real-app drive) → commit+push
→ update doc. The implementing agent never commits; the main model commits only after the review loop
and the real-build verification are both clean.

---

## Pending items

Every item below was re-verified against current code on 2026-06-23. Status legend:
🔴 correctness risk · 🟠 user-visible gap · 🟡 structural/feature · ⚪ cosmetic / cleanup / test / process.

| # | Item | Risk | Area | Effort |
| --- | --- | --- | --- | --- |
| 8 | opencode **voice** input | 🟡 | voice | M |
| 10 | Fold **FloatingApproval** into shared `<ApprovalButtons>` | ⚪ | tool rendering | S |
| 11 | Tool-rendering **coverage polish** — structured **search/web** only (a/b); c/d/e shipped | ⚪ | tool rendering | S |
| 13 | opencode **end-to-end render** verification (test gap) | ⚪ | testing | M |
| 14 | Retire legacy **JSONL usage** parse path | ⚪ | metering | M |
| 15 | Consolidate opencode `/event` to **one subscription per server** | ⚪ | opencode transport | S |
| 16 | Open the **V2 PR stack** (process, not code) | ⚪ | process | — |

> ✅ **#9 shipped 2026-06-24** (`v2-followup-tool-rendering-lift`) — engine-neutral lifting of
> plan/question/todo/task + opencode todo fix. See *Verified resolved*.
>
> ✅ **#1, #2, #3, #5, #7 shipped 2026-06-23; #4 shipped 2026-06-24** — subagent questions (#1,
> `v2-followup-subagent-questions`); the opencode auth-UX cluster (#2 re-login card + #7 native browser
> OAuth, `v2-followup-opencode-auth-ux`); opencode status-line usage + cost gating (#3,
> `v2-followup-opencode-statusline`); opencode reasoning (effort-variant) picker (#5,
> `v2-followup-opencode-reasoning`); opencode hosted tools via on-the-fly MCP (#4,
> `v2-followup-opencode-mcp-onthefly`). See *Verified resolved*. Those IDs are retired (remaining rows
> are **not** renumbered).
>
> Background/detached opencode subagents are **not** listed: opencode itself gates them behind
> `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` (`tool/task.ts:98-102`), so it's upstream-experimental,
> not our deferral. Revisit only if opencode promotes it.

---

### 6 — ✅ DONE — Vendor editing UI + ModelRef-derived vendor at spawn

Both halves shipped: the Anthropic vendor-editing UI (`v2-followup-settings-ia`, 2026-06-25) and the
ModelRef-derived vendor at spawn (`v2-followup-opencode-settings`, 2026-06-25). See *Verified resolved*.

---

### 8 — opencode voice input 🟡

**What.** Voice input is Claude-only. `OPENCODE_ENGINE_CAPABILITIES.voice` is `false`
(`model-capabilities.ts`) and there's no opencode voice wiring; the voice-capture path
(`voice-capture.ts`/`voice-client.ts`) only feeds the Claude input flow.

**Why deferred.** Phase 5b set non-core opencode caps false for the chat MVP.

**Definition of done.** Route transcribed voice into the opencode prompt path (it's engine-neutral text
input once transcribed), flip the capability true, and gate the mic UI on `capabilities.voice` so it
appears for opencode sessions. Mostly wiring — the transcription stack is engine-agnostic.

**References.** `phase-5b-opencode-chat.md:283`, `model-capabilities.ts`, `voice-capture.ts`,
`voice-client.ts`, `OpencodeSession.ts` (prompt path).

---

### 10 — Fold FloatingApproval into shared `<ApprovalButtons>` ⚪

**What.** Phase 6 extracted `<ApprovalButtons>` (3 call-sites → 1) for in-line tool-card approvals, but
`FloatingApproval`'s `ApprovalCardView` still has its **own** inline Deny / Allow-for-session / Allow
button JSX (`FloatingApproval.tsx:138-163`) — it does not consume the shared component. So there are two
approval-button renderers to keep in sync. *(My earlier audit wrongly called this resolved; the file
confirms FloatingApproval stands apart.)*

**Why deferred.** Phase 6 noted it as a dedup follow-up; the floating *card* (positioning + the
unmatched-approval filter, `FloatingApproval.tsx:172-199`) is genuinely separate, but the *buttons*
inside it can still share `<ApprovalButtons>`.

**Definition of done.** Replace the inline button block in `ApprovalCardView` with `<ApprovalButtons>`
(threading `showAllowForSession` + the decision handler), keeping the floating container and filter.
Pure refactor; app-shot the floating card as pixel-equivalent.

**References.** `FloatingApproval.tsx:138-163`, `ApprovalButtons.tsx`, `phase-6-tool-registry.md`.

---

### 11 — Tool-rendering coverage polish ⚪ (c/d/e shipped; a/b remain)

**Shipped 2026-06-24** (`v2-followup-tool-rendering-polish`, see *Verified resolved*):
- **(c) fileEdit single-diff** — the diff renders exactly once (was twice: input + result).
- **(d) truncation + show-more** — `<ExpandableText>` + a `toolOutputMaxChars` setting (default 5000)
  replace the hardcoded `trunc(2000/5000)` cuts; full text revealed on expand (no data loss).
- **(e) per-kind display metadata** — card name + summary come from `EngineToolMap.displayName` +
  `summarizeTool(kind, view)` instead of the Claude-hardcoded `getSummary`/raw `toolName`. Fixes
  opencode's raw lowercase labels + JSON-blob summaries. Claude byte-identical (equivalence-tested).

**Still deferred — (a)/(b) structured results:**
- **(a) search** (Grep/Glob) — JSON-dump input + generic terminal output, not a structured match list
  (file · line · highlighted text). Still `GenericBody`.
- **(b) web** (WebFetch/WebSearch) — raw, not structured title/url/snippet. Still `GenericBody`.

**Why a/b deferred.** Most cosmetic + brittle (parsing freeform result text across engines/output
modes); lowest value-per-risk. The generic fallback renders them acceptably.

**Definition of done (remaining).** Structured `search` match-list + structured `web` results, with the
generic body as fallback. Per-kind; can be split. Requires extending the `search`/`web` ToolViews to
carry parsed matches/results (today they carry only the input `query`/`target`).

**References.** `06-tool-rendering.md §9`, `tool-registry/kinds/{GenericBody}.tsx`,
`followup-tool-rendering-polish.md`.

---

### 12 — ✅ DONE — Per-section capability gating in Settings

Shipped 2026-06-25 (`v2-followup-settings-12-caps`). `EngineCapabilities` grew `sandbox`/`proxy` flags
(Claude both true, opencode both false), and the settings shell gates each scope's section visibility on
the scope-engine's caps via `SECTION_CAPABILITY` + `isSectionVisible`. Zero user-visible change today
(Claude all-true; opencode has no sandbox/proxy sections) — structure-ready. See *Verified resolved*.

---

### 13 — opencode end-to-end render verification ⚪ (test gap)

**What.** opencode tool rendering is **unit-verified only** — the `verifier-electron` app-shot can't
type a prompt, and no e2e/integration test drives a live opencode turn and asserts the rendered tool
cards in the DOM. `src/integration/opencode/` covers server lifecycle, not rendering.

**Why deferred.** Phase 5b/6 verified opencode mapping at the unit level; a full driven e2e was out of
scope.

**Definition of done.** An integration test (gated, real binary) that runs an opencode free-model turn
producing a tool call and asserts the correct kind body renders, plus an approval round-trip. Closes the
"opencode chat is only unit-verified" gap noted since 5b.

**References.** `phase-5b-opencode-chat.md`, `phase-6-tool-registry.md`, `src/integration/opencode/`,
`docs/testing-strategy.md`.

---

### 14 — Retire the legacy JSONL usage parse path ⚪

**What.** Phase 7/9 moved metering onto the SQLite `usage_event` table but kept the legacy ingestion "a
release as fallback." The Claude JSONL scan (`block-usage.ts:1442+`, `~/.claude/projects/**/*.jsonl`)
is still the **primary intake** — it parses, upserts into `usage_event`, then reads back via SQL — and
legacy JSON daily-summary files are still written (`block-usage.ts:~1879`).

**Why deferred.** Intentional safety margin while the DB path proves out.

**Definition of done.** Once the DB path is field-proven, make the reconciler the only JSONL reader
(first-run backfill) and the steady-state read path pure SQL; stop writing legacy daily JSON. Confirm
dashboard + sidebar wheel + WLS projection unaffected. Lowest urgency — it's the safety net.

**References.** `phase-7-metering.md`, `phase-9-usage-analytics.md:200`, `block-usage.ts`,
`usage-reconciler.ts`, `usage-aggregation.ts`.

---

### 15 — Consolidate opencode `/event` to one subscription per server ⚪

**What.** The opencode server is shared per-cwd (ref-counted, `OpencodeServerManager`), and the
`/event` stream already multiplexes all sessions (filtered by `properties.sessionID`). But each
`OpencodeSession` consumes events through its own client subscription rather than a single shared
server-level subscription fanned out to sessions. Functionally correct (and the original "per-session,
optimize later" note overstated the cost); a single shared subscription per server is a minor
efficiency/cleanliness win.

**Why deferred.** 5b MVP — correctness over optimization.

**Definition of done.** One `/event` subscription per server process, demultiplexed to the registered
sessions/children by `sessionID`. No behavior change; fewer open streams under many concurrent sessions
on one cwd. Genuinely optional.

**References.** `phase-5b-opencode-chat.md`, `OpencodeServerManager.ts`, `OpencodeClient.ts` (`/event`),
`event-mapper.ts` (sessionID routing).

---

### 16 — Open the V2 PR stack ⚪ (process)

**What.** The entire V2 work is built as **stacked branches** (`v2-phase-N-…`), each off the previous,
all pushed — but **no PRs are open**. The plan's review gates were after Phase 1 (passed) and Phase 5
(the whole opencode engine, overdue). Integration base is `codex-sup`.

**Definition of done.** Open the stacked PR(s) for review (at minimum the Phase-5 gate), or decide on a
squash/integration strategy for landing the stack. Not code — a process decision for you.

---

## Verified resolved since the original inventories (stale follow-ups — now closed)

Prior session inventories (pre-Phase-8/9) listed these as deferred; the 2026-06-23 sweep confirms they
shipped. Recorded here so they're not re-raised:

- **Per-section capability gating in Settings** (ROADMAP #12, shipped 2026-06-25,
  `v2-followup-settings-12-caps`) — `EngineCapabilities` grew `sandbox` + `proxy` boolean flags (Claude
  both true, opencode both false — it has its own provider config), threaded through
  `resolveCapabilities`. The settings shell now gates each scope's section visibility on the scope-engine's
  static caps: `SECTION_CAPABILITY` (sectionId → required flag) + `scopeCapabilities(scope)` +
  `isSectionVisible(id, caps)`, applied in `View.tsx` (left list + active-section resolution) and
  `firstSectionOfScope`. **Zero user-visible change today** (Claude is all-true so sandbox/proxy still
  show; opencode's scope has no sandbox/proxy sections) — it's structure-ready for an engine that lacks a
  launch-param surface. Guarded by a non-vacuous unit test (a hypothetical no-sandbox engine hides those
  sections while ungated sections stay). Closes the settings-refactor chapter. Spec: ROADMAP §12.
- **opencode settings in the UI (no-JSON) + ModelRef vendor-at-spawn** (settings refactor phase 2 +
  ROADMAP #6 completion, shipped 2026-06-25, `v2-followup-opencode-settings`) — the opencode tab now
  carries native opencode config so users stop hand-editing JSON: **Models** (default + small model),
  **Providers** (custom OpenAI-compatible providers — id + base URL + model list — plus disabled/
  enabled-only provider lists), and **Agents** (per-agent model + temperature). Stored in
  `engines/opencode.json` (`EngineConfig.opencodeConfig`) and merged into opencode at spawn via
  `OPENCODE_CONFIG_CONTENT` — `buildOpencodeConfigContent` now **spreads in only the fields the user set**
  (clobber-safe: opencode deep-merges at priority above the user's `opencode.jsonc`, so unset fields are
  omitted and a set field intentionally overrides; `provider[id].models` mapped array→object-keyed-by-id;
  credentials never injected — API keys stay in the existing vendor-opencode auth UI / `auth.json`).
  Threaded through the ref-counted per-cwd `OpencodeServerManager` (captured at spawn). Also finishes
  **#6**: `session:create` derives the Claude vendor from the active model's `ModelRef` (`claudeModel(...)
  .vendorId` → `'anthropic'`) instead of the hardcode (no-op for Claude, structure-ready). Review caught a
  real UI bug — the provider-id input used the editable id as the React `key`, so each keystroke remounted
  the row and dropped focus (+ a UUID leaked into new rows); fixed by decoupling a stable `_key` from the
  editable `_id`, guarded by a node-identity focus test. Real-app verified: all three new sections render,
  typing a multi-char provider id keeps focus, no regression to Auto mode / Vendors. **#12
  capability-gating** remains the one deferred settings follow. Spec: `docs/v2/followup-opencode-settings.md`.
- **Settings IA refactor — tabbed scopes + Anthropic vendor editable** (settings refactor phase 1 +
  ROADMAP #6 UI-half, shipped 2026-06-25, `v2-followup-settings-ia`) — the dialog was broken: a single
  unified scroll with a tier-tree nav whose flat `SECTIONS` order had **diverged from the grouping**
  (App's `mockup` sat between Claude's `permissions`/`sandbox`; accounts/vendor interleaved Claude's
  sandbox/proxy), so the left nav no longer filtered. Replaced with **Option A** — a `SCOPES` model
  (Common / Claude / opencode tabs) where each tab renders only its sections (explicit order = the bug
  fix) in a scoped left list, with a **single focused section pane** (no unified cross-section scroll);
  scroll-spy machinery deleted. Per-item `render(...)` contract unchanged, so all section content is
  behavior-preserving. Folded in **#6's UI half**: `VendorAnthropicEditableForm` (endpoint + model
  override, nested-merge writes via `saveVendorConfig`). Dead `NAV_GROUPS`/`NavGroup` tier-tree removed.
  New `settings-scopes.unit.test.tsx` guards "every section in exactly one scope" (the bug class).
  Real-app verified: 3 tabs filter correctly, Anthropic form editable, opencode tab renders, old
  interleaving gone. **Phase 2** (separate) = ModelRef-derived vendor at spawn (rest of #6), #12
  capability-gating, and new opencode settings (custom-provider base URL, default model). Spec:
  `docs/v2/followup-settings-ia-refactor.md`.
- **Tool-rendering polish c/d/e** (ROADMAP #11 partial, shipped 2026-06-24,
  `v2-followup-tool-rendering-polish`) — (c) fileEdit renders the diff once not twice; (d) a reusable
  `<ExpandableText>` + `AppSettings.toolOutputMaxChars` (default 5000) replace the hardcoded
  `trunc(2000/5000)` cuts (full text on expand, no data loss); (e) the card name + summary come from
  `EngineToolMap.displayName` (Claude passthrough / opencode prettify map) + `summarizeTool(kind, view)`
  instead of the Claude-name-hardcoded `getSummary`/raw `toolName` — fixing opencode's raw lowercase
  labels + `JSON.stringify(input)` summaries. Claude byte-identical: a `summarizeTool === getSummary`
  equivalence guard test covers every kind, and `displayName` is a passthrough (real-app: 33 Edit cards
  one-diff each, Read/Bash/Glob/Grep/Edit headers unchanged). Structured search/web (a/b) stay deferred.
  Spec: `docs/v2/followup-tool-rendering-polish.md`.
- **Engine-neutral lifting of plan/question/todo/task** (was ROADMAP #9 🟡, shipped 2026-06-24,
  `v2-followup-tool-rendering-lift`) — the four lifted interaction kinds now consume an engine-neutral
  `ToolView` (extended with `task.subagent/model/background`, typed `question.questions: AskUserQuestion[]`,
  `todo` items + optional `activeForm`), not engine-specific `block.toolInput`. `renderToolBlock`
  computes the view once via `toolMap.normalize` and threads it to `ExitPlanModeCard`/`AskUserQuestionBlock`/
  `TodoToolBlock`/`TaskCard` (+ the `FloatingApproval` question card + the synthetic-plan user path).
  **Root-caused the reported opencode-todo no-op:** `OpencodeEngineToolMap.kindOf('todowrite')` fell to
  `unknown` (dead `list`/`patch` cases, missing `todowrite`/`websearch`/`apply_patch`/`question`/`plan_exit`),
  and the floating Todo widget was Claude-name-hardcoded (`buildTodosFromMessages`) with the
  `session:plan`/`onPlanSteps` event channel **dead — no emitter**. Fix: completed the opencode tool→kind
  map (verified every id against `opencode-src/.../tool/registry.ts`), and fed the widget from opencode's
  **`todo.updated`** bus event (`event-mapper` `case 'todo.updated'` → `{kind:'todos'}` →
  `OpencodeSession` revives `session:plan` → `setTodos`). `TodoStatus` extended with `'cancelled'` (opencode
  emits it; rendered muted/strikethrough). Claude byte-identical (app-shot: compact `TodoWrite N/M tasks`
  rows + widget unchanged; opencode todowrite now renders the same card + populates the widget). The
  question→`AskUserQuestion` mapping is currently mirrored in both normalizers + `buildQuestionApproval`
  (a small DRY debt, noted). A fully-**driven** opencode todo turn remains ROADMAP #13's gated e2e. Spec:
  `docs/v2/followup-tool-rendering-lift.md`.
- **opencode hosted tools via on-the-fly MCP** (was ROADMAP #4 🟠, shipped 2026-06-24,
  `v2-followup-opencode-mcp-onthefly`) — replaced the GLOBAL plugin install (`~/.config/opencode/plugin/`)
  with an in-process **per-cwd HTTP MCP server** (session-mode `StreamableHTTPServerTransport`, bearer
  auth) re-hosting the real `mermaid-tool.ts`/`mockup-tool.ts` impls (no duplication), injected per-spawn
  via `OPENCODE_CONFIG_CONTENT` (`{mcp:{claudeui:{type:'remote',url,headers}}}`) and lifecycle-paired with
  the ref-counted `OpencodeServerManager` (started before spawn, closed on last release/exit/dispose).
  opencode names the tools `claudeui_*`; `OpencodeEngineToolMap` classifies them → diagram/mockup. The
  global plugin + call site + electron-builder extraResources are deleted — the user's standalone opencode
  is no longer polluted. **Stateless transport mode was a trap** (review caught it: the
  `notifications/initialized` follow-up 500s with no session id) → session mode. Verified by a unit
  round-trip through opencode's exact SDK client (listTools + callTool) AND a gated integration test where
  **real opencode connects** (`claudeui.status === 'connected'`). Spec:
  `docs/v2/followup-opencode-mcp-onthefly.md`.
- **opencode reasoning (effort-variant) picker** (was ROADMAP #5 🟠, shipped 2026-06-23,
  `v2-followup-opencode-reasoning`) — the ROADMAP framed this as a "boolean toggle," but opencode
  reasoning is actually per-model effort **variants** (`model.variants`, exposed via `/config/providers`,
  gated on `capabilities.reasoning`): minimax → `none`/`thinking`, OpenAI → `none`/`low`/`medium`/`high`/
  `xhigh`, etc. model-discovery carries each model's variant keys on `ModelInfo.reasoningVariants`; the
  input box shows a `ReasoningPicker` (Default + the model's variants) for opencode reasoning models; the
  selected variant is sent as `variant` in the prompt (Default = omitted = opencode's own default),
  threaded via a `session:set-reasoning-variant` IPC + `OpencodeSession`, and reset on model change.
  Claude byte-identical (picker hidden for models without variants). Spec:
  `docs/v2/followup-opencode-reasoning.md`.
- **opencode status-line usage + cost gating** (was ROADMAP #3 🟠, shipped 2026-06-23,
  `v2-followup-opencode-statusline`) — fixed opencode sessions showing In:0 / Out:0 / Total:0 · 0%
  context: `OpencodeSession` now builds + emits `session:status-line` (StatusLineData) live on
  `cost_update` and at result — cumulative In/Out/Total from the accumulators, context-used % from the
  latest turn's `input + cacheRead` over the model's `limit.context` (captured in model-discovery), and
  the metering `contextWindow` is populated too. The status-line **cost** segment is gated on
  `Account.billingType` (hidden when `'free'`), so free models (e.g. OpenCode Zen) no longer show a
  misleading "$". Claude byte-identical. (Per-billingType *metric semantics* — subscription
  utilization%/window — remain a separate foundation-5 §6 item.) Spec:
  `docs/v2/followup-opencode-statusline.md`.
- **opencode auth-UX: native browser OAuth + interactive re-login card** (was ROADMAP #7 🟡 + #2 🟠,
  shipped 2026-06-23, `v2-followup-opencode-auth-ux`) — `method:'auto'` is driven in-app (open browser →
  await `oauthCallback` with **no code**; opencode's vendor plugin hosts the loopback/device flow, we
  host nothing), and an opencode `ProviderAuthError` now surfaces an interactive `VendorAuthRequiredCard`
  (Re-authenticate runs the native flow; Retry re-sends the last prompt). **Finding:** opencode caches
  vendor creds per server process (provider `InstanceState` reads `auth.all()` once at init; no
  invalidation on `setAuth` / `/oauth/callback`), so the post-auth Retry recreates the session to bounce
  the per-cwd `opencode serve` and re-read `auth.json` — effective for the one-session-per-cwd case; a
  shared-cwd sibling keeps the server alive so the retry rejoins the cached process (documented
  limitation). Spec: `docs/v2/followup-opencode-auth-ux.md`.
- **opencode subagent questions surfaced** (was ROADMAP #1 🔴, shipped 2026-06-23) — a child
  `question.asked` is mapped to an `AskUserQuestion` approval under the **child** tool's callID and
  rendered as a floating `AskUserQuestionBlock`; answering replies via `replyQuestion(requestId)`,
  dismissing rejects — fixing the subagent-question turn-hang (same class as the 8e permission hang).
  Spec: `docs/v2/followup-subagent-questions.md`.
- **opencode interaction caps** — `steer`, `queue`, `slashCommands`, `skills`, `subagents` are all
  `true` (`model-capabilities.ts`); built in Phases 8a (commands/skills), 8c (queue/steer), 8d
  (subagents). The old "all false in 5b" note is stale.
- **Subagent streaming** — live child output works: `handleChildEvent` emits `subagent-stream` /
  `subagent-message`, dispatched as `session:subagent-*` (8d, `event-mapper.ts`).
- **Subagent permission surfacing + child-event pre-registration race** — 8e surfaces child
  `permission.asked` and **verified the ordering guarantee** (registration always precedes child
  transcript events) so no buffering is needed.
- **WLS projection DB-sourced** — `block-usage.ts` builds projection samples from `usage_window_sample`
  via `getWindowSamples` (DB **primary**), with the in-memory ring retained only as a first-boot
  fallback (9a). The "still reads the ring" note is stale.
- **models.dev network fetch removed** — no `externalPricingStub`; pricing = built-in Anthropic table +
  opencode `/config/providers` (`pricing.ts`, `opencode-pricing.ts`) (9b).
- **opencode usage in the dashboard** — per-engine + per-model breakdown, opencode cost from its own
  reported `engineCostUsd`, opencode-idle recompute trigger (9b); subagent usage metered under the
  child's own model (9a).
- **vision/attachment** — auto-detected per opencode model caps and sent as fileParts (5b/discovery);
  works today. A *richer explicit control* is the only (low-value) remainder, folded into #5's area.
- **Error-render consistency** — `GenericBody`/`FileEditBody` now share consistent error styling (the
  "red `<pre>` inconsistency" is gone; structured-error ambition tracked under #11).

---

## Explicitly NOT doing (folded away — recorded so they're not re-litigated)

- **Daily-chart Claude-only filter** — folded away; the daily chart is intentionally all-engine per the
  locked Phase-9 layout (`UsageView.tsx:90`).
- **ChatGPT-via-opencode usage windows** — no usage API is exposed to us; cumulative meter only.
- **opencode stage-and-edit dequeue** — moot per the Phase-8c design note.
- **Claude subagent re-metering** — already correct via the JSONL per-message model.
- **Background/detached opencode subagents** — upstream-experimental (`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`);
  not our deferral. Revisit only if opencode promotes it.
- **Multi-account for opencode** — opencode has no multi-account concept; N/A.

---

## Standing constraints (carry these forward — they have bitten us)

- **NEVER `bun install` / `bun add` / `bun remove` casually.** bun's postinstall leaves `better-sqlite3`
  **Node-ABI**, which crashes the Electron app on boot (`ERR_DLOPEN_FAILED`). After any dep change run
  **`bun run rebuild:native`** (`electron-builder install-app-deps`, rebuilds to the Electron ABI).
- **Dual-ABI testing.** vitest runs in plain Node and can't load the Electron-ABI `better-sqlite3`, so
  `vitest.config.ts` aliases it → `src/test/stubs/better-sqlite3-stub.ts` (a `node:sqlite` adapter).
  DB-touching code is tested through that. Electron is **41.0.3 / Node 24.14.0** (node:sqlite is
  built-in, flagless). Never import `better-sqlite3` from renderer/shared — main process only.
- **Don't break Claude.** Claude is the daily driver and the live login path (the user is actively
  logged in — an auth-detection bug = lockout). Every change touching shared seams must be confirmed
  behavior-preserving for Claude via the real-app drive.
- **opencode specifics.** Binary (~165 MB) is gitignored (`vendor/opencode-cli/`), vendored by
  `ensure-opencode`, shipped via electron-builder `extraResources`. HTTP **Basic auth**
  (`opencode:<generated-password>`). Target the **v1** API (`/session`, `/event`, `/auth/{id}`) — NOT
  the `/api/*` v2 family. The shared `/event` stream multiplexes all sessions → filter by
  `properties.sessionID`. Binary/plugin locators use `app.getAppPath()`, not `__dirname`.
- **cli.js wire.** For any cli.js-integration question, consult `docs/protocol/` first, then probe the
  real `bun-claude` binary — cheaper and more reliable than reading minified cli.js. Use
  `/bundle-analyzer` to navigate the bundle.
- **Commits.** One per item, no AI attribution, multi-paragraph body. Branch `v2-…`, stacked, push `-u`.
- **Pre-existing lint.** 3 `exhaustive-deps` warnings (Sidebar / ExitPlanModeCard / ReviewBar) — leave
  them.

---

## Key files / entry points

- **Design spec:** `docs/v2/01..06-*.md`, `docs/v2/persistence.md`, ADRs `docs/adr/adr-018..024`,
  per-area kickoffs `docs/v2/phase-*.md`.
- **Engine seam:** `src/main/providers/` (`ISession`, `BaseSession`, `EngineRegistry`,
  `register-engines.ts`).
- **Capabilities:** `src/shared/model-capabilities.ts` (single source of truth).
- **DB:** `src/main/services/db.ts` (only better-sqlite3 importer; `user_version` migrations).
- **Auth:** `src/main/auth/` (`EngineAuthProvider`, `ClaudeAuthProvider`, `OpencodeAuthProvider`,
  `engineAuthRegistry`).
- **opencode:** `src/main/opencode/` (`OpencodeServerManager`, `OpencodeClient`, `OpencodeSession`,
  `event-mapper.ts`, `ensure-plugin.ts`, `model-discovery.ts`, `protocol/`).
- **Metering:** `src/main/services/{block-usage,usage-recorder,usage-reconciler,usage-aggregation,usage-provider,opencode-pricing}.ts`,
  `src/shared/pricing.ts`, renderer `components/usage/`.
- **Tool rendering:** `src/renderer/src/components/chat/tool-registry/` + `src/shared/tool-kinds.ts`;
  `MessageBubble.tsx`, `FloatingApproval.tsx`, `ApprovalButtons.tsx`.
- **Settings:** `src/renderer/src/components/SettingsDialog/` (`settings-sections.tsx`, `SettingsDialog.tsx`).
- **Types:** `src/shared/types.ts` (`EngineId`, `ModelRef`, `AccountRef`, `SessionStatus`,
  `AuthFlowState`, `BlockUsageData`…).
- **Verification:** `verifier-electron` skill + `scripts/app-shot.mjs` (Playwright-Electron, real-build
  drive).

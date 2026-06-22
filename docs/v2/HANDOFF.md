# V2 Implementation — Session Handoff

> **You are a fresh session continuing the ClaudeUI V2 multi-engine re-platform.** This doc is your
> single entry point: where we are, how we work, what's next, and the hard-won gotchas. Read it fully,
> then [implementation-plan.md](implementation-plan.md) and the next phase's design doc.

## TL;DR — where we are

**9 phases done and pushed; Phase 5 (the whole opencode engine) is COMPLETE (5a+5b+5c).** Next up:
**Phase 6** (tool registry). The whole V2 is being built as **stacked branches on `origin`**, one
per phase, each reviewed + verified + committed before the next. **The plan's PR review gate after
Phase 5 (the opencode MVP) is now due** — open it, or keep building 6 (the user's call).

| Phase | What | Branch (pushed) | Status |
| --- | --- | --- | --- |
| 0 | Rip Codex | `v2-phase-0-rip-codex` | ✅ |
| 1 | `provider`→`engine` rename + data-model identity types (`EngineId`/`VendorId`/`ModelRef`/`AccountRef`); `SessionStatus.model`→`ModelRef` | `v2-phase-1-engine-rename` | ✅ |
| 2 | Computed capability model (`EngineCapabilities`×`ModelCapabilities`→`ResolvedCapabilities`, two-axis `reasoning`); all §4 feature gates | `v2-phase-2-capability-model` | ✅ |
| 3a | Operational SQLite DB (better-sqlite3) + session-metadata migration | `v2-phase-3a-db-substrate` | ✅ |
| 3b | Config-plane (tier/plane split, per-engine/vendor stores) + SettingsDialog re-IA + autonomy modes | `v2-phase-3b-config-plane` | ✅ |
| 4 | Auth providers (`EngineAuthProvider`/`ClaudeAuthProvider`, neutral probe, `AuthState`→`AuthFlowState`, accounts→DB) | `v2-phase-4-auth-providers` | ✅ |
| 5a | opencode infra: `ensure-opencode` + `OpencodeServerManager` + v1 HTTP/SSE `OpencodeClient` + smoke | `v2-phase-5a-opencode-server` | ✅ |
| 5b | opencode chat MVP: `OpencodeSession` + event mapper + grouped model picker + approvals | `v2-phase-5b-opencode-chat` | ✅ |
| 5c | `OpencodeAuthProvider` (per-vendor auth) + hosted-tools opencode plugin (mermaid/mockup) | `v2-phase-5c-opencode-auth-mcp` | ✅ |
| **6** | **Tool registry (`ToolKind` taxonomy + renderer registry)** (see Next steps) | — | ⬜ **next** |
| 7 | Metering (usage recorder, pricing, dashboard → SQL) | — | ⬜ |

Branches are stacked: each off the previous (`5c` off `5b` off `5a` off `4` off `3b` off `3a` off `2`
off `1` off `0` off `codex-sup`). **No PRs opened yet** — the plan's review gates are after Phase 1
(passed) and Phase 5. **Phase 5 is now complete (5a+5b+5c), so the Phase-5 PR gate is due** (or keep
building Phase 6 — the user's call). Base/integration branch is `codex-sup` (where the V2 design lives).

## The workflow (follow this exactly)

This is the loop the user established and wants continued. **You are the orchestrator + reviewer; a
Sonnet sub-agent writes the code.**

1. **Scope the phase.** Read the locked design doc(s) in `docs/v2/` (the `0X-*.md` foundations) + the
   relevant ADR(s). Recon the current code (grep/read) to ground the plan and gauge blast radius.
   **De-risk external/native dependencies FIRST** (e.g. I probed `node:sqlite`, ran `opencode serve`,
   verified the better-sqlite3 Electron ABI before designing around them).
2. **Discuss scope with the user.** For genuine forks (depth, behavior-preserving vs structure-ready,
   library choices), use `AskUserQuestion` with a clear recommendation. The user has **consistently
   chosen the fuller, "structure-ready" option** over minimal/behavior-preserving — design for the V2
   target, not a shim. Don't re-ask settled things.
3. **Write a phase kickoff spec** → `docs/v2/phase-N-<name>.md` (mirrors `phase-0-rip-codex.md`).
   Include: scope decisions (with the chosen forks), precise file/seam map, verified facts so the agent
   doesn't re-discover, out-of-scope list, step-by-step, verify gates, gotchas, suggested commit msg.
4. **Create the branch** `v2-phase-N-<name>` off the previous phase branch.
5. **Delegate to a Sonnet agent** (`Agent` tool, `subagent_type: general-purpose`, `model: sonnet`).
   Point it at the spec. Tell it: **do NOT commit/`git add`/create branches; do NOT `bun install`**
   (see gotchas); leave the working tree for review; report deltas + exact verify results + deviations.
6. **Review every single line** of the agent's diff (`git diff <prev-branch>`). Read the actual code,
   not just the report. Run independent checks (re-run gates, grep, probe). Find the subtle bugs —
   real ones surfaced every phase (e.g. a model-picker regression, dead persisted data, a `pragma`
   no-op that made a migration test vacuous, an `acquire()` concurrency race, a wrong auth-source
   mapping). **Verify the agent's tests actually test what they claim** (ask it to prove a guard test
   fails against the pre-fix code).
7. **Send feedback** via `SendMessage` (to the agent's `agentId` from its spawn result — it resumes
   with context). Categorize fixes (required / minor / accept-with-note). The agent fixes; **re-review
   the fixes**; iterate until clean.
8. **Verify** (all must pass): `bun run typecheck`, `bun run test`, `bun run test:ci`, `bun run lint`
   (0 errors; 3 pre-existing `exhaustive-deps` warnings in Sidebar/ExitPlanModeCard/ReviewBar are OK),
   `bun run build`. Then a **runtime smoke** via the `verifier-electron` skill (`node scripts/app-shot.mjs`)
   for any UI/behavior change — launch the real app, screenshot, assert (read the PNG). For headless
   infra phases (5a), a gated/integration smoke instead.
9. **Commit + push** — **one commit per phase**, after review passes. Stage with `git add -A`; commit
   with a descriptive multi-paragraph message (subject + body). **NO AI attribution / no Co-Authored-By**
   (project convention + user's global rule). `git push -u origin v2-phase-N-<name>`.
10. **Update memory** (`MEMORY.md` + `project_v2_multi_engine_pivot.md`) with the phase result + any new
    gotcha. Then `AskUserQuestion`: next phase / open PR / pause.

**Cadence:** spec → branch → delegate → review→fix loop (1–3 rounds typical) → verify → commit+push →
memory → ask. The agent never commits; I commit after the review loop is clean.

## Verification tooling (built this session)

- **`verifier-electron` skill** (`.claude/skills/verifier-electron/SKILL.md`) + **`scripts/app-shot.mjs`**
  (Playwright-Electron). Launches the *built* app, screenshots it, asserts DOM (`--needle`), drives
  chained `--click` selectors (e.g. `[title="Settings"]`, `text=All Settings`). Run `bun run build`
  first. Used every UI phase to confirm behavior-preservation by *reading the screenshot*. The user
  expects real-app self-verification for UI changes, not just tests.
- Screenshots land in `.cache/screenshots/` (gitignored). `playwright` is a committed devDep.

## What Phase 5 shipped (done — see `phase-5{a,b,c}-*.md`)

opencode is a fully-integrated engine. **5b:** `OpencodeSession` + event→ContentBlock mapper + grouped
model picker (`getEngineModels`) + EngineToggle + per-session autonomy→permission (`PATCH /session/{id}`)
+ approvals. **5c:** `OpencodeAuthProvider` (per-vendor API-key + paste-code OAuth; new engine-routed
`vendor-auth:*` IPC; Settings › Vendors opencode section) + hosted-tools opencode **plugin**
(render_mermaid/create_mockup/show_mockup, auto-loaded from `~/.config/opencode/plugin/`, names
normalized → `mcp__claude-ui*` so the existing cards render). All verified against the real 1.17.9 binary
(free OpenCode-Zen model).

**Phase-5 gotchas now baked into code (carry forward):** binary/plugin locators use `app.getAppPath()`
not `__dirname`; the shared `/event` stream multiplexes all sessions → filter by `properties.sessionID`;
`import {app} from 'electron'` fails under plain `bun`; **opencode `config.plugin` absolute paths don't
load — only the auto-load dirs do**; **opencode's plugin loader rejects any non-function module export**;
**`ToolContext.directory` = git root ≠ session cwd → pass `CLAUDEUI_SESSION_CWD` spawn env** for the
plugin's mockup writes; opencode `session.error` shape = `{name, data:{providerID,message}}`. The hosted
plugin installs **globally** (affects standalone opencode too) — a config-dir-scoping follow-up is possible.

## Next steps — Phase 6 (tool registry)

- `ToolKind` taxonomy + a `TOOL_RENDERERS` registry; unify the three tool dispatch sites
  (`MessageBubble.tsx` + `ToolCallBlock/View.tsx` special-cases); a shared `ToolCard` shell + extracted
  `<ApprovalButtons>`; port existing cards (mermaid/mockup/todo/task/exit-plan/ask-question) to kinds
  (behavior-preserving for Claude). opencode tools currently render via name-normalization + the generic
  block — Phase 6 makes that first-class. Lift `question`/`plan`/`todo` to the interaction layer.
- Then **7** (metering — opencode `info.tokens`/`cost` are already parsed in the 5b mapper; the recorder
  + pricing + dashboard→SQL land here).

## Gotchas / conventions (carry these forward)

- **NEVER `bun install`/`bun add`/`bun remove` casually** — bun's postinstall leaves `better-sqlite3`
  **Node-ABI**, which crashes the Electron app on boot (`ERR_DLOPEN_FAILED`). After any dep change run
  **`bun run rebuild:native`** (`electron-builder install-app-deps`, rebuilds to Electron ABI).
- **Dual-ABI testing**: vitest runs in Node and can't load the Electron-ABI `better-sqlite3`, so
  `vitest.config.ts` aliases it → `src/test/stubs/better-sqlite3-stub.ts` (a `node:sqlite` adapter).
  DB-touching code is tested through that. Electron is **41.0.3 / Node 24.14.0** (node:sqlite is built-in,
  flagless — verified).
- **Don't break Claude.** Phases 0–4 are behavior-preserving; every phase's smoke confirmed the Claude
  UX is unchanged. Auth (Phase 4) is the live login path — the user is actively logged in; a detection
  bug = lockout.
- **Design docs are the spec.** `docs/v2/01..06` + `persistence.md` are the locked foundations; ADR-018..021
  record them. Some were DRAFT (04 was) and the user edited a foundation doc mid-phase (02's two-axis
  `reasoning` correction) — treat the docs as authoritative and re-read them.
- **`EngineId = 'claude' | 'opencode'`** (type since Phase 1; `'opencode'` had no backend until 5b).
  **`ProviderId` is gone** (renamed to `EngineId`). `provider`→`engineId` everywhere.
- **Commits:** one per phase, no AI attribution, multi-paragraph body. Branch `v2-phase-N-<name>`,
  stacked. Push with `-u`.
- **The opencode binary** (~165 MB) is gitignored (`vendor/opencode-cli/`), vendored by `ensure-opencode`,
  shipped via electron-builder `extraResources`. HTTP **Basic auth** (`opencode:<generated-password>`).
  Target the **v1** API (paths like `/session`, `/event`, `/auth/{id}`) — NOT the `/api/*` v2 family.
- **Pre-existing:** 3 `exhaustive-deps` lint warnings (Sidebar/ExitPlanModeCard/ReviewBar) — leave them.

## Key files / entry points

- Plan + design: `docs/v2/implementation-plan.md`, `docs/v2/01..06-*.md`, `docs/v2/persistence.md`,
  per-phase kickoffs `docs/v2/phase-*.md`, ADRs `docs/adr/adr-018..021`.
- Engine seam: `src/main/providers/` (`ISession`, `BaseSession`, `EngineRegistry`, `register-engines.ts`).
- Capabilities: `src/shared/model-capabilities.ts` (single source of truth).
- DB: `src/main/services/db.ts` (only better-sqlite3 importer; `user_version` migrations).
- Auth: `src/main/auth/` (`EngineAuthProvider`, `ClaudeAuthProvider`, `engineAuthRegistry`).
- opencode: `src/main/opencode/` (`OpencodeServerManager`, `OpencodeClient`, `protocol/`).
- Types: `src/shared/types.ts` (`EngineId`, `ModelRef`, `AccountRef`, `SessionStatus`, `AuthFlowState`…).

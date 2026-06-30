# ADR-024: opencode interaction-feature parity (slash commands, skills, side-questions, queue/steer, subagents)

**Status:** Accepted
**Date:** 2026-06-23
**Relates to:** [ADR-019](adr-019_opencode-engine-backend.md) (opencode engine backend), [ADR-018](adr-018_v2-engine-vendor-account-model.md) (capability model / autonomy modes), [ADR-022](adr-022_opencode-permission-mapping.md) (opencode permission mapping), [ADR-023](adr-023_opencode-automode-classifier.md) (auto-mode classifier)

## Context

Phase 5 (ADR-019) shipped opencode as a lean second engine — it chatted, rendered tools, and handled approvals — but left **eight interaction capabilities gated `false`**: `slashCommands`, `skills`, `steer`, `queue`, `sideQuestion`, `subagents`, `voice`, `backgroundTasks`. Research against the **opencode 1.17.9 source** (cloned at tag `v1.17.9`) confirmed that most of these are exposed over opencode's **HTTP+SSE server API** — not TUI-only — so ClaudeUI can drive them. This ADR records the decisions for closing that gap (the "Phase 8" series, branches `v2-phase-8{a,b,c,d}-*`), the deliberate scope-outs, and the accepted trade-offs.

Two facts shaped the work:
1. The renderer / store / IPC layers for these features are already **engine-neutral** — they gate on `capabilities.*`, not `engineId`. The Claude coupling was almost entirely `isClaudeSession` narrowing guards in `session.ipc.ts` plus the per-feature session methods.
2. opencode's mechanisms often differ **structurally** from cli.js's. "Parity" therefore means mapping opencode's native server mechanism onto the same neutral contract — not replicating cli.js internals.

## Decision

Enable **six** of the eight capabilities for opencode, each mapping opencode's native mechanism onto the existing neutral contract. **Skip `backgroundTasks`** and **defer `voice`**.

### Slash commands + skills (8a)
- **Commands** are server-driven: `GET /command` lists them; **`POST /session/{id}/command {command, arguments}`** runs a full turn with server-side template expansion. opencode does **not** interpret a leading `/` in a normal prompt, so `OpencodeSession.run` routes a `/known-command` prompt to the command route (else `promptAsync`), with a BadRequest→promptAsync fallback.
- **Skills** are list-only + model-invoked (no user-invoke API, no skill SSE event). `GET /skill` feeds the read-only SkillsDialog (engine-dispatched in the skill-details IPC); opencode reads the same `~/.claude/skills` dirs.
- **Eager connect:** `run(null)` connects opencode at session creation (parity with Claude's spawn-only init) to discover commands/skills before the first prompt and emit `session:slash-commands`/`session:skills`. The acquire is **memoized** (`ensureConnected`) so a prompt racing the eager connect cannot double-acquire the shared per-cwd server (a ref-leak); the per-run cancel guard resets so a session reconnects after an idle timeout; the eager path arms the inactivity timer.

### Side-questions: `/btw` + native `question.asked` (8b) — two distinct features
- **`/btw` (user→model aside, `sideQuestion` cap):** opencode has no native side-question control. Implemented via a **throwaway, history-free session** (createSession → prompt → deleteSession) with a **deny-all permission ruleset** so the synchronous turn is tool-less and cannot hang on an unanswerable `permission.asked` (matching Claude's tool-less `/btw`). `askSideQuestion` is promoted to `ISession` (BaseSession default `null`); the IPC is de-gated from `isClaudeSession` to a capability check and added to `SESSION_IPC_CHANNELS` (it was missing).
- **Native `question.asked` (model→user elicitation — opencode's analog of Claude's AskUserQuestion):** mapped in the event-mapper to a `PendingApproval{toolName:'AskUserQuestion', input:{questions}}` and routed to the existing AskUserQuestionBlock UI; answered via `POST /question/{id}/reply {answers:string[][]}` / `/reject`. The renderer's `answers: Record<string,string>` is mapped to opencode's `string[][]` **in question order** (key `q.question||'q'+i`, `', '`-split for multiSelect). **A question always goes to the human — never the auto-mode classifier** (which judges tool permissions, not user-facing questions). This fixes a real **turn-hang**: an opencode model that called its `question`/`plan_exit` tool previously had no answer path.

### Queue + steer (8c) — collapsed into one mechanism
opencode has **no server-side holdable queue**: a prompt POSTed to a busy session is accepted and **coalesced into the running loop** (the runLoop re-reads the message list each step and picks it up at the next step), with a single `session.idle` at the end, and **no un-send**. Therefore for opencode, queue and steer collapse: **send-while-busy posts immediately and is steered into the ongoing turn** (we emit `session:steer-consumed` so the renderer moves the queued card into chat). The `queue` cap enables the renderer's type-ahead; `steer` is the mid-turn coalesce.
- **Accepted trade-off:** stage-and-edit *dequeue* is moot (you cannot un-send a coalesced prompt) — the `↑`-edit-queued affordance no-ops. The alternative (buffer→flush-on-idle) would preserve dequeue but delay the follow-up until the current turn fully ends; rejected as less responsive and less native to opencode.

### Subagents (8d) — child-session rendering
opencode's `task` tool spawns a **child session** whose transcript streams on the shared `/event` SSE under the child's sessionID. The parent's `task` tool-part carries `state.metadata.sessionId` (the child) and `callID` (the parent toolUseId everything keys on). The event-mapper was restructured into **own / known-child / ignore** routing:
- The own-session handler **registers** the child (`childSessions: childSessionId → parent callID`) when it sees the task tool part.
- A new child handler routes the child's events to `session:subagent-message` / `-stream` / `-tool-result` + `session:task-notification`, keyed by the parent toolUseId → the existing engine-neutral TaskCard / SubagentMessages. No renderer change: `'task'` already maps to the TaskCard kind, and `canUseSubagents` was a dead renderer flag.
- **Critical guard (structural, not conditional):** a child's `session.idle` is handled in the child handler and **can never reach** the own-session `session.idle → {result}` path (the two branches are mutually exclusive by sessionID), so a completing subagent never ends the parent turn early.
- Child accumulators are tagged `isChild` and **excluded from `recordTurnUsage`/`sendMetering`**, so subagent tokens are never mis-attributed to the parent model (preserving pre-existing parent metering; see follow-up #3).

### Scope-outs
- **`backgroundTasks` — skipped.** opencode has no analog of Claude's "send a running Bash to the background + tail its output file." opencode "background" = experimental detached *subagents* behind an off-by-default env flag (`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`), semantically unrelated to the "Send to background" affordance. Cap stays `false`.
- **`voice` — deferred.** The capture/transcription pipeline is engine-agnostic (transcript→text→normal prompt); only the STT *server* is currently Claude-hosted (cli.js Deepgram TCP). Enabling it for opencode is a backend decision (reuse the cli.js-hosted STT vs. an independent service), not interaction wiring. Cap stays `false`.

## Consequences

- opencode reaches **interaction parity** with Claude on slash commands, skills, side-questions, model elicitation, queue/steer, and subagents — all over the engine-neutral contract; the renderer was unchanged except for being fed by the opencode engine.
- The Claude path and **non-subagent opencode turns are behavior-preserving** (empty `childSessions` makes the mapper restructure a no-op; the permission-approval path is untouched).
- `question.asked` wiring removes a latent **turn-hang**.
- Native differences are surfaced as **accepted trade-offs** rather than papered over (no dequeue under coalesced steer; subagent usage unmetered).
- `OPENCODE_ENGINE_CAPABILITIES` now: `slashCommands`/`skills`/`sideQuestion`/`queue`/`steer`/`subagents` = `true`; `voice`/`backgroundTasks` = `false`.

## Known gaps / follow-ups (accepted, non-blocking)

Deliberate scope boundaries or edge-case refinements flagged during review — none represents a broken delivered feature.

> **Update — Phase 8e (`v2-phase-8e-opencode-subagent-permissions`):** #2 is **RESOLVED** — child `permission.asked` is now surfaced to the parent approval UI (keyed by the child tool's `callID`, no persist-suggestion), so a subagent hitting an `ask`-gated tool no longer hangs the parent turn; the hang was confirmed real (opencode's default ruleset asks on `doom_loop`/`.env`/`external_directory`, and `deriveSubagentSessionPermission` propagates only the parent's *deny* rules to children). #1 was **verified a non-issue and documented** — `ctx.metadata` is `yield*`-awaited before the child is prompted (`tool/task.ts` 178→259), so on the single FIFO SSE stream the child-registration event always precedes any child transcript event (no buffering needed). #3 is now logged in `docs/v2/phase-7-metering.md`'s deferred list.
1. **Pre-registration child-event race (8d):** if opencode emits a child event before the parent task-part registers the child mapping (event ordering is not pinned in the opencode source), those early child events are dropped (the subagent transcript may miss its opening lines). Deferred mitigation: buffer events for unknown sessions briefly and replay on registration, or pre-register from `session.updated.parentID` and backfill the toolUseId from the task part.
2. **Subagent `permission.asked` not surfaced (8d):** a child session's own permission prompts hit the child handler's `default` (ignored), so a subagent that needs an `ask`-gated tool would block. Impact depends on opencode's *derived* subagent permissions (built-in subagents tend to allow/deny, not ask). Follow-up: verify the derived ruleset, then route child approvals to the parent approval UI (and the auto-mode classifier in `full`).
3. **Subagent usage not metered (8d):** child tokens are intentionally excluded from parent metering to avoid model mis-attribution; metering them properly requires recording per-child under the child's actual model — a Phase-7 (metering) follow-up.
4. **`voice` / `backgroundTasks`** — see scope-outs; revisit on demand.
5. **Live verification:** deep opencode behaviors (subagent rendering, mid-turn steer, `/btw` round-trip) are unit-verified; a scripted live opencode drive (free OpenCode-Zen model) to close the app-shot gap is a follow-up.

## Implementation notes (as built)

- **Branches (stacked off the V2 tip):** `v2-phase-8a-opencode-commands-skills` → `8b-opencode-questions` → `8c-opencode-queue-steer` → `8d-opencode-subagents`. Per-phase kickoff specs in `docs/v2/phase-8{a,b,c,d}-*.md`.
- **Key files:** `OpencodeClient.ts` (listCommands/runCommand/listSkills/replyQuestion/rejectQuestion), `command-skill-discovery.ts`, `event-mapper.ts` (question.asked + own/child/ignore restructure + `isChild`), `OpencodeSession.ts` (eager `ensureConnected`, slash routing, `askSideQuestion`, `pendingQuestions`, steer path, child-session dispatch, metering excludes children), `protocol/types.ts`, `model-capabilities.ts` (cap flips), `session.ipc.ts`/`remote-handlers.ts` (de-gates + `SESSION_IPC_CHANNELS`), `providers/ISession.ts`+`BaseSession.ts` (`askSideQuestion`).
- **Workflow:** each phase — Sonnet sub-agent wrote, reviewed line-by-line with a fix loop, gated (typecheck/test:ci/lint/build), committed+pushed. Review caught a real defect each phase (8a double-acquire ref-leak + abandoned-session leak; 8b `/btw` synchronous-turn hang risk; 8d child-token metering mis-attribution).
- **Verification:** per-phase gate green (3607 tests on 8d); real-app boot smoke clean (engine toggle + Settings opencode tier render, 0 console errors); Claude path unaffected.
- **opencode source** was cloned at tag `v1.17.9` as the authoritative wire reference.

## Alternatives considered

- **Queue via buffer→flush-on-idle** (preserve dequeue) — rejected for opencode: delays the follow-up to after the current turn, less responsive, and fights opencode's native coalescing. Revisit if dequeue-able queueing is explicitly wanted.
- **Normalize opencode's `question` tool name → `AskUserQuestion` for inline history rendering** — out of scope; the floating AskUserQuestionBlock (driven by the `question.asked` event) is what prevents the hang; the in-history tool card showing as a generic `question` tool is acceptable.
- **Implementing `backgroundTasks` via the experimental detached-subagent flag** — rejected: off-by-default, semantically mismatched with the "Send to background on a Bash tool" affordance.

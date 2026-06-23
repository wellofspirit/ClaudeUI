# Follow-up — Surface opencode subagent questions (floating AskUserQuestion)

> ROADMAP item **#1** (🔴). Fixes a **turn-hang**: an opencode subagent (a `task` child session) that
> calls the `question` tool emits `question.asked` under the child's sessionID, which `handleChildEvent`
> currently drops → the child fiber blocks → the synchronous parent turn hangs until cancelled.
> **Decision (user-confirmed): SURFACE the child question** as a **floating** `AskUserQuestionBlock` so
> the user can answer it (not auto-answer/defuse). **opencode-only; Claude untouched.** Branch
> `v2-followup-subagent-questions` (off `v2-phase-9b-usage-engine-split`). opencode source for
> verification: `D:\WorkPlace\opencode-src` (v1.17.9).

## Why this is a real hang (verified against opencode 1.17.9)

- The `question` tool is in **every** session's toolset, subagents included — gated once instance-wide
  by `questionEnabled` (`tool/registry.ts:196`, ON for ClaudeUI: 8b own-session questions prove it).
  The per-agent filter `registry.tools({agent})` (`tool/registry.ts:267-279`) gates only by
  model/provider and **never consults the agent**.
- It is **not** permission-gated: the tool calls `Question.Service.ask()` directly
  (`tool/question.ts:24`), bypassing `ctx.ask()`; `task.ts`'s `childToolDenies` (`tool/task.ts:129-141`)
  doesn't list `question`.
- `Question.ask` publishes `question.asked` then blocks on a `Deferred` until reply/reject
  (`question/index.ts:170-177`); a foreground child task is awaited synchronously by the parent
  (`tool/task.ts:303-321`). Child blocked → parent turn hung. Same shape as the 8e permission hang.

## Scope (locked)

- **Surface** the child question in the **floating layer** as an interactive `AskUserQuestionBlock`.
  Answering replies; dismissing rejects. Either way the child fiber unblocks → no hang.
- **Floating, not inline** — a blocking prompt must be visible; the subagent thread (TaskCard /
  TaskDetailPanel) can be collapsed and the question missed → re-hang. Floating mirrors how 8e child
  *permissions* surface.
- **opencode-only by construction** — only opencode emits child `question.asked`. The renderer branch
  keys on `toolName === 'AskUserQuestion'`, which is engine-neutral, but only opencode produces
  *unmatched* (child) questions, so Claude is unaffected.
- **No new reply plumbing** — the existing `AskUserQuestion` reply path is reused end to end.

## Verified facts (do NOT re-discover — file:line)

**Backend (main):**
- **Own-session `question.asked` mapping** — `event-mapper.ts:354-378`: reads `props.id`,
  `props.questions` (`QuestionInfo[]`), `props.tool` (`{messageID,callID}`); maps to
  `AskUserQuestion[]`; returns `{kind:'approval', approval:{ requestId:id, toolUseId:tool?.callID,
  toolName:'AskUserQuestion', input:{questions} }}`. **The child case is the SAME code** — inside
  `handleChildEvent`, `tool?.callID` is already the child question tool's own callID (the value we want).
- **`handleChildEvent`** — `event-mapper.ts:406-589`: switch over child events; ends in
  `default → {kind:'ignore'}` (the current drop). The 8e `permission.asked` child case (`:537-572`) is
  the pattern to mirror (build an approval, return `{kind:'approval'}`). **`handleChildEvent` is only
  reached for *registered* child sessions** — `mapEvent` routes unknown foreign sessions to ignore
  before this function (the own/child/ignore split documented at `:404`-ish and the 8e spec). So
  "unregistered child → ignore" is handled by the router, not this case.
- **Dispatch already handles `AskUserQuestion` uniformly** — `OpencodeSession.ts:535-545`: the
  `'approval'` case stores `pendingQuestions[requestId] = input.questions` when
  `approval.toolName === 'AskUserQuestion'` and emits `session:approval-request`. **Source-agnostic** —
  child approvals flow through unchanged (8e relies on this). Confirm there is **no `isChild` skip** on
  the approval dispatch path.
- **Reply path is child-ready** — `OpencodeSession.resolveApproval` (`:664-718`): for
  `pendingQuestions.has(requestId)` it maps `answers: Record<string,string>` → `string[][]` in question
  order with key `q.question || 'q'+i` and calls `client.replyQuestion(requestId, mapped)`; deny / no
  answers → reject. opencode keys question replies by **requestId globally** — no child handle needed.
- **Auto-mode must NOT swallow questions** — questions always go to the human, never the auto-mode
  classifier. Confirm the dispatch still forces `toolName === 'AskUserQuestion'` to the human path for
  child questions (it should, since the check is on `toolName`, `OpencodeSession.ts:~539`). Add/extend a
  test asserting a child question in `full`/auto mode still emits `session:approval-request`.

**Renderer:**
- **Floating layer** — `FloatingApproval.tsx`: `useUnmatchedApprovals()` (`:172-199`) returns pending
  approvals whose `toolUseId` is **not** in the rendered **main** message blocks. A child question's
  callID lives in the subagent thread, so it is **unmatched** → floats. Today `FloatingApproval`
  (`:263-275`) maps every unmatched approval to `<ApprovalCard>` → `ApprovalCardView` (permission UI,
  Deny/Allow only) — **wrong for a question** (it'd JSON-dump the questions with Deny/Allow).
- **`AskUserQuestionBlock`** — `AskUserQuestionBlock/AskUserQuestionBlock.tsx`: props `{block, result?,
  approval?}`. Renders from **`block.toolInput.questions`** (`View.tsx:25-26`). Submit →
  `window.api.respondApproval(routingId, approval.requestId, 'allow', answers)`; Dismiss → `respondApproval(…,'deny')`
  (`:23-35`). Answer keys = `q.question || 'q'+i` (`View.tsx:40-41`) — **matches** `resolveApproval`'s
  mapping. So rendering needs a `block`; submit needs the `approval`.
- **`ToolUseBlock` shape** — `shared/types.ts` (`ContentBlock` `type:'tool_use'`): fields incl.
  `type`, `toolUseId`, `toolName`, `toolInput`. The View only reads `toolInput`. Build a **synthetic
  block** from the approval for the floating render.

## File / seam map

- `src/main/opencode/event-mapper.ts` — add `case 'question.asked'` to `handleChildEvent` (mirror the
  own-session case `:354-378`). Consider extracting the `QuestionInfo[] → AskUserQuestion[]` mapping +
  approval construction into a shared helper used by BOTH the own-session and child cases (DRY — avoid
  drift).
- `src/renderer/src/components/chat/FloatingApproval.tsx` — in the `.map` (`:270-272`), branch:
  `approval.toolName === 'AskUserQuestion'` → a new `FloatingQuestionCard` that builds a synthetic
  `ToolUseBlock` from `approval.input` (+ `toolUseId: approval.toolUseId ?? approval.requestId`,
  `toolName:'AskUserQuestion'`) and renders `<AskUserQuestionBlock block={synthetic} approval={approval} />`;
  else `<ApprovalCard>`.
- Tests: `src/main/opencode/__tests__/event-mapper.test.ts`,
  `src/main/opencode/__tests__/OpencodeSession.test.ts`, and a renderer test for `FloatingApproval`
  (component-level; jsdom).
- **No capability change** (`subagents` already true). **No new IPC.** **Claude path untouched.**

## Steps

1. **Mapper.** Add `case 'question.asked'` to `handleChildEvent`. Build the AskUserQuestion approval
   exactly like the own-session case; `toolUseId = tool?.callID` (child callID). Guard:
   `if (!id || !rawQuestions) return {kind:'ignore'}`. Return `{kind:'approval', approval}`. If you
   extract a helper for the own/child shared mapping, keep the own-session case behavior byte-identical.
2. **Dispatch sanity.** Confirm child `{kind:'approval'}` flows through `dispatchMapperOutput`'s
   `'approval'` case (it does for 8e permissions); confirm `pendingQuestions` is stored and
   `session:approval-request` emitted for the child question; confirm **no `isChild` skip** drops it and
   that `AskUserQuestion` still routes to the human (not the auto-mode classifier). No code change
   expected here — if one is needed, it's a one-liner; flag it.
3. **Renderer.** Add the `FloatingQuestionCard` branch in `FloatingApproval`. Build the synthetic
   `ToolUseBlock` (match `shared/types.ts`). Render `<AskUserQuestionBlock>`. Keep `ApprovalCard` for all
   non-question approvals. Verify own-session questions are unaffected (they're *matched* → inline, never
   floating).
4. **Tests** (below).

## Tests (mocked, no binary)

- **event-mapper**: a CHILD `question.asked` (registered child) → `{kind:'approval'}` with
  `toolName === 'AskUserQuestion'`, `toolUseId === tool.callID`, and `input.questions` mapped from
  `QuestionInfo[]` (header/options/multi). A child event for an **unregistered** session →
  routed to ignore (assert via the `mapEvent` entry, not `handleChildEvent` directly). **Regression**:
  the own-session `question.asked` case still returns the same approval (guard against helper-refactor
  drift).
- **OpencodeSession**: dispatch a child question approval → `session:approval-request` emitted +
  `pendingQuestions` populated; `resolveApproval(requestId,'allow',answers)` → `replyQuestion(requestId,
  mapped)` (answers mapped in order); `resolveApproval(requestId,'deny')` → question **reject**. In
  **full/auto** mode the child question still goes to the human (NOT auto-classified). Keep 8e subagent
  tests green.
- **FloatingApproval** (component): given an unmatched approval with `toolName:'AskUserQuestion'` +
  `input.questions`, it renders the question UI (options visible) — NOT the permission card; submitting
  calls `respondApproval(routingId, requestId, 'allow', answers)`; dismiss → `respondApproval(…,'deny')`.
  Given an unmatched **permission** approval, it still renders `ApprovalCard`.

## Verify

```
bun run typecheck && bun run test && bun run test:ci && bun run lint && bun run build
```
- 0 lint errors (3 pre-existing `exhaustive-deps` warnings OK). **No `bun install`** (better-sqlite3 ABI).
- **Live drive (verifier-electron / app-shot):** the orchestrator will drive a real opencode session
  whose subagent is prompted to ask a question → assert a floating question card appears → answering
  continues the subagent; a second run dismissing the card fails the subagent cleanly. **Read the PNG.**
  (Agent: you don't need to run the live drive — report your unit/gate results; the orchestrator does the
  real-app verification.)

## Gotchas

- **`toolUseId = tool?.callID`** (child callID), NOT the parent task toolUseId — else `useUnmatchedApprovals`
  treats it as matched and the card never floats.
- **Synthetic block must carry `toolInput.questions`** — the View reads questions from the block, not the
  approval. Submit/deny use `approval.requestId`.
- **Answer-key contract** — `q.question || 'q'+i` must stay identical across `View.tsx`,
  `resolveApproval`, and any helper; a mismatch makes opencode see blank answers.
- **Don't regress own-session questions** — they must still render **inline** (matched), never float.
  If you extract a shared mapper helper, prove the own-session case is byte-identical.
- **Don't break Claude** — Claude never emits child `question.asked`; the renderer branch only changes
  rendering for `AskUserQuestion`-typed approvals (Claude's own questions are matched/inline, untouched).
- **opencode-src is read-only reference** — verify shapes there; do not modify it.

## Out of scope

- Inline-in-subagent rendering (explicitly rejected — floating is the decision).
- Auto-answering / defusing (superseded — we surface now).
- Child permissions (already handled in 8e) and Claude questions (8b) — unchanged.
- Background/detached subagents (upstream-experimental).

## Commit (orchestrator does this after review)

One commit, no AI attribution. Suggested subject:
`fix(v2/opencode): surface subagent questions as floating AskUserQuestion cards`.

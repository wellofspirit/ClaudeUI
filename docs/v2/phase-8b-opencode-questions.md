# Phase 8b — opencode Questions: `/btw` + native model-elicitation

> Second of the Phase-8 series. Two distinct "question" features for the opencode engine:
> **(A)** `sideQuestion` — the user's `/btw` out-of-band aside (enables the `sideQuestion` capability);
> **(B)** wiring opencode's **native `question.asked`** SSE (the MODEL asking the USER a structured
> question — opencode's analog of Claude's `AskUserQuestion`) into the existing `AskUserQuestionBlock`
> UI, which fixes a real turn-hang. **Claude is untouched.** opencode source: `D:\WorkPlace\opencode-src`
> (v1.17.9). Branch `v2-phase-8b-opencode-questions` (already created off 8a).

## Verified facts (build on these)

**ClaudeUI seam (traced):**
- `/btw`: `InputBox/utils.ts:50-52` detects `/btw ` (gated on `sideQuestionEnabled`) → store `setBtwQuestion`/`setBtwResponse`/`btwLoading`/`clearBtw` (`session-store.ts:437-439,847-849`) → preload `askSideQuestion(routingId, question)` → IPC `session:ask-side-question` (`session.ipc.ts:899-904`) → `ClaudeSession.askSideQuestion(question): Promise<string|null>` (`claude-session.ts:1367-1370`) → `query.ts:641-647` `side_question` control request. `BtwCard.tsx` renders from `btwQuestion`/`btwResponse`/`btwLoading`.
  - `askSideQuestion` is **NOT on `ISession`** — only `ClaudeSession`.
  - IPC guard (`session.ipc.ts:901`): `if (!session.capabilities.sideQuestion || !isClaudeSession(session)) return null` — the `isClaudeSession` is the hard engine gate.
  - `session:ask-side-question` is **NOT in `SESSION_IPC_CHANNELS`** (`session.ipc.ts:272-375`) — latent bug; add it. Verify whether it's mirrored in `remote-handlers.ts` (one prior sweep said yes ~:244-248, another said no — **check and match Claude's actual state**; remote `/btw` is optional).
- AskUserQuestion (model→user): surfaces as a `PendingApproval` with `toolName:'AskUserQuestion'` + `input: AskUserQuestionInput`. Types (`shared/types.ts:306-320`):
  ```ts
  interface AskUserQuestionOption { label: string; description: string }
  interface AskUserQuestion { question: string; header: string; options: AskUserQuestionOption[]; multiSelect: boolean }
  interface AskUserQuestionInput { questions: AskUserQuestion[] }
  ```
  `AskUserQuestionBlock.tsx` discriminates on `approval.toolName === 'AskUserQuestion'`, submits via `window.api.respondApproval(routingId, requestId, 'allow', answers)` where `answers: Record<string, string>` — **verify the exact key (question text vs header) and how multiSelect is encoded** by reading `AskUserQuestionBlock.tsx`'s submit handler before mapping.
  - `resolveApproval(requestId, decision, answers?, updatedPermissions?)` is on `ISession` (`ISession.ts:42-48`); the IPC `session:approval-response` (`session.ipc.ts:843-855`) and the renderer are **engine-neutral** (no engineId gate). `OpencodeSession.resolveApproval` (`OpencodeSession.ts:566-589`) currently **ignores `answers`** and only calls `replyPermission`.

**opencode wire (v1.17.9):**
- `question.asked` SSE: `properties = { id: 'que_…', sessionID, questions: QInfo[], tool?: { messageID, callID } }`. `QInfo = { question: string, header: string, options: {label, description}[], multiple?: boolean, custom?: boolean (default true) }`. **Blocking** — the model's `question`/`plan_exit` tool suspends until reply/reject; an unanswered question hangs the turn (this is the bug we fix).
- Reply: `POST /question/{requestID}/reply` body `{ answers: string[][] }` — one inner array per question (in `questions` order), each = the selected option **labels** (a `custom` free-text answer flows through as an arbitrary string; the server doesn't validate label membership). Reject: `POST /question/{requestID}/reject` (no body).
- Acks: `question.replied { sessionID, requestID, answers }`, `question.rejected { sessionID, requestID }`.
- For `/btw`, opencode has **no** native side_question control — emulate with a throwaway session (the pattern already in `OpencodeSession.makeJudgeFn()`: `createSession` → `client.prompt(...)` → extract text → `deleteSession`).

## Scope decisions (locked)

### Part A — `/btw` (sideQuestion)
1. Promote `askSideQuestion(question: string): Promise<string | null>` to **`ISession`**; add a default in `BaseSession` returning `null` (engines without the capability). `ClaudeSession` already satisfies it (no change). Implement on `OpencodeSession`.
2. `OpencodeSession.askSideQuestion`: reuse the `makeJudgeFn` pattern — `ensureConnected()`, `createSession({title:'side-question'})`, `client.prompt(js.id, { model, system: <concise, no-tools instruction>, parts:[{type:'text', text: question}], tools: <all-false to disable tools if cheap> })`, join the assistant `text` parts, `deleteSession(js.id)` in `finally`, return the text or `null` on failure. Stateless + history-free by construction (fresh session). Never throw to the caller (return null).
3. De-gate the IPC (`session.ipc.ts:~901`): drop `!isClaudeSession(session)`; keep `!session.capabilities.sideQuestion`. (Now that it's on `ISession`, no narrowing needed.)
4. Add `'session:ask-side-question'` to `SESSION_IPC_CHANNELS`. Match `remote-handlers.ts` to Claude's existing state (mirror if Claude is mirrored; else leave — remote `/btw` optional).
5. Flip `OPENCODE_ENGINE_CAPABILITIES.sideQuestion = true`; update the comment.

### Part B — native `question.asked` → AskUserQuestionBlock
1. `OpencodeClient`: add `replyQuestion(requestId, answers: string[][]): Promise<unknown>` (POST /question/{id}/reply `{answers}`) and `rejectQuestion(requestId): Promise<unknown>` (POST /question/{id}/reject).
2. `event-mapper.ts`: handle `case 'question.asked'` → emit a `{kind:'approval'}` whose `PendingApproval` is `{ requestId: id, toolUseId: tool?.callID, toolName: 'AskUserQuestion', input: { questions: mapped } }`, where each opencode `QInfo` → `AskUserQuestion { question, header, options: [{label, description}], multiSelect: !!q.multiple }`. (The cross-session filter still applies — child-session questions stay filtered until Phase D.) Also handle `question.replied` / `question.rejected` → `{kind:'ignore'}` (we originate the reply; acks are redundant for a single client) — but document.
3. `OpencodeSession`: track questions for ordered answer-mapping + routing — `private pendingQuestions = new Map<string, AskUserQuestion[]>()`. In `dispatchMapperOutput` 'approval' case: if `approval.toolName === 'AskUserQuestion'`, store `pendingQuestions.set(requestId, approval.input.questions)` and **always** `send('session:approval-request', approval)` — **never** route a question to the auto-mode classifier (it judges tool permissions, not user questions). Only permission approvals go to `handleAutoModeApproval`.
4. `OpencodeSession.resolveApproval`: branch on `pendingQuestions.has(requestId)`:
   - **question** → if `decision` is allow/allowForSession: map `answers: Record<string,string>` → opencode `string[][]` by iterating `pendingQuestions.get(requestId)` **in order**, looking up each question's answer by the SAME key `AskUserQuestionBlock` uses (verify: question text or header), wrapping as `[value]` (split if multiSelect encodes multiple labels in one string — match the block's format), then `client.replyQuestion(requestId, mapped)`. If deny → `client.rejectQuestion(requestId)`. Delete from `pendingQuestions`. Do NOT touch the permission path.
   - **permission** (not in pendingQuestions) → existing behavior unchanged.
5. No capability flip needed for Part B (AskUserQuestionBlock renders on any approval with `toolName:'AskUserQuestion'`; it's not capability-gated).

**Out of scope (B):** rendering opencode's `question` tool part inline as AskUserQuestionBlock in history (it'll show as a generic tool card; the interactive floating block is what prevents the hang). Subagent-issued questions (cross-session filtered → Phase D). `plan_exit` confirmation nuance beyond the generic question flow.

## File / seam map
- `src/main/opencode/OpencodeClient.ts` — `replyQuestion`, `rejectQuestion`.
- `src/main/opencode/protocol/types.ts` — `QUESTION_ASKED`/`QUESTION_REPLIED`/`QUESTION_REJECTED` in EVENT_TYPES; an opencode `QuestionInfo` type if useful.
- `src/main/opencode/event-mapper.ts` — `question.asked` → approval (mapped); `question.replied`/`rejected` → ignore.
- `src/main/opencode/OpencodeSession.ts` — `askSideQuestion`; `pendingQuestions` map; dispatch 'approval' question-routing (skip auto-mode for questions); `resolveApproval` question branch.
- `src/main/providers/ISession.ts` — add `askSideQuestion`. `src/main/providers/BaseSession.ts` — default returning null.
- `src/main/ipc/session.ipc.ts` — de-gate `session:ask-side-question`; add to `SESSION_IPC_CHANNELS`. (`remote-handlers.ts` — match Claude.)
- `src/shared/model-capabilities.ts` — flip `sideQuestion`; update comment.
- Tests under `src/main/opencode/__tests__/`.

## Tests (default suite — mocked client, no binary)
- `OpencodeClient`: `replyQuestion` (POST /question/{id}/reply + body `{answers}`), `rejectQuestion` (POST /question/{id}/reject).
- `event-mapper`: `question.asked` → approval with `toolName:'AskUserQuestion'` + mapped `input.questions` (multiple→multiSelect); foreign sessionID still ignored; `question.replied`/`rejected` → ignore.
- `OpencodeSession`: `askSideQuestion('x')` → creates a throwaway session, prompts, returns the joined text, deletes the session (assert createSession+prompt+deleteSession on the mock; assert the prompt did NOT pollute the main session/history). resolveApproval on a tracked question requestId with `answers` → `replyQuestion` with the correctly-ordered `string[][]`, NOT `replyPermission`; deny → `rejectQuestion`. A permission requestId still → `replyPermission` (unchanged). A question approval is sent to the human even in auto/full mode (assert no classifier call).
- `model-capabilities` / resolve: opencode `sideQuestion` now true.
- Keep all existing opencode + approval tests green.

## Verify
```
bun run typecheck && bun run test:ci && bun run lint && bun run build
```
(I'll run the gate via a separate verification subagent. App-shot deferred to a cross-phase smoke.)

## Gotchas
- **Questions ≠ permissions** — a question approval must NEVER go to the auto-mode classifier; always to the human. Route by `toolName === 'AskUserQuestion'`.
- **Answer key + multiSelect** — read `AskUserQuestionBlock.tsx`'s submit handler and match its `answers` Record key + multiSelect encoding exactly when mapping to opencode's `string[][]`. Get the per-question ORDER from the stored `pendingQuestions` array.
- **`/btw` must not pollute the session** — use a throwaway session (createSession→prompt→deleteSession), never the main `openSessionId`. Disable tools / keep it one-shot.
- **Don't break Claude** — `askSideQuestion` on `ISession` + the BaseSession default must leave ClaudeSession's behavior identical; de-gating the IPC only removes the `isClaudeSession` narrowing (capability gate stays).
- **opencode optional** — `askSideQuestion` and question handling degrade silently on connect/HTTP failure.
- No `bun install`/`bun add`. Main-process-only opencode code.

## Commit
One commit, no AI attribution. Suggested subject:
`feat(v2/opencode): /btw side-questions + native question.asked elicitation (Phase 8b)`.

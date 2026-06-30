# Follow-up — Engine-neutral lifting of plan/question/todo/task (ROADMAP #9)

> Kickoff spec. Implementing agent: **Sonnet, `general-purpose`**. The main model (Opus) is the
> reviewer and owns correctness — do **not** commit, `git add`, branch, or `bun install`. Leave the
> working tree for review; report deltas, exact verify-gate output, and any deviations from this spec.

## 0. Why (the acute symptom)

opencode's `todowrite` renders as a dead generic tool card and never populates the floating Todo
widget. Root cause is the half-lifted seam ROADMAP #9 describes: the four "lifted" interaction kinds
(plan/question/todo/task) still consume the **engine-specific `block`** instead of a normalized
neutral shape, and the widget feed is **Claude-name-hardcoded**.

Concretely, today:
- `OpencodeEngineToolMap.kindOf('todowrite')` → `'unknown'` (no case) → `GenericBody`.
- Even classified `todo`, `TodoToolBlock` reads `block.toolInput.todos` (works only by Claude-shape
  coincidence).
- The widget is fed **only** by `buildTodosFromMessages` (session-store), which scans Claude names
  (`TodoWrite`/`TaskCreate`/`TaskUpdate`). opencode's `todowrite` is never scanned → empty widget.
- The "engine feeds via event" channel (`session:plan` / `onPlanSteps`, preload + store wired) has
  **no emitter in main** — dead.

## 1. Scope decisions (locked with the user)

- **This kickoff is #9 only.** #11 (cosmetic coverage: structured search/web, single-diff fileEdit,
  configurable truncation, per-kind metadata) is a **separate** follow-up — do not start it here.
- **Fuller option chosen: normalize all four lifted kinds onto a neutral contract.** The four lifted
  components must consume a neutral `ToolView` (engine-agnostic), not `block.toolInput.*`. Even where a
  card currently works by coincidence (Claude task/question), route it through the normalizer so the
  component never reads engine field names.
- **Behavior-preserving for Claude is mandatory.** Claude is the daily driver. Every lifted card must
  be pixel-equivalent for Claude (app-shot proof). No regressions to the plan flow, the AskUserQuestion
  answer round-trip, or the Task card.

## 2. Verified facts (grounded — do not re-discover)

### opencode tool registry (authoritative)
Source: `D:\WorkPlace\opencode-src\packages\opencode\src\tool\registry.ts:198-236` + each tool's
`Tool.define("<id>", …)`. The **wire `part.tool` value is the tool's defined id**, not the registry
key. Confirmed id literals:

| opencode tool id | maps to kind | note |
| --- | --- | --- |
| `bash` | command | (shell.ts, id `"bash"`) |
| `edit` | fileEdit | `{ filePath, oldString, newString }` |
| `apply_patch` | fileEdit | **id is `apply_patch`, NOT `patch`** — carries a patch doc, no old/new pair → falls back to generic body (fine) |
| `write` | fileWrite | `{ filePath, content }` |
| `read` | fileRead | `{ filePath }` |
| `glob`, `grep` | search | **no `list` tool exists** |
| `webfetch`, `websearch` | web | **`websearch` was unmapped** |
| `task` | task | `{ description, prompt, subagent_type, task_id?, command?, background? }` — note `subagent_type` is the SAME snake_case field Claude uses |
| `todowrite` | todo | `{ todos: [{ content, status, priority }] }` (lifted) |
| `question` | question | `{ questions: Question.Prompt[] }` (lifted) — see §2 question shape |
| `plan_exit` | plan | gated `experimentalPlanMode && client === "cli"` → **never appears in our `serve` integration**; map for completeness only |
| `skill`, `lsp`, `invalid` | unknown | leave `unknown` (graceful) — out of scope to give dedicated kinds |
| `claudeui_render_mermaid` / `claudeui_create_mockup` / `claudeui_show_mockup` | diagram/mockup | already handled, keep |

**Current `OpencodeEngineToolMap` bugs to fix:** dead `list` and `patch` cases (remove); missing
`todowrite`, `websearch`, `apply_patch`, `question`, `plan_exit`.

### opencode todo item shape + the `todo.updated` event
Source: `opencode-src/packages/opencode/src/session/todo.ts`, `tool/todo.ts`.
- Item: `{ content: string, status: 'pending'|'in_progress'|'completed'|'cancelled', priority: 'high'|'medium'|'low' }`.
  **No `activeForm`, no `id`.** Note the `cancelled` status — Claude's `TodoStatus` lacks it.
- opencode **publishes `todo.updated`** `{ sessionID, todos }` on the **`/event` SSE stream** (verified
  through `EventV2Bridge` → `GlobalBus` → `server/routes/instance/httpapi/handlers/event.ts`). Wire
  shape matches every other event: `{ type: "todo.updated", properties: { sessionID, todos } }`, so it
  routes by `properties.sessionID` exactly like `message.updated` etc.
- The `todowrite` tool also raises a `permission: "todowrite"` ask (`always:["*"]`). Expected — in
  ask/plan mode the user sees a todowrite approval; auto/full auto-allows. Not a bug, don't suppress.

### opencode question shape
Source: `opencode-src/packages/opencode/src/tool/question.ts`, `question/index.ts`.
- Tool params + event `question.asked` properties both carry `questions: Question.Prompt[]` where each
  is `{ question, header, options: [{ label, description }], multiple, custom }`. **opencode uses
  `multiple`; Claude `AskUserQuestion` uses `multiSelect`.** `buildQuestionApproval` (event-mapper.ts)
  already maps `multiple`→`multiSelect` for the event path — reuse the SAME mapping in the tool-part
  normalizer.

### opencode plan
opencode's `plan_exit` is an experimental CLI-only tool that internally calls `question.ask(...)` →
emits a `question.asked`. In our server integration plan completion surfaces (if at all) as a question,
already handled. **No opencode plan-review work in this kickoff.**

### Renderer architecture (the seam)
- `MessageBubble.tsx:36-63 renderToolBlock` computes `kind = hostedMcpKind(name) ?? toolMap.kindOf(name)`
  and routes `plan/question/todo/task` to their components (passing **`block`**), passive kinds to
  `ToolCallBlock`.
- Passive kinds already consume a neutral `ToolView` via `KindBodyProps.view` (tool-registry/kinds/types.ts).
  `ToolCallBlock` computes `toolMap.normalize(kind, block.toolInput, result)` internally. **Mirror this
  for the lifted kinds**: compute the view in `renderToolBlock` and pass it down.
- `EngineToolMap.normalize(kind, input, result)` → `ToolView` (shared/tool-kinds.ts). Existing
  `ToolView` variants: `todo {items}`, `plan {plan}`, `question {questions: unknown[]}`,
  `task {description, prompt}`.
- Store: `TodoItem { content, status: TodoStatus, activeForm }`, `TodoStatus = 'pending'|'in_progress'|'completed'`
  (shared/types.ts:327-333). Widget `TodoWidget.tsx` reads `useActiveSession(s => s.todos)`. Feed paths:
  `buildTodosFromMessages` (session-store.ts:75) + `rebuildTodos` (useClaudeEvents.ts:20) for Claude;
  `onPlanSteps`→`setTodos` (useClaudeEvents.ts:325, **dead — no emitter**).
- opencode dispatch: `OpencodeSession.dispatchMapperOutput` (OpencodeSession.ts:508) switch over
  `MapperOutput.kind`; `this.send(channel, payload)`. event-mapper `handleOwnEvent` switch
  (event-mapper.ts:164) has no `todo.updated` case → default ignore.

## 3. The work

### 3a. Extend the neutral shapes (`src/shared/tool-kinds.ts` + `src/shared/types.ts`)
- `ToolView` `task`: `{ kind:'task'; description:string; prompt:string; subagent?:string; model?:string; background?:boolean }`.
- `ToolView` `question`: carry typed normalized questions: `{ kind:'question'; questions: AskUserQuestion[] }`
  (import `AskUserQuestion` from types). Both engines normalize to `AskUserQuestion[]` (Claude passes
  through; opencode maps `multiple`→`multiSelect`).
- `ToolView` `todo`: `{ kind:'todo'; items: { status:string; text:string; activeForm?:string }[] }`
  (add optional `activeForm` for Claude parity in the inline card; opencode leaves it absent).
- `TodoStatus`: extend to `'pending'|'in_progress'|'completed'|'cancelled'`. Render `cancelled` in
  `StatusIndicator` (TodoWidget) + `TodoToolBlock` (muted / strikethrough; pick a minimal, tasteful
  treatment). Claude never emits it → zero Claude change.

### 3b. Fix `OpencodeEngineToolMap` (`tool-registry/OpencodeEngineToolMap.ts`)
- `kindOf`: per the §2 table. Remove dead `list`/`patch`; add `apply_patch`→fileEdit, `websearch`→web,
  `todowrite`→todo, `question`→question, `plan_exit`→plan. Keep `skill`/`lsp`/`invalid`/default →
  unknown.
- `normalize`: add cases:
  - `todo`: `inp.todos[]` `{content,status}` → `items:[{ status, text: content }]` (priority ignored
    for render).
  - `question`: `inp.questions[]` (Question.Prompt) → `AskUserQuestion[]` mapping `multiple`→`multiSelect`,
    `options:[{label,description}]`. Factor the QuestionInfo→AskUserQuestion map so event-mapper's
    `buildQuestionApproval` and this share it (DRY) — or at minimum mirror it exactly.
  - `task`: `{ description, prompt, subagent: inp.subagent_type, model: inp.model, background: inp.background }`.

### 3c. Make `ClaudeEngineToolMap` produce the extended views (`tool-registry/ClaudeEngineToolMap.ts`)
- `task`: add `subagent: inp.subagent_type ?? inp.subagentType`, `model: inp.model`,
  `background: inp.run_in_background`.
- `question`: already `AskUserQuestion[]` shape (Claude `multiSelect`) — ensure the view's typed shape
  matches (Claude options `{label,description}`; pass through).
- `todo`: add `activeForm: t.activeForm` to each item.

### 3d. Lift the four components onto `view` (`MessageBubble.tsx` + the 4 components)
- In `renderToolBlock`, compute `const view = toolMap.normalize(kind, block.toolInput, result)` once and
  pass `view` to each lifted component (keep `block`/`result`/`approval` for ids, streaming join keys,
  and action round-trips).
- `TodoToolBlock`: read `view.items` (not `block.toolInput.todos`). Summary counts from `view.items`.
- `AskUserQuestionBlock` (+ its `View`): read `view.questions` (typed `AskUserQuestion[]`) instead of
  `block.toolInput.questions`. The answer round-trip (`respondApproval(…, answers)`) is unchanged.
- `ExitPlanModeCard`: read `view.plan` instead of `block.toolInput.plan`. **Keep the
  `MessageBubble:121-133` user-message planContent path working** — it builds a synthetic `ExitPlanMode`
  block; either normalize it the same way or pass `plan` directly. Verify both entry points.
- `TaskCard`: read `view.subagent`/`view.model`/`view.background`/`view.description`/`view.prompt`
  instead of `input.subagent_type`/`input.model`/`input.run_in_background`/… Keep all the
  subagent-streaming, background, stop, and approval wiring (those key off `block.toolUseId` and store
  state — leave untouched).

### 3e. Wire the opencode todo widget via `todo.updated`
- `event-mapper.ts`: add a `MapperOutput` variant `{ kind:'todos'; items: TodoItem[] }`. In
  `handleOwnEvent`, add `case 'todo.updated'`: map `props.todos` (`{content,status,priority}`) →
  `TodoItem[]` (`{ content, status, activeForm:'' }`, status incl. `cancelled`). Route is already own-session
  (it carries `properties.sessionID`). **Child sessions: do NOT handle `todo.updated` in
  `handleChildEvent`** (children don't drive the parent widget) → falls through to default ignore; add a
  brief comment.
- `OpencodeSession.dispatchMapperOutput`: add `case 'todos'` → `this.send('session:plan', output.items)`
  (revives the existing wired `onPlanSteps`→`setTodos` path; minimal surface). *(Optional cleanliness:
  rename the channel to `session:todos`/`onTodos` end-to-end if it reads clearer — only if it doesn't
  balloon the diff. Reuse is acceptable.)*
- Claude path (`buildTodosFromMessages`/`rebuildTodos`) is **unchanged**. Result-time dismiss
  (useClaudeEvents `onResult`, TodoWidget "all completed → null") already works engine-neutrally.

## 4. Out of scope (do NOT do)
- #11 coverage polish (structured search/web, single-diff fileEdit, configurable truncation/show-more,
  per-kind name/icon metadata).
- Dedicated kinds for `skill`/`lsp`/`invalid` — leave `unknown`.
- opencode plan-review / `plan_exit` redesign.
- Folding FloatingApproval into `<ApprovalButtons>` (ROADMAP #10).
- Any `bun install` / dep changes.

## 5. Tests (write alongside — catch real bugs, prove they'd fail pre-fix)
- `OpencodeEngineToolMap`: `kindOf` for every id in §2 (esp. `todowrite`→`todo`, `websearch`→`web`,
  `apply_patch`→`fileEdit`; `list`/`patch` gone). `normalize` for `todo`/`question`/`task` field
  mapping (incl. `multiple`→`multiSelect`, `subagent_type`→`subagent`).
- `ClaudeEngineToolMap`: extended `task`/`todo` view fields.
- `event-mapper`: `todo.updated` (own session) → `{kind:'todos', items}` with `cancelled` preserved;
  child `todo.updated` ignored.
- Component: `TodoToolBlock` renders from `view.items` (opencode + Claude shapes); `AskUserQuestionBlock`
  renders/answers from `view.questions`; `TaskCard` reads neutral fields.
- A **guard test** that fails against pre-fix code (e.g. assert `kindOf('todowrite') === 'todo'`).

## 6. Verify gates (report exact output)
1. `bun run typecheck && bun run test && bun run lint && bun run build` (0 lint errors; the 3
   pre-existing exhaustive-deps warnings in Sidebar/ExitPlanModeCard/ReviewBar are OK).
2. Note: this touches `event-mapper`/`OpencodeSession` (main) — run the opencode unit/integration
   projects too if they're separate.
3. Leave the working tree dirty for review. List every changed file with a one-line rationale.

## 7. Gotchas
- **Don't read engine field names in the components after the lift** — that's the whole point. If a
  component still needs something not on the view, extend the view + both normalizers, don't reach into
  `block.toolInput`.
- `task` `subagent_type` is snake_case for BOTH engines — keep the Claude `subagentType` camelCase
  fallback that exists today.
- `apply_patch` has no old/new pair → `fileEdit` view `before/after` empty → generic fallback. That's
  the intended graceful behavior; don't invent patch parsing (that's #11).
- The `question` tool part and the `question.asked` event share a `callID` → the approval maps to the
  tool block by `toolUseId`; FloatingApproval's unmatched filter then excludes it (no double-render).
  **Verify this on the live opencode session** — answering must complete the turn, not hang.
- `cancelled` todo status: extend `TodoStatus` and the two render sites; confirm Claude (no `cancelled`)
  is byte-identical.
- Keep `MessageBubble`'s synthetic-plan user-message path (`:121`) working after ExitPlanModeCard lift.

## 8. Suggested commit (main model writes it after review — agent does NOT commit)
```
feat(v2/tool-rendering): lift plan/question/todo/task onto a neutral ToolView; fix opencode todo

Normalize the four lifted interaction kinds so their components consume the engine-neutral ToolView
instead of engine-specific tool input. Complete the opencode tool→kind map (todowrite→todo,
websearch→web, apply_patch→fileEdit; drop dead list/patch). Feed the floating Todo widget from
opencode's todo.updated event (reviving the session:plan channel). Behavior-preserving for Claude.
```

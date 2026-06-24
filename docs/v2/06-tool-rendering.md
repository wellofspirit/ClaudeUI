# Foundation 6 — Tool Rendering

> **Status: DRAFT for discussion.** Replaces today's scattered, Claude-name-hardcoded tool
> dispatch with a **tool-kind taxonomy + renderer registry**, and improves coverage (the current
> Claude rendering is "usable, not great"). Builds on [01-data-model.md](01-data-model.md)
> (`session.engineId`) and [02-capability-model.md](02-capability-model.md). Grounded in a full
> read of the current chat renderer.

## 1. Current state

Tool calls are dispatched on `toolName` in **three hardcoded sites**:

- `MessageBubble.tsx:243` (single) and `:272` (grouped) — route `ExitPlanMode` / `AskUserQuestion`
  / `TodoWrite` / `Task`|`Agent` to special cards, everything else to `ToolCallBlock`.
- `ToolCallBlock/View.tsx:637` (input) and `:681` (result) — a *second* switch on `Bash` / `Edit`
  / `Read` / `Write` for rich rendering, plus MCP special-cases (`mcp__claude-ui__render_mermaid`,
  `…mockup…`) at `:200`.

Every branch assumes a Claude tool **name** and **input/result shape** (`Edit.old_string`/
`new_string`, `Task.subagent_type`, `TodoWrite.todos`, `ExitPlanMode.plan`, …). And coverage is
uneven: **Glob/Grep/WebFetch/WebSearch/NotebookEdit/MultiEdit get only a JSON dump + raw terminal
view**; Edit shows the same diff twice; truncation limits are hardcoded; approval buttons are
re-implemented in three places.

The ContentBlock contract itself is fine and engine-neutral:
`tool_use { toolUseId, toolName, toolInput }` + `tool_result { toolUseId, toolResult, isError }`
(`types.ts:8`). Streaming attaches out-of-band by `toolUseId` (bash output, subagent deltas).

## 2. The problem for V2

opencode emits tools with different names, casing, and shapes (`bash`, `edit`, `read`, `write`,
`glob`, `grep`, `list`, `task`, `webfetch`; input in `ToolPart.state.input`, output in
`state.completed.output`). Three Claude-name `switch` sites can't absorb that without becoming a
tangle. We need to **separate tool identity from renderer resolution**.

## 3. Neutral model — `ToolKind`

Render by **semantic kind**, not engine tool name. Each engine maps its tool names onto these:

```ts
type ToolKind =
  | 'command'    // shell/exec        — Claude Bash · opencode bash
  | 'fileEdit'   // modify a file     — Claude Edit/MultiEdit · opencode edit/patch
  | 'fileWrite'  // create a file     — Claude Write · opencode write
  | 'fileRead'   // read a file       — Claude Read · opencode read
  | 'search'     // glob/grep/list    — Claude Glob/Grep · opencode glob/grep/list
  | 'web'        // fetch/search web  — Claude WebFetch/WebSearch · opencode webfetch
  | 'todo'       // checklist tool    — Claude TodoWrite  (see §7 boundary)
  | 'task'       // subagent          — Claude Task/Agent · opencode task
  | 'plan'       // plan approval     — Claude ExitPlanMode (see §7 boundary)
  | 'question'   // ask-user          — Claude AskUserQuestion (see §7 boundary)
  | 'diagram'    // hosted MCP        — mcp__claude-ui__render_mermaid (engine-independent)
  | 'mockup'     // hosted MCP        — mcp__claude-ui-mockup__*       (engine-independent)
  | 'mcp'        // other MCP tool    — generic structured render
  | 'unknown'    // fallback          — generic input/output render
```

## 4. Resolution pipeline + registry

One dispatch, replacing all three sites:

```ts
// engine declares its tool-name → kind map (+ a normalizer per kind)
interface EngineToolMap {
  kindOf(toolName: string): ToolKind
  normalize(kind: ToolKind, input: unknown, result?: ToolResult): ToolView   // engine shape → neutral view
}

// registry: kind → renderer (renderers are engine-agnostic, consume ToolView)
const TOOL_RENDERERS: Record<ToolKind, ToolRenderer>

function renderTool(engineId, block, result) {
  const kind = hostedMcpKind(block.toolName)             // mermaid/mockup first — engine-independent
            ?? engineToolMap(engineId).kindOf(block.toolName)
  const view = engineToolMap(engineId).normalize(kind, block.toolInput, result)
  return <TOOL_RENDERERS[kind] view={view} block={block} result={result} approval={approval} />
}
```

- `engineId` comes from the **session** (immutable per session, 01 §3.5) — not per-block.
- Renderers are keyed on **kind**, so `Claude.Edit` and `opencode.edit` share one `fileEdit`
  renderer. Adding an engine = one `EngineToolMap`; adding a kind = one renderer. (SOLID/DRY.)
- **Alternative considered:** keying directly on `(engineId, toolName)` with shared components.
  Rejected — it pushes engine-shape branching back into every renderer; the kind+normalize layer
  keeps renderers ignorant of engines. The normalizer is usually a trivial field rename.

## 5. Neutral view shapes (representative)

```ts
type ToolView =
  | { kind:'command';  command:string; output?:string; exitCode?:number; streaming?:boolean }
  | { kind:'fileEdit'; path:string; before:string; after:string; language?:string }
  | { kind:'fileWrite';path:string; content:string; language?:string }
  | { kind:'fileRead'; path:string; content:string; language?:string; truncated?:boolean }
  | { kind:'search';   query:string; matches:{file:string; line?:number; text:string}[] }
  | { kind:'web';      target:string; body:string }
  | { kind:'task';     description:string; subagent?:string; model?:string; prompt:string; output?:string; usage?:Usage }
  | { kind:'todo';     items:{status:string; text:string}[] }
  | … // plan, question, diagram, mockup, mcp, unknown
```

The normalizer maps each engine's field names onto these (Claude `old_string`/`new_string` →
`before`/`after`; opencode `oldString`/`newString` → same). Renderers never see engine field names.

## 6. Engine tool→kind maps

| Kind | Claude names | opencode names |
| --- | --- | --- |
| command | Bash | bash |
| fileEdit | Edit, MultiEdit | edit, patch |
| fileWrite | Write | write |
| fileRead | Read | read |
| search | Glob, Grep | glob, grep, list |
| web | WebFetch, WebSearch | webfetch |
| task | Task, Agent | task |
| todo | TodoWrite | — (events, §7) |
| plan | ExitPlanMode | — (events, §7) |
| question | AskUserQuestion | — (events, §7) |
| diagram/mockup | hosted MCP (engine-independent) | hosted MCP |
| mcp | `mcp__*` | `mcp__*` / opencode MCP names |
| unknown | (fallback) | (fallback) |

Hidden tools (`TaskCreate/Update/List/Get`, `EnterPlanMode`) stay suppressed — model that as a
per-engine `hidden` set, not a render kind.

**Maintenance:** engines add tools over time — periodically review each engine's tool list and
extend its `kindOf` map. Until a tool is mapped, it falls to `unknown` and still renders via the
generic body (graceful degradation, never a crash).

## 7. Two render modes — passive cards vs lifted interactions

Not everything that arrives as a Claude tool call should render as a passive tool card. Three
concepts are **interactions** and should be *lifted* out of the registry into neutral state that
**both engines feed** — Claude via a tool call, opencode via an event/request — converging on one
renderer per concept (the "map Claude's as events too" unification):

| Concept | Claude transport | opencode transport | Interaction shape & neutral home |
| --- | --- | --- | --- |
| **question** | `AskUserQuestion` tool — answer returned via `respondApproval(…, answers)` | `question.v2` server-request → reply | **request/response** → joins the **approval/elicitation layer** (answer consumed by the model; *not* a passive card) |
| **plan** | `ExitPlanMode` tool — plan + accept/refine | plan agent → `session:plan` / plan→build | **state-gate** → **plan-review**; the approval maps to autonomy modes (03 §4) |
| **todo** | `TodoWrite` tool (snapshot) | `turn/plan/updated` event | **passive snapshot** → the **Todo widget** (already wired for opencode) |

So `AskUserQuestion` ≠ `ExitPlanMode`: question is a genuine request/response (belongs with
approvals), plan is a state-gate, todo is a snapshot — three distinct shapes, all lifted from the
passive registry, each fed from whichever transport the engine uses.

**The registry (§4) renders only the *passive* kinds** — command, fileEdit, fileWrite, fileRead,
search, web, task, diagram, mockup, mcp, unknown. The `plan`/`todo`/`question` kinds remain as
routing labels (a Claude tool_use with those names is *recognized*), but they **route into the
interaction layer**, not a passive card — and that layer is shared with opencode's event paths.
One renderer per concept, two transports in.

## 8. Structural fixes this unlocks

- **One dispatch** (the registry) replaces the three `switch` sites — single source of truth.
- **Shared `ToolCard` shell + kind body** — common header (name/icon/status/expand), a single
  extracted `<ApprovalButtons>` (kills the 3× duplication: generic + mermaid + mockup), common
  footer; the kind renderer supplies only the body.
- **Configurable truncation** — replace the hardcoded 5000/2000-char cuts with a setting + a
  "show more" affordance, uniformly across kinds.
- Display metadata (name, icon, one-line summary) becomes a per-kind/per-engine concern, replacing
  the hardcoded name lists in `utils.ts`.

## 9. Coverage improvements (the "not great" → better)

**Deferred to after opencode integration** — these are cosmetic and low-priority; the generic
fallback renders the weak tools acceptably meanwhile. Candidates for when we return:

- **search** — render Grep/Glob/list as a **match list** (file · line · highlighted text), not a
  JSON blob.
- **web** — render WebFetch/WebSearch results structured (title/url/snippet), not raw terminal.
- **fileEdit** — stop showing the same diff twice (input *and* result); show it once.
- **error states** — a consistent error renderer with context, not a red `<pre>`.
- **fileWrite/large outputs** — paginate/truncate-with-expand consistently.

Scope question in §11 — do these land with the registry (v1) or as a fast-follow.

## 10. Migration (incremental — no big-bang)

1. Introduce `ToolKind` + `TOOL_RENDERERS` + the Claude `EngineToolMap`; route the existing
   dispatch through it. Existing components (`TaskCard`, `ExitPlanModeCard`, `AskUserQuestionBlock`,
   `TodoToolBlock`, the Bash/Edit/Read/Write bodies) are **refactored to consume `ToolView`** and
   registered by kind — behavior-preserving for Claude.
2. Add the opencode `EngineToolMap` (names + normalizers) — opencode tool blocks now render via the
   same kind renderers.
3. Improve weak kinds (search/web/error) as a second pass.

No ContentBlock change required; `engineId` is read from session context.

## 11. Decisions

1. **`ToolKind` taxonomy** ✓ — keep the current set. **Maintenance:** periodically review each
   engine's tool list and extend its `kindOf` map (§6); `unknown` covers gaps meanwhile.
2. **Kind-based registry** ✓ — kind keys + per-engine `kindOf`/`normalize`; renderers stay
   engine-ignorant (chosen over `(engine,toolName)`-keyed).
3. **Passive cards vs lifted interactions** ✓ (refined, §7) — `question`/`plan`/`todo` are lifted
   from the passive registry into neutral interactions fed from either transport: **question →
   approval/elicitation layer** (request/response), **plan → plan-review** (state-gate), **todo →
   Todo widget** (snapshot). The registry renders the passive kinds only.
4. **Coverage-improvement scope** ✓ — **deferred to post-opencode-integration** (cosmetic, low
   priority); v1 = registry + behavior-preserving Claude port, with the generic fallback covering
   weak/new tools. Search/web/error polish comes later.
5. **Pain points** ✓ — acknowledged (bland search/web, double-diff, hardcoded truncation, plain
   errors); all deferred as cosmetic per #4.

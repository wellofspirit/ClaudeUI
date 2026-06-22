# Phase 6 — Tool registry (ToolKind taxonomy + renderer registry)

> Implements [foundation 6](06-tool-rendering.md). Replaces the **three hardcoded, Claude-name
> dispatch sites** with one kind-based registry; extracts the 3×-duplicated approval buttons; ports
> Claude's existing cards to **kind renderers consuming a neutral `ToolView`** (behavior-preserving);
> then adds the opencode `EngineToolMap` so opencode's tools get the same rich cards. **Coverage
> polish (§9) is DEFERRED** (foundation decision #4). **Claude rendering must be pixel-equivalent.**

Delivered as **two review passes under one `v2-phase-6-tool-registry` branch + one commit**:
- **Pass 1** — registry + Claude `EngineToolMap` + `ToolCard`/`<ApprovalButtons>` + unified dispatch
  (behavior-preserving Claude port). The big, risky pass.
- **Pass 2** — opencode `EngineToolMap` (names + normalizers); opencode tool blocks render via the same
  kind renderers; retire the 5c tool-name normalization hack in `event-mapper.ts` (the registry's
  `hostedMcpKind` + opencode `kindOf` now handle mermaid/mockup + bash/edit/read/etc.).

## Verified current architecture (from a full renderer read — preserve ALL of this)

**3 dispatch sites** (Phase 6 collapses them to one):
1. `MessageBubble.tsx` — single (~:243) + grouped (~:268) routes: `ExitPlanMode→ExitPlanModeCard`,
   `AskUserQuestion→AskUserQuestionBlock`, `TodoWrite(∈TODO_TOOLS)→TodoToolBlock`,
   `isAgentTool→TaskCard`, else `→ToolCallBlock`. `HIDDEN_TOOLS = {EnterPlanMode, TaskCreate, TaskUpdate,
   TaskList, TaskGet}` suppressed. Approval bound by `approval.toolUseId===block.toolUseId` (primary)
   or a legacy toolName+input-signature fallback (:168-189) — **keep both**.
2. `ToolCallBlock/View.tsx` — MCP special-cases (mermaid ~:203, mockup ~:204-320) each with their OWN
   inline approval buttons; the main handler with the **input switch** (~:640 `ToolInput`:
   Bash`command`/Edit`old_string,new_string`→DiffViewer/Read,Write`file_path`/else JSON) and **result
   switch** (~:684 `ToolResult`: Write→`WriteResult`(CodeView+markdown toggle)/Edit→DiffViewer/Read→
   CodeView/Bash→TerminalView/error→red pre trunc2000/else TerminalView), expand/collapse, live bash
   (`LiveBashOutput` :512), background bash (`BackgroundBashOutput` :555), the main approval section
   (:432 — decision reason + `AlwaysAllowSection` + Deny/Allow).
3. (The above two switches ARE the "three sites" — input + result count separately.)

**Approval buttons — 3× duplication** (mermaid :241, mockup :302, main :432): all call
`onApproval(decision, selectedSuggestions)`; main + floating use `AlwaysAllowSection`
(`PermissionSuggestions.tsx`) for `approval.suggestions`. **Extract one `<ApprovalButtons>`.**
`FloatingApproval.tsx` handles UNMATCHED approvals (no tool card) — leave it, but it should reuse the
extracted `<ApprovalButtons>`/`AlwaysAllowSection` too (dedup).

**Bodies to preserve exactly:** `DiffViewer` (lib/diff), `CodeView` (prism), `TerminalView` (ansi_up),
`WriteResult` (markdown preview/code toggle), `MarkdownRenderer`. Truncation 5000 (read/write) / 2000
(error) — keep as-is (configurable truncation is §8/deferred).

**Streaming by `toolUseId` (NON-NEGOTIABLE join key):** `bashOutputs[id]`, `backgroundOutputs[id]`,
`subagentMessages/StreamingText/StreamingThinking[id]`, `taskNotifications.find(toolUseId)`,
`taskProgressMap[id]`. Cards read these from `useActiveSession`. The registry/ToolView must NOT change
how cards reach this state — pass `block.toolUseId` through.

**Tests (regression guards — keep green, extend):** `MessageBubble.unit.test.tsx` (dispatch),
`ToolCallBlock.component.test.ts` (approval/bg IPC), `utils.test.ts` (`getSummary`/`resolveToolVisualState`),
`AskUserQuestionBlock.component.test.ts`, `FloatingApproval.component.test.tsx`,
`PermissionSuggestions.test.ts`, `ExitPlanModeCard.component.test.ts`, `CodeView.test.ts`.

## Pass 1 — registry + Claude port (behavior-preserving)

1. **`ToolKind`** (`src/shared/tool-kinds.ts` or `src/renderer/.../tool-registry/`): the §3 union
   (`command|fileEdit|fileWrite|fileRead|search|web|todo|task|plan|question|diagram|mockup|mcp|unknown`).
2. **`ToolView`** (§5) neutral view shapes per kind; **`EngineToolMap`** interface: `kindOf(toolName):
   ToolKind`, `normalize(kind, input, result?): ToolView`, `hidden: Set<string>`.
   **`hostedMcpKind(toolName)`** (engine-independent): `mcp__claude-ui__render_mermaid→diagram`,
   `mcp__claude-ui-mockup__*→mockup`, other `mcp__*→mcp`.
3. **`ClaudeEngineToolMap`** — `kindOf` per §6 (Bash→command, Edit/MultiEdit→fileEdit, Write→fileWrite,
   Read→fileRead, Glob/Grep→search, WebFetch/WebSearch→web, Task/Agent→task, TodoWrite→todo,
   ExitPlanMode→plan, AskUserQuestion→question); `hidden = HIDDEN_TOOLS`; `normalize` maps Claude field
   names → ToolView (Edit `old_string/new_string`→`before/after`, Bash `command`+result→`command/output`,
   Read `file_path`+result→`path/content`, Write `file_path`+`content`→`path/content`, etc.).
4. **`<ApprovalButtons>`** — extract from the 3 sites: props `{approval, permissionMode, onApproval,
   showSuggestions?}`; renders the decision-reason + `AlwaysAllowSection` (when suggestions) + Deny/
   Allow(/Allow-for-session). Used by the ToolCard, the mermaid/mockup bodies, AND `FloatingApproval`.
5. **`<ToolCard>` shell** — common header (icon/name/status/expand from `utils.ts:getSummary`/visual
   state), body slot, `<ApprovalButtons>`, footer. The kind renderer supplies only the body.
6. **`TOOL_RENDERERS: Record<ToolKind, KindRenderer>`** — passive kinds render via `ToolCard` + body:
   - `command`→TerminalView(output) + LiveBashOutput/BackgroundBashOutput wiring (by toolUseId);
     `fileEdit`→DiffViewer(before/after) **once** (not twice — but keep current double-render if needed
     for behavior-parity in v1; note it); `fileWrite`→WriteResult; `fileRead`→CodeView; `search`/`web`/
     `mcp`/`unknown`→generic (current JSON input + TerminalView result fallback); `diagram`→MermaidDiagram;
     `mockup`→MockupPreviewCard. **These reuse the EXISTING body components** (DiffViewer/CodeView/
     TerminalView/WriteResult/MermaidDiagram/MockupPreviewCard) — refactored to read `ToolView` fields
     instead of `block.toolName`-switching.
   - **Lifted kinds** route OUT to the existing interaction components (NOT the passive ToolCard):
     `plan→ExitPlanModeCard`, `question→AskUserQuestionBlock`, `todo→TodoToolBlock`, `task→TaskCard`.
     (These keep consuming `block` directly in v1 — lifting them to fully engine-neutral state is a
     fast-follow; for Pass 1 they just become registry routing targets, behavior unchanged.)
7. **Unified dispatch** — one `renderToolBlock(engineId, block, result, approval, …streaming)` used by
   BOTH MessageBubble routes (single + grouped). It computes `kind` (hostedMcpKind ?? engineToolMap.
   kindOf), suppresses `hidden`, routes lifted kinds to their components, else renders `ToolCard`.
   `engineId` from the session (`useActiveSession`/status). Delete the ToolCallBlock input/result
   `switch`es (their bodies move to kind renderers) — OR keep ToolCallBlock as the `command/file*/
   generic` ToolCard body host if cleaner; the requirement is ONE dispatch + kind-keyed bodies, no
   per-toolName switching outside the EngineToolMap.
8. **Behavior-preservation gate:** Claude chat must render identically — diffs, code (prism), terminal
   (ansi), bash streaming, background bash, expand/collapse, approval + suggestions, hidden tools,
   grouping, `getSummary` headers. The verifier-electron smoke + the existing component tests are the
   proof.

## Pass 2 — opencode EngineToolMap
- **`OpencodeEngineToolMap`** — `kindOf` per §6 (bash→command, edit/patch→fileEdit, write→fileWrite,
  read→fileRead, glob/grep/list→search, webfetch→web, task→task; `mcp__*` via hostedMcpKind);
  `normalize` maps opencode field names (the mapper's `tool_use` block already carries `toolInput` from
  `state.input`; opencode `oldString/newString`→`before/after`, etc.). `hidden` = opencode's internal
  tools if any.
- **Retire the 5c hack:** remove `OPENCODE_TOOL_NAME_MAP`/`normalizeOpencodeToolName` application in
  `event-mapper.ts` (keep the plugin tool NAMES as `render_mermaid`/`create_mockup`/`show_mockup`); the
  registry's `hostedMcpKind` won't match those bare names, so EITHER keep a tiny opencode `kindOf`
  mapping `render_mermaid→diagram`, `create_mockup/show_mockup→mockup` (cleaner — the mapping moves from
  the mapper into the opencode EngineToolMap), and the diagram/mockup renderers read `ToolView`
  (source/html/directory) regardless of engine. Confirm the mermaid/mockup cards still render for
  opencode (the renderer is now kind-keyed, not name-keyed).
- Register both EngineToolMaps in a `engineToolMap(engineId)` lookup.

## Out of scope (deferred — foundation §9 / decision #4)
Coverage polish: search match-list, structured web results, single-diff for fileEdit, consistent error
renderer, configurable truncation + show-more. Fully lifting plan/question/todo to engine-neutral
interaction state (they stay routed to their existing components in v1). Phase 7 metering.

## Testing
- Keep ALL existing tool-rendering tests green (they ARE the behavior-preservation guard). Adjust only
  where a component's props legitimately change (e.g. a body now takes `ToolView`); preserve the
  assertions' intent.
- New: `EngineToolMap` unit tests — Claude `kindOf` for every mapped tool + `hidden`; `normalize`
  field-mapping per kind; `hostedMcpKind`. opencode `kindOf`/`normalize` (Pass 2). The unified
  `renderToolBlock` dispatch (kind resolution, hidden suppression, lifted-kind routing).
- `<ApprovalButtons>` extraction test (decision/suggestions wiring identical across the 3 former sites).

## Verify
```
bun run typecheck && bun run test && bun run test:ci && bun run lint && bun run build
```
- **Runtime smoke (verifier-electron — this is a heavy renderer change):** open a Claude session with a
  rich transcript (Bash, Edit diff, Read, a Task/subagent, a mermaid, an approval) → screenshot →
  assert each renders identically to before (read the PNG; compare against `.cache/screenshots` from
  5b/5c if useful). Drive an approval → assert the extracted buttons work. Then an opencode session
  (free model) calling bash + render_mermaid → assert the rich command card + mermaid card render via
  the kind registry. **Read the PNGs.**
- Claude is the daily driver — any rendering regression is a real bug. Be thorough.

## Gotchas
- **Behavior-preserving for Claude is the bar** — this refactors the most complex renderer. Reuse the
  existing body components (DiffViewer/CodeView/TerminalView/WriteResult/Mermaid/Mockup); change only
  how they're SELECTED (kind, not toolName) and FED (ToolView, not raw block fields where practical).
- **`toolUseId` is the streaming join key** — never change it; cards must still read `bashOutputs[id]`
  etc. Pass it through every kind renderer that needs streaming (command, task).
- **Approval binding** — keep BOTH the `toolUseId` primary + legacy signature fallback in the dispatch.
- **Lifted kinds keep working** — plan/question/todo/task must route to ExitPlanModeCard/
  AskUserQuestionBlock/TodoToolBlock/TaskCard with unchanged behavior (the answer-key-by-question-text
  for AskUserQuestion is critical — don't touch it).
- **opencode mermaid/mockup** — after retiring the mapper name-normalization, the diagram/mockup
  renderers must be kind-keyed (engine-independent) so opencode's `render_mermaid` (→diagram kind via
  opencode `kindOf`) renders the same card. Re-verify the 5c plugin path end-to-end.
- **No `bun install`/`bun add`** (better-sqlite3 ABI). No new runtime deps expected.
- **Pre-existing:** 3 `exhaustive-deps` lint warnings — leave them.

## Commit
Branch `v2-phase-6-tool-registry` off `v2-phase-5c-opencode-auth-mcp`; **no AI attribution**; one
commit after both passes review clean. Suggested subject:
`feat(v2): tool-kind registry + ApprovalButtons extraction + opencode tool map (Phase 6)`.

# src/renderer/src/components/chat/tool-registry

Turns an engine's tool call into a neutral `ToolView` and picks the card that draws it. The taxonomy is shared: `ToolKind`, `ToolView`, `EngineToolMap` and `hostedMcpKind` in `src/shared/tool-kinds.ts`.

## What lives here

- `ClaudeEngineToolMap.ts`, `OpencodeEngineToolMap.ts`, `PiEngineToolMap.ts`: per engine, `kindOf` (tool name to kind), `normalize` (kind plus input to `ToolView`), `displayName`; `engine-tool-maps.ts` picks one by engine id.
- `claude-tool-specs.ts`: `CLAUDE_TOOL_SPECS`, the card shape (`detail`, `findings` or `note`) of each Claude tool that has no kind of its own.
- `kinds/`: one body per kind; `kinds/index.ts` holds `TOOL_RENDERERS`. `summary.ts` is the header text, `chips.ts` the header chips, `approval-action.ts` the approval card's tool label.
- `src/shared/first-party-tool-names.ts`: labels and server ownership of ClaudeUI's own tools; `src/shared/session-tools-description.ts` names the session tools.
- Kinds: `command` shell; `fileEdit`, `fileWrite`, `fileRead` file tools; `search`; `web`; `image`; `diagram`, `mockup` hosted cards that draw the whole card; `mcp` any other MCP tool; `detail` field list; `findings` review rows; `unknown` fallback.
- Lifted kinds, absent from `TOOL_RENDERERS` and routed by `renderToolBlock` in `src/renderer/src/components/chat/MessageBubble.tsx`: `todo`, `task`, `plan`, `question`, `note`.

## Recipes

**A new tool name on an existing kind** (exemplars: the session tools in each map; `src/renderer/src/components/chat/tool-registry/__tests__/session-tools-maps.test.ts`)

1. Claude: a `case` in `claudeKindOf`, or for `detail`, `findings`, `note` one entry in `CLAUDE_TOOL_SPECS` in `claude-tool-specs.ts` [nothing]. A native name without either renders as `unknown`.
2. opencode: `opencodeKindOf` case in `OpencodeEngineToolMap.ts`; a `normalize` case only if the input shape differs from the kind's [nothing].
3. pi: `piKindOf` case in `PiEngineToolMap.ts` and the same case in `piToolKind` in `src/core/pi/permission-engine.ts`; add the name to the `cases` table of `PiEngineToolMap.test.ts` or the parity guard does not see it [test: PiEngineToolMap.test.ts].
4. A `displayName` entry (`OPENCODE_DISPLAY_NAMES`, `PI_DISPLAY_NAMES`) when the wire name is not display-ready [nothing].

**A new kind with its card body**

1. `src/shared/tool-kinds.ts`: `ToolKind` member and `ToolView` variant [compiler for the member in `TOOL_RENDERERS`; the variant is not forced].
2. `kinds/<X>Body.tsx`: copy `kinds/DetailBody.tsx` (standard card) or `kinds/DiagramBody.tsx` (draws its own card).
3. `kinds/index.ts`, `TOOL_RENDERERS`: one entry; the record is exhaustive over `PassiveToolKind` [compiler].
4. Each engine map: `kindOf` case and `normalize` case, in all three [nothing]; a missing `normalize` case returns the `unknown` view.
5. `summary.ts` (`default:`), `chips.ts` (`default:`), `src/renderer/src/components/chat/ChatPanel/estimate-height.ts` (two switches with `default:`): a new kind compiles and gets a generic row and a wrong height, which shows as a scroll jump [nothing].
6. Tests: the three engine-map specs, `renderToolBlock.test.tsx`, and a body test beside `__tests__/DetailBody.component.test.tsx`.

**The renderer half of a hosted MCP tool** (ClaudeUI-owned; exemplar `render_mermaid`; host half: `src/core/services/CLAUDE.md`)

1. Spellings: Claude `mcp__<server>__<tool>`, opencode `claudeui_<tool>`, pi the bare `<tool>`.
2. `src/shared/tool-kinds.ts`, `hostedMcpKind`: the Claude spelling only; without it the call renders as generic `mcp` [nothing].
3. `src/shared/first-party-tool-names.ts`: `FIXED_LABELS` and `FIRST_PARTY_MCP_SERVERS` [test: first-party-display-names.test.ts].
4. `ClaudeEngineToolMap.ts` needs no `kindOf` case (`hostedMcpKind` answers first); `OpencodeEngineToolMap.ts` and `PiEngineToolMap.ts` need a `kindOf` case in their own spelling, as does `piToolKind` [test: PiEngineToolMap.test.ts].
5. A `normalize` case per engine when the kind is new (the diagram and mockup cases repeat in all three maps) [nothing].

## Invariants

- `summary.ts`, `chips.ts` and `estimate-height.ts` end in `default:`; a new kind never fails to compile there.
- `piToolKind` in `src/core/pi/permission-engine.ts` mirrors `piKindOf` because `src/core` cannot import the renderer; `PiEngineToolMap.test.ts` checks only the names in its `cases` table.
- `TOOL_RENDERERS` is a `Record<PassiveToolKind, KindRenderer>`: a new passive kind without a body is a type error. The lifted kinds are excluded from `PassiveToolKind`.
- `hostedMcpKind` is consulted before each engine's `kindOf`, so it wins for a name it recognises.

## Fast test

- `bunx vitest run src/renderer/src/components/chat/tool-registry/__tests__/ClaudeEngineToolMap.test.ts src/renderer/src/components/chat/tool-registry/__tests__/OpencodeEngineToolMap.test.ts src/renderer/src/components/chat/tool-registry/__tests__/PiEngineToolMap.test.ts`
- `bunx vitest run src/renderer/src/components/chat/tool-registry/__tests__/first-party-display-names.test.ts src/renderer/src/components/chat/tool-registry/__tests__/renderToolBlock.test.tsx`

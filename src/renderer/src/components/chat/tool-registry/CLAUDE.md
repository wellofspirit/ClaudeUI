# src/renderer/src/components/chat/tool-registry

Turns an engine's tool call into a neutral `ToolView` and picks the card that draws it. The taxonomy is shared: `ToolKind`, `ToolView`, `EngineToolMap` and `hostedMcpKind` in `src/shared/tool-kinds.ts`.

## What lives here

- `ClaudeEngineToolMap.ts`, `OpencodeEngineToolMap.ts`, `PiEngineToolMap.ts`: per engine, `kindOf` (tool name to kind), `normalize` (kind plus input to `ToolView`), `displayName`; `engine-tool-maps.ts` picks one by engine id.
- `claude-tool-specs.ts`: `CLAUDE_TOOL_SPECS`, the card shape (`detail`, `findings` or `note`) of each Claude tool that has no kind of its own.
- `kinds/`: one body per kind; `kinds/index.ts` holds `TOOL_RENDERERS`. `summary.ts` is the header text, `chips.ts` the header chips, `approval-action.ts` the approval card's tool label.
- `src/shared/hosted-tools.ts`: `HOSTED_TOOLS`, one row per ClaudeUI-owned tool (Claude server, kind, label), its three spellings, and `hostedToolView` (the `diagram` and `mockup` views). `src/shared/pi-tool-kinds.ts`: `piToolKind`, pi's name to kind, which is `PiEngineToolMap.kindOf` and what the permission ladder reads. `src/shared/session-tools-description.ts` names the session tools.
- Kinds: `command` shell; `fileEdit`, `fileWrite`, `fileRead` file tools; `search`; `web`; `image`; `diagram`, `mockup` hosted cards that draw the whole card; `mcp` any other MCP tool; `detail` field list; `findings` review rows; `unknown` fallback.
- Lifted kinds, absent from `TOOL_RENDERERS` and routed by `renderToolBlock` in `src/renderer/src/components/chat/MessageBubble.tsx`: `todo`, `task`, `plan`, `question`, `note`.

## Recipes

**A new name for an engine's own tool, on an existing kind** (exemplar: pi's `list_models`)

1. Claude: a `case` in `claudeKindOf`, or for `detail`, `findings`, `note` one entry in `CLAUDE_TOOL_SPECS` in `claude-tool-specs.ts` [nothing]. A native name without either renders as `unknown`.
2. opencode: `opencodeKindOf` case in `OpencodeEngineToolMap.ts`; a `normalize` case only if the input shape differs from the kind's [nothing].
3. pi: a case in `piToolKind` in `src/shared/pi-tool-kinds.ts`. The ladder in `src/core/pi/permission-engine.ts` reads the same function, so this is a permission change: a Critical area (root `CLAUDE.md`) [nothing forces the name into `tool-kind-matrix.test.ts`: add it].
4. A `displayName` entry (`OPENCODE_DISPLAY_NAMES`, `PI_DISPLAY_NAMES`) when the wire name is not display-ready [nothing].

**A new kind with its card body**

1. `src/shared/tool-kinds.ts`: `ToolKind` member and `ToolView` variant [compiler: `TOOL_RENDERERS`, `summary.ts` and the two switches in `src/renderer/src/components/chat/ChatPanel/estimate-height.ts` each name the missing kind].
2. `kinds/<X>Body.tsx`: copy `kinds/DetailBody.tsx` (standard card) or `kinds/DiagramBody.tsx` (draws its own card).
3. `kinds/index.ts`, `TOOL_RENDERERS`: one entry; the record is exhaustive over `PassiveToolKind` [compiler].
4. `summary.ts` and `estimate-height.ts`: the header text and the height of the new kind [compiler]. A wrong height shows as a scroll jump.
5. Each engine map: `kindOf` case and `normalize` case, in all three [nothing]; a missing `normalize` case returns the `unknown` view. A kind only ClaudeUI's own tools use needs neither: see the next recipe.
6. `chips.ts` ends in `default:` (no chips) [nothing].
7. Tests: the three engine-map specs, `renderToolBlock.test.tsx`, and a body test beside `__tests__/DetailBody.component.test.tsx`.

**The renderer half of a hosted MCP tool** (ClaudeUI-owned; exemplar `render_mermaid`; host half: `src/core/services/CLAUDE.md`)

1. Spellings: Claude `mcp__<server>__<tool>`, opencode `claudeui_<tool>`, pi the bare `<tool>`.
2. `src/shared/hosted-tools.ts`: one `HOSTED_TOOLS` row (`claudeServer`, `kind`, `label`). `hostedMcpKind`, the opencode and pi `kindOf`, the ladder's `piToolKind` and every `displayName` read it; no engine map needs a case [test: `tool-kind-matrix.test.ts` fails until the name is in its `HOSTED` list, then its snapshot shows the new rows].
3. A new kind for it: one branch in `hostedToolView` in the same file; every map's `normalize` asks it first [nothing], plus the recipe above.

## Invariants

- `summary.ts` and both switches in `estimate-height.ts` are exhaustive (`satisfies never`): a new kind fails to compile there. `chips.ts` ends in `default:`.
- pi's `kindOf` is `piToolKind` in `src/shared/pi-tool-kinds.ts`, the function `decideWithSource` in `src/core/pi/permission-engine.ts` reads: a kind that moves is a permission change. `tool-kind-matrix.test.ts` pins the kind and label of every known name on every engine; a diff in its snapshot gets the review a ladder change gets.
- `TOOL_RENDERERS` is a `Record<PassiveToolKind, KindRenderer>`: a new passive kind without a body is a type error. The lifted kinds are excluded from `PassiveToolKind`.
- `hostedMcpKind` is consulted before each engine's `kindOf`, so it wins for a name it recognises.
- Table lookups by tool name go through `Object.hasOwn` (`claudeToolSpec`, the display-name tables, `HOSTED_TOOLS`): `constructor` is a legal tool name.

## Fast test

- `bunx vitest run src/renderer/src/components/chat/tool-registry/__tests__/ClaudeEngineToolMap.test.ts src/renderer/src/components/chat/tool-registry/__tests__/OpencodeEngineToolMap.test.ts src/renderer/src/components/chat/tool-registry/__tests__/PiEngineToolMap.test.ts`
- `bunx vitest run src/renderer/src/components/chat/tool-registry/__tests__/tool-kind-matrix.test.ts src/shared/__tests__/hosted-tools.test.ts src/renderer/src/components/chat/tool-registry/__tests__/first-party-display-names.test.ts src/renderer/src/components/chat/tool-registry/__tests__/renderToolBlock.test.tsx`

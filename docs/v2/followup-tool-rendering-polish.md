# Follow-up — Tool-rendering coverage polish (ROADMAP #11, scoped to c/d/e)

> Kickoff spec. Implementing agent: **Sonnet, `general-purpose`**. Main model (Opus) reviews and owns
> correctness. Do **not** commit, `git add`, branch, or `bun install`. Leave the tree for review;
> report deltas, exact verify-gate output, deviations.

Builds directly on `v2-followup-tool-rendering-lift` (ROADMAP #9, already merged into this branch's
base). That work made the lifted kinds consume the neutral `ToolView`; this one polishes the **passive**
rendering + display metadata.

## 0. Scope (locked with the user)

**IN — three sub-items:**
- **(c) fileEdit single-diff** — stop rendering the edit diff twice (Input *and* Result).
- **(d) truncation + show-more** — replace the hardcoded `trunc(text, 2000/5000)` cuts with a uniform
  truncate-with-"show more" affordance + one configurable setting.
- **(e) per-kind display metadata** — drive the card's **name + one-line summary** off the engine-neutral
  `kind`/`ToolView` instead of the Claude-name-hardcoded `getSummary`/raw `toolName`. This is the real
  win: opencode cards today show raw lowercase labels (`bash`, `todowrite`) + `JSON.stringify(input)`
  summaries.

**OUT (do NOT do):**
- **(a) structured search** + **(b) structured web** result parsing — deferred (brittle freeform-text
  parsing, lowest value-per-risk). The generic body keeps rendering them.
- **Per-tool icons** — net-new visual design; the card has only a status icon today. Keep it that way.
- Any `bun install` / dep change. Any change to the lifted kinds' behavior.

## 1. Verified facts (grounded — don't re-discover)

- **Passive bodies** live in `src/renderer/src/components/chat/tool-registry/kinds/`:
  `GenericBody.tsx` (search/web/mcp/unknown), `FileEditBody.tsx`, `FileReadBody.tsx`, `FileWriteBody.tsx`,
  `CommandBody.tsx`, `DiagramBody.tsx`, `MockupBody.tsx`. They receive `KindBodyProps`
  (`kinds/types.ts`) — `{ view, block, result, expanded, hideToolInput, theme, isError, … }`.
- **The card shell** is `tool-registry/ToolCard.tsx`. Header at `:238` renders `{block.toolName}` (raw)
  + `getSummary(block)` (`:116/:240`). The body is `TOOL_RENDERERS[kind].Body` (`kinds/index.ts`).
  ToolCard is invoked by `ToolCallBlock` (the host) **and directly by `SubagentMessages`** for subagent
  tool calls — both call sites matter for any new prop.
- **`getSummary`** (`ToolCallBlock/utils.ts:82-118`) is a Claude-`toolName` switch
  (Read/Write/Edit/Bash/Glob/Grep/AskUserQuestion/TodoWrite/mermaid/mockup/agent/TaskOutput/TaskStop) →
  falls through to `JSON.stringify(input)`. opencode names never match → JSON blob. Also `shorten` +
  `trunc` live here. Confirm refs before moving (`getSummary` is imported by ToolCard; grep for others).
- **Double-diff:** `FileEditBody.tsx:43-47` (Input) and `:65-68` (Result) both render `<DiffViewer
  oldStr={before} newStr={after}>` when `hasDiff`. The before/after come from the **input**, so the
  Result diff is a pure duplicate.
- **Truncation cuts:** `GenericBody` error `trunc(text,2000)`; `FileEditBody` error `trunc(text,2000)`;
  `FileReadBody` success `trunc(text,5000)` (into `CodeView`) + error `trunc(text,2000)`. `trunc` is a
  hard slice — content past the limit is **lost**, not scrollable.
- **Settings:** `AppSettings` (session-store.ts:140) + `DEFAULT_SETTINGS` (:181). The **`tool-output`**
  settings section (`settings-sections.tsx:1095-1166`) holds `expandToolCalls`/`expandReadResults`/
  `hideToolInput`/`expandThinking` toggles. Number-setting controls exist (`maxRecentSessions`,
  `chatWidthPx`, `chatFontScale`) — mirror their control component for the new number setting.
- **EngineToolMap** (`shared/tool-kinds.ts`) has `kindOf`/`normalize`/`hidden`. Both impls in
  `tool-registry/{Claude,Opencode}EngineToolMap.ts`.

## 2. The work

### (e) Per-kind display metadata  ← do this first; biggest blast radius
**Goal:** card name + summary come from `kind`/`view` (engine-neutral), Claude byte-identical.

1. **Summary off the view.** Add a pure `summarizeTool(kind, view): string` (renderer util, e.g.
   `tool-registry/summary.ts`; may import `shorten`). Map per kind so it reproduces `getSummary` **exactly**
   for Claude:
   - command → `view.command`
   - fileRead/fileWrite/fileEdit → `shorten(view.path)`
   - search → `view.query`
   - web → `view.target`
   - todo → `${completed}/${total} tasks` (from `view.items`; completed = status==='completed')
   - task → `view.description`
   - question → `${n} question${n!==1?'s':''}` (from `view.questions.length`)
   - diagram → `view.title ?? 'diagram'`
   - mockup → `view.title ?? (view.directory ? 'show mockup' : 'new mockup')` *(minor wording drift from
     the old `show <dir8>` is acceptable — note it)*
   - mcp/unknown → `JSON.stringify(view.input)`
   ToolCard calls `summarizeTool(kind, view)` instead of `getSummary(block)`. opencode now gets real
   summaries (bash→`ls -la`, todowrite→`3/5 tasks`). **Add a test asserting `summarizeTool` ===
   the old `getSummary` for a representative Claude block of each kind** (regression guard). Keep/retire
   `getSummary` based on remaining refs (if only ToolCard used it, retire it; otherwise leave + delegate).
2. **Display name (header).** Extend `EngineToolMap` with `displayName(toolName: string): string`.
   - Claude: passthrough — names are already display-ready (`Bash`/`Read`/`Edit`/`Glob`/`Grep`/`Write`/
     `WebFetch`/`WebSearch`/`TodoWrite`/`AskUserQuestion`/`ExitPlanMode`); return as-is (handle hosted MCP
     + agent tools sensibly, matching today). **Must be byte-identical to today's header for Claude.**
   - opencode: prettify map — `bash`→`Bash`, `read`→`Read`, `write`→`Write`, `edit`→`Edit`,
     `apply_patch`→`Patch`, `glob`→`Glob`, `grep`→`Grep`, `webfetch`→`WebFetch`, `websearch`→`WebSearch`,
     `todowrite`→`TodoWrite`, `task`→`Task`, `question`→`AskUserQuestion`,
     `claudeui_render_mermaid`→`Mermaid`, `claudeui_create_mockup`/`claudeui_show_mockup`→`Mockup`;
     fallback = raw name.
   - Thread the resolved name into ToolCard as a **`displayName` prop** (precomputed by the caller, since
     ToolCard lacks engineId). Update **both** call sites — `ToolCallBlock` and `SubagentMessages` — to
     compute `engineToolMap(engineId).displayName(block.toolName)` and pass it. Default the prop to
     `block.toolName` if a path leaves it unset (safety).

### (c) fileEdit single-diff
Render the diff **exactly once**. Rule (handles `hideToolInput`):
- Input section (shown when `!hideToolInput`): `hasDiff` → `<DiffViewer>`; else JSON dump (unchanged).
- Result section (shown when `showResult`):
  - `resultIsError` → red-`<pre>` error text (unchanged, but via the new show-more — see (d)).
  - else if `hasDiff && hideToolInput` → `<DiffViewer>` (the diff couldn't show in the hidden Input, so
    show it here — still exactly once).
  - else if `hasDiff` → render the **result text** (`TerminalView`), NOT a duplicate diff. (For opencode
    this surfaces useful post-edit diagnostics; for Claude it's the brief "updated" confirmation. This is
    the intended improvement over the duplicate diff.)
  - else (no diff) → existing generic result.
App-shot the Claude Edit card to confirm it reads cleanly (one diff + a short result line).

### (d) Truncation + show-more
1. **Setting.** Add `toolOutputMaxChars: number` to `AppSettings` + `DEFAULT_SETTINGS` (default **5000**)
   + a number control in the `tool-output` settings section (mirror `maxRecentSessions`'s control;
   sensible min/max, e.g. 500–50000). Keywords for search filter.
2. **Affordance.** Add a reusable `<ExpandableText>` (renderer util/component) that, given the full text +
   a limit, renders the first `limit` chars and a **"Show more" / "Show less"** toggle that reveals the
   **full** text (no data loss). Use it wherever `trunc(...)` hard-cuts today:
   - `GenericBody` error pre, `FileEditBody` error pre, `FileReadBody` error pre → wrap with
     `<ExpandableText limit={toolOutputMaxChars}>`.
   - `FileReadBody` success (`CodeView`) → show first `toolOutputMaxChars` chars in `CodeView` + a
     show-more toggle that re-renders `CodeView` with the full text. (CodeView's own `max-h` scroll stays.)
   - Thread `toolOutputMaxChars` via `KindBodyProps` (ToolCard reads it from props passed by ToolCallBlock,
     which reads settings). The toggle is local component state.
   - The affordance only appears when `text.length > limit` → for short outputs, **zero visual change**.

## 3. Behavior-preservation gates (Claude is the daily driver)
- Header **name** byte-identical for Claude (passthrough displayName).
- **Summary** byte-identical for Claude — the `summarizeTool === getSummary` test must pass for every kind.
- Short tool outputs: no show-more chrome (unchanged). Long outputs: truncated + "Show more" (improvement).
- fileEdit: one diff (was two). app-shot proof it's clean.
- opencode cards: clean names + real summaries (the visible win) — app-shot an opencode session.

## 4. Tests
- `summarizeTool` per kind, incl. the **Claude-equivalence guard** vs `getSummary`.
- `displayName`: Claude passthrough (identity for the standard names); opencode prettify map (bash→Bash,
  todowrite→TodoWrite, apply_patch→Patch, …).
- `<ExpandableText>`: truncates over limit, reveals full on toggle, no chrome under limit.
- `FileEditBody`: diff rendered once (assert a single `DiffViewer` instance for a hasDiff success — would
  fail against pre-fix code which rendered two).
- Settings: `toolOutputMaxChars` round-trips (default + update).

## 5. Verify gates (report exact output)
`bun run typecheck && bun run test && bun run lint && bun run build` — 0 lint errors (3 pre-existing
exhaustive-deps warnings OK). Leave the tree dirty; list every changed file + one-line rationale.

## 6. Gotchas
- `summarizeTool` is the regression trap — reproduce `getSummary` exactly for Claude or it's a visible
  regression on the daily driver. The equivalence test is mandatory.
- ToolCard has **two** call sites (ToolCallBlock + SubagentMessages) — the `displayName` prop must be
  wired at both, else subagent tool cards lose their name.
- `hideToolInput` interacts with the single-diff rule — verify the diff still shows (in Result) when
  input is hidden.
- Don't lose data: "show more" must reveal the **full** text, not re-cut at a higher fixed limit.
- Keep `mcp`/`unknown`/`search`/`web` rendering through `GenericBody` (a/b are out of scope) — only their
  **summary/name** improve via (e), not their bodies.

## 7. Suggested commit (main model writes it after review)
```
feat(v2/tool-rendering): per-kind display metadata, single-diff fileEdit, show-more truncation

Drive the tool card's name + summary off the engine-neutral kind/ToolView (EngineToolMap.displayName +
summarizeTool) instead of Claude-hardcoded getSummary/raw toolName — fixing opencode's raw lowercase
labels + JSON-blob summaries. Render the fileEdit diff once instead of twice. Replace the hardcoded
2000/5000-char cuts with a uniform show-more affordance + a toolOutputMaxChars setting. Claude
byte-identical (name/summary equivalence-tested). ROADMAP #11 (c/d/e); structured search/web (a/b) stay
deferred.
```

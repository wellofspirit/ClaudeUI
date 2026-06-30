# Follow-up — opencode custom-agent CRUD, slice C2 (renderer: drill-in list + editor)

> Kickoff spec. Agent: **Sonnet, `general-purpose`**. Opus orchestrates, reviews every line, runs gates,
> commits. **You must NOT:** commit, `git add`, branch, `bun install`/`add`/`remove`, or self-certify.
> Leave the tree dirty. Decisions: **[ADR-029](../adr/adr-029_opencode-custom-agent-crud.md)** — read it.
> Slice C1 (backend service + IPC + preload) is **already implemented in the working tree** — you consume it.

Build the renderer UI for opencode custom-agent CRUD: replace the model+temp-only `OpencodeAgentsSection`
with a **drill-in list + editor** that matches the approved mockup.

## 0. The approved UX — READ THE MOCKUP FIRST
Open `.claude/ui/mockups/43de2eed/index.html` and study it — it is the authoritative layout/interaction
reference (drill-in list → editor, opt-in permissions, generate, mode/scope toggles, collapsibles, footer).
Build the real React version of THAT inside the SettingsDialog opencode → Agents section. The section lives
in the 760×540 dialog's ~580px content column, so it's a **drill-in** (list replaced by editor + a back
link), NOT side-by-side.

## 1. What you consume (C1, already in the tree)
`window.api` methods (preload `index.ts:358-367`, types in `shared/types.ts`):
- `listOpencodeAgents(cwd?)` → `OpencodeAgentSummary[]` (`{name, kind:'custom'|'builtin', mode, scope, model?, color?, overridden?, disabled?, hidden?}`)
- `readOpencodeAgent(name, scope, cwd?)` → `OpencodeAgentDetail | null` (adds `description?, prompt?, temperature?, topP?, steps?, reasoningEffort?, restrict, permission?`)
- `saveOpencodeAgent(input, cwd?)` → void  (`OpencodeAgentInput` = `{name, scope, mode, model?, description?, prompt?, temperature?, topP?, steps?, reasoningEffort?, color?, hidden?, disable?, permission?}`)
- `deleteOpencodeAgent(name, scope, cwd?)` → void  (custom = delete; built-in = reset override)
- `setOpencodeAgentDisabled(name, scope, cwd, disabled)` → void
- `generateOpencodeAgent(description, cwd?)` → `{identifier, whenToUse, systemPrompt}` (may reject — handle softly)
**Permission opt-in contract:** include `permission` in the save input ONLY when "Restrict" is on; omit it
otherwise (the agent then inherits the session autonomy mode — ADR-029). On read, `restrict === !!permission`.

## 2. The work

### 2a. New component file `src/renderer/src/components/SettingsDialog/OpencodeAgents.tsx`
Export `OpencodeAgentsSection` here (settings-sections.tsx is already 3490 lines — keep this out of it).
Internal state machine: `view: { mode:'list' } | { mode:'edit', name, scope } | { mode:'new' }`.
- **cwd**: read the active session's cwd from the store — `useSessionStore(s => s.sessions?.[s.activeSessionId ?? '']?.cwd)` (adapt to the real shape; grep the store). Pass it to all calls. If there's no active cwd, **project scope is disabled** in the editor (global-only) and generate runs without a cwd (backend falls back).
- Self-gate on `useOpencodeInstalled()` (mirror the current section's not-installed message); keep the
  `data-testid="OpencodeAgentsSection"` root in every state.

**List view** (`listOpencodeAgents(cwd)` on mount + after any save/delete):
- Group by `kind`: **Custom** (`kind==='custom'`) then **Built-in** (`kind==='builtin'`). Built-in overrides
  stay in the Built-in group (they're `kind:'builtin'`, `overridden:true`).
- Row (testid `OpencodeAgentsSection.agentRow`, `data-id={name}`): color dot, name, **mode** badge, **scope**
  badge (custom only), `overridden`/`disabled` chips, model sub-text, chevron. Click → `view=edit`.
  Disabled built-in (`explore`): dim + strikethrough + "disabled" chip.
- `+ New agent` button (testid `OpencodeAgentsSection.newAgent`) → `view=new`.

**Editor view** (on enter: `view=new` → blank draft; `view=edit` → `readOpencodeAgent(name, scope, cwd)`):
- Back link `‹ Agents` (testid `.back`) → list.
- **Name** input (read-only when editing a built-in; required + filename-safe `[a-z0-9-]` for new/custom),
  **Scope** segmented Global/Project (Project disabled w/o cwd), live **file-path hint**
  (`~/.config/opencode/agents/<name>.md` or `<cwd>/.opencode/agents/<name>.md`).
- Built-in banner when editing a built-in ("Overriding built-in <name> — unset fields use defaults").
- **Generate with AI** (testid `.generate`): description input + button → `generateOpencodeAgent(desc, cwd)`;
  on success prefill name(identifier)/description(whenToUse)/prompt(systemPrompt); on reject show a soft
  inline error (no throw). Disable the button while in-flight.
- **Description** textarea; **Mode** segmented (primary/subagent/all) with the "subagent → callable via task
  tool" hint; **Model** select (Inherit + opencode models from `getEngineModels()` filtered to `engineId==='opencode'` — reuse the current section's loader); **System prompt** textarea.
- **Tool permissions — OPT-IN** (testid `.permToggle`): default OFF → caption "Inherits from the session's
  autonomy mode + auto gatekeeper"; ON → reveal an allow/ask/deny grid over categories
  `['bash','edit','read','glob','grep','webfetch','task','websearch','todowrite','lsp','skill']` + the floor/
  inheritance hint (see mockup). On read, initialise the toggle to `detail.restrict`. Only send `permission`
  when ON (build `{cat: action}` from the grid).
- Collapsible **Advanced** (temperature slider, top_p, steps, reasoningEffort) + **Appearance** (color, hidden).
- **Footer** (pinned): custom → `Delete` (testid `.delete`, calls `deleteOpencodeAgent` then back+reload);
  built-in → `Disable`/`Re-enable` (`setOpencodeAgentDisabled`) + `Reset to default` (`deleteOpencodeAgent`);
  always `Cancel` (→ list) + `Save` (testid `.save` → `saveOpencodeAgent(input, cwd)` then back+reload).
- Build `OpencodeAgentInput` from editor state; map back the snake/camel (topP→ the input field is `topP`;
  the C1 service handles `top_p`). `hidden`/`disable` only when true. `permission` only when restrict on.

### 2b. Wire it in
`settings-sections.tsx`: remove the old inline `OpencodeAgentsSection` (1591-~1745) and
`import { OpencodeAgentsSection } from './OpencodeAgents'`; the SECTIONS entry (`:3325`) is unchanged.
Keep `KNOWN_AGENT_NAMES` only if still referenced elsewhere (grep; otherwise remove).

## 3. Tests (`*.component.test.tsx` or `*.unit.test.tsx`; mock `window.api` via the test harness)
- List renders custom + built-in groups from a mocked `listOpencodeAgents`; an `overridden:true` built-in
  is in the Built-in group with the badge; a `disabled` one shows disabled.
- Clicking a row drills into the editor and calls `readOpencodeAgent(name, scope, cwd)`.
- Save builds the right `OpencodeAgentInput`: e.g. a new subagent with prompt+description+model → `saveOpencodeAgent`
  called with those; **permission omitted when Restrict OFF**, **present when ON** (assert both).
- Generate: mock `generateOpencodeAgent` → fields prefilled; mock reject → soft error shown, no throw.
- Built-in: Disable calls `setOpencodeAgentDisabled(name, scope, cwd, true)`; Reset calls `deleteOpencodeAgent`.
- Project scope disabled when no active cwd.
- Assert by `data-testid` (ADR-027).

## 4. Verify gates (report exact output; do NOT commit)
```
bun run typecheck && bun run test && bun run test:ci && bun run lint && bun run build
```
0 lint errors (2 pre-existing exhaustive-deps warnings OK; model-discovery tests are GREEN — keep them green).
No `bun install`. Leave tree dirty; list changed files + rationale + deviations. No app-shot (orchestrator
drives the real app). rm any throwaway probe scripts.

## 5. Gotchas
- **Drill-in, not modal/side-by-side** — the dialog content column is ~580px; the list is replaced by the editor.
- **Permission opt-in** — default inherit (no `permission` in the saved input); the grid is a restrictive floor.
  Do not write `permission:{}`.
- **Built-in name is read-only**; built-in footer = Disable/Reset, not Delete. Custom footer = Delete.
- **cwd** drives project scope + generate; gate Project off when absent.
- **Reuse** `useOpencodeInstalled()` + the opencode `getEngineModels()` model-loader pattern from the existing
  opencode sections. Match the app's existing control styling (SettingsSlider, selects, the `inputClass`).
- **data-testid** on the root + every interactive part (ADR-027) so the orchestrator can drive the real app.
- Don't touch C1 backend files, permissions engine, or unrelated sections.

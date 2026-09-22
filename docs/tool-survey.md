# Cross-harness tool and history-item survey

Written 2026-09-16 for roadmap item 1 of [`codex-integration-handoff.md`](codex-integration-handoff.md): inventory every tool and history item each harness exposes against ClaudeUI's card vocabulary BEFORE writing the Codex history mappers. The mapping proposal is at the end, with one mockup page ([`mockups/f20-history-cards.html`](mockups/f20-history-cards.html)) drawn in the app's own card chrome. The kickoff (F20) followed Daniel's choices in § 6 and landed 2026-09-17 (`git log -p -- docs/codex-followups-spec.md` for the kickoff itself, deleted with the rest of the landed specs).

Sources: `docs/protocol-cc/` (cli.js 2.1.268), `.cache/opencode-fork` (opencode 1.18.29; the ADR-cited `vendor/opencode-src` path does not exist), `vendor/pi-cli/pi/docs/` (pi 0.84.3; one directory deeper than the docs cite), `.cache/codex-src` (Codex 0.154.0) with `src/core/codex/protocol/v2/ThreadItem.ts`, and the renderer's `tool-registry/`. Every claim was verified by reading the code; file:line citations are in the four agent reports this condenses.

## 1. The card vocabulary

Fourteen `ToolKind`s (`src/shared/tool-kinds.ts`), selected by `hostedMcpKind(name) ?? engineToolMap(engine).kindOf(name)`, then `normalize(kind, input, result)` into a `ToolView`. Four kinds are lifted out of the shared card shell (`plan` → `ExitPlanModeCard`, `question` → `AskUserQuestionBlock`, `todo` → `TodoToolBlock`, `task` → `TaskCard`); the other ten share `ToolCard` with a per-kind body. `search`, `web`, `mcp` and `unknown` all use `GenericBody`: a JSON dump of the input and the raw result text.

Non-tool rows come from `ContentBlock` variants on a system message: `compact_separator` (hairline, or an expandable amber card when `text` is set), `text` (verbatim notice, never markdown), `cli_command`, `api_error`. `tool_result.images` is rendered by the card shell for every standard kind, so any engine that supplies bytes gets a thumbnail strip for free.

### Kind coverage today

| Kind            | Claude                | opencode                      | pi                 | Codex                       |
| --------------- | --------------------- | ----------------------------- | ------------------ | --------------------------- |
| command         | Bash                  | bash                          | bash               | commandExecution            |
| fileEdit        | Edit, MultiEdit       | edit, apply_patch             | edit               | fileChange                  |
| fileWrite       | Write                 | write                         | write              | —                           |
| fileRead        | Read                  | read                          | read               | —                           |
| search          | Glob, Grep            | glob, grep                    | grep, find, ls     | —                           |
| web             | WebFetch, WebSearch   | webfetch, websearch           | none exists        | —                           |
| todo            | TodoWrite             | todowrite                     | none exists        | —                           |
| task            | Task, Agent, dispatch | task, dispatch                | subagent, dispatch | collab:spawnAgent, dispatch |
| plan            | ExitPlanMode          | plan_exit (never registered)  | exit_plan          | —                           |
| question        | AskUserQuestion       | question                      | none exists        | requestUserInput            |
| diagram, mockup | hosted MCP            | claudeui_*                    | bare names         | bare names                  |
| mcp             | `mcp__*`              | none: names are `server_tool` | none exists        | `mcp__*` approval card only |

Codex reaches seven of fourteen kinds. pi cannot reach web, todo, question or mcp because the harness has no such tool. opencode's MCP tools never reach the `mcp` kind because its names are underscore-joined.

## 2. Non-tool item kinds per harness and their fate today

| Harness  | Item                                                                     | Where         | Today                                                                 |
| -------- | ------------------------------------------------------------------------ | ------------- | --------------------------------------------------------------------- |
| Claude   | `system/compact_boundary`                                                | live + JSONL  | separator on reload only; dropped live                                |
| Claude   | `isCompactSummary` user line                                             | JSONL         | summary attached to the separator                                     |
| Claude   | `attachment` lines (23 subtypes; 2,628 of 9,173 lines in a local census) | JSONL         | all dropped                                                           |
| Claude   | `system/permission_denied`, `commands_changed`, `api_retry`, `hook_*`    | live          | dropped (hooks never requested)                                       |
| Claude   | `tool_use_summary`                                                       | live          | dropped, not in the SDK union                                         |
| opencode | `compaction` part                                                        | SSE + history | dropped                                                               |
| opencode | `subtask` part                                                           | SSE + history | dropped; a slash command to a subagent vanishes from replayed history |
| opencode | `retry`, `patch`, `agent`, `step-start`, `step-finish` parts             | SSE + history | dropped                                                               |
| opencode | `file` part on an assistant message                                      | SSE + history | dropped; user-role only                                               |
| pi       | `compaction` entry                                                       | RPC + file    | first line of the summary only                                        |
| pi       | `custom_message` entry                                                   | file          | dropped, though it is in the model's context                          |
| pi       | `branch_summary`, `model_change`, `thinking_level_change`, `label`       | file          | dropped                                                               |
| pi       | `extension_ui_request`                                                   | RPC           | dropped, never answered                                               |
| Codex    | see § 3                                                                  |               |                                                                       |

## 3. Codex thread items

Both paths run the same pure function: `item/started` and `item/completed` feed `mapCodexItem` live (`CodexSession.item`), and `thread/read` feeds it cold (`history.ts`). The `default` case returns nothing, so every kind below marked dropped is dropped on both paths at once, and one mapper change fixes both.

| ThreadItem                                                                                                                 | Producer (0.154.0)                                                                                                                                 | Cold history | Today                                                 |
| -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------- |
| userMessage, agentMessage, reasoning, commandExecution, fileChange, dynamicToolCall, collabAgentToolCall, subAgentActivity | core                                                                                                                                               | yes          | mapped                                                |
| **mcpToolCall**                                                                                                            | any configured MCP server (user's own `config.toml`; F17 only disables the desktop app's)                                                          | yes          | **dropped**; only the elicitation approval card shows |
| **webSearch**                                                                                                              | hosted Responses web search or the standalone extension; `query`, `action` (search / openPage / findInPage / other), `results` opaque JSON         | yes          | dropped                                               |
| **imageView**                                                                                                              | `view_image` tool; `path` only                                                                                                                     | yes          | dropped                                               |
| **imageGeneration**                                                                                                        | hosted image generation; `revisedPrompt`, base64 `result`, `savedPath`, `failure` (`usageLimitExceeded`)                                           | yes          | dropped                                               |
| **sleep**                                                                                                                  | `clock.sleep`; `durationMs`                                                                                                                        | yes          | dropped                                               |
| **plan**                                                                                                                   | plan mode's `<proposed_plan>`; id `<turnId>-plan`, streamed by `item/plan/delta`, completed with the full markdown                                 | yes          | dropped                                               |
| **contextCompaction**                                                                                                      | `ContextCompacted` event; id only, no summary. The `thread/compacted` notification is deprecated in its favour                                     | yes          | dropped                                               |
| **hookPrompt**                                                                                                             | user-role `<hook_prompt hook_run_id>` fragments; live from `contextual_user_message`, cold parsed back out of the rollout                          | yes          | dropped                                               |
| **functionCallOutput**                                                                                                     | a `function_call_output` submitted as turn input by a client with no `call_id` (desktop async-question answers, hooks); ClaudeUI never submits one | yes          | dropped                                               |
| **enteredReviewMode / exitedReviewMode**                                                                                   | `review/start`; entered carries `user_facing_hint` and the target, exited carries `render_review_output_text` (explanation + findings)             | yes          | dropped                                               |

Related notifications with no thread item: `turn/plan/updated` (the `update_plan` checklist tool: `explanation`, `plan[] {step, status}`; ignored by `thread_history.rs`, so absent cold), `item/mcpToolCall/progress` (`message`), `item/plan/delta`, `turn/diff/updated`, `hook/started`, `hook/completed`, `warning`, `deprecationNotice`, `model/rerouted`. `agentMessage` also carries `questions` (async `request_user_input_async`), `phase` and `memoryCitation`, none of which the mapper reads.

Vendored types: `ThreadItem.ts` already carries every item; `WebSearchAction`, `ImageGenerationFailure`, `HookPromptFragment`, `McpToolCallResult` and `McpToolCallError` are present. `PlanDeltaNotification`, `McpToolCallProgressNotification`, `TurnPlanUpdatedNotification`, `TurnPlanStep`, `TurnPlanStepStatus` are not and would be added to `scripts/generate-codex-protocol.mjs`'s roots.

## 4. Proposal

One mockup page holds every card: [`mockups/f20-history-cards.html`](mockups/f20-history-cards.html). Section numbers match.

| #   | Item(s)                        | Kind                   | Card                                                                                                                                                                                             | Also fixes                                                                                                               |
| --- | ------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| 1   | Codex webSearch                | `web`                  | new `WebBody`: the action line, then a results list (title, domain, snippet) when the wire carries structured results, else the result text                                                      | Claude WebSearch/WebFetch and opencode websearch/webfetch stop being JSON dumps; opencode websearch header reads `query` |
| 2   | Codex mcpToolCall              | `mcp`                  | new `McpBody`: header `server / tool`, read-only chip, arguments, result content (text; images via the strip), error, duration; running state shows the last `item/mcpToolCall/progress` message | Claude `mcp__*` and opencode `server_tool` share the body; opencode names route to `mcp`                                 |
| 3   | Codex imageView                | `fileRead`             | option A: core reads the file (5 MB cap, image types only) into `tool_result.images`; option B (fallback when the read fails): path only                                                         | —                                                                                                                        |
| 4   | Codex imageGeneration          | new `image`            | revised prompt, saved path, the picture in the strip; failure renders the limit message with the reset time                                                                                      | —                                                                                                                        |
| 5   | Codex sleep                    | new one-line row       | option A: `Sleep · waited 2.5 s` in the todo-row shape; option B: a standard card                                                                                                                | —                                                                                                                        |
| 6   | Codex plan                     | `plan`                 | option A: `ExitPlanModeCard` markdown body, no actions, streamed through `item/plan/delta`; option B adds a "switch to Default and implement" action (a mode switch, beyond the mapper)          | —                                                                                                                        |
| 7   | Codex `turn/plan/updated`      | `todo`                 | option A: todo row + floating widget, live only, with the reload caveat stated in the spec; option B: widget only                                                                                | —                                                                                                                        |
| 8   | Codex functionCallOutput       | `unknown`, result only | option A: a result-only card named by `name`, summary "answer supplied by another client"; option B: drop                                                                                        | —                                                                                                                        |
| 9   | Codex hookPrompt               | system row             | "Injected context · n hook fragments", collapsed by default, fragments verbatim (never markdown)                                                                                                 | pi `custom_message` and, later, Claude `attachment` can reuse the row                                                    |
| 10  | Codex entered/exitedReviewMode | system row + card      | thin row "Review started: <hint>"; a `Review` card whose body is the findings text through markdown                                                                                              | —                                                                                                                        |
| 11  | Codex contextCompaction        | `compact_separator`    | hairline, no summary                                                                                                                                                                             | opencode `compaction` part and Claude live `compact_boundary` map to the same row; pi keeps its full summary             |

Shape changes: `ToolView.web` gains `action?` and `results?: {title, url, snippet?}[]`; `ToolView.mcp` gains `server`, `tool`, `readOnly?`, `progress?`; a new `ToolView.image` with `prompt?`, `savedPath?`; `ToolKind` gains `image`. `CodexEngineToolMap` gains `webSearch → web`, `mcpToolCall → mcp`, `imageView → fileRead`, `imageGeneration → image`, `plan → plan`, `sleep`, `hookPrompt` and review rows are system messages, not tool cards. `mapCodexDelta` gains `item/plan/delta` (an item-scoped upsert like thinking) and `CodexSession` gains `item/mcpToolCall/progress` and `turn/plan/updated`.

Security posture: result URLs render as text with an `https?:` check before becoming links; MCP result text and hook fragments are untrusted model or server text and stay out of the markdown pipeline; the image-view read is capped and typed and never follows a path outside the thread's cwd unless the item's path is absolute and readable (the model already read it).

Tests: mapper guard tests per kind with wire-shaped fixtures (proven failing first), `CodexEngineToolMap` tests for every new name, body component tests for `WebBody` and `McpBody`, a `history.ts` cold-read test with a thread carrying all nine kinds, and a fixture-provider turn that emits a `webSearch` and an `mcpToolCall` item for the verifier. Verification per ADR-026 as amended: an Opus verifier drives the rebuilt app on an isolated home and the main model reviews the screenshots against `data-testid` assertions (`WebBody`, `McpBody`, `ToolResultImages`, `ExitPlanModeCard`, `MessageBubble.systemNotice`).

## 5. Findings outside this item

- **Claude**: `PowerShell` and `Skill` render generically; `permission_denied` and `commands_changed` are dropped against the protocol doc's explicit guidance; `compact_boundary` is dropped live; `stream_event` keeps only text and thinking deltas; the `attachment` JSONL family is undocumented and entirely dropped.
- **opencode**: `subtask` messages vanish from replayed history; `retry` is invisible; MCP names miss the `mcp__` path; the protocol snapshot is 1.18.9 against a 1.18.29 pin; `plan_exit` reads an input field the tool does not have.
- **pi**: `powershell` is offered in settings but unmapped in both the renderer and the permission engine; `custom_message` is in the model's context but not the transcript; `extension_ui_request` is never answered; `ToolResultMessage.usage` is unsummed.
- **Codex**: `commandExecution.commandActions` could route reads and searches to the read and search cards; `agentMessage.questions` are unread.

## 6. Decisions (Daniel, 2026-09-16)

1. Image view: A, read the bytes, path-only as the fallback.
2. Sleep: A, the one-line row.
3. Plan item: the Claude-style card with the plan viewer and the options at the bottom. Prerequisite found afterwards: a `plan` item exists only under Codex's native plan collaboration mode, so ClaudeUI's plan mode sends `collaborationMode: plan` on `turn/start` as well as its read-only sandbox; the options become a mode switch plus "Implement the plan.", the way the Codex TUI does it.
4. Step checklist: B, widget only.
5. Function call output: A, result-only card.
6. `mcpToolCall` joins the slice.
7. The cross-harness fixes ride the slice.

Kickoff: § F20 of the follow-ups spec, deleted once landed (`git log -p -- docs/codex-followups-spec.md`).

---

## 7 · Claude rescan (2026-09-18)

§ 1–6 surveyed opencode, pi and Codex against the card vocabulary and left Claude on the reading the vocabulary was originally built from. This section rescans Claude itself against the pinned binary, because that reading had rotted: tools have been added, renamed and gated off since.

### Method

1. **Bundle enumeration** — every tool object in `vendor/claude-cli/cli.js` (2.1.268) located by its `name:` property inside an object that also defines `inputSchema`, with the name constants resolved from their `IDENT="Name"` assignments and the neighbouring `isEnabled` / `isReadOnly` / `shouldDefer` / `userFacingName` members read off the same object. **69 tool objects exist**; most are claude.ai and Desktop surfaces (`Projects`, `ReadNotifications`, `SendFeedback`, `ClaudeDesign`, `Poll`, `REPL`, `ObserverReport`, …) that no CLI spawn enables.
2. **Init probes** — `bun-claude` spawned in ClaudeUI's own shape (`--output-format stream-json --verbose --input-format stream-json --include-partial-messages`), killed the moment `system/init` arrives, so no request completes and nothing is spent. Four runs: default mode; `CLAUDE_CODE_ENTRYPOINT=claude-desktop` (what `buildEnv` sets); `--permission-prompt-tool stdio` + plan mode (what a `canUseTool` session sends); and the two `CLAUDE_CODE_ENABLE_TASKS` / `CLAUDE_CODE_ENABLE_TODO_TOOLS` combinations.

`system/init`'s `tools` array is the enabled set, not the loaded-schema set: `shouldDefer` tools (WebFetch, WebSearch, NotebookEdit, Monitor, Cron\*, the Task\* family, …) are listed there and reach the model through `ToolSearch` later. Absence from the array therefore means **disabled**, which is what made the gate findings below visible.

### The 32 a ClaudeUI session can receive

Probed with `--permission-prompt-tool stdio` in plan mode; `mcp__*` names are per-install and additional.

| Tool                         | Kind today  | Proposed                                                                                    |
| ---------------------------- | ----------- | ------------------------------------------------------------------------------------------- |
| Bash                         | `command`   | redesigned `command` (drop the echoed input, duration + exit-code chips)                    |
| Read                         | `fileRead`  | redesigned (language + line-window chips, path out of the body)                             |
| Write                        | `fileWrite` | redesigned (`new file` / size chips, diff when the path existed)                            |
| Edit                         | `fileEdit`  | redesigned (real line numbers, `+n −m` chip)                                                |
| Glob, Grep                   | `search`    | new `SearchBody` — file list with per-file hit counts, header carries pattern + root + mode |
| WebFetch, WebSearch          | `web`       | `WebBody` + snippet and domain rows                                                         |
| Task                         | `task`      | `TaskCard` (unchanged)                                                                      |
| AskUserQuestion              | `question`  | `AskUserQuestionBlock` (unchanged)                                                          |
| ExitPlanMode                 | `plan`      | `ExitPlanModeCard` (unchanged)                                                              |
| EnterPlanMode                | hidden      | hidden                                                                                      |
| `mcp__*`                     | `mcp`       | `McpBody` (landed for Codex in F20) applied to Claude's names                               |
| **Skill**                    | `unknown`   | rich card: skill name, args, the loaded instructions                                        |
| **ReportFindings**           | `unknown`   | rich card: one row per finding, verdict chip, file:line, failure scenario                   |
| **Workflow**                 | `unknown`   | rich card: `meta.name`, description, one progress row per phase                             |
| **Artifact**                 | `unknown`   | rich card: action, title, url, published files                                              |
| **Monitor**                  | `unknown`   | rich card: the watched command, then one row per event                                      |
| **NotebookEdit**             | `unknown`   | rich card: cell id + edit mode chips, source diff (it is a file edit)                       |
| **TaskOutput**               | `unknown`   | rich card: task id header, streamed output body                                             |
| **CronCreate**               | `unknown`   | detail card: cron, human schedule, prompt, recurring/durable chips                          |
| **RemoteTrigger**            | `unknown`   | detail card: action, trigger id, url, enabled/next-run                                      |
| **EnterWorktree**            | `unknown`   | detail card: worktree path, branch, base                                                    |
| **ScheduleWakeup**           | `unknown`   | detail card: delay, fire time, reason; `noop`/`stop` chips                                  |
| **ListAgents**               | `unknown`   | detail card: one row per agent with busy/idle and kind                                      |
| **SendMessage**              | `unknown`   | detail card: recipient header, message body                                                 |
| **ToolSearch**               | `unknown`   | flat row: "Loaded n tool schemas for \<query\>"                                             |
| **TaskStop**                 | `unknown`   | flat row: "Stopped background task \<id\>"                                                  |
| **PushNotification**         | `unknown`   | flat row: the message                                                                       |
| **CronDelete**, **CronList** | `unknown`   | flat rows                                                                                   |
| **ExitWorktree**             | `unknown`   | flat row: kept / discarded changes                                                          |
| **DesignSync**               | `unknown`   | flat row                                                                                    |

A flat row is the Codex `sleep` shape — no border, no chevron, no status dot, one sentence — and promotes itself to an ordinary error card when the call fails. The three shapes are driven by one descriptor table keyed on tool name, not twenty components. Card mockup: [`mockups/claude-tool-cards.html`](mockups/claude-tool-cards.html) (authored through the in-app mockup tool, directory `6268db38`).

Also reachable but gated off in a stock install, so unproven against these cards: `SendUserFile` (has a summary special-case and the Files widget), `ShareOnboardingGuide`, `SuggestSkills`, `ListSkills`, `SearchSkills`, `ListPlugins`, `SearchPlugins`, `SuggestPluginInstall`.

### Gate findings

- **`TodoWrite.isEnabled` is `!z_() && mL()`.** `z_()` is "the Tasks system is on" — true unless `CLAUDE_CODE_ENABLE_TASKS=false` — so TodoWrite is off by default. Its replacement family (`TaskCreate`, `TaskGet`, `TaskList`, `TaskUpdate`, all `xK() = z_() && mL()`) needs `CLAUDE_CODE_ENABLE_TODO_TOOLS=true`, which `buildEnv` does not set. **A stock Claude session therefore has no checklist tool at all**: `TodoToolBlock`, the `todo` kind and `buildTodosFromMessages`' TaskCreate/TaskUpdate branch are unreachable on Claude (opencode and pi still use the kind). Probed all four combinations: `CLAUDE_CODE_ENABLE_TODO_TOOLS=true` alone brings the Task\* family (already hidden in `HIDDEN_TOOLS` and already folded into the widget by `derive-session.ts`); adding `CLAUDE_CODE_ENABLE_TASKS=false` brings TodoWrite back instead.
- **`AskUserQuestion` and `ExitPlanMode` share the gate `cCe()`**: `if (jm().length > 0 && Ae()) return false; if (Ae() && !gWe(wH())) return false; return true`, where `Ae()` is "not interactive", `wH()` is the permission-prompt tool name and `gWe(x)` is `x !== undefined && x !== 'none'`. ClaudeUI passes `--permission-prompt-tool stdio` whenever `canUseTool` is set, so both tools exist; a spawn without it loses plan-mode's exit tool and the question card silently. Worth a guard test on `buildArgs`.
- **`MultiEdit` no longer exists** in 2.1.268 — `ClaudeEngineToolMap.kindOf` still maps it, a dead branch. `BashOutput`/`AgentOutput` are aliases of `TaskOutput`, and `KillShell`/`KillBash` aliases of `TaskStop`; cli.js's own `userFacingName`s for them are "Task Output" and "Stop Task".
- cli.js carries a `userFacingName` for most tools ("Search" for both Glob and Grep, "Web Search", "Edit Notebook", "Entering worktree" / "Creating worktree" from the input). Claude's `displayName` is a passthrough today; adopting these where they are clearer than the raw name is a cheap consistency win with what the Claude Code TUI shows.

### Card rulings (Daniel, 2026-09-18)

1. **The Bash input block stays.** A command is routinely longer than the header line can hold, and showing exactly what ran is a security affordance — which is why Bash renders its input even when _hide tool input_ is on. What changes is legibility: the command is syntax-highlighted through `prism-react-renderer` (already a dependency, already carrying a `bash` grammar via `CodeView`), and a heredoc is highlighted in its own language — `<<'PY'` after `python` makes the body Python. An unrecognised interpreter falls back to plain bash.
2. **Bash output is highlighted too.** `TerminalView` renders ANSI and nothing else, so piped `grep`, `rg`, `git diff` and `sed -n` output arrives flat. Four detectors, in order, and only when the text carries no ANSI: grep/rg gutter (muted gutter, content by the path's extension through `EXT_TO_LANG`), unified diff, JSON (`{`/`[` **and** `JSON.parse` succeeds), single-file read (one plain `cat`/`head`/`tail`/`sed -n` of one path). Guards: never re-highlight ANSI; detect on the first ~40 lines; fall back to plain above a 100 KB cap; a detector matching under ~60% of non-empty lines declines rather than half-colouring.
3. **Cross-harness consistency is a constraint, not a side effect.** Every change above lands in the shared `ToolKind` bodies, so Codex `commandExecution`, opencode `bash` and pi `bash` inherit it and no harness looks like the odd one out. Only the name→kind maps and the per-tool descriptor table are Claude-specific. Metadata chips are opportunistic: each engine fills what its wire carries (Codex `commandExecution` has a real `exitCode`, Claude's Bash result does not), and an absent field renders nothing rather than a placeholder.
4. The remaining kinds (Read, Write, Edit, Task, plan, question, todo) were reviewed as good enough; they take the header-grammar chips and no body redesign. `search` is the exception — it has no body at all today and gets the file-list renderer the grep detector already builds.

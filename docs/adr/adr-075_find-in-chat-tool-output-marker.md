# ADR-075 — Find-in-chat search-scope markers: what a tool returned is `TOOL_OUTPUT_SCOPE`, what it was given is not

**Status:** Accepted (2026-09-23). Owner rulings: the "Exclude tool output" toggle skips tool OUTPUT only, and
headers and inputs stay searchable.
**Relates to:** [ADR-027](adr-027_test-data-attributes.md) (`data-testid` is for tests; these attributes are
read by production code), [ADR-033](adr-033_cross-engine-dispatch.md) (dispatch cards share the `task` ToolView
and its marked result area)

## Context

Find-in-chat (`src/renderer/src/components/chat/ChatSearch/`) searches the rendered DOM, not the message store:

- a TreeWalker visits every text node in the chat scroll container;
- matches are painted with the CSS Custom Highlight API.

The DOM does not say which text a tool returned and which text it was given. A command, its stdout and the
tool's header all end up as text nodes in the same card.

Two needs follow from that:

1. **The "Exclude tool output" toggle** (the setting `searchExcludeToolOutput`, the button next to `Aa`) has to
   skip what tools returned (stdout, file contents, grep hits, subagent transcripts), which is most of the noise
   in a long session. It must still find what the user or the model typed: commands, paths, edit diffs, prompts.
2. **Renderers are spread out.** About 15 kind bodies in `tool-registry/kinds/`, plus TaskCard, SubagentMessages,
   ToolNoteRow and the bash output views, render results, each with its own layout. Some put INPUT where results
   usually go. The engine cannot infer the split, so each renderer has to declare it.

## Decision

### The rule

**An element that renders content a tool RETURNED spreads `TOOL_OUTPUT_SCOPE`. Content the tool was GIVEN
(its input), the tool header, and interaction cards are never marked.**

```tsx
import { TOOL_OUTPUT_SCOPE } from '../../ChatSearch/search-scope'

{
  showResult && (
    <div {...TOOL_OUTPUT_SCOPE} className="px-3 py-2.5 border-t border-border">
      …result text…
    </div>
  )
}
```

- `TOOL_OUTPUT_SCOPE` renders `data-search-scope="tool-output"`. It and its selector are defined once, in
  `ChatSearch/search-scope.ts`. Never write the attribute as a string literal.
- Mark the outermost element that holds ONLY output, usually the whole result section. The "Result"/"Output"/
  "Error" labels inside it may be marked too.
- The toggle skips any text node with a marked ancestor. With the toggle off, marked text is searched like any
  other text.

### Deciding input vs output

Ask where the text came from, not where it is drawn.

| Site                                                                                    | Marked?        | Why                                  |
| --------------------------------------------------------------------------------------- | -------------- | ------------------------------------ |
| Command stdout/stderr, live and background bash output                                  | yes            | returned                             |
| File-read contents, grep/glob/search results, web results, MCP and generic results      | yes            | returned                             |
| TaskCard result area, subagent transcript (SubagentMessages), TaskCard usage stats      | yes            | returned or derived from the result  |
| ToolNoteRow `— {error}` text, image/mockup error text                                   | yes            | returned error                       |
| Tool header: name, summary, chips                                                       | no             | derived from the input               |
| Command, paths, JSON arguments, task prompt/description                                 | no             | input                                |
| Edit diff, including when "hide tool input" moves it into FileEditBody's result section | no             | built from `old_string`/`new_string` |
| FileWrite `content` shown in the result slot                                            | no             | the written file is input            |
| SendMessage's `message` in DetailBody's text slot                                       | no             | input drawn where results usually go |
| Findings (ReportFindings), diagrams, plan/question/todo/sleep cards                     | no             | built from input, or interaction     |
| Thinking blocks                                                                         | never searched | `data-search="skip"`                 |

When one slot shows either kind of text, mark it conditionally, the way DetailBody does
(`textIsOutput = text === result?.toolResult`) and FileEditBody does (the diff branch stays unmarked).

### The other search markers

- **`data-search="skip"`** excludes a subtree from search regardless of the toggle. It is used for thinking
  blocks, the find bar and the find indicator's layer.
- **`SEARCH_ANCHOR`** (`data-search-anchor`) is on each per-message `.cv-auto` wrapper in ChatPanel. The engine
  binary-searches these to pick the match nearest the viewport, and pre-renders neighbouring messages before a
  jump. A new transcript host that wants viewport-relative navigation must put it on its per-message elements.

## Consequences

- **Nothing enforces the rule at build time.** A new kind body, or an engine rendering output in a new place,
  that forgets the marker makes the toggle silently search that output. There is no type error and no failing
  test. When you add or change a renderer that shows tool results, spread `TOOL_OUTPUT_SCOPE` on the result
  element and extend `ChatSearch/__tests__/tool-output-scope.component.test.tsx`. That test renders real bodies
  and runs the real engine over them: output must be excluded and input must remain.
- **Only mounted text is searchable.** A collapsed tool card does not mount its body, so its output is not found
  whatever the toggle says. The marker is about what gets skipped, not about what gets rendered.
- The rule describes where text came from. It is independent of the visual layout, so moving a section between
  "Input" and "Result" does not change whether it is marked.

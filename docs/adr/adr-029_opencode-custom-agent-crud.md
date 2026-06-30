# ADR-029: opencode custom-agent CRUD — markdown agent files, scoped, AI-assisted

**Status:** Accepted
**Date:** 2026-06-29
**Builds on:** [ADR-028](adr-028_opencode-native-config-in-place.md) (engine-native config in place)
**Relates to:** [ADR-019](adr-019_opencode-engine-backend.md), [ADR-022](adr-022_opencode-permission-mapping.md), [ADR-023](adr-023_opencode-automode-classifier.md), [ADR-024](adr-024_opencode-interaction-parity.md)

## Context

ClaudeUI's opencode "Agents" settings only let users override a known agent's **model + temperature**
(injected ephemerally). Users want to **create, edit, and delete real custom agents** (the original
Phase-C / "point #2") — with a system prompt, mode, tool restrictions, etc. — and to override the
built-ins. opencode represents agents as **markdown files** (frontmatter + body) under its own config
dirs; `opencode agent create` writes exactly these. This is the natural home given ADR-028 (manage the
engine's own config in place) and means a standalone `opencode` sees the same agents.

A permission subtlety surfaced in design (verified at source): opencode autonomy is governed at the
**session** level (autonomy mode → ruleset, ADR-022; `full`/auto → LLM gatekeeper, ADR-023), and for a
subagent the child session **inherits the parent's `deny` rules** (opencode-native
`deriveSubagentSessionPermission`, surfaced via `event-mapper.ts`); the auto-mode classifier already
judges subagent `permission.asked` (routed through the parent's mode in `OpencodeSession`). So per-agent
permissions are **not** the primary control — they are a self-imposed *restrictive floor* (what built-in
`explore` is).

## Decision

- **Storage = markdown agent files in opencode's own dirs** (gray-matter, matching opencode's own
  parser): **global** `~/.config/opencode/agents/<name>.md` or **project** `<cwd>/.opencode/agents/<name>.md`,
  chosen per-agent via a scope toggle. Frontmatter holds the structured fields; the markdown body is the
  system prompt. CRUD = create / read / update / delete the file. Standalone-visible (ADR-028).
- **Built-ins are editable** (`build`/`plan`/`general`/`explore` + hidden `title`/`summary`/`compaction`):
  the list shows them; editing writes a **same-named override file**, "Reset to default" deletes it,
  "Disable" writes `disable: true`. Supersedes today's model+temp-only override section.
- **Fields**: `name` (= filename), `description` (the "when to use" — drives auto-delegation), `mode`
  (`primary`/`subagent`/`all`), `model`, `temperature`, `top_p`, `steps`, reasoning effort (`options`),
  `color`, `hidden`, and the **system prompt** (body).
- **Permissions are OPT-IN.** Default: **no `permission` block** → the agent inherits the session's
  autonomy mode + auto-mode gatekeeper (and, as a subagent, the parent's deny rules). A "Restrict this
  agent's tools" toggle reveals a per-category **allow/ask/deny** grid that writes a `permission` block —
  a restrictive floor (e.g. a read-only reviewer). Rationale above: session-level governance is primary;
  **no permission-engine change is needed** for this phase (auto-mode already covers subagents — verified).
- **AI-assisted authoring** ("Generate with AI"): port opencode's agent-architect meta-prompt into the
  repo and run a **one-off stateless opencode prompt** (the ADR-023 judge transport: `createSession →
  prompt → deleteSession`, model = session model) → parse `{identifier, whenToUse, systemPrompt}` →
  prefill the editor for review/edit. Fail-soft to manual authoring (opencode exposes no generate API —
  CLI-only — so we replicate the prompt, we do not call a new endpoint).
- **UI = drill-in inside the SettingsDialog** opencode → Agents section (list → editor with a back link +
  pinned save/cancel), because the dialog content column (~580px of the 760×540 dialog) has no room for
  a master/detail.

## Consequences

- New main-process agent service + IPC/preload; the renderer's `OpencodeAgentsSection` is rewritten from
  a model/temp override list into the drill-in CRUD. New dep **gray-matter**.
- The Phase-A `agent` model+temperature overrides (in `opencode.json`'s `agent` key) and markdown agents
  **coexist** (opencode merges both, keyed by name). A follow-up may consolidate the json overrides into
  markdown; not required here.
- Standalone `opencode` gains every agent ClaudeUI authors.
- Permission semantics are intentionally thin per-agent (floor only); the session autonomy mode +
  ADR-023 gatekeeper remain the real control, including for subagents.

## Relation to existing ADRs

- **Builds on ADR-028** — agents are written to opencode's own files in place, the same principle.
- **Relies on ADR-022/023/024** for runtime permission/auto-mode behavior (inheritance, subagent
  approval routing); this ADR adds no runtime permission change, only authoring.

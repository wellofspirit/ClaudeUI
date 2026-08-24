# ADR-032: opencode tool-experience parity from the wire — no fork required

**Status:** Accepted
**Date:** 2026-07-08
**Relates to:** [ADR-019](adr-019_opencode-engine-backend.md) (opencode backend), [ADR-022](adr-022_opencode-permission-mapping.md) (permission mapping), [ADR-023](adr-023_opencode-automode-classifier.md) (auto-mode judge — amends its observability guard), [ADR-024](adr-024_opencode-interaction-parity.md) (interaction parity), [ADR-030](adr-030_capability-honesty.md), [ADR-031](adr-031_opencode-config-leaf-merge-writes.md) (ephemeral-config constraint)

## Context

Three user-visible gaps separated the opencode engine from the Claude engine's tool experience:

1. **No live bash output.** Claude streams foreground bash output into `LiveBashOutput` (via the
   `bash-output-streaming` cli.js patch → `session:bash-output`). opencode bash showed output only
   after completion.
2. **`apply_patch` rendered as a one-liner.** The tool result text is "Success. Updated the
   following files: …"; the rendered card showed that string (or a generic JSON dump), not diffs.
3. **Auto-mode was opaque and rejections were fatal.** The ADR-023 judge's block _reason_ went only
   to the log (`autoReply(id,'reject')` carried nothing), and _any_ opencode permission rejection —
   judge or human — ended the whole turn: the agent could never see why or retry. On Claude, a deny
   is a tool error with a message (`Auto mode blocked: <reason>` / `answers?.feedback || 'User
denied'`) that the agent responds to.

The working assumption was that fixing (3) — and possibly (1) — would require forking opencode and
bundling a patched build (as we do for Claude's cli.js). Source inspection (checkout at
`vendor/opencode-src`, gitignored; verified byte-identical between pinned v1.17.14 and v1.17.15 for
every file cited here) disproved that:

- **(1) is already on the wire.** opencode's shell tool republishes a cumulative stdout+stderr tail
  preview (≤30 000 chars) via `ctx.metadata({metadata:{output}})` on _every chunk_; each call
  surfaces as a `message.part.updated` event with `state.status:'running'` and
  `state.metadata.output`. Our event mapper snapshotted the state and dropped it.
- **(2) is already on the wire.** `apply_patch` results carry `metadata: { diff, files: [{filePath,
relativePath, type: add|update|delete|move, patch, additions, deletions}] }`; `edit` results carry
  `metadata: { diff, filediff: {file, patch, additions, deletions} }` (singular). `write` carries no
  diff (its `permission.asked` metadata has one, but not the result). Our `extractToolResult` kept
  only `state.output`.
- **(3) has first-class upstream support.** `POST /permission/{id}/reply` accepts `{reply,
message?}`. Reject **with** `message` raises `CorrectedError({feedback})` — which (a) fails only
  that tool call with model-visible text _"The user rejected permission to use this specific tool
  call with the following feedback: `<message>`"_, and (b) does **not** trip the turn-ending
  `ctx.blocked` flag (processor.ts checks `instanceof RejectedError` only). Additionally,
  `experimental.continue_loop_on_deny: true` makes even _bare_ rejects non-fatal — needed because
  opencode cascade-rejects all other same-session pending permissions with the bare (message-less)
  `RejectedError`.

## Decision

Close all three gaps **purely on the ClaudeUI side** — consume what opencode already emits and use
the reply/config surface it already exposes. **Do not fork opencode.** Concretely:

1. **Bash streaming**: `OpencodeSession` feeds running-`bash` parts' `state.metadata.output`
   through a dedup + trailing-edge throttle gate (`bash-stream-gate.ts`, ~100 ms/toolUseId) into the
   existing engine-neutral `session:bash-output` → `LiveBashOutput` path. Own-session parts only;
   gate entries cancelled on completion and on session teardown.
2. **Diff rendering**: a typed, narrow `FileDiff { path, patch, additions?, deletions?,
changeType? }` is extracted shape-gated (not tool-name-gated) from result metadata
   (`files[]` → apply_patch, `filediff` → edit) by `extractFileDiffs`, attached as
   `fileDiffs?: FileDiff[]` on the `tool_result` ContentBlock, and flows through live
   (`session:tool-result`, subagent variant included), history (`convertStoredMessage`), and store
   paths. `FileEditBody` renders one diff card per file through the existing `DiffViewer` `patch`
   prop. **No size caps** — parity with Claude, which ships full old/new strings. Claude's engine
   tool map is untouched.
3. **Reasoned, non-fatal denials**: `replyPermission` gains the `message` parameter. The auto-mode
   judge's block sends `Auto mode blocked: ${reason}` (wording parity with cli.js); a human deny
   sends `answers?.feedback || 'User denied'`. The mapper's `ToolPartState` gains `error?: string`
   and `extractToolResult` prefers it for error-status parts, so the rejection text (and every other
   opencode tool error) is visible in the tool card live — previously errored tools rendered an
   empty result. `experimental.continue_loop_on_deny: true` is added to the **ephemeral**
   `OPENCODE_CONFIG_CONTENT` (never written to user files — ADR-031) to keep cascade bare-rejects
   from ending the turn.

## Consequences

- opencode `full` autonomy now matches Claude's: a judged block is a visible, explained, retryable
  tool error instead of a silent session stop. This **amends ADR-023's guard #8** (observability):
  the decision reason now reaches the transcript/UI, not just the log. The denial caps (3
  consecutive / 20 total → human) are unchanged.
- A _human_ deny also no longer ends the opencode turn (the agent answers instead) — deliberate
  Claude-parity change of behavior vs. opencode's own TUI, where reject stops the turn.
- Live bash output is preview-based (30 KB tail, `totalLines`/`totalBytes` are preview-derived
  approximations) — sufficient for the `LiveBashOutput` panel, which replaces content per update.
- The vendored-source checkout at `vendor/opencode-src` (pin-matched tag) is the verification
  substrate for wire facts; on every `opencodeCliVersion` bump, the cited files
  (`tool/shell.ts`, `tool/apply_patch.ts`, `tool/edit.ts`, `permission/index.ts`,
  `session/processor.ts`, `schema/src/v1/permission.ts`) must be re-checked alongside the existing
  `scripts/probe-opencode-caps.mjs` run.
- `write` results still render without a diff (upstream sends none); if upstream adds result-side
  diff metadata later, `extractFileDiffs`'s shape gate picks it up with a one-line change.

## Alternatives considered

- **Fork + patched opencode bundle** (the original hypothesis, mirroring the cli.js rebundle
  pipeline): rejected — everything needed is reachable via published events, an optional reply
  field, and a documented experimental config flag. A fork adds a build pipeline, a rebase burden
  per upstream release, and ADR-030 honesty risk for zero additional capability.
- **Untyped `toolMetadata` passthrough** on `tool_result`: rejected (user decision) in favor of the
  typed, narrow `FileDiff[]` — the renderer consumes exactly what it renders, and the wire/store
  payload can't silently grow unbounded engine-specific baggage.
